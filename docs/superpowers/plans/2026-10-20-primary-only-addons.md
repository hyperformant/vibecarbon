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
- **R4. n8n needs a shared `N8N_ENCRYPTION_KEY`.** Promotion cannot work without it, so it is folded in as Task 2.
  - Today n8n generates a random key in each node's `n8n_data` volume. The workflows and credentials are replicated in Postgres, so a promoted node's n8n cannot decrypt them.
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
- No hand-written add-on name lists (`'n8n'`, `'metabase'`, `'redis'`) in `src/lib/deploy/**`, `src/failover.js` or `src/scale.js`. Every consumer goes through `src/lib/services/standby-policy.js` (census in Task 1).
- The compose `-f` set never depends on role. Role-specific behaviour is only the runtime `--scale` fragment.
- dotenv writes only through `formatDotenvLine`. Never hand-parse `.env` in JS. The shell side reads `WALG_ROLE` the way `compose-role-env-census.test.ts` sanctions; check that census before writing the sed.
- Conventional commits, pathspec commits (`git commit -- <files>`), never `--no-verify`, no `!:` footers. Root fixes, no retry ladders.
- Work in a worktree off `main`, e.g. `.claude/worktrees/primary-only-addons` on branch `feat/primary-only-addons`.

## Review Focus
1. **A compose-ha standby reboots:** the systemd `ExecStart` brings the stack up and n8n and Metabase must stay absent. Task 3 adds a unit assertion on the rendered unit's `$$` fragment, and a test that executes `standby-scale.sh`.
2. **A promotion leaves `db` alone:** the promoted node's `db` container is not recreated by the add-on start (`--no-deps`, same `-f` set). Task 4 asserts the command shape. The real-infra check in Task 6 compares the `db` container id before and after.
3. **The retired primary stops its n8n:** an unplanned failover with the old primary still reachable stops n8n there too, or it keeps firing schedules against the old writable DB. This is the split-brain class. Task 4 covers the stop list, and Task 5 the k8s scale-down through `scaleUpList`.
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

