# Operator configuration hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every operator-supplied value (env-file credentials and `configure` prompts) is normalized on ingress, shape-checked before infrastructure is touched (deploy preflight, hard) and surfaced in `status` (advisory), with a census that fails the suite when a variable is read but unregistered, documented under a stale name, or documented with prose that no longer matches its shape.

**Architecture:** `CONFIG_KEYS` in `src/lib/config-registry.js` gains per-entry `kind`/`shape`/`sample`/`where` metadata and the missing operator keys. A new dependency-free `src/lib/operator-env.js` exposes `normalizeOperatorValue`, `validateOperatorValue`, `readOperatorVar`, and `checkOperatorConfig(scopes)`; every read of a registered key goes through it (census-enforced). Deploy preflight calls `checkOperatorConfig` before any provider call; `status` prints a `Configuration` line from the same check; `configure`'s two prompt helpers validate through the same rows. A new `carbon/.env.local.example` documents the operator keys; a census ties every registry entry to its example file and `# format:` line.

**Tech Stack:** Node ESM, vitest unit + integration projects, `@clack/prompts` validate callbacks.

**Spec:** `docs/superpowers/specs/2026-09-19-operator-config-hygiene-design.md` (approved 2026-09-19; decisions: tight shapes only where the vendor documents them, `status` line pre-deploy, Phases 1+2 together).

## Global Constraints

- Branch `feat/operator-config-hygiene` off `main` (v0.45.0). Conventional prefixes; no `!:`/`BREAKING` footers; pathspec commits after `git diff --cached --stat`; the pre-commit hook must pass on its own (never `--no-verify`).
- `pnpm lint` at 0 warnings, `pnpm test:unit`, `pnpm test:cli`, `pnpm test:template` green after every task.
- **Never print, log, or include a secret value in a message, test name, or fixture from a real file.** Problem strings carry only the variable name, the expected shape prose, and the observed *length* / a hint (`trailing newline or quote?`). Unit fixtures use obviously fake samples.
- `src/lib/config-registry.js` stays dependency-free (deploy code imports it without clack). `src/lib/operator-env.js` may import only `config-registry.js` and node builtins.
- Tight regexes only for documented vendor formats: Hetzner API token (64 alnum), Docker Hub PAT (`dckr_pat_`), Stripe secret (`sk_(live|test)_`) and webhook (`whsec_`), Resend (`re_`), SendGrid (`SG.`), Google client ID (`.apps.googleusercontent.com`) and secret (`GOCSPX-`), Polar token (`polar_`), UUIDs (Postmark server token, Microsoft tenant ID, DigitalOcean project ID). Everything else `minLen` + kind rules.
- Existing behaviour that must not change: `resolveProviderToken` returns the token string or `null`; `configure` still writes via `setEnvVar` with `localOnly: isOperatorKey(key)`; `featureRuntimeKeys()` / `clientBuildKeys()` / `isOperatorKey()` results are unchanged by the new metadata.

---

## File Structure

- Modify `src/lib/config-registry.js`: extend `ConfigKey` typedef; add metadata to every entry; add missing operator entries (`DOCKER_HUB_USERNAME`, `DOCKER_HUB_TOKEN`, `ALLOWED_SSH_IPS`, `HETZNER_STORAGE_REGION`, `DIGITALOCEAN_STORAGE_REGION`, `SCALEWAY_STORAGE_REGION`, `PULUMI_BACKEND_URL`, `ACME_CA_SERVER`); export `registryEntry(key)`, `entriesForScopes(scopes)`.
- Create `src/lib/operator-env.js`: `normalizeOperatorValue(raw, entry)`, `validateOperatorValue(value, entry)`, `readOperatorVar(key, deps)`, `checkOperatorConfig(scopes, deps)`, `describeProblem(...)`.
- Modify `src/lib/providers/index.js` (`resolveProviderToken` → reader), `src/lib/deploy/docker-hub.js` (reader), `src/lib/configure-providers.js` (Cloudflare token via reader where it is read), `src/lib/deploy/preflight.js` (`checkDeployPrerequisites` gains `checkOperatorConfig`), `src/lib/deploy/orchestrator.js` (passes scopes), `src/status.js` (Configuration line), `src/configure.js` (`promptText`/`promptSecret` take an `entry`, every call site passes its key).
- Create `carbon/.env.local.example`; modify `carbon/.env.example` (`# format:` lines), `tests/.env.e2e.example` (`# format:` line for the PEM key).
- Tests: extend `tests/unit/config-registry.test.ts`; create `tests/unit/lib/operator-env.test.ts`, `tests/unit/lib/operator-env-census.test.ts`, `tests/unit/deploy/preflight-operator-config.test.ts`, `tests/unit/status/configuration-line.test.ts`, `tests/unit/configure/prompt-validation.test.ts`; one integration case in `tests/integration/cli/deploy/` (quoted token refused before any provider call) and one in `tests/integration/cli/status/`.

