import type { Context, Next } from 'hono';
import { isMfaGloballyEnabled } from '../lib/mfa-settings';
import type { HonoVariables } from '../types';

type Ctx = Context<{ Variables: HonoVariables }>;

/**
 * Shared decision for aal2 gating. Returns a Response to short-circuit with, or
 * null when the request may proceed.
 *
 * Order: no user -> 401; already aal2 -> allow; MFA globally disabled -> allow
 * (gate inert, respects the operator toggle); otherwise -> 403 mfa_required.
 */
export async function checkAal2(c: Ctx): Promise<Response | null> {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const aal = c.get('aal');
  if (aal === 'aal2') {
    return null;
  }

  if (!(await isMfaGloballyEnabled())) {
    return null;
  }

  return c.json({ error: 'mfa_required', current_aal: aal ?? 'aal1', aal_required: 'aal2' }, 403);
}

/**
 * Hono middleware: gate a route behind aal2.
 *   v1Routes.delete('/me', requireAal2, handler)
 */
export async function requireAal2(c: Ctx, next: Next): Promise<Response | undefined> {
  const blocked = await checkAal2(c);
  if (blocked) return blocked;
  await next();
}

/**
 * Inline guard for conditional gating inside a handler (returns a Response to
 * return early with, or null to proceed):
 *   if (body.role === 'OWNER') { const b = await assertAal2(c); if (b) return b; }
 */
export function assertAal2(c: Ctx): Promise<Response | null> {
  return checkAal2(c);
}
