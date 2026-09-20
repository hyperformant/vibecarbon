import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_KEYS, registryEntry } from '../../../src/lib/config-registry.js';
import { resolveDockerHubCreds } from '../../../src/lib/deploy/docker-hub.js';
import { DNS_PROVIDERS } from '../../../src/lib/dns-provider.js';
import { PROVIDERS, resolveProviderToken } from '../../../src/lib/providers/index.js';

/**
 * Census: every read of a REGISTERED operator key FROM `process.env` goes
 * through `readOperatorVar()` (src/lib/operator-env.js), never a raw
 * `process.env` access — and every operator-facing key that IS read has a
 * registry row.
 *
 * Scope, stated plainly (M12, review 2026-09-19): this census covers
 * `process.env` reads ONLY. File-based reads of the same keys — the k8s
 * path's `envLocal?.X` / `loadEnvLocal(...)` over the project's `.env.local`,
 * `parseDotenv`-driven reads of `.env`, `getEnvValue(...)` in up.js/status.js
 * — are outside it and are NOT normalized by construction here. "Census
 * green" therefore means "no raw process.env read of a registered key", not
 * "every read of a registered key is normalized". The file-based readers
 * that matter for operator values are `status`'s configure-family pass
 * (src/status.js computeConfigurationCheck, which validates what it reads)
 * and the k8s `.env.local` reads in src/lib/deploy/k8s/k3s.js (which do
 * not); anything new that reads a registered key from a FILE should route
 * the value through `normalizeOperatorValue`/`validateOperatorValue` itself.
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
 *   - `process.env.X` / `process.env?.X` / `process.env['X']` where X is in
 *     CONFIG_KEYS
 *   - `const { X } = process.env` (destructuring) where X is in CONFIG_KEYS
 *   - `process.env[<expr>.TOKEN_ENV]` (and `.S3_REGION_ENV`,
 *     `.PROJECT_ID_ENV`, `.OBJECT_STORAGE_ENV[…]`) — the provider statics,
 *     every one of which names a registered key (asserted below)
 *   - `process.env[<expr>.tokenEnv]` — the DNS_PROVIDERS rows, likewise
 *   - `process.env[<anything else dynamic>]` — unresolvable statically, so
 *     flagged unconditionally: the reader passes UNREGISTERED keys through
 *     untouched, so routing a dynamic read through it is always safe, and
 *     it is the only way to prove the read can't be a registered key.
 *   - a bare `process.env` alias (`const env = process.env`, an
 *     `env = process.env` default parameter, `fn(process.env)`) — the alias
 *     can be read for any key later, so it is flagged unless the file is in
 *     ALIAS_ALLOWLIST with a reason. Spreads (`...process.env`, a child
 *     process's env bag) and `key in process.env` (presence, not value) are
 *     not aliases.
 *
 * What does NOT count:
 *   - Writes (`process.env.X = …`, `delete process.env.X`). The reader reads
 *     `process.env` by design; the code that populates it — the guided
 *     setups after an accepted paste, `bootstrapOperatorEnv` folding
 *     `.env.local` in at startup (src/lib/project.js), the failover/destroy
 *     re-prompts — is the contract, not a bypass. Nothing is exempted by
 *     file for this: the write rule covers every one of them.
 *   - Reads of unregistered keys (`process.env.CI`, `HOME`, `VITEST`, …) —
 *     but see the second half: each such key must be a known runtime fact
 *     (RUNTIME_DETECTION) or a listed, TODO-tagged gap (KNOWN_UNREGISTERED).
 *   - Comments: block comments (`/* … *\/`, inline or multi-line at line
 *     start) and `//`-led lines. A `process.env.X` mention inside a string
 *     on a code line IS still flagged — loud in the safe direction.
 *   - `getEnvValue('DEV_PORT_OFFSET')` and friends in up.js/status.js: those
 *     read the .env FILE for dev-server ports, not `process.env`, and the
 *     DEV_* keys are create-time template values, not operator config.
 *     Deliberately out of scope.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

/** The reader itself is the one module allowed to touch `process.env` for these keys. */
const READER = join('lib', 'operator-env.js');
/** Metadata only, no env access; excluded so a doc example can't trip the sweep. */
const REGISTRY = join('lib', 'config-registry.js');
const ALLOWLIST = new Set([READER, REGISTRY]);

