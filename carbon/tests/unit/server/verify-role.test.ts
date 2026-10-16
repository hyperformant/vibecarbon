import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * verify-role (Traefik ForwardAuth) over a mocked token store. The real
 * mint / hash / bound-session round trip against the database is in
 * tests/db/admin-surfaces.test.ts.
 */

vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { resolve, mfaOn } = vi.hoisted(() => ({
  resolve: vi.fn(),
  mfaOn: vi.fn(async () => false),
}));
vi.mock('@server/auth/forwardauth-token', () => ({
  FORWARDAUTH_TTL_SECONDS: 3600,
  resolveForwardAuthToken: resolve,
}));
vi.mock('@server/lib/mfa-settings', () => ({ isMfaGloballyEnabled: mfaOn }));

const { verifyRoleRoutes } = await import('@server/routes/_internal/verify-role');

const superAdmin = {
  id: 'u1',
  email: 'admin@example.com',
  role: 'super_admin',
  banned: false,
  banExpires: null,
};

function identity(
  user: Record<string, unknown>,
  session: Record<string, unknown> = { id: 's1', twoFactorVerified: false }
) {
  resolve.mockResolvedValue({ user, session });
}

const URL_BASE = '/?role=super_admin';
const request = (headers: Record<string, string>) => verifyRoleRoutes.request(URL_BASE, { headers });

beforeEach(() => {
  resolve.mockReset();
  mfaOn.mockReset();
  mfaOn.mockResolvedValue(false);
});

describe('verify-role', () => {
  it('SECURITY: accepts vc-admin-token and resolves it through the token store', async () => {
    identity(superAdmin);
    const res = await request({ Cookie: 'vc-admin-token=fa-token-1' });
    expect(res.status).toBe(200);
    expect(resolve).toHaveBeenCalledWith('fa-token-1');
  });

  it('sets X-User-Id / Email / Role and X-Authenticated-User', async () => {
    identity(superAdmin);
    const res = await request({ Cookie: 'vc-admin-token=t' });
    expect(res.headers.get('X-User-Id')).toBe('u1');
    expect(res.headers.get('X-User-Email')).toBe('admin@example.com');
    expect(res.headers.get('X-User-Role')).toBe('super_admin');
    expect(res.headers.get('X-Authenticated-User')).toBe('admin@example.com');
  });

  it("SECURITY: the app's own session cookie is NOT a ForwardAuth credential", async () => {
    identity(superAdmin);
    for (const name of ['better-auth.session_token', '__Secure-better-auth.session_token']) {
      expect((await request({ Cookie: `${name}=signed.value` })).status).toBe(401);
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it('SECURITY: Authorization: Bearer and X-Forwarded-Access-Token are not credentials', async () => {
    identity(superAdmin);
    expect((await request({ Authorization: 'Bearer fa-token-1' })).status).toBe(401);
    expect((await request({ 'X-Forwarded-Access-Token': 'fa-token-1' })).status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('401 when the token or its session is gone (expired, forgotten, signed out)', async () => {
    resolve.mockResolvedValue(null);
    expect((await request({ Cookie: 'vc-admin-token=t' })).status).toBe(401);
  });

  it('401 for a banned user; an expired ban passes', async () => {
    identity({ ...superAdmin, banned: true, banExpires: null });
    expect((await request({ Cookie: 'vc-admin-token=t' })).status).toBe(401);
    identity({ ...superAdmin, banned: true, banExpires: new Date(Date.now() - 1000) });
    expect((await request({ Cookie: 'vc-admin-token=t' })).status).toBe(200);
  });

  it('MFA on: an aal1 session is refused, an aal2 session passes', async () => {
    mfaOn.mockResolvedValue(true);
    identity(superAdmin, { id: 's1', twoFactorVerified: false });
    expect((await request({ Cookie: 'vc-admin-token=t' })).status).toBe(401);
    identity(superAdmin, { id: 's1', twoFactorVerified: true });
    expect((await request({ Cookie: 'vc-admin-token=t' })).status).toBe(200);
  });

  it('403 when the user lacks the required role (exact match)', async () => {
    for (const role of ['user', 'admin', 'Super_Admin', null]) {
      identity({ ...superAdmin, role });
      expect((await request({ Cookie: 'vc-admin-token=t' })).status).toBe(403);
    }
  });

  it('500 (no detail) when the lookup fails', async () => {
    resolve.mockRejectedValue(new Error('db down'));
    const res = await request({ Cookie: 'vc-admin-token=t' });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('Internal Server Error');
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
