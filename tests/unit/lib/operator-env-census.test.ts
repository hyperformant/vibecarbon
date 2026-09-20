import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_KEYS, registryEntry } from '../../../src/lib/config-registry.js';
import { resolveDockerHubCreds } from '../../../src/lib/deploy/docker-hub.js';
import { DNS_PROVIDERS } from '../../../src/lib/dns-provider.js';
import { PROVIDERS, resolveProviderToken } from '../../../src/lib/providers/index.js';

/**
 * Census: every read of a REGISTERED operator key goes through
 * `readOperatorVar()` (src/lib/operator-env.js), never a raw `process.env`
 * access.
 *
 * Why: `readOperatorVar` is where a pasted token loses its trailing newline,
 * its surrounding quotes and its stray `Bearer ` prefix, and where a wrong
 * shape gets reported by name (never by value). A raw `process.env.X` read
 * anywhere else hands the un-normalized value straight to a provider call,
 * so the operator gets an opaque 401 instead of the reader's diagnosis. One
 * raw read is a hole in that guarantee, so this sweep bans them all rather
 * than policing each one's correctness.
 *
 * What counts as a read of a registered key:
 *   - `process.env.X` / `process.env['X']` where X is in CONFIG_KEYS
 *   - `process.env[<expr>.TOKEN_ENV]` (and `.S3_REGION_ENV`,
 *     `.PROJECT_ID_ENV`, `.OBJECT_STORAGE_ENV[…]`) — the provider statics,
 *     every one of which names a registered key (asserted below)
 *   - `process.env[<expr>.tokenEnv]` — the DNS_PROVIDERS rows, likewise
 *   - `process.env[<anything else dynamic>]` — unresolvable statically, so
 *     flagged unconditionally: the reader passes UNREGISTERED keys through
 *     untouched, so routing a dynamic read through it is always safe, and
 *     it is the only way to prove the read can't be a registered key.
 *
 * What does NOT count:
 *   - Writes (`process.env.X = …`, `delete process.env.X`). The reader reads
 *     `process.env` by design; the code that populates it — the guided
 *     setups after an accepted paste, `bootstrapOperatorEnv` folding
 *     `.env.local` in at startup (src/lib/project.js), the failover/destroy
 *     re-prompts — is the contract, not a bypass. Nothing is exempted by
 *     file for this: the write rule covers every one of them.
 *   - Reads of unregistered keys (`process.env.CI`, `HOME`, `VITEST`, …).
 *   - Comment lines (`//`, `*`, `/*`-led). A `process.env.X` mention inside
 *     a string on a code line IS still flagged — loud in the safe direction.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

/** The reader itself is the one module allowed to touch `process.env` for these keys. */
const READER = join('lib', 'operator-env.js');
/** Metadata only, no env access; excluded so a doc example can't trip the sweep. */
const REGISTRY = join('lib', 'config-registry.js');
const ALLOWLIST = new Set([READER, REGISTRY]);

const PROVIDER_STATICS = ['TOKEN_ENV', 'S3_REGION_ENV', 'PROJECT_ID_ENV', 'OBJECT_STORAGE_ENV'];

function jsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return jsFiles(full);
    return entry.endsWith('.js') ? [full] : [];
  });
}

/** Blank out comment-led lines (keep the newline so line numbers hold). */
function stripCommentLines(src: string): string {
  return src
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line))
    .join('\n');
}

type Access = {
  line: number;
  text: string;
  kind: 'read' | 'write';
  /** Registered keys this access can resolve to; `null` = dynamic, unresolvable. */
  keys: string[] | null;
};

/**
 * Each `process.env` property access: `.NAME` or `[<expr>]`. The bracket form
 * is matched by hand so a nested `]` (`process.env[DNS_PROVIDERS[id].tokenEnv]`)
 * doesn't cut the expression short.
 */
