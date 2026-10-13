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
  return out;
}

/** The message to show a developer for `err`, without SQL or params. */
export function dbErrorMessage(err: unknown): string | undefined {
  const safe = dbErrorForLog(err);
  return safe !== err ? (safe as DbErrorLog).message : undefined;
}
