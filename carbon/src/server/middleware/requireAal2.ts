import type { Context, Next } from 'hono';
import { isMfaGloballyEnabled } from '../lib/mfa-settings';
import type { HonoVariables } from '../types';

type Ctx = Context<{ Variables: HonoVariables }>;

/**
 * Shared decision for aal2 gating. Returns a Response to short-circuit with, or
 * null when the request may proceed.
 *
 * aal2 means THIS session passed a second factor: `session.twoFactorVerified`,
 * which only auth/assurance.ts writes (on a verified TOTP or backup code).
 * The session middleware reads the session from the database on every
 * request, so a verification counts from the very next request.
 *
 * Order: no user -> 401; an impersonation session -> 403
 * impersonation_not_allowed (a super admin acting as the user never takes
 * the user's sensitive actions: deleting the account, billing, ownership);
 * this session verified -> allow; MFA globally disabled -> allow (gate
 * inert, respects the operator toggle); otherwise -> 403 mfa_required.
 *
 * The 403 tells the client what to do next:
 * - `mfa_enrolled: true`: the user has an authenticator. Verify a code from
 *   THIS session (step-up): POST /api/auth/two-factor/verify-totp
 *   `{ code }` (or /verify-backup-code), then retry. Sessions from a magic
 *   link, social sign-in or a trusted device land here.
 * - `mfa_enrolled: false`: no second factor yet. Enroll one (POST
 *   /api/auth/two-factor/enable, then verify its first code), then retry.
 */
export async function checkAal2(c: Ctx): Promise<Response | null> {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const session = c.get('session');
  if (session?.impersonatedBy) {
    return c.json(
      {
        error: 'impersonation_not_allowed',
        message: 'This is not available while impersonating a user.',
      },
      403
    );
  }

  if (session?.twoFactorVerified === true) {
    return null;
  }

  if (!(await isMfaGloballyEnabled())) {
    return null;
  }

  const enrolled = user.twoFactorEnabled === true;
  return c.json(
    {
      error: 'mfa_required',
      current_aal: 'aal1',
      aal_required: 'aal2',
      mfa_enrolled: enrolled,
      message: enrolled
        ? 'Confirm a code from your authenticator app to continue.'
        : 'Set up two-factor authentication to continue.',
    },
    403
  );
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
