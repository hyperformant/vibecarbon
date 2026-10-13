import { createMiddleware } from 'hono/factory';
import { auth } from '../auth';
import type { HonoVariables } from '../types';

/**
 * Resolve the caller's session from the auth cookie and put it on the
 * context: `user`, `session`, and `aal` (the session's assurance level:
 * 'aal2' once this session passed a second factor, else 'aal1'; null when
 * signed out). Routes check `c.get('user')` and return 401 when it is null.
 *
 * Every lookup reads the database, never the signed session-cache cookie.
 * The cache would keep a revoked session, a banned user, a demoted super
 * admin or a stale assurance level valid until it expires; nearly every
 * /api route acts on the caller's identity or role, so instead of sorting
 * routes into "sensitive" and not (and getting one wrong), none trust it.
 * The cost is one indexed session + user read per API request, on the
 * pool every route already uses. The cookie cache still spares the
 * browser client's own frequent /api/auth/get-session polls (Better Auth's
 * admin endpoints bypass it themselves).
 *
 * The health probes skip the lookup: they are public and polled often.
 */
/**
 * A banned user (ban not yet expired) is treated as signed out. Banning
 * already deletes the user's sessions and blocks new ones; this covers a
 * session that outlived that (defence in depth).
 */
function isBanned(user: { banned?: boolean | null; banExpires?: Date | null }): boolean {
  if (!user.banned) return false;
  return !user.banExpires || new Date(user.banExpires).getTime() > Date.now();
}

export const sessionMiddleware = createMiddleware<{ Variables: HonoVariables }>(async (c, next) => {
  if (c.req.path === '/api/health' || c.req.path === '/api/health/ready') {
    c.set('user', null);
    c.set('session', null);
    c.set('aal', null);
    await next();
    return;
  }

  const data = await auth.api.getSession({
    headers: c.req.raw.headers,
    query: { disableCookieCache: true },
  });
  if (data && !isBanned(data.user)) {
    c.set('user', data.user);
    c.set('session', data.session);
    c.set('aal', data.session.twoFactorVerified ? 'aal2' : 'aal1');
  } else {
    c.set('user', null);
    c.set('session', null);
    c.set('aal', null);
  }
  await next();
});
