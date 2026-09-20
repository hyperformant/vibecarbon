/**
 * Repair for lines the old writer produced. Before 2026-09-20 the CLI wrote
 * user-supplied values with the POSIX shell quoting `'it'\''s'`; Node, Docker
 * Compose and Vite all read that as `it`, truncating the secret. Only lines
 * containing the `'\''` sequence are touched — a plain `'value'` is already
 * read identically everywhere. Pure text in, text out; callers own the I/O.
 */
import { dotenvValueProblem, formatDotenvLine } from './dotenv.js';

const LEGACY_LINE = /^([A-Za-z_][A-Za-z0-9_]*)='(.*)'\s*$/;

/**
 * @param {string} text
 * @returns {{ text: string, healed: string[], skipped: Array<{ key: string, reason: string }> }}
 */
export function healLegacyDotenvText(text) {
  const healed = [];
  const skipped = [];
  const lines = String(text).split('\n');
  const out = lines.map((line) => {
    if (!line.includes("'\\''")) return line;
    const m = line.match(LEGACY_LINE);
    if (!m) return line;
    const [, key, body] = m;
    const value = body.replace(/'\\''/g, "'");
    const problem = dotenvValueProblem(key, value);
    if (problem) {
      skipped.push({ key, reason: problem });
      return line;
    }
    healed.push(key);
    return formatDotenvLine(key, value);
  });
  return { text: out.join('\n'), healed, skipped };
}