---

### Task 1: Registry metadata and the missing operator keys

**Files:**
- Modify: `src/lib/config-registry.js`
- Test: `tests/unit/config-registry.test.ts` (extend)

**Interfaces:**
- Produces:
  ```js
  // ConfigKey gains: kind, shape?, sample?, where, optional?, scope?
  //   kind:  'token'|'secret'|'id'|'slug'|'hostname'|'port'|'email'|'url'|'cidr-list'|'pem'|'enum'|'flag'
  //   shape: { regex?: RegExp, minLen?: number, maxLen?: number, values?: string[], describe: string }
  //   sample: string   (required whenever shape is present; must pass the shape)
  //   where: '.env.local' | '.env' | 'operator shell' | 'tests/.env.e2e'
  //   optional: boolean (default false)   scope: e.g. 'provider:hetzner' | 'dns:cloudflare' | 'registry' | 'access' | 'billing' | 'oauth' | 'smtp' | 'e2e'
  export function registryEntry(key)            // -> ConfigKey | undefined
  export function entriesForScopes(scopes)      // -> ConfigKey[] whose scope is in scopes (Set or array)
  ```

- [ ] **Step 1: Write the failing tests** — append to `tests/unit/config-registry.test.ts`:

```ts
describe('shape metadata', () => {
  it('every entry has a kind, a where, and a scope', () => {
    for (const e of CONFIG_KEYS) {
      expect(e.kind, e.key).toBeTruthy();
      expect(['.env.local', '.env', 'operator shell', 'tests/.env.e2e'], e.key).toContain(e.where);
      expect(e.scope, e.key).toMatch(/^[a-z]+(:[a-z]+)?$/);
    }
  });
  it('every entry with a shape has a sample that satisfies it', () => {
    for (const e of CONFIG_KEYS.filter((e) => e.shape)) {
      expect(e.sample, `${e.key} needs a sample`).toBeTruthy();
      expect(e.shape.describe, `${e.key} shape needs describe`).toBeTruthy();
      if (e.shape.regex) expect(e.sample, e.key).toMatch(e.shape.regex);
      if (e.shape.minLen) expect(e.sample.length, e.key).toBeGreaterThanOrEqual(e.shape.minLen);
      if (e.shape.values) expect(e.shape.values, e.key).toContain(e.sample);
    }
  });
  it('operator-secret entries live in .env.local or the operator shell', () => {
    for (const e of CONFIG_KEYS.filter((e) => e.class === 'operator-secret')) {
      expect(['.env.local', 'operator shell'], e.key).toContain(e.where);
    }
  });
  it('registers the keys deploy reads outside configure', () => {
    for (const k of ['DOCKER_HUB_USERNAME', 'DOCKER_HUB_TOKEN', 'ALLOWED_SSH_IPS', 'HETZNER_STORAGE_REGION', 'DIGITALOCEAN_STORAGE_REGION', 'SCALEWAY_STORAGE_REGION', 'PULUMI_BACKEND_URL', 'ACME_CA_SERVER']) {
      expect(registryEntry(k), k).toBeDefined();
    }
  });
  it('tight shapes exist only where the vendor documents the format', () => {
    const tight = CONFIG_KEYS.filter((e) => e.shape?.regex).map((e) => e.key).sort();
    expect(tight).toEqual([
      'ACME_CA_SERVER', 'ALLOWED_SSH_IPS', 'DIGITALOCEAN_PROJECT_ID', 'DOCKER_HUB_TOKEN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
      'HETZNER_API_TOKEN', 'MICROSOFT_TENANT_ID', 'POLAR_ACCESS_TOKEN', 'PULUMI_BACKEND_URL', 'SMTP_ADMIN_EMAIL', 'SMTP_PORT',
      'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
    ]);
  });
  it('entriesForScopes selects by scope', () => {
    const keys = entriesForScopes(['provider:hetzner']).map((e) => e.key).sort();
    expect(keys).toEqual(['HETZNER_ACCESS_KEY', 'HETZNER_API_TOKEN', 'HETZNER_SECRET_KEY', 'HETZNER_STORAGE_REGION']);
  });
  it('existing derived views are unchanged by the metadata', () => {
    expect(featureRuntimeKeys()).not.toContain('HETZNER_API_TOKEN');
    expect(isOperatorKey('DOCKER_HUB_TOKEN')).toBe(true);
    expect(isOperatorKey('ALLOWED_SSH_IPS')).toBe(false); // ships in .env (ALLOWED_SSH_IPS is read server-side by the firewall/ssh config)
  });
});
```

