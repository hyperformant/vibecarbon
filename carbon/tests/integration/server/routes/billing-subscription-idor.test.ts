import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { HonoVariables } from '@server/types';

// adminDb (service role) is used by the handler AFTER the org membership gate.
// A customer lookup that returns null yields {status:'none'} — enough to prove
// the request reached the handler (i.e. the gate passed).
const adminChain = {
  select: () => adminChain,
  eq: () => adminChain,
  is: () => adminChain,
  maybeSingle: async () => ({ data: null, error: null }),
};
vi.mock('@server/lib/supabase', () => ({ supabaseAdmin: { from: () => adminChain } }));
vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@server/billing', () => ({
  isBillingConfigured: () => true,
  getBillingProvider: () => ({ type: 'stripe' }),
  getProviderPriceIds: () => ({}),
}));

const { billingRoutes } = await import('@server/routes/v1/billing');

// Build an app that injects an authenticated user + a fake RLS-enforced
// per-user Supabase client whose memberships lookup returns `membershipRole`.
function appWith(membershipRole: string | null) {
  const app = new Hono<{ Variables: HonoVariables }>();
  app.use('*', async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal injected user
    c.set('user', { id: 'u1', email: 'u@test.com' } as any);
    c.set('aal', 'aal2');
    // biome-ignore lint/suspicious/noExplicitAny: minimal supabase double
    c.set('supabase', {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: membershipRole ? { role: membershipRole } : null,
                error: membershipRole ? null : { message: 'no rows' },
              }),
            }),
          }),
        }),
      }),
    } as any);
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
});
