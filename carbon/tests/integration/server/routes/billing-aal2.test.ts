import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonPost } from '../../../_helpers/app';
import type { HonoVariables } from '@server/types';

const { maybeSingleMock } = vi.hoisted(() => ({ maybeSingleMock: vi.fn() }));

vi.mock('@server/lib/supabase', () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: maybeSingleMock }) }) }),
  },
}));
vi.mock('@server/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
// Billing is "configured" so the gate (which runs first) is what we observe,
// not a 503. getBillingProvider is never reached because the gate short-circuits.
vi.mock('@server/billing', () => ({
  isBillingConfigured: () => true,
  getBillingProvider: () => ({}),
  getProviderPriceIds: () => ({}),
}));

const { billingRoutes } = await import('@server/routes/v1/billing');
const { __resetMfaSettingsCache } = await import('@server/lib/mfa-settings');

function appWith(aal: 'aal1' | 'aal2') {
  const app = new Hono<{ Variables: HonoVariables }>();
  app.use('*', async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal injected user
    c.set('user', { id: 'u1', email: 'u@test.com' } as any);
    c.set('aal', aal);
    await next();
  });
  app.route('/api/v1/billing', billingRoutes);
  return app;
}

beforeEach(() => {
  __resetMfaSettingsCache();
  maybeSingleMock.mockReset();
  maybeSingleMock.mockResolvedValue({ data: { value: { enabled: true } }, error: null });
});

describe('billing endpoints are aal2-gated when MFA is globally enabled', () => {
  for (const path of ['/checkout', '/portal', '/setup']) {
    it(`POST ${path} returns 403 mfa_required for an aal1 session`, async () => {
      const res = await appWith('aal1').request(
        `/api/v1/billing${path}`,
        jsonPost({ type: 'user' }),
      );
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('mfa_required');
    });
  }

  it('POST /checkout is NOT gated for an aal2 session (gate passes through)', async () => {
    const res = await appWith('aal2').request('/api/v1/billing/checkout', jsonPost({ type: 'user' }));
    // Gate satisfied → handler runs. Whatever it returns, it is NOT the mfa_required 403.
    const body = await res.json();
    expect(body.error).not.toBe('mfa_required');
  });
});
