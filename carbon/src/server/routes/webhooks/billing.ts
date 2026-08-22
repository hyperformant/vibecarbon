/**
 * Generic billing webhook handler.
 *
 * Accepts webhooks at /api/webhooks/billing from any configured billing provider
 * (Stripe, Paddle, Polar). The active provider verifies the signature and
 * normalizes the event, and this handler updates subscriptions in the database.
 *
 * The Stripe-specific webhook at /api/webhooks/stripe is kept for backward
 * compatibility with existing deployments.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { Hono } from 'hono';
import { getBillingProvider, isBillingConfigured } from '../../billing';
import { paymentFailedEmail, subscriptionConfirmEmail } from '../../emails/templates';
import { sendEmail } from '../../lib/email';
import { logger } from '../../lib/logger';
import { supabaseAdmin } from '../../lib/supabase';
import type { HonoVariables } from '../../types';

// Helper to access tables not yet in generated types
// biome-ignore lint/suspicious/noExplicitAny: Tables not yet in generated Database types
const adminDb = supabaseAdmin as SupabaseClient<any>;

const billingWebhookRoutes = new Hono<{ Variables: HonoVariables }>();

/**
 * Handle billing webhook events from the active provider.
 *
 * IMPORTANT: This endpoint must receive the raw body for signature verification.
 * The body parser middleware should be skipped for this route.
 */
