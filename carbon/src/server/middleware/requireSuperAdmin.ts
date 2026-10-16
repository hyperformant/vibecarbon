import type { Context, Next } from 'hono';
import { isSuperAdmin } from '../lib/auth';
import type { HonoVariables } from '../types';
import { checkAal2 } from './requireAal2';

type Ctx = Context<{ Variables: HonoVariables }>;

/**
 * Shared decision for super-admin routes. Returns a Response to short-circuit
 * with, or null when the request may proceed.
 *
 * Order: no user -> 401; not a super admin -> 403 (the server-controlled
 * `user.role` the session middleware read from the database, `isSuperAdmin`,
 * exact match); then the aal2 rule of `checkAal2`: while MFA is globally on,
 * THIS session must have verified a second factor (403 `mfa_required`, which
 * the client's apiFetch turns into a step-up prompt), and an impersonation
 * session is refused. Without the aal2 step, a stolen aal1 admin session
 * could turn global MFA off and walk through every other admin gate.
 *
 * Inline use, where a handler cannot take the middleware:
 *   const blocked = await checkSuperAdmin(c); if (blocked) return blocked;
 */
export async function checkSuperAdmin(c: Ctx): Promise<Response | null> {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if (!isSuperAdmin(user)) {
    return c.json({ error: 'Super admin access required' }, 403);
  }
  return checkAal2(c);
}

/**
 * Hono middleware: gate a route (or route group) behind the super_admin role
 * and, while MFA is globally on, a verified second factor (see
 * `checkSuperAdmin`).
 *
 * Usage:
 *   adminRoutes.use('*', requireSuperAdmin);
 */
export async function requireSuperAdmin(c: Ctx, next: Next): Promise<Response | undefined> {
  const blocked = await checkSuperAdmin(c);
  if (blocked) return blocked;
  await next();
}
