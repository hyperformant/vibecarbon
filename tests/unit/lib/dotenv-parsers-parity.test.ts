/**
 * One dotenv parser (review residual, PR #112).
 *
 * `parseDotenv` (src/lib/shell.js, re-exported by src/lib/project.js) is the
 * codebase's canonical dotenv reader. Until this sweep three more readers
 * duplicated it with slightly different quoting rules — the k8s path's
 * `loadEnvLocal` (k3s.js), gitops' `parseEnvLocal` (gitops-deploy.js) and the
 * per-key regex `getEnvValue` in up.js (mirrored in status.js's
 * `getPortConfig`); `readReplPassword` (deploy/utils.js) carried a fourth,
 * quoted-forms-only regex. Every one of them now delegates to `parseDotenv`.
 *
 * Two halves:
 *
 *   1. PARITY — the pre-consolidation bodies are reproduced VERBATIM below
 *      (from commit 8d5b93c, with only the readFileSync step lifted out so
 *      they take text) and run against one fixture next to `parseDotenv`.
 *      Where they agreed, the test asserts the agreement; where they
 *      disagreed, the test pins `parseDotenv`'s behaviour and names the
 *      legacy behaviour it replaces, so the choice is on record rather than
 *      implicit. `parseDotenv` is the TOLERANT parser: where it was the
 *      strict outlier (CRLF files dropped wholesale; indented keys and
 *      `KEY = value` ignored) the parser was widened to what the replaced
 *      readers accepted, not pinned.
 *
 *   2. CENSUS — a source-shape sweep over src/ that fails when any function
 *      other than `parseDotenv` reads a `.env*` file and then splits it on
 *      newlines or regex-matches `KEY=` lines out of it. The two in-place
 *      line REWRITERS (bundle.js's override merge, utils.js's remote merge)
 *      keep their own line loops on purpose and are allow-listed by exact
 *      path with the reason; an allow-list entry that stops matching fails
 *      the census too, so the list cannot rot.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDotenv } from '../../../src/lib/shell.js';

// ---------------------------------------------------------------------------
// Legacy bodies (8d5b93c), text-in instead of path-in.
// ---------------------------------------------------------------------------

/** src/lib/deploy/k8s/k3s.js loadEnvLocal — the loop after readFileSync. */
function legacyLoadEnvLocal(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** src/lib/deploy/k8s/gitops-deploy.js parseEnvLocal — the loop after readFileSync. */
function legacyParseEnvLocal(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(.*))\s*$/);
    if (!m) continue;
    const [, key, dq, sq, rest] = m;
    out[key] = dq ?? sq ?? rest ?? '';
  }
  return out;
}

/** src/up.js getEnvValue (and status.js getPortConfig's inner getEnvValue) — the per-key regex. */
function legacyGetEnvValue(content: string, key: string): string | null {
  const match = content.match(new RegExp(`^${key}=["']?([^"'\\n]+)["']?`, 'm'));
  return match ? match[1] : null;
}

/** src/lib/deploy/utils.js readReplPassword — the two quoted-form regexes. */
function legacyReadReplPassword(content: string): string | null {
  const m =
    content.match(/^REPL_PASSWORD="([^"]+)"/m) || content.match(/^REPL_PASSWORD='([^']+)'/m);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Fixture: one line per case the brief names, plus the quoting edge each
// legacy reader handled differently.
// ---------------------------------------------------------------------------

const FIXTURE = `${[
  'UNQUOTED=plain',
  'DQ_SPACES="has spaces here"',
  "SQ='single quoted'",
  'export EXPORTED=1',
  'EMPTY=',
  '# a comment line',
  'INLINE=value # trailing comment',
  'EQUALS=a=b=c',
  'DQ_EQ="x=y"',
  'PAD_VALUE=  spaced  ',
  '  INDENTED=indented',
  'SPACED_EQ = around',
  'lower=nope',
  "SQ_HASH='a # b'",
  'DQ_HASH="a # b"',
  'REPL_PASSWORD=unquoted-pass',
].join('\n')}\n`;

