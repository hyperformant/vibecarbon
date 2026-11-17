import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryChain } from '../../../_helpers/drizzle-mock';
import type { HonoVariables } from '@server/types';

// DELETE /api/v1/me cancels the user's subscriptions through whichever billing
// provider is active, so a deleted account stops being billed on Stripe,
// Paddle and Polar alike.

const { selectResults, deleteMock, provider, getBillingProviderMock } = vi.hoisted(() => {
  const provider = {
    type: 'paddle' as string,
    isConfigured: vi.fn(() => true),
    cancelActiveSubscriptions: vi.fn(async (_customerId: string) => undefined),
  };
  return {
    // adminDb.select() results, in the order the handler reads them.
    selectResults: [] as unknown[][],
    deleteMock: vi.fn(async () => undefined),
    provider,
    getBillingProviderMock: vi.fn(() => provider),
  };
});

vi.mock('@server/db/client', () => ({
  adminDb: {
    select: () => queryChain(() => selectResults.shift() ?? []),
    delete: () => queryChain(deleteMock),
  },
}));
vi.mock('@server/billing', () => ({ getBillingProvider: getBillingProviderMock }));
// The route sits behind the aal2 gate; the MFA setting is not under test here.
vi.mock('@server/lib/mfa-settings', () => ({ isMfaGloballyEnabled: async () => false }));
vi.mock('@server/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@server/lib/email', () => ({ sendEmail: vi.fn() }));

const { v1Routes } = await import('@server/routes/v1/index');

function app() {
  const hono = new Hono<{ Variables: HonoVariables }>();
  hono.use('*', async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal injected user
    c.set('user', { id: 'u1', email: 'u@example.test', role: null } as any);
    await next();
  });
  hono.route('/api/v1', v1Routes);
  return hono;
}

/** The user belongs to no organization and has a personal customer `ctm_1`. */
function seedCustomer(providerCustomerId: string | null) {
  selectResults.length = 0;
  selectResults.push([], providerCustomerId ? [{ stripeCustomerId: providerCustomerId }] : []);
}

beforeEach(() => {
  provider.isConfigured.mockReset().mockReturnValue(true);
  provider.cancelActiveSubscriptions.mockReset().mockResolvedValue(undefined);
  getBillingProviderMock.mockClear();
  deleteMock.mockClear();
});

describe('DELETE /api/v1/me cancels billing through the active provider', () => {
  for (const type of ['stripe', 'paddle', 'polar']) {
    it(`cancels the personal customer's subscriptions with ${type}, then deletes the user`, async () => {
      provider.type = type;
      seedCustomer('ctm_1');

      const res = await app().request('/api/v1/me', { method: 'DELETE' });

      expect(res.status).toBe(200);
      expect(provider.cancelActiveSubscriptions).toHaveBeenCalledExactlyOnceWith('ctm_1');
      expect(deleteMock).toHaveBeenCalledTimes(1);
    });
  }

  it('cancels nothing when the provider is not configured, and still deletes', async () => {
    provider.isConfigured.mockReturnValue(false);
    seedCustomer('ctm_1');

    const res = await app().request('/api/v1/me', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(provider.cancelActiveSubscriptions).not.toHaveBeenCalled();
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  it('asks no provider when the user has no customer record', async () => {
    seedCustomer(null);

    const res = await app().request('/api/v1/me', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(getBillingProviderMock).not.toHaveBeenCalled();
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  it('still deletes the account when the provider refuses the cancel', async () => {
    provider.cancelActiveSubscriptions.mockRejectedValue(new Error('provider down'));
    seedCustomer('ctm_1');

    const res = await app().request('/api/v1/me', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });
});
