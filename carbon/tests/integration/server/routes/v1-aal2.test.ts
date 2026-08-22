import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HonoVariables } from '@server/types';

const { maybeSingleMock } = vi.hoisted(() => ({ maybeSingleMock: vi.fn() }));

// supabaseAdmin is used both for the app_settings read (gate) and by handlers.
// The gate short-circuits gated paths before handlers run, so an app_settings-
// shaped chain is enough. The PATCH "skip" case proceeds into the handler,
// which calls getUserOrgRole on the USER client (c.get('supabase')) — injected
// separately below.
vi.mock('@server/lib/supabase', () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: maybeSingleMock }) }) }),
  },
}));
vi.mock('@server/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@server/lib/email', () => ({ sendEmail: vi.fn() }));

const { v1Routes } = await import('@server/routes/v1/index');
const { __resetMfaSettingsCache } = await import('@server/lib/mfa-settings');

// User-scoped supabase stub whose membership lookups resolve to "no role", so a
// request that passes the gate cleanly 404s instead of crashing.
const noRoleSupabase = {
  from: () => ({
    select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) }),
  }),
};

function appWith(aal: 'aal1' | 'aal2', user: unknown = { id: 'u1', email: 'u@test.com' }) {
  const app = new Hono<{ Variables: HonoVariables }>();
  app.use('*', async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal injected context
    c.set('user', user as any);
    c.set('aal', aal);
    // biome-ignore lint/suspicious/noExplicitAny: minimal user-client stub
    c.set('supabase', noRoleSupabase as any);
    await next();
  });
  app.route('/api/v1', v1Routes);
  return app;
}

function jsonPatch(body: unknown): RequestInit {
  return { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

beforeEach(() => {
  __resetMfaSettingsCache();
  maybeSingleMock.mockReset();
  maybeSingleMock.mockResolvedValue({ data: { value: { enabled: true } }, error: null });
});

describe('account + org endpoints are aal2-gated when MFA is globally enabled', () => {
  it('DELETE /me returns 403 mfa_required for aal1', async () => {
    const res = await appWith('aal1').request('/api/v1/me', { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('mfa_required');
  });

  it('DELETE /organizations/:id returns 403 mfa_required for aal1', async () => {
    const res = await appWith('aal1').request('/api/v1/organizations/org-1', { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('mfa_required');
  });

  it('PATCH member role -> OWNER returns 403 mfa_required for aal1 (transfer gated)', async () => {
    const res = await appWith('aal1').request(
      '/api/v1/organizations/org-1/members/u2',
      jsonPatch({ role: 'OWNER' }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('mfa_required');
  });

  it('PATCH member role -> ADMIN is NOT blocked by the MFA gate for aal1', async () => {
    const res = await appWith('aal1').request(
      '/api/v1/organizations/org-1/members/u2',
      jsonPatch({ role: 'ADMIN' }),
    );
    // Proceeds past the gate into the handler, which 404s on the null-role
    // membership lookup. The point: it is NOT the mfa_required 403.
    const body = await res.json();
    expect(body.error).not.toBe('mfa_required');
  });

  it('aal2 session passes the gate and reaches the handler on DELETE /organizations/:id', async () => {
    // Same route as the aal1 -> 403 test above. With aal2 the gate is satisfied
    // and the handler runs; getUserOrgRole (on the null-role stub) then returns
    // 404 "not found / access denied". Asserting the concrete 404 — not merely
    // "not 403" — proves the handler actually executed past the gate. The aal1
    // companion test (403 mfa_required on this same route) is what guards
    // against the middleware being accidentally removed: if it were, aal1 would
    // also reach the handler and return 404 instead of 403.
    const del = await appWith('aal2').request('/api/v1/organizations/org-1', { method: 'DELETE' });
    expect(del.status).toBe(404);
    expect((await del.json()).error).not.toBe('mfa_required');
  });
});