Read the top of the existing test file for its imports and add `registryEntry`, `entriesForScopes`, `featureRuntimeKeys`, `isOperatorKey` as needed. If `ALLOWED_SSH_IPS` is in fact operator-local (check `src/access.js` for how it writes it — `localOnly`?), flip that last expectation and the entry's `where`/`class` accordingly and say so in the report.

- [ ] **Step 2: Run** `pnpm vitest run --project unit tests/unit/config-registry.test.ts` → FAIL (no metadata, no exports).

- [ ] **Step 3: Implement.** In `config-registry.js`: extend the typedef comment; add the fields to every existing entry; add the eight missing entries with `class: 'operator-secret'` for Docker Hub (`where: 'operator shell'`, scope `registry`), storage regions (scope `provider:<x>`, `optional: true`, kind `slug`), `PULUMI_BACKEND_URL` (kind `url`, optional, scope `state`), `ACME_CA_SERVER` (kind `url`, optional, scope `tls`), and `ALLOWED_SSH_IPS` (kind `cidr-list`, `class: 'runtime-config'` unless Step 1 said otherwise, scope `access`, optional). Shapes per the Global Constraints list; `describe` prose is what the docs will carry verbatim (e.g. `'64 alphanumeric characters'`, `'sk_live_… or sk_test_…'`, `'a UUID'`, `'comma-separated IPv4 CIDRs like 203.0.113.0/24'`, `'1-65535'`, `'an https:// URL'`). Every other existing entry gets a loose shape or none: `minLen: 8` for secrets/tokens without a documented format, `values` for enums (`BILLING_PROVIDER`, `PADDLE_ENVIRONMENT`, `GOOGLE_ENABLED`/`MICROSOFT_ENABLED`/`GOTRUE_MAILER_AUTOCONFIRM` as `flag` with `values: ['true','false']`), `hostname` for `SMTP_HOST`, `email` for `SMTP_ADMIN_EMAIL`, `url` for `VITE_PLAUSIBLE_SCRIPT_URL`/`VITE_GITHUB_REPO_URL`. Add `registryEntry` and `entriesForScopes`.

Run: the registry test, plus `pnpm test:unit` — the existing coverage tests (`registry ⊆ each deploy path`) must still pass; if adding `ALLOWED_SSH_IPS`/`DOCKER_HUB_*` as entries breaks a "registry ⊆ path" census because a propagation path does not carry them, read that census's rationale and exclude by class/scope the way it already excludes `operator-secret`, and explain in the report.

- [ ] **Step 4: Commit** `feat(config): shape metadata on the config registry, plus the operator keys deploy reads` — pathspec `src/lib/config-registry.js tests/unit/config-registry.test.ts`.

---

### Task 2: The normalizing reader and validator

**Files:**
- Create: `src/lib/operator-env.js`
- Test: `tests/unit/lib/operator-env.test.ts` (create)

