/**
 * Repair for lines the old writer produced. Before 2026-09-20 the CLI wrote
 * user-supplied values with the POSIX shell quoting `'it'\''s'`; Node, Docker
 * Compose and Vite all read that as `it`, truncating the secret. Only lines
 * containing the `'\''` sequence are touched — a plain `'value'` is already
 * read identically everywhere.
 *
 * `healLegacyDotenvText` is pure (text in, text out). `healLegacyDotenvQuoting`
 * applies it to a project's `.env` and `.env.local` and is what every command
 * that READS those files runs at entry (configure, deploy, scale, upgrade —
 * via project.js's `repairLegacyEnvQuoting`), because a truncated value read
 * before the repair is acted on: configure's Enter-to-keep would write the
 * truncated string back over the recoverable line, and deploy's k8s path
 * would ship it as the Secret. `hasLegacyDotenvQuoting` is the read-only
 * detector for `status`, which never writes.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dotenvValueProblem, formatDotenvLine } from './dotenv.js';

/** The old writer's escaping of a single quote inside a `'…'` value. */
const LEGACY_QUOTE = "'\\''";
const LEGACY_LINE = /^([A-Za-z_][A-Za-z0-9_]*)='(.*)'\s*$/;
const KEY_PREFIX = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/** The two project env files the repair covers, in read order. */
const PROJECT_ENV_FILES = ['.env', '.env.local'];

/**
 * @param {string} text
 * @returns {{ text: string, healed: string[], skipped: Array<{ key: string, reason: string }> }}
 */
export function healLegacyDotenvText(text) {
  const healed = [];
  const skipped = [];
  const lines = String(text).split('\n');
  const out = lines.map((line) => {
    if (!line.includes(LEGACY_QUOTE)) return line;
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

/**
 * Keys of every `KEY=` line that still carries the old `'\''` sequence, in
 * file order — the read-only counterpart of `healLegacyDotenvText` for a
 * caller that must not write (`status`). Deliberately wider than the healer's
 * own match: a line the healer would skip (a refused body) is still a value
 * every reader truncates, so it is still worth naming.
 * @param {string} text
 * @returns {string[]}
 */
export function hasLegacyDotenvQuoting(text) {
  const keys = [];
  for (const line of String(text).split('\n')) {
    if (!line.includes(LEGACY_QUOTE)) continue;
    const m = line.match(KEY_PREFIX);
    if (m) keys.push(m[1]);
  }
  return keys;
}

/**
 * Apply `healLegacyDotenvText` to the project's `.env` and `.env.local`
 * (missing files skipped), writing each file back only when a line changed.
 * `dryRun` computes and reports the same result without touching either file
 * (`upgrade -dry`). The file mode is preserved: `writeFileSync` on an existing
 * path keeps it, so a 0600 `.env.local` stays 0600.
 * @param {string} cwd
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {{ healed: string[], skipped: Array<{ key: string, reason: string }> }}
 */
export function healLegacyDotenvQuoting(cwd, { dryRun = false } = {}) {
  const healed = [];
  const skipped = [];
  for (const name of PROJECT_ENV_FILES) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    const before = readFileSync(path, 'utf-8');
    const result = healLegacyDotenvText(before);
    if (!dryRun && result.text !== before) writeFileSync(path, result.text);
    healed.push(...result.healed);
    skipped.push(...result.skipped);
  }
  return { healed, skipped };
}
