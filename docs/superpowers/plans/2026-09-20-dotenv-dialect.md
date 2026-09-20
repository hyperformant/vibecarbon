# One dotenv dialect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `.env*` file vibecarbon writes is read identically by Node `util.parseEnv`, Docker Compose, and Vite; every process we control reads through `util.parseEnv`; values that cannot be represented are refused at the prompt.

**Architecture:** One dependency-free module (`src/lib/dotenv.js`, byte-identical copy at `carbon/scripts/lib/dotenv.js`) owns parsing (`util.parseEnv`) and the portable writer grammar. The CLI's old state-machine parser and POSIX writer are deleted; every caller moves to the new module. `upgrade` and `setEnvVar` repair the legacy `'\''` lines. Oracle tests (Node, dotenv, dotenv-expand, `docker compose config`) and a census make the invariant enumerable.

**Tech Stack:** Node ≥ 24.15 (`node:util` `parseEnv`), vitest, biome, `dotenv` + `dotenv-expand` as root devDependencies (oracle only), Docker Compose (docker test tier).

**Spec:** `docs/superpowers/specs/2026-09-20-dotenv-dialect-design.md`

## Global Constraints

- Writer grammar, in order: bare when `/^[A-Za-z0-9_./:@+=,%-]*$/`; else double-quoted (real newline → `\n`) when the value has none of `"` `\` `$`; else single-quoted when it has no `'` and no newline; else refuse. Also refuse any control character other than `\n`, and refuse `$` in `VITE_*` values. Error messages name the key and the reason, **never the value**.
- No file outside `src/lib/dotenv.js` / `carbon/scripts/lib/dotenv.js` may call `parseEnv(` or match `KEY=` against `.env` text (exception: `src/lib/deploy/bundle.js` rewriter loop, which must emit lines with `formatDotenvLine`).
- `src/lib/dotenv.js` and `carbon/scripts/lib/dotenv.js` are byte-identical.
- The identifiers `escapeDotenv`, `decodeDotenvValue`, `unescapeDotenv` cease to exist in `src/`, `carbon/`, `tests/`, `scripts/`.
- `pnpm lint` 0 warnings; `pnpm test:unit`, `pnpm test:cli`, `pnpm test:template` green; pre-commit hook passes on its own (never `--no-verify`).
- Commit with pathspecs (`git commit -- <files>`); conventional prefixes; no `!:`/BREAKING footers — a `Compatibility:` paragraph in the body instead. Never print a real secret value in any output or test fixture (fixtures are synthetic).
- Node floor stays `>=24.15` in both `package.json` engines fields; do not add runtime dependencies.

---

### Task 1: The dotenv module (CLI + template copy) with oracle tests

**Files:**
- Create: `src/lib/dotenv.js`
- Create: `carbon/scripts/lib/dotenv.js` (identical bytes)
- Create: `tests/unit/lib/dotenv.test.ts`
- Create: `tests/unit/lib/dotenv-oracle.test.ts`
- Modify: `package.json` (root devDependencies: `dotenv`, `dotenv-expand`), `pnpm-lock.yaml`

**Interfaces (Produces):**
```js
export class DotenvValueError extends Error { key: string; reason: string }
export function parseDotenv(text: string | undefined): Record<string, string>
export function readEnvFiles(dir: string): Record<string, string>   // .env then .env.local layered; missing skipped
export function dotenvValueProblem(key: string, value: unknown): string | null
export function encodeDotenvValue(key: string, value: unknown): string  // throws DotenvValueError
export function formatDotenvLine(key: string, value: unknown): string   // `${key}=${encodeDotenvValue(key, value)}`
```

- [ ] **Step 1: Write the failing unit test** `tests/unit/lib/dotenv.test.ts`

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DotenvValueError,
  dotenvValueProblem,
  encodeDotenvValue,
  formatDotenvLine,
  parseDotenv,
  readEnvFiles,
} from '../../../src/lib/dotenv.js';

