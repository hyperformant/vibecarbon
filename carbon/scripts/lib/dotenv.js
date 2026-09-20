/**
 * The one dotenv dialect.
 *
 * Every `.env*` file vibecarbon writes must be read identically by three
 * parsers we do not all control: Node's `util.parseEnv` (the CLI, the
 * template's scripts, `tsx --env-file`), Docker Compose (`env_file` and
 * `${…}` interpolation on the server) and Vite's dotenv + dotenv-expand
 * (`import.meta.env.VITE_*`). This module reads with `util.parseEnv` and
 * writes only the intersection those parsers agree on. Anything outside the
 * intersection is refused with a reason that never echoes the value.
 *
 * This file is copied byte-for-byte to carbon/scripts/lib/dotenv.js (template
 * projects cannot import the CLI); tests/unit/lib/dotenv.test.ts enforces the
 * lockstep. Keep it dependency-free: node:fs, node:path, node:util only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

const BARE = /^[A-Za-z0-9_./:@+=,%-]*$/;
// Every control character except \n (which the double-quoted form escapes).
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching literal control bytes is the point, a value with one cannot round-trip through .env.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;

export class DotenvValueError extends Error {
  /**
   * @param {string} key
   * @param {string} reason
   */
  constructor(key, reason) {
    super(`${key} cannot be stored in a .env file: ${reason}`);
    this.name = 'DotenvValueError';
    this.key = key;
    this.reason = reason;
  }
}

/**
 * Parse dotenv text with Node's parser. Empty/undefined text is `{}`.
 * @param {string | undefined | null} text
 * @returns {Record<string, string>}
 */
export function parseDotenv(text) {
  if (!text) return {};
  return parseEnv(String(text));
}

/**
 * `.env` then `.env.local` layered (local wins); a missing file contributes
 * nothing. The shell environment is NOT merged here — callers decide whether
 * the shell or the file wins.
 * @param {string} dir
 * @returns {Record<string, string>}
 */
export function readEnvFiles(dir) {
  const merged = {};
  for (const name of ['.env', '.env.local']) {
    const path = join(dir, name);
    if (existsSync(path)) Object.assign(merged, parseDotenv(readFileSync(path, 'utf-8')));
  }
  return merged;
}

/**
 * Why `value` cannot be written portably, or null when it can. The reason is
 * safe to show a user: it names character classes, never the value.
 * @param {string} key
 * @param {unknown} value
 * @returns {string | null}
 */
export function dotenvValueProblem(key, value) {
  const v = String(value);
  if (CONTROL.test(v)) return 'it contains a control character (tab or carriage return)';
  if (BARE.test(v)) return null;
  const hasSingle = v.includes("'");
  const hasDouble = v.includes('"');
  const hasBackslash = v.includes('\\');
  const hasDollar = v.includes('$');
  const hasNewline = v.includes('\n');
  if (!hasDouble && !hasBackslash && !hasDollar) return null;
  if (hasDollar && key.startsWith('VITE_')) {
    return 'it contains "$", which Vite expands as a variable reference in client-visible (VITE_*) values';
  }
  if (!hasSingle && !hasNewline) return null;
  const others = [hasDouble && '"', hasBackslash && '\\', hasDollar && '$']
    .filter(Boolean)
    .join(' ');
  const left = [hasSingle && 'a single quote', hasNewline && 'a newline']
    .filter(Boolean)
    .join(' or ');
  return `it mixes ${left} with ${others}; no .env syntax that Node, Docker Compose and Vite all read the same way can hold that`;
}

/**
 * Encode a value in the portable grammar: bare, then "double-quoted" (real
 * newline → \n), then 'single-quoted'. Throws DotenvValueError otherwise.
 * @param {string} key
 * @param {unknown} value
 * @returns {string}
 */
export function encodeDotenvValue(key, value) {
  const problem = dotenvValueProblem(key, value);
  if (problem) throw new DotenvValueError(key, problem);
  const v = String(value);
  if (BARE.test(v)) return v;
  if (!v.includes('"') && !v.includes('\\') && !v.includes('$'))
    return `"${v.replace(/\n/g, '\\n')}"`;
  return `'${v}'`;
}

/**
 * @param {string} key
 * @param {unknown} value
 * @returns {string}
 */
export function formatDotenvLine(key, value) {
  return `${key}=${encodeDotenvValue(key, value)}`;
}
