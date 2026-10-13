import { and, eq } from 'drizzle-orm';
import { adminDb } from '../db/client';
import { account, session, user } from '../db/schema';
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
 * - this hook, on every new social account: if it was linked onto a user
 *   whose email was never verified and who has a password, the password
 *   was set by someone who never proved they own the address. Delete that
 *   credential, end all the user's sessions (the attacker's included), and
 *   mark the email verified, since the provider just verified it.
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
  const [owner] = await adminDb
    .select({ email: user.email, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, linked.userId));
  if (!owner || owner.emailVerified) return false;

  const credentialOf = and(eq(account.userId, linked.userId), eq(account.providerId, 'credential'));
  const [credential] = await adminDb.select({ id: account.id }).from(account).where(credentialOf);
  // A brand-new social user has no password; nothing to take over.
  if (!credential) return false;

  await adminDb.transaction(async (tx) => {
    await tx.delete(account).where(credentialOf);
    await tx.delete(session).where(eq(session.userId, linked.userId));
    await tx.update(user).set({ emailVerified: true }).where(eq(user.id, linked.userId));
  });
  logger.warn(
    { userId: linked.userId, email: owner.email, provider: linked.providerId },
    'Social sign-in claimed an unverified email: removed its password and ended its sessions'
  );
  return true;
}
