import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { dbErrorForLog } from './errors';
import * as schema from './schema';

/**
 * The server's one connection to Postgres.
 *
 * - `adminDb` runs as the connection role (DB_USER), which bypasses RLS. Use
 *   it only where the server acts for itself: webhooks, admin tooling, jobs,
 *   and the auth tables (which app_user cannot read).
 * - `withUserDb(userId, fn)` is the path for anything done on behalf of a
 *   user (or an anonymous visitor). RLS decides what `fn` can see.
 *
 * The pool connects lazily, so importing this module never dials the
 * database and the server boots while the db container is still starting.
 */
export const pool = new pg.Pool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  max: 10,
  idleTimeoutMillis: 30_000,
  // Fail a checkout instead of waiting forever when the db is unreachable,
  // so /api/health/ready answers 503 promptly.
  connectionTimeoutMillis: 5_000,
  // A request Hono has already timed out keeps running its query, and the
  // pooled connection stays checked out until the query ends. Postgres
  // cancels any statement past 30 s and ends a transaction left idle for
  // 30 s (a callback stuck awaiting something else), so neither can hold
  // one of the 10 connections indefinitely. The client-side query_timeout
  // is the backstop for a database that stops answering at all; it sits
  // above statement_timeout so the server's cleaner cancel normally wins.
  statement_timeout: 30_000,
  idle_in_transaction_session_timeout: 30_000,
  query_timeout: 35_000,
});

// An idle client can die under us (db restart, failover). pg emits that on
// the pool; without a listener it is an uncaught error that kills the
// process. The pool drops the dead client and the next checkout reconnects.
pool.on('error', (err) => {
  logger.error(
    { err: dbErrorForLog(err) },
    'Idle Postgres connection failed; the pool will reconnect'
  );
});

export const adminDb: NodePgDatabase<typeof schema> = drizzle({ client: pool, schema });

/** The transaction handle `withUserDb` gives its callback. */
export type UserDb = Parameters<Parameters<typeof adminDb.transaction>[0]>[0];

/** Anything that can run a raw statement: `adminDb` or a transaction. */
type Executor = Pick<NodePgDatabase<typeof schema>, 'execute'>;

/**
 * Run `fn` inside one transaction as role `app_user`, with `app.user_id` set
 * to `userId` (`null` for an anonymous request, which `app.user_id()` reads
 * as NULL, so user-scoped policies match nothing). RLS is in force for every
 * statement `fn` issues.
 *
 * Both settings go in ONE parameterized statement, `set_config(..., true)`,
 * which is transaction-local: COMMIT or ROLLBACK resets them, so nothing
 * leaks to the next request that borrows the pooled connection. If `fn`
 * throws, the transaction rolls back and the connection goes back to the
 * pool.
 *
 * What this boundary does and does not guard: switching to `app_user` makes
 * RLS catch application-logic mistakes (a missing `where`, the wrong id). It
 * is NOT a defence against SQL injection. The connection role is a member of
 * `app_user`, so SQL running inside this transaction could `reset role` and
 * read everything. Never build SQL text from input: use Drizzle's query
 * builder or the `sql` template (which binds values as parameters).
 */
export async function withUserDb<T>(
  userId: string | null,
  fn: (tx: UserDb) => Promise<T>
): Promise<T> {
  return adminDb.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('role', 'app_user', true), set_config('app.user_id', ${userId ?? ''}, true)`
    );
    return fn(tx);
  });
}

/**
 * The connection role is wrong for `adminDb`: RLS would scope it, or it
 * cannot switch to `app_user`, so `withUserDb` would fail on every request.
 */
export class DbRoleError extends Error {
  constructor(role: string, reason: 'no-bypass' | 'not-app-user-member' = 'no-bypass') {
    super(
      reason === 'no-bypass'
        ? `Postgres role "${role}" cannot bypass row-level security. ` +
            'Set DB_USER to a role with BYPASSRLS (the default is postgres).'
        : `Postgres role "${role}" is not a member of app_user, so it cannot run ` +
            'user requests under RLS. Grant it (GRANT app_user TO ' +
            `${role}) or set DB_USER to a role that is (the default is postgres).`
    );
    this.name = 'DbRoleError';
  }
}

/** Role app_user is missing: the migrations have not run yet. Retryable. */
export class DbNotMigratedError extends Error {
  constructor() {
    super('Role app_user does not exist yet; the database migrations have not run');
    this.name = 'DbNotMigratedError';
  }
}

/**
 * Resolve if the current role bypasses RLS (superuser or BYPASSRLS) and is a
 * member of `app_user` (so `withUserDb` can switch to it). Throw
 * `DbRoleError` if either is false. A database without `app_user` yet (fresh
 * deploy, migrations pending) throws `DbNotMigratedError` instead, and
 * connection failures propagate as they are: both mean "not ready yet",
 * which a caller retries, not "wrong role".
 */
export async function assertBypassRole(db: Executor = adminDb): Promise<void> {
  const { rows } = await db.execute<{
    role: string;
    bypass: boolean | null;
    hasAppUser: boolean;
    member: boolean;
  }>(
    sql`select current_user as role,
      (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) as bypass,
      exists (select 1 from pg_roles where rolname = 'app_user') as "hasAppUser",
      case when exists (select 1 from pg_roles where rolname = 'app_user')
        then pg_has_role(current_user, 'app_user', 'MEMBER') else false end as member`
  );
  const row = rows[0];
  const role = row?.role ?? env.DB_USER;
  if (!row?.bypass) throw new DbRoleError(role);
  if (!row.hasAppUser) throw new DbNotMigratedError();
  if (!row.member) throw new DbRoleError(role, 'not-app-user-member');
}

/** What `pingDb` found: the database answered, or the error it failed with. */
export type DbPing = { ok: true } | { ok: false; error: unknown };

/**
 * Ask Postgres a trivial query. Never throws: an unreachable database is
 * `{ ok: false, error }`, so the caller can log why (through `dbErrorForLog`)
 * without a try/catch of its own.
 */
export async function pingDb(target: pg.Pool = pool): Promise<DbPing> {
  try {
    await target.query('select 1');
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
