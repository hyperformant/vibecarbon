/**
 * Polar billing provider implementation.
 *
 * Uses the Polar API via fetch (no SDK dependency). Polar is a modern billing
 * platform for developers. API docs: https://docs.polar.sh/api-reference
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../lib/env';
import { logger } from '../../lib/logger';
import type { BillingProvider, CheckoutResult, PortalResult, SubscriptionInfo } from '../provider';

const POLAR_API_URL = 'https://api.polar.sh';

export class PolarProvider implements BillingProvider {
  readonly type = 'polar' as const;

  private get accessToken(): string {
    if (!env.POLAR_ACCESS_TOKEN) {
      throw new Error('Polar is not configured. Set POLAR_ACCESS_TOKEN in your environment.');
    }
    return env.POLAR_ACCESS_TOKEN;
  }

  isConfigured(): boolean {
    return !!env.POLAR_ACCESS_TOKEN;
  }

  async createCheckout(params: {
    customerId?: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
  }): Promise<CheckoutResult> {
    // Polar uses the Checkouts API
    const response = await this.request('POST', '/v1/checkouts', {
      product_price_id: params.priceId,
      customer_id: params.customerId,
      success_url: params.successUrl,
      metadata: params.metadata,
    });

    const data = response.data;

    return {
      url: data.url as string,
      sessionId: data.id as string,
    };
  }

  async createPortalSession(params: {
    customerId: string;
    returnUrl: string;
  }): Promise<PortalResult> {
    // Polar provides customer portal sessions via the Customers API
    const response = await this.request(
      'POST',
      `/v1/customers/${params.customerId}/portal/sessions`,
      {
        return_url: params.returnUrl,
      }
    );

    return { url: response.data.url as string };
  }

  async getSubscription(params: {
    customerId: string;
    subscriptionId: string;
  }): Promise<SubscriptionInfo | null> {
    try {
      const response = await this.request('GET', `/v1/subscriptions/${params.subscriptionId}`);

      const sub = response.data;
      if (!sub) return null;

      const price = sub.price as Record<string, unknown> | undefined;
      const product = sub.product as Record<string, unknown> | undefined;

      return {
        id: sub.id as string,
        status: this.normalizePolarStatus(sub.status as string),
        planId: this.resolvePlanId((price?.id as string) ?? ''),
        priceId: (price?.id as string) ?? '',
        currentPeriodEnd: (sub.current_period_end as string) ?? null,
        cancelAtPeriodEnd: (sub.cancel_at_period_end as boolean) ?? false,
        price: {
          unitAmount: (price?.price_amount as number) ?? 0,
          currency: (price?.price_currency as string) ?? 'usd',
          interval: (price?.recurring_interval as string) ?? 'month',
        },
        product: {
          id: (product?.id as string) ?? '',
          name: (product?.name as string) ?? '',
        },
      };
    } catch (error) {
      logger.error(
        { error, subscriptionId: params.subscriptionId },
        'Failed to fetch Polar subscription'
      );
      return null;
    }
  }

  async handleWebhook(params: {
    body: string;
    signature: string;
  }): Promise<{ type: string; data: Record<string, unknown> }> {
    // Verify Polar webhook signature (HMAC-SHA256)
    this.verifyWebhookSignature(params.body, params.signature);

    const payload = JSON.parse(params.body);
    const eventType = payload.type as string;
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
    const body: Record<string, unknown> = {
      email: params.email,
      name: params.name,
      metadata: params.metadata,
    };

    // Polar requires an organization_id for customer creation
    if (env.POLAR_ORGANIZATION_ID) {
      body.organization_id = env.POLAR_ORGANIZATION_ID;
    }

    const response = await this.request('POST', '/v1/customers', body);
    return response.data.id as string;
  }

  async deleteCustomer(customerId: string): Promise<void> {
    try {
      await this.request('DELETE', `/v1/customers/${customerId}`);
    } catch (error) {
      // Polar may return 404 if customer was already removed
      logger.warn(
        { error, customerId },
        'Failed to delete Polar customer (may already be deleted)'
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Make an authenticated request to the Polar API. */
  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<{ data: Record<string, unknown> }> {
    const url = `${POLAR_API_URL}${path}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
    };

    const options: RequestInit = { method, headers };
    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error({ status: response.status, body: errorBody, path }, 'Polar API request failed');
      throw new Error(`Polar API error (${response.status}): ${errorBody}`);
    }

    // DELETE responses may have no body
    if (response.status === 204) {
      return { data: {} };
    }

    // biome-ignore lint/suspicious/noExplicitAny: Polar API response shape varies
    const json = (await response.json()) as any;
    return { data: json };
  }

  /**
   * Verify Polar webhook signature.
   *
   * Polar sends a webhook-id, webhook-timestamp, and webhook-signature header.
   * The signature is an HMAC-SHA256 over `<webhook-id>.<timestamp>.<body>` using
   * the webhook secret (base64-decoded).
   *
   * The signature header may contain multiple signatures separated by spaces,
   * each prefixed with `v1,`. We check if any match.
   */
  private verifyWebhookSignature(body: string, signatureHeader: string): void {
    if (!env.POLAR_WEBHOOK_SECRET) {
      throw new Error('Polar webhook secret is not configured');
    }

    // The signatureHeader passed here is the combined value we construct
    // in the billing webhook route: `${webhookId}.${timestamp}.${signature}`
    const parts = signatureHeader.split('.');
    if (parts.length < 3) {
      throw new Error('Invalid Polar webhook signature format');
    }

    const webhookId = parts[0];
    const timestamp = parts[1];
    const signatures = parts.slice(2).join('.');

    // Compute expected HMAC
    // Polar webhook secrets are base64-encoded and prefixed with "whsec_"
    const secretRaw = env.POLAR_WEBHOOK_SECRET.startsWith('whsec_')
      ? env.POLAR_WEBHOOK_SECRET.slice(6)
      : env.POLAR_WEBHOOK_SECRET;
    const secretBytes = Buffer.from(secretRaw, 'base64');
    const payload = `${webhookId}.${timestamp}.${body}`;
    const expectedSig = createHmac('sha256', secretBytes).update(payload).digest('base64');

    // The signature header may contain multiple v1 signatures
    const providedSigs = signatures.split(' ').map((s) => {
      if (s.startsWith('v1,')) return s.slice(3);
      return s;
    });

    const expectedBuf = Buffer.from(expectedSig);
    const matched = providedSigs.some((sig) => {
      const sigBuf = Buffer.from(sig);
      if (sigBuf.length !== expectedBuf.length) return false;
      return timingSafeEqual(sigBuf, expectedBuf);
    });

    if (!matched) {
      throw new Error('Invalid Polar webhook signature');
    }

    // SECURITY: reject stale events to blunt replay attacks. A captured, validly
    // signed payload can otherwise be resent forever to re-assert subscription
    // state. Standard Webhooks timestamps are Unix seconds; use the same
    // 5-minute tolerance as the Paddle/Stripe verifiers.
    const timestampSec = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(timestampSec)) {
      throw new Error('Invalid Polar webhook timestamp');
    }
    const ageSec = Math.abs(Date.now() / 1000 - timestampSec);
    const TOLERANCE_SEC = 5 * 60;
    if (ageSec > TOLERANCE_SEC) {
      throw new Error('Polar webhook timestamp outside tolerance');
    }
  }

  /** Map Polar event types to normalized billing event names. */
  private normalizeEventType(polarType: string): string {
    const map: Record<string, string> = {
      'checkout.created': 'checkout.completed',
      'subscription.created': 'subscription.created',
      'subscription.updated': 'subscription.updated',
      'subscription.revoked': 'subscription.deleted',
      'subscription.canceled': 'subscription.deleted',
    };
    return map[polarType] ?? polarType;
  }

  /** Map Polar subscription status to a normalized string. */
  private normalizePolarStatus(polarStatus: string): string {
    const map: Record<string, string> = {
      active: 'active',
      canceled: 'canceled',
      revoked: 'canceled',
      incomplete: 'incomplete',
      incomplete_expired: 'expired',
      trialing: 'trialing',
      past_due: 'past_due',
      unpaid: 'past_due',
    };
    return map[polarStatus] ?? polarStatus;
  }

  /** Map a Polar price ID to a plan ID using configured env vars. */
  private resolvePlanId(priceId: string): string {
    if (priceId === env.POLAR_PRICE_STARTER) return 'starter';
    if (priceId === env.POLAR_PRICE_PRO) return 'pro';
    return 'free';
  }

  /** Extract relevant data from a Polar webhook event payload. */
  // biome-ignore lint/suspicious/noExplicitAny: Polar webhook shapes vary by event type
  private extractEventData(eventType: string, data: any): Record<string, unknown> {
    switch (eventType) {
      case 'checkout.created':
        return {
          provider: 'polar',
          mode: 'subscription',
          customerId: data.customer_id ?? null,
          subscriptionId: data.subscription_id ?? null,
          customerEmail: data.customer_email ?? null,
        };

      case 'subscription.created':
      case 'subscription.updated': {
        const price = data.price;
        return {
          provider: 'polar',
          subscriptionId: data.id,
          customerId: data.customer_id ?? null,
          status: this.normalizePolarStatus(data.status ?? ''),
          priceId: price?.id ?? '',
          currentPeriodStart: data.current_period_start ?? null,
          currentPeriodEnd: data.current_period_end ?? null,
          cancelAtPeriodEnd: data.cancel_at_period_end ?? false,
          canceledAt: data.ended_at ?? null,
        };
      }

      case 'subscription.revoked':
      case 'subscription.canceled':
        return {
          provider: 'polar',
          subscriptionId: data.id,
          customerId: data.customer_id ?? null,
          status: 'canceled',
        };

      default:
        return { provider: 'polar', raw: data };
    }
  }
}
