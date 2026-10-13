import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  FORWARDAUTH_TTL_SECONDS,
  mintForwardAuthToken,
  revokeForwardAuthTokens,
} from '../../auth/forwardauth-token';
import { dbErrorForLog } from '../../db/errors';
import { isSuperAdmin } from '../../lib/auth';
import { parentCookieDomain } from '../../lib/cookie-domain';
import { logger } from '../../lib/logger';
import { requireAal2 } from '../../middleware/requireAal2';
import type { HonoVariables } from '../../types';

/**
 * FORWARDAUTH ADMIN COOKIE (Super Admin only)
 *
 * SECURITY: vc-admin-token is the ONLY cookie /api/_internal/verify-role
 * accepts. It is HttpOnly (XSS cannot read it), lives 1 hour, and carries a
 * dedicated ForwardAuth token (auth/forwardauth-token.ts), never the
 * session token: the parent-domain cookie reaches the admin tools behind
 * ForwardAuth, so what it carries is good for verify-role only, for one
 * hour, and only while the session it was minted from is alive. Minting
 * again replaces the session's previous token. Only super admins ever
 * receive it, from an aal2 session while MFA is globally on (the same rule
 * as Better Auth's admin endpoints), and never from an impersonation
 * session. Regular users carry no domain-wide cookie at all. The SPA mints
 * it on load and sign-in (AuthProvider.syncAdminCookie) and clears it on
 * sign-out (DELETE forgets the token too). See spec
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
    maxAge: FORWARDAUTH_TTL_SECONDS,
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
    let token: string;
    try {
      token = await mintForwardAuthToken(session.id);
    } catch (err) {
      logger.error({ err: dbErrorForLog(err) }, 'Could not mint the ForwardAuth token');
      return c.json({ error: 'Could not set the admin cookie' }, 500);
    }
    setCookie(c, FORWARDAUTH_COOKIE, token, forwardAuthCookieOpts());
    return c.body(null, 204);
  }
);

forwardAuthCookieRoutes.delete('/', async (c) => {
  const token = getCookie(c, FORWARDAUTH_COOKIE);
  const sessionId = c.get('session')?.id;
  if (token || sessionId) {
    try {
      // Every token of the session, not just the cookie's (a session can
      // hold two); found from the cookie, the caller's session, or both.
      await revokeForwardAuthTokens({ rawToken: token, sessionId });
    } catch (err) {
      // The cookie still goes, and the token dies with its hour or session.
      logger.warn({ err: dbErrorForLog(err) }, 'Could not forget the ForwardAuth token');
    }
  }
  deleteCookie(c, FORWARDAUTH_COOKIE, forwardAuthCookieOpts());
  return c.body(null, 204);
});

export { forwardAuthCookieRoutes };