describe('encodeDotenvValue grammar', () => {
  it('emits bare values for the safe alphabet', () => {
    expect(encodeDotenvValue('K', '')).toBe('');
    expect(encodeDotenvValue('K', 'abc+/=')).toBe('abc+/=');
    expect(encodeDotenvValue('K', 'https://x.y:8443/z@v,1%')).toBe('https://x.y:8443/z@v,1%');
    expect(encodeDotenvValue('K', 'eyJ.abc.def-_')).toBe('eyJ.abc.def-_');
  });
  it('double-quotes spaces, #, single quotes, unicode and newlines', () => {
    expect(encodeDotenvValue('K', 'with space')).toBe('"with space"');
    expect(encodeDotenvValue('K', 'has#hash')).toBe('"has#hash"');
    expect(encodeDotenvValue('K', "it's")).toBe('"it\'s"');
    expect(encodeDotenvValue('K', 'émoji ✓')).toBe('"émoji ✓"');
    expect(encodeDotenvValue('K', 'line1\nline2')).toBe('"line1\\nline2"');
    expect(encodeDotenvValue('K', ' lead and trail ')).toBe('" lead and trail "');
    expect(encodeDotenvValue('K', 'semi;colon*star!bang?q&amp')).toBe('"semi;colon*star!bang?q&amp"');
  });
  it('single-quotes values holding ", backslash or $', () => {
    expect(encodeDotenvValue('K', 'say "hi"')).toBe("'say \"hi\"'");
    expect(encodeDotenvValue('K', 'back\\slash')).toBe("'back\\slash'");
    expect(encodeDotenvValue('K', 'cost $5 and ${X}')).toBe("'cost $5 and ${X}'");
  });
  it('refuses the unrepresentable, naming key and reason but never the value', () => {
    const cases: Array<[string, string, RegExp]> = [
      ['PW', `both ' and "`, /single quote/],
      ['PW', "quote ' and $X", /single quote/],
      ['PW', 'nl\nand "q"', /newline/],
      ['PW', 'tab\there', /control character/],
      ['PW', 'cr\r', /control character/],
      ['VITE_PUBLIC_URL', 'https://x/$y', /Vite/],
    ];
    for (const [key, value, reason] of cases) {
      expect(dotenvValueProblem(key, value)).toMatch(reason);
      let err: unknown;
      try {
        encodeDotenvValue(key, value);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(DotenvValueError);
      expect((err as DotenvValueError).key).toBe(key);
      expect((err as Error).message).toContain(key);
      expect((err as Error).message).not.toContain(value);
    }
  });
  it('accepts every representable value with a null problem', () => {
    expect(dotenvValueProblem('K', "it's")).toBeNull();
    expect(dotenvValueProblem('K', 'a $b')).toBeNull();
    expect(dotenvValueProblem('K', 42)).toBeNull();
  });
  it('formatDotenvLine joins key and encoded value', () => {
    expect(formatDotenvLine('A', 'x y')).toBe('A="x y"');
  });
});

describe('parseDotenv / readEnvFiles', () => {
  it('parses through util.parseEnv semantics', () => {
    const text = 'export A=1\n# c\nB="two words"\nC=\'lit $X\'\nD=bare # comment\n\nE=\n';
    expect(parseDotenv(text)).toEqual({ A: '1', B: 'two words', C: 'lit $X', D: 'bare', E: '' });
    expect(parseDotenv('')).toEqual({});
    expect(parseDotenv(undefined)).toEqual({});
  });
  it('round-trips everything the encoder accepts', () => {
    const values = ['', 'plain', 'with space', 'has#hash', "it's", 'say "hi"', 'back\\slash', 'a $b ${c}', 'l1\nl2', 'é ✓', ' pad '];
    const text = values.map((v, i) => formatDotenvLine(`K${i}`, v)).join('\n');
    const parsed = parseDotenv(text);
    values.forEach((v, i) => expect(parsed[`K${i}`]).toBe(v));
  });
  it('layers .env.local over .env and skips missing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dotenv-'));
    expect(readEnvFiles(dir)).toEqual({});
    writeFileSync(join(dir, '.env'), 'A=1\nB=from-env\n');
    writeFileSync(join(dir, '.env.local'), 'B=from-local\nC=3\n');
    expect(readEnvFiles(dir)).toEqual({ A: '1', B: 'from-local', C: '3' });
  });
});

describe('template copy is byte-identical', () => {
  it('carbon/scripts/lib/dotenv.js === src/lib/dotenv.js', async () => {
    const { readFileSync } = await import('node:fs');
    const root = join(import.meta.dirname, '..', '..', '..');
    expect(readFileSync(join(root, 'carbon/scripts/lib/dotenv.js'), 'utf-8')).toBe(
      readFileSync(join(root, 'src/lib/dotenv.js'), 'utf-8'),
    );
  });
});
```

- [ ] **Step 2: Run it, expect failure** — `pnpm vitest run tests/unit/lib/dotenv.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write the module** `src/lib/dotenv.js`

```js
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
  const others = [hasDouble && '"', hasBackslash && '\\', hasDollar && '$'].filter(Boolean).join(' ');
  const left = [hasSingle && 'a single quote', hasNewline && 'a newline'].filter(Boolean).join(' or ');
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
  if (!v.includes('"') && !v.includes('\\') && !v.includes('$')) return `"${v.replace(/\n/g, '\\n')}"`;
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
```

Then `cp src/lib/dotenv.js carbon/scripts/lib/dotenv.js`.

- [ ] **Step 4: Run the test, expect pass.** If `parseDotenv` of `D=bare # comment` does not yield `bare` under the installed Node, record the actual behaviour in the test with a comment (the writer never emits a bare `#`; the assertion documents Node's rule) — do not change the module.

- [ ] **Step 5: Add oracle devDependencies and the oracle test**

`pnpm add -D -w dotenv dotenv-expand` (root only; check `carbon/package.json` is untouched).

`tests/unit/lib/dotenv-oracle.test.ts`:

```ts
import { parseEnv } from 'node:util';
import { parse as dotenvParse } from 'dotenv';
import { expand } from 'dotenv-expand';
import { describe, expect, it } from 'vitest';
import { dotenvValueProblem, formatDotenvLine } from '../../../src/lib/dotenv.js';

// Synthetic values only. Every accepted value must read back identically from
// Node, dotenv and dotenv-expand; refused values must be refused. The Compose
// leg of the same oracle lives in tests/integration/docker/dotenv-compose-oracle.test.ts.
export const ORACLE_VALUES: Record<string, string> = {
  EMPTY: '',
  PLAIN: 'plain',
  BASE64: 'YWJj+/==',
  JWT: 'eyJhbGciOi.eyJpc3Mi.SflKxwRJ-_',
  URL: 'https://x.example:8443/p?a=1&b=2#frag',
  SPACES: 'with two  spaces',
  HASH: 'abc#def',
  SINGLE: "it's",
  DOUBLE: 'say "hi"',
  BACKSLASH: 'back\\slash\\n',
  DOLLAR: 'cost $5, $HOME and ${HOME} stay literal',
  NEWLINE: 'line1\nline2\n',
  PEM: '-----BEGIN X-----\nabc\ndef==\n-----END X-----\n',
  UNICODE: 'émoji ✓ 日本',
  PUNCT: 'semi;colon*star!bang?q&amp|pipe<gt>~tilde^caret(paren)[br]{brace}',
  BACKTICK: 'tick `x` tick',
  EQUALS: 'a=b=c',
  LEAD_TRAIL: '  padded  ',
  COMMENTISH: ' # not a comment',
};

export const REFUSED_VALUES: Record<string, string> = {
  MIXED_QUOTES: `both ' and "`,
  QUOTE_DOLLAR: "quote ' and $X",
  NEWLINE_DOUBLE: 'nl\nand "q"',
  TAB: 'tab\there',
  CR: 'cr\r\n',
  VITE_DOLLAR: 'https://x/$y',
};

