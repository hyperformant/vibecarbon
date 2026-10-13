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

// Connection loss only: the database went away or refused us. These are a
// dependency wait (the db container restarting, a failover), the same wait
// checkDbRoleAtStartup does before the bootstrap ever runs. Node errno codes
// for the socket, SQLSTATE class 08 (connection exception) and 57P01-03
// (admin/crash shutdown, cannot connect now).
const CONNECTION_ERRNO = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);
const CONNECTION_SQLSTATE = new Set(['57P01', '57P02', '57P03']);

/**
 * True when a bootstrap error is the connection to Postgres dropping or
 * being refused. Looks through Drizzle's (and Better Auth's) `cause`
 * wrapping like isDbAuthFailure.
 */
export function isConnectionLoss(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (CONNECTION_ERRNO.has(code) || CONNECTION_SQLSTATE.has(code) || code.startsWith('08')) {
        return true;
      }
    } else if (/^Connection terminated/.test(current.message)) {
      // node-pg raises "Connection terminated (unexpectedly)" with no code at
      // all when the server closes the socket mid-query. Matched only when
      // there is no code, as the same dependency wait as the codes above.
      return true;
    }
    current = current.cause;
  }
  return false;
}

/** SQLSTATE 25006: the database is a read-only replica (a compose-ha standby). */
export function isReadOnlyDatabase(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if ((current as { code?: unknown }).code === '25006') return true;
    current = current.cause;
  }
  return false;
}

interface AdminStartupDeps {
  bootstrap: () => Promise<BootstrapResult>;
  schemaReady: () => Promise<{ ready: boolean; missing: string[] }>;
  setStatus: (status: AdminStatus) => void;
  log: Pick<typeof logger, 'error' | 'info' | 'warn'>;
  retryMs: number;
  /** How often a persistent problem is logged again, at error level. */
  relogMs: number;
  now: () => number;
}

const adminDefaults: AdminStartupDeps = {
  // Loaded lazily: the auth instance is heavy and this module is imported by
  // tests that never bootstrap.
  bootstrap: async () => (await import('../auth/bootstrap-admin')).bootstrapAdmin(),
  schemaReady: async () => (await import('../auth/bootstrap-admin')).adminSchemaReady(),
  setStatus: setAdminStatus,
  log: logger,
  retryMs: defaults.retryMs,
  relogMs: defaults.authRelogMs,
  now: Date.now,
};

/**
 * Ensure the ADMIN_EMAIL super admin exists, as the second half of startup:
 * call it once checkDbRoleAtStartup has confirmed the database answers and is
 * migrated. Never rejects; run it without awaiting. Every wait below runs on
 * the startup loop's cadence (`retryMs`).
 *
 * - Waits for a positive schema check (adminSchemaReady: every column the
 *   bootstrap writes exists) before trying, so a migration still running is
 *   waited for by its condition, not by retrying schema errors.
 * - Waits through connection loss (isConnectionLoss), warning once.
 * - Waits while the database is a read-only replica (SQLSTATE 25006, a
 *   compose-ha standby that has no admin row yet): the status stays
 *   `pending` (not settled on a standby); replication or the promotion
 *   restart settles it.
 * - Any other error publishes `failed` (so a deploy stops with a reason) and
 *   keeps retrying, so fixing the cause recovers without a restart.
 *
 * While waiting on the schema or on a persistent error, the cause is logged
 * at error level again every `relogMs`, so it reaches a deploy's log tail.
 * Settled outcomes (ready, skipped, refused) end the loop.
 */
export async function ensureAdminAtStartup(
  overrides: Partial<AdminStartupDeps> = {}
): Promise<AdminStatus> {
  const { bootstrap, schemaReady, setStatus, log, retryMs, relogMs, now } = {
    ...adminDefaults,
    ...overrides,
  };
  let warnedConnection = false;
  let notedReadOnly = false;
  // Throttled per cause: the first occurrence of each distinct cause always
  // logs at error level, repeats every relogMs. One shared timer would let a
  // schema-wait line swallow the first real failure right after it.
  const loggedAt = new Map<string, number>();
  const relog = (cause: string, fields: object, message: string) => {
    const last = loggedAt.get(cause);
    if (last === undefined || now() - last >= relogMs) {
      log.error(fields, message);
      loggedAt.set(cause, now());
    }
  };
  // Published only on change. Waiting states put a stale `failed` back to
  // `pending`, so health reports what the loop is doing now.
  let published: AdminStatus | undefined;
  const publish = (next: AdminStatus) => {
    if (next !== published) {
      setStatus(next);
      published = next;
    }
  };
  const waiting = () => {
    if (published === 'failed') publish('pending');
  };
  const pause = () => new Promise((resolve) => setTimeout(resolve, retryMs));

  for (;;) {
    try {
      const schema = await schemaReady();
      if (!schema.ready) {
        waiting();
        relog(
          'schema',
          { missing: schema.missing },
          'Super admin bootstrap is waiting for the auth tables; run the database migrations'
        );
        await pause();
        continue;
      }
      const result = await bootstrap();
      const status = adminStatusAfter(result);
      publish(status);
      if (result === 'created') log.info('Created the super admin account from ADMIN_EMAIL');
      else if (result === 'promoted') log.info('Granted super_admin to the ADMIN_EMAIL account');
      else if (result === 'skipped')
        log.info('ADMIN_EMAIL/ADMIN_PASSWORD not set; no super admin bootstrap');
      // 'refused' has already logged its own error with what to do.
      return status;
    } catch (err) {
      if (isConnectionLoss(err)) {
        waiting();
        if (!warnedConnection) {
          log.warn(
            { err: dbErrorForLog(err) },
            'Super admin bootstrap lost the database connection; waiting for it'
          );
          warnedConnection = true;
        }
      } else if (isReadOnlyDatabase(err)) {
        waiting();
        if (!notedReadOnly) {
          log.info(
            'The database is read-only (a standby); the super admin arrives with replication'
          );
          notedReadOnly = true;
        }
      } else {
        publish('failed');
        const code = (err as { code?: unknown; cause?: { code?: unknown } })?.code;
        const causeCode = (err as { cause?: { code?: unknown } })?.cause?.code;
        relog(
          `failed:${String(code ?? causeCode ?? (err instanceof Error ? err.message : err))}`,
          { err: dbErrorForLog(err) },
          'Super admin bootstrap failed; retrying'
        );
      }
      await pause();
    }
  }
}