describe('dotenv parser parity — parseDotenv vs the readers it replaced', () => {
  const canonical = parseDotenv(FIXTURE);
  const k3s = legacyLoadEnvLocal(FIXTURE);
  const gitops = legacyParseEnvLocal(FIXTURE);

  it('agrees with every legacy reader on the plain cases', () => {
    for (const key of ['UNQUOTED', 'DQ_SPACES', 'SQ', 'EQUALS', 'DQ_EQ', 'SQ_HASH', 'DQ_HASH']) {
      expect(canonical[key], key).toBe(k3s[key]);
      expect(canonical[key], key).toBe(gitops[key]);
      expect(canonical[key], key).toBe(legacyGetEnvValue(FIXTURE, key));
    }
    expect(canonical).toMatchObject({
      UNQUOTED: 'plain',
      DQ_SPACES: 'has spaces here',
      SQ: 'single quoted',
      EQUALS: 'a=b=c',
      DQ_EQ: 'x=y',
      SQ_HASH: 'a # b',
      DQ_HASH: 'a # b',
    });
  });

  it('skips `#` comment lines like every legacy reader did', () => {
    expect(Object.keys(canonical).some((k) => k.startsWith('#'))).toBe(false);
    expect(Object.keys(k3s).some((k) => k.startsWith('#'))).toBe(false);
  });

  it('`KEY=` (empty) is the empty string, as k3s/gitops had it; up.js returned null, which every call site folds with `||`', () => {
    expect(canonical.EMPTY).toBe('');
    expect(k3s.EMPTY).toBe('');
    expect(gitops.EMPTY).toBe('');
    // Legacy up.js: `[^"'\n]+` needs one character, so an empty value was a
    // miss (null) and the lookup fell through to the next file. The
    // consolidated getEnvValue keeps that fall-through by treating '' as
    // absent — see up.js.
    expect(legacyGetEnvValue(FIXTURE, 'EMPTY')).toBeNull();
  });

  // DIFFERENCE 1 — `export KEY=value`: parseDotenv reads it as KEY (the
  // dotenv package's behaviour; fix round, controller ruling: the shared
  // parser is the TOLERANT one). gitops ignored the line; the k3s reader
  // produced a junk key named "export EXPORTED" nobody read.
  it('DIFFERENCE 1: an `export KEY=value` line reads as KEY (gitops ignored it, k3s kept a junk "export KEY" entry)', () => {
    expect(canonical.EXPORTED).toBe('1');
    expect(canonical['export EXPORTED']).toBeUndefined();
    expect(gitops.EXPORTED).toBeUndefined();
    expect(gitops['export EXPORTED']).toBeUndefined();
    expect(k3s['export EXPORTED']).toBe('1'); // the legacy quirk, on record
  });

  // DIFFERENCE 2 — an unquoted value followed by ` # comment`: parseDotenv
  // strips the comment (the dotenv convention; quoted values keep their
  // `#`); every legacy reader kept the comment as part of the value.
  it('DIFFERENCE 2: an inline ` # comment` after an unquoted value is stripped (legacy readers kept it)', () => {
    expect(canonical.INLINE).toBe('value');
    expect(k3s.INLINE).toBe('value # trailing comment');
    expect(gitops.INLINE).toBe('value # trailing comment');
    expect(legacyGetEnvValue(FIXTURE, 'INLINE')).toBe('value # trailing comment');
    // Inside quotes a `#` is data for everyone.
    expect(canonical.SQ_HASH).toBe('a # b');
    expect(canonical.DQ_HASH).toBe('a # b');
  });

  // DIFFERENCE 3 — whitespace around an unquoted VALUE is trimmed
  // (parseDotenv, k3s). gitops kept the trailing run, up.js kept both ends.
  it('DIFFERENCE 3: whitespace around an unquoted value is trimmed (gitops kept trailing, up.js kept both)', () => {
    expect(canonical.PAD_VALUE).toBe('spaced');
    expect(k3s.PAD_VALUE).toBe('spaced');
    expect(gitops.PAD_VALUE).toBe('spaced  ');
    expect(legacyGetEnvValue(FIXTURE, 'PAD_VALUE')).toBe('  spaced  ');
  });

  // AGREEMENT (fix round) — an indented key, or spaces around `=`: both
  // replaced readers tolerated the padding, and a hand-edited `.env.local`
  // with `HETZNER_API_TOKEN = …` must not silently lose the key on k8s.
  // parseDotenv now accepts leading whitespace and whitespace around `=`
  // (controller ruling: the shared parser is the tolerant one, not the
  // strictest); a quoted value after `KEY = ` still reaches the quote
  // scanners.
  it('an indented key or `KEY = value` reads its value, as k3s/gitops did', () => {
    expect(canonical.INDENTED).toBe('indented');
    expect(canonical.SPACED_EQ).toBe('around');
    expect(k3s.INDENTED).toBe('indented');
    expect(k3s.SPACED_EQ).toBe('around');
    expect(gitops.INDENTED).toBe('indented');
    expect(gitops.SPACED_EQ).toBe('around');
    expect(parseDotenv("  K = 'it'\\''s'\n")).toEqual({ K: "it's" }); // escapeDotenv's '\'' form
    expect(parseDotenv('K = \'a # b\'\nD = "x y"  \n')).toEqual({ K: 'a # b', D: 'x y' });
    expect(parseDotenv("export K = 'multi\nline'\n")).toEqual({ K: 'multi\nline' });
  });

  // DIFFERENCE 5 — lowercase keys: ignored (parseDotenv, gitops); k3s read
  // them. No consumer of these readers ever asked for a lowercase key.
  it('DIFFERENCE 5: a lowercase key is ignored (k3s used to read it)', () => {
    expect(canonical.lower).toBeUndefined();
    expect(gitops.lower).toBeUndefined();
    expect(k3s.lower).toBe('nope');
  });

  // DIFFERENCE 6 — readReplPassword only ever matched a QUOTED value. The
  // consolidated reader takes any form parseDotenv reads; create.js writes
  // the value quoted, so the accepted set only grew.
  it('DIFFERENCE 6: REPL_PASSWORD is read in any dotenv form (legacy regex needed quotes)', () => {
    expect(canonical.REPL_PASSWORD).toBe('unquoted-pass');
    expect(legacyReadReplPassword(FIXTURE)).toBeNull();
    for (const quoted of ['REPL_PASSWORD="q-pass"\n', "REPL_PASSWORD='q-pass'\n"]) {
      expect(parseDotenv(quoted).REPL_PASSWORD).toBe('q-pass');
      expect(legacyReadReplPassword(quoted)).toBe('q-pass');
    }
  });

  // FIXED IN THE PARSER, not pinned — parseDotenv's `split('\n')` left a
  // `\r` on every line of a CRLF file, and its `KEY=(.*)$` regex (where `.`
  // excludes `\r`) then matched none of them: a Windows-edited .env.local
  // parsed as EMPTY. k3s (trim) and gitops (`\r?\n`) both handled CRLF, so
  // routing them through parseDotenv would have regressed both. The parser
  // now splits on `\r?\n`; a CRLF file reads exactly like its LF twin.
  it('CRLF line endings read exactly like LF (parseDotenv fixed to match k3s/gitops)', () => {
    const lf = 'A=1\nB="two words"\nC=\'three\'\nD=x # c\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(parseDotenv(crlf)).toEqual(parseDotenv(lf));
    expect(parseDotenv(crlf)).toEqual({ A: '1', B: 'two words', C: 'three', D: 'x' });
    expect(legacyLoadEnvLocal(crlf)).toMatchObject({ A: '1', B: 'two words', C: 'three' });
    expect(legacyParseEnvLocal(crlf)).toMatchObject({ A: '1', B: 'two words', C: 'three' });
    // A multi-line single-quoted value (escapeDotenv output) in a CRLF file
    // comes back LF-normalized — the same text escapeDotenv would emit.
    expect(parseDotenv("M='line1\r\nline2'\r\n").M).toBe('line1\nline2');
  });
});

