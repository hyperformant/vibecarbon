import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryChain } from '../../../_helpers/drizzle-mock';
import type { HonoVariables } from '@server/types';

const { state, withUserDbMock } = vi.hoisted(() => ({
  state: { membershipRole: null as string | null },
  withUserDbMock: vi.fn(),
}));

// requireOrgRole reads the caller's membership through withUserDb (RLS as the
// caller). The handler then reads billing rows through adminDb AFTER the gate;
// a customer lookup that finds nothing yields {status:'none'} — enough to
// prove the request reached the handler (i.e. the gate passed).
vi.mock('@server/db/client', () => ({
  adminDb: { select: () => queryChain(() => []) },
  withUserDb: withUserDbMock,
}));
vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@server/billing', () => ({
  isBillingConfigured: () => true,
  getBillingProvider: () => ({ type: 'stripe' }),
  getProviderPriceIds: () => ({}),
}));

const { billingRoutes } = await import('@server/routes/v1/billing');

beforeEach(() => {
  state.membershipRole = null;
  withUserDbMock.mockReset();
  withUserDbMock.mockImplementation((_userId: string | null, fn: (tx: unknown) => unknown) =>
    fn({
      select: () =>
        queryChain(() => (state.membershipRole ? [{ role: state.membershipRole }] : [])),
    })
  );
});

// Build an app that injects an authenticated user whose membership in the
// target org (as RLS shows it to them) has role `membershipRole`.
function appWith(membershipRole: string | null) {
  state.membershipRole = membershipRole;
  const app = new Hono<{ Variables: HonoVariables }>();
  app.use('*', async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal injected user
    c.set('user', { id: 'u1', email: 'u@test.com' } as any);
    // biome-ignore lint/suspicious/noExplicitAny: minimal injected session (aal2)
    c.set('session', { id: 's1', twoFactorVerified: true } as any);
    await next();
  });
  app.route('/api/v1/billing', billingRoutes);
  return app;
}

const ORG = '00000000-0000-0000-0000-0000000000aa';

describe('GET /billing/subscription org access control (IDOR fix)', () => {
  it('SECURITY: returns 403 when the caller is not a member of the target org', async () => {
    const res = await appWith(null).request(
      `/api/v1/billing/subscription?type=organization&organizationId=${ORG}`
    );
    expect(res.status).toBe(403);
    // The lookup ran as the caller, under RLS — never as the server.
    expect(withUserDbMock).toHaveBeenCalledWith('u1', expect.any(Function));
  });

  it('allows an OWNER of the target org through the gate', async () => {
    const res = await appWith('OWNER').request(
      `/api/v1/billing/subscription?type=organization&organizationId=${ORG}`
    );
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('none');
  });

  it('rejects a non-privileged member (e.g. MEMBER role)', async () => {
    const res = await appWith('MEMBER').request(
      `/api/v1/billing/subscription?type=organization&organizationId=${ORG}`
    );
    expect(res.status).toBe(403);
  });

  it('requires an organizationId for organization-scoped requests', async () => {
    const res = await appWith('OWNER').request(
      '/api/v1/billing/subscription?type=organization'
    );
    expect(res.status).toBe(400);
  });

  it('is inert for user-scoped requests (no org membership needed)', async () => {
    const res = await appWith(null).request('/api/v1/billing/subscription?type=user');
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('none');
  });

  it('denies a malformed organizationId without querying', async () => {
    const res = await appWith('OWNER').request(
      '/api/v1/billing/subscription?type=organization&organizationId=not-a-uuid'
    );
    expect(res.status).toBe(403);
    expect(withUserDbMock).not.toHaveBeenCalled();
  });

  it('SECURITY: rejects any other type instead of reading the org ungated', async () => {
    // requireOrgRole only gates type=organization; another type must not reach
    // the organization lookup with an arbitrary organizationId.
    const res = await appWith(null).request(
      `/api/v1/billing/subscription?type=org&organizationId=${ORG}`
    );
    expect(res.status).toBe(400);
  });
});