**Interfaces:**
- Produces:
  ```js
  export function normalizeOperatorValue(raw, entry)   // -> { value: string, fixed: string[] }
  export function validateOperatorValue(value, entry)  // -> string | null   (problem text, never the value)
  export function readOperatorVar(key, { env = process.env } = {})  // -> { value: string|null, problem: string|null, fixed: string[] }
  export function checkOperatorConfig(scopes, { env = process.env } = {}) // -> { problems: string[], checked: string[] }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { checkOperatorConfig, normalizeOperatorValue, readOperatorVar, validateOperatorValue } from '../../../src/lib/operator-env.js';
import { registryEntry } from '../../../src/lib/config-registry.js';

const hetzner = registryEntry('HETZNER_API_TOKEN')!;
const stripe = registryEntry('STRIPE_SECRET_KEY')!;
const pem = { key: 'X_PEM', class: 'operator-secret', feature: 'e2e', kind: 'pem', where: 'tests/.env.e2e', scope: 'e2e' } as const;
const good64 = 'a'.repeat(64);

describe('normalizeOperatorValue', () => {
  it('trims whitespace and newlines', () => {
    expect(normalizeOperatorValue(`  ${good64}\n`, hetzner)).toEqual({ value: good64, fixed: ['trimmed whitespace'] });
  });
  it('strips one pair of matching surrounding quotes', () => {
    expect(normalizeOperatorValue(`"${good64}"`, hetzner).value).toBe(good64);
    expect(normalizeOperatorValue(`'${good64}'`, hetzner).value).toBe(good64);
    expect(normalizeOperatorValue(`"${good64}'`, hetzner).value).toBe(`"${good64}'`);
  });
  it('strips a Bearer prefix for tokens only', () => {
    expect(normalizeOperatorValue(`Bearer ${good64}`, hetzner)).toEqual({ value: good64, fixed: ['removed "Bearer " prefix'] });
    expect(normalizeOperatorValue('Bearer x', registryEntry('SMTP_HOST')!).value).toBe('Bearer x');
  });
  it('expands \\n escapes and decodes base64 for pem', () => {
    const p = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
    expect(normalizeOperatorValue(p.replace(/\n/g, '\\n'), pem).value).toBe(p);
    expect(normalizeOperatorValue(Buffer.from(p).toString('base64'), pem).value).toBe(p);
    expect(normalizeOperatorValue(p, pem).fixed).toEqual([]);
  });
  it('returns empty for null/undefined', () => {
    expect(normalizeOperatorValue(undefined, hetzner)).toEqual({ value: '', fixed: [] });
  });
});

describe('validateOperatorValue', () => {
  it('accepts a matching value', () => expect(validateOperatorValue(good64, hetzner)).toBeNull());
  it('names the variable, the expected shape, and the observed length — never the value', () => {
    const msg = validateOperatorValue(`${good64}x`, hetzner)!;
    expect(msg).toBe('HETZNER_API_TOKEN looks wrong: expected 64 alphanumeric characters, got 65 characters');
    expect(msg).not.toContain('aaaa');
  });
  it('hints at the classic paste mistakes', () => {
    expect(validateOperatorValue(`${good64}\n`, hetzner)).toContain('trailing newline');
    expect(validateOperatorValue(`"${good64}"`, hetzner)).toContain('surrounding quotes');
  });
  it('reports a missing required value', () => {
    expect(validateOperatorValue('', hetzner)).toBe('HETZNER_API_TOKEN is not set');
    expect(validateOperatorValue('', registryEntry('HETZNER_STORAGE_REGION')!)).toBeNull();
  });
  it('checks kind rules without a regex: port, email, hostname, url, cidr-list, enum, minLen', () => {
    expect(validateOperatorValue('70000', registryEntry('SMTP_PORT')!)).toContain('1-65535');
    expect(validateOperatorValue('not-an-email', registryEntry('SMTP_ADMIN_EMAIL')!)).toContain('email');
    expect(validateOperatorValue('http://x', registryEntry('ACME_CA_SERVER')!)).toContain('https://');
    expect(validateOperatorValue('10.0.0.0/8,garbage', registryEntry('ALLOWED_SSH_IPS')!)).toContain('CIDR');
    expect(validateOperatorValue('paypal', registryEntry('BILLING_PROVIDER')!)).toContain('one of');
    expect(validateOperatorValue('short', registryEntry('LINODE_API_TOKEN')!)).toContain('at least');
    expect(validateOperatorValue('sk_test_abc', stripe)).toBeNull();
  });
});

describe('readOperatorVar', () => {
  it('normalizes then validates from the given env', () => {
    expect(readOperatorVar('HETZNER_API_TOKEN', { env: { HETZNER_API_TOKEN: `"${good64}"\n` } })).toEqual({ value: good64, problem: null, fixed: ['trimmed whitespace', 'stripped surrounding quotes'] });
  });
  it('returns null value + problem when missing', () => {
    expect(readOperatorVar('HETZNER_API_TOKEN', { env: {} })).toEqual({ value: null, problem: 'HETZNER_API_TOKEN is not set', fixed: [] });
  });
  it('passes through an unregistered key untouched (no problem, no normalization)', () => {
    expect(readOperatorVar('NOT_IN_REGISTRY', { env: { NOT_IN_REGISTRY: ' x ' } })).toEqual({ value: ' x ', problem: null, fixed: [] });
  });
});

