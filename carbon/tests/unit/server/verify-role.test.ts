import { makeSignature } from 'better-auth/crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * verify-role (Traefik ForwardAuth) over a mocked auth API. The signed-cookie
 * round trip against the real auth instance and database is in
 * tests/db/admin-surfaces.test.ts.
 */

vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const SECRET = 'test-secret-test-secret-test-secret-0123';
const COOKIE_NAME = '__Secure-better-auth.session_token';

const { getSession, mfaOn } = vi.hoisted(() => ({
  getSession: vi.fn(),
  mfaOn: vi.fn(async () => false),
}));
vi.mock('@server/auth', () => ({
  auth: {
    api: { getSession },
    $context: Promise.resolve({
      secret: 'test-secret-test-secret-test-secret-0123',
      authCookies: { sessionToken: { name: '__Secure-better-auth.session_token' } },
    }),
  },
}));
vi.mock('@server/lib/mfa-settings', () => ({ isMfaGloballyEnabled: mfaOn }));

const { verifyRoleRoutes } = await import('@server/routes/_internal/verify-role');

const superAdmin = { id: 'u1', email: 'admin@example.com', role: 'super_admin', banned: false };

function sessionFor(
  user: Record<string, unknown>,
  session: Record<string, unknown> = { twoFactorVerified: false }
) {
  getSession.mockResolvedValue({ user, session });
}

const URL_BASE = '/?role=super_admin';
const request = (headers: Record<string, string>) => verifyRoleRoutes.request(URL_BASE, { headers });

beforeEach(() => {
  getSession.mockReset();
  mfaOn.mockReset();
  mfaOn.mockResolvedValue(false);
});

describe('verify-role', () => {
  it('SECURITY: accepts vc-admin-token, looked up as a signed session cookie, uncached and unrefreshed', async () => {
    sessionFor(superAdmin);
    const res = await request({ Cookie: 'vc-admin-token=sess-token-1' });
    expect(res.status).toBe(200);

    const [{ headers, query }] = getSession.mock.calls[0];
    const expected = `sess-token-1.${await makeSignature('sess-token-1', SECRET)}`;
    expect((headers as Headers).get('cookie')).toBe(
      `${COOKIE_NAME}=${encodeURIComponent(expected)}`
    );
    expect(query).toEqual({ disableCookieCache: true, disableRefresh: true });
  });

  it('sets X-User-Id / Email / Role and X-Authenticated-User', async () => {
    sessionFor(superAdmin);
    const res = await request({ Cookie: 'vc-admin-token=t' });
    expect(res.headers.get('X-User-Id')).toBe('u1');
    expect(res.headers.get('X-User-Email')).toBe('admin@example.com');
    expect(res.headers.get('X-User-Role')).toBe('super_admin');
    expect(res.headers.get('X-Authenticated-User')).toBe('admin@example.com');
  });

  it("SECURITY: the app's own session cookie is NOT a ForwardAuth credential", async () => {
    sessionFor(superAdmin);
    for (const name of ['better-auth.session_token', COOKIE_NAME]) {
      const res = await request({ Cookie: `${name}=signed.value` });
      expect(res.status).toBe(401);
    }
    expect(getSession).not.toHaveBeenCalled();
  });

  it('SECURITY: Authorization: Bearer and X-Forwarded-Access-Token are not credentials', async () => {
    sessionFor(superAdmin);
    expect((await request({ Authorization: 'Bearer sess-token-1' })).status).toBe(401);
    expect((await request({ 'X-Forwarded-Access-Token': 'sess-token-1' })).status).toBe(401);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('401 when the session is gone (signed out, revoked, expired)', async () => {
    getSession.mockResolvedValue(null);
    expect((await request({ Cookie: 'vc-admin-token=t' })).status).toBe(401);
  });

  it('401 for a banned user; an expired ban passes', async () => {
    sessionFor({ ...superAdmin, banned: true, banExpires: null });
    expect((await request({ Cookie: 'vc-admin-token=t' })).status).toBe(401);
    sessionFor({ ...superAdmin, banned: true, banExpires: new Date(Date.now() - 1000) });
    expect((await request({ Cookie: 'vc-admin-token=t' })).status).toBe(200);
  });

  it('MFA on: an aal1 session is refused, an aal2 session passes', async () => {
    mfaOn.mockResolvedValue(true);
    sessionFor(superAdmin, { twoFactorVerified: false });
    expect((await request({ Cookie: 'vc-admin-token=t' })).status).toBe(401);
    sessionFor(superAdmin, { twoFactorVerified: true });
    expect((await request({ Cookie: 'vc-admin-token=t' })).status).toBe(200);
  });

  it('403 when the user lacks the required role (exact match)', async () => {
    for (const role of ['user', 'admin', 'Super_Admin', null]) {
      sessionFor({ ...superAdmin, role });
      expect((await request({ Cookie: 'vc-admin-token=t' })).status).toBe(403);
    }
  });

  it('400 without a role parameter', async () => {
    const res = await verifyRoleRoutes.request('/', { headers: { Cookie: 'vc-admin-token=t' } });
    expect(res.status).toBe(400);
  });

  it('redirects browsers (Accept: text/html) with no token to /login?redirect=', async () => {
    const res = await request({
      Accept: 'text/html',
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'grafana.example.com',
      'X-Forwarded-Uri': '/dashboards',
    });
    expect(res.status).toBe(302);
    const location = res.headers.get('Location') || '';
    expect(location).toContain('/login?redirect=');
    expect(location).toContain(encodeURIComponent('https://grafana.example.com/dashboards'));
  });
});
