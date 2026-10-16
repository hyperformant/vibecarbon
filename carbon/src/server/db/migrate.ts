import { resolve } from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';

/**
 * Apply db/migrations/ with drizzle-orm's migrator: the one way migrations
 * reach a database. The app runs it at startup (db/startup.ts
 * migrateAtStartup) and `npm run db:migrate` runs it locally
 * (scripts/db-migrate.ts); no deploy step applies SQL on its own.
 *
 * The ledger is drizzle's default, `drizzle.__drizzle_migrations`. Pending
 * migrations run in ONE transaction, so a failure leaves none of them
 * applied. A restored database carries its ledger, so this is a no-op there.
 */

/** Where the migrations are: `db/migrations` under the app's working directory. */
export function migrationsFolder(cwd: string = process.cwd()): string {
  return resolve(cwd, 'db', 'migrations');
}

/**
 * Stable key for the migration advisory lock (any bigint; unique to
 * migrations in this database, distinct from the admin bootstrap's key).
 */
export const MIGRATIONS_LOCK_KEY = '7264519330021876';

export type MigrationOutcome =
  /** This database is writable and now has every migration. */
  | { kind: 'applied'; newlyApplied: number }
  /**
   * A read-only standby: migrations are the primary's job and arrive by
   * replication. `upToDate` says whether its ledger already has them all.
   */
  | { kind: 'standby'; upToDate: boolean };

async function ledger(client: pg.ClientBase): Promise<{ count: number; latest: number }> {
  const { rows } = await client.query<{ present: boolean }>(
    `select to_regclass('drizzle.__drizzle_migrations') is not null as present`
  );
  if (!rows[0]?.present) return { count: 0, latest: 0 };
  const res = await client.query<{ count: string; latest: string | null }>(
    'select count(*) as count, max(created_at) as latest from drizzle.__drizzle_migrations'
  );
  return { count: Number(res.rows[0]?.count ?? 0), latest: Number(res.rows[0]?.latest ?? 0) };
}

/**
 * Apply every pending migration on `client`, a dedicated connection (a
 * checked-out pool client or a plain client) that nothing else uses
 * meanwhile. Holds a session advisory lock for the whole run, so replicas
 * starting together take turns: the second finds the ledger complete and
 * applies nothing. The lock is released in `finally`; if that fails the
 * error propagates, and the caller should discard the client (which ends the
 * session and drops the lock with it).
 *
 * On a standby (pg_is_in_recovery) nothing is applied or locked; the ledger
 * is only compared with the folder.
 */
export async function runMigrations(
  client: pg.PoolClient | pg.Client,
  folder: string = migrationsFolder()
): Promise<MigrationOutcome> {
  const { rows } = await client.query<{ standby: boolean }>(
    'select pg_is_in_recovery() as standby'
  );
  if (rows[0]?.standby) {
    const files = readMigrationFiles({ migrationsFolder: folder });
    const newest = Math.max(0, ...files.map((m) => m.folderMillis));
    const { latest } = await ledger(client);
    return { kind: 'standby', upToDate: latest >= newest };
  }

  await client.query('select pg_advisory_lock($1::bigint)', [MIGRATIONS_LOCK_KEY]);
  let outcome: MigrationOutcome | undefined;
  try {
    const before = await ledger(client);
    await migrate(drizzle({ client }), { migrationsFolder: folder });
    const after = await ledger(client);
    outcome = { kind: 'applied', newlyApplied: after.count - before.count };
  } finally {
    const unlock = client.query('select pg_advisory_unlock($1::bigint)', [MIGRATIONS_LOCK_KEY]);
    // A failed unlock only matters when the run itself succeeded; otherwise
    // the run's own error is the one to report.
    if (outcome) await unlock;
    else await unlock.catch(() => undefined);
  }
  return outcome;
}

/**
 * Check out a client from `source`, run `fn` on it and release it, discarding
 * the client if `fn` threw (so a session lock never outlives a broken run).
 */
export async function withDedicatedClient<T>(
  source: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await source.connect();
  let broken: Error | undefined;
  try {
    return await fn(client);
  } catch (err) {
    broken = err instanceof Error ? err : new Error(String(err));
    throw err;
  } finally {
    client.release(broken);
  }
}
