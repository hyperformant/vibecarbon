import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonPost } from '../../../_helpers/app';
import type { HonoVariables } from '@server/types';

/**
 * Catalog-drift guard (launch blocker "Stripe Fullerene $149 refresh"):
 * license checkout must refuse to sell when the LIVE provider price behind
 * FULLERENE_PRICE_ID disagrees with the advertised $149 — a stale env var
 * pointing at the old $299 price must 503 loudly, never charge silently.
 */

const holder = vi.hoisted(() => ({
  provider: {} as Record<string, unknown>,
}));

vi.mock('@server/lib/env', async (importOriginal) => {
  const real = await importOriginal<typeof import('@server/lib/env')>();
  return { ...real, env: { ...real.env, FULLERENE_PRICE_ID: 'price_fullerene_test' } };
});
vi.mock('@server/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@server/billing', () => ({
  isBillingConfigured: () => true,
  getBillingProvider: () => holder.provider,
  getProviderPriceIds: () => ({}),
}));
// Pass-through limiter: the real 5/15min limiter would 429 the later cases.
vi.mock('@server/lib/rate-limiter', () => ({
  createRateLimiter: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const { billingRoutes } = await import('@server/routes/v1/billing');

function app() {
  const a = new Hono<{ Variables: HonoVariables }>();
  a.route('/api/v1/billing', billingRoutes);
  return a;
}

const checkout = () =>
  app().request('/api/v1/billing/license-checkout', jsonPost({ tier: 'fullerene' }));

// No createCustomer: license checkout is a guest session — the provider's
// hosted page collects the buyer's email itself.
const happyProviderBase = () => ({
  type: 'stripe',
  createCheckout: vi.fn(async () => ({ url: 'https://checkout.test/session' })),
});

beforeEach(() => {
  holder.provider = {};
});

describe('license checkout price-integrity guard', () => {
  it('proceeds (with a skip) when the provider cannot retrieve prices', async () => {
    holder.provider = happyProviderBase();
    const res = await checkout();
    expect(res.status).toBe(200);
  });

  it('proceeds when price retrieval errors (availability over a provider blip)', async () => {
    holder.provider = {
      ...happyProviderBase(),
      getPriceAmount: vi.fn(async () => {
        throw new Error('stripe 500');
      }),
    };
    const res = await checkout();
    expect(res.status).toBe(200);
  });

  it('BLOCKS the sale when the live amount disagrees with the advertised $149', async () => {
    const provider = {
      ...happyProviderBase(),
      getPriceAmount: vi.fn(async () => ({ unitAmountCents: 299_00, currency: 'usd' })),
    };
    holder.provider = provider;
    const res = await checkout();
    expect(res.status).toBe(503);
    expect(provider.createCheckout).not.toHaveBeenCalled();
  });

  it('proceeds on an exact $149 usd match and caches the verification', async () => {
    const provider = {
      ...happyProviderBase(),
      getPriceAmount: vi.fn(async () => ({ unitAmountCents: 149_00, currency: 'usd' })),
    };
    holder.provider = provider;
    expect((await checkout()).status).toBe(200);
    expect((await checkout()).status).toBe(200);
    // one provider round-trip per process, not per request
    expect(provider.getPriceAmount).toHaveBeenCalledTimes(1);
    // guest payment session: no pre-created customer, no email in metadata
    const args = provider.createCheckout.mock.calls[0][0];
    expect(args.mode).toBe('payment');
    expect(args).not.toHaveProperty('customerId');
    expect(args.metadata).toEqual({ tier: 'fullerene', type: 'license' });
  });

  it('builds return URLs on the SITE_URL origin (single origin — never an api. host)', async () => {
    const provider = happyProviderBase();
    holder.provider = provider;

    // Production serves ONE public origin; a buyer finishing payment must land
    // on the site, not the retired api.<domain> host (Kong would 404 them).
    const { env } = await import('@server/lib/env');
    const prevNodeEnv = env.NODE_ENV;
    const prevSiteUrl = process.env.SITE_URL;
    (env as { NODE_ENV: string }).NODE_ENV = 'production';
    process.env.SITE_URL = 'https://example.com';
    try {
      expect((await checkout()).status).toBe(200);
    } finally {
      (env as { NODE_ENV: string }).NODE_ENV = prevNodeEnv;
      if (prevSiteUrl === undefined) delete process.env.SITE_URL;
      else process.env.SITE_URL = prevSiteUrl;
    }

    const args = provider.createCheckout.mock.calls[0][0];
    expect(args.successUrl).toBe('https://example.com/checkout?success=true&tier=fullerene');
    expect(args.cancelUrl).toBe('https://example.com/#pricing');
    expect(args.successUrl).not.toContain('api.');
    expect(args.cancelUrl).not.toContain('api.');
  });
});
