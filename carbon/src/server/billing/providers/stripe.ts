/**
 * Stripe billing provider implementation.
 *
 * Wraps the existing Stripe client (src/server/lib/stripe.ts) behind
 * the BillingProvider interface. All Stripe-specific API calls are
 * contained here so the rest of the billing system stays provider-agnostic.
 */

import type Stripe from 'stripe';
import { env } from '../../lib/env';
import { getStripe, isStripeConfigured, verifyWebhookSignature } from '../../lib/stripe';
import type { BillingProvider, CheckoutResult, PortalResult, SubscriptionInfo } from '../provider';

export class StripeProvider implements BillingProvider {
  readonly type = 'stripe' as const;

  isConfigured(): boolean {
    return isStripeConfigured();
  }

  async getPriceAmount(
    priceId: string
  ): Promise<{ unitAmountCents: number; currency: string } | null> {
    const client = getStripe();
    if (!client) return null;
    const price = await client.prices.retrieve(priceId);
    if (typeof price.unit_amount !== 'number') return null;
    return { unitAmountCents: price.unit_amount, currency: price.currency };
  }

  async createCheckout(params: {
    customerId?: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
    mode?: 'subscription' | 'payment';
  }): Promise<CheckoutResult> {
    const stripe = getStripe();
    const mode = params.mode ?? 'subscription';

    const session = await stripe.checkout.sessions.create({
      customer: params.customerId,
      // Guest payment checkouts (no pre-created customer) still create a
      // Customer record, so one-time license sales stay attributable in the
      // dashboard. Stripe only allows this param in payment mode.
      ...(!params.customerId && mode === 'payment' ? { customer_creation: 'always' as const } : {}),
      mode,
      line_items: [{ price: params.priceId, quantity: 1 }],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      metadata: params.metadata,
    });

    return {
      url: session.url ?? '',
      sessionId: session.id,
    };
  }

  async createPortalSession(params: {
    customerId: string;
    returnUrl: string;
  }): Promise<PortalResult> {
    const stripe = getStripe();

    const session = await stripe.billingPortal.sessions.create({
      customer: params.customerId,
      return_url: params.returnUrl,
    });

    return { url: session.url };
  }

  async getSubscription(params: {
    customerId: string;
    subscriptionId: string;
  }): Promise<SubscriptionInfo | null> {
    const stripe = getStripe();

    try {
      const subscription = await stripe.subscriptions.retrieve(params.subscriptionId, {
        expand: ['items.data.price.product'],
      });

      const item = subscription.items.data[0];
      if (!item) return null;

      const price = item.price;
      const product = price.product as Stripe.Product;

      const currentPeriodEnd = (subscription as unknown as { current_period_end?: number })
        .current_period_end;

      return {
        id: subscription.id,
        status: subscription.status,
        planId: this.resolvePlanId(price.id),
        priceId: price.id,
        currentPeriodEnd: currentPeriodEnd ? new Date(currentPeriodEnd * 1000).toISOString() : null,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        price: {
          unitAmount: price.unit_amount ?? 0,
          currency: price.currency,
          interval: price.recurring?.interval ?? 'month',
        },
        product: {
          id: product.id,
          name: product.name,
        },
      };
    } catch {
      return null;
    }
  }

  async handleWebhook(params: {
    body: string;
    signature: string;
  }): Promise<{ type: string; data: Record<string, unknown> }> {
    const event = verifyWebhookSignature(params.body, params.signature);

    // Normalize Stripe event types to a common format
    const normalized = this.normalizeEventType(event.type);

    return {
      type: normalized,
      data: {
        ...this.extractEventData(event),
        _raw: event,
      },
    };
  }

  async createCustomer(params: {
    email: string;
    name: string;
    metadata: Record<string, string>;
  }): Promise<string> {
    const stripe = getStripe();

    const customer = await stripe.customers.create({
      email: params.email,
      name: params.name,
      metadata: params.metadata,
    });

    return customer.id;
  }

  async deleteCustomer(customerId: string): Promise<void> {
    const stripe = getStripe();
    await stripe.customers.del(customerId);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Map a Stripe price ID to a plan ID using configured env vars. */
  private resolvePlanId(priceId: string): string {
    if (priceId === env.STRIPE_PRICE_STARTER) return 'starter';
    if (priceId === env.STRIPE_PRICE_PRO) return 'pro';
    return 'free';
  }

  /**
   * Map Stripe webhook event types to normalized billing event names.
   *
   * The normalized names are used by the generic webhook handler so that
   * subscription lifecycle logic is provider-agnostic.
   */
  private normalizeEventType(stripeType: string): string {
    const map: Record<string, string> = {
      'checkout.session.completed': 'checkout.completed',
      'customer.subscription.created': 'subscription.created',
      'customer.subscription.updated': 'subscription.updated',
      'customer.subscription.deleted': 'subscription.deleted',
      'invoice.payment_failed': 'payment.failed',
    };
    return map[stripeType] ?? stripeType;
  }

  /** Extract relevant data from a Stripe event into a flat record. */
  private extractEventData(event: Stripe.Event): Record<string, unknown> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        return {
          provider: 'stripe',
          mode: session.mode,
          customerId: session.customer as string,
          subscriptionId: session.subscription as string,
          customerEmail: session.customer_details?.email ?? null,
        };
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const priceId = sub.items.data[0]?.price.id;
        const periodStart = (sub as unknown as { current_period_start?: number })
          .current_period_start;
        const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end;
        return {
          provider: 'stripe',
          subscriptionId: sub.id,
          customerId: sub.customer as string,
          status: sub.status,
          priceId,
          currentPeriodStart: periodStart ? new Date(periodStart * 1000).toISOString() : null,
          currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
        };
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        return {
          provider: 'stripe',
          subscriptionId: sub.id,
          customerId: sub.customer as string,
          status: 'canceled',
        };
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const invoiceWithSub = invoice as unknown as {
          subscription?: string | { id: string } | null;
        };
        const subscriptionId =
          typeof invoiceWithSub.subscription === 'string'
            ? invoiceWithSub.subscription
            : invoiceWithSub.subscription?.id;
        return {
          provider: 'stripe',
          subscriptionId: subscriptionId ?? null,
          invoiceId: invoice.id,
        };
      }

      default:
        return { provider: 'stripe', raw: event.data.object as unknown as Record<string, unknown> };
    }
  }
}
