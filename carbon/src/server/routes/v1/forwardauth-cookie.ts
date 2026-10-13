import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { isSuperAdmin } from '../../lib/auth';
import { parentCookieDomain } from '../../lib/cookie-domain';
import { requireAal2 } from '../../middleware/requireAal2';
import type { HonoVariables } from '../../types';

/**
 * FORWARDAUTH ADMIN COOKIE (Super Admin only)
 *
 * SECURITY: vc-admin-token is the ONLY cookie /api/_internal/verify-role
 * accepts. It is HttpOnly (XSS cannot read it), lives 1 hour, and carries
 * the caller's own session token, taken server-side from the session the
 * middleware verified (never from the request body, never echoed in a
 * response body). Unsigned: verify-role signs it to look the session up,
 * so the value alone is not a usable app session cookie. Only super admins
 * ever receive it, from an aal2 session while MFA is globally on (the same
 * rule as Better Auth's admin endpoints), and never from an impersonation
 * session. Regular users carry no domain-wide cookie at all. The SPA mints
 * it on load and sign-in (AuthProvider.syncAdminCookie) and clears it on
 * sign-out; signing out also ends the session it names. See spec
 * 2026-07-24-session-cookie-split.
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

forwardAuthCookieRoutes.post(
  '/',
  async (c, next) => {
    const user = c.get('user');
    const session = c.get('session');
    if (!user || !session) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!isSuperAdmin(user) || session.impersonatedBy) {
      return c.json({ error: 'Super admin access required' }, 403);
    }
    await next();
  },
  requireAal2,
  async (c) => {
    // biome-ignore lint/style/noNonNullAssertion: checked by the handler above
    const session = c.get('session')!;
    // verify-role revalidates this session on every gated request.
    setCookie(c, FORWARDAUTH_COOKIE, session.token, forwardAuthCookieOpts());
    return c.body(null, 204);
  }
);

forwardAuthCookieRoutes.delete('/', async (c) => {
  deleteCookie(c, FORWARDAUTH_COOKIE, forwardAuthCookieOpts());
  return c.body(null, 204);
});

export { forwardAuthCookieRoutes };
