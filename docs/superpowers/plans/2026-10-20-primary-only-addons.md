# Primary-only add-ons on HA standbys: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every add-on declares how it behaves on an HA standby, and both HA modes enforce those declarations:
- n8n and Metabase never run on a standby, and start on promotion.
- Redis and observability follow the app tier.

**Architecture:**
- The declaration lives in each `services/<name>/manifest.json`, which ships in the npm package. One loader in `src/lib/services/standby-policy.js` turns it into the lists each consumer needs.
- **k8s-ha:** the pilot-light branch of `applyK3sManifests` zeroes every declared add-on workload with one function. This generalizes `demoteObservabilityOnStandby` from #232. Promotion picks the add-ons up through the persisted `scaleUpList`.
- **compose-ha:** the reconcile, systemd and restore-recreate paths keep the full `-f` set and add a runtime `--scale <svc>=0` fragment when the node's `.env` says `WALG_ROLE=standby`.
  - Dropping the overlay files would not work: the n8n and Metabase overlays also change the `db` service (env and init mount), so a role-dependent `-f` set would recreate `db` on every promotion.
  - Failover starts the primary-only services on the promoted node and stops them on the retired one.

**Tech Stack:**
- Node ESM CLI (`src/`) and vitest (root `pnpm`);
- Docker Compose v2 shell rendered by `src/lib/deploy/bundle.js`;
- kubectl over `runKubectlWithRetry`.

