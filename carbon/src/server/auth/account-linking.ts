import { APIError } from 'better-auth/api';
import { and, eq } from 'drizzle-orm';
import { adminDb } from '../db/client';
import { dbErrorForLog } from '../db/errors';
import { account, session, twoFactor, user } from '../db/schema';
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
 * session on the now-verified account. So after every session that
 * `/sign-in/email` creates, check the credential it was granted on still
 * exists; if not, delete the session and fail the sign-in. Both orderings
 * are covered: a session inserted before the cleanup is deleted by it, one
 * inserted after is deleted here.
 *
 * Runs as the `session.create.after` database hook; the thrown error ends
 * the sign-in before its cookie is set.
 */
export async function rejectOrphanedPasswordSession(
  created: { id: string; userId: string },
  path: string | undefined
): Promise<void> {
  if (path !== '/sign-in/email') return;
  const [credential] = await adminDb
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, created.userId), eq(account.providerId, 'credential')));
  if (credential) return;
  await adminDb.delete(session).where(eq(session.id, created.id));
  logger.warn(
    { userId: created.userId },
    'Password sign-in finished after its password was removed: session deleted'
  );
  // The same answer as a wrong password, so the race reveals nothing.
  throw new APIError('UNAUTHORIZED', {
    code: 'INVALID_EMAIL_OR_PASSWORD',
    message: 'Invalid email or password',
  });
}
