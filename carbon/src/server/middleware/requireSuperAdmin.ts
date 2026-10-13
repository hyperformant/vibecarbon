import type { Context, Next } from 'hono';
import { isSuperAdmin } from '../lib/auth';
import type { HonoVariables } from '../types';

/**
 * Hono middleware: gate a route (or route group) behind the super_admin role.
 *
 * The role is the server-controlled `user.role` of the session the session
 * middleware read from the database (`isSuperAdmin`, exact match).
 *
 * Usage:
 *   adminRoutes.use('*', requireSuperAdmin);
 */
export async function requireSuperAdmin(
  c: Context<{ Variables: HonoVariables }>,
  next: Next
): Promise<Response | undefined> {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if (!isSuperAdmin(user)) {
    return c.json({ error: 'Super admin access required' }, 403);
  }
  await next();
}