billingWebhookRoutes.post('/', async (c) => {
  if (!isBillingConfigured()) {
    return c.json({ error: 'Billing is not configured' }, 503);
  }

  const provider = getBillingProvider();

  // Each provider uses different signature headers:
  // - Stripe: stripe-signature
  // - Paddle: paddle-signature
  // - Polar: webhook-id + webhook-timestamp + webhook-signature (combined below)
  let signature = '';
  switch (provider.type) {
    case 'stripe':
      signature = c.req.header('stripe-signature') ?? '';
      break;
    case 'paddle':
      signature = c.req.header('paddle-signature') ?? '';
      break;
    case 'polar': {
      // Polar uses three headers; combine them into a single string for the provider
      const webhookId = c.req.header('webhook-id') ?? '';
      const webhookTimestamp = c.req.header('webhook-timestamp') ?? '';
      const webhookSignature = c.req.header('webhook-signature') ?? '';
      signature = `${webhookId}.${webhookTimestamp}.${webhookSignature}`;
      break;
    }
  }

  if (!signature || signature === '..') {
    logger.warn({ provider: provider.type }, 'Billing webhook received without signature');
    return c.json({ error: 'Missing webhook signature' }, 400);
  }

  let event: { type: string; data: Record<string, unknown> };

  try {
    const rawBody = await c.req.text();
    event = await provider.handleWebhook({ body: rawBody, signature });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error(
      { error: message, provider: provider.type },
      'Billing webhook signature verification failed'
    );
    return c.json({ error: 'Invalid signature' }, 400);
  }

  logger.info({ type: event.type, provider: provider.type }, 'Processing billing webhook event');

  try {
    switch (event.type) {
      case 'checkout.completed':
        await handleCheckoutCompleted(event.data);
        break;

      case 'subscription.created':
      case 'subscription.updated':
        await handleSubscriptionUpsert(event.data);
        break;

      case 'subscription.deleted':
        await handleSubscriptionDeleted(event.data);
        break;

      case 'payment.failed':
        await handlePaymentFailed(event.data);
        break;

      default:
        logger.debug({ type: event.type }, 'Unhandled billing webhook event type');
    }

    return c.json({ received: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error(
      { error: message, eventType: event.type, provider: provider.type },
      'Failed to process billing webhook event'
    );
    return c.json({ error: 'Webhook handler failed' }, 500);
  }
});

// ============================================================================
// EVENT HANDLERS (provider-agnostic)
// ============================================================================

/**
 * Handle a completed checkout from any provider.
 * The data contains normalized fields: customerId, subscriptionId, customerEmail.
 */
async function handleCheckoutCompleted(data: Record<string, unknown>): Promise<void> {
  const customerId = data.customerId as string | null;
  const subscriptionId = data.subscriptionId as string | null;
  const customerEmail = data.customerEmail as string | null;

  if (!customerId || !subscriptionId) {
    logger.debug('Checkout completed event missing customerId or subscriptionId');
    return;
  }

  logger.info({ customerId, subscriptionId }, 'Checkout completed');

  // Find customer in our database
  const { data: customer, error: customerError } = await adminDb
    .from('customers')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single();

  if (customerError || !customer) {
    logger.error({ customerId, error: customerError }, 'Customer not found for checkout');
    throw new Error(`Customer not found: ${customerId}`);
  }

  // If the provider sent subscription data inline, upsert it
  if (data.status && data.priceId) {
    await upsertSubscriptionFromData(customer.id, data);
  } else {
    // For providers like Stripe that require a separate fetch, get the full subscription
    try {
      const provider = getBillingProvider();
      const subInfo = await provider.getSubscription({ customerId, subscriptionId });
      if (subInfo) {
        await upsertSubscriptionFromInfo(customer.id, subscriptionId, subInfo);
      }
    } catch (error) {
      logger.warn({ error, subscriptionId }, 'Could not fetch subscription details after checkout');
    }
  }

  // Send confirmation email
  if (customerEmail) {
    try {
      const provider = getBillingProvider();
      const subInfo = await provider.getSubscription({ customerId, subscriptionId });
      if (subInfo) {
        const template = subscriptionConfirmEmail({
          planName: subInfo.product.name,
          amount: `$${(subInfo.price.unitAmount / 100).toFixed(2)}`,
          interval: subInfo.price.interval,
        });
        sendEmail({ to: customerEmail, ...template }).catch((err) => {
          logger.error({ error: err }, 'Failed to send subscription confirmation email');
        });
      }
    } catch (emailErr) {
      logger.error({ error: emailErr }, 'Failed to prepare subscription confirmation email');
    }
  }
}

/**
 * Handle subscription create/update from any provider.
 */
async function handleSubscriptionUpsert(data: Record<string, unknown>): Promise<void> {
  const customerId = data.customerId as string | null;
  const subscriptionId = data.subscriptionId as string | null;

  if (!customerId || !subscriptionId) {
    logger.warn('Subscription event missing customerId or subscriptionId');
    return;
  }

  logger.info({ subscriptionId, status: data.status }, 'Subscription upserted');

  // Find customer in our database
  const { data: customer, error: customerError } = await adminDb
    .from('customers')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single();

  if (customerError || !customer) {
    logger.error({ customerId, error: customerError }, 'Customer not found for subscription');
    throw new Error(`Customer not found: ${customerId}`);
  }

  await upsertSubscriptionFromData(customer.id, data);
}

/**
 * Handle subscription deletion/cancellation.
 */
async function handleSubscriptionDeleted(data: Record<string, unknown>): Promise<void> {
  const subscriptionId = data.subscriptionId as string | null;

  if (!subscriptionId) {
    logger.warn('Subscription delete event missing subscriptionId');
    return;
  }

  logger.info({ subscriptionId }, 'Subscription deleted');

  const { error } = await adminDb
    .from('subscriptions')
    .update({
      status: 'canceled',
      canceled_at: new Date().toISOString(),
    })
    .eq('stripe_subscription_id', subscriptionId);

  if (error) {
    logger.error({ error, subscriptionId }, 'Failed to update canceled subscription');
    throw error;
  }
}

/**
 * Handle a failed payment.
 */
async function handlePaymentFailed(data: Record<string, unknown>): Promise<void> {
  const subscriptionId = data.subscriptionId as string | null;

  if (!subscriptionId) {
    logger.debug('Payment failed event without subscription');
    return;
  }

  logger.warn({ subscriptionId }, 'Payment failed for subscription');

  const { error } = await adminDb
    .from('subscriptions')
    .update({ status: 'past_due' })
    .eq('stripe_subscription_id', subscriptionId);

  if (error) {
    logger.error({ error, subscriptionId }, 'Failed to update subscription status to past_due');
    throw error;
  }

  // Send payment failed email
  try {
    const { data: sub } = await adminDb
      .from('subscriptions')
      .select('customer_id')
      .eq('stripe_subscription_id', subscriptionId)
      .single();

    if (sub) {
      const { data: customer } = await adminDb
        .from('customers')
        .select('email')
        .eq('id', sub.customer_id)
        .single();

      if (customer?.email) {
        const baseUrl = process.env.SITE_URL || 'http://localhost:5173';
        const template = paymentFailedEmail({
          planName: 'your',
          billingUrl: `${baseUrl}/settings/billing`,
        });
        sendEmail({ to: customer.email, ...template }).catch((err) => {
          logger.error({ error: err }, 'Failed to send payment failed email');
        });
      }
    }
  } catch (emailErr) {
    logger.error({ error: emailErr }, 'Failed to prepare payment failed email');
  }
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Upsert a subscription record using normalized webhook event data.
 * Used when the webhook payload contains all needed subscription fields.
 */
async function upsertSubscriptionFromData(
  dbCustomerId: string,
  data: Record<string, unknown>
): Promise<void> {
  const subscriptionId = data.subscriptionId as string;
  const priceId = data.priceId as string;

  if (!priceId) {
    throw new Error('Subscription event has no priceId');
  }

  const subscriptionData = {
    customer_id: dbCustomerId,
    stripe_subscription_id: subscriptionId,
    stripe_price_id: priceId,
    status: (data.status as string) ?? 'active',
    current_period_start: (data.currentPeriodStart as string) ?? null,
    current_period_end: (data.currentPeriodEnd as string) ?? null,
    cancel_at_period_end: (data.cancelAtPeriodEnd as boolean) ?? false,
    canceled_at: (data.canceledAt as string) ?? null,
  };

  const { error } = await adminDb.from('subscriptions').upsert(subscriptionData, {
    onConflict: 'stripe_subscription_id',
  });

  if (error) {
    logger.error({ error, subscriptionId }, 'Failed to upsert subscription');
    throw error;
  }

  logger.info({ subscriptionId, status: data.status }, 'Subscription record upserted');
}

/**
 * Upsert a subscription record using SubscriptionInfo from the provider API.
 * Used when we need to fetch subscription details separately (e.g., after checkout).
 */
async function upsertSubscriptionFromInfo(
  dbCustomerId: string,
  subscriptionId: string,
  info: {
    status: string;
    priceId: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  }
): Promise<void> {
  const subscriptionData = {
    customer_id: dbCustomerId,
    stripe_subscription_id: subscriptionId,
    stripe_price_id: info.priceId,
    status: info.status,
    current_period_end: info.currentPeriodEnd,
    cancel_at_period_end: info.cancelAtPeriodEnd,
  };

  const { error } = await adminDb.from('subscriptions').upsert(subscriptionData, {
    onConflict: 'stripe_subscription_id',
  });

  if (error) {
    logger.error({ error, subscriptionId }, 'Failed to upsert subscription from provider info');
    throw error;
  }

  logger.info(
    { subscriptionId, status: info.status },
    'Subscription record upserted from provider'
  );
}

export { billingWebhookRoutes };
