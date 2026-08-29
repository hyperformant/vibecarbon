# Adding a Cloud Provider

The canonical checklist for bringing a new provider (compute + object
storage) into vibecarbon. It supersedes the 4-step comment in
`src/lib/providers/base.js`: that comment understates the real surface. The
DigitalOcean provider (`src/lib/providers/digitalocean.js`) is the worked
reference implementation for every step here.

The test suite is built so that most of this list is **enforced, not
remembered**: registering the class in `PROVIDERS` (step 2) trips a chain of
censuses that stay red until steps 3–7 are done. Work in whatever order you
like. The suite tells you what is missing. The guard-decision table in
`docs/tests.md` still applies to every fix you make along the way.

## 1. Implement the classes

- `src/lib/providers/<id>.js`: `class <Name>Provider extends BaseProvider`.
  Implement **every** abstract member: ~23 data statics, 16 abstract static
  methods (catalog, user-data renderers, Pulumi program loaders,
  guided-setup prompts, `getObjectStorageProviderClass`), and ~31 abstract
  instance methods (server CRUD, firewall ops, listings with completeness
  signals, the destroy-sweep field accessors). The abstract-surface
  completeness check in `provider-contract.test.ts` fails on any member
  still resolving to the base class's throwing stub. Inherited stubs do
  not count as implemented.
- `src/lib/providers/<id>-<storage>.js`: `extends S3CompatibleProvider`
  with `ENDPOINTS`, `REGIONS` (slug → human description map: the S3
  contract suite rejects arrays), and `resolveS3Region`. Keep it thin; all
  real S3 behavior lives in `s3-base.js`.
- `src/lib/iac/programs/<id>-compose.js` and `<id>-k8s.js`: Pulumi
  programs. The k8s program must use the shared naming templates
  (`<clusterName>-network` / `-firewall` / `<clusterName>-<region>-key`);
  `k8s-naming-parity.test.ts` discovers `*-k8s.js` files automatically and
  pins them.

## 2. Register

- Add the class to `PROVIDERS` in `src/lib/providers/index.js`. An
  implemented-but-unregistered module fails
  `provider-registration-census.test.ts`, and registration immediately
  drafts the class into every registry-driven suite below.

## 3. Satisfy the unit censuses (they are now red)

- `tests/_shared/provider-expected.ts`: pinned identity/credential values
  (TOKEN_ENV, CLI_TOKEN_ENV, PROVIDER_ID_PREFIX…). Two-way locked with the
  registry.
- `provider-contract.test.ts`: ~25 invoked invariants plus the
  abstract-surface completeness check run automatically.
- `s3-provider-contract.test.ts`: S3 shape/bijection/resolveS3Region
  totality run automatically via `getObjectStorageProviderClass()`.
- `k8s-storage-class-literal-guard.test.ts`: your `K8S_STORAGE_CLASS`
  literal is banned outside your provider file automatically.
- `k8s-image-mirrors.test.ts`: if you declare `K8S_ASSETS.csiNodeDaemonSet`
  you must ship a CSI sidecar mirror spec.
- `transient-classifier-census.test.ts`: any new retry classifier you add
  must be registered with a domain and meet its floor. Prefer reusing
  fetch-retry / s3-base / DEPLOY_TRANSIENT over writing a new one.

## 4. E2E wiring

- `tests/config.ts`: a `capacityPreferences.<id>` block and a scenario
  array (one entry per `SUPPORTED_TIERS` tier).
  `supported-tiers-scenario-coverage.test.ts` fails until both exist and
  its `SCENARIOS_BY_PROVIDER` map carries the new id.
- `tests/e2e/runner.ts`: token read + needs-gate + capacity/token switch,
  and the opt-in scenario-prefix matcher.
- `tests/e2e/utils/region-resolver.ts`: a `CAPACITY_RESOLVERS` row (the
  dispatcher throws on unknown ids; inventory loading is genuinely
  per-provider).
- `tests/e2e/utils/preflight.ts`: API-health, project-clean, and
  object-storage checks, wired into `runPreflight`.
- **Teardown sweep**: a provider-specific orphan sweep dispatched from
  `_run-lifecycle.ts`'s teardown switch (see
  `tests/e2e/utils/sweep-digitalocean.ts` as the model: instance-API
  deletes, completeness-aware enumeration, cloud-named banner). The switch's
  default arm prints a loud `[sweep] REGRESSION` for an id with no sweep.
  Never leave a provider on that arm.
- Credential seeding, provider tokens, and cred keys inside the lifecycle
  derive from `TOKEN_ENV` / `OBJECT_STORAGE_ENV` automatically.

## 5. CI

`.github/workflows/e2e-us-perf.yml` runs one `matrix` job instance per
provider (`strategy.matrix.provider`) plus a single `publish-perf` collector
job that patches README from every leg's uploaded `e2e.db`
(`tests/e2e/metrics/publish-perf-pr.ts`).

- Add the provider's token/storage secrets to the `e2e-infra` GitHub
  Environment (secrets via GitHub Environments, never committed
  ciphertext) and map them in the `matrix` job's "Run e2e (provider leg)"
  step env (both providers' secrets are present on every leg: the
  runner's registry-driven credential preflight only requires the
  SELECTED provider's vars) and in the "Scrub secret values from
  artifacts" step's redaction list.
- Add the provider to the `matrix` job's two hand-maintained lists (the
  `provider:` workflow_dispatch input's `options:` and the
  `fromJSON('["hetzner","digitalocean"]')` literal in the matrix `strategy`
  expression) and to a namespace-scoped safety-net sweep step (model:
  `tests/e2e/sweep-digitalocean-ci.ts`, which self-skips without a token and
  exits nonzero on incomplete enumeration), gated `if: always() && matrix.provider
  == '<id>'` so a leg never sweeps a cloud it never touched.
  `tests/unit/e2e/workflow-provider-census.test.ts` fails on both lists
  until the new provider is in `tests/config.ts` `e2e.providers` AND named
  here: it's a census, not a hand-list, so a missed entry is loud rather
  than a silently-unreachable dispatch option.

## 6. Docs & policy

- `docs/deploy-<id>.md`: operator setup guide (see the Hetzner/DO ones).
- Pricing watchlist entry if the provider's catalog is pinned anywhere
  (watchlists need spec, source URL, refresh cadence).
- No `sha256` digest-pinned image refs in templates; floating/version tags
  only.

## 7. Prove it on real infra

- Run the provider's scenarios end-to-end (`--scenario <x1>` style, opt-in
  tokens): deploy, verify, scale, backup, destroy, restore, and confirm
  the teardown sweep banner names your cloud and reports clean. No
  e2e shortcuts a customer couldn't reuse.
