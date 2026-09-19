# Operator configuration hygiene — design

**Date:** 2026-09-19
**Status:** approved 2026-09-19 (Brandon: loose shapes unless the vendor documents one; Configuration line pre-deploy; Phases 1 and 2 together)
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

- Verifying credentials against the provider (an API call). Shape only; liveness stays where it is (provider preflight ping in e2e, first API call in deploy).
- Changing where values live. `.env.local` (never leaves the machine) vs `.env` (ships in the server bundle) is a real distinction the existing `localOnly` machinery already enforces.

## Design

### 1. Variable registry (extend `src/lib/config-registry.js`)

`CONFIG_KEYS` already is the single source of truth for the 52 keys `configure` manages, classed `client-build` / `runtime-config` / `runtime-secret` / `operator-secret`, dependency-free, with coverage tests asserting every deploy path derives from it. The spec's registry is that table with per-entry shape metadata, not a second table:

```js
{ key: 'HETZNER_API_TOKEN', class: 'operator-secret', feature: 'providers',
  kind: 'token', shape: { regex: /^[A-Za-z0-9]{64}$/, describe: '64 alphanumeric characters' }, sample: 'a'.repeat(64) },
{ key: 'STRIPE_SECRET_KEY', class: 'runtime-secret', feature: 'billing',
  kind: 'token', shape: { regex: /^sk_(live|test)_[A-Za-z0-9]+$/, describe: 'sk_live_… or sk_test_…' }, sample: 'sk_test_abc123' },
{ key: 'LINODE_API_TOKEN', class: 'operator-secret', feature: 'providers',
  kind: 'token', shape: { minLen: 16, describe: 'at least 16 characters' }, sample: 'x'.repeat(32) },
{ key: 'SMTP_PORT', class: 'runtime-config', feature: 'smtp',
  kind: 'port', shape: { describe: '1-65535' }, sample: '587' },
```

`kind` ∈ `token | secret | id | slug | hostname | port | email | url | cidr-list | pem | enum | flag`; `shape` is tight only where the vendor documents the format (Brandon, 2026-09-19), `minLen` otherwise; `sample` is required for every entry with a shape and is what the census feeds through the validator. Keys the code reads but the registry lacks today, and which the census forces in: `DOCKER_HUB_USERNAME`, `DOCKER_HUB_TOKEN` (`^dckr_pat_`), `ALLOWED_SSH_IPS` (cidr-list), `HETZNER_STORAGE_REGION` / `DIGITALOCEAN_STORAGE_REGION` / `SCALEWAY_STORAGE_REGION` (slug), `PULUMI_BACKEND_URL` (url), `ACME_CA_SERVER` (url), and the e2e `VIBECARBON_LICENSE_PRIVATE_KEY` (pem, `scope: 'e2e'`, documented in `tests/.env.e2e.example`). Provider classes keep their `TOKEN_ENV` / `OBJECT_STORAGE_ENV` / `S3_REGION_ENV` statics; a census asserts every such static names a registry key.

### 2. Normalizing reader (`src/lib/operator-env.js`)

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

**`status` advisory (soft).** The Local Development block already prints `▲ Access: no operator CIDRs configured …`. It gains a `Configuration` line for the project's configured provider (and each deployed environment's DNS/registry scopes), shown even before the first deploy: `Configuration ● ok` or `▲ HETZNER_API_TOKEN looks wrong …`. Same reader, same messages, no exit-code change. This is where a user sees a problem *before* they run deploy.

### 4. Census (the enumerable invariant)

`tests/unit/operator-env/census.test.ts` walks `src/**/*.js` and asserts, for every environment-variable read (`process.env.X`, `process.env[X]`, `getEnvValue('X')`, `Provider.*_ENV` statics):

