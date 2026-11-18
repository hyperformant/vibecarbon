/**
 * GET /api/v1/billing/status names the active provider's environment
 * variables. The Billing page shows them when billing is not configured, so a
 * Paddle or Polar project is not told to set Stripe's keys.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HonoVariables } from '@server/types';

const provider = vi.hoisted(() => ({ value: 'stripe' as 'stripe' | 'paddle' | 'polar' }));

// The real env, with BILLING_PROVIDER set per test.
vi.mock('@server/lib/env', async (importOriginal) => {
  const real = await importOriginal<typeof import('@server/lib/env')>();
  return {
    ...real,
    env: new Proxy(real.env, {
      get: (target, key) => (key === 'BILLING_PROVIDER' ? provider.value : Reflect.get(target, key)),
    }),
  };
});
vi.mock('@server/db/client', () => ({ adminDb: {} }));
vi.mock('@server/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@server/billing', () => ({
  isBillingConfigured: () => false,
  getBillingProvider: () => ({}),
  getProviderPriceIds: () => ({}),
}));

const { billingRoutes } = await import('@server/routes/v1/billing');

function app() {
  const a = new Hono<{ Variables: HonoVariables }>();
  a.route('/api/v1/billing', billingRoutes);
  return a;
}

beforeEach(() => {
  provider.value = 'stripe';
});

describe('GET /billing/status', () => {
  it.each([
    ['stripe', ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']],
    ['paddle', ['PADDLE_API_KEY', 'PADDLE_WEBHOOK_SECRET']],
    ['polar', ['POLAR_ACCESS_TOKEN', 'POLAR_WEBHOOK_SECRET']],
  ] as const)('names the %s variables', async (name, envVars) => {
    provider.value = name;
    const res = await app().request('/api/v1/billing/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, provider: name, envVars });
  });
});
