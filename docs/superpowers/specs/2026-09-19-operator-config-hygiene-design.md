# Operator configuration hygiene — design

**Date:** 2026-09-19
**Status:** draft for Brandon's review
**Trigger:** the licence-signing-key incident (2026-09-19). One value, three silent drifts (name renamed at PR #103, location `.env` vs `.env.local`, encoding base64 vs PEM), docs describing only one of them, and a failure surfaced minutes later as an unrelated error. The CLI fix (`normalizePem`, accept either encoding) closed that instance. This spec closes the class for the values vibecarbon's users actually handle.

## Problem

Users copy values between systems with an implicit contract on name, location, and shape: provider API tokens, object-storage key pairs, DNS tokens, registry credentials, SSH allowlists. Today:

- The only ingress validation is "is it set". `resolveProviderToken` (`src/lib/providers/index.js:151`) returns `process.env[Provider.TOKEN_ENV] || null`; deploy preflight (`src/lib/deploy/preflight.js:112`) checks host tools, not configuration.
- A value with stray quotes, a trailing newline, a `Bearer ` prefix, or the wrong encoding passes preflight and fails 5-20 minutes later inside a provider API call, a Pulumi run, or an S3 handshake, with the provider's error text and the user's bill for the VM that was already created.
- `carbon/.env.example` (55 variables) is prose. Nothing checks that every variable the code reads is documented, that the documented name is the current name, or that the documented shape is the accepted one. The e2e example carried a stale name for 3 days and a wrong encoding since the file was written.

## Goals

1. **Normalize on ingress.** Every operator-supplied value passes through one reader that absorbs the harmless variance users produce (whitespace, surrounding quotes, `\n` escapes, `Bearer ` prefixes, base64-vs-PEM for key material) before any code sees it.
2. **Validate shape before infrastructure.** Deploy refuses to start, and `status` warns, when a required value is missing or malformed, naming the variable, what was expected, what was found (without echoing the secret), and where to set it.
3. **Docs can't drift from code.** An enumerable invariant: every operator-facing variable the code reads is documented in `.env.example` with its accepted forms, and every documented variable is read somewhere.

## Non-goals

- Validating values `configure` collects interactively (SMTP, OAuth, billing). Those prompts have their own validators; they're a later phase using the same registry.
- Verifying credentials against the provider (an API call). Shape only; liveness stays where it is (provider preflight ping in e2e, first API call in deploy).
- Changing where values live. `.env.local` (never leaves the machine) vs `.env` (ships in the server bundle) is a real distinction the existing `localOnly` machinery already enforces.

## Design

### 1. Variable registry (`src/lib/operator-env/registry.js`)

One declarative table, the single source of truth for name, owner, shape, and docs:

```js
export const OPERATOR_VARS = [
  { name: 'HETZNER_API_TOKEN',   scope: 'provider:hetzner', kind: 'token',  shape: { regex: /^[A-Za-z0-9]{64}$/, describe: '64 alphanumeric characters' }, where: '.env.local' },
  { name: 'HETZNER_ACCESS_KEY',  scope: 'provider:hetzner', kind: 'token',  shape: { minLen: 16 }, where: '.env.local' },
  { name: 'HETZNER_SECRET_KEY',  scope: 'provider:hetzner', kind: 'secret', shape: { minLen: 16 }, where: '.env.local' },
  { name: 'HETZNER_STORAGE_REGION', scope: 'provider:hetzner', kind: 'slug', shape: { regex: /^[a-z]{3}$/ , describe: 'a three-letter Hetzner location (fsn1, nbg1, hel1)' }, where: '.env.local', optional: true },
  { name: 'CLOUDFLARE_API_TOKEN', scope: 'dns:cloudflare', kind: 'token', shape: { regex: /^[A-Za-z0-9_-]{40}$/, describe: '40-character API token (not the Global API Key)' }, where: '.env.local' },
  { name: 'DOCKER_HUB_TOKEN',     scope: 'registry',        kind: 'token', shape: { regex: /^dckr_pat_[A-Za-z0-9_-]+$/, describe: 'a Docker Hub personal access token (dckr_pat_…)' }, where: 'operator shell' },
  { name: 'ALLOWED_SSH_IPS',      scope: 'access',          kind: 'cidr-list', shape: { each: /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/, describe: 'comma-separated IPv4 CIDRs' }, where: '.env', optional: true },
  // … one row per operator-facing variable; providers contribute their rows via a static on the Provider class so provider N+1 registers itself.
];
```

Provider rows come from the provider class (`static OPERATOR_VARS = [...]`, next to the existing `TOKEN_ENV` / `OBJECT_STORAGE_ENV`), so the registry is assembled, not hand-listed, for the provider family. Shapes are deliberately loose where the vendor's format is undocumented (`minLen`), tight where it is public (Hetzner tokens, Docker PATs). A wrong tight shape is a bug we'd see immediately in CI; a loose one still catches quotes and newlines.

### 2. Normalizing reader (`src/lib/operator-env/read.js`)

```js
export function readOperatorVar(name, { env = process.env, registry = OPERATOR_VARS } = {})
// -> { value: string | null, problems: string[], fixed: string[] }
```

`fixed` lists the normalizations that were applied (for a `-v`/debug line, never for the value itself): trimmed whitespace, stripped matching surrounding quotes, removed `Bearer ` prefix (kind `token`), expanded literal `\n` (kind `pem`), base64-decoded to PEM (kind `pem`, reusing `normalizePem` from `scripts/generate-license.js`, which moves into this module and is re-exported from its old path). `problems` lists shape violations in user language, computed on the normalized value: `HETZNER_API_TOKEN looks wrong: expected 64 alphanumeric characters, got 65 (a trailing newline or quote?)`. The length hint is safe to print; the value never is.

`resolveProviderToken` and every `process.env[X]` read of a registered variable go through `readOperatorVar`. A census (§4) enforces that.

### 3. Two surfaces

**Deploy preflight (hard gate).** `checkDeployPrerequisites` gains `checkOperatorConfig(scopeSelectors)` which evaluates the registry rows for the deploy's provider, DNS backend, and registry (scopes are derived from the env config, the same way `requiredEnv` is unioned in the e2e runner), and throws before any infrastructure call with every problem listed at once:

```
Configuration problems (nothing was provisioned):
  - HETZNER_API_TOKEN looks wrong: expected 64 alphanumeric characters, got 65 (a trailing newline or quote?)
  - CLOUDFLARE_API_TOKEN is not set — this environment uses Cloudflare DNS
Set them in .env.local (never committed; see .env.example for each variable's format).
```

**`status` advisory (soft).** The Local Development block already prints `▲ Access: no operator CIDRs configured …`. It gains a `Configuration` line per deployed environment's scopes: `Configuration ● ok` or `▲ HETZNER_API_TOKEN looks wrong …`. Same reader, same messages, no exit-code change. This is where a user sees a problem *before* they run deploy.

### 4. Census (the enumerable invariant)

`tests/unit/operator-env/census.test.ts` walks `src/**/*.js` and asserts, for every environment-variable read (`process.env.X`, `process.env[X]`, `getEnvValue('X')`, `Provider.*_ENV` statics):

- If `X` is operator-facing (not in the explicit `RUNTIME_DETECTION` allowlist: `CI`, `GITHUB_ACTIONS`, `HOME`, `PATH`, `DEBUG`, `VITEST`, `DISPLAY`, …), then `X` has a registry row, and the read site goes through `readOperatorVar` (source-shape check, like the signing-key ingress census).
- Every registry row's `name` appears in `carbon/.env.example` (or `tests/.env.e2e.example` for `scope: 'e2e'`) with a `# format:` comment line above it, and that comment mentions the same `describe` text as the shape (so the doc *is* the shape's prose, generated or compared).
- Every `X=` in `.env.example` is either a registry row or a template-app variable read by `carbon/src` (walked the same way), so nothing documented is dead.

