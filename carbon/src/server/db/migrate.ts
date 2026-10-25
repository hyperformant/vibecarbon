import { resolve } from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/**
 * Apply db/migrations/ with drizzle-orm's migrator: the one way migrations
 * reach a database. They run as the owner (`postgres`) in a step of their
 * own, never in the app: the compose `app-migrate` one-shot and the k8s
 * `migrate` init container run db/migrate-cli.ts, and `npm run db:migrate`
 * runs the same step locally (scripts/db-migrate.ts). The app only checks
 * the ledger (verifyMigrations, db/startup.ts), so the request process never
 * holds the owner password (security plan 2026-10-20, R8).
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
 * Whether the ledger on `client` already has every migration in `folder`:
 * its newest entry is at least as new as the newest migration file. Reads
 * only, so the app runs it as `app_service` (which may read the ledger and
 * nothing else in the `drizzle` schema), and a standby runs it on a
 * read-only database. Never applies, locks or writes anything.
 */
export async function verifyMigrations(
  client: pg.ClientBase,
  folder: string = migrationsFolder()
): Promise<{ upToDate: boolean }> {
  const files = readMigrationFiles({ migrationsFolder: folder });
  const newest = Math.max(0, ...files.map((m) => m.folderMillis));
  const { latest } = await ledger(client);
  return { upToDate: latest >= newest };
}

/**
 * Take every server-only table (RLS on, no policies, plus the Better Auth
 * tables) back from every role but superusers, its owner, this one and the
 * app's own role, app_service:
 * app.revoke_server_only_tables() in db/migrations/0002_baseline_post.sql.
 * Run after every migration run, new migrations or not, so a table a later
 * migration creates never stays readable to an RLS-bypass add-on role (the
 * default privileges grant it at creation, and a server never reruns the
 * add-on init scripts). A failure fails the run: a deploy that leaves token
 * tables readable is not a successful one. The template baseline creates the
 * function, so every project has it; only a database whose migrations are
 * not the template's (the runner's own tests) lacks it, and has nothing to
 * guard.
 */
async function revokeServerOnlyTables(client: pg.ClientBase): Promise<void> {
  const { rows } = await client.query<{ present: boolean }>(
    `select to_regprocedure('app.revoke_server_only_tables()') is not null as present`
  );
  if (rows[0]?.present) await client.query('select app.revoke_server_only_tables()');
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
    return { kind: 'standby', ...(await verifyMigrations(client, folder)) };
  }

  await client.query('select pg_advisory_lock($1::bigint)', [MIGRATIONS_LOCK_KEY]);
  let outcome: MigrationOutcome | undefined;
  try {
    const before = await ledger(client);
    await migrate(drizzle({ client }), { migrationsFolder: folder });
    await revokeServerOnlyTables(client);
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

/** Where to connect; any timeout fields in it are ignored (see below). */
export type MigrationConnection = Pick<
  pg.ClientConfig,
  'host' | 'port' | 'user' | 'password' | 'database'
>;

/**
 * Run `fn` on a connection of its own, opened from `connection` and closed
 * afterwards: the migrate step (db/migrate-cli.ts, `npm run db:migrate`) and
 * the app's startup ledger check (db/startup.ts) share it.
 *
 * Deliberately NOT a pool client: the request pool's statement, query and
 * idle-in-transaction timeouts (30-35 s, db/client.ts) are right for a web
 * request and wrong here. A long migration (an index build, a backfill)
 * would be cancelled the same way on every run, and a replica waiting in
 * pg_advisory_lock for another replica's run would be cancelled and report
 * the migration failed. Waiting on that lock is waiting for a dependency,
 * not a retry. So only the location and credentials are taken from
 * `connection`, and the session's timeouts are set to 0 (off) explicitly, in
 * case the role or database sets defaults.
 */
export async function onOwnConnection<T>(
  connection: MigrationConnection,
  fn: (client: pg.Client) => Promise<T>
): Promise<T> {
  const { host, port, user, password, database } = connection;
  // Only the connect itself is bounded (as for the pool), so an unreachable
  // database fails fast into the caller's connection-loss wait.
  const client = new pg.Client({
    host,
    port,
    user,
    password,
    database,
    connectionTimeoutMillis: 5_000,
  });
  try {
    // Inside the try: a connect that fails (refused, timed out) still ends
    // the client, so its socket and timer never outlive the failure.
    await client.connect();
    await client.query(
      'set statement_timeout = 0; set lock_timeout = 0; set idle_in_transaction_session_timeout = 0'
    );
    return await fn(client);
  } finally {
    // Ending the session also drops the advisory lock if the unlock failed.
    await client.end().catch(() => undefined);
  }
}

/** Apply pending migrations on a connection of their own (onOwnConnection). */
export function runMigrationsOnOwnConnection(
  connection: MigrationConnection,
  folder: string = migrationsFolder()
): Promise<MigrationOutcome> {
  return onOwnConnection(connection, (client) => runMigrations(client, folder));
}

/** Check the ledger on a connection of its own (onOwnConnection). */
export function verifyMigrationsOnOwnConnection(
  connection: MigrationConnection,
  folder: string = migrationsFolder()
): Promise<{ upToDate: boolean }> {
  return onOwnConnection(connection, (client) => verifyMigrations(client, folder));
}
