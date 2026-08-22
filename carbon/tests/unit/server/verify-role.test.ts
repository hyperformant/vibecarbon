import { describe, expect, it, vi } from 'vitest';

vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const getUserMock = vi.fn();
vi.mock('@server/lib/supabase', () => ({
  supabaseAdmin: { auth: { getUser: (...a: unknown[]) => getUserMock(...a) } },
}));

const { verifyRoleRoutes } = await import('@server/routes/_internal/verify-role');

const superAdmin = {
  id: 'u1',
  email: 'admin@example.com',
  app_metadata: { role: 'super_admin' },
};

function grantUser(user: unknown) {
  getUserMock.mockResolvedValue({ data: { user }, error: null });
}

const URL_BASE = '/?role=super_admin';

describe('verify-role token sources', () => {
  it('SECURITY: accepts the HttpOnly vc-admin-token cookie (raw JWT)', async () => {
    grantUser(superAdmin);
    const res = await verifyRoleRoutes.request(URL_BASE, {
      headers: { Cookie: 'vc-admin-token=raw-jwt-token' },
    });
    expect(res.status).toBe(200);
    expect(getUserMock).toHaveBeenCalledWith('raw-jwt-token');
    expect(res.headers.get('X-User-Id')).toBe('u1');
    expect(res.headers.get('X-Authenticated-User')).toBe('admin@example.com');
  });

  it('SECURITY: the SPA session cookie (sb-auth-token) is NOT a ForwardAuth credential', async () => {
    grantUser(superAdmin);
    const sessionJson = encodeURIComponent(
      JSON.stringify({ access_token: 'spa-token', refresh_token: 'spa-refresh' })
    );
    const res = await verifyRoleRoutes.request(URL_BASE, {
      headers: { Cookie: `sb-auth-token=${sessionJson}` },
    });
    expect(res.status).toBe(401);
    expect(getUserMock).not.toHaveBeenCalledWith('spa-token');
  });

  it('still accepts Authorization: Bearer', async () => {
    grantUser(superAdmin);
    const res = await verifyRoleRoutes.request(URL_BASE, {
      headers: { Authorization: 'Bearer bearer-token' },
    });
    expect(res.status).toBe(200);
    expect(getUserMock).toHaveBeenCalledWith('bearer-token');
  });

  it('403 when the user lacks the required role', async () => {
    grantUser({ id: 'u2', email: 'user@example.com', app_metadata: {} });
    const res = await verifyRoleRoutes.request(URL_BASE, {
      headers: { Cookie: 'vc-admin-token=raw-jwt-token' },
    });
    expect(res.status).toBe(403);
  });

  it('redirects browsers (Accept: text/html) with no token to /login?redirect=', async () => {
    const res = await verifyRoleRoutes.request(URL_BASE, {
      headers: {
        Accept: 'text/html',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'grafana.example.com',
        'X-Forwarded-Uri': '/dashboards',
      },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get('Location') || '';
    expect(location).toContain('/login?redirect=');
    expect(location).toContain(encodeURIComponent('https://grafana.example.com/dashboards'));
  });
});