A new variable that isn't registered fails the suite; a rename that leaves the example stale fails the suite; a shape whose prose drifts from its regex fails the suite. That is what the licence-key incident lacked.

### 5. Rollout

- Phase 1 (this spec): registry + reader + preflight + status line + census, provider rows for Hetzner, DigitalOcean, Linode, Vultr, Scaleway, plus Cloudflare, Docker Hub, `ALLOWED_SSH_IPS`, `PULUMI_BACKEND_URL`, `ACME_CA_SERVER`. e2e example rows (`VIBECARBON_LICENSE_PRIVATE_KEY`, kind `pem`) so the harness benefits too.
- Phase 2 (later spec): `configure`-collected values use the same registry rows at prompt time.

## Error handling

- A registry row with a broken regex is a startup crash in unit tests (census evaluates every shape against a synthetic valid sample per row: `sample` is a required field, so each shape is exercised).
- `readOperatorVar` never throws; missing = `value: null` with a problem only when the row is not `optional`.
- Preflight prints all problems, not the first; users fix once.

## Testing

Unit: reader normalizations (each `fixed` kind, with and without the kind that permits it), shape messages (length hint, never the value), preflight aggregation, status line rendering. Census as above. Integration (`test:cli`): `deploy` with a token wrapped in quotes exits non-zero before any provider call with the expected message; `status` shows the advisory. e2e: unaffected; CI secrets are already the right shape.

## Open questions for Brandon

1. Tight vs loose shapes for providers whose token formats aren't public (Linode, Vultr, Scaleway): loose (`minLen`) by default, tighten as we learn? (Recommended: yes.)
2. Should `status` show the Configuration line even with no environments deployed (i.e. pre-first-deploy guidance)? (Recommended: yes, keyed on the project's configured provider.)
3. Phase 2 timing.
