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
 * - `adminDb` runs as the connection role (DB_USER, `app_service` in every
 *   deploy and in local dev), which bypasses RLS but owns nothing. Use
 *   it only where the server acts for itself: webhooks, admin tooling, jobs,
 *   and the auth tables (which app_user cannot read).
 * - `withUserDb(userId, fn)` is the path for anything done on behalf of a
 *   user (or an anonymous visitor). RLS decides what `fn` can see.
 *
 * The pool connects lazily, so importing this module never dials the
 * database and the server boots while the db container is still starting.
 */
/**
 * Where the database is and who to connect as: the pool below and the
 * startup ledger check (db/migrate.ts, on a connection of their own without
 * the pool's request timeouts) share it.
 */
export const connectionConfig = {
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
} as const;

export const pool = new pg.Pool({
  ...connectionConfig,
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
 * The connection role is wrong for the app: RLS would scope `adminDb`, it
 * cannot switch to `app_user` (so `withUserDb` would fail on every request),
 * or, in production, it holds more than the app needs (a superuser, or the
 * owner of a table, either of which can change the schema or reach the
 * database host).
 */
export class DbRoleError extends Error {
  constructor(
    role: string,
    reason: 'no-bypass' | 'not-app-user-member' | 'privileged' = 'no-bypass'
  ) {
    super(
      reason === 'no-bypass'
        ? `Postgres role "${role}" cannot bypass row-level security. ` +
            'Set DB_USER to a role with BYPASSRLS (app_service, which the migrate step creates).'
        : reason === 'not-app-user-member'
          ? `Postgres role "${role}" is not a member of app_user, so it cannot run ` +
            'user requests under RLS. Grant it (GRANT app_user TO ' +
            `${role}) or set DB_USER to a role that is (app_service, which the migrate step creates).`
          : `Postgres role "${role}" is a superuser or owns tables, which the app must not ` +
            'connect as in production. Set DB_USER=app_service and DB_PASSWORD to APP_DB_PASSWORD; ' +
            'the migrate step (db/migrate-cli.ts) creates that role.'
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
 *
 * In production (`NODE_ENV=production`, or `production: true`) it also
 * refuses a superuser or a role that owns any relation in the database: the
 * app connects as `app_service`, which owns nothing, so it can neither alter
 * the schema nor reach the superuser's powers. Local dev connects as
 * `app_service` too; tests may use the owner.
 *
 * `requireAppUser: false` checks the bypass half only: the startup check
 * before migrations are verified, when `app_user` (created by the baseline)
 * may not exist yet.
 */
export async function assertBypassRole(
  db: Executor = adminDb,
  opts: { requireAppUser?: boolean; production?: boolean } = {}
): Promise<void> {
  const production = opts.production ?? env.NODE_ENV === 'production';
  const { rows } = await db.execute<{
    role: string;
    bypass: boolean | null;
    privileged: boolean | null;
    hasAppUser: boolean;
    member: boolean;
  }>(
    sql`select current_user as role,
      (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) as bypass,
      (select rolsuper from pg_roles where rolname = current_user)
        or exists (select 1 from pg_class
          where relowner = (select oid from pg_roles where rolname = current_user)) as privileged,
      exists (select 1 from pg_roles where rolname = 'app_user') as "hasAppUser",
      case when exists (select 1 from pg_roles where rolname = 'app_user')
        then pg_has_role(current_user, 'app_user', 'MEMBER') else false end as member`
  );
  const row = rows[0];
  const role = row?.role ?? env.DB_USER;
  if (!row?.bypass) throw new DbRoleError(role);
  if (production && row.privileged) throw new DbRoleError(role, 'privileged');
  if (opts.requireAppUser === false) return;
  if (!row.hasAppUser) throw new DbNotMigratedError();
  if (!row.member) throw new DbRoleError(role, 'not-app-user-member');
}

/**
 * What `pingDb` found: the database answered, or the error it failed with.
 * `latencyMs` is the round trip either way; `timedOut` marks a ping that gave
 * up after `timeoutMs` (its `error` is then a plain timeout Error).
 */
export type DbPing =
  | { ok: true; latencyMs: number }
  | { ok: false; latencyMs: number; error: unknown; timedOut?: true };

/** Anything `pingDb` can ask: the pool, or a stand-in in tests. */
export type Pingable = { query(text: string): Promise<unknown> };

/**
 * Ask Postgres `select 1`. The one database health check: readiness, the
 * admin Infrastructure page and the performance page all use it.
 *
 * Never throws: an unreachable database is `{ ok: false, error }`, so the
 * caller can log why (through `dbErrorForLog`) without a try/catch of its
 * own. With `timeoutMs`, a query that has not answered by then is reported
 * as `{ ok: false, timedOut: true }`; the query itself is left to the pool's
 * own timeouts (it cannot be cancelled from here).
 */
export async function pingDb(
  target: Pingable = pool,
  opts: { timeoutMs?: number } = {}
): Promise<DbPing> {
  const start = Date.now();
  const elapsed = () => Date.now() - start;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = target.query('select 1').then(() => 'answered' as const);
    const outcome =
      opts.timeoutMs === undefined
        ? await query
        : await Promise.race([
            query,
            new Promise<'timeout'>((resolve) => {
              timer = setTimeout(() => resolve('timeout'), opts.timeoutMs);
            }),
          ]);
    if (outcome === 'timeout') {
      return {
        ok: false,
        latencyMs: elapsed(),
        error: new Error(`select 1 did not answer within ${opts.timeoutMs} ms`),
        timedOut: true,
      };
    }
    return { ok: true, latencyMs: elapsed() };
  } catch (error) {
    return { ok: false, latencyMs: elapsed(), error };
  } finally {
    clearTimeout(timer);
  }
}