- If `X` is operator-facing (not in the explicit `RUNTIME_DETECTION` allowlist: `CI`, `GITHUB_ACTIONS`, `HOME`, `PATH`, `DEBUG`, `VITEST`, `DISPLAY`, …), then `X` has a registry row, and the read site goes through `readOperatorVar` (source-shape check, like the signing-key ingress census).
- Every registry entry is documented with a `# format: <describe>` line above it: `client-build` / `runtime-*` keys in `carbon/.env.example` (ships in the bundle), `operator-secret` keys in a new `carbon/.env.local.example` (the file `configure` actually writes; today those 19 keys plus Docker Hub, `ALLOWED_SSH_IPS`, storage regions, `PULUMI_BACKEND_URL`, `ACME_CA_SERVER` are documented nowhere in the template), `scope: 'e2e'` keys in `tests/.env.e2e.example`. The comment's prose must equal the entry's `describe`, so the doc *is* the shape.
- Every `X=` in `.env.example` is either a registry row or a template-app variable read by `carbon/src` (walked the same way), so nothing documented is dead.

A new variable that isn't registered fails the suite; a rename that leaves the example stale fails the suite; a shape whose prose drifts from its regex fails the suite. That is what the licence-key incident lacked.

### 5. Phase 2: `configure` values validated at the prompt

`configure` collects ~25 values through two helpers, `promptText` and `promptSecret` (`src/configure.js:138-176`), whose only validation today is `requireNonEmpty`. Both helpers gain an optional `row` argument (a registry row); when present:

- the entered value is normalized with the same reader as Phase 1 (`normalizeOperatorValue(raw, row)`: trim, strip matching quotes, strip `Bearer `), and
- the shape is checked *inside* the clack `validate` callback, so the user sees `Stripe secret key looks wrong: expected sk_live_… or sk_test_…` and re-enters immediately, before anything is written.

Registry rows for the `configure` family, tight only where the vendor documents the format: Stripe secret (`^sk_(live|test)_`), Stripe webhook secret (`^whsec_`), Resend (`^re_`), SendGrid (`^SG\.`), Postmark server token (UUID), Google client ID (`\.apps\.googleusercontent\.com$`), Google client secret (`^GOCSPX-`), Microsoft tenant ID (UUID), Polar access token (`^polar_`), Polar/Paddle price IDs and org IDs (`minLen` only), SMTP host (hostname), SMTP port (1-65535), sender address (email). These rows carry `scope: 'configure:<section>'` and `where: '.env'` (they ship in the server bundle) so Phase 1's preflight and `status` line also cover them once written.

Phase 2 is why the registry, not the validators, is the source of truth: the same row validates at the prompt, at deploy preflight, and in `status`, and the census proves every `configure` prompt that writes an env var has a row.

### 6. Rollout

Phases 1 and 2 ship together (Brandon, 2026-09-19: catching a bad value at the prompt is the earliest possible point). Provider rows for Hetzner, DigitalOcean, Linode, Vultr, Scaleway (tight only for Hetzner's documented 64-char token; the others `minLen`); Cloudflare, Docker Hub, `ALLOWED_SSH_IPS`, `PULUMI_BACKEND_URL`, `ACME_CA_SERVER`; the `configure` family above; e2e rows (`VIBECARBON_LICENSE_PRIVATE_KEY`, kind `pem`).

## Error handling

- A registry row with a broken regex is a startup crash in unit tests (census evaluates every shape against a synthetic valid sample per row: `sample` is a required field, so each shape is exercised).
- `readOperatorVar` never throws; missing = `value: null` with a problem only when the row is not `optional`.
- Preflight prints all problems, not the first; users fix once.

## Testing

Unit: reader normalizations (each `fixed` kind, with and without the kind that permits it), shape messages (length hint, never the value), preflight aggregation, status line rendering. Census as above. Integration (`test:cli`): `deploy` with a token wrapped in quotes exits non-zero before any provider call with the expected message; `status` shows the advisory. e2e: unaffected; CI secrets are already the right shape.

## Decisions (Brandon, 2026-09-19)

1. Shapes are tight only where the vendor documents the format; loose (`minLen`, no quotes/whitespace) otherwise.
2. `status` shows the Configuration line even before the first deploy, keyed on the project's configured provider.
3. Phases 1 and 2 ship together.