const text = Object.entries(ORACLE_VALUES)
  .map(([k, v]) => formatDotenvLine(k, v))
  .join('\n');

describe('dotenv oracle: Node, dotenv, dotenv-expand read the writer identically', () => {
  it('util.parseEnv', () => {
    expect(parseEnv(text)).toEqual(ORACLE_VALUES);
  });
  it('dotenv.parse', () => {
    expect(dotenvParse(text)).toEqual(ORACLE_VALUES);
  });
  it('dotenv-expand (what Vite applies)', () => {
    // Vite reads only VITE_* keys, where the writer refuses "$". Under any
    // other key dotenv-expand still expands "$HOME"; that key is excluded
    // here and the divergence is the documented reason for the refusal.
    const { DOLLAR: _skip, ...viteVisible } = ORACLE_VALUES;
    const parsed = dotenvParse(text);
    const expanded = expand({ parsed: { ...parsed }, processEnv: {} }).parsed ?? {};
    for (const [k, v] of Object.entries(viteVisible)) expect(expanded[k]).toBe(v);
  });
  it('refuses the unrepresentable set', () => {
    for (const [k, v] of Object.entries(REFUSED_VALUES)) {
      const key = k === 'VITE_DOLLAR' ? 'VITE_PUBLIC_URL' : k;
      expect(dotenvValueProblem(key, v), k).not.toBeNull();
    }
  });
});
```

Run `pnpm vitest run tests/unit/lib/dotenv-oracle.test.ts` → PASS. If the `HASH` (`abc#def`, double-quoted) or `COMMENTISH` case fails under any parser, that is a real grammar hole: report it as BLOCKED with the parser and observed value rather than weakening the fixture.

- [ ] **Step 6: Lint and commit**

```bash
pnpm lint
git add src/lib/dotenv.js carbon/scripts/lib/dotenv.js tests/unit/lib/dotenv.test.ts tests/unit/lib/dotenv-oracle.test.ts package.json pnpm-lock.yaml
git commit -- src/lib/dotenv.js carbon/scripts/lib/dotenv.js tests/unit/lib/dotenv.test.ts tests/unit/lib/dotenv-oracle.test.ts package.json pnpm-lock.yaml -m "feat(dotenv): one dotenv module — util.parseEnv reader and the portable writer grammar

Bare / double-quoted / single-quoted in that order, refusing values no
parser set (Node, Compose, Vite) reads the same way. Oracle test pins
Node, dotenv and dotenv-expand against the writer. Identical copy for
the template at carbon/scripts/lib/dotenv.js (lockstep-tested)."
```

---

### Task 2: Legacy-quoting repair (pure helper + `upgrade` hook)

**Files:**
- Create: `src/lib/dotenv-heal.js`
- Modify: `src/upgrade.js` (next to `healShortVaultEncKey`, ~line 177-187)
- Create: `tests/unit/lib/dotenv-heal.test.ts`

**Interfaces (Produces):**
```js
export function healLegacyDotenvText(text: string): { text: string; healed: string[]; skipped: Array<{ key: string; reason: string }> }
export function healLegacyDotenvQuoting(cwd: string): { healed: string[]; skipped: Array<{ key: string; reason: string }> }  // in upgrade.js, touches .env and .env.local
```

- [ ] **Step 1: Failing test** `tests/unit/lib/dotenv-heal.test.ts`

```ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDotenv } from '../../../src/lib/dotenv.js';
import { healLegacyDotenvText } from '../../../src/lib/dotenv-heal.js';
import { healLegacyDotenvQuoting } from '../../../src/upgrade.js';

describe('healLegacyDotenvText', () => {
  it("re-encodes POSIX '\\'' lines and leaves everything else byte-identical", () => {
    const input = [
      '# header',
      "PLAIN='fine as is'",
      "PW='it'\\''s'",
      'GEN="abc"',
      "TOKEN='a $b'",
      '',
    ].join('\n');
    const { text, healed, skipped } = healLegacyDotenvText(input);
    expect(healed).toEqual(['PW']);
    expect(skipped).toEqual([]);
    expect(text.split('\n')[2]).toBe('PW="it\'s"');
    expect(text.split('\n').filter((_, i) => i !== 2)).toEqual(input.split('\n').filter((_, i) => i !== 2));
    expect(parseDotenv(text).PW).toBe("it's");
  });
  it('skips a legacy value the new grammar refuses, naming the key', () => {
    const { text, healed, skipped } = healLegacyDotenvText(`PW='mix '\\'' and "'\n`);
    expect(healed).toEqual([]);
    expect(skipped).toEqual([{ key: 'PW', reason: expect.stringMatching(/single quote/) }]);
    expect(text).toBe(`PW='mix '\\'' and "'\n`);
  });
  it('is a no-op on already-portable text', () => {
    const input = 'A=1\nB="x y"\nC=\'$z\'\n';
    expect(healLegacyDotenvText(input)).toEqual({ text: input, healed: [], skipped: [] });
  });
});

describe('healLegacyDotenvQuoting (upgrade hook)', () => {
  it('rewrites .env and .env.local in place and reports per file', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'legacy-'));
    writeFileSync(join(cwd, '.env'), "A='x'\\''y'\n");
    writeFileSync(join(cwd, '.env.local'), "B='ok'\n");
    const result = healLegacyDotenvQuoting(cwd);
    expect(result.healed).toEqual(['A']);
    expect(readFileSync(join(cwd, '.env'), 'utf-8')).toBe('A="x\'y"\n');
    expect(readFileSync(join(cwd, '.env.local'), 'utf-8')).toBe("B='ok'\n");
  });
});
```

- [ ] **Step 2: Run → FAIL** (`dotenv-heal.js` missing; `healLegacyDotenvQuoting` not exported).

- [ ] **Step 3: Implement** `src/lib/dotenv-heal.js`

```js
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
```

In `src/upgrade.js`, add after `healShortVaultEncKey`:

```js
/**
 * Re-encode `.env` / `.env.local` lines written with the pre-2026-09-20 POSIX
 * quoting (`'it'\''s'`), which Node, Compose and Vite all truncate. Runs
 * before the env is read so the reconstructed variables see the real value.
 * @param {string} cwd
 * @returns {{ healed: string[], skipped: Array<{ key: string, reason: string }> }}
 */
