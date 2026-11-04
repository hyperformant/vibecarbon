/**
 * Remote sentinels are whole stdout lines (src/lib/remote-sentinel.js).
 *
 * A failed command's message is `Command failed: <argv>\n<stderr>`
 * (src/lib/command.js), and over ssh the argv carries the remote script, so
 * the script's own `echo 'X_REFUSED ...'` sits inside it. An unanchored
 * search, or any search of the message, reads every failed exec (an ssh
 * drop, an exec killed with its container) as the script's refusal: the A3
 * stop said "nothing was stopped" while the postmaster was stopping.
 *
 * The census over src/:
 *   1. a sentinel string literal (`'FENCE_WRITTEN'`, `'FAILED '`) is never
 *      the argument of a substring search (`.includes`, `.endsWith`,
 *      `.indexOf`, `.lastIndexOf`, `.search`) on raw output; use
 *      hasSentinelLine / sentinelLinePayload / refusalFromError. A search
 *      over an array named `lines` (or `*Lines`) is a whole-line match and
 *      passes; `.startsWith` is anchored and passes;
 *   2. a regex literal naming a sentinel starts with `^` (with the `m` flag
 *      it is per line; without it, it can only match the text's first line,
 *      which in a failed command's message is `Command failed: ...`).
 *      Case-insensitive regexes are error-text classifiers, not sentinels
 *      (remote sentinels are exact upper case), and are out of scope;
 *   3. no sentinel check reads `.message`: the helpers' output argument, a
 *      sentinel regex's `.test`/`.exec` argument (inline or through the const
 *      it is bound to), and a sentinel search's statement never mention it;
 *   4. no `new RegExp(...)` builds a sentinel pattern (the helpers do it).
 * Each rule has a bite test below.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hasSentinelLine,
  outputLines,
  refusalFromError,
  sentinelLinePayload,
} from '../../../src/lib/remote-sentinel.js';
import { shJoin } from '../../../src/lib/shell.js';
import { CODE, findCalls, lex, matchBracket } from '../helpers/js-call-scan.js';

/** An ALL_CAPS token with an underscore: the shape of every remote sentinel. */
const TOKEN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;
/** A string literal that IS a sentinel (optionally followed by the space or `=` of a payload). */
const SENTINEL_LITERAL = /^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|(?!E[A-Z]+$)[A-Z]{4,})[ =]?$/;
const SEARCH_BEFORE = /(?:([\w$]+)\s*)?\.(?:includes|endsWith|indexOf|lastIndexOf|search)\(\s*$/;
const LINES_ARRAY = /^(?:lines|[\w$]*Lines)$/;

/**
 * Not remote sentinels, each with the reason. `file::text` of the literal.
 */
const ALLOWED: Record<string, string> = {
  // A list of GitHub variable NAMES, not command output.
  "src/lib/deploy/k8s/gitops-deploy.js::'TLS_CERT_ISSUER'":
    'names.includes over a variable-name list, not command output',
  // wal-archive.sh's failure log: tagged lines behind a timestamp prefix,
  // read from the log file's content, never a command's message.
  "src/lib/status/backup-health.js::'WAL_ARCHIVE_OVERWRITE_REFUSED'":
    'a log-file tag that follows a timestamp prefix',
  // AWS SDK / Node error codes on a local S3 client error, not a remote
  // script's output (the other S3 classifier is case-insensitive).
  'src/lib/providers/s3-base.js::/TimeoutError|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET/':
    'S3 client error codes on a local SDK error',
};

interface Literal {
  kind: 'string' | 'regex';
  start: number;
  end: number; // exclusive, after the closing delimiter (and flags for a regex)
  body: string;
  flags: string;
  raw: string;
}

/** Every string/template/regex literal in code, from the lexer's mask. */
function literals(text: string, mask: Uint8Array): Literal[] {
  const out: Literal[] = [];
  let i = 0;
  while (i < text.length) {
    if (mask[i] !== 2) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < text.length && mask[j] === 2) j += 1;
    const raw = text.slice(i, j);
    const open = raw[0];
    if (open === '/') {
      let k = j;
      while (k < text.length && /[a-z]/.test(text[k])) k += 1;
      const full = text.slice(i, k);
      const close = full.lastIndexOf('/');
      out.push({
        kind: 'regex',
        start: i,
        end: k,
        body: full.slice(1, close),
        flags: full.slice(close + 1),
        raw: full,
      });
    } else if (open === "'" || open === '"' || open === '`' || open === '}') {
      const body = raw.replace(/^['"`}]/, '').replace(/(?:['"`]|\$\{)$/, '');
      out.push({ kind: 'string', start: i, end: j, body, flags: '', raw });
    }
    i = j;
  }
  return out;
}

/** The statement around `at`: from the previous `;`/`{`/`}` in code to the next `;` or line end. */
function statementAround(text: string, mask: Uint8Array, at: number): string {
  let a = at;
  while (a > 0 && !(mask[a - 1] === CODE && /[;{}]/.test(text[a - 1]))) a -= 1;
  let b = at;
  while (b < text.length && !(mask[b] === CODE && /[;{]/.test(text[b]))) b += 1;
  return text.slice(a, b);
}

/** Violations of the four rules in one source text. */
function sentinelViolations(text: string, file = '<src>'): string[] {
  const { mask, errors } = lex(text);
  if (errors.length > 0) throw new Error(`${file}: cannot scan soundly: ${errors[0]}`);
  const lineOf = (at: number) => text.slice(0, at).split('\n').length;
  const bad: string[] = [];
  const codeMentionsMessage = (s: string) => /\bmessage\b/.test(s);

  for (const lit of literals(text, mask)) {
    const where = `${file}:${lineOf(lit.start)}`;
    if (lit.kind === 'string') {
      if (!SENTINEL_LITERAL.test(lit.body)) continue;
      const search = SEARCH_BEFORE.exec(text.slice(Math.max(0, lit.start - 60), lit.start));
      if (!search || LINES_ARRAY.test(search[1] ?? '')) continue;
      if (ALLOWED[`${file}::${lit.raw}`]) continue;
      bad.push(
        `${where} substring search for the sentinel ${lit.raw}; use hasSentinelLine/sentinelLinePayload`,
      );
      continue;
    }
    if (!TOKEN.test(lit.body) || lit.flags.includes('i') || ALLOWED[`${file}::${lit.raw}`]) {
      continue;
    }
    if (!lit.body.startsWith('^')) {
      bad.push(`${where} sentinel regex ${lit.raw} is not line-anchored (needs ^)`);
    }
    // Its argument, used inline (`/^X$/m.test(arg)`) or through its const.
    const after = text.slice(lit.end);
    const inline = /^\s*\.(?:test|exec)\s*\(/.exec(after);
    const args: string[] = [];
    if (inline) {
      const open = lit.end + inline[0].length - 1;
      args.push(text.slice(open, matchBracket(text, mask, open) + 1));
    }
    const bound = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(
      text.slice(Math.max(0, lit.start - 80), lit.start),
    );
    if (bound) {
      for (const m of text.matchAll(new RegExp(`\\b${bound[1]}\\s*\\.(?:test|exec)\\s*\\(`, 'g'))) {
        const open = (m.index ?? 0) + m[0].length - 1;
        if (mask[open] === CODE) args.push(text.slice(open, matchBracket(text, mask, open) + 1));
      }
      for (const m of text.matchAll(new RegExp(`\\.match(?:All)?\\s*\\(\\s*${bound[1]}\\b`, 'g'))) {
        args.push(statementAround(text, mask, m.index ?? 0));
      }
    }
    if (args.some(codeMentionsMessage)) {
      bad.push(`${where} sentinel regex ${lit.raw} is matched against a .message`);
    }
  }

  for (const call of findCalls(text, ['hasSentinelLine', 'sentinelLinePayload', 'outputLines'])) {
    if (codeMentionsMessage(call.args[0] ?? '')) {
      bad.push(`${file}:${call.line} ${call.name} reads a .message (${call.args[0]}); read stdout`);
    }
  }

  for (const m of text.matchAll(/\bnew\s+RegExp\s*\(/g)) {
    const at = m.index ?? 0;
    if (mask[at] !== CODE) continue;
    const open = at + m[0].length - 1;
    const call = text.slice(open, matchBracket(text, mask, open) + 1);
    if (
      TOKEN.test(call) &&
      /REFUSED|DONE|STAGED|SWAPPED|SKIPPED|WRITTEN|REMOVED|SENTINEL|_OK\b/.test(call)
    ) {
      bad.push(
        `${file}:${lineOf(at)} new RegExp builds a sentinel pattern; use the remote-sentinel helpers`,
      );
    }
  }
  return bad;
}

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

describe('remote sentinel census (src/)', () => {
  it('every sentinel is read as a whole stdout line, never from a .message', () => {
    const bad = srcFiles('src')
      .filter((f) => f !== join('src', 'lib', 'remote-sentinel.js'))
      .flatMap((f) => sentinelViolations(readFileSync(f, 'utf-8'), f));
    expect(bad).toEqual([]);
  });

  it('every allowlist entry still names a real literal in its file', () => {
    for (const key of Object.keys(ALLOWED)) {
      const [file, raw] = key.split('::');
      expect(readFileSync(file, 'utf-8'), key).toContain(raw);
    }
  });

  describe('bites', () => {
    it.each([
      ["if (out.includes('FENCE_WRITTEN')) ok();", /substring search/],
      ["return String(out ?? '').includes('FAILED ');", /substring search/],
      ['if (/RESEED_REFUSED busy/.test(out)) busy();', /not line-anchored/],
      ['if (/.*RESEED_REFUSED busy$/m.test(out)) busy();', /not line-anchored/],
      ["if (stdout.indexOf('X_DONE') >= 0) ok();", /substring search/],
      ["if (text.endsWith('READY')) ok();", /substring search/],
      [
        "if (/^RESEED_REFUSED busy$/m.test(String(error?.message ?? ''))) busy();",
        /against a .message/,
      ],
      [
        'const BUSY = /^RESEED_REFUSED busy$/m;\nfunction f(err) { return BUSY.test(err.message); }',
        /against a .message/,
      ],
      ['const r = sentinelLinePayload(error.message, "X_REFUSED");', /reads a .message/],
      [`const re = new RegExp(\`^.*\${STOP_REFUSED} (.*)$\`, "m");`, /new RegExp/],
    ])('%s is flagged', (src, re) => {
      expect(sentinelViolations(src).join('\n')).toMatch(re);
    });

    it.each([
      "if (hasSentinelLine(out, 'FENCE_WRITTEN')) ok();",
      "const role = /^WALG_ROLE_FILE=(.*)$/m.exec(String(out ?? ''))?.[1];",
      "const r = refusalFromError(error, 'RESEED_REFUSED', { status: 1 });",
      `if (lines.some((l) => l.startsWith(\`\${tag} \`))) x();`,
      "const begin = lines.indexOf('WALG_AUDIT_LIST_BEGIN');",
      "if (msg.includes('ETIMEDOUT')) retry();",
      'if (/ECONNRESET|EAI_AGAIN/i.test(err.message)) retry();',
    ])('%s passes', (src) => {
      expect(sentinelViolations(src)).toEqual([]);
    });
  });
});

describe('the helpers', () => {
  // A realistic rejected ssh exec (src/lib/command.js runCommandAsync shape):
  // its message quotes the remote script, sentinel text included.
  const script = "grep -q x f || { echo 'X_REFUSED no marker'; exit 3; }; echo X_DONE";
  const failed = (o: { status: number; stdout?: string; stderr?: string }) =>
    Object.assign(
      new Error(
        `Command failed: ssh -- root@10.0.0.2 ${shJoin(['sh', '-c', script])}\nX_REFUSED in stderr`,
      ),
      { stdout: o.stdout ?? '', stderr: o.stderr ?? '', status: o.status },
    );

  it('a message that quotes the script, empty stdout and a non-refusal status is never a refusal', () => {
    for (const status of [255, 137, 1, 3]) {
      expect(refusalFromError(failed({ status }), 'X_REFUSED', { status: 3 })).toBeNull();
    }
    expect(
      refusalFromError(failed({ status: 255, stdout: 'X_REFUSED no marker\n' }), 'X_REFUSED', {
        status: 3,
      }),
    ).toBeNull();
  });

  it('a stdout refusal line under the refusal status is the refusal', () => {
    expect(
      refusalFromError(
        failed({ status: 3, stdout: 'noise\nX_REFUSED no marker\r\n' }),
        'X_REFUSED',
        { status: 3 },
      ),
    ).toBe('no marker');
    // A stub error with no numeric status still reads stdout only.
    expect(refusalFromError({ stdout: 'X_REFUSED busy' }, 'X_REFUSED', { status: 1 })).toBe('busy');
    expect(refusalFromError({ message: 'X_REFUSED busy' }, 'X_REFUSED', { status: 1 })).toBeNull();
  });

  it('only a whole line is a sentinel', () => {
    expect(hasSentinelLine('a\n  X_DONE \n', 'X_DONE')).toBe(true);
    expect(hasSentinelLine('+ echo X_DONE', 'X_DONE')).toBe(false);
    expect(hasSentinelLine('NOT_X_DONE', 'X_DONE')).toBe(false);
    expect(hasSentinelLine(false, 'X_DONE')).toBe(false);
    expect(hasSentinelLine(null, 'X_DONE')).toBe(false);
    expect(sentinelLinePayload('FAILED app\n', 'FAILED')).toBe('app');
    expect(sentinelLinePayload('NOT FAILED app', 'FAILED')).toBeNull();
    expect(outputLines(undefined)).toEqual([]);
  });
});
