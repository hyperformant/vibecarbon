import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { parentCookieDomain } = await import('@server/lib/cookie-domain');
const { forwardAuthCookieRoutes } = await import('@server/routes/v1/forwardauth-cookie');

const superAdmin = { id: 'u1', email: 'admin@example.com', app_metadata: { role: 'super_admin' } };
const regularUser = { id: 'u2', email: 'user@example.com', app_metadata: {} };

function appWithUser(user: unknown) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: test stub for the session middleware
    (c as any).set('user', user);
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
      headers: { Authorization: 'Bearer some-token' },
    });
    expect(res.status).toBe(403);
  });

  it('400 when no bearer token accompanies the request', async () => {
    const res = await appWithUser(superAdmin).request('/api/v1/admin/forwardauth-cookie', {
      method: 'POST',
    });
    expect(res.status).toBe(400);
  });

  it('SECURITY: mints an HttpOnly, domain-scoped, 1h vc-admin-token cookie from the bearer', async () => {
    const res = await appWithUser(superAdmin).request('/api/v1/admin/forwardauth-cookie', {
      method: 'POST',
      headers: { Authorization: 'Bearer the-access-token' },
    });
    expect(res.status).toBe(204);
    const cookie = res.headers.get('Set-Cookie') || '';
    expect(cookie).toContain('vc-admin-token=the-access-token');
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
      headers: { Authorization: 'Bearer the-access-token' },
    });
    expect(res.status).toBe(204);
    const cookie = res.headers.get('Set-Cookie') || '';
    expect(cookie).not.toContain('Domain=');
    expect(cookie).not.toContain('Secure');
  });
});

describe('DELETE /api/v1/admin/forwardauth-cookie', () => {
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
