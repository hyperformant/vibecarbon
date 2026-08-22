import type { SupabaseClient } from '@supabase/supabase-js';
import { Hono } from 'hono';
import type Stripe from 'stripe';
import { paymentFailedEmail, subscriptionConfirmEmail } from '../../emails/templates';
import { sendEmail } from '../../lib/email';
import { logger } from '../../lib/logger';
import { getStripe, verifyWebhookSignature } from '../../lib/stripe';
import { supabaseAdmin } from '../../lib/supabase';
import type { HonoVariables } from '../../types';

// Helper to access tables not yet in generated types
// biome-ignore lint/suspicious/noExplicitAny: Tables not yet in generated Database types
const adminDb = supabaseAdmin as SupabaseClient<any>;

const stripeWebhookRoutes = new Hono<{ Variables: HonoVariables }>();

/**
 * Handle Stripe webhook events
 *
 * IMPORTANT: This endpoint must receive the raw body for signature verification.
 * The body parser middleware should be skipped for this route.
 */
stripeWebhookRoutes.post('/', async (c) => {
  const signature = c.req.header('stripe-signature');

  if (!signature) {
    logger.warn('Stripe webhook received without signature');
    return c.json({ error: 'Missing stripe-signature header' }, 400);
  }

  let event: Stripe.Event;

  try {
    // Get raw body for signature verification
    const rawBody = await c.req.text();
    event = verifyWebhookSignature(rawBody, signature);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error: message }, 'Stripe webhook signature verification failed');
    return c.json({ error: 'Invalid signature' }, 400);
  }

  logger.info({ type: event.type, id: event.id }, 'Processing Stripe webhook event');

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session);
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;

      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object as Stripe.Invoice);
        break;

      default:
        logger.debug({ type: event.type }, 'Unhandled webhook event type');
    }

    return c.json({ received: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error: message, eventType: event.type }, 'Failed to process webhook event');
    return c.json({ error: 'Webhook handler failed' }, 500);
  }
});

// ============================================================================
// EVENT HANDLERS
// ============================================================================

async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session) {
  if (session.mode !== 'subscription') {
    logger.debug('Ignoring non-subscription checkout session');
    return;
  }

  const subscriptionId = session.subscription as string;
  const customerId = session.customer as string;

  logger.info({ subscriptionId, customerId }, 'Checkout session completed');

  // Fetch full subscription details
  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

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

  // Create or update subscription record
  await upsertSubscription(customer.id, subscription);

  // Send subscription confirmation email
  const stripeObj = getStripe();
  try {
    const price = await stripeObj.prices.retrieve(subscription.items.data[0]?.price.id, {
      expand: ['product'],
    });
    const product = price.product as Stripe.Product;
    const customerEmail = (session as Stripe.Checkout.Session).customer_details?.email;

    if (customerEmail) {
      const template = subscriptionConfirmEmail({
        planName: product.name,
        amount: `$${((price.unit_amount ?? 0) / 100).toFixed(2)}`,
        interval: price.recurring?.interval ?? 'month',
      });
      sendEmail({ to: customerEmail, ...template }).catch((err) => {
        logger.error({ error: err }, 'Failed to send subscription confirmation email');
      });
    }
  } catch (emailErr) {
    logger.error({ error: emailErr }, 'Failed to prepare subscription confirmation email');
  }
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string;

  logger.info(
    { subscriptionId: subscription.id, status: subscription.status },
    'Subscription updated'
  );

  // Find customer in our database
  const { data: customer, error: customerError } = await adminDb
    .from('customers')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single();

  if (customerError || !customer) {
    logger.error(
      { customerId, error: customerError },
      'Customer not found for subscription update'
    );
    throw new Error(`Customer not found: ${customerId}`);
  }

  await upsertSubscription(customer.id, subscription);
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  logger.info({ subscriptionId: subscription.id }, 'Subscription deleted');

  const { error } = await adminDb
    .from('subscriptions')
    .update({
      status: 'canceled',
      canceled_at: new Date().toISOString(),
    })
    .eq('stripe_subscription_id', subscription.id);

  if (error) {
    logger.error(
      { error, subscriptionId: subscription.id },
      'Failed to update canceled subscription'
    );
    throw error;
  }
}

async function handlePaymentFailed(invoice: Stripe.Invoice) {
  // In Stripe 20.x, subscription is accessed via parent property
  const invoiceWithSub = invoice as unknown as {
    subscription?: string | { id: string } | null;
  };
  const subscriptionId =
    typeof invoiceWithSub.subscription === 'string'
      ? invoiceWithSub.subscription
      : invoiceWithSub.subscription?.id;

  if (!subscriptionId) {
    logger.debug('Ignoring invoice without subscription');
    return;
  }

  logger.warn({ subscriptionId, invoiceId: invoice.id }, 'Payment failed for subscription');

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
    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price.product'],
    });
    const customerObj = await stripe.customers.retrieve(sub.customer as string);
    if (customerObj && !customerObj.deleted && customerObj.email) {
      const product = sub.items.data[0]?.price.product as Stripe.Product;
      const baseUrl = process.env.SITE_URL || 'http://localhost:5173';
      const template = paymentFailedEmail({
        planName: product?.name ?? 'your',
        billingUrl: `${baseUrl}/settings/billing`,
      });
      sendEmail({ to: customerObj.email, ...template }).catch((err) => {
        logger.error({ error: err }, 'Failed to send payment failed email');
      });
    }
  } catch (emailErr) {
    logger.error({ error: emailErr }, 'Failed to prepare payment failed email');
  }
}

// ============================================================================
// HELPERS
// ============================================================================

async function upsertSubscription(customerId: string, subscription: Stripe.Subscription) {
  const priceId = subscription.items.data[0]?.price.id;

  if (!priceId) {
    throw new Error('Subscription has no price');
  }

  const currentPeriodStart = (subscription as unknown as { current_period_start?: number })
    .current_period_start;
  const currentPeriodEnd = (subscription as unknown as { current_period_end?: number })
    .current_period_end;

  const subscriptionData = {
    customer_id: customerId,
    stripe_subscription_id: subscription.id,
    stripe_price_id: priceId,
    status: subscription.status,
    current_period_start: currentPeriodStart
      ? new Date(currentPeriodStart * 1000).toISOString()
      : null,
    current_period_end: currentPeriodEnd ? new Date(currentPeriodEnd * 1000).toISOString() : null,
    cancel_at_period_end: subscription.cancel_at_period_end,
    canceled_at: subscription.canceled_at
      ? new Date(subscription.canceled_at * 1000).toISOString()
      : null,
  };

  const { error } = await adminDb.from('subscriptions').upsert(subscriptionData, {
    onConflict: 'stripe_subscription_id',
  });

  if (error) {
    logger.error({ error, subscriptionId: subscription.id }, 'Failed to upsert subscription');
    throw error;
  }

  logger.info(
    { subscriptionId: subscription.id, status: subscription.status },
    'Subscription record upserted'
  );
}

export { stripeWebhookRoutes };
