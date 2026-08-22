import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// signed-cookie reads the HMAC key lazily from process.env — set it before the
// route (and its cookie signer) load so start/verify share one secret.
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const getUserByIdMock = vi.fn();
const generateLinkMock = vi.fn();
const refreshUserSessionMock = vi.fn();
vi.mock('@server/lib/supabase', () => ({
  supabaseAdmin: {
    auth: {
      admin: {
        getUserById: (...a: unknown[]) => getUserByIdMock(...a),
        generateLink: (...a: unknown[]) => generateLinkMock(...a),
      },
    },
  },
  refreshUserSession: (...a: unknown[]) => refreshUserSessionMock(...a),
}));

// Step-up MFA middleware is covered by its own tests; pass through here.
vi.mock('@server/middleware/requireAal2', () => ({
  requireAal2: async (_c: unknown, next: () => Promise<void>) => next(),
}));

const { impersonationRoutes } = await import('@server/routes/v1/impersonation');
const { logger } = await import('@server/lib/logger');
const { signCookiePayload, verifyCookiePayload } = await import('@server/lib/signed-cookie');

const superAdmin = { id: 'admin-1', email: 'admin@example.com', app_metadata: { role: 'super_admin' } };
const targetUser = {
  id: 'target-1',
  email: 'customer@example.com',
  app_metadata: {},
  user_metadata: { full_name: 'Customer One' },
};

const BASE = '/api/v1/admin/impersonate';

function appWithUser(user: unknown) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: test stub for the session middleware
    (c as any).set('user', user);
    await next();
  });
  app.route(BASE, impersonationRoutes);
  return app;
}

function restoreCookie(overrides: Record<string, unknown> = {}): string {
  const value = signCookiePayload({
    refreshToken: 'rt-admin',
    adminId: 'admin-1',
    adminEmail: 'admin@example.com',
    startedAt: Date.now() - 60_000,
    ...overrides,
  });
  return `vc-impersonation-restore=${value}`;
}

beforeEach(() => {
  process.env.SITE_URL = 'https://example.com';
  getUserByIdMock.mockResolvedValue({ data: { user: targetUser }, error: null });
  generateLinkMock.mockResolvedValue({
    data: { properties: { hashed_token: 'hash-1' } },
    error: null,
  });
  refreshUserSessionMock.mockResolvedValue({
    data: { session: { access_token: 'new-at', refresh_token: 'new-rt' } },
    error: null,
  });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /admin/impersonate/:userId (start)', () => {
  function start(user: unknown, userId = 'target-1', body: unknown = { refreshToken: 'rt-admin' }) {
    return appWithUser(user).request(`${BASE}/${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('403 for a non-super-admin', async () => {
    const res = await start({ id: 'u2', app_metadata: {} });
    expect(res.status).toBe(403);
  });

  it('400 when the body lacks refreshToken', async () => {
    const res = await start(superAdmin, 'target-1', {});
    expect(res.status).toBe(400);
  });

  it('400 on self-impersonation', async () => {
    const res = await start(superAdmin, 'admin-1');
    expect(res.status).toBe(400);
  });

  it('403 when the target is another super_admin', async () => {
    getUserByIdMock.mockResolvedValue({
      data: { user: { ...targetUser, app_metadata: { role: 'super_admin' } } },
      error: null,
    });
    const res = await start(superAdmin);
    expect(res.status).toBe(403);
  });

  it('404 when the target does not exist', async () => {
    getUserByIdMock.mockResolvedValue({ data: { user: null }, error: { message: 'nope' } });
    const res = await start(superAdmin);
    expect(res.status).toBe(404);
  });

  it('SECURITY: parks the admin refresh token in an HttpOnly path-scoped Strict cookie', async () => {
    const res = await start(superAdmin);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tokenHash).toBe('hash-1');
    expect(body.user).toEqual({ id: 'target-1', email: 'customer@example.com', name: 'Customer One' });

    const cookie = res.headers.get('Set-Cookie') || '';
    expect(cookie).toContain('vc-impersonation-restore=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api/v1/admin/impersonate');
    expect(cookie).toContain('Max-Age=3600');
    // The payload is HMAC-signed (base64url.hmac), not plain JSON — verify it
    // round-trips to the parked token rather than asserting a raw substring.
    const value = cookie.split('vc-impersonation-restore=')[1].split(';')[0];
    const parked = verifyCookiePayload<{ refreshToken: string }>(value);
    expect(parked?.refreshToken).toBe('rt-admin');
  });
});

describe('POST /admin/impersonate/stop', () => {
  function stop(cookie?: string, body: unknown = {}) {
    return appWithUser(null).request(`${BASE}/stop`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it('401 when there is no restore cookie', async () => {
    const res = await stop();
    expect(res.status).toBe(401);
  });

  it('SECURITY: rejects a forged/tossed cookie (bad signature) without refreshing', async () => {
    const forged = JSON.stringify({
      refreshToken: 'attacker-rt',
      adminId: 'attacker',
      adminEmail: 'attacker@evil.test',
      startedAt: Date.now(),
    });
    // Plain JSON (or any value not signed with the server secret) must fail.
    const res = await stop(`vc-impersonation-restore=${encodeURIComponent(forged)}`);
    expect(res.status).toBe(401);
    expect(refreshUserSessionMock).not.toHaveBeenCalled();
    expect(res.headers.get('Set-Cookie') || '').toContain('Max-Age=0');
  });

  it('refreshes the parked token, clears the cookie, returns the admin session, logs duration', async () => {
    const res = await stop(restoreCookie());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session).toEqual({ access_token: 'new-at', refresh_token: 'new-rt' });
    expect(refreshUserSessionMock).toHaveBeenCalledWith('rt-admin');

    const cookie = res.headers.get('Set-Cookie') || '';
    expect(cookie).toContain('vc-impersonation-restore=');
    expect(cookie).toContain('Max-Age=0');

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ adminId: 'admin-1', durationMs: expect.any(Number) }),
      'Admin impersonation stopped'
    );
  });

  it('401 (and clears the cookie) when the parked token no longer refreshes', async () => {
    refreshUserSessionMock.mockResolvedValue({
      data: { session: null },
      error: { message: 'invalid refresh token' },
    });
    const res = await stop(restoreCookie());
    expect(res.status).toBe(401);
    expect(res.headers.get('Set-Cookie') || '').toContain('Max-Age=0');
  });

  it('{discard:true} clears the cookie without refreshing (sign-out path)', async () => {
    const res = await stop(restoreCookie(), { discard: true });
    expect(res.status).toBe(204);
    expect(refreshUserSessionMock).not.toHaveBeenCalled();
    expect(res.headers.get('Set-Cookie') || '').toContain('Max-Age=0');
  });
});
