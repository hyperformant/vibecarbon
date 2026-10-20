/**
 * Apply the database migrations locally (`npm run db:migrate`).
 *
 * The same migrate step deploys run (src/server/db/migrate-cli.ts, the
 * compose `app-migrate` one-shot and the k8s init container), so dev, CI and
 * every deploy mode apply migrations one way, with one ledger
 * (drizzle.__drizzle_migrations), and set up the app's own role the same
 * way. It connects as the owner, `postgres`, with POSTGRES_PASSWORD from
 * .env.local (DB_PASSWORD on a project that predates it), on DB_HOST and the
 * same dev port rule as the server (src/server/db/port.ts), then creates or
 * updates `app_service` with APP_DB_PASSWORD. The dev server connects as
 * that role (scripts/dev.js), never as the owner. The super admin is not
 * created here: the app does that at startup from ADMIN_EMAIL and
 * ADMIN_PASSWORD (src/server/auth/bootstrap-admin.ts).
 */
import { existsSync } from 'node:fs';
import { runMigrateStep } from '../src/server/db/migrate-cli';
import { resolveDbPort } from '../src/server/db/port';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const env = process.env;
const host = env.DB_HOST ?? 'localhost';
const connection = {
  host,
  port: Number(resolveDbPort({ ...env, DB_HOST: host }) ?? 5432),
  user: 'postgres',
  password: env.POSTGRES_PASSWORD || env.DB_PASSWORD,
  database: env.DB_NAME ?? 'postgres',
};

try {
  const outcome = await runMigrateStep(connection, env.APP_DB_PASSWORD);
  if (outcome.kind === 'standby') {
    console.log(
      outcome.upToDate
        ? 'Standby database: migrations are up to date (applied on the primary)'
        : 'Standby database: migrations run on the primary and replicate here'
    );
  } else if (outcome.newlyApplied > 0) {
    console.log(`Applied ${outcome.newlyApplied} database migration(s)`);
  } else {
    console.log('Database migrations are up to date');
  }
} catch (err) {
  console.error('Database migrations failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
