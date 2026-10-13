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
