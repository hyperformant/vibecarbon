/**
 * Small adapters between what Postgres hands back through Drizzle and what
 * the API has always sent.
 */

/**
 * A `timestamptz` read in `mode: 'string'` arrives in Postgres text form
 * (`2026-10-13 09:30:00.123456+00`). The API has always sent the JSON form
 * (`2026-10-13T09:30:00.123456+00:00`), which every browser's `Date` parses.
 * Convert one to the other without touching precision.
 */
export function isoTimestamp(value: string): string;
export function isoTimestamp(value: string | null): string | null;
export function isoTimestamp(value: string | null): string | null {
  if (value == null) return value;
  return value.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00');
}

/**
 * The SQLSTATE of a failed query (`23505` for a unique violation), or
 * undefined. Drizzle wraps the driver's error, so look through `cause`.
 */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True for a string Postgres will accept as a uuid. Ids from a URL or query
 * string are checked first so a malformed one reads as "not found" rather
 * than as a database error.
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