**Base:** branch `feat/primary-only-addons` stacks on `feat/ha-correctness` (PR #235, itself on #234 security, on main with #233). Refreshed 2026-10-21 against that HEAD (3bd9c67); line numbers below are from it.

## Already done by #234 / #235 (do not redo)

- **The retired compose primary's n8n and Metabase are stopped.** HA added `FAILOVER_FENCE_SERVICES = ['app','n8n','metabase']` (`src/lib/deploy/compose/ha.js:1520`) used by the planned-failover pre-promote fence (`stopOldPrimaryWriters`, :1533), the retirement fence's compose writer step (`src/lib/deploy/retired-fence.js` composeBackend `workloadsZero`, :~455), `-abort`'s writer restart, and the e2e retired-node excuse (`tests/e2e/scenarios/_run-lifecycle.ts:3867`). The retired database is also read-only (`default_transaction_read_only`) and refuses its own backups, so Review Focus 3's split-brain class is closed for compose. What is left is that `FAILOVER_FENCE_SERVICES` is a hand list: Task 4 derives it from the declaration.
- **The k8s retired side has a seam.** `reconcileRetiredFence` takes `deps.zeroWorkloads(ip)`; the k8s default only `kubectl scale`s `deployment/app` (`retired-fence.js:353-362`). Task 5 fills the seam.
- **Secrets split.** `N8N_DB_PASSWORD`/`METABASE_DB_PASSWORD` live in `INFRA_SECRET_KEYS` (`src/lib/deploy/k8s/k3s.js:1823`) and the n8n Deployment reads `vibecarbon-infra-secrets`. The app's allowlist (`src/lib/deploy/app-runtime-env.js`, census-pinned) must never gain an n8n key.
- **compose-ha reconverge** (`src/lib/deploy/effects/compose-ha.js` `reconvergeStandbyStack` :728, `reconcileRebuiltStandby` :1042) starts the rebuilt standby with `startComposeStack`, which runs `reconcile.sh`; `haMergeWalgRole` writes `WALG_ROLE=standby` into its `.env` first. So Task 3's runtime `--scale` fragment covers the reconverge with no extra code; Task 3 only asserts it.

**Spec:** the parent session's item 5 answer: "Treat n8n, Metabase and Redis like observability: primary-only … don't start them on a standby, start them on promotion, add a test requiring every add-on to declare whether it's primary-only". This plan refines one point, recorded as ruling R1.

## Rulings made while planning (from the code)

- **R1. Redis is not primary-only.**
  - `carbon/src/server/lib/rate-limiter.ts` makes Redis an app-tier dependency: the redis overlay injects `REDIS_URL` into `app`.
  - n8n's queue mode needs it too: `QUEUE_BULL_REDIS_HOST=redis`.
  - The compose-ha standby runs its app tier (`haStartComposeStack` starts both nodes; Cloudflare/Hetzner LB health-checks can send it traffic). So Redis stays wherever the app runs. Two policies:
    - `primary-only`: off on every standby in both modes (n8n, Metabase). Their databases are the read-only replica, and n8n would fire schedules and webhooks twice.
    - `with-app-tier`: runs wherever the app runs (Redis, observability). Today that is on the compose-ha standby and zeroed on the k8s-ha pilot-light standby, whose app is zeroed.
  - Cost if wrong: Redis's few MB idle on the compose-ha standby.
- **R2. The k8s failover `scaleUpList` gains the add-on Deployments in namespace `vibecarbon`.** Those are n8n, Metabase and Redis, each at its manifest replica count.
  - Observability stays out: it is applied outside `k8s/base`, its namespace is absent on a fresh standby, and its `grafana-tls` issuer re-point belongs to the reconverge (#231/#232 prove it there).
  - `gatePromotedApiReadiness` rolls the list out in parallel, 120 s each, so this adds at most the slowest add-on's rollout to RTO. Measure it in Task 6.
- **R3. Compose promotion starts only long-running services, never the one-shot `*-setup` jobs.** Setup already ran on the original primary, and its results live in the replicated database.
- **R4. n8n needs a shared, generated `N8N_ENCRYPTION_KEY`.** Promotion cannot work without it, so it is folded in as Task 2.
  - `services/n8n/compose/docker-compose.yml` sets no key, so n8n generates a random one in each node's `n8n_data` volume. The workflows and credentials are replicated in Postgres, so a promoted node's n8n cannot decrypt them.
  - `carbon/docker-compose.n8n.yml:41` defaults to the literal `n8n_dev_encryption_key`, a public key if it ever reaches a server. Task 2 removes the default (fail fast) in both copies.
  - The key is an infra secret (n8n reads it, the app never does): k8s `INFRA_SECRET_KEYS` / `vibecarbon-infra-secrets`, never the app allowlist.
  - Compatibility: a dev environment that already stored n8n credentials keeps its old volume key, and n8n refuses to start on a key mismatch. Say so in the commit and the Compatibility note; there are no customers.
- **R5. The compose-ha `-f` set at promotion is read from `reconcile.sh`.** The sed that `scale.js` already uses is extracted into one exported constant, so promotion, restore and reconcile can't drift.
- **R6. No status-command change.**
  - `src/status.js` lists only what `docker ps` or the pods report, and has no expected-container list, so a zero-scaled add-on is simply absent rather than "down".
  - Leftover, not fixed here: the template's admin services-status page (`carbon/src/server/routes/_internal/services-status.ts:337`) on the compose-ha standby would list n8n and Metabase as down. That page is only reached on the primary through DNS. It's noted as out of scope.
- **R7. Duplicate compose files.** `carbon/docker-compose.n8n.yml` and `carbon/docker-compose.metabase.yml` already drift from `services/*/compose/docker-compose.yml`. `services/` is canonical, because `vibecarbon add` copies from it.
  - Task 2 edits both copies so the encryption key lands everywhere.
  - Reconciling the duplication is out of scope; flag it in the final report.

## Global Constraints
- Policy values are exactly `primary-only` and `with-app-tier`. The manifest key is `standby`.
- No hand-written add-on name lists (`'n8n'`, `'metabase'`, `'redis'`) in `src/lib/deploy/**`, `src/failover.js` or `src/scale.js`. Every consumer goes through `src/lib/services/standby-policy.js` (census in Task 1). `FAILOVER_FENCE_SERVICES` is the known existing hand list; Task 4 replaces it.
- Every k8s scale-to-zero uses `kubectl scale`, never a patch or `set image` (HA ruling: no pod roll).
- The compose `-f` set never depends on role. Role-specific behaviour is only the runtime `--scale` fragment.
- dotenv writes only through `formatDotenvLine`. Never hand-parse `.env` in JS. The shell side reads `WALG_ROLE` the way `compose-role-env-census.test.ts` sanctions; check that census before writing the sed.
- Conventional commits, pathspec commits (`git commit -- <files>`), never `--no-verify`, no `!:` footers. Root fixes, no retry ladders.
- Work in `.claude/worktrees/speed-price` on branch `feat/primary-only-addons` off `feat/ha-correctness`. `pnpm typecheck` does not exist; `tsc` runs inside `pnpm lint`.
- Ordering with other plans: this plan lands before the backup-restore plan (both edit `src/scale.js`; that plan declares this dependency). The speed plan's Task 6 edits `effects/compose-ha.js` `haConfigureReplication` and k8s replication timing, not the files here; no conflict beyond `effects/compose-ha.js` rebase noise.

## Review Focus
1. **A compose-ha standby reboots:** the systemd `ExecStart` brings the stack up and n8n and Metabase must stay absent. Task 3 adds a unit assertion on the rendered unit's `$$` fragment, and a test that executes `standby-scale.sh`.
2. **A promotion leaves `db` alone:** the promoted node's `db` container is not recreated by the add-on start (`--no-deps`, same `-f` set). Task 4 asserts the command shape. The real-infra check in Task 6 compares the `db` container id before and after.
3. **The retired primary stops its n8n:** on compose this is already done by #235 (retirement fence, read-only retired DB). This plan must not regress it when Task 4 derives the list. On k8s, Task 5 fills the retirement fence's `zeroWorkloads` seam so the retired cluster's add-ons go to zero too.
4. **Values in `.env`:** `WALG_ROLE` may be written quoted (`WALG_ROLE="standby"`) or be absent (single-server compose). Absent means no scaling. Task 3 runs the script against all four `.env` shapes.
5. **Add-ons installed after the HA deploy:** a project that runs `vibecarbon add n8n` after its HA deploy gets the add-on into `scaleUpList` and `standby-scale.sh` on the next `vibecarbon deploy`, because both are rendered per deploy. Task 5 asserts `deriveScaleUpList` with and without add-ons. Task 3 asserts the bundle re-renders the script from the current services.

---

### Task 1: Standby declaration, loader and census

**Files:**
- Modify: `services/n8n/manifest.json`, `services/metabase/manifest.json`, `services/redis/manifest.json`, `services/observability/manifest.json`
- Create: `src/lib/services/standby-policy.js`
- Test: `tests/unit/services/addon-standby-declaration-census.test.ts`

Manifest values (verbatim):

| add-on | `standby.policy` | `standby.compose.services` | `standby.compose.setup` | `standby.k8s` |
|---|---|---|---|---|
| n8n | `primary-only` | `["n8n"]` | `["n8n-setup"]` | `[{ "kind": "Deployment", "name": "n8n", "namespace": "vibecarbon" }]` |
| metabase | `primary-only` | `["metabase"]` | `["metabase-setup"]` | `[{ "kind": "Deployment", "name": "metabase", "namespace": "vibecarbon" }]` |
| redis | `with-app-tier` | `["redis"]` | `[]` | `[{ "kind": "Deployment", "name": "redis", "namespace": "vibecarbon" }]` |
| observability | `with-app-tier` | `["prometheus","grafana","loki","promtail","postgres-exporter"]` | `[]` | `grafana`, `prometheus` and `loki` Deployments in `vibecarbon-observability` |

**Interfaces (Produces):**
- `loadAddonStandby(name: string): { name, policy: 'primary-only'|'with-app-tier', composeServices: string[], composeSetup: string[], k8s: Array<{kind:'Deployment', name:string, namespace:string}> }`. It reads `services/<name>/manifest.json` relative to the package root, the same way `src/add.js` builds `LOCAL_SERVICES_DIR`, and throws on a missing or invalid `standby`.
- `enabledAddonNames(envConfig): string[]`: the add-on names `envConfig[name]` or `envConfig.services?.[name]` turns on, in `services/index.json` order.
- `enabledK8sAddonNames(projectDir): string[]`: the add-ons whose `k8s/base/<name>/kustomization.yaml` exists in the project.
- `composeStandbyScaledServices(names: string[]): string[]`: the `composeServices` and `composeSetup` of each `primary-only` add-on, in order.
- `composePromotionServices(names: string[]): string[]`: the `composeServices` only (R3) of each `primary-only` add-on.
- `k8sStandbyZeroedWorkloads(names: string[])`: the `k8s` entries of every named add-on, both policies, because the pilot-light app tier is zeroed.
- `k8sFailoverAddonWorkloads(names: string[])`: the `k8s` entries with `namespace === 'vibecarbon'` (R2).
- `composeWriterServices(names: string[]): string[]`: `['app', ...composePromotionServices(names)]`. Task 4 replaces `FAILOVER_FENCE_SERVICES` with it.
- The directory `src/lib/services/` does not exist yet; this task creates it.

- [ ] **Step 1: Write the census test.** It walks every directory under `services/` and asserts, per add-on:
  - `standby.policy` is one of the two values.
  - `composeServices ∪ composeSetup` equals the top-level service keys of `compose/docker-compose.yml` minus the shared `db`, `app` and `traefik` (parse with the `yaml` package already in devDeps).
  - `k8s` equals the set of `kind: Deployment|StatefulSet|DaemonSet` documents across `k8s/*.yaml`. Each entry's namespace comes from `k8s/kustomization.yaml`'s `namespace:` when present, else `vibecarbon`.
  - Source census: `src/lib/deploy/**/*.js`, `src/failover.js` and `src/scale.js` contain no string literal matching `/['"`](n8n|metabase|redis)(-setup)?['"`]/`, except lines in an allowlist that names file and reason. Seed the allowlist by running the grep first; expect `FAILOVER_FENCE_SERVICES` in `compose/ha.js:1520` (allowlist it with "removed in Task 4", and Task 4 deletes the entry). Existing literals unrelated to standby (for example `bundle.js` `COMPOSE_OPTIONAL_FILES` filenames contain `docker-compose.n8n.yml`, which the pattern does not match) stay put. Any true hand list found is either migrated in Tasks 3–5 or allowlisted with a reason.
  - Loader unit tests: `composeStandbyScaledServices(['n8n','redis','metabase'])` is `['n8n','n8n-setup','metabase','metabase-setup']`, and `k8sFailoverAddonWorkloads(['observability','redis'])` is just the redis Deployment.
- [ ] **Step 2: Run the test to verify it fails.** Run `pnpm vitest run tests/unit/services/addon-standby-declaration-census.test.ts`. Expected: FAIL on the missing `standby` keys and the missing module.
- [ ] **Step 3: Implement.** Add the manifest blocks and write `standby-policy.js`.
- [ ] **Step 4: Run the test to verify it passes.** Run the same file, then `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(services): every add-on declares its HA standby behaviour`.

### Task 2: One n8n encryption key per environment (R4)

**Files:**
- Modify:
  - `services/n8n/manifest.json` (`envVars.N8N_ENCRYPTION_KEY: { "generate": "password", "length": 48 }`). `ensureAddonSecrets` (`src/upgrade.js:~202-220`) already generates every manifest `generate: "password"` var, so `vibecarbon add` and `upgrade` heal it with no new code.
  - `services/n8n/compose/docker-compose.yml` (add) and `carbon/docker-compose.n8n.yml:41` (replace the `n8n_dev_encryption_key` default): `- N8N_ENCRYPTION_KEY=${N8N_ENCRYPTION_KEY:?N8N_ENCRYPTION_KEY missing, run vibecarbon upgrade}`. Check `carbon/.env.example:235` and local dev (`scripts/dev-init.js`) still produce a value so `vibecarbon up` doesn't break.
  - `services/n8n/k8s/deployment.yaml` (env `N8N_ENCRYPTION_KEY` from `secretKeyRef vibecarbon-infra-secrets/N8N_ENCRYPTION_KEY`, matching the existing `N8N_DB_PASSWORD` ref at :~66)
  - `src/lib/deploy/k8s/k3s.js` `INFRA_SECRET_KEYS` (:1823) — infra, never `APP_RUNTIME_KEYS`
  - `src/lib/deploy/k8s/gitops-deploy.js:~338` (beside `N8N_DB_PASSWORD`) and the workflow's `INFRA_KEYS` in `carbon/.github/workflows/deploy.yml` (its census pins `INFRA_KEYS == INFRA_SECRET_KEYS`)
  - `src/lib/github-environments.js` (doc line :23 and the key list)
  - `services/n8n/docs/integration.md` (one line)
- Test: extend whichever existing tests pin `N8N_DB_PASSWORD` in those lists. Find them with `git grep -l N8N_DB_PASSWORD tests/`. Also `tests/unit/lib/env-docs-census.test.ts` if it requires docs for new env names.

- [ ] **Step 1: Write the tests.** Wherever a test asserts `N8N_DB_PASSWORD` membership, add the same assertion for `N8N_ENCRYPTION_KEY`. Assert it is NOT in `APP_RUNTIME_KEYS` / the GitOps `APP_KEYS` (extend `tests/unit/deploy/app-runtime-env-census.test.ts`), and that a rendered production compose `app` service never receives it (`tests/integration/docker/compose-secret-reach.test.ts` sentinel). Add a test that `upgrade.js`'s manifest-password generation (around `src/upgrade.js:188`) produces `N8N_ENCRYPTION_KEY` for a project with n8n installed and none set.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.** Run `pnpm test:unit && pnpm test:integration`.
- [ ] **Step 5: Commit** with `fix(n8n): one encryption key per environment so a promoted standby can read credentials`. Include a Compatibility note per R4.

### Task 3: compose-ha keeps primary-only add-ons at zero on a standby

**Files:**
- Modify:
  - `src/lib/deploy/bundle.js`: `renderReconcileScript` (:56, `up` line :138), `renderSystemdUnit` (:154, `ExecStart` :172), the stage writes (`reconcile.sh` at :423), and a new exported renderer and constants.
  - `src/scale.js:~900-925`: the restore recreate (its inline `sed -n` on `reconcile.sh` at :922 becomes `RECONCILE_FLAGS_SED`).
- Test:
  - `tests/unit/deploy/compose-ha-overlay-up-flags.test.ts` (extend the sed-vs-renderer lockstep);
  - new `tests/unit/deploy/standby-scale-script.test.ts`;
  - new `tests/integration/docker/compose-scale-zero.test.ts`, gated `DOCKER_INTEGRATION=true` like its siblings.

**Interfaces:**
- Consumes `composeStandbyScaledServices` from Task 1, with names taken from the bundle options (`n8n`, `metabase`, `redis` and `observability` booleans).
- Produces, in `bundle.js`:
  - `STANDBY_SCALE_SCRIPT = 'standby-scale.sh'`;
  - `renderStandbyScaleScript(services: string[]): string`;
  - `STANDBY_SCALE_FLAG`, the shell fragment ``$([ -f standby-scale.sh ] && sh standby-scale.sh)``;
  - `STANDBY_SCALE_FLAG_SYSTEMD`, the same with `$$`;
  - `RECONCILE_FLAGS_SED`, the sed expression that extracts the baked `-f` set from `reconcile.sh`. It is moved out of `scale.js` and loosened so the `up -d --remove-orphans` line may carry trailing arguments.

Behaviour of the rendered `standby-scale.sh`:
- It runs from the project directory.
- It reads the last `WALG_ROLE=` line of `.env`, with optional single or double quotes.
- When the value is `standby`, it prints `--scale <svc>=0` for each service, space-separated, on one line.
- It prints nothing otherwise, including when `.env` or the key is absent.
- It always exits 0. With an empty service list it prints nothing.

Placement:
- `reconcile.sh`'s `up` line becomes `docker compose ${flags} ${repl} up -d --remove-orphans ${STANDBY_SCALE_FLAG}`.
- The systemd `ExecStart` gets the `$$` variant. `ExecStop` is unchanged.
- The `config > .vc-render-last.yaml` and `pull` lines are unchanged: scale is not part of the rendered config.
- `scale.js` uses `RECONCILE_FLAGS_SED` and appends `STANDBY_SCALE_FLAG` to its `up -d --force-recreate`.

- [ ] **Step 1: Write the failing tests.**
  - `standby-scale-script.test.ts` writes the rendered script plus a `.env` into a temp dir and runs `sh standby-scale.sh` through `execFileSync`. Cases:
    - `WALG_ROLE=standby` gives `--scale n8n=0 --scale n8n-setup=0`;
    - `WALG_ROLE="standby"` gives the same;
    - `WALG_ROLE=primary` gives `''`;
    - no key, or no `.env`, gives `''`;
    - an empty service list with standby gives `''`.
  - Renderer assertions:
    - the reconcile `up` line ends with `STANDBY_SCALE_FLAG`;
    - the systemd ExecStart contains `STANDBY_SCALE_FLAG_SYSTEMD` and ExecStop does not;
    - the `pull` and `config` lines do not contain it.
  - Lockstep: run `RECONCILE_FLAGS_SED` with `sed -n` over a rendered `reconcile.sh` (n8n, metabase and redis on). It extracts exactly `composeFileFlags(options)`.
  - Bundle test: the staged bundle contains `standby-scale.sh` rendered from the current options. With n8n off, the script lists no n8n.
  - Reconverge (no new code): `reconvergeStandbyStack`/`reconcileRebuiltStandby` reach the retired node through `startComposeStack` → `reconcile.sh`, after `haMergeWalgRole` wrote `WALG_ROLE=standby`. Add a source-order assertion in `tests/unit/deploy/compose-ha-reconverge.test.ts` that the WALG merge precedes the rebuilt standby's `startComposeStack`, so the scale fragment applies.
  - Docker integration (`compose-scale-zero.test.ts`) uses a throwaway two-service project, `a` and `b` with `b.depends_on: a`, each with `container_name`:
    - `up -d --scale b=0` never creates `b`;
    - after a plain `up -d`, a second `up -d --scale b=0` removes `b` and leaves `a`'s container id unchanged.
    - This proves the Compose behaviour the design rests on. Pin the Compose version observed in the test's comment.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
  - Write `standby-scale.sh` into `stageDir` beside `reconcile.sh`, mode 0755. It is written for every compose mode; on a node without `WALG_ROLE` it is a no-op.
  - Check `compose-invocation-service-names.test.ts` and `compose-ha-overlay-up-flags.test.ts` for census rules on `up` invocations, and extend them so every `up -d` that `bundle.js` or `scale.js` renders carries the fragment.
- [ ] **Step 4: Run them to verify they pass.** Run `pnpm test:unit`, then `DOCKER_INTEGRATION=true pnpm test:docker -- compose-scale-zero`.
- [ ] **Step 5: Commit** with `feat(compose-ha): hold primary-only add-ons at zero on the standby`. Add one line to `docs/deploy-hetzner.md`'s compose-ha section: what runs on the standby.

### Task 4: compose-ha failover starts primary-only add-ons on the promoted node; the writer list comes from the declaration

Shrunk by #235: the retired/old primary's n8n and Metabase are already stopped (pre-promote fence `stopOldPrimaryWriters`, retirement fence, read-only retired DB). What remains is (a) starting them on the promoted node and (b) replacing the hand list `FAILOVER_FENCE_SERVICES` with the declaration.

**Files:**
- Modify: `src/lib/deploy/compose/ha.js` (`FAILOVER_FENCE_SERVICES` :1520 and its users `stopOldPrimaryWriters` :1533 and the un-fence restart; `failoverComposeHA` :1842 — after `restoreComposeWalgRole` :~2247 and `armComposeAcme` :~2260, before `waitForNewPrimaryApi` :~2329; Step 2's best-effort `docker stop` :~2338 uses `APP_TIER_RESTART_SERVICES`), `src/lib/deploy/retired-fence.js` (compose `writerContainers` :436), `tests/e2e/scenarios/_run-lifecycle.ts:3867` (retired-node `allowedExited`).
- Test: `tests/unit/deploy/compose-ha-failover-readiness.test.ts`, `tests/unit/failover/compose-failover-state-matrix.test.ts`, the Task 1 census (remove the allowlist entry).

**Interfaces:**
- Consumes `enabledAddonNames`, `composePromotionServices`, `composeWriterServices` (Task 1), `RECONCILE_FLAGS_SED` (Task 3).
- Produces, in `ha.js`:
  - `composeStartPrimaryOnlyCmd(projectName: string, services: string[]): string | null` — null for `[]`; otherwise `cd /opt/<p> && FLAGS=$(sed -n '<RECONCILE_FLAGS_SED>' reconcile.sh | tail -1) && [ -n "$FLAGS" ] && docker compose $FLAGS <repl overlay fragment> up -d --no-deps <services>`. No fallback `-f` set (a guessed set would recreate `db`).
  - `failoverFenceServices(envConfig): string[]` = `composeWriterServices(enabledAddonNames(envConfig))`, replacing `FAILOVER_FENCE_SERVICES` at every user (pre-promote fence, retirement fence `writerContainers`, `-abort` restart, Step 2's stop, e2e `allowedExited`). With no add-ons it equals `['app']`.

Order inside `failoverComposeHA`:
1. The add-on start runs after `restoreComposeWalgRole` and `armComposeAcme` (DB read-write, `.env` says `primary`, so later reconciles keep them up) and before the API gate. Best-effort and loud: on failure `p.log.warn` naming the services and the exact command; never aborts the failover. Never runs `app-migrate` or `*-setup` (R3). On a resumed run (journal) it is idempotent (`up -d` of running services is a no-op).
2. Step 2's best-effort stop uses `failoverFenceServices`; the retirement fence remains the guarantee.

- [ ] **Step 1: Write the failing tests.**
  - `composeStartPrimaryOnlyCmd('p', ['n8n','metabase'])` contains `up -d --no-deps n8n metabase` and the replication fragment, no `-f docker-compose.yml` literal; `[]` → null.
  - Source order: the start follows `restoreComposeWalgRole(` and `armComposeAcme(` and precedes `waitForNewPrimaryApi(`.
  - `failoverFenceServices({ n8n: true })` is `['app','n8n']`; `{}` is `['app']`. Every former `FAILOVER_FENCE_SERVICES` user reads it (grep census: the constant is gone).
  - State matrix: a promoted node with n8n enabled gets the start command; a run with no add-ons issues none.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.** `pnpm test:unit`.
- [ ] **Step 5: Commit** with `feat(compose-ha): failover starts primary-only add-ons on the promoted node`.

### Task 5: k8s-ha pilot standby zeroes declared add-ons, and promotion scales them up

**Files:**
- Modify:
  - `src/lib/deploy/k8s/k3s.js`: `demoteObservabilityOnStandby` (:2900; today it `scale deployment --all --replicas=0` in the observability namespace, then re-points `grafana-tls`), the pilot-standby block (:3574, app zero patch :3592), and the observability branch call (:3873);
  - `src/lib/deploy/k8s/standby-config.js:18` `deriveScaleUpList` (consumed by `gatePromotedApiReadiness`, `src/failover.js:681`);
  - `src/lib/deploy/orchestrator.js:~2244` (`scaleUpList: deriveScaleUpList({...})`);
  - `src/lib/deploy/retired-fence.js` k8s backend `workloadsZero` step (:353-362) and its probe: the default zeroes the app AND the declared add-ons, so all five `reconcileRetiredFence` callers (`src/failover.js:1659`, `:2436`, `src/status.js:1586`, `src/lib/deploy/orchestrator.js:709`, `src/lib/deploy/compose/ha.js:1883`) get it with no `deps` change.
- Test:
  - `tests/unit/deploy/standby-config.test.ts`;
  - new `tests/unit/deploy/k3s-standby-addons.test.ts`;
  - whichever existing test covers `demoteObservabilityOnStandby`. Find it with `git grep -l demoteObservabilityOnStandby tests`.

**Interfaces:**
- Consumes `enabledK8sAddonNames(projectDir)`, `k8sStandbyZeroedWorkloads` and `k8sFailoverAddonWorkloads` (Task 1).
- Produces:
  - `zeroWorkloadsOnStandby({ env, workloads }): Promise<string[]>` in `k3s.js`. For each `{kind,name,namespace}` it runs `get <kind> <name> --ignore-not-found -o name` and, when the object exists, `scale <kind> <name> --replicas=0` (never a patch: HA ruling, no pod roll). It returns the names it zeroed and logs one `[pilot-standby] zeroed …` line.
  - A kubectl-over-ssh variant for the retirement fence (it runs against a retired cluster's IP through `kubectl(ip, argv)`), sharing the workload list from `k8sStandbyZeroedWorkloads(enabledK8sAddonNames(cwd))` plus the app. The retired fence's probe reports `workloadsZero` only when every listed workload reads 0 replicas.
  - `demoteObservabilityOnStandby` is renamed `repointObservabilityCertOnStandby({ env, issuerName })` and keeps only the `grafana-tls` issuer patch, no-op without the namespace. Its `scale deployment --all` is removed, because `zeroWorkloadsOnStandby` now does the scaling from the declaration.
  - `deriveScaleUpList({ appManifestText, addons })`. Here `addons` is `Array<{ name, namespace, manifestText }>`, and the function returns the app entry, then one `{name, namespace, replicas}` per add-on (replicas parsed like the app's, default 1), then `cluster-autoscaler` last.
  - The orchestrator passes `k8sFailoverAddonWorkloads(enabledK8sAddonNames(cwd))`, with each manifest read from `k8s/base/<addon>/deployment.yaml`.

Placement in `applyK3sManifests`:
- `zeroWorkloadsOnStandby` runs inside the existing pilot-standby block straight after the app's `replicas: 0` patch. That keeps the window between `apply -k` and the zero patch the same as the app's.
- The later observability branch keeps skipping the apply and calls `repointObservabilityCertOnStandby` in place of the old function.

- [ ] **Step 1: Write the failing tests.**
  - `zeroWorkloadsOnStandby`, with `runKubectlWithRetry` injected or mocked as in the existing k3s unit tests:
    - it patches only existing objects;
    - it sends argv `['-n','vibecarbon','scale','deployment','n8n','--replicas=0']`;
    - with an empty list it returns `[]` and makes no call.
  - Source order: in the pilot-standby block, `zeroWorkloadsOnStandby(` follows the `zero app deployment (pilot standby)` patch.
  - Retirement fence (k8s): with n8n and redis installed, `workloadsZero` scales app, n8n and redis on the retired IP and the probe requires all three at 0; with none installed it is today's app-only behaviour (extend `tests/unit/deploy/retired-fence.test.ts`).
  - `deriveScaleUpList` with no add-ons equals today's output, so existing assertions keep passing. With redis (`replicas: 1`) and n8n, the result is `[app, redis, n8n, cluster-autoscaler]` with namespaces.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.** Run `pnpm test:unit`.
- [ ] **Step 5: Commit** with `feat(k8s-ha): pilot standby zeroes every declared add-on and failover scales them up`. Update `docs/deploy-hetzner.md`'s k8s-ha pilot-light paragraph with one line.

### Task 6: e2e proof with the add-ons on

**Files:**
- Modify: `tests/e2e/checks/pilot-light.ts` and `tests/e2e/scenarios/_run-lifecycle.ts`
- Create: `tests/e2e/checks/standby-addons.ts` (or extend `tests/e2e/checks/ha-integrity.ts`, which #235 added for HA checks, if it fits better)
- Test: `tests/unit/e2e/standby-addons-check.test.ts`

Checks:
- **k8s-ha** at verify-deploy is already covered: `pilot_light_deployments_zero` asserts every `vibecarbon` Deployment except `PILOT_KEPT_DEPLOYMENTS` is at 0. That check would fail today with n8n on, which is the bug's proof; don't change it.
- **k8s-ha after failover:** new `promoted_addons_ready`. Every `k8sFailoverAddonWorkloads` Deployment on the promoted cluster has `readyReplicas >= 1`.
- **compose-ha at verify-deploy:** new `standby_primary_only_absent`. `docker ps -a --format '{{.Names}}'` on the standby contains none of `<p>-<svc>` for `composeStandbyScaledServices`.
- **compose-ha after failover:**
  - new `promoted_primary_only_running`: the promoted node runs every `composePromotionServices` container;
  - new `promoted_db_not_recreated`: the db container id captured on the standby before failover equals the one after (Review Focus 2). Reuse the container-id/startedAt reader behind #235's `primary_not_restarted` in `ha-integrity.ts` rather than a second one.
- All four checks read their lists from `standby-policy.js`, never literals. With no primary-only add-on enabled they report `skip`, not `pass`. That keeps the hollow-pass census from #226 happy; extend `tests/unit/e2e/hollow-pass-census.test.ts` if it enumerates check files.

- [ ] **Step 1: Write parser unit tests.** Cover the name-list parsing and the skip-when-empty behaviour.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.** Wire the checks into the verify-deploy and verify-failover steps for HA modes.
- [ ] **Step 4: Run them to verify they pass.** Run `pnpm lint && pnpm test:unit` (tsc runs inside lint).
- [ ] **Step 5: Commit** with `test(e2e): HA scenarios prove primary-only add-ons follow the primary`.
- [ ] **Step 6: Run on real infra.** STOP HERE and ask Brandon before running: this costs money. Run `pnpm test:e2e:batch -- --scenario hetzner/compose-ha --features=observability,n8n,metabase,redis`, then the same for `hetzner/k8s-ha`. Record the failover-step duration against the 3.0–3.7 min baseline for R2.

## Verification (end of branch)
- `pnpm lint && pnpm test:unit && pnpm test:integration`, `DOCKER_INTEGRATION=true pnpm test:docker`, and `cd carbon && npm run test:prepush`.
- Whole-branch review on the most capable model, then open the PR against `feat/ha-correctness` (or `main` once #235 has merged). Task 6 Step 6 is the acceptance gate before merge.
