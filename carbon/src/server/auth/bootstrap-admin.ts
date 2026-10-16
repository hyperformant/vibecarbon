import { and, eq } from 'drizzle-orm';
import { adminDb, pool } from '../db/client';
import { account, user } from '../db/schema';
import { isSuperAdmin } from '../lib/auth';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import type { BootstrapResult } from './admin-status';
import { auth } from './index';

export type { BootstrapResult } from './admin-status';

/**
 * Ensure the operator's super admin exists, from ADMIN_EMAIL and
 * ADMIN_PASSWORD. Runs at every startup and is idempotent:
 *
 * - no account with that email: create it with the password, as a verified
 *   super admin past onboarding;
 * - the account is already super_admin: nothing to do (its password is
 *   never touched, so changing ADMIN_PASSWORD later resets nothing),
 *   unless it has no password, which is refused with a fix (under the
 *   bootstrap lock this is a real leftover, never another replica's
 *   create in progress);
 * - the account exists but is not super_admin: promote it ONLY if its own
 *   password verifies against ADMIN_PASSWORD. Sign-up is open and, without
 *   SMTP, unverified, so anyone could register the admin address before
 *   the first boot; the password proves the account is the operator's.
 *   Otherwise refuse, change nothing, and log what to do.
 *
 * Serialized across replicas by a Postgres session advisory lock
 * (withAdminBootstrapLock). Better Auth's createUser writes the user row,
 * hashes, then links the password outside one transaction, so two replicas
 * starting together could otherwise see each other's half-made admin. Under
 * the lock the second one finds the finished admin and returns `unchanged`.
 * The unique-email fallback below stays as a backstop.
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
  return withAdminBootstrapLock(() => bootstrapUnderLock(email, password));
}

/**
 * Stable key for the bootstrap's advisory lock (any bigint; this one is
 * unique to the admin bootstrap in this database).
 */
export const ADMIN_BOOTSTRAP_LOCK_KEY = '7264519330021875';

/**
 * Run `fn` holding a session advisory lock on a dedicated pool client, so
 * only one process bootstraps the admin at a time. The lock is released in
 * `finally`; if releasing fails, the client is discarded, which ends the
 * session and so drops the lock with it.
 */
export async function withAdminBootstrapLock<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('select pg_advisory_lock($1::bigint)', [ADMIN_BOOTSTRAP_LOCK_KEY]);
    try {
      return await fn();
    } finally {
      await client
        .query('select pg_advisory_unlock($1::bigint)', [ADMIN_BOOTSTRAP_LOCK_KEY])
        .catch((err: Error) => {
          broken = err;
        });
    }
  } catch (err) {
    broken ??= err instanceof Error ? err : new Error(String(err));
    throw err;
  } finally {
    client.release(broken);
  }
}

async function bootstrapUnderLock(email: string, password: string): Promise<BootstrapResult> {
  const findUser = async () => {
    const [found] = await adminDb
      .select({ id: user.id, role: user.role })
      .from(user)
      .where(eq(user.email, email));
    return found;
  };

  const ensureExisting = async (existing: {
    id: string;
    role: string | null;
  }): Promise<BootstrapResult> => {
    if (isSuperAdmin(existing)) {
      if (await hasPassword(existing.id)) return 'unchanged';
      // Under the bootstrap lock no other replica can be mid-create, so this
      // is a real leftover: refuse now, with the fix.
      logger.error(
        { email },
        `The super admin ${email} has no password, so it cannot sign in with ADMIN_PASSWORD ` +
          '(a bootstrap interrupted before the password was saved, or an account that only ' +
          'uses social sign-in). Request a password reset for it, or delete the account and ' +
          'restart to recreate it from ADMIN_EMAIL and ADMIN_PASSWORD.'
      );
      return 'refused';
    }
    if (!(await passwordMatches(existing.id, password))) {
      logger.error(
        { email },
        `An account with ADMIN_EMAIL (${email}) already exists, is not a super admin, and its ` +
          'password does not match ADMIN_PASSWORD, so it was NOT promoted. If that account is ' +
          "yours, sign in and set its password to ADMIN_PASSWORD, then restart. If it isn't, " +
          'delete it (or set ADMIN_EMAIL to an address you control) and restart.'
      );
      return 'refused';
    }
    await adminDb.update(user).set({ role: 'super_admin' }).where(eq(user.id, existing.id));
    return 'promoted';
  };

  const existing = await findUser();
  if (existing) return ensureExisting(existing);

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
    const raced = await findUser();
    if (raced) return ensureExisting(raced);
    throw err;
  }
}

async function credentialHash(userId: string): Promise<string | null> {
  const [credential] = await adminDb
    .select({ hash: account.password })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'credential')));
  return credential?.hash ?? null;
}

async function hasPassword(userId: string): Promise<boolean> {
  return (await credentialHash(userId)) !== null;
}

/**
 * Whether the user's email + password credential verifies against
 * `password`, with Better Auth's own hasher (never a hand comparison).
 * False when the account has no password (OAuth or magic-link only).
 */
async function passwordMatches(userId: string, password: string): Promise<boolean> {
  const hash = await credentialHash(userId);
  if (!hash) return false;
  const ctx = await auth.$context;
  return ctx.password.verify({ hash, password });
}
