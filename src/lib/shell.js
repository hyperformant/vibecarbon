/**
 * Shell / dotenv / SQL / YAML escaping helpers.
 *
 * All helpers produce values safe to paste into the corresponding sink.
 * None of them perform any validation — callers must validate input before
 * reaching a sink that a hostile value could corrupt.
 */

/**
 * POSIX shell single-quote escape. Wraps value in single quotes and
 * handles embedded single quotes via close-reopen (`'\''`).
 */
export function shEscape(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Dotenv single-quoted form. Same encoding as shEscape — dotenv parsers
 * that support single-quoted values treat the content literally.
 *
 * NOTE: The output is valid for dotenv-package parsers that support
 * multi-line single-quoted values (e.g. the `dotenv` npm package).
 * It is NOT safe to `source` in bash if the value contains a literal
 * newline — bash single-quoted strings do not span lines the same way.
 */
export function escapeDotenv(value) {
  return shEscape(value);
}

/**
 * Decode a single value from its dotenv-on-disk form back to the raw
 * string we'd have passed to `escapeDotenv`. Handles the three shapes
 * we emit / accept:
 *
 *   - `'POSIX-single-quoted'` (escapeDotenv output, with `'\''` for embedded `'`)
 *   - `"double-quoted"` (legacy `.env` files; no escape-sequence interpretation)
 *   - bare unquoted (legacy `.env` files; treated as the literal value)
 *
 * Inverse of `escapeDotenv` for any string that didn't contain a literal newline
 * inside an unquoted value.
 */
export function unescapeDotenv(raw) {
  if (raw == null) return '';
  const v = String(raw);
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
    return v.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Parse the full text of a `.env`-style file into a flat key→value map,
 * decoding any escapeDotenv-quoted values back to their raw form.
 *
 * Single source of truth for dotenv parsing (project.js re-exports it).
 * Supports every shape we emit or accept:
 *   - Single-quoted values (escapeDotenv output), INCLUDING multi-line
 *     values — escapeDotenv preserves embedded newlines inside the quotes,
 *     so the parser must scan across lines to round-trip them
 *   - Legacy double-quoted values (old KEY="value" files; no escape
 *     interpretation)
 *   - Bare unquoted values (trailing ` # comment` stripped, whitespace
 *     trimmed)
 *   - Blank lines, `#` comments, and non-`KEY=VALUE` lines (e.g.
 *     `export FOO=bar`) are ignored
 *
 * The single-quoted branch is a tiny state machine that handles the `'\''`
 * close-reopen escape AND literal backslashes (which are not escape
 * characters in POSIX single-quoted strings).
 */
export function parseDotenv(text) {
  const out = {};
  if (!text) return out;
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    const rest = m[2];

    if (rest.startsWith("'")) {
      // Scan forward, possibly consuming more lines, until we find the
      // closing single-quote. The only "escape" in POSIX single-quoted
      // strings is the close-reopen trick: '\'' produces a literal '.
      let buf = rest.slice(1);
      const parts = [];
      let done = false;
      while (!done) {
        let pos = 0;
        while (pos < buf.length) {
          const ch = buf[pos];
          if (ch === "'") {
            // Check for close-reopen '\''
            if (buf.slice(pos, pos + 4) === "'\\''") {
              parts.push("'");
              pos += 4;
            } else {
              // Actual closing quote.
              done = true;
              break;
            }
          } else {
            parts.push(ch);
            pos += 1;
          }
        }
        if (done) break;
        // Exhausted this line without finding the close — consume the next.
        if (i + 1 >= lines.length) {
          // Malformed: unterminated single quote. Salvage what we have.
          done = true;
          break;
        }
        parts.push('\n');
        i += 1;
        buf = lines[i];
      }
      out[key] = parts.join('');
    } else if (rest.startsWith('"')) {
      // Legacy double-quoted. No escape handling (pre-C-8 files used simple "...").
      const closeIdx = rest.indexOf('"', 1);
      if (closeIdx !== -1) out[key] = rest.slice(1, closeIdx);
    } else {
      // Unquoted value — up to first whitespace-then-# or end of line.
      out[key] = rest.replace(/\s+#.*$/, '').trim();
    }
  }
  return out;
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
