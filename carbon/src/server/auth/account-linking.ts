import { APIError } from 'better-auth/api';
import { and, eq, like } from 'drizzle-orm';
import { adminDb } from '../db/client';
import { dbErrorForLog } from '../db/errors';
import { account, session, twoFactor, user, verification } from '../db/schema';
import { logger } from '../lib/logger';

/**
 * Account pre-hijacking defence for social sign-in.
 *
 * Sign-up is open, and without SMTP an email address is never verified. So
 * an attacker can register victim@example.com with a password first. When
 * the victim later signs in with Google or Microsoft, Better Auth links
 * that provider onto the existing account by email, and the attacker's
 * password would still open it.
 *
 * Two parts:
 * - auth/index.ts allows implicit linking only when the provider asserts the
 *   email is verified (`trustedProviders: []`, so no provider is trusted by
 *   name), which is what lets this hook rely on the link proving ownership.
 * - this function, run as the `account.create.before` database hook, so it
 *   finishes BEFORE the social account row is written: if the account is
 *   being linked onto a user whose email was never verified and who has a
 *   password, that password was set by someone who never proved they own
 *   the address. In ONE transaction it deletes that credential, ends all the
 *   user's sessions (the attacker's included) and marks the email verified.
 *
 * Fail closed: if the cleanup fails, the transaction rolls back, the error
 * is logged and rethrown, and Better Auth does not write the link or create
 * a session (the sign-in fails; nothing changed). Better Auth does not hand
 * its own insert to our transaction, so the two are not one transaction;
 * the only gap is "cleanup committed, then the link insert failed", which
 * leaves the attacker cut out and the victim free to retry.
 *
 * Trade-off: an unverified password user who links a provider on purpose
 * also loses the password and signs in with the provider from then on (or
 * sets a new password through reset).
 *
 * Returns true when it removed a credential.
 */
export async function secureSocialLink(linked: {
  userId: string;
  providerId: string;
}): Promise<boolean> {
  if (linked.providerId === 'credential') return false;
  try {
    return await adminDb.transaction(async (tx) => {
      const [owner] = await tx
        .select({ email: user.email, emailVerified: user.emailVerified })
        .from(user)
        .where(eq(user.id, linked.userId))
        .for('update');
      if (!owner || owner.emailVerified) return false;

      const credentialOf = and(
        eq(account.userId, linked.userId),
        eq(account.providerId, 'credential')
      );
      const removed = await tx.delete(account).where(credentialOf).returning({ id: account.id });
      // A brand-new social user has no password; nothing to take over.
      if (removed.length === 0) return false;

      await tx.delete(session).where(eq(session.userId, linked.userId));
      // The password's owner may have enrolled TOTP too; a pending or later
      // second-factor step must not keep their factor on the account.
      await tx.delete(twoFactor).where(eq(twoFactor.userId, linked.userId));
      await tx
        .update(user)
        .set({ emailVerified: true, twoFactorEnabled: false })
        .where(eq(user.id, linked.userId));
      logger.warn(
        { userId: linked.userId, email: owner.email, provider: linked.providerId },
        'Social sign-in claimed an unverified email: removed its password and ended its sessions'
      );
      return true;
    });
  } catch (err) {
    logger.error(
      { err: dbErrorForLog(err), userId: linked.userId, provider: linked.providerId },
      'Could not secure a social sign-in onto an existing account; refusing the link'
    );
    throw new Error('Social account link refused: pre-link cleanup failed');
  }
}

/**
 * Close the race with the cleanup above. A password sign-in reads the
 * credential hash, spends time verifying it, then inserts its session. If
 * the cleanup commits in between, that insert still succeeds (it only
 * waited on the cleanup's row lock) and the attacker would hold a live
 * session on the now-verified account. The same holds for every endpoint
 * that issues a session on the strength of the password, or of a session
 * the password created. So after every session one of those creates, check
 * that what it rests on still exists; if not, delete the session and fail
 * the request.
 *
 * Both orderings are covered, and this depends on two things in the schema
 * and the cleanup: session.user_id is a foreign key to "user", so inserting
 * a session takes a KEY SHARE lock on the user row, and the cleanup holds
 * that row FOR UPDATE for its whole transaction. Those locks conflict, so a
 * session insert either commits before the cleanup's DELETE runs (and is
 * deleted by it) or waits until the cleanup commits (and is deleted here).
 * Dropping that foreign key, or the FOR UPDATE, reopens the race.
 *
 * Better Auth does not record how a session was authenticated, so this
 * keys on the endpoint path. tests/structural/auth-session-paths.test.ts
 * lists every place the installed Better Auth creates a session and fails
 * when a new one appears, so an upgrade cannot add an unclassified path.
 *
 * Runs as the `session.create.after` database hook; the thrown error ends
 * the request before its cookie is set.
 */

/** Sessions issued because the password was just checked: the password must survive. */
export const PASSWORD_SESSION_PATHS: ReadonlySet<string> = new Set([
  '/sign-in/email', // password sign-in
  '/sign-up/email', // sign-up with a password, auto sign-in
  '/change-password', // re-issues the session (revokeOtherSessions)
]);

/**
 * Sessions the second-factor endpoints issue. With a current session
 * (confirming an enrollment, enabling or disabling 2FA) the new session
 * replaces it, so that session must still exist: the cleanup deletes every
 * session of the user. Without one (finishing a password sign-in that owed
 * a second factor) the session rests on the password, which must survive.
 * Keying the first case on the session, not the password, is what lets a
 * social-only account (no password; `allowPasswordless`) manage 2FA.
 */