// ---------------------------------------------------------------------------
// Census — no second dotenv reader in src/.
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

/**
 * Sites that read a `.env*` file and walk its lines WITHOUT parsing it —
 * in-place rewriters that must preserve every untouched line (comments,
 * blank lines, key order) byte for byte, which a parse-then-serialize
 * cannot. Exact file AND exact flagged line, so the entry covers one loop,
 * not a whole module (utils.js also holds a value READER, readReplPassword,
 * which must stay on parseDotenv); each carries its reason and must still
 * match.
 */
const REWRITER_ALLOWLIST: Array<{ file: string; text: string; reason: string }> = [
  {
    file: 'lib/deploy/bundle.js',
    text: "const lines = envContent.split('\\n');",
    reason:
      'renderBundle merges envOverrides into the staged .env LINE BY LINE so untouched lines ship ' +
      'verbatim (comments, order); it never reads a value out of the file',
  },
  {
    file: 'lib/deploy/utils.js',
    text: "const existing = readFileSync(local, 'utf-8').split('\\n');",
    reason:
      'mergeRemoteDotenv rewrites matching KEY= lines of the pulled remote .env in place and appends ' +
      'the rest — same rewriter shape as bundle.js, no value is read out',
  },
];

const isAllowListed = (h: Hit) =>
  REWRITER_ALLOWLIST.some((entry) => entry.file === h.file && entry.text === h.text);

