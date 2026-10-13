import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api';
import { sql } from 'drizzle-orm';
import { adminDb } from '../db/client';
import { dbErrorForLog } from '../db/errors';
import { getClientIp, lockoutIp } from '../lib/client-ip';
import { logger } from '../lib/logger';

/**
 * Account lockout for email + password sign-in, on the existing
 * failed_login_attempts SQL functions: 5 failures for one (email, client IP)
 * pair inside 15 minutes lock that pair until the window passes. A locked
 * pair gets 429 even with the right password; a successful sign-in clears it.
 *
 * Wired as Better Auth hooks on `/sign-in/email` (see auth/index.ts):
 *   before: refuse when locked;
 *   after:  record a wrong password, clear on a new session.
 */

const SIGN_IN_PATH = '/sign-in/email';

type Lockout = { locked?: boolean; remaining_minutes?: number };

/** The client IP the lockout keys on, from the request Better Auth received. */
function clientIp(headers: Headers | undefined): string {
  return lockoutIp(getClientIp({ req: { header: (name) => headers?.get(name) ?? undefined } }));
}

function emailOf(body: unknown): string | null {
  const email = (body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email.length > 0 ? email.toLowerCase() : null;
}

export async function checkLockout(email: string, ip: string): Promise<Lockout | null> {
  const { rows } = await adminDb.execute<{ lockout: Lockout }>(
    sql`select check_account_lockout(${email}, ${ip}::inet) as lockout`
  );
  return rows[0]?.lockout ?? null;
}

export const lockoutBefore = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== SIGN_IN_PATH) return;
  const email = emailOf(ctx.body);
  if (!email) return;

  let lockout: Lockout | null = null;
  try {
    lockout = await checkLockout(email, clientIp(ctx.headers));
  } catch (err) {
    // Fail open on a lockout-table outage: the password check still runs,
    // and the per-IP rate limit on /api/auth/sign-in still applies.
    logger.error({ err: dbErrorForLog(err) }, 'Failed to check lockout status');
  }
  if (lockout?.locked) {
    const minutes = lockout.remaining_minutes ?? 15;
    throw new APIError('TOO_MANY_REQUESTS', {
      code: 'ACCOUNT_LOCKED',
      message: `Account temporarily locked due to too many failed attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      remainingMinutes: minutes,
    });
  }
});

export const lockoutAfter = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== SIGN_IN_PATH) return;
  const email = emailOf(ctx.body);
  if (!email) return;
  const ip = clientIp(ctx.headers);
  const returned = ctx.context.returned;

  if (isAPIError(returned)) {
    // Only a wrong email/password counts. A locked refusal (429), an
    // unverified email (403, right password) or a malformed request does not.
    if (returned.body?.code !== 'INVALID_EMAIL_OR_PASSWORD') return;
    try {
      await adminDb.execute(sql`select record_failed_login(${email}, ${ip}::inet)`);
      logger.warn({ email, ip }, 'Failed login attempt recorded');
    } catch (err) {
      logger.error({ err: dbErrorForLog(err) }, 'Failed to record login attempt');
    }
    return;
  }

  // A 2FA challenge answers success without a session (newSession is reset),
  // so only a real new session clears the failures.
  if (!ctx.context.newSession) return;
  try {
    await adminDb.execute(sql`select clear_failed_logins(${email}, ${ip}::inet)`);
  } catch (err) {
    logger.error({ err: dbErrorForLog(err) }, 'Failed to clear lockout records');
  }
});
