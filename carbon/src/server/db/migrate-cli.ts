/**
 * The migrate step: `node dist/server/migrate-cli.js`. Applies the pending
 * migrations as the database owner, then sets up the app's own role
 * (`app_service`, db/app-service-role.ts), and exits 0 or 1. It runs outside
 * the app process, so the app never holds the owner password (security plan
 * 2026-10-20, R8):
 *
 * - compose: the one-shot `app-migrate` service (same image as the app). The
 *   app starts only after it completed successfully.
 * - k8s: the `migrate` init container of the app pod.
 * - local: `npm run db:migrate` (scripts/db-migrate.ts) runs the same step.
 *
 * Reads its connection from the environment: DB_HOST, DB_PORT (5432),
 * DB_USER (postgres), DB_PASSWORD (the owner's), DB_NAME (postgres), and
 * APP_DB_PASSWORD for `app_service`. It does not load the app's env schema:
 * the step needs none of the app's keys.
 *
 * On a standby (compose-ha, k8s-ha) nothing is applied: the primary's
 * migrations and role arrive by replication, so it exits 0 at once.
 *
 * Connection loss (the db still starting, which an init container sees on
 * a cold deploy) is a dependency wait, as in the app's startup: it waits and
 * looks again. Anything else (rejected credentials, a failed migration)
 * exits 1 with a one-line cause.
 */
import { pathToFileURL } from 'node:url';
import { logger } from '../lib/logger';
import { ensureAppServiceRole } from './app-service-role';
import { dbErrorForLog, isConnectionLoss } from './errors';
import {
  type MigrationConnection,
  type MigrationOutcome,
  migrationsFolder,
  onOwnConnection,
  runMigrations,
} from './migrate';

/**
 * Apply the migrations, then (on a primary) create or update `app_service`
 * with `appPassword`, on one connection of their own.
 */
export async function runMigrateStep(
  connection: MigrationConnection,
  appPassword: string | undefined,
  folder: string = migrationsFolder()
): Promise<MigrationOutcome> {
  if (!appPassword) {
    throw new Error(
      'APP_DB_PASSWORD is not set, so the app database role cannot be set up. ' +
        'Run `vibecarbon upgrade` to generate it'
    );
  }
  return onOwnConnection(connection, async (client) => {
    const outcome = await runMigrations(client, folder);
    if (outcome.kind === 'applied') await ensureAppServiceRole(client, appPassword);
    return outcome;
  });
}

/** The migrate step's connection, from the process environment. */
export function migrateConnectionFromEnv(env: NodeJS.ProcessEnv): MigrationConnection {
  if (!env.DB_HOST) throw new Error('DB_HOST is not set');
  if (!env.DB_PASSWORD) throw new Error('DB_PASSWORD (the database owner password) is not set');
  return {
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 5432),
    user: env.DB_USER || 'postgres',
    password: env.DB_PASSWORD,
    database: env.DB_NAME || 'postgres',
  };
}

interface MainDeps {
  run: () => Promise<MigrationOutcome>;
  log: Pick<typeof logger, 'error' | 'info' | 'warn'>;
  pause: () => Promise<void>;
}

/** Run the step to an outcome: 0 done (or standby), 1 failed. */
export async function migrateMain({ run, log, pause }: MainDeps): Promise<0 | 1> {
  let warned = false;
  for (;;) {
    try {
      const outcome = await run();
      if (outcome.kind === 'standby') {
        log.info('The database is a standby: migrations arrive from the primary');
      } else if (outcome.newlyApplied > 0) {
        log.info({ applied: outcome.newlyApplied }, 'Applied database migrations');
      } else {
        log.info('Database migrations are up to date');
      }
      return 0;
    } catch (err) {
      if (isConnectionLoss(err)) {
        if (!warned) {
          log.warn({ err: dbErrorForLog(err) }, 'Waiting for the database to accept connections');
          warned = true;
        }
        await pause();
        continue;
      }
      log.error({ err: dbErrorForLog(err) }, 'Database migrations failed');
      return 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let code: 0 | 1 = 1;
  try {
    const connection = migrateConnectionFromEnv(process.env);
    code = await migrateMain({
      run: () => runMigrateStep(connection, process.env.APP_DB_PASSWORD),
      log: logger,
      pause: () => new Promise((resolve) => setTimeout(resolve, 2_000)),
    });
  } catch (err) {
    logger.error({ err: dbErrorForLog(err) }, 'Database migrations failed');
  }
  // exitCode, not exit(): the log line is flushed before the process ends.
  process.exitCode = code;
}
