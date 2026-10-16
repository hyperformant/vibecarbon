import { eq } from 'drizzle-orm';
import { adminDb } from '../db/client';
import { dbErrorForLog } from '../db/errors';
import { user } from '../db/schema';
import { logger } from '../lib/logger';

/**
 * Stamp `user.last_sign_in_at` when a session is issued (the admin users
 * list and the active-user counts read it). Impersonation sessions do not
 * count: the user did not sign in. Best effort: a failed write is logged
 * and never fails the sign-in.
 */
export async function recordSignIn(created: {
  userId: string;
  impersonatedBy?: string | null;
}): Promise<void> {
  if (created.impersonatedBy) return;
  try {
    await adminDb.update(user).set({ lastSignInAt: new Date() }).where(eq(user.id, created.userId));
  } catch (err) {
    logger.warn({ err: dbErrorForLog(err) }, 'Could not record the sign-in time');
  }
}
