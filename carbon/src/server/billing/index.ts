/**
 * Billing provider factory.
 *
 * Selects the active payment provider based on the BILLING_PROVIDER env var
 * (defaults to 'stripe'). The provider instance is cached so it's created once
 * per process lifetime.
 */

import { env } from '../lib/env';
import type { BillingProvider, BillingProviderType } from './provider';
import { PaddleProvider } from './providers/paddle';
import { PolarProvider } from './providers/polar';
import { StripeProvider } from './providers/stripe';

// Re-export types for convenience
export type {
  BillingProvider,
  BillingProviderType,
  CheckoutResult,
  PortalResult,
  SubscriptionInfo,
} from './provider';

/** Cached provider instance (one per process). */
let cachedProvider: BillingProvider | null = null;
let cachedProviderType: BillingProviderType | null = null;

/**
 * Get the active billing provider instance.
 *
 * The provider is determined by the BILLING_PROVIDER env var and cached
 * for the lifetime of the process.
 *
 * @throws {Error} if the BILLING_PROVIDER value is unsupported
 */
export function getBillingProvider(): BillingProvider {
  const providerType = env.BILLING_PROVIDER;

  // Return cached instance if the provider type hasn't changed
  if (cachedProvider && cachedProviderType === providerType) {
    return cachedProvider;
  }

  switch (providerType) {
    case 'stripe':
      cachedProvider = new StripeProvider();
      break;
    case 'paddle':
      cachedProvider = new PaddleProvider();
      break;
    case 'polar':
      cachedProvider = new PolarProvider();
      break;
    default:
      throw new Error(`Unknown billing provider: ${providerType}`);
  }

  cachedProviderType = providerType;
  return cachedProvider;
}

/**
 * Check if the active billing provider is properly configured.
 *
 * Returns false if the provider type is unknown or the provider's
 * required credentials are missing.
 */
export function isBillingConfigured(): boolean {
  try {
    return getBillingProvider().isConfigured();
  } catch {
    return false;
  }
}

/**
 * Get the provider-specific price IDs from environment variables.
 *
 * Used by the pricing endpoint and webhook handler to map price IDs
 * back to plan names.
 */
export function getProviderPriceIds(): { starter?: string; pro?: string } {
  const providerType = env.BILLING_PROVIDER;

  switch (providerType) {
    case 'stripe':
      return {
        starter: env.STRIPE_PRICE_STARTER,
        pro: env.STRIPE_PRICE_PRO,
      };
    case 'paddle':
      return {
        starter: env.PADDLE_PRICE_STARTER,
        pro: env.PADDLE_PRICE_PRO,
      };
    case 'polar':
      return {
        starter: env.POLAR_PRICE_STARTER,
        pro: env.POLAR_PRICE_PRO,
      };
    default:
      return {};
  }
}
