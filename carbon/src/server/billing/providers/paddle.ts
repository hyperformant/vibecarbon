/**
 * Paddle billing provider implementation.
 *
 * Uses Paddle API v2 via fetch (no SDK dependency). Supports both sandbox
 * and production environments via PADDLE_ENVIRONMENT env var.
 *
 * Paddle API docs: https://developer.paddle.com/api-reference/overview
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../lib/env';
import { logger } from '../../lib/logger';
import type { BillingProvider, CheckoutResult, PortalResult, SubscriptionInfo } from '../provider';

// Paddle API v2 base URLs
const PADDLE_API_URLS = {
  sandbox: 'https://sandbox-api.paddle.com',
  production: 'https://api.paddle.com',
} as const;

export class PaddleProvider implements BillingProvider {
  readonly type = 'paddle' as const;

  private get apiKey(): string {
    if (!env.PADDLE_API_KEY) {
      throw new Error('Paddle is not configured. Set PADDLE_API_KEY in your environment.');
    }
    return env.PADDLE_API_KEY;
  }

  private get baseUrl(): string {
    const environment = env.PADDLE_ENVIRONMENT ?? 'sandbox';
    return PADDLE_API_URLS[environment];
  }

  isConfigured(): boolean {
    return !!env.PADDLE_API_KEY;
  }

  async createCheckout(params: {
    customerId?: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
  }): Promise<CheckoutResult> {
    // Paddle uses Transactions API to create checkout sessions
    const response = await this.request('POST', '/transactions', {
      customer_id: params.customerId,
      items: [{ price_id: params.priceId, quantity: 1 }],
      checkout: {
        url: params.successUrl,
      },
      custom_data: params.metadata,
    });

    // biome-ignore lint/suspicious/noExplicitAny: Paddle API response shape
    const data = response.data as any;

    return {
      url: (data.checkout?.url as string) ?? '',
      sessionId: data.id as string,
    };
  }

  async createPortalSession(params: {
    customerId: string;
    returnUrl: string;
  }): Promise<PortalResult> {
    // Paddle provides a hosted customer portal via the Customers API
    const response = await this.request('POST', `/customers/${params.customerId}/portal-sessions`, {
      return_url: params.returnUrl,
    });

    // SECURITY: The portal URL is a short-lived link from Paddle
    // biome-ignore lint/suspicious/noExplicitAny: Paddle API response shape
    const data = response.data as any;
    return { url: (data.urls?.general?.overview as string) ?? '' };
  }

  async getSubscription(params: {
    customerId: string;
    subscriptionId: string;
  }): Promise<SubscriptionInfo | null> {
    try {
      const response = await this.request(
        'GET',
        `/subscriptions/${params.subscriptionId}?include=next_transaction`
      );

      // biome-ignore lint/suspicious/noExplicitAny: Paddle API response shape
      const sub = response.data as any;
      if (!sub) return null;

      const item = sub.items?.[0];
      const price = item?.price;
      const product = price?.product;

      return {
        id: sub.id as string,
        status: this.normalizePaddleStatus(String(sub.status ?? '')),
        planId: this.resolvePlanId(String(price?.id ?? '')),
        priceId: String(price?.id ?? ''),
        currentPeriodEnd: (sub.current_billing_period?.ends_at as string) ?? null,
        cancelAtPeriodEnd: sub.scheduled_change?.action === 'cancel',
        price: {
          unitAmount: Number.parseInt(String(price?.unit_price?.amount ?? '0'), 10),
          currency: String(price?.unit_price?.currency_code ?? 'USD'),
          interval: String(price?.billing_cycle?.interval ?? 'month'),
        },
        product: {
          id: String(product?.id ?? ''),
          name: String(product?.name ?? ''),
        },
      };
    } catch (error) {
      logger.error(
        { error, subscriptionId: params.subscriptionId },
        'Failed to fetch Paddle subscription'
      );
      return null;
    }
  }

  async handleWebhook(params: {
    body: string;
    signature: string;
  }): Promise<{ type: string; data: Record<string, unknown> }> {
    // Verify Paddle webhook signature
    this.verifyWebhookSignature(params.body, params.signature);

    const payload = JSON.parse(params.body);
    const eventType = payload.event_type as string;
    const normalized = this.normalizeEventType(eventType);

    return {
      type: normalized,
      data: this.extractEventData(eventType, payload.data ?? {}),
    };
  }

  async createCustomer(params: {
    email: string;
    name: string;
    metadata: Record<string, string>;
  }): Promise<string> {
    const response = await this.request('POST', '/customers', {
      email: params.email,
      name: params.name,
      custom_data: params.metadata,
    });

    return response.data.id as string;
  }

  async deleteCustomer(_customerId: string): Promise<void> {
    // Paddle does not support customer deletion via API.
    // Customers can be archived but not removed. Log and no-op.
    logger.info({ customerId: _customerId }, 'Paddle does not support customer deletion; skipping');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Make an authenticated request to the Paddle API v2. */
  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<{ data: Record<string, unknown> }> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    const options: RequestInit = { method, headers };
    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error({ status: response.status, body: errorBody, path }, 'Paddle API request failed');
      throw new Error(`Paddle API error (${response.status}): ${errorBody}`);
    }

    // biome-ignore lint/suspicious/noExplicitAny: Paddle API response shape varies
    const json = (await response.json()) as any;
    return { data: json.data ?? json };
  }

  /**
   * Verify the Paddle webhook signature (Paddle Billing v2 format).
   *
   * Paddle v2 sends the signature in a header with format:
   * `ts=<timestamp>;h1=<hmac_hex>`
   *
   * The HMAC is computed over `<timestamp>:<raw_body>` using the webhook secret.
   */
  private verifyWebhookSignature(body: string, signatureHeader: string): void {
    if (!env.PADDLE_WEBHOOK_SECRET) {
      throw new Error('Paddle webhook secret is not configured');
    }

    // Parse ts=...; h1=...
    const parts = signatureHeader.split(';');
    const tsEntry = parts.find((p) => p.trim().startsWith('ts='));
    const h1Entry = parts.find((p) => p.trim().startsWith('h1='));

    if (!tsEntry || !h1Entry) {
      throw new Error('Invalid Paddle webhook signature format');
    }

    const timestamp = tsEntry.trim().slice(3);
    const providedHash = h1Entry.trim().slice(3);

    const payload = `${timestamp}:${body}`;
    const expectedHash = createHmac('sha256', env.PADDLE_WEBHOOK_SECRET)
      .update(payload)
      .digest('hex');

    // SECURITY: constant-time comparison to avoid leaking the expected HMAC via
    // response-timing. `!==` short-circuits on the first differing byte, which
    // is a classic signature-forgery oracle. Encode as bytes and compare with
    // timingSafeEqual (guarding the length first, since it throws on mismatch).
    const expectedBuf = Buffer.from(expectedHash, 'hex');
    const providedBuf = Buffer.from(providedHash, 'hex');
    if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
      throw new Error('Invalid Paddle webhook signature');
    }

    // SECURITY: reject stale events to blunt replay attacks. A captured, validly
    // signed payload can otherwise be resent forever. Mirror Stripe/Polar's
    // 5-minute tolerance. Paddle's `ts` is a Unix timestamp in seconds.
    const timestampSec = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(timestampSec)) {
      throw new Error('Invalid Paddle webhook timestamp');
    }
    const ageSec = Math.abs(Date.now() / 1000 - timestampSec);
    const TOLERANCE_SEC = 5 * 60;
    if (ageSec > TOLERANCE_SEC) {
      throw new Error('Paddle webhook timestamp outside tolerance');
    }
  }

  /** Map Paddle event types to normalized billing event names. */
  private normalizeEventType(paddleType: string): string {
    const map: Record<string, string> = {
      'transaction.completed': 'checkout.completed',
      'subscription.created': 'subscription.created',
      'subscription.updated': 'subscription.updated',
      'subscription.canceled': 'subscription.deleted',
      'subscription.past_due': 'payment.failed',
      'transaction.payment_failed': 'payment.failed',
    };
    return map[paddleType] ?? paddleType;
  }

  /** Map Paddle subscription status to a normalized string. */
  private normalizePaddleStatus(paddleStatus: string): string {
    const map: Record<string, string> = {
      active: 'active',
      paused: 'paused',
      past_due: 'past_due',
      canceled: 'canceled',
      trialing: 'trialing',
    };
    return map[paddleStatus] ?? paddleStatus;
  }

  /** Map a Paddle price ID to a plan ID using configured env vars. */
  private resolvePlanId(priceId: string): string {
    if (priceId === env.PADDLE_PRICE_STARTER) return 'starter';
    if (priceId === env.PADDLE_PRICE_PRO) return 'pro';
    return 'free';
  }

  /** Extract relevant data from a Paddle webhook event payload. */
  // biome-ignore lint/suspicious/noExplicitAny: Paddle webhook shapes vary by event type
  private extractEventData(eventType: string, data: any): Record<string, unknown> {
    switch (eventType) {
      case 'transaction.completed':
        return {
          provider: 'paddle',
          mode: 'subscription',
          customerId: data.customer_id ?? null,
          subscriptionId: data.subscription_id ?? null,
          customerEmail: null, // Paddle transactions don't always include email
        };

      case 'subscription.created':
      case 'subscription.updated': {
        const item = data.items?.[0];
        const priceId = item?.price?.id ?? '';
        return {
          provider: 'paddle',
          subscriptionId: data.id,
          customerId: data.customer_id ?? null,
          status: this.normalizePaddleStatus(data.status ?? ''),
          priceId,
          currentPeriodStart: data.current_billing_period?.starts_at ?? null,
          currentPeriodEnd: data.current_billing_period?.ends_at ?? null,
          cancelAtPeriodEnd: data.scheduled_change?.action === 'cancel',
          canceledAt: data.canceled_at ?? null,
        };
      }

      case 'subscription.canceled':
        return {
          provider: 'paddle',
          subscriptionId: data.id,
          customerId: data.customer_id ?? null,
          status: 'canceled',
        };

      case 'subscription.past_due':
      case 'transaction.payment_failed':
        return {
          provider: 'paddle',
          subscriptionId: data.subscription_id ?? data.id ?? null,
          invoiceId: data.id ?? null,
        };

      default:
        return { provider: 'paddle', raw: data };
    }
  }
}