export function healLegacyDotenvQuoting(cwd) {
  const healed = [];
  const skipped = [];
  for (const name of ['.env', '.env.local']) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    const before = readFileSync(path, 'utf-8');
    const result = healLegacyDotenvText(before);
    if (result.text !== before) writeFileSync(path, result.text);
    healed.push(...result.healed);
    skipped.push(...result.skipped);
  }
  return { healed, skipped };
}
```

Call it in `reconstructVariables` right before `healShortVaultEncKey(cwd)`; where `upgrade` prints its summary, log `healed.length` keys re-encoded (names only) and one warning per `skipped` entry: `${key}: ${reason} — re-enter it with \`vibecarbon configure\``. Import `healLegacyDotenvText` from `./lib/dotenv-heal.js`; ensure `existsSync`, `readFileSync`, `writeFileSync`, `join` are imported (check the file's existing imports).

- [ ] **Step 4: Run → PASS.** Also `pnpm vitest run tests/unit --reporter=dot` to catch upgrade tests pinning output.

- [ ] **Step 5: Commit**

```bash
pnpm lint
git commit -- src/lib/dotenv-heal.js src/upgrade.js tests/unit/lib/dotenv-heal.test.ts -m "fix(upgrade): re-encode legacy POSIX-quoted .env values that every parser truncated"
```

---

### Task 3: Move the CLI onto the module (readers, writers, prompt-time refusal)

**Files:**
- Modify: `src/lib/shell.js` (delete `parseDotenv`, `escapeDotenv`, `decodeDotenvValue`/`unescapeDotenv` and their JSDoc; keep `shEscape`)
- Modify: `src/lib/project.js` (`serializeDotenv`, `setEnvVar`, `readProjectEnvFiles`, the `export { parseDotenv }` re-export, imports)
- Modify: `src/lib/deploy/bundle.js` (rewriter emits with `formatDotenvLine`; comment updated to reference the census file `tests/unit/lib/dotenv-dialect-census.test.ts`)
- Modify: `src/create.js` (`generateEnvLocal` ~1545-1600: every `KEY="${x}"` and `KEY=${escapeDotenv(x)}` line becomes `${formatDotenvLine('KEY', x)}`; the admin-password prompt at ~599 gains `validate`)
- Modify: every other importer of `parseDotenv`/`escapeDotenv`: `src/lib/config.js`, `src/lib/deploy/compose/build-args.js`, `src/lib/deploy/compose/index.js`, `src/lib/deploy/k8s/gitops-deploy.js`, `src/lib/deploy/k8s/k3s.js`, `src/lib/deploy/utils.js`, `src/scale.js`, `src/status.js`, `src/up.js`, `src/configure.js` (`promptText`/`promptSecret` validate), `src/lib/{linode,vultr,scaleway}-guided-setup.js` (their prompts), `tests/e2e/utils/e2e-env-file.js`
- Modify tests that pin the old grammar: `tests/unit/lib/shell.test.ts` (drop escapeDotenv/parseDotenv cases), `tests/unit/security/dotenv-roundtrip.test.ts` (round-trip via `formatDotenvLine`/`parseDotenv` from `src/lib/dotenv.js`; the "legacy double-quoted" case becomes "the three forms"), `tests/unit/deploy/bundle-env-overrides.test.ts`, `bundle-operator-secret-strip.test.ts`, `compose-admin-credentials.test.ts`, `tests/unit/iac/build-env.test.ts`, `tests/unit/lib/credential-key-convention.test.ts`, `tests/unit/lib/env-docs-census.test.ts`, `tests/unit/lib/operator-env-census.test.ts`, `tests/unit/e2e/*.test.ts`, `tests/integration/template/create.test.ts` — update imports and expected line shapes (`KEY='x'` → whatever the grammar emits for that fixture).
- Delete: `tests/unit/lib/dotenv-parsers-parity.test.ts` (replaced in Task 6).

**Interfaces (Consumes):** Task 1 module; Task 2 `healLegacyDotenvText`.

- [ ] **Step 1: Failing tests for `setEnvVar`** — add to `tests/unit/lib/dotenv-setenv.test.ts` (new):

```ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DotenvValueError, parseDotenv } from '../../../src/lib/dotenv.js';
import { setEnvVar } from '../../../src/lib/project.js';

function project(env: string, local: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'setenv-'));
  writeFileSync(join(cwd, '.env'), env);
  writeFileSync(join(cwd, '.env.local'), local);
  return cwd;
}

describe('setEnvVar writes the portable grammar', () => {
  it('replaces bare, double-quoted and single-quoted existing lines', () => {
    const cwd = project('A=1\nB="two"\nC=\'$3\'\n', '');
    setEnvVar('A', 'x y', cwd);
    setEnvVar('B', 'say "hi"', cwd);
    setEnvVar('C', 'bare', cwd);
    const env = readFileSync(join(cwd, '.env'), 'utf-8');
    expect(env).toBe('A="x y"\nB=\'say "hi"\'\nC=bare\n');
    expect(parseDotenv(env)).toEqual({ A: 'x y', B: 'say "hi"', C: 'bare' });
  });
  it('appends when the key is absent and keeps other lines verbatim', () => {
    const cwd = project('# keep\nA=1\n', '');
    setEnvVar('NEW', "it's", cwd);
    expect(readFileSync(join(cwd, '.env'), 'utf-8')).toBe('# keep\nA=1\nNEW="it\'s"\n');
  });
  it("repairs legacy '\\'' lines in the file it touches", () => {
    const cwd = project("OLD='a'\\''b'\nA=1\n", '');
    setEnvVar('A', '2', cwd);
    expect(parseDotenv(readFileSync(join(cwd, '.env'), 'utf-8'))).toEqual({ OLD: "a'b", A: '2' });
  });
  it('refuses an unrepresentable value before writing anything', () => {
    const cwd = project('A=1\n', 'A=1\n');
    expect(() => setEnvVar('A', `mix ' and "`, cwd)).toThrow(DotenvValueError);
    expect(readFileSync(join(cwd, '.env'), 'utf-8')).toBe('A=1\n');
    expect(readFileSync(join(cwd, '.env.local'), 'utf-8')).toBe('A=1\n');
  });
  it('localOnly creates .env.local and leaves .env alone', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'setenv-'));
    writeFileSync(join(cwd, '.env'), 'A=1\n');
    setEnvVar('T', 'tok', cwd, { localOnly: true });
    expect(readFileSync(join(cwd, '.env'), 'utf-8')).toBe('A=1\n');
    expect(parseDotenv(readFileSync(join(cwd, '.env.local'), 'utf-8'))).toEqual({ T: 'tok' });
  });
});
```

- [ ] **Step 2: Run → FAIL** (bare line not replaced; legacy not healed; no refusal).

- [ ] **Step 3: Rewrite `setEnvVar` and `serializeDotenv`** in `src/lib/project.js`

```js
import { formatDotenvLine, parseDotenv, readEnvFiles } from './dotenv.js';
import { healLegacyDotenvText } from './dotenv-heal.js';
export { parseDotenv };

/** Serialize a key-value object into dotenv lines in the portable grammar. */
export function serializeDotenv(obj) {
  return `${Object.entries(obj)
    .map(([k, v]) => formatDotenvLine(k, v))
    .join('\n')}\n`;
}