function* accesses(
  code: string,
): Generator<{ index: number; end: number; name?: string; expr?: string }> {
  const HEAD = /process\.env\s*(\.\s*([A-Za-z_$][\w$]*)|\[)/g;
  for (const head of code.matchAll(HEAD)) {
    const index = head.index ?? 0;
    if (head[2] !== undefined) {
      yield { index, end: index + head[0].length, name: head[2] };
      continue;
    }
    let depth = 1;
    let i = index + head[0].length;
    while (i < code.length && depth > 0) {
      if (code[i] === '[') depth += 1;
      else if (code[i] === ']') depth -= 1;
      i += 1;
    }
    yield { index, end: i, expr: code.slice(index + head[0].length, i - 1).trim() };
  }
}

function resolveKeys(expr: string): string[] | null {
  const literal = expr.match(/^(['"])([A-Za-z_][\w]*)\1$/);
  if (literal) return [literal[2]];

  const providerStatic = expr.match(/\.(TOKEN_ENV|S3_REGION_ENV|PROJECT_ID_ENV)$/);
  if (providerStatic) {
    return Object.values(PROVIDERS)
      .map((Provider) => (Provider as unknown as Record<string, string>)[providerStatic[1]])
      .filter(Boolean);
  }
  if (/\.OBJECT_STORAGE_ENV\s*\[/.test(expr)) {
    return Object.values(PROVIDERS).flatMap((Provider) => Provider.OBJECT_STORAGE_ENV);
  }
  if (/\.tokenEnv$/.test(expr)) {
    return Object.values(DNS_PROVIDERS).map((row) => row.tokenEnv);
  }
  return null;
}

/** Every `process.env` property access in `src`, classified. Exported shape is test-internal. */
function scan(src: string): Access[] {
  const code = stripCommentLines(src);
  const lines = code.split('\n');
  const out: Access[] = [];
  for (const a of accesses(code)) {
    const after = code.slice(a.end);
    const before = code.slice(0, a.index);
    const isWrite = /^\s*(=(?!=)|\+=|\|\|=|\?\?=)/.test(after) || /delete\s*$/.test(before);
    const line = before.split('\n').length;
    const text = lines[line - 1].trim();
    const keys = a.name !== undefined ? [a.name] : resolveKeys(a.expr ?? '');
    out.push({ line, text, kind: isWrite ? 'write' : 'read', keys });
  }
  return out;
}

function offendingReads(access: Access[]): Access[] {
  return access.filter(
    (a) => a.kind === 'read' && (a.keys === null || a.keys.some((k) => Boolean(registryEntry(k)))),
  );
}

describe('operator-env census — registered keys are read through readOperatorVar', () => {
  it('no module outside the reader reads a registered key straight from process.env', () => {
    const offenders = jsFiles(SRC)
      .map((file) => ({ rel: relative(SRC, file), src: readFileSync(file, 'utf-8') }))
      .filter(({ rel }) => !ALLOWLIST.has(rel))
      .flatMap(({ rel, src }) =>
        offendingReads(scan(src)).map((a) => {
          const via =
            a.keys === null ? 'dynamic key' : a.keys.filter((k) => registryEntry(k)).join('|');
          return `${rel}:${a.line}  [${via}]  ${a.text}`;
        }),
      );

    expect(
      offenders,
      'These read a registered operator key straight from process.env instead of ' +
        'readOperatorVar(key).value (src/lib/operator-env.js):\n  ' +
        `${offenders.join('\n  ')}\n` +
        'The reader trims, unquotes and strips "Bearer " so a pasted credential ' +
        'reaches the provider clean; a raw read hands the paste straight through.',
    ).toEqual([]);
  });

  it('every module that reads a registered key imports the reader', () => {
    // Belt for the braces above: a file that got its raw reads routed but
    // then lost the import would fail at runtime, not here — this makes the
    // census the place that notices.
    const missing = jsFiles(SRC)
      .map((file) => ({ rel: relative(SRC, file), src: readFileSync(file, 'utf-8') }))
      .filter(({ rel }) => !ALLOWLIST.has(rel))
      .filter(({ src }) => /\breadOperatorVar\s*\(/.test(stripCommentLines(src)))
      .filter(
        ({ src }) =>
          !/import\s*\{[^}]*\breadOperatorVar\b[^}]*\}\s*from\s*['"][^'"]*operator-env\.js['"]/s.test(
            src,
          ),
      )
      .map(({ rel }) => rel);
    expect(missing, 'call readOperatorVar but do not import it from lib/operator-env.js').toEqual(
      [],
    );
  });

  it('every provider credential static names a registered key scoped to that provider', () => {
    const problems: string[] = [];
    for (const [id, Provider] of Object.entries(PROVIDERS)) {
      const statics: Array<[string, string]> = [];
      for (const name of PROVIDER_STATICS) {
        const value = (Provider as unknown as Record<string, string | string[]>)[name];
        if (Array.isArray(value)) for (const v of value) statics.push([`${name}[]`, v]);
        else if (value) statics.push([name, value]);
      }
      for (const [name, key] of statics) {
        const entry = registryEntry(key);
        if (!entry) problems.push(`${id}.${name} = ${key}: not in CONFIG_KEYS`);
        else if (entry.scope !== `provider:${id}`) {
          problems.push(`${id}.${name} = ${key}: scope is ${entry.scope}, expected provider:${id}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('every DNS_PROVIDERS row token env names a registered key (grounds the .tokenEnv resolution)', () => {
    const unregistered = Object.entries(DNS_PROVIDERS)
      .filter(([, row]) => !registryEntry(row.tokenEnv))
      .map(([id, row]) => `${id}: ${row.tokenEnv}`);
    expect(unregistered).toEqual([]);
  });

  it('the scanner classifies reads, writes, deletes, statics and comments (guards the matcher)', () => {
    const fixture = [
      '// process.env.HETZNER_API_TOKEN in a comment is ignored',
      ' * process.env.DOCKER_HUB_TOKEN in a docblock is ignored',
      'const a = process.env.HETZNER_API_TOKEN;',
      "const b = process.env['DIGITALOCEAN_API_TOKEN'] || null;",
      'process.env.VULTR_API_TOKEN = token;',
      'delete process.env.LINODE_API_TOKEN;',
      'if (process.env.CI === "true") {}',
      'const c = process.env[Provider.TOKEN_ENV];',
      'const d = process.env[DNS_PROVIDERS[id].tokenEnv];',
      'const e = process.env[key];',
      'if (process.env[envKey] !== x) {}',
      'process.env[envKey] = x;',
    ].join('\n');

    const access = scan(fixture);
    expect(
      access.map((a) => [a.line, a.kind, a.keys === null ? 'dynamic' : a.keys.length]),
    ).toEqual([
      [3, 'read', 1],
      [4, 'read', 1],
      [5, 'write', 1],
      [6, 'write', 1],
      [7, 'read', 1],
      [8, 'read', Object.keys(PROVIDERS).length],
      [9, 'read', Object.keys(DNS_PROVIDERS).length],
      [10, 'read', 'dynamic'],
      [11, 'read', 'dynamic'],
      [12, 'write', 'dynamic'],
    ]);
    // Line 7 (process.env.CI) is a read of an unregistered key: not an offender.
    expect(offendingReads(access).map((a) => a.line)).toEqual([3, 4, 8, 9, 10, 11]);
  });

  it('the registry still carries the operator keys this census exists for (guards the sweep)', () => {
    const keys = new Set(CONFIG_KEYS.map((e) => e.key));
    for (const k of [
      'HETZNER_API_TOKEN',
      'CLOUDFLARE_API_TOKEN',
      'DOCKER_HUB_TOKEN',
      'PULUMI_BACKEND_URL',
      'ACME_CA_SERVER',
      'ALLOWED_SSH_IPS',
    ]) {
      expect(
        keys.has(k),
        `${k} left the registry — the census would silently stop covering it`,
      ).toBe(true);
    }
  });
});

describe('routed reads deliver the normalized value', () => {
  const KEYS = ['HETZNER_API_TOKEN', 'DOCKER_HUB_USERNAME', 'DOCKER_HUB_TOKEN'];
  const ambient = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of KEYS) {
      ambient.set(k, process.env[k]);
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      const v = ambient.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('resolveProviderToken strips whitespace, quotes and a Bearer prefix; still string|null', () => {
    const token = 'a'.repeat(64);
    process.env.HETZNER_API_TOKEN = `"Bearer ${token}"\n`;
    expect(resolveProviderToken('hetzner')).toBe(token);
    delete process.env.HETZNER_API_TOKEN;
    expect(resolveProviderToken('hetzner')).toBeNull();
    process.env.HETZNER_API_TOKEN = '   ';
    expect(resolveProviderToken('hetzner')).toBeNull();
  });

  it('a shape problem does not null the value (preflight reports it; reads only normalize)', () => {
    process.env.HETZNER_API_TOKEN = ' too-short ';
    expect(resolveProviderToken('hetzner')).toBe('too-short');
  });

  it('resolveDockerHubCreds trims both halves', () => {
    process.env.DOCKER_HUB_USERNAME = ' acme ';
    process.env.DOCKER_HUB_TOKEN = '"dckr_pat_abc"';
    expect(resolveDockerHubCreds()).toEqual({ username: 'acme', token: 'dckr_pat_abc' });
  });
});