describe('checkOperatorConfig', () => {
  it('aggregates every problem for the selected scopes and lists what it checked', () => {
    const r = checkOperatorConfig(['provider:hetzner', 'dns:cloudflare'], { env: { HETZNER_API_TOKEN: 'short', HETZNER_ACCESS_KEY: 'k'.repeat(20), HETZNER_SECRET_KEY: 's'.repeat(40) } });
    expect(r.problems).toEqual([
      'HETZNER_API_TOKEN looks wrong: expected 64 alphanumeric characters, got 5 characters',
      'CLOUDFLARE_API_TOKEN is not set',
    ]);
    expect(r.checked).toContain('HETZNER_STORAGE_REGION');
  });
  it('is clean when everything is set and shaped', () => {
    expect(checkOperatorConfig(['provider:hetzner'], { env: { HETZNER_API_TOKEN: good64, HETZNER_ACCESS_KEY: 'k'.repeat(20), HETZNER_SECRET_KEY: 's'.repeat(40) } }).problems).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement** `src/lib/operator-env.js` (imports only `config-registry.js`): `normalizeOperatorValue` applies, in order, trim → matching-quote strip → `Bearer ` strip (kind token) → pem handling (`\\n` expansion when the string contains literal `\n` and no real newlines; base64 decode when it does not start with `-----BEGIN`), recording each applied step in `fixed`. `validateOperatorValue` returns `null` or a message built as `${key} looks wrong: expected ${describe}, got ${n} characters` with an appended hint when the *raw* value ended in `\n` (`— a trailing newline?`) or was quote-wrapped (`— surrounding quotes?`); kind rules for port/email/hostname/url (`https://` required for `url` kinds marked `https: true`; ACME and Pulumi are), cidr-list, enum (`one of a, b, c`), minLen (`at least N characters`). `readOperatorVar` wires the two. `checkOperatorConfig` walks `entriesForScopes(scopes)` in registry order.

- [ ] **Step 4: Verify** the test file, `pnpm lint`, `pnpm test:unit`.
- [ ] **Step 5: Commit** `feat(config): normalizing reader and shape validator for operator values` — pathspec the two files.

---

### Task 3: Every read of a registered key goes through the reader, with a census

**Files:**
- Modify: `src/lib/providers/index.js` (`resolveProviderToken`), `src/lib/deploy/docker-hub.js`, any other `process.env.<registered key>` read the census finds (`src/lib/configure-providers.js`, `src/access.js`, `src/lib/deploy/*` for storage regions / `PULUMI_BACKEND_URL` / `ACME_CA_SERVER`)
- Test: `tests/unit/lib/operator-env-census.test.ts` (create); existing tests for the touched readers stay green

- [ ] **Step 1: Write the census (it fails first)** — walk `src/**/*.js` (excluding `src/lib/operator-env.js` and `src/lib/config-registry.js`), find every `process.env.X`, `process.env['X']`, `process.env[X]` where `X` is a literal or a `Provider.*_ENV` static, and every `getEnvValue('X')`; for each `X` that is a registered key, assert the read happens inside a file that imports `readOperatorVar` AND the line itself is not a raw `process.env` read (i.e. the only allowed raw reads of registered keys are inside `operator-env.js`). Also assert: every `static TOKEN_ENV|OBJECT_STORAGE_ENV|S3_REGION_ENV|PROJECT_ID_ENV` value across `src/lib/providers/*.js` names a registered key with `scope: 'provider:<id>'` where `<id>` is the class's provider id. Print the offending file:line list in the assertion message.

- [ ] **Step 2: Run** → FAIL listing the raw reads.

- [ ] **Step 3: Route them.** `resolveProviderToken(providerId)` becomes `readOperatorVar(Provider.TOKEN_ENV).value` (still `string | null`; a shape problem does NOT null the token here — preflight reports it; a malformed token must still reach the provider call so today's behaviour for edge shapes is unchanged). Same for object-storage keys, storage region, DO project ID, Docker Hub, Cloudflare (wherever `process.env.CLOUDFLARE_API_TOKEN` is read — likely `src/lib/dns/*` or `configure-providers.js`), `ALLOWED_SSH_IPS`, `PULUMI_BACKEND_URL`, `ACME_CA_SERVER`. Behaviour change allowed and intended: values now arrive trimmed/unquoted. Run the whole unit + cli suites; any test that passed a quoted/whitespace-padded value and expected it verbatim is asserting the bug — update it and list each in the report.

- [ ] **Step 4: Verify** census green, `pnpm lint`, `pnpm test:unit`, `pnpm test:cli`.
- [ ] **Step 5: Commit** `refactor(config): read every registered operator value through the normalizing reader (census-enforced)`.

---

### Task 4: Deploy preflight refuses malformed configuration before any provider call

**Files:**
- Modify: `src/lib/deploy/preflight.js` (`checkDeployPrerequisites` gains an `operatorScopes` option and calls `checkOperatorConfig`), `src/lib/deploy/orchestrator.js:~297` (passes the scopes: `provider:<id>` from `providerFor(config)`, `dns:<dnsProvider>` when automated DNS is in play (`hasAutomatedDns`), `registry` when the deploy pushes to Docker Hub (read how `docker-hub.js` decides), `access`, `tls`, `state`)
- Test: `tests/unit/deploy/preflight-operator-config.test.ts` (create); integration: `tests/integration/cli/deploy/` — one case

- [ ] **Step 1: Tests.** Unit: `checkDeployPrerequisites('compose', { has: () => true, ProviderClass: Hetzner, operatorScopes: ['provider:hetzner'], env: { HETZNER_API_TOKEN: '"abc"' } })` throws with a message that starts `Configuration problems (nothing was provisioned):` and contains the Hetzner line and `Set them in .env.local`; with a good env it does not throw; problems for two scopes are listed together. Integration: seed a fixture project with a quoted Hetzner token in `.env.local` (fake value), run `deploy prod -y` via the harness with the provider stubbed as the existing deploy tests do, and assert non-zero exit, the `Configuration problems` line on stderr/stdout, and that no provider API call happened (use whatever the existing deploy integration tests use to observe provider calls; if none, assert on the absence of the "Creating server" progress line).

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Preflight: after the host-tool check, `const { problems } = checkOperatorConfig(operatorScopes, { env }); if (problems.length) throw new Error(['Configuration problems (nothing was provisioned):', ...problems.map((p) => `  - ${p}`), 'Set them in .env.local (never committed; see .env.local.example for each variable\'s format).'].join('\n'));`. Orchestrator: compute scopes from the resolved config (provider id, `dnsProvider`, registry usage, and always `access`/`tls`/`state`) and pass them.
- [ ] **Step 4: Verify** unit + cli. **Step 5: Commit** `feat(deploy): refuse to start on malformed operator configuration, listing every problem at once`.

---

### Task 5: `status` Configuration line

**Files:**
- Modify: `src/status.js` (~1285-1300, next to the `Access:` advisory): a pure `formatConfigurationLines(problems, checked)` and the call in the local block, keyed on the project's configured provider (`providerFor(projectConfig)` or the first environment's provider) plus each deployed environment's DNS scope; shown even with no environments
- Test: `tests/unit/status/configuration-line.test.ts`; integration `tests/integration/cli/status/` one case

- [ ] **Step 1: Tests.** `formatConfigurationLines([], ['HETZNER_API_TOKEN', …])` → one line `Configuration ● ok  (4 variables checked)` (green); with problems → `▲ Configuration: 2 problems` followed by one indented line per problem (yellow); integration: a fixture project whose `.env.local` has a fake quoted Hetzner token → `status` (TTY not required; check `-json` too: `localDev.configuration = { problems: [...], checked: [...] }`) shows the line and exits 0.
- [ ] **Step 2-5:** RED, implement (reuse `checkOperatorConfig`; never print values), verify, commit `feat(status): configuration advisory line from the same checks deploy enforces`.

---

### Task 6: `configure` prompts validate through the registry (Phase 2)

**Files:**
- Modify: `src/configure.js` (`promptText(message, currentValue, options)` and `promptSecret(message, currentValue, options)` gain `options.entry`; every call site passes `entry: registryEntry('<KEY>')` for the key it writes — enumerate all ~25 call sites; `requireNonEmpty` stays for values with no registry entry)
- Test: `tests/unit/configure/prompt-validation.test.ts` (create; mock `@clack/prompts` the way `tests/unit/licensing/activate-command.test.ts` does, capture the `validate` callback and the returned value)

- [ ] **Step 1: Tests.** With `entry: registryEntry('STRIPE_SECRET_KEY')`: `validate('pk_test_x')` returns `STRIPE_SECRET_KEY looks wrong: expected sk_live_… or sk_test_…, got 9 characters`; `validate(' "sk_test_abc" ')` returns `undefined` (normalized before validation) and the helper's return value is `sk_test_abc` (normalized); pressing Enter on an existing value still keeps it; a prompt without `entry` behaves exactly as before. A census-style test: every `promptText(`/`promptSecret(` call in `src/configure.js` whose result is written to a registered key passes an `entry` (walk the file: find each `setEnvVar`/result-key assignment and the prompt feeding it; simplest robust form: assert that every `promptText(`/`promptSecret(` call site in the file contains `entry:`, and list the exceptions explicitly with a reason).
- [ ] **Step 2-5:** RED, implement (inside `validate`: `const { value } = normalizeOperatorValue(raw, entry); return validateOperatorValue(value, entry) ?? undefined;` and return the normalized value from the helper), verify with `pnpm test:unit`, commit `feat(configure): validate every prompted value against its registry shape before writing it`.

---

### Task 7: Documentation files and the docs census

**Files:**
- Create: `carbon/.env.local.example` (every `where: '.env.local'` / `'operator shell'` entry, grouped by scope, each preceded by `# format: <describe>` and a one-line purpose; secrets shown as empty)
- Modify: `carbon/.env.example` (add `# format: <describe>` above each registered `.env` key; add any registered `.env` key that is missing), `tests/.env.e2e.example` (`# format:` for `VIBECARBON_LICENSE_PRIVATE_KEY`: `PEM or base64-encoded PEM`)
- Modify: template scaffolding so `create` copies `.env.local.example` into new projects (find where `.env.example` is copied in `src/create.js` / template bundle and add the sibling); `.gitignore` in the template already ignores `.env.local` (verify)
- Test: `tests/unit/lib/env-docs-census.test.ts` (create)

- [ ] **Step 1: Census test (fails first):** for every registry entry, the file named by `where` (`.env.local`/`operator shell` → `carbon/.env.local.example`; `.env` → `carbon/.env.example`; `tests/.env.e2e` → `tests/.env.e2e.example`) contains a line `^KEY=` and, within the 3 lines above it, `# format: <describe>` where `<describe>` equals `entry.shape?.describe ?? '<kind prose>'` (define the kind prose table in the test: `token → 'an opaque token'`, `secret → 'an opaque secret'`, etc.). Conversely every `^KEY=` in those example files is a registry entry or is read by `carbon/src` (walk `carbon/src/**/*.ts` for `process.env.KEY`/`env.KEY`) — nothing documented is dead.
- [ ] **Step 2-5:** RED, write the files (`# format:` prose copied from `describe`), wire `create`, run `pnpm test:template` too, commit `docs(template): .env.local.example for operator credentials; format lines everywhere, census-enforced`.

---

### Task 8: Gate and PR

- [ ] `pnpm test:prepush` green (lint 0 warnings, unit, integration), plus `pnpm test:template`.
- [ ] Push `feat/operator-config-hygiene`; `gh pr create --base main` with a summary of the three surfaces (prompt, preflight, status), the census, the new `.env.local.example`, and a **Compatibility** note: values that were previously read verbatim are now trimmed/unquoted (a fix); deploy now refuses malformed configuration before provisioning; existing projects get `.env.local.example` via `vibecarbon upgrade`.

---

## Self-review

- Spec §1 registry → Task 1; §2 reader → Task 2; §3 surfaces → Tasks 4 (preflight) and 5 (status); §4 census → Tasks 3 (reads) and 7 (docs); §5 Phase 2 → Task 6; §6 rollout → Task 8. Decisions 1-3 are encoded in Task 1's tight-list test, Task 5's "shown even with no environments", and Task 6's inclusion.
- Placeholder scan: Task 6's "~25 call sites" and Task 3's "wherever CLOUDFLARE_API_TOKEN is read" are enumeration instructions with the grep to run, not TODOs.
- Type consistency: `entry` objects from `registryEntry` are what Tasks 2, 5, 6 consume; `checkOperatorConfig(scopes, { env })` signature is identical in Tasks 2, 4, 5; problem-string format `${key} looks wrong: expected ${describe}, got ${n} characters` is pinned once in Task 2 and asserted verbatim in Tasks 4 and 6.