export function setEnvVar(key, value, cwd = process.cwd(), { localOnly = false } = {}) {
  // Encode first: an unrepresentable value must not touch either file.
  const replacement = formatDotenvLine(key, value);
  const envFiles = localOnly ? ['.env.local'] : ['.env.local', '.env'];
  for (const filename of envFiles) {
    const envPath = join(cwd, filename);
    if (!existsSync(envPath)) {
      if (localOnly && filename === '.env.local') {
        writeSecretFile(envPath, '# Local-only environment overrides (not committed to git)\n');
      } else {
        continue;
      }
    }
    // Repair pre-2026-09-20 POSIX-quoted lines on the way through so an
    // un-upgraded project is fixed the first time configure touches it.
    const content = healLegacyDotenvText(readFileSync(envPath, 'utf-8')).text;
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      writeFileSync(envPath, content.replace(regex, () => replacement));
    } else {
      writeFileSync(envPath, `${content.trimEnd()}\n${replacement}\n`);
    }
  }
}
```

(`content.replace(regex, () => replacement)` — the function form so `$` in the replacement is literal.) Replace the body of `readProjectEnvFiles(cwd)` with `return readEnvFiles(cwd);` (keep the export name; `status.js`/deploy import it). Remove the `serializeDotenv`-style duplicate at ~line 297 by routing it through `formatDotenvLine` too.

- [ ] **Step 4: Delete the old functions from `shell.js`**, then `pnpm lint` — biome/import errors list every remaining caller. Fix each: `parseDotenv` → `import { parseDotenv } from '<rel>/lib/dotenv.js'` (or from `project.js` where already imported); `escapeDotenv(v)` in a `KEY=${…}` template → `formatDotenvLine('KEY', v)`; object-driven writers → `serializeDotenv`. In `bundle.js`: `return formatDotenvLine(m[1], envOverrides[m[1]])` and `merged.push(formatDotenvLine(k, v))`; update the comment to name `tests/unit/lib/dotenv-dialect-census.test.ts`.

- [ ] **Step 5: `create.js` `generateEnvLocal`** — convert every value-bearing line in the template string to `${formatDotenvLine('KEY', value)}`; comments and blank lines stay. Run `pnpm test:template -- create.test.ts` afterwards; adjust expectations that pinned `KEY="…"` to the grammar's output (generated secrets are base64/JWT → bare).

- [ ] **Step 6: Prompt-time refusal.** In `src/configure.js` `promptText`/`promptSecret`, inside the existing `validate` callback (after normalization, before the shape check):

```js
const problem = entry ? dotenvValueProblem(entry.key, normalized) : null;
if (problem) return `${entry.key} ${problem}`;
```

For prompts without an `entry`, find the key the prompt writes and pass it (or add `key` to the options). Apply the same to `src/create.js`'s admin-password `p.password({ validate })` with key `ADMIN_PASSWORD`, and to each prompt in `src/lib/{linode,vultr,scaleway}-guided-setup.js` that ends in `setEnvVar`. Add an integration test in `tests/integration/cli/` only if one already drives `configure` prompts non-interactively; otherwise a unit test that calls the exported validate helper with `mix ' and "` and expects the message. Every path also gets the throw from `setEnvVar` as a backstop; make sure `src/cli.js`'s top-level error handler prints `DotenvValueError.message` without a stack (check how it prints other user errors and match).

- [ ] **Step 7: Fix pinned tests, run tiers**

`pnpm test:unit && pnpm test:cli && pnpm test:template`. Delete `tests/unit/lib/dotenv-parsers-parity.test.ts` (its census is rebuilt in Task 6). Any test that asserted `KEY='value'` for a plain value now expects the bare/double form the grammar emits; do not weaken assertions to regexes that accept both.

- [ ] **Step 8: Commit**

```bash
pnpm lint
git add -A src tests
git commit -- src tests -m "refactor(dotenv): every CLI read and write goes through src/lib/dotenv.js

shell.js loses parseDotenv/escapeDotenv/decodeDotenvValue; setEnvVar
replaces whole lines, heals legacy quoting and refuses unrepresentable
values before writing; configure/create/guided-setup prompts refuse at
the prompt with the reason (never the value).

Compatibility: files written by this CLI parse identically under older
CLIs (bare, double- and single-quoted forms were all accepted). Files
written by older CLIs are repaired by vibecarbon upgrade or the next
configure."
```