/**
 * Files allowed to hold a bare `process.env` alias, each with the reason it
 * can never be a registered-key read. Exact paths, not globs: a new alias in
 * a new file must earn its own line here.
 */
const ALIAS_ALLOWLIST: Record<string, string> = {
  'backup.js':
    'passes the whole env to a child-process runner (env: process.env), a spawn bag not a read',
  'telemetry.js':
    'injectable env for the telemetry status command; reads CI/DO_NOT_TRACK/VIBECARBON_TELEMETRY_DISABLED only',
  [join('lib', 'command.js')]:
    'spawn plumbing: gitSafeEnv/runCommand build child env bags from options.env || process.env',
  [join('lib', 'operator-ip.js')]:
    'shouldAutoDetectOperatorIp({ env }) reads env.CI only (the CIDR itself goes through the reader)',
  [join('lib', 'cli', 'progress.js')]:
    'shouldAnimateSpinner reads TTY facts: VIBECARBON_PLAIN/NO_COLOR/TERM/CI',
  [join('lib', 'licensing', 'check.js')]:
    'env.VIBECARBON_API_BASE (host override) is the only read, documented in its header',
  [join('lib', 'licensing', 'bind.js')]:
    'env.VIBECARBON_API_BASE (host override) is the only read, documented in its header',
  [join('lib', 'telemetry', 'index.js')]:
    'env.VIBECARBON_API_BASE (host override) is the only read',
  [join('lib', 'telemetry', 'state.js')]:
    'isAnalyticsDisabled reads VIBECARBON_TELEMETRY_DISABLED/DO_NOT_TRACK/CI',
  [join('lib', 'telemetry', 'update-check.js')]:
    'reads CI and VIBECARBON_API_BASE to decide whether/where to check for updates',
  [join('lib', 'deploy', 'preflight.js')]:
    'injectable env bag forwarded verbatim to checkOperatorConfig(scopes, { env }) — the reader ' +
    '(operator-env.js) is what actually reads each registered key off it',
};

/**
 * Literal keys read from `process.env` that are facts about the host, the
 * CI runner or this process — never operator configuration — so they have
 * no business in the registry. Enumerated from the actual reads in src/
 * (a key listed here that nothing reads any more is itself a failure, so
 * the list can't rot). SSH_ASKPASS, SSH_ASKPASS_REQUIRE and DISPLAY are
 * WRITTEN by cli.js (never read), so they don't appear.
 */
const RUNTIME_DETECTION: Record<string, string> = {
  CI: 'CI-runner detection (create.js non-interactive, command.js verbose output)',
  CONTINUOUS_INTEGRATION: 'CI-runner detection (create.js)',
  GITHUB_ACTIONS: 'CI-runner detection (create.js)',
  GITLAB_CI: 'CI-runner detection (create.js)',
  CIRCLECI: 'CI-runner detection (create.js)',
  JENKINS_URL: 'CI-runner detection (create.js)',
  DEBUG: 'developer verbosity toggle (command.js)',
  HOME: 'log-directory hint in a deploy error message (deploy.js)',
  PATH: 'prepended with a wrapper bin dir for the remote build (remote-build.js)',
  VITEST: 'test-runner detection so the deploy completion guard stays inert under vitest',
  npm_config_user_agent: 'package-manager detection set by npm/pnpm/yarn themselves (create.js)',
  COMPOSE_PROJECT_NAME: "docker compose's own project-name override for the dev stack (up.js)",
  VIBECARBON_PERF: 'internal perf-timer switch (perf.js)',
  VIBECARBON_UPLINK_LOCK_DIR: 'internal override for the uplink lock directory (uplink-lock.js)',
  VIBECARBON_BUNDLE_VERBOSE: 'internal bundle-render verbosity (orchestrator.js)',
  VIBECARBON_SKIP_CONFIG_SHAPES:
    'escape hatch for a vendor token-format change: downgrades shape problems to warnings in ' +
    'assertOperatorConfig (deploy/preflight.js); a switch about THIS process, not operator config',
};

/**
 * Literal keys read from `process.env` that ARE part of a deployment's
 * configuration surface but have no registry row yet. Listing one here
 * keeps the census green while making the gap visible; each carries the
 * reason and the follow-up that should decide its fate. Do not register a
 * key from this list as a side effect of an unrelated change.
 */
