/**
 * Apply the database migrations locally (`npm run db:migrate`).
 *
 * The same runMigrations() the app runs at startup (src/server/db/migrate.ts),
 * so dev, CI and every deploy mode apply migrations one way, with one ledger
 * (drizzle.__drizzle_migrations). Connects with the server's DB_* vars from
 * .env.local and the same dev port rule (src/server/db/port.ts). The super
 * admin is not created here: the app does that at startup from ADMIN_EMAIL
 * and ADMIN_PASSWORD (src/server/auth/bootstrap-admin.ts).
 */
import { existsSync } from 'node:fs';
import pg from 'pg';
import { runMigrations } from '../src/server/db/migrate';
import { resolveDbPort } from '../src/server/db/port';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const env = process.env;
const host = env.DB_HOST ?? 'localhost';
const client = new pg.Client({
  host,
  port: Number(resolveDbPort({ ...env, DB_HOST: host }) ?? 5432),
  user: env.DB_USER ?? 'postgres',
  password: env.DB_PASSWORD,
  database: env.DB_NAME ?? 'postgres',
});

try {
  await client.connect();
  const outcome = await runMigrations(client);
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
} finally {
  await client.end().catch(() => undefined);
}
