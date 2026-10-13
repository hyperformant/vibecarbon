import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { mfaOn, mint, revoke } = vi.hoisted(() => ({
  mfaOn: vi.fn(async () => false),
  mint: vi.fn(async (_sessionId: string) => 'minted-forwardauth-token'),
  revoke: vi.fn(async (_token: string) => undefined),
}));
vi.mock('@server/lib/mfa-settings', () => ({ isMfaGloballyEnabled: mfaOn }));
vi.mock('@server/auth/forwardauth-token', () => ({
  FORWARDAUTH_TTL_SECONDS: 3600,
  mintForwardAuthToken: mint,
  revokeForwardAuthToken: revoke,
}));

const { parentCookieDomain } = await import('@server/lib/cookie-domain');
const { forwardAuthCookieRoutes } = await import('@server/routes/v1/forwardauth-cookie');

const superAdmin = { id: 'u1', email: 'admin@example.com', role: 'super_admin' };
const regularUser = { id: 'u2', email: 'user@example.com', role: 'user' };

const adminSession = { id: 's1', token: 'the-session-token', twoFactorVerified: false };

function appWithUser(user: unknown, session: unknown = user ? adminSession : null) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: test stub for the session middleware
    (c as any).set('user', user);
    // biome-ignore lint/suspicious/noExplicitAny: test stub for the session middleware
    (c as any).set('session', session);
    await next();
  });
  app.route('/api/v1/admin/forwardauth-cookie', forwardAuthCookieRoutes);
  return app;
}

describe('parentCookieDomain', () => {
  it('returns the last two labels for a production domain', () => {
    expect(parentCookieDomain('https://example.com')).toBe('.example.com');
    expect(parentCookieDomain('https://app.example.com')).toBe('.example.com');
  });

  it('documents the two-label limitation for multi-part TLDs (matches client getCookieDomain)', () => {
    expect(parentCookieDomain('https://app.example.co.uk')).toBe('.co.uk');
  });

  it('is host-only (undefined) for localhost and unparseable input', () => {
    expect(parentCookieDomain('http://localhost:5173')).toBeUndefined();
    expect(parentCookieDomain('http://app.localhost:5173')).toBeUndefined();
    expect(parentCookieDomain('not a url')).toBeUndefined();
  });
});

describe('POST /api/v1/admin/forwardauth-cookie', () => {
  const origSiteUrl = process.env.SITE_URL;
  beforeEach(() => {
    process.env.SITE_URL = 'https://example.com';
    mfaOn.mockReset();
    mfaOn.mockResolvedValue(false);
  });
  afterEach(() => {
    process.env.SITE_URL = origSiteUrl;
  });

  it('401 when unauthenticated', async () => {
    const res = await appWithUser(null).request('/api/v1/admin/forwardauth-cookie', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  it('403 for a non-super-admin', async () => {
    const res = await appWithUser(regularUser).request('/api/v1/admin/forwardauth-cookie', {
      method: 'POST',
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('403 for an impersonation session', async () => {
    const res = await appWithUser(superAdmin, {
      ...adminSession,
      impersonatedBy: 'someone-else',
    }).request('/api/v1/admin/forwardauth-cookie', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('MFA on: an aal1 session gets 403 mfa_required and no cookie; aal2 gets the cookie', async () => {
    mfaOn.mockResolvedValue(true);
    const refused = await appWithUser(superAdmin).request('/api/v1/admin/forwardauth-cookie', {
      method: 'POST',
    });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toBe('mfa_required');
    expect(refused.headers.get('Set-Cookie')).toBeNull();

    const ok = await appWithUser(superAdmin, {
      ...adminSession,
      twoFactorVerified: true,
    }).request('/api/v1/admin/forwardauth-cookie', { method: 'POST' });
    expect(ok.status).toBe(204);
  });

  it('SECURITY: mints an HttpOnly, domain-scoped, 1h vc-admin-token cookie from the session, never from the request', async () => {
    const res = await appWithUser(superAdmin).request('/api/v1/admin/forwardauth-cookie', {
      method: 'POST',
      headers: { Authorization: 'Bearer attacker-chosen' },
      body: JSON.stringify({ token: 'attacker-chosen' }),
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    const cookie = res.headers.get('Set-Cookie') || '';
    expect(cookie).toContain('vc-admin-token=minted-forwardauth-token');
    expect(mint).toHaveBeenCalledWith('s1');
    expect(cookie).not.toContain('the-session-token');
    expect(cookie).not.toContain('attacker-chosen');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=3600');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Domain=.example.com');
    expect(cookie).toContain('Secure');
  });

  it('is host-only and not Secure on http localhost', async () => {
    process.env.SITE_URL = 'http://localhost:5173';
    const res = await appWithUser(superAdmin).request('/api/v1/admin/forwardauth-cookie', {
      method: 'POST',
    });
    expect(res.status).toBe(204);
    const cookie = res.headers.get('Set-Cookie') || '';
    expect(cookie).not.toContain('Domain=');
    expect(cookie).not.toContain('Secure');
  });
});

describe('DELETE /api/v1/admin/forwardauth-cookie', () => {
  it('forgets the token it carries', async () => {
    const res = await appWithUser(null).request('/api/v1/admin/forwardauth-cookie', {
      method: 'DELETE',
      headers: { Cookie: 'vc-admin-token=old-token' },
    });
    expect(res.status).toBe(204);
    expect(revoke).toHaveBeenCalledWith('old-token');
  });

  it('clears the cookie', async () => {
    process.env.SITE_URL = 'https://example.com';
    const res = await appWithUser(null).request('/api/v1/admin/forwardauth-cookie', {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    const cookie = res.headers.get('Set-Cookie') || '';
    expect(cookie).toContain('vc-admin-token=');
    expect(cookie).toContain('Max-Age=0');
  });
});