export const SECOND_FACTOR_SESSION_PATHS: ReadonlySet<string> = new Set([
  '/two-factor/verify-totp',
  '/two-factor/verify-otp',
  '/two-factor/verify-backup-code',
  '/two-factor/enable',
  '/two-factor/disable',
]);

async function hasPassword(userId: string): Promise<boolean> {
  const [credential] = await adminDb
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'credential')));
  return Boolean(credential);
}

async function sessionExists(sessionId: string, userId: string): Promise<boolean> {
  const [row] = await adminDb
    .select({ id: session.id })
    .from(session)
    .where(and(eq(session.id, sessionId), eq(session.userId, userId)));
  return Boolean(row);
}

export async function rejectOrphanedPasswordSession(
  created: { id: string; userId: string },
  path: string | undefined,
  sourceSessionId?: string | null
): Promise<void> {
  if (!path) return;
  let stands: boolean;
  if (PASSWORD_SESSION_PATHS.has(path)) {
    stands = await hasPassword(created.userId);
  } else if (SECOND_FACTOR_SESSION_PATHS.has(path)) {
    stands = sourceSessionId
      ? await sessionExists(sourceSessionId, created.userId)
      : await hasPassword(created.userId);
  } else {
    return;
  }
  if (stands) return;
  await adminDb.delete(session).where(eq(session.id, created.id));
  logger.warn(
    { userId: created.userId, path },
    'Session issued after the password or session it rested on was removed: session deleted'
  );
  // The same answer as a wrong password, so the race reveals nothing.
  throw new APIError('UNAUTHORIZED', {
    code: 'INVALID_EMAIL_OR_PASSWORD',
    message: 'Invalid email or password',
  });
}

/**
 * The password (credential account) cannot be unlinked: the database-level
 * half of that rule, as the `account.delete.before` hook. The endpoint
 * guard in auth/assurance.ts refuses it first; this one holds even if a
 * Better Auth upgrade changes how /unlink-account picks the account.
 *
 * Keyed on the endpoint path, so only unlinking is refused. Other deletes
 * are untouched: Better Auth's magic-link cleanup of an unverified account
 * (/magic-link/verify), user removal (its own paths), and our own cleanups
 * (secureSocialLink, bootstrap), which delete through adminDb directly and
 * never run Better Auth's hooks.
 */
export function refuseCredentialUnlinkRow(
  deleting: { providerId?: string | null },
  path: string | undefined
): void {
  if (path === '/unlink-account' && deleting.providerId === 'credential') {
    throw new APIError('FORBIDDEN', {
      code: 'PASSWORD_UNLINK_NOT_ALLOWED',
      message: 'Your password cannot be removed. Change or reset it instead.',
    });
  }
}

/**
 * The magic-link side of the pre-hijacking defence.
 *
 * Better Auth's magic-link verify has its own version of secureSocialLink
 * (dist/db/revoke-unproven-account-access.mjs): when the link proves an
 * address whose account was never verified, it deletes every account link
 * (the attacker's password included) and every session, then marks the
 * email verified. It does not touch the second factor, so an attacker who
 * pre-registered the address and enrolled their own authenticator would
 * leave it behind: the owner could not remove it (that needs aal2, which
 * needs the attacker's codes). This finishes the job: it removes the
 * factor and its trusted-device records, and turns 2FA off.
 *
 * Fail closed and retryable: it runs from a before hook on
 * /magic-link/verify (auth/assurance.ts), BEFORE the link is used up and
 * before the email is marked verified. If it fails, the link is refused
 * unused and the account stays unverified, so the owner's retry runs it
 * again. (Better Auth's user-update before hook cannot do this: it gets
 * only the new values, not which user.) The `user.update.after` hook in
 * auth/index.ts runs it once more after the email is marked verified, best
 * effort, for a factor enrolled in the milliseconds between the two.
 *
 * Social sign-in never reaches that helper (secureSocialLink above covers
 * it, second factor included), and the two cannot fight: each deletes
 * rows the other may already have deleted.
 */
export async function dropUnprovenSecondFactor(email: string): Promise<void> {
  const [owner] = await adminDb
    .select({ id: user.id, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.email, email.toLowerCase()));
  if (!owner || owner.emailVerified) return;
  await removeSecondFactor(owner.id, 'Magic link for an unverified address');
}

/** The after-update sweep (see dropUnprovenSecondFactor). */
export async function sweepUnprovenSecondFactor(
  updated: { id: string; emailVerified?: boolean | null },
  path: string | undefined
): Promise<void> {
  if (path !== '/magic-link/verify' || !updated.emailVerified) return;
  await removeSecondFactor(updated.id, 'Magic link proved an unverified address');
}

async function removeSecondFactor(userId: string, why: string): Promise<void> {
  try {
    await adminDb.transaction(async (tx) => {
      const removed = await tx
        .delete(twoFactor)
        .where(eq(twoFactor.userId, userId))
        .returning({ id: twoFactor.id });
      // Trusted-device records: Better Auth stores them in verification
      // with identifier `trust-device-<random>` and the user id as value.
      await tx
        .delete(verification)
        .where(
          and(like(verification.identifier, 'trust-device-%'), eq(verification.value, userId))
        );
      await tx.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, userId));
      if (removed.length) {
        logger.warn({ userId }, `${why}: removed a second factor nobody had proved`);
      }
    });
  } catch (err) {
    logger.error(
      { err: dbErrorForLog(err), userId },
      'Could not remove an unproven second factor; refusing the magic link'
    );
    throw new Error('Magic link refused: second-factor cleanup failed');
  }
}
