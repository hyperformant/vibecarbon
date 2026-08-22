import Stripe from 'stripe';
import { env } from './env';

/**
 * Stripe client instance.
 * Only initialized if STRIPE_SECRET_KEY is configured.
 */
export const stripe = env.STRIPE_SECRET_KEY
  ? new Stripe(env.STRIPE_SECRET_KEY, {
      typescript: true,
    })
  : null;

/**
 * Get the Stripe client, throwing an error if not configured.
 * Use this in routes that require Stripe to be configured.
 */
export function getStripe(): Stripe {
  if (!stripe) {
    throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY in your environment.');
  }
  return stripe;
}

/**
 * Check if Stripe is configured.
 */
export function isStripeConfigured(): boolean {
  return stripe !== null;
}

/**
 * Verify Stripe webhook signature.
 * Returns the event if valid, throws an error if invalid.
 */
export function verifyWebhookSignature(payload: string | Buffer, signature: string): Stripe.Event {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new Error('Stripe webhook secret is not configured');
  }

  return getStripe().webhooks.constructEvent(payload, signature, env.STRIPE_WEBHOOK_SECRET);
}
