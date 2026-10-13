import type { BetterAuthPlugin } from 'better-auth';
import {
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
  isAPIError,
} from 'better-auth/api';
import { setCookieCache } from 'better-auth/cookies';
import { and, eq, sql } from 'drizzle-orm';
import { adminDb } from '../db/client';
import { dbErrorForLog } from '../db/errors';
import { session as sessionTable, twoFactor } from '../db/schema';
import { logger } from '../lib/logger';
import { isMfaGloballyEnabled } from '../lib/mfa-settings';

/**
 * Per-session assurance level (AAL) on top of Better Auth's twoFactor plugin.
 *
 * A session is aal2 when `session.twoFactorVerified` is true, and the ONLY
 * writer of that column is the after hook below: a successful TOTP or
 * backup-code verification marks the session it was verified for. The field
 * is `input: false` (auth/index.ts), so no client body can set it, and
 * every new session starts at false (Better Auth re-applies the field
 * default on each createSession, so even the sessions that enable/disable
 * re-issue drop back to aal1).
 *
 * Which session the verification is "for":
 * - finishing a password sign-in that owed a second factor, or confirming
 *   the first code of a new enrollment: Better Auth creates a NEW session
 *   (`ctx.context.newSession`); that one is marked.
 * - step-up: a request that already has a session (magic link, social, a
 *   trusted device, or a password session from before the user enrolled)
 *   verifies a code; Better Auth keeps the CURRENT session
 *   (`ctx.context.session`); that one is marked. This is how a user who
 *   signed in without the second factor reaches aal2 without signing out.
 *
 * Marking also rewrites the session-cache cookie, so the browser's own
 * get-session answer (cookie cached up to 60 s) shows aal2 at once. The API
 * session middleware never reads that cache anyway.
 *
 * Step-up guessing: Better Auth counts failed codes toward its per-account
 * lock only on the sign-in path. A step-up attempt from an aal1 session would
 * be bounded only by the per-IP rate limit, so this plugin counts those
 * failures on the same columns (`failed_verification_count`,
 * `locked_until`) with the same budget: 10 consecutive failures lock the
 * factor for 15 minutes, across sign-in and step-up.
 *
 * Managing an enrolled factor (read the TOTP URI, regenerate backup codes,
 * disable 2FA) needs a session that proved that factor. Otherwise an aal1
 * session (a magic link from a read mailbox, say) could read the secret and
 * mint aal2 for itself, or remove the factor. Enabling 2FA when none is
 * enrolled stays open to any session, as before.
 *
 * Better Auth's admin endpoints (/admin/*) need aal2 while MFA is globally
 * on, the same rule `requireAal2` applies to the app's own routes.
 * stop-impersonating is exempt: an impersonation session is always aal1 and
 * must be able to end itself. Server-side calls with no request headers
 * (the startup admin bootstrap) carry no session and are not gated.
 */

const VERIFY_PATHS: ReadonlySet<string> = new Set([
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
]);

const FACTOR_MANAGEMENT_PATHS: ReadonlySet<string> = new Set([
  '/two-factor/get-totp-uri',
  '/two-factor/generate-backup-codes',
  '/two-factor/disable',
]);

const ADMIN_UNGATED: ReadonlySet<string> = new Set(['/admin/stop-impersonating']);

const INVALID_CODE_ERRORS: ReadonlySet<string> = new Set(['INVALID_CODE', 'INVALID_BACKUP_CODE']);

/** Better Auth's own defaults for the per-account second-factor lock. */
const MAX_FAILED_VERIFICATIONS = 10;
const LOCK_MINUTES = 15;

type SessionLike = {
  session: { id: string; twoFactorVerified?: boolean | null };
  user: { id: string; twoFactorEnabled?: boolean | null };
};

function isAdminPath(path: string | undefined): boolean {
  return Boolean(path?.startsWith('/admin/')) && !ADMIN_UNGATED.has(path as string);
}

function mfaRequired(message: string): APIError {
  return new APIError('FORBIDDEN', { code: 'MFA_REQUIRED', message });
}

async function lockedUntil(userId: string): Promise<Date | null> {
  const [row] = await adminDb
    .select({ lockedUntil: twoFactor.lockedUntil })
    .from(twoFactor)
    .where(and(eq(twoFactor.userId, userId), eq(twoFactor.verified, true)));
  return row?.lockedUntil && row.lockedUntil.getTime() > Date.now() ? row.lockedUntil : null;
}

/** One failed step-up code, toward the shared per-account budget. */
async function recordStepUpFailure(userId: string): Promise<void> {
  await adminDb.execute(sql`
    update public.two_factor
       set failed_verification_count = coalesce(failed_verification_count, 0) + 1,
           locked_until = case
             when coalesce(failed_verification_count, 0) + 1 >= ${MAX_FAILED_VERIFICATIONS}
               then now() + make_interval(mins => ${LOCK_MINUTES})
             else locked_until
           end
     where user_id = ${userId} and verified`);
}

async function resetFailures(userId: string): Promise<void> {
  await adminDb
    .update(twoFactor)
    .set({ failedVerificationCount: 0, lockedUntil: null })
    .where(eq(twoFactor.userId, userId));
}