const KNOWN_UNREGISTERED: Record<string, string> = {
  REPL_PASSWORD:
    'generated at create time into .env.local (deploy/utils.js readReplPassword reads env first, then the file); ' +
    'the registry excludes generated infra secrets by design (see its header), so it has no row and no shape. ' +
    'TODO(operator-config-hygiene follow-up): decide whether generated secrets get a registry class or stay out.',
  PROVIDER_API_TOKEN:
    'read by src/autoscaler/server.js INSIDE the cluster; set from a secretKeyRef in ' +
    'carbon/k8s/base/cluster-autoscaler/deployment.yaml, never by an operator. ' +
    'TODO(operator-config-hygiene follow-up): a deployed-runtime class, or leave container env out of the registry.',
  CARBON_AUTOSCALER_BIND:
    'autoscaler sidecar listen address, set by the deployment manifest (src/autoscaler/*). Same follow-up as PROVIDER_API_TOKEN.',
  CARBON_AUTOSCALER_CONFIG:
    'autoscaler sidecar config path, set by the deployment manifest (src/autoscaler/server.js). Same follow-up as PROVIDER_API_TOKEN.',
};

const PROVIDER_STATICS = ['TOKEN_ENV', 'S3_REGION_ENV', 'PROJECT_ID_ENV', 'OBJECT_STORAGE_ENV'];

function jsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return jsFiles(full);
    return entry.endsWith('.js') ? [full] : [];
  });
}

/**
 * Remove comments while keeping every newline so line numbers hold:
 * single-line block comments anywhere on a line (`/* x *\/ code`), multi-line
 * block comments that START a line (a `/**` inside a glob string like
 * 'k8s/base/**' must not open one), then `//`- and `*`-led lines.
 */
function stripComments(src: string): string {
  const keepNewlines = (m: string) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*(?:(?!\*\/)[^\n])*\*\//g, keepNewlines)
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, keepNewlines)
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? '' : line))
    .join('\n');
}

type Access = {
  line: number;
  text: string;
  kind: 'read' | 'write' | 'destructure' | 'alias';
  /** Registered keys this access can resolve to; `null` = dynamic, unresolvable. */
  keys: string[] | null;
  /** True when `keys` are spelled out at the site (not resolved from a static). */
  literal: boolean;
};

type Head =
  | { index: number; end: number; form: 'member'; name: string }
  | { index: number; end: number; form: 'bracket'; expr: string }
  | { index: number; end: number; form: 'destructure'; names: string[] }
  | { index: number; end: number; form: 'alias' };

/**
 * Every `process.env` occurrence, by form: `.NAME` / `?.NAME`, `[<expr>]`
 * (matched by hand so a nested `]` in `process.env[DNS_PROVIDERS[id].tokenEnv]`
 * doesn't cut the expression short), `{ … } = process.env` destructuring,
 * and a bare alias (anything else that is not a `...` spread or an `in`
 * presence test).
 */