/** How far after an env-file readFileSync a line loop / KEY= match still counts as parsing it. */
const READ_WINDOW = 60;
/** How far before the readFileSync a `.env` mention still marks the read as an env-file read. */
const PATH_WINDOW = 10;

function jsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return jsFiles(full);
    return entry.endsWith('.js') ? [full] : [];
  });
}

/** Blank out comments (keeping newlines) so a doc example cannot trip the sweep. */
function stripComments(src: string): string {
  const keepNewlines = (m: string) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*(?:(?!\*\/)[^\n])*\*\//g, keepNewlines)
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, keepNewlines)
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? '' : line))
    .join('\n');
}

const NEWLINE_SPLIT = /\.split\((?:'\\n'|"\\n"|\/\\r\?\\n\/|\/\\n\/)\)/;
/** A `KEY=`-shaped regex fed to .match()/.exec()/matchAll() or built with new RegExp — a READ, not a .test()/.replace() rewrite. */
const KEY_MATCH = /\.(?:match|matchAll|exec)\(\s*(?:\/\^[^/]*=|new RegExp\()/;

type Hit = { file: string; line: number; text: string };

/**
 * Every `readFileSync` of an env file whose text is then line-split or
 * KEY=-matched by the same function — i.e. a second dotenv parser.
 */
function findDotenvReaders(): Hit[] {
  const hits: Hit[] = [];
  for (const file of jsFiles(SRC)) {
    const rel = relative(SRC, file);
    const lines = stripComments(readFileSync(file, 'utf-8')).split('\n');
    lines.forEach((line, idx) => {
      const call = line.match(
        /(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)?\s*=?[^=\n]*?readFileSync\(([^)]*)\)/,
      );
      if (!call) return;
      if (!line.includes('readFileSync(')) return;
      const arg = call[2] ?? '';
      const before = lines.slice(Math.max(0, idx - PATH_WINDOW), idx + 1).join('\n');
      const envish = /env/i.test(arg) || before.includes('.env');
      if (!envish) return;

      // Chained on the read itself: readFileSync(...).split('\n') / .match(...)
      const after = line.slice(line.indexOf('readFileSync('));
      if (NEWLINE_SPLIT.test(after) || KEY_MATCH.test(after)) {
        hits.push({ file: rel, line: idx + 1, text: line.trim() });
        return;
      }
      // Assigned, then split/matched later in the window.
      const assign = line.match(
        /(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*(?:[^;]*?\?\s*)?readFileSync\(/,
      );
      const name = assign?.[1];
      if (!name) return;
      const window = lines.slice(idx + 1, idx + 1 + READ_WINDOW);
      for (let j = 0; j < window.length; j++) {
        const later = window[j];
        const uses = new RegExp(`\\b${name}\\b`).test(later);
        if (!uses) continue;
        const splitsIt = new RegExp(`\\b${name}\\s*${NEWLINE_SPLIT.source}`).test(later);
        const matchesIt = new RegExp(`\\b${name}\\s*${KEY_MATCH.source}`).test(later);
        if (splitsIt || matchesIt) {
          hits.push({ file: rel, line: idx + 1 + j + 1, text: later.trim() });
          return;
        }
      }
    });
  }
  return hits;
}

describe('census — parseDotenv is the only dotenv reader in src/', () => {
  const hits = findDotenvReaders();

  it('no function other than parseDotenv splits a .env* file into lines or matches KEY= out of it', () => {
    const offenders = hits.filter((h) => !isAllowListed(h));
    expect(
      offenders.map((h) => `src/${h.file}:${h.line}  ${h.text}`),
      'route these through parseDotenv (src/lib/shell.js) — or, for an in-place line REWRITER, add an exact-path entry to REWRITER_ALLOWLIST with the reason',
    ).toEqual([]);
  });

  it('every REWRITER_ALLOWLIST entry still matches a real line loop (the list cannot rot)', () => {
    for (const entry of REWRITER_ALLOWLIST) {
      expect(
        hits.some((h) => h.file === entry.file && h.text === entry.text),
        `${entry.file} is allow-listed for \`${entry.text}\` but that line no longer walks an env file — drop or update the entry`,
      ).toBe(true);
    }
  });
});
