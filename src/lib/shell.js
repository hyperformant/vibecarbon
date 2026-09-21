/**
 * Shell / SQL / YAML escaping helpers.
 *
 * All helpers produce values safe to paste into the corresponding sink.
 * None of them perform any validation — callers must validate input before
 * reaching a sink that a hostile value could corrupt.
 *
 * Dotenv reading and writing is NOT here: see src/lib/dotenv.js. `shEscape`
 * is for shell command lines only; a `.env` line written with it (`'it'\''s'`)
 * reads as `it` in Node, Docker Compose and Vite.
 */

/**
 * POSIX shell single-quote escape. Wraps value in single quotes and
 * handles embedded single quotes via close-reopen (`'\''`).
 */
export function shEscape(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Postgres SQL single-quote escape. Returns a complete SQL string literal
 * (including outer single quotes), ready to paste anywhere a SQL string
 * literal is expected.
 */
export function escapeSql(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * YAML-safe encoding via JSON string literal.
 */
export function escapeYaml(value) {
  return JSON.stringify(String(value));
}
