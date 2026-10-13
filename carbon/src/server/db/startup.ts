import { logger } from '../lib/logger';
import { assertBypassRole, DbRoleError } from './client';

interface StartupDeps {
  assert: () => Promise<void>;
  log: Pick<typeof logger, 'fatal' | 'info' | 'warn'>;
  exit: (code: number) => void;
  retryMs: number;
}

const defaults: StartupDeps = {
  assert: assertBypassRole,
  log: logger,
  exit: (code) => process.exit(code),
  retryMs: 5_000,
};

/**
 * Confirm at boot that the connection role bypasses RLS, so `adminDb` can
 * never silently become RLS-scoped. A role that cannot is a configuration
 * error: log it as fatal and exit.
 *
 * A database that is not reachable yet (the db container still starting) is
 * not: the server keeps serving, `/api/health/ready` reports the db down,
 * and this keeps checking every `retryMs` until it gets an answer. Run it
 * without awaiting; it never rejects.
 */
export async function checkDbRoleAtStartup(overrides: Partial<StartupDeps> = {}): Promise<void> {
  const { assert, log, exit, retryMs } = { ...defaults, ...overrides };
  let warned = false;
  for (;;) {
    try {
      await assert();
      log.info('Postgres connection role verified (bypasses RLS)');
      return;
    } catch (err) {
      if (err instanceof DbRoleError) {
        log.fatal({ err }, 'Refusing to start: the database connection role is RLS-scoped');
        exit(1);
        return;
      }
      if (!warned) {
        log.warn({ err }, 'Postgres is not reachable yet; serving with the database down');
        warned = true;
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}
