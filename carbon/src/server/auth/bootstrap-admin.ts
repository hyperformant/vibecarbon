import { eq } from 'drizzle-orm';
import { adminDb } from '../db/client';
import { dbErrorForLog } from '../db/errors';
import { user } from '../db/schema';
import { isSuperAdmin } from '../lib/auth';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { auth } from './index';

export type BootstrapResult = 'skipped' | 'created' | 'promoted' | 'unchanged';

/**
 * Ensure the operator's super admin exists, from ADMIN_EMAIL and
 * ADMIN_PASSWORD. Runs at every startup and is idempotent:
 *
 * - no account with that email: create it with the password, as a verified
 *   super admin past onboarding;
 * - an account exists: make it super_admin if it is not. Its password,
 *   name and everything else stay as they are, so changing ADMIN_PASSWORD
 *   later never resets a password someone already chose.
 *
 * Two replicas starting together may both try to create the account; the
 * loser hits the unique email and falls through to the promote path.
 */
export async function bootstrapAdmin(
  opts: { email?: string; password?: string } = {
    email: env.ADMIN_EMAIL,
    password: env.ADMIN_PASSWORD,
  }
): Promise<BootstrapResult> {
  const email = opts.email?.trim().toLowerCase();
  const password = opts.password;
  if (!email || !password) return 'skipped';

  const promote = async (): Promise<BootstrapResult> => {
    const [existing] = await adminDb
      .select({ id: user.id, role: user.role })
      .from(user)
      .where(eq(user.email, email));
    if (!existing) throw new Error('admin account vanished during bootstrap');
    if (isSuperAdmin(existing)) return 'unchanged';
    await adminDb.update(user).set({ role: 'super_admin' }).where(eq(user.id, existing.id));
    return 'promoted';
  };

  const [existing] = await adminDb.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (existing) return promote();

  try {
    // Called without request headers, so the admin plugin allows it as a
    // server-side call. It hashes the password and writes the credential
    // account; no session is created and no email is sent.
    await auth.api.createUser({
      body: {
        email,
        password,
        name: 'Admin',
        role: 'super_admin',
        data: { emailVerified: true, onboardingCompleted: true },
      },
    });
    return 'created';
  } catch (err) {
    const [raced] = await adminDb.select({ id: user.id }).from(user).where(eq(user.email, email));
    if (raced) return promote();
    throw err;
  }
}

/** Startup wrapper: never throws, logs the outcome. */
export async function bootstrapAdminAtStartup(): Promise<BootstrapResult | null> {
  try {
    const result = await bootstrapAdmin();
    if (result === 'created') logger.info('Created the super admin account from ADMIN_EMAIL');
    else if (result === 'promoted') logger.info('Granted super_admin to the ADMIN_EMAIL account');
    else if (result === 'skipped')
      logger.info('ADMIN_EMAIL/ADMIN_PASSWORD not set; no super admin bootstrap');
    return result;
  } catch (err) {
    logger.error({ err: dbErrorForLog(err) }, 'Super admin bootstrap failed');
    return null;
  }
}
