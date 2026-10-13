import {
  type AdminStatus,
  adminStatusAfter,
  type BootstrapResult,
  setAdminStatus,
} from '../auth/admin-status';
import { logger } from '../lib/logger';
import { assertBypassRole, DbRoleError } from './client';
import { dbErrorForLog } from './errors';

interface StartupDeps {
  assert: () => Promise<void>;
  log: Pick<typeof logger, 'fatal' | 'error' | 'info' | 'warn'>;
  exit: (code: number) => void;
  retryMs: number;
  /** How often a persistent credentials failure is logged again. */
  authRelogMs: number;
  now: () => number;
}

const defaults: StartupDeps = {
  assert: assertBypassRole,
  log: logger,
  exit: (code) => process.exit(code),
  retryMs: 5_000,
  authRelogMs: 60_000,
  now: Date.now,
};

// SQLSTATE 28P01 invalid_password, 28000 invalid_authorization_specification
// (e.g. no pg_hba entry, unknown role).
const AUTH_FAILURE_CODES = new Set(['28P01', '28000']);

/**
 * True when Postgres refused the credentials. Waiting does not fix that:
 * someone has to correct DB_USER / DB_PASSWORD. Drizzle wraps the pg error,
 * so the code may sit on a cause.
 */
export function isDbAuthFailure(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && AUTH_FAILURE_CODES.has(code)) return true;
    current = current.cause;
  }
  return false;
}

/**
 * Confirm at boot that the connection role bypasses RLS, so `adminDb` can
 * never silently become RLS-scoped, and that it is a member of `app_user`,
 * so `withUserDb` can switch to it. A role that fails either is a
 * configuration error: log it as fatal and exit.
 *
 * A database that is not ready yet (the db container still starting, or
 * migrations not applied so `app_user` does not exist) is not: the server
 * keeps serving, `/api/health/ready` reports the db down, and this keeps
 * checking every `retryMs` until it gets an answer. Run it without
 * awaiting; it never rejects.
 *
 * Rejected credentials (wrong DB_PASSWORD, unknown DB_USER) also keep
 * retrying, because the database side (the role's password, pg_hba) can be
 * fixed without restarting the app, but they are
 * not "starting up": they log at error level and again every
 * `authRelogMs`, so the cause stays visible in the logs instead of one
 * warning at boot.
 */
export async function checkDbRoleAtStartup(overrides: Partial<StartupDeps> = {}): Promise<void> {
  const { assert, log, exit, retryMs, authRelogMs, now } = { ...defaults, ...overrides };
  let warned = false;
  let authLoggedAt: number | undefined;
  for (;;) {
    try {
      await assert();
      log.info('Postgres connection role verified (bypasses RLS, member of app_user)');
      return;
    } catch (err) {
      if (err instanceof DbRoleError) {
        log.fatal({ err }, 'Refusing to start: the database connection role is RLS-scoped');
        exit(1);
        return;
      }
      if (isDbAuthFailure(err)) {
        if (authLoggedAt === undefined || now() - authLoggedAt >= authRelogMs) {
          log.error(
            { err: dbErrorForLog(err) },
            'Postgres rejected the connection credentials; check DB_USER and DB_PASSWORD. ' +
              'Serving with the database down until they work'
          );
          authLoggedAt = now();
        }
      } else if (!warned) {
        log.warn(
          { err: dbErrorForLog(err) },
          'Postgres is not ready yet; serving with the database down'
        );
        warned = true;
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

// Errors waiting fixes: the connection dropped or was refused (node errno or
// SQLSTATE class 08 / 57P0x), a concurrent transaction won (40001, 40P01),
// or the schema is mid-migration (42P01 undefined_table, 42703
// undefined_column, 42704 undefined_object).
const TRANSIENT_ERRNO = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);
const TRANSIENT_SQLSTATE = new Set([
  '40001',
  '40P01',
  '42P01',
  '42703',
  '42704',
  '57P01',
  '57P02',
  '57P03',
  '53300',
]);

/**
 * True when a bootstrap error is worth retrying: a connection problem, a
 * lost serialization race, or a schema that is still being migrated. Looks
 * through Drizzle's (and Better Auth's) `cause` wrapping like isDbAuthFailure.
 */
export function isTransientDbError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (TRANSIENT_ERRNO.has(code) || TRANSIENT_SQLSTATE.has(code) || code.startsWith('08')) {
        return true;
      }
    }
    if (/Connection terminated|timeout exceeded when trying to connect/i.test(current.message)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

interface AdminStartupDeps {
  bootstrap: () => Promise<BootstrapResult>;
  setStatus: (status: AdminStatus) => void;
  log: Pick<typeof logger, 'error' | 'info' | 'warn'>;
  retryMs: number;
}

const adminDefaults: AdminStartupDeps = {
  // Loaded lazily: the auth instance is heavy and this module is imported by
  // tests that never bootstrap.
  bootstrap: async () => (await import('../auth/bootstrap-admin')).bootstrapAdmin(),
  setStatus: setAdminStatus,
  log: logger,
  retryMs: defaults.retryMs,
};

/**
 * Ensure the ADMIN_EMAIL super admin exists, as the second half of startup:
 * call it once checkDbRoleAtStartup has confirmed the database answers and is
 * migrated. Never rejects; run it without awaiting.
 *
 * A transient failure (isTransientDbError) is retried on the startup loop's
 * cadence until the bootstrap settles, so a database blip or a migration
 * still running does not leave the app without its admin until a restart.
 * Settled outcomes are terminal and published for /api/health: ready,
 * skipped (no ADMIN_* env), refused (ownership not proven), or failed (an
 * error waiting cannot fix). Deploys wait for ready and stop early on the
 * others.
 */
export async function ensureAdminAtStartup(
  overrides: Partial<AdminStartupDeps> = {}
): Promise<AdminStatus> {
  const { bootstrap, setStatus, log, retryMs } = { ...adminDefaults, ...overrides };
  let warned = false;
  for (;;) {
    try {
      const result = await bootstrap();
      const status = adminStatusAfter(result);
      setStatus(status);
      if (result === 'created') log.info('Created the super admin account from ADMIN_EMAIL');
      else if (result === 'promoted') log.info('Granted super_admin to the ADMIN_EMAIL account');
      else if (result === 'skipped')
        log.info('ADMIN_EMAIL/ADMIN_PASSWORD not set; no super admin bootstrap');
      // 'refused' has already logged its own error with what to do.
      return status;
    } catch (err) {
      if (!isTransientDbError(err)) {
        log.error({ err: dbErrorForLog(err) }, 'Super admin bootstrap failed');
        setStatus('failed');
        return 'failed';
      }
      if (!warned) {
        log.warn(
          { err: dbErrorForLog(err) },
          'Super admin bootstrap hit a transient database error; retrying'
        );
        warned = true;
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}