(Check `git status` first; stage only files this task changed — the shared checkout may hold another session's edits.)

---

### Task 4: Template scripts and Vite config read through `scripts/lib/dotenv.js`

**Files:**
- Modify: `carbon/scripts/dev.js` (~24-40), `carbon/scripts/docker-up.js` (~20-45), `carbon/scripts/generate-rss.ts` (~29-55), `carbon/scripts/generate-seo.ts` (~70-100), `carbon/scripts/generate-sitemap.ts` (~36-45), `carbon/scripts/dev-init.js` (env writer, ~59-146), `carbon/vite.config.ts` (~21-24)
- Modify: `carbon/.env.example` header (3 lines on quoting)
- Test: `tests/integration/template/dev-script.test.ts` (extend), `tests/integration/template/dotenv-scripts.test.ts` (new)

**Interfaces (Consumes):** `carbon/scripts/lib/dotenv.js` → `readEnvFiles(dir)`, `parseDotenv`, `formatDotenvLine`.

- [ ] **Step 1: Failing test** `tests/integration/template/dotenv-scripts.test.ts`

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const carbon = join(import.meta.dirname, '..', '..', '..', 'carbon');
const readers = [
  'scripts/dev.js',
  'scripts/docker-up.js',
  'scripts/generate-rss.ts',
  'scripts/generate-seo.ts',
  'scripts/generate-sitemap.ts',
  'vite.config.ts',
];

describe('template scripts read .env through scripts/lib/dotenv.js', () => {
  for (const file of readers) {
    it(`${file} imports the shared reader and owns no regex over .env text`, () => {
      const src = readFileSync(join(carbon, file), 'utf-8');
      expect(src).toMatch(/from '\.\.?\/(scripts\/)?lib\/dotenv\.js'/);
      expect(src).not.toMatch(/\[\^"'\\n\]|\["'\]\?\(|loadEnv\(/);
    });
  }
  it('dev-init.js writes env lines with formatDotenvLine', () => {
    const src = readFileSync(join(carbon, 'scripts/dev-init.js'), 'utf-8');
    expect(src).toContain('formatDotenvLine');
    expect(src).not.toMatch(/^[A-Z_]+="\$\{/m);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** In each reader replace the regex helper with:

```js
import { readEnvFiles } from './lib/dotenv.js';           // dev.js, docker-up.js, generate-*.ts (adjust path)
const fileEnv = readEnvFiles(rootDir);                     // rootDir = the project root each script already computes
const getEnvValue = (key) => process.env[key] ?? fileEnv[key] ?? null;   // shell wins, then .env.local over .env
```

`generate-*.ts` currently read only `.env.local`; they now get the layered read (a `.env`-only `VITE_PUBLIC_URL` was previously invisible to them — that is the fix). `vite.config.ts`: drop `loadEnv` from the import, `const env = { ...readEnvFiles(path.resolve(import.meta.dirname)), ...process.env };` (Vite still loads `import.meta.env.VITE_*` itself). `dev-init.js`: build each `KEY=value` line of the generated file with `formatDotenvLine(key, value)`; fixed comment lines stay in the template string.

`carbon/.env.example` header, after the existing intro:

```
# Quoting: values are read by Node (util.parseEnv), Docker Compose and Vite.
# Plain letters/digits/._/:@+=,%- need no quotes; wrap anything with spaces,
# '#' or a single quote in double quotes; wrap ", \ or $ in single quotes.
# vibecarbon configure writes this form for you.
```

- [ ] **Step 4: Run** `pnpm test:template` and the template's own checks the tier runs (`lint-build.test.ts` covers `tsc`/biome for carbon). Also run `node carbon/scripts/docker-up.js --help 2>/dev/null || true` only if the script has a dry mode; otherwise rely on the tier.

- [ ] **Step 5: Commit**

```bash
git commit -- carbon/scripts carbon/vite.config.ts carbon/.env.example tests/integration/template/dotenv-scripts.test.ts tests/integration/template/dev-script.test.ts -m "fix(template): scripts and vite.config read .env through scripts/lib/dotenv.js

Replaces four hand-rolled regex readers (which stopped at the first
quote) and Vite's loadEnv on the config side with util.parseEnv via the
shared module; dev-init.js writes env lines with the same grammar."
```

---

### Task 5: Harness and scripts read through the module

**Files:**
- Modify: `tests/e2e/sweep-project.ts` (~30-40), `tests/e2e/runner.ts` (wherever `tests/.env.e2e` is read — follow `loadE2EEnvFile` in `tests/e2e/utils/e2e-env-file.js`, which already uses `parseDotenv` via `project.js`; switch its import to `src/lib/dotenv.js`), `scripts/iter-step.js` (`setupE2EEnv` → uses `loadE2EEnvFile` or `parseDotenv`)
- Test: `tests/unit/e2e/e2e-env-file.test.ts` (imports only)

- [ ] **Step 1:** In `sweep-project.ts` replace the `for (const line of readFileSync(envFile).split('\n'))` loop with `const fileEnv = existsSync(envFile) ? parseDotenv(readFileSync(envFile, 'utf-8')) : {};` and read `HETZNER_API_TOKEN` from `process.env` then `fileEnv`. In `iter-step.js` and `runner.ts` confirm the read goes through `loadE2EEnvFile`; if either has its own loop, route it through `parseDotenv` from `../src/lib/dotenv.js` / `../../src/lib/dotenv.js`.
- [ ] **Step 2:** `pnpm test:unit -- tests/unit/e2e` → PASS; `node --check scripts/iter-step.js`; `pnpm exec tsx --tsconfig tsconfig.e2e.json -e "import('./tests/e2e/sweep-project.ts')"` is NOT run (it would sweep); `pnpm exec tsc -p tsconfig.e2e.json --noEmit` instead if that config exists.
- [ ] **Step 3: Commit** `git commit -- tests/e2e scripts/iter-step.js tests/unit/e2e -m "refactor(e2e): harness reads tests/.env.e2e through src/lib/dotenv.js"`

---

### Task 6: Census, Compose oracle, AGENTS.md note

**Files:**
- Create: `tests/unit/lib/dotenv-dialect-census.test.ts`
- Create: `tests/integration/docker/dotenv-compose-oracle.test.ts`
- Modify: `AGENTS.md` (one paragraph under the testing/architecture section that describes env files)

- [ ] **Step 1: Census test**

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..');
const ROOTS = ['src', 'carbon/scripts', 'carbon/vite.config.ts', 'scripts', 'tests'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'results', 'fixtures']);
const MODULES = new Set(['src/lib/dotenv.js', 'carbon/scripts/lib/dotenv.js']);
const SELF = 'tests/unit/lib/dotenv-dialect-census.test.ts';
// bundle.js rewrites an existing .env line by line so comments and order ship
// verbatim; it emits every line it changes with formatDotenvLine.
const REWRITER = 'src/lib/deploy/bundle.js';

function walk(p: string, out: string[] = []) {
  const st = statSync(p);
  if (st.isFile()) {
    if (/\.(js|ts|mjs|cjs)$/.test(p) && !p.endsWith('.d.ts')) out.push(p);
    return out;
  }
  for (const n of readdirSync(p)) if (!SKIP_DIRS.has(n)) walk(join(p, n), out);
  return out;
}

const files = ROOTS.flatMap((r) => walk(join(root, r))).map((f) => relative(root, f));
const read = (f: string) => readFileSync(join(root, f), 'utf-8');
const opensEnvFile = (src: string) => /(readFileSync|existsSync|writeFileSync|appendFileSync|loadEnvFile)\([^)\n]*['"`][^'"`]*\.env(\.local|\.e2e|\.example)?['"`]/.test(src)
  || /join\([^)\n]*['"`]\.env(\.local|\.e2e)?['"`]\)/.test(src);
const importsModule = (src: string) => /lib\/dotenv(-heal)?\.js'/.test(src);

describe('dotenv dialect census', () => {
  it('only the two dotenv modules call util.parseEnv or a dotenv library', () => {
    for (const f of files) {
      if (MODULES.has(f) || f === SELF || f === 'tests/unit/lib/dotenv-oracle.test.ts') continue;
      expect(read(f), f).not.toMatch(/\bparseEnv\(|from ['"]dotenv|loadEnv\(/);
    }
  });
  it('every file that opens a .env* path imports the dotenv module', () => {
    const offenders = files.filter((f) => !MODULES.has(f) && f !== SELF && opensEnvFile(read(f)) && !importsModule(read(f)));
    expect(offenders).toEqual([]);
  });
  it('no file matches KEY= against env text except the module and the bundle rewriter', () => {
    const pattern = /\^\$\{key\}=|\^\(\?:VITE_|=\["'\]\?|\[\^"'\\\\n\]/;
    const offenders = files.filter((f) => !MODULES.has(f) && f !== SELF && f !== REWRITER && pattern.test(read(f)));
    expect(offenders).toEqual([]);
  });
  it('the bundle rewriter emits changed lines with formatDotenvLine', () => {
    const src = read(REWRITER);
    expect(src).toContain('formatDotenvLine(');
    expect(src).not.toMatch(/`\$\{[a-zA-Z.\[\]0-9]+\}=\$\{(?!formatDotenvLine)/);
  });
  it('the retired identifiers are gone', () => {
    for (const f of files) {
      if (f === SELF) continue;
      expect(read(f), f).not.toMatch(/\b(escapeDotenv|decodeDotenvValue|unescapeDotenv)\b/);
    }
  });
  it('the CLI and template modules are byte-identical', () => {
    expect(read('carbon/scripts/lib/dotenv.js')).toBe(read('src/lib/dotenv.js'));
  });
});
```

Run it. Every offender it lists is real work left over from Tasks 3-5: fix the offender, not the census. Allow-list additions need a one-line reason in the test and in the report.

- [ ] **Step 2: Compose oracle** `tests/integration/docker/dotenv-compose-oracle.test.ts`

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatDotenvLine } from '../../../src/lib/dotenv.js';
import { ORACLE_VALUES } from '../../unit/lib/dotenv-oracle.test.js';

const docker = process.env.DOCKER_INTEGRATION === 'true';

describe.skipIf(!docker)('dotenv oracle: docker compose reads the writer identically', () => {
  it('env_file values equal the source values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'compose-oracle-'));
    writeFileSync(join(dir, '.env'), `${Object.entries(ORACLE_VALUES).map(([k, v]) => formatDotenvLine(k, v)).join('\n')}\n`);
    writeFileSync(join(dir, 'compose.yml'), 'services:\n  probe:\n    image: busybox\n    env_file:\n      - .env\n');
    const out = execFileSync('docker', ['compose', '-f', 'compose.yml', 'config', '--format', 'json'], { cwd: dir, encoding: 'utf-8' });
    const env = JSON.parse(out).services.probe.environment;
    expect(env).toEqual(ORACLE_VALUES);
  });
});
```

If importing the `.test.ts` module for its fixture is awkward under the integration project config, move `ORACLE_VALUES`/`REFUSED_VALUES` to `tests/fixtures/dotenv-oracle-values.ts` and import from both tests (the census skips `fixtures`). Run `pnpm test:docker -- dotenv-compose-oracle` locally (Docker is available on this machine); a Compose mismatch on any value is a grammar hole → BLOCKED with the value name and both readings, do not drop the value.

- [ ] **Step 3: AGENTS.md** — one paragraph where env files are described: the three parsers, the writer grammar in one sentence, "refused at the prompt", pointer to `src/lib/dotenv.js` and the census test.

- [ ] **Step 4: Full tiers and commit**

```bash
pnpm lint && pnpm test:unit && pnpm test:cli && pnpm test:template && pnpm test:docker -- dotenv-compose-oracle
git commit -- tests/unit/lib/dotenv-dialect-census.test.ts tests/integration/docker/dotenv-compose-oracle.test.ts tests/fixtures AGENTS.md -m "test(dotenv): reader/writer census and docker compose oracle for the single dialect"
```

---

## Self-review

- Spec coverage: grammar (T1), refusal at prompt (T3 step 6), readers CLI (T3), template (T4), harness (T5), bundle rewriter (T3/T6), migration (T2 + T3 step 3), oracle Node/dotenv/expand (T1), Compose oracle (T6), census + lockstep (T6, lockstep also in T1), `.env.example` note (T4), documented `#` difference (T4 header + spec). Compatibility paragraph (T3 commit).
- Names used consistently: `parseDotenv`, `readEnvFiles`, `dotenvValueProblem`, `encodeDotenvValue`, `formatDotenvLine`, `DotenvValueError`, `healLegacyDotenvText`, `healLegacyDotenvQuoting`, `ORACLE_VALUES`, `REFUSED_VALUES`.
