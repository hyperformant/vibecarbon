import { env } from '../lib/env';

/**
 * The starter and pro price ids configured for `provider` (unset ones are
 * undefined). Lives apart from billing/index.ts so the providers can read it
 * without importing the module that imports them.
 */
export function priceIdsFor(provider: string): { starter?: string; pro?: string } {
  switch (provider) {
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