- [ ] **Step 1: Write the census test.** It walks every directory under `services/` and asserts, per add-on:
  - `standby.policy` is one of the two values.
  - `composeServices ∪ composeSetup` equals the top-level service keys of `compose/docker-compose.yml` minus the shared `db`, `app` and `traefik` (parse with the `yaml` package already in devDeps).
  - `k8s` equals the set of `kind: Deployment|StatefulSet|DaemonSet` documents across `k8s/*.yaml`. Each entry's namespace comes from `k8s/kustomization.yaml`'s `namespace:` when present, else `vibecarbon`.
  - Source census: `src/lib/deploy/**/*.js`, `src/failover.js` and `src/scale.js` contain no string literal matching `/['"`](n8n|metabase|redis)(-setup)?['"`]/`, except lines in an allowlist that names file and reason. Seed the allowlist by running the grep first. Existing literals unrelated to standby (for example `bundle.js` `COMPOSE_OPTIONAL_FILES` filenames contain `docker-compose.n8n.yml`, which the pattern does not match) stay put. Any true hand list found is either migrated in Tasks 3–5 or allowlisted with a reason.
  - Loader unit tests: `composeStandbyScaledServices(['n8n','redis','metabase'])` is `['n8n','n8n-setup','metabase','metabase-setup']`, and `k8sFailoverAddonWorkloads(['observability','redis'])` is just the redis Deployment.
- [ ] **Step 2: Run the test to verify it fails.** Run `pnpm vitest run tests/unit/services/addon-standby-declaration-census.test.ts`. Expected: FAIL on the missing `standby` keys and the missing module.
- [ ] **Step 3: Implement.** Add the manifest blocks and write `standby-policy.js`.
- [ ] **Step 4: Run the test to verify it passes.** Run the same file, then `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(services): every add-on declares its HA standby behaviour`.

### Task 2: One n8n encryption key per environment (R4)

**Files:**
- Modify:
  - `services/n8n/manifest.json` (`envVars.N8N_ENCRYPTION_KEY: { "generate": "password", "length": 48 }`)
  - `services/n8n/compose/docker-compose.yml` and `carbon/docker-compose.n8n.yml` (`- N8N_ENCRYPTION_KEY=${N8N_ENCRYPTION_KEY:?N8N_ENCRYPTION_KEY missing, run vibecarbon upgrade}`)
  - `services/n8n/k8s/deployment.yaml` (env `N8N_ENCRYPTION_KEY` from `secretKeyRef vibecarbon-secrets/N8N_ENCRYPTION_KEY`)
  - `src/lib/deploy/k8s/k3s.js` (the secret key list holding `'N8N_DB_PASSWORD'`, near :1822)
  - `src/lib/deploy/k8s/gitops-deploy.js:326`
  - `src/lib/github-environments.js` (doc line and the key list)
  - `services/n8n/docs/integration.md` (one line)
- Test: extend whichever existing tests pin `N8N_DB_PASSWORD` in those lists. Find them with `git grep -l N8N_DB_PASSWORD tests/`. Also `tests/unit/lib/env-docs-census.test.ts` if it requires docs for new env names.

- [ ] **Step 1: Write the tests.** Wherever a test asserts `N8N_DB_PASSWORD` membership, add the same assertion for `N8N_ENCRYPTION_KEY`. Add a test that `upgrade.js`'s manifest-password generation (around `src/upgrade.js:188`) produces `N8N_ENCRYPTION_KEY` for a project with n8n installed and none set.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.** Run `pnpm test:unit && pnpm test:integration`.
- [ ] **Step 5: Commit** with `fix(n8n): one encryption key per environment so a promoted standby can read credentials`. Include a Compatibility note per R4.

### Task 3: compose-ha keeps primary-only add-ons at zero on a standby

**Files:**
- Modify:
  - `src/lib/deploy/bundle.js`: `renderReconcileScript`, `renderSystemdUnit`, the stage writes near :396, and a new exported renderer and constants.
  - `src/scale.js:819-829`: the restore recreate.
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

### Task 4: compose-ha failover starts them on the promoted node and stops them on the retired one

**Files:**
- Modify: `src/lib/deploy/compose/ha.js` (`failoverComposeHA` steps 1b and 2, near :1625–:1720)
- Test:
  - `tests/unit/deploy/compose-ha-failover-readiness.test.ts`;
  - `tests/unit/e2e/status-health-check.test.ts` (the retired node's `allowedExited`);
  - `tests/e2e/scenarios/_run-lifecycle.ts:3838` (where the retired node's allowed-exited list is read).

**Interfaces:**
- Consumes:
  - `enabledAddonNames(envConfig)`;
  - `composePromotionServices`;
  - `composeStandbyScaledServices` (Task 1);
  - `RECONCILE_FLAGS_SED` (Task 3).
- Produces, in `ha.js`:
  - `composeStartPrimaryOnlyCmd(projectName: string, services: string[]): string | null`. It returns null for an empty list. Otherwise it returns `cd /opt/<p> && FLAGS=$(sed -n '<RECONCILE_FLAGS_SED>' reconcile.sh | tail -1) && [ -n "$FLAGS" ] && docker compose $FLAGS <repl overlay fragment> up -d --no-deps <services>`. There is deliberately no fallback `-f` set: an empty FLAGS fails loudly, because a guessed set would recreate `db`.
  - `retiredNodeStopContainers(projectName: string, envConfig): string[]`, which is `APP_TIER_RESTART_SERVICES` plus `composeStandbyScaledServices(enabledAddonNames(envConfig))`, each as `<projectName>-<svc>`.

Order inside `failoverComposeHA`:
1. The add-on start runs after `restoreComposeWalgRole` and `armComposeAcme`. By then the database is read-write and `.env` says `primary`, so later reconciles keep the services up.
2. It runs before the step 1c API gate. It is best-effort and loud: a failure is a `p.log.warn` naming the services and the exact command to run by hand, and the spinner says FAILED. It never aborts the failover; the app is what failover must restore.
3. Step 2's `docker stop` uses `retiredNodeStopContainers`. `docker stop` on a container that does not exist exits non-zero, so the command becomes `docker stop <list> 2>&1; docker ps -q --filter name=^/<p>-(app|n8n|…)$` and the step judges success by nothing being left running. The "split-brain" warning text stays.
4. The retired-node `allowedExited` lists, in the e2e harness and its unit test, read `retiredNodeStopContainers` service names instead of `APP_TIER_RESTART_SERVICES`.

- [ ] **Step 1: Write the failing tests.**
  - `composeStartPrimaryOnlyCmd('p', ['n8n','metabase'])` contains `up -d --no-deps n8n metabase`, contains the replication fragment, and contains no `-f docker-compose.yml` literal fallback. With `[]` it returns null.
  - The failover source order: the start call follows `restoreComposeWalgRole(` and precedes `waitForNewPrimaryApi(`. Follow the existing source-order assertions in `compose-ha-failover-readiness.test.ts`.
  - `retiredNodeStopContainers('p', { n8n: true })` equals `['p-app','p-n8n','p-n8n-setup']`.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.** Run `pnpm test:unit`.
- [ ] **Step 5: Commit** with `feat(compose-ha): failover moves primary-only add-ons with the primary`.

### Task 5: k8s-ha pilot standby zeroes declared add-ons, and promotion scales them up

**Files:**
- Modify:
  - `src/lib/deploy/k8s/k3s.js`: `demoteObservabilityOnStandby` near :2783, the pilot-standby block after `applyBase` near :3456, and the observability branch near :3740;
  - `src/lib/deploy/k8s/standby-config.js`: `deriveScaleUpList`;
  - `src/lib/deploy/orchestrator.js:1762`.
- Test:
  - `tests/unit/deploy/standby-config.test.ts`;
  - new `tests/unit/deploy/k3s-standby-addons.test.ts`;
  - whichever existing test covers `demoteObservabilityOnStandby`. Find it with `git grep -l demoteObservabilityOnStandby tests`.

**Interfaces:**
- Consumes `enabledK8sAddonNames(projectDir)`, `k8sStandbyZeroedWorkloads` and `k8sFailoverAddonWorkloads` (Task 1).
- Produces:
  - `zeroWorkloadsOnStandby({ env, workloads }): Promise<string[]>` in `k3s.js`. For each `{kind,name,namespace}` it runs `get <kind> <name> --ignore-not-found -o name` and, when the object exists, `patch <kind> <name> --type=merge -p {"spec":{"replicas":0}}`. It returns the names it zeroed and logs one `[pilot-standby] zeroed …` line.
  - `demoteObservabilityOnStandby` is renamed `repointObservabilityCertOnStandby({ env, issuerName })` and keeps only the `grafana-tls` issuer patch, no-op without the namespace. Its `scale deployment --all` is removed, because `zeroWorkloadsOnStandby` now does the scaling from the declaration.
  - `deriveScaleUpList({ appManifestText, addons })`. Here `addons` is `Array<{ name, namespace, manifestText }>`, and the function returns the app entry, then one `{name, namespace, replicas}` per add-on (replicas parsed like the app's, default 1), then `cluster-autoscaler` last.
  - The orchestrator passes `k8sFailoverAddonWorkloads(enabledK8sAddonNames(cwd))`, with each manifest read from `k8s/base/<addon>/deployment.yaml`.

Placement in `applyK3sManifests`:
- `zeroWorkloadsOnStandby` runs inside the existing pilot-standby block straight after the app's `replicas: 0` patch. That keeps the window between `apply -k` and the zero patch the same as the app's.
- The later observability branch keeps skipping the apply and calls `repointObservabilityCertOnStandby` in place of the old function.

- [ ] **Step 1: Write the failing tests.**
  - `zeroWorkloadsOnStandby`, with `runKubectlWithRetry` injected or mocked as in the existing k3s unit tests:
    - it patches only existing objects;
    - it sends argv `['-n','vibecarbon','patch','deployment','n8n','--type=merge','-p','{"spec":{"replicas":0}}']`;
    - with an empty list it returns `[]` and makes no call.
  - Source order: in the pilot-standby block, `zeroWorkloadsOnStandby(` follows the `zero app deployment (pilot standby)` patch.
  - `deriveScaleUpList` with no add-ons equals today's output, so existing assertions keep passing. With redis (`replicas: 1`) and n8n, the result is `[app, redis, n8n, cluster-autoscaler]` with namespaces.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.** Run `pnpm test:unit`.
- [ ] **Step 5: Commit** with `feat(k8s-ha): pilot standby zeroes every declared add-on and failover scales them up`. Update `docs/deploy-hetzner.md`'s k8s-ha pilot-light paragraph with one line.

### Task 6: e2e proof with the add-ons on

**Files:**
- Modify: `tests/e2e/checks/pilot-light.ts` and `tests/e2e/scenarios/_run-lifecycle.ts`
- Create: `tests/e2e/checks/standby-addons.ts`
- Test: `tests/unit/e2e/standby-addons-check.test.ts`

Checks:
- **k8s-ha** at verify-deploy is already covered: `pilot_light_deployments_zero` asserts every `vibecarbon` Deployment except `PILOT_KEPT_DEPLOYMENTS` is at 0. That check would fail today with n8n on, which is the bug's proof; don't change it.
- **k8s-ha after failover:** new `promoted_addons_ready`. Every `k8sFailoverAddonWorkloads` Deployment on the promoted cluster has `readyReplicas >= 1`.
- **compose-ha at verify-deploy:** new `standby_primary_only_absent`. `docker ps -a --format '{{.Names}}'` on the standby contains none of `<p>-<svc>` for `composeStandbyScaledServices`.
- **compose-ha after failover:**
  - new `promoted_primary_only_running`: the promoted node runs every `composePromotionServices` container;
  - new `promoted_db_not_recreated`: the db container id captured on the standby before failover equals the one after (Review Focus 2).
- All four checks read their lists from `standby-policy.js`, never literals. With no primary-only add-on enabled they report `skip`, not `pass`. That keeps the hollow-pass census from #226 happy; extend `tests/unit/e2e/hollow-pass-census.test.ts` if it enumerates check files.

- [ ] **Step 1: Write parser unit tests.** Cover the name-list parsing and the skip-when-empty behaviour.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.** Wire the checks into the verify-deploy and verify-failover steps for HA modes.
- [ ] **Step 4: Run them to verify they pass.** Run `pnpm test:unit && pnpm typecheck`.
- [ ] **Step 5: Commit** with `test(e2e): HA scenarios prove primary-only add-ons follow the primary`.
- [ ] **Step 6: Run on real infra.** STOP HERE and ask Brandon before running: this costs money. Run `pnpm test:e2e:batch -- --scenario hetzner/compose-ha --features=observability,n8n,metabase,redis`, then the same for `hetzner/k8s-ha`. Record the failover-step duration against the 3.0–3.7 min baseline for R2.

## Verification (end of branch)
- `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration`, and `DOCKER_INTEGRATION=true pnpm test:docker`.
- Whole-branch review on the most capable model, then open the PR against `main`. Task 6 Step 6 is the acceptance gate before merge.