/** Remove `name` (and its chunks, `name.0`...) from a response's Set-Cookie list. */
function dropSetCookie(headers: Headers | undefined, name: string): void {
  if (!headers) return;
  const all = headers.getSetCookie();
  const kept = all.filter((c) => !c.startsWith(`${name}=`) && !c.startsWith(`${name}.`));
  if (kept.length === all.length) return;
  headers.delete('set-cookie');
  for (const c of kept) headers.append('set-cookie', c);
}

const before = createAuthMiddleware(async (ctx) => {
  const path = ctx.path;

  if (isAdminPath(path)) {
    // No request headers: a server-side call (the startup bootstrap).
    if (!ctx.request && !ctx.headers) return;
    const current = (await getAuthoritativeSessionFromCtx(ctx)) as SessionLike | null;
    // No session: the endpoint itself answers 401.
    if (!current || current.session.twoFactorVerified === true) return;
    if (!(await isMfaGloballyEnabled())) return;
    throw mfaRequired(
      'Admin actions need a session that passed two-factor verification. ' +
        'Verify a code from your authenticator app (POST /api/auth/two-factor/verify-totp) and try again.'
    );
  }

  if (FACTOR_MANAGEMENT_PATHS.has(path)) {
    const current = (await getAuthoritativeSessionFromCtx(ctx)) as SessionLike | null;
    if (!current) return; // the endpoint answers 401
    if (current.user.twoFactorEnabled && current.session.twoFactorVerified !== true) {
      throw mfaRequired(
        'Changing your two-factor settings needs a session that passed two-factor verification. ' +
          'Verify a code from your authenticator app (POST /api/auth/two-factor/verify-totp) first.'
      );
    }
    return;
  }

  if (VERIFY_PATHS.has(path)) {
    // Read the session from the database, not the cookie cache, so the
    // endpoint below acts on a live session (it reuses this one).
    const current = (await getAuthoritativeSessionFromCtx(ctx)) as SessionLike | null;
    // No session: finishing a sign-in, which Better Auth locks itself.
    if (!current) return;
    if (await lockedUntil(current.user.id)) {
      throw new APIError('TOO_MANY_REQUESTS', {
        code: 'ACCOUNT_TEMPORARILY_LOCKED',
        message: 'Too many wrong codes. Try again in a few minutes.',
      });
    }
  }
});

const after = createAuthMiddleware(async (ctx) => {
  const returned = ctx.context.returned;
  const current = ctx.context.session as SessionLike | null;

  if (isAPIError(returned)) {
    // A wrong step-up code (a session was present): count it. Sign-in
    // failures (no session) are counted by Better Auth itself.
    if (current?.session && INVALID_CODE_ERRORS.has(String(returned.body?.code))) {
      try {
        await recordStepUpFailure(current.user.id);
      } catch (err) {
        logger.error({ err: dbErrorForLog(err) }, 'Failed to record a wrong two-factor code');
      }
    }
    return;
  }
  if (returned === undefined || returned === null) return;

  // Success. The session the code was verified for: a new one (sign-in
  // finished, or an enrollment confirmed) or the current one (step-up).
  const target = (ctx.context.newSession as SessionLike | null) ?? current;
  if (!target?.session) return; // a backup code checked without a session

  let marked: boolean;
  try {
    const rows = await adminDb
      .update(sessionTable)
      .set({ twoFactorVerified: true })
      .where(and(eq(sessionTable.id, target.session.id), eq(sessionTable.userId, target.user.id)))
      .returning({ id: sessionTable.id });
    marked = rows.length > 0;
    if (current?.session && !ctx.context.newSession) await resetFailures(current.user.id);
  } catch (err) {
    logger.error({ err: dbErrorForLog(err) }, 'Failed to mark a session as two-factor verified');
    throw new APIError('INTERNAL_SERVER_ERROR', {
      code: 'FAILED_TO_RECORD_SECOND_FACTOR',
      message: 'Your code was right, but the session could not be updated. Please try again.',
    });
  }
  // The session ended meanwhile (signed out or revoked): nothing to refresh.
  if (!marked) return;

  const verified = {
    session: { ...target.session, twoFactorVerified: true },
    user: target.user,
  };
  if (ctx.context.newSession) ctx.context.newSession.session.twoFactorVerified = true;
  // Replace (not add to) the cache cookie the endpoint already set, so the
  // response carries one, current, session-cache cookie.
  dropSetCookie(ctx.context.responseHeaders, ctx.context.authCookies.sessionData.name);
  const dontRememberMe = await ctx.getSignedCookie(
    ctx.context.authCookies.dontRememberToken.name,
    ctx.context.secret
  );
  // biome-ignore lint/suspicious/noExplicitAny: Better Auth's cookie helper takes its own session shape
  await setCookieCache(ctx, verified as any, Boolean(dontRememberMe));
});

/**
 * The assurance hooks as a plugin. Register it after twoFactor (its verify
 * endpoints must have run) and before stripSessionToken (auth/index.ts).
 */
export const sessionAssurance = () =>
  ({
    id: 'session-assurance',
    hooks: {
      before: [
        {
          matcher: (ctx) =>
            isAdminPath(ctx.path) ||
            FACTOR_MANAGEMENT_PATHS.has(ctx.path ?? '') ||
            VERIFY_PATHS.has(ctx.path ?? ''),
          handler: before,
        },
      ],
      after: [{ matcher: (ctx) => VERIFY_PATHS.has(ctx.path ?? ''), handler: after }],
    },
  }) satisfies BetterAuthPlugin;
