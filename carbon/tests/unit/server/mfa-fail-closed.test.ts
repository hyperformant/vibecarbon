import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryChain } from '../../_helpers/drizzle-mock';

/**
 * The aal2 gate with the REAL mfa-settings module over a mocked adminDb:
 * an unreadable setting (no cache yet) must deny, never wave a session
 * through. With the cache warm and false, MFA-off behaviour is unchanged.
 */

const { selectMock, resolve, liveSessionMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  resolve: vi.fn(),
  liveSessionMock: vi.fn(),
}));

vi.mock('@server/db/client', () => ({
  adminDb: { select: () => queryChain(selectMock) },
}));
vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@server/auth/forwardauth-token', () => ({
  FORWARDAUTH_TTL_SECONDS: 3600,
  resolveForwardAuthToken: resolve,
}));
vi.mock('better-auth/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('better-auth/api')>()),
  getAuthoritativeSessionFromCtx: liveSessionMock,
}));

const { __resetMfaSettingsCache, isMfaGloballyEnabled } = await import('@server/lib/mfa-settings');
const { requireAal2 } = await import('@server/middleware/requireAal2');
const { verifyRoleRoutes } = await import('@server/routes/_internal/verify-role');
const { sessionAssurance } = await import('@server/auth/assurance');

const superAdmin = {
  id: 'u1',
  email: 'admin@example.com',
  role: 'super_admin',
  banned: false,
  banExpires: null,
  twoFactorEnabled: true,
};
const aal1 = { id: 's1', twoFactorVerified: false };

function gatedApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: test-only context variables
    (c as any).set('user', superAdmin);
    // biome-ignore lint/suspicious/noExplicitAny: test-only context variables
    (c as any).set('session', aal1);
    await next();
  });
  // biome-ignore lint/suspicious/noExplicitAny: Hono generic mismatch in test wiring
  app.get('/sensitive', requireAal2 as any, (c) => c.text('ok'));
  return app;
}

const adminGuard = () => {
  const hook = sessionAssurance().hooks.before[0];
  // biome-ignore lint/suspicious/noExplicitAny: Better Auth's middleware context
  return (ctx: any) => (hook.handler as any)(ctx);
};
const adminCtx = {
  path: '/admin/list-users',
  request: {},
  headers: new Headers(),
  getCookie: () => 'cookie',
  context: { authCookies: { sessionToken: { name: 'session_token' } } },
};

beforeEach(() => {
  __resetMfaSettingsCache();
  selectMock.mockReset();
  resolve.mockReset();
  liveSessionMock.mockReset();
});

describe('an unreadable MFA setting fails closed', () => {
  beforeEach(() => {
    selectMock.mockRejectedValue(new Error('db down'));
  });

  it('isMfaGloballyEnabled reports unknown as null', async () => {
    expect(await isMfaGloballyEnabled()).toBeNull();
  });

  it('requireAal2 refuses an aal1 super admin with 403', async () => {
    const res = await gatedApp().request('/sensitive');
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('mfa_required');
  });

  it('verify-role refuses an aal1 super admin', async () => {
    resolve.mockResolvedValue({ user: superAdmin, session: aal1 });
    const res = await verifyRoleRoutes.request('/?role=super_admin', {
      headers: { Cookie: 'vc-admin-token=t' },
    });
    expect([401, 403]).toContain(res.status);
  });

  it('the admin guard in assurance.ts denies an aal1 session', async () => {
    liveSessionMock.mockResolvedValue({ user: superAdmin, session: aal1 });
    await expect(adminGuard()(adminCtx)).rejects.toMatchObject({
      body: { code: 'MFA_REQUIRED' },
    });
  });
});

describe('MFA known to be off is unchanged', () => {
  beforeEach(async () => {
    selectMock.mockResolvedValueOnce([{ value: { enabled: false } }]);
    expect(await isMfaGloballyEnabled()).toBe(false); // warms the cache
    selectMock.mockRejectedValue(new Error('db down'));
  });

  it('an aal1 session passes requireAal2', async () => {
    const res = await gatedApp().request('/sensitive');
    expect(res.status).toBe(200);
  });

  it('an aal1 super admin passes verify-role', async () => {
    resolve.mockResolvedValue({ user: superAdmin, session: aal1 });
    const res = await verifyRoleRoutes.request('/?role=super_admin', {
      headers: { Cookie: 'vc-admin-token=t' },
    });
    expect(res.status).toBe(200);
  });

  it('the admin guard lets an aal1 session through', async () => {
    liveSessionMock.mockResolvedValue({ user: superAdmin, session: aal1 });
    await expect(adminGuard()(adminCtx)).resolves.toBeUndefined();
  });
});
