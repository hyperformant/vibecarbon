import {
  type AdminStatus,
  adminStatusAfter,
  type BootstrapResult,
  setAdminStatus,
} from '../auth/admin-status';
import { logger } from '../lib/logger';
import { assertBypassRole, connectionConfig, DbRoleError } from './client';
import { dbErrorForLog, isConnectionLoss } from './errors';
import { verifyMigrationsOnOwnConnection } from './migrate';
import {
  type MigrationStatus,
  migrationFailureReason,
  setMigrationStatus,
} from './migration-status';

export { isConnectionLoss };

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
 * `app_user` missing because migrations have not run) is not: the server
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
      log.info('Postgres connection role verified');
      return;
    } catch (err) {
      if (err instanceof DbRoleError) {
        log.fatal({ err }, 'Refusing to start: the database connection role is wrong for the app');
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
  setStatus: setAdminStatus,
  log: logger,
  retryMs: defaults.retryMs,
  relogMs: defaults.authRelogMs,
  now: Date.now,
};

/**
 * Ensure the ADMIN_EMAIL super admin exists, as the last step of startup:
 * call it once migrations are applied (verifyMigrationsAtStartup) and
 * checkDbRoleAtStartup has confirmed the role, so every table the bootstrap
 * writes exists. Never rejects; run it without awaiting. Every wait below
 * runs on the startup loop's cadence (`retryMs`).
 *
 * - Waits through connection loss (isConnectionLoss), warning once.
 * - Waits while the database is a read-only replica (SQLSTATE 25006, a
 *   compose-ha standby that has no admin row yet): the status stays
 *   `pending` (not settled on a standby); replication or the promotion
 *   restart settles it.
 * - Any other error publishes `failed` (so a deploy stops with a reason) and
 *   keeps retrying, so fixing the cause recovers without a restart.
 *
 * While a persistent error lasts, the cause is logged at error level again
 * every `relogMs`, so it reaches a deploy's log tail.
 * Settled outcomes (ready, skipped, refused) end the loop.
 */
export async function ensureAdminAtStartup(
  overrides: Partial<AdminStartupDeps> = {}
): Promise<AdminStatus> {
  const { bootstrap, setStatus, log, retryMs, relogMs, now } = {
    ...adminDefaults,
    ...overrides,
  };
  let warnedConnection = false;
  let notedReadOnly = false;
  // Throttled per cause: the first occurrence of each distinct cause always
  // logs at error level, repeats every relogMs.
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

interface MigrateStartupDeps {
  verify: () => Promise<{ upToDate: boolean }>;
  setStatus: (status: MigrationStatus, reason?: string) => void;
  log: Pick<typeof logger, 'error' | 'info' | 'warn'>;
  retryMs: number;
  /** Waits between looks; defaults to `retryMs`. */
  pause?: () => Promise<void>;
}

const migrateDefaults: MigrateStartupDeps = {
  verify: () => verifyMigrationsOnOwnConnection(connectionConfig),
  setStatus: setMigrationStatus,
  log: logger,
  retryMs: defaults.retryMs,
};

/**
 * Wait until the database has every migration, and publish that for
 * /api/health and the migrations gate. The app never applies a migration:
 * the migrate step does, as the owner, before the app starts (compose
 * `app-migrate`, the k8s `migrate` init container, `npm run db:migrate`
 * locally; db/migrate-cli.ts). This only reads drizzle's ledger
 * (verifyMigrations), so it runs as the app's own role. Never rejects;
 * resolves with the final status.
 *
 * - While the ledger is behind db/migrations, logs "migrations pending"
 *   once, keeps the status `pending` (readiness answers 503) and looks again
 *   every `retryMs`. That covers a standby waiting for replication too.
 * - Waits through connection loss (isConnectionLoss), warning once.
 * - Any other error (the role may not read the ledger) is published as
 *   `failed` with its SQLSTATE, logged at error level, and terminal for this
 *   boot, as a failed migration was.
 */
export async function verifyMigrationsAtStartup(
  overrides: Partial<MigrateStartupDeps> = {}
): Promise<MigrationStatus> {
  const { verify, setStatus, log, retryMs, pause } = { ...migrateDefaults, ...overrides };
  const wait = pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, retryMs)));
  let warnedConnection = false;
  let notedPending = false;
  for (;;) {
    try {
      const { upToDate } = await verify();
      if (!upToDate) {
        if (!notedPending) {
          log.info(
            'Database migrations pending: the migrate step applies them (app-migrate, the ' +
              'migrate init container, or `npm run db:migrate`). Serving with readiness down'
          );
          notedPending = true;
        }
        await wait();
        continue;
      }
      setStatus('applied');
      log.info('Database migrations are up to date');
      return 'applied';
    } catch (err) {
      if (isConnectionLoss(err)) {
        if (!warnedConnection) {
          log.warn(
            { err: dbErrorForLog(err) },
            'The database migration check is waiting for the database connection'
          );
          warnedConnection = true;
        }
        await wait();
        continue;
      }
      const reason = migrationFailureReason(err);
      setStatus('failed', reason);
      log.error(
        { err: dbErrorForLog(err) },
        'Could not read the database migration ledger; the app serves only /api/health until ' +
          'the cause is fixed and the app restarted'
      );
      return 'failed';
    }
  }
}

interface DatabaseStartupDeps {
  checkRole: typeof checkDbRoleAtStartup;
  migrate: () => Promise<MigrationStatus>;
  ensureAdmin: () => Promise<unknown>;
}

/**
 * The app's database startup, in order: wait until Postgres answers as a
 * role that bypasses RLS, wait until the migrate step has applied every
 * migration (the app applies none itself), confirm the role is a member of
 * the `app_user` the baseline creates, then bootstrap the super admin. An
 * unreadable ledger stops the sequence (the admin bootstrap never runs
 * against a half-known schema). Never rejects; run it without awaiting.
 */
export async function startDatabase(overrides: Partial<DatabaseStartupDeps> = {}): Promise<void> {
  const { checkRole, migrate, ensureAdmin } = {
    checkRole: checkDbRoleAtStartup,
    migrate: () => verifyMigrationsAtStartup(),
    ensureAdmin: () => ensureAdminAtStartup(),
    ...overrides,
  };
  await checkRole({ assert: () => assertBypassRole(undefined, { requireAppUser: false }) });
  if ((await migrate()) !== 'applied') return;
  await checkRole();
  await ensureAdmin();
}
