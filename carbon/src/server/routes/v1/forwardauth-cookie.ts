import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { isSuperAdmin } from '../../lib/auth';
import { parentCookieDomain } from '../../lib/cookie-domain';
import type { HonoVariables } from '../../types';

/**
 * FORWARDAUTH ADMIN COOKIE (Super Admin only)
 *
 * SECURITY: vc-admin-token is the ONLY cookie /api/_internal/verify-role
 * accepts. It is HttpOnly (XSS cannot read it), carries the access token
 * only (no refresh token, no session JSON), and lives 1 hour. Only
 * super_admins ever receive it — regular users carry no domain-wide cookie
 * at all. The SPA mints it on login/refresh (AuthProvider.syncAdminCookie)
 * and clears it on sign-out. See spec 2026-07-24-session-cookie-split.
 */
export const FORWARDAUTH_COOKIE = 'vc-admin-token';

function forwardAuthCookieOpts() {
  const siteUrl = process.env.SITE_URL || 'http://localhost:5173';
  return {
    httpOnly: true,
    secure: siteUrl.startsWith('https:'),
    sameSite: 'Lax' as const,
    domain: parentCookieDomain(siteUrl),
    path: '/',
    maxAge: 3600,
  };
}

const forwardAuthCookieRoutes = new Hono<{ Variables: HonoVariables }>();

forwardAuthCookieRoutes.post('/', async (c) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if (!isSuperAdmin(user)) {
    return c.json({ error: 'Super admin access required' }, 403);
  }
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return c.json({ error: 'Bearer token required' }, 400);
  }
  // The cookie value is the caller's own (already-middleware-verified) access
  // token — verify-role revalidates it against GoTrue on every gated request.
  setCookie(c, FORWARDAUTH_COOKIE, token, forwardAuthCookieOpts());
  return c.body(null, 204);
});

forwardAuthCookieRoutes.delete('/', async (c) => {
  deleteCookie(c, FORWARDAUTH_COOKIE, forwardAuthCookieOpts());
  return c.body(null, 204);
});

export { forwardAuthCookieRoutes };
