/**
 * Database errors, made safe to log.
 *
 * Drizzle wraps every failed statement in a `DrizzleQueryError` whose message
 * is `Failed query: <sql>\nparams: <values>`, and keeps the SQL and the bound
 * values on `.query` / `.params`. The values are whatever the route passed in:
 * emails, unsubscribe and confirmation tokens, user ids. The Postgres error
 * underneath (`.cause`) carries `detail` (`Key (email)=(a@b.c) already
 * exists`) and `where` (the statement context), which can hold them too.
 *
 * `dbErrorForLog(err)` keeps what you need to debug (SQLSTATE code,
 * constraint, table, column, and the Postgres message) and drops the rest.
 * Use it wherever a caught error may have come from the database:
 *
 *   logger.error({ err: dbErrorForLog(err) }, 'Failed to save theme');
 *
 * The logger runs it on every `err` / `error` field as well (lib/logger.ts),
 * so a site that forgets still cannot write params to the log. Never log
 * `err.message` of a database error as a plain string: that copy is out of
 * the serializer's reach.
 */

/** What a database error looks like in a log line. */
export interface DbErrorLog {
  type: 'DatabaseError';
  message: string;
  code?: string;
  constraint?: string;
  table?: string;
  column?: string;
  /** The wrapping error's own message, when the db error is its cause. */
  context?: string;
}

type QueryError = Error & { query: string; params: unknown[] };
type PgError = Error & {
  severity?: string;
  code?: string;
  constraint?: string;
  table?: string;
  column?: string;
};

/** Drizzle's wrapper: carries the SQL text and the bound values. */
function isQueryError(value: unknown): value is QueryError {
  return (
    value instanceof Error &&
    typeof (value as Partial<QueryError>).query === 'string' &&
    Array.isArray((value as Partial<QueryError>).params)
  );
}

/** node-postgres' server error (pg-protocol DatabaseError). */
function isPgError(value: unknown): value is PgError {
  return (
    value instanceof Error &&
    typeof (value as PgError).code === 'string' &&
    'severity' in value &&
    'detail' in value
  );
}

/** First database error in `err`'s cause chain (itself included), if any. */
function findDbError(err: unknown): QueryError | PgError | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (isQueryError(current) || isPgError(current)) return current;
    current = current.cause;
  }
  return undefined;
}

function pick(source: object, key: 'code' | 'constraint' | 'table' | 'column') {
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * A log-safe stand-in for `err` when it is (or wraps) a database error;
 * `err` itself otherwise, so the logger's normal error serializer applies.
 */
export function dbErrorForLog(err: unknown): DbErrorLog | unknown {
  const found = findDbError(err);
  if (!found) return err;
  // For a Drizzle wrapper the useful error is the cause: a Postgres error, or
  // the network error that stopped the query (ECONNREFUSED, a timeout).
  const source: unknown = isQueryError(found) ? found.cause : found;
  const out: DbErrorLog = {
    type: 'DatabaseError',
    message: source instanceof Error ? source.message : 'Database query failed',
  };
  if (source instanceof Error) {
    for (const key of ['code', 'constraint', 'table', 'column'] as const) {
      const value = pick(source, key);
      if (value) out[key] = value;
    }
  }
  // A wrapper such as new Error('Failed to fetch customer', { cause }) keeps
  // its context, unless its message embeds Drizzle's (SQL and params).
  if (found !== err && err instanceof Error && !/Failed query|params:/.test(err.message)) {
    out.context = err.message;
  }
  return out;
}

/** The message to show a developer for `err`, without SQL or params. */
export function dbErrorMessage(err: unknown): string | undefined {
  const safe = dbErrorForLog(err);
  return safe !== err ? (safe as DbErrorLog).message : undefined;
}

// Connection loss only: the database went away or refused us. These are a
// dependency wait (the db container restarting, a failover), not a failure:
// startup, the admin bootstrap and the migrate step all wait them out. Node
// errno codes for the socket, SQLSTATE class 08 (connection exception) and
// 57P01-03 (admin/crash shutdown, cannot connect now).
const CONNECTION_ERRNO = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);
const CONNECTION_SQLSTATE = new Set(['57P01', '57P02', '57P03']);

/**
 * True when an error is the connection to Postgres dropping or being
 * refused. Looks through Drizzle's (and Better Auth's) `cause` wrapping.
 * Lives here, not in startup.ts, so the migrate step (migrate-cli.ts) can use
 * it without loading the app's env and pool.
 */
export function isConnectionLoss(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (CONNECTION_ERRNO.has(code) || CONNECTION_SQLSTATE.has(code) || code.startsWith('08')) {
        return true;
      }
    } else if (/^Connection terminated/.test(current.message)) {
      // node-pg raises "Connection terminated (unexpectedly)" with no code at
      // all when the server closes the socket mid-query. Matched only when
      // there is no code, as the same dependency wait as the codes above.
      return true;
    }
    current = current.cause;
  }
  return false;
}