function* heads(code: string): Generator<Head> {
  const DESTRUCTURE = /\{([^}]*)\}\s*=\s*process\.env\b/g;
  const destructured = new Set<number>();
  for (const m of code.matchAll(DESTRUCTURE)) {
    const index = (m.index ?? 0) + m[0].lastIndexOf('process.env');
    destructured.add(index);
    const names = m[1]
      .split(',')
      .map((part) => part.split(':')[0].split('=')[0].trim())
      .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
    yield { index, end: index + 'process.env'.length, form: 'destructure', names };
  }

  const TOKEN = /process\.env\b/g;
  for (const t of code.matchAll(TOKEN)) {
    const index = t.index ?? 0;
    if (destructured.has(index)) continue;
    const after = code.slice(index + t[0].length);
    const before = code.slice(0, index);

    const member = after.match(/^\s*(\?\.|\.)\s*([A-Za-z_$][\w$]*)/);
    if (member) {
      yield { index, end: index + t[0].length + member[0].length, form: 'member', name: member[2] };
      continue;
    }
    const bracket = after.match(/^\s*(\?\.)?\s*\[/);
    if (bracket) {
      let depth = 1;
      let i = index + t[0].length + bracket[0].length;
      const exprStart = i;
      while (i < code.length && depth > 0) {
        if (code[i] === '[') depth += 1;
        else if (code[i] === ']') depth -= 1;
        i += 1;
      }
      yield { index, end: i, form: 'bracket', expr: code.slice(exprStart, i - 1).trim() };
      continue;
    }
    if (/\.\.\.\s*$/.test(before) || /\bin\s+$/.test(before)) continue;
    yield { index, end: index + t[0].length, form: 'alias' };
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

/** Every `process.env` access in `src`, classified. */
function scan(src: string): Access[] {
  const code = stripComments(src);
  const lines = code.split('\n');
  const out: Access[] = [];
  for (const h of heads(code)) {
    const before = code.slice(0, h.index);
    const line = before.split('\n').length;
    const text = lines[line - 1].trim();
    if (h.form === 'destructure') {
      out.push({ line, text, kind: 'destructure', keys: h.names, literal: true });
      continue;
    }
    if (h.form === 'alias') {
      out.push({ line, text, kind: 'alias', keys: null, literal: false });
      continue;
    }
    const after = code.slice(h.end);
    const isWrite = /^\s*(=(?!=)|\+=|\|\|=|\?\?=)/.test(after) || /delete\s*$/.test(before);
    const keys = h.form === 'member' ? [h.name] : resolveKeys(h.expr);
    const literal = h.form === 'member' || /^['"]/.test(h.expr);
    out.push({ line, text, kind: isWrite ? 'write' : 'read', keys, literal });
  }
  return out.sort((x, y) => x.line - y.line);
}

/** Accesses that must go through the reader (or, for aliases, be allowlisted). */
function offendingReads(access: Access[], rel = ''): Access[] {
  return access.filter((a) => {
    if (a.kind === 'write') return false;
    if (a.kind === 'alias') return !(rel in ALIAS_ALLOWLIST);
    return a.keys === null || a.keys.some((k) => Boolean(registryEntry(k)));
  });
}

/** Literal key names read (member or destructure) — the census's second half. */
function literalKeysRead(access: Access[]): string[] {
  return access
    .filter((a) => (a.kind === 'read' || a.kind === 'destructure') && a.literal && a.keys !== null)
    .flatMap((a) => a.keys ?? []);
}

function scanSrc(): Array<{ rel: string; access: Access[] }> {
  return jsFiles(SRC)
    .map((file) => ({ rel: relative(SRC, file), src: readFileSync(file, 'utf-8') }))
    .filter(({ rel }) => !ALLOWLIST.has(rel))
    .map(({ rel, src }) => ({ rel, access: scan(src) }));
}

describe('operator-env census — registered keys are read through readOperatorVar', () => {
  it('no module outside the reader reads a registered key straight from process.env', () => {
    const offenders = scanSrc().flatMap(({ rel, access }) =>
      offendingReads(access, rel).map((a) => {
        const via =
          a.kind === 'alias'
            ? 'alias'
            : a.keys === null
              ? 'dynamic key'
              : a.keys.filter((k) => registryEntry(k)).join('|');
        return `${rel}:${a.line}  [${via}]  ${a.text}`;
      }),
    );

    expect(
      offenders,
      'These read a registered operator key straight from process.env instead of ' +
        'readOperatorVar(key).value (src/lib/operator-env.js), or alias process.env ' +
        'without an ALIAS_ALLOWLIST reason:\n  ' +
        `${offenders.join('\n  ')}\n` +
        'The reader trims, unquotes and strips "Bearer " so a pasted credential ' +
        'reaches the provider clean; a raw read hands the paste straight through.',
    ).toEqual([]);
  });

  it('every operator-facing key read from process.env has a registry row (or a listed gap)', () => {
    const read = new Set(scanSrc().flatMap(({ access }) => literalKeysRead(access)));
    const unregistered = [...read]
      .filter((k) => !registryEntry(k))
      .filter((k) => !(k in RUNTIME_DETECTION))
      .filter((k) => !(k in KNOWN_UNREGISTERED))
      .sort();
    expect(
      unregistered,
      'Read from process.env but neither registered in CONFIG_KEYS nor explained in ' +
        'RUNTIME_DETECTION / KNOWN_UNREGISTERED:\n  ' +
        unregistered.join('\n  '),
    ).toEqual([]);

    // Both explanation lists must describe reads that still exist.
    const stale = [...Object.keys(RUNTIME_DETECTION), ...Object.keys(KNOWN_UNREGISTERED)].filter(
      (k) => !read.has(k),
    );
    expect(stale, 'listed as an unregistered read, but nothing in src/ reads it any more').toEqual(
      [],
    );
    // And a key can't be in both a gap list and the registry.
    const registeredGaps = Object.keys(KNOWN_UNREGISTERED).filter((k) => registryEntry(k));
    expect(registeredGaps, 'now registered — drop it from KNOWN_UNREGISTERED').toEqual([]);
  });

  it('every ALIAS_ALLOWLIST entry still holds an alias (the list cannot rot)', () => {
    const aliasFiles = new Set(
      scanSrc()
        .filter(({ access }) => access.some((a) => a.kind === 'alias'))
        .map(({ rel }) => rel),
    );
    const stale = Object.keys(ALIAS_ALLOWLIST).filter((rel) => !aliasFiles.has(rel));
    expect(stale, 'allowlisted for a process.env alias it no longer holds').toEqual([]);
  });

  it('every module that calls readOperatorVar imports it from lib/operator-env.js', () => {
    // A file that got its raw reads routed but then lost the import would
    // fail at runtime, not in the sweep above — this makes the census the
    // place that notices.
    const missing = jsFiles(SRC)
      .map((file) => ({ rel: relative(SRC, file), src: readFileSync(file, 'utf-8') }))
      .filter(({ rel }) => !ALLOWLIST.has(rel))
      .filter(({ src }) => /\breadOperatorVar\s*\(/.test(stripComments(src)))
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

  it('the scanner classifies reads, writes, deletes, statics, destructuring, aliases and comments (guards the matcher)', () => {
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
      'const f = process.env?.CLOUDFLARE_API_TOKEN;',
      'const { HETZNER_ACCESS_KEY, HOME, HETZNER_SECRET_KEY: sk } = process.env;',
      'const env = process.env;',
      'function g(env = process.env) {}',
      'const spread = { ...process.env, KUBECONFIG: k };',
      'if (key in process.env) {}',
      'const msg = "not set in process.env or .env.local";',
      '/* inline */ const h = process.env.SCALEWAY_SECRET_KEY;',
      '/**',
      ' * process.env.PULUMI_BACKEND_URL in a block comment is ignored',
      ' */',
      'const i = process.env.ACME_CA_SERVER; /* trailing */',
    ].join('\n');

    const access = scan(fixture);
    const summary = access.map((a) => [
      a.line,
      a.kind,
      a.keys === null ? 'dynamic' : a.keys.length === 1 ? a.keys[0] : a.keys.length,
    ]);
    expect(summary).toEqual([
      [3, 'read', 'HETZNER_API_TOKEN'],
      [4, 'read', 'DIGITALOCEAN_API_TOKEN'],
      [5, 'write', 'VULTR_API_TOKEN'],
      [6, 'write', 'LINODE_API_TOKEN'],
      [7, 'read', 'CI'],
      [8, 'read', Object.keys(PROVIDERS).length],
      [9, 'read', Object.keys(DNS_PROVIDERS).length],
      [10, 'read', 'dynamic'],
      [11, 'read', 'dynamic'],
      [12, 'write', 'dynamic'],
      [13, 'read', 'CLOUDFLARE_API_TOKEN'],
      [14, 'destructure', 3],
      [15, 'alias', 'dynamic'],
      [16, 'alias', 'dynamic'],
      [20, 'read', 'SCALEWAY_SECRET_KEY'],
      [24, 'read', 'ACME_CA_SERVER'],
    ]);
    expect(access.find((a) => a.kind === 'destructure')?.keys).toEqual([
      'HETZNER_ACCESS_KEY',
      'HOME',
      'HETZNER_SECRET_KEY',
    ]);
    // Line 7 (process.env.CI) is a read of an unregistered key: not an
    // offender. Lines 17-19 (spread, `in`, a string mentioning process.env
    // after `in`) are not accesses at all.
    expect(offendingReads(access, 'fixture.js').map((a) => a.line)).toEqual([
      3, 4, 8, 9, 10, 11, 13, 14, 15, 16, 20, 24,
    ]);
    // The allowlist exempts aliases only — never a registered-key read.
    expect(offendingReads(access, 'backup.js').map((a) => a.line)).toEqual([
      3, 4, 8, 9, 10, 11, 13, 14, 20, 24,
    ]);
    expect(literalKeysRead(access).sort()).toEqual(
      [
        'ACME_CA_SERVER',
        'CI',
        'CLOUDFLARE_API_TOKEN',
        'DIGITALOCEAN_API_TOKEN',
        'HETZNER_ACCESS_KEY',
        'HETZNER_API_TOKEN',
        'HETZNER_SECRET_KEY',
        'HOME',
        'SCALEWAY_SECRET_KEY',
      ].sort(),
    );
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
