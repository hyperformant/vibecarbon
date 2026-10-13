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
import { account, session as sessionTable, twoFactor, user as userTable } from '../db/schema';
import { logger } from '../lib/logger';
import { isMfaGloballyEnabled } from '../lib/mfa-settings';
import { dropUnprovenSecondFactor } from './account-linking';

/**
 * Per-session assurance level (AAL) on top of Better Auth's twoFactor plugin.
 *
 * A session is aal2 when `session.twoFactorVerified` is true, and the ONLY
 * writer of that column is the after hook below: a successful TOTP or
 * backup-code verification marks the session it was verified for, and only
 * when the user really has an enrolled factor afterwards (a confirmed
 * `two_factor` row and `twoFactorEnabled`). The field is `input: false`
 * (auth/index.ts), so no client body can set it, and every new session
 * starts at false (Better Auth re-applies the field default on each
 * createSession, so even the sessions that enable/disable re-issue drop
 * back to aal1).
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
 * A backup code is not a way to confirm an enrollment: Better Auth's
 * verify-backup-code does not check that the factor was confirmed, so it
 * is refused here while the factor is unconfirmed (enable, then skipping
 * the authenticator code, must not yield aal2).
 *
 * Marking also rewrites the session-cache cookie, so the browser's own
 * get-session answer (cookie cached up to 60 s) shows aal2 at once. The API
 * session middleware never reads that cache anyway.
 *
 * Step-up guessing: Better Auth counts failed codes toward its per-account
 * lock only on the sign-in path. A step-up attempt from an aal1 session would
 * be bounded only by the per-IP rate limit, so each step-up attempt first
 * reserves one unit of the same budget (`failed_verification_count`,
 * `locked_until`) in ONE atomic UPDATE: 10 attempts without a success lock
 * the factor for 15 minutes, across sign-in and step-up, and concurrent
 * attempts cannot slip past the cap. A success resets the count.
 *
 * Enrolling and managing a factor:
 * - reading the TOTP URI, regenerating backup codes, disabling 2FA, and
 *   enabling it again while a confirmed factor exists all need a session
 *   that proved that factor. Otherwise an aal1 session (a magic link from a
 *   read mailbox, say) could read the secret and mint aal2 for itself, or
 *   swap or remove the factor.
 * - on an account with no password (social or magic link only,
 *   `allowPasswordless`) and no confirmed factor, every enrollment step
 *   (enable, read the URI, regenerate backup codes, confirm the first code)
 *   needs a session signed in within the last 10 minutes: there is no
 *   password to ask for, so recency stands in for it, and a stolen
 *   long-lived cookie cannot enroll or finish enrolling the thief's
 *   authenticator. A password account gives its password (Better Auth
 *   checks it). Disabling 2FA with nothing confirmed is refused (it would
 *   only re-issue the session with a fresh createdAt).
 * - code attempts from a session on an unconfirmed factor share the same
 *   atomic budget as step-up.
 * - a session cookie whose session is gone gets 401 from every gated path,
 *   never Better Auth's 60 s cookie-cache fallback.
 *
 * Better Auth's admin endpoints (/admin/*) need aal2 while MFA is globally
 * on, the same rule `requireAal2` applies to the app's own routes.
 * stop-impersonating is exempt: an impersonation session is always aal1 and
 * must be able to end itself. Server-side calls with no request headers
 * (the startup admin bootstrap) carry no session and are not gated.
 *
 * Magic link onto an unverified account: before the link is used, any second
 * factor enrolled on that account is removed (auth/account-linking.ts,
 * dropUnprovenSecondFactor). A failure there refuses the link without using
 * it up, so the owner's retry redoes the cleanup.
 */

const VERIFY_PATHS: ReadonlySet<string> = new Set([
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
]);

const FACTOR_MANAGEMENT_PATHS: ReadonlySet<string> = new Set([
  '/two-factor/get-totp-uri',
  '/two-factor/generate-backup-codes',
  '/two-factor/disable',
  '/two-factor/enable',
]);

const MAGIC_LINK_VERIFY = '/magic-link/verify';

const ADMIN_UNGATED: ReadonlySet<string> = new Set(['/admin/stop-impersonating']);

/** Better Auth's own defaults for the per-account second-factor lock. */
const MAX_FAILED_VERIFICATIONS = 10;
const LOCK_MINUTES = 15;

/** How recent a passwordless account's sign-in must be to enroll 2FA. */
const FRESH_SESSION_MS = 10 * 60 * 1000;

type SessionLike = {
  session: { id: string; twoFactorVerified?: boolean | null; createdAt?: Date | string };
  user: { id: string; twoFactorEnabled?: boolean | null };
};

function isAdminPath(path: string | undefined): boolean {
  return Boolean(path?.startsWith('/admin/')) && !ADMIN_UNGATED.has(path as string);
}

function mfaRequired(message: string): APIError {
  return new APIError('FORBIDDEN', { code: 'MFA_REQUIRED', message });
}

