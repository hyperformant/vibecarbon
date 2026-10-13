import { createMiddleware } from 'hono/factory';
import { auth } from '../auth';
import type { HonoVariables } from '../types';

/**
 * Resolve the caller's session from the auth cookie and put it on the
 * context: `user`, `session`, and `aal` (the session's assurance level:
 * 'aal2' once this session passed a second factor, else 'aal1'; null when
 * signed out). Routes check `c.get('user')` and return 401 when it is null.
 *
 * The health probes skip the lookup: they are public and polled often.
 */
export const sessionMiddleware = createMiddleware<{ Variables: HonoVariables }>(async (c, next) => {
  if (c.req.path === '/api/health' || c.req.path === '/api/health/ready') {
    c.set('user', null);
    c.set('session', null);
    c.set('aal', null);
    await next();
    return;
  }

  const data = await auth.api.getSession({ headers: c.req.raw.headers });
  if (data) {
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