/** The user's factor: none, enrolled but unconfirmed, or confirmed. */
async function factorOf(userId: string): Promise<'none' | 'unconfirmed' | 'confirmed'> {
  const [row] = await adminDb
    .select({ verified: twoFactor.verified })
    .from(twoFactor)
    .where(eq(twoFactor.userId, userId));
  if (!row) return 'none';
  return row.verified === false ? 'unconfirmed' : 'confirmed';
}

async function hasPassword(userId: string): Promise<boolean> {
  const [row] = await adminDb
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'credential')));
  return Boolean(row);
}

/**
 * Reserve one code attempt made from a session (step-up, or confirming an
 * enrollment), atomically. Returns false when the factor is locked (no
 * attempt left). An expired lock starts a fresh budget. Reaching the cap
 * sets the lock; the attempt that reached it still runs, and a success
 * clears it. Applies to an unconfirmed factor too, so an abandoned
 * enrollment cannot be brute-forced from an aal1 session.
 */
async function reserveCodeAttempt(userId: string): Promise<boolean> {
  const { rows } = await adminDb.execute<{ n: number }>(sql`
    update public.two_factor
       set failed_verification_count = case
             when locked_until is not null and locked_until <= now() then 1
             else coalesce(failed_verification_count, 0) + 1
           end,
           locked_until = case
             when locked_until is not null and locked_until <= now() then null
             when coalesce(failed_verification_count, 0) + 1 >= ${MAX_FAILED_VERIFICATIONS}
               then now() + make_interval(mins => ${LOCK_MINUTES})
             else locked_until
           end
     where user_id = ${userId}
       and (locked_until is null or locked_until <= now())
     returning failed_verification_count as n`);
  return rows.length > 0;
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

const VERIFY_FIRST =
  'Verify a code from your authenticator app (POST /api/auth/two-factor/verify-totp) first.';

/**
 * A passwordless account (no credential) with no confirmed factor has no
 * secret to ask for, so recency stands in for it: every factor-management
 * step (enable, read the URI, regenerate backup codes, confirm the first
 * code) needs a session signed in within the last 10 minutes. `createdAt`
 * comes from the database (authoritative read), and no path a stale session
 * can reach re-issues it: disable is refused without a confirmed factor,
 * and every other re-issuing path needs a password or aal2.
 */
async function requireFreshIfPasswordless(current: SessionLike): Promise<void> {
  if (await hasPassword(current.user.id)) return;
  const created = current.session.createdAt ? new Date(current.session.createdAt).getTime() : 0;
  if (Date.now() - created > FRESH_SESSION_MS) {
    throw new APIError('FORBIDDEN', {
      code: 'REAUTH_REQUIRED',
      error: 'reauth_required',
      message: 'For your security, sign in again, then set up two-factor authentication.',
    });
  }
}

async function gateFactorManagement(path: string, current: SessionLike): Promise<void> {
  const verified = current.session.twoFactorVerified === true;
  const factor = await factorOf(current.user.id);
  const enrolled = current.user.twoFactorEnabled === true || factor === 'confirmed';

  if (enrolled) {
    if (!verified) {
      throw mfaRequired(
        `Changing your two-factor settings needs a session that passed two-factor verification. ${VERIFY_FIRST}`
      );
    }
    return;
  }

  // Nothing confirmed. Disabling would only re-issue the session (a new
  // createdAt that would pass the freshness rule below), so refuse it.
  if (path === '/two-factor/disable') {
    throw new APIError('FORBIDDEN', {
      code: 'TWO_FACTOR_NOT_ENABLED',
      message: 'Two-factor authentication is not enabled.',
    });
  }
  await requireFreshIfPasswordless(current);
}

async function gateVerify(path: string, current: SessionLike): Promise<void> {
  const factor = await factorOf(current.user.id);
  if (factor === 'none') return; // the endpoint refuses: nothing to verify
  if (factor === 'unconfirmed') {
    // Confirming a new enrollment takes an authenticator code, never a
    // backup code. (verify-totp on an unconfirmed factor is that confirm.)
    if (path === '/two-factor/verify-backup-code') {
      throw new APIError('BAD_REQUEST', {
        code: 'TWO_FACTOR_NOT_CONFIRMED',
        message: 'Finish setting up two-factor authentication with a code from your app first.',
      });
    }
    await requireFreshIfPasswordless(current);
  }
  if (!(await reserveCodeAttempt(current.user.id))) {
    throw new APIError('TOO_MANY_REQUESTS', {
      code: 'ACCOUNT_TEMPORARILY_LOCKED',
      message: 'Too many wrong codes. Try again in a few minutes.',
    });
  }
}

/**
 * The caller's session, read from the database. When the request carries a
 * session cookie but its session is gone (revoked, expired, banned), answer
 * 401 here: returning would let Better Auth's own endpoint fall back to the
 * session-cache cookie (valid up to 60 s) and act on the dead session past
 * every gate above. No session cookie at all: null (server-side call, or a
 * sign-in finishing its second factor).
 */
// biome-ignore lint/suspicious/noExplicitAny: Better Auth's middleware context
async function liveSession(ctx: any): Promise<SessionLike | null> {
  const current = (await getAuthoritativeSessionFromCtx(ctx)) as SessionLike | null;
  if (current) return current;
  if (ctx.getCookie(ctx.context.authCookies.sessionToken.name)) {
    throw new APIError('UNAUTHORIZED', {
      code: 'SESSION_EXPIRED',
      message: 'Your session has ended. Please sign in again.',
    });
  }
  return null;
}

const before = createAuthMiddleware(async (ctx) => {
  const path = ctx.path;

  if (path === MAGIC_LINK_VERIFY) {
    const token = typeof ctx.query?.token === 'string' ? ctx.query.token : null;
    // The pending link, read (not used up): auth/index.ts keeps magicLink's
    // default plain token storage, so its identifier is `magic-link:<token>`.
    const pending = token
      ? await ctx.context.internalAdapter.findVerificationValue(`magic-link:${token}`)
      : null;
    if (!pending || new Date(pending.expiresAt).getTime() <= Date.now()) return;
    let email: unknown;
    try {
      email = (JSON.parse(pending.value) as { email?: unknown }).email;
    } catch {
      return; // the endpoint refuses a malformed link
    }
    if (typeof email !== 'string') return;
    try {
      await dropUnprovenSecondFactor(email);
    } catch (err) {
      // The link stays unused, so a retry redoes this.
      logger.error({ err: dbErrorForLog(err) }, 'Magic-link second-factor cleanup failed');
      throw new APIError('INTERNAL_SERVER_ERROR', {
        code: 'MAGIC_LINK_CLEANUP_FAILED',
        message: 'Sign-in could not be completed. Please open the link again.',
      });
    }
    return;
  }

  if (isAdminPath(path)) {
    // No request headers: a server-side call (the startup bootstrap).
    if (!ctx.request && !ctx.headers) return;
    const current = await liveSession(ctx);
    // No session cookie: the endpoint itself answers 401.
    if (!current || current.session.twoFactorVerified === true) return;
    if (!(await isMfaGloballyEnabled())) return;
    throw mfaRequired(
      'Admin actions need a session that passed two-factor verification. ' +
        'Verify a code from your authenticator app (POST /api/auth/two-factor/verify-totp) and try again.'
    );
  }

  if (FACTOR_MANAGEMENT_PATHS.has(path)) {
    const current = await liveSession(ctx);
    if (!current) return; // no session cookie: the endpoint answers 401
    await gateFactorManagement(path, current);
    return;
  }

  if (VERIFY_PATHS.has(path)) {
    // Read the session from the database, not the cookie cache, so the
    // endpoint below acts on a live session (it reuses this one).
    const current = await liveSession(ctx);
    // No session: finishing a sign-in, which Better Auth locks itself.
    if (!current) return;
    await gateVerify(path, current);
  }
});

const after = createAuthMiddleware(async (ctx) => {
  const returned = ctx.context.returned;
  // Failures need nothing here: a step-up attempt was counted before it ran.
  if (isAPIError(returned) || returned === undefined || returned === null) return;

  const current = ctx.context.session as SessionLike | null;
  // Success. The session the code was verified for: a new one (sign-in
  // finished, or an enrollment confirmed) or the current one (step-up).
  const target = (ctx.context.newSession as SessionLike | null) ?? current;
  if (!target?.session) return; // a backup code checked without a session

  let marked: boolean;
  try {
    // Only with a factor the user really has now: a confirmed row and 2FA on.
    const [enrolled] = await adminDb
      .select({ id: twoFactor.id })
      .from(twoFactor)
      .innerJoin(userTable, eq(userTable.id, twoFactor.userId))
      .where(
        and(
          eq(twoFactor.userId, target.user.id),
          eq(twoFactor.verified, true),
          eq(userTable.twoFactorEnabled, true)
        )
      );
    if (!enrolled) {
      logger.warn(
        { userId: target.user.id },
        'Second-factor code accepted without a confirmed factor: session left at aal1'
      );
      return;
    }
    const rows = await adminDb
      .update(sessionTable)
      .set({ twoFactorVerified: true })
      .where(and(eq(sessionTable.id, target.session.id), eq(sessionTable.userId, target.user.id)))
      .returning({ id: sessionTable.id });
    marked = rows.length > 0;
    // A session-mode attempt (step-up or confirm) reserved a unit; clear the
    // budget on success. Sign-in attempts are Better Auth's to reset.
    if (current?.session) await resetFailures(current.user.id);
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
            ctx.path === MAGIC_LINK_VERIFY ||
            isAdminPath(ctx.path) ||
            FACTOR_MANAGEMENT_PATHS.has(ctx.path ?? '') ||
            VERIFY_PATHS.has(ctx.path ?? ''),
          handler: before,
        },
      ],
      after: [{ matcher: (ctx) => VERIFY_PATHS.has(ctx.path ?? ''), handler: after }],
    },
  }) satisfies BetterAuthPlugin;
