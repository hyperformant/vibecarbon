# Event-Driven Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop paying for probe intervals on the deploy path: every wait that can end the moment its condition turns true does.

**Architecture:** Three patterns replace laptop-side polling. Kubernetes gets fast startup probes that hand over to the existing slow readiness probes. Compose gets a fast Docker health interval during startup. Waits on a remote condition become one held SSH session whose work happens on the server, so nothing crosses the network until the answer is known. Provider APIs, DNS propagation and the first SSH connect stay polled, because nothing can notify a laptop behind NAT.

**Tech Stack:** Node.js ESM (CLI), vitest, Kubernetes manifests (k3s), Docker Compose (Engine 29 pinned, 25 is the floor for `start_interval`), POSIX sh with GNU coreutils on the servers.

**Spec:** Approved by Brandon 2026-11-04 in conversation. Census evidence: `/tmp/claude-1000/-home-brandon-repos-vibecarbon/0b7ee7cd-7067-44f6-a72a-5ce5d7505b2c/scratchpad/timeout-census.md`. Ruling recorded here: compose does NOT move to `docker compose up --wait` with a new app healthcheck. A held probe inside the app container gives the same result with no always-on healthcheck process and no change to reconcile's failure behaviour.

## Global Constraints

- Failure behaviour does not change: same overall deadlines, same error text, same diagnostics captured on timeout. Only the happy path gets faster.
- No retry ladders and no new `docs/mitigations.yml` entries. A reconnect inside a wait is the wait itself, the same role the old poll loop had.
- Customers get every change. Nothing is e2e-only.
- amd64 only. Server scripts stay ASCII, POSIX sh plus GNU coreutils (`timeout`, `tail --pid`), which Ubuntu 24.04 has on every provider.
- `carbon/k8s/base/app/deployment.yaml` already follows the startup-probe pattern. Leave it alone. Add-on manifests under `services/` are out of scope.
- Never print secret values. Conventional commits, pathspec commits (`git commit -- <files>`), never `--no-verify`, no `!:` or BREAKING footers, no attribution lines, no em dashes in user-facing text.
- Never touch Docker containers you did not create. Throwaway test containers are named `vctest-*` and removed with `docker rm -f -v`.
- Run tests from the worktree `/home/brandon/repos/vibecarbon/.claude/worktrees/perf-readiness`. No real infrastructure in any task. The controller runs that.

## Review Focus

1. The held SSH session drops mid-boot (ufw enabling, sshd reload, a router dropping an idle connection): the wait reconnects and still sees the marker. Task 4 test.
2. cloud-init fails and the marker never appears: same deadline, same error, same cloud-init tail as before. Task 4 test.
3. The marker is already present (a redeploy reusing a server): the wait returns at once and never blocks on `tail`. Task 4 test.
4. A slow database must never be killed by its new startup probe: the db's budget is one hour, and it has no liveness probe. Task 1 census test.
5. The app crash-loops after `up -d`: the held probe ends, `docker compose ps` and the app log are still captured, and the result is `healthy: false`. Task 3 test.

---

### Task 1: Kubernetes startup probes

**Files:**
- Modify: `carbon/k8s/base/cluster-autoscaler/deployment.yaml:136-188`
- Modify: `carbon/k8s/base/traefik/deployment.yaml:60-74`
- Modify: `carbon/k8s/base/registry/local-registry.yaml:102-124`
- Modify: `carbon/k8s/base/db/statefulset.yaml:518-523`
- Create: `tests/unit/k8s/startup-probe-census.test.ts`
- Check and update as needed: `tests/unit/autoscaler/manifest.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing other tasks use.

The kubelet runs a container's readiness probe as soon as its startup probe succeeds, provided readiness `initialDelaySeconds` has passed. So every readiness and liveness `initialDelaySeconds` in these four files becomes `0`. The startup probe is the only thing gating the early period, and liveness is off until it passes.

Exact values:

| Container | Startup probe | periodSeconds | timeoutSeconds | failureThreshold |
|---|---|---|---|---|
| autoscaler sidecar | exec, same command as its readiness probe (`healthcheck.js --readiness`) | 2 | 15 | 60 |
| traefik | httpGet `/ping` port `traefik` | 1 | 3 | 60 |
| local registry | httpGet `/v2/`, same port as its readiness probe | 1 | same as its readiness probe | 60 |
| db | exec, same `pg_isready` command as its readiness probe | 1 | 5 | 3600 |

Keep every existing readiness and liveness `periodSeconds`, `timeoutSeconds` and `failureThreshold` unchanged. The autoscaler's Task 9j cold-start margin is why its timeouts stay at 15 s. Update the comments in that file so they stay true: the sidecar's initial delays are gone because the startup probe now gates the cold start. A kubelet probe worker runs one attempt at a time, so a 2 s period with a 15 s timeout cannot overlap. Say so, because the existing comment warns about overlap. Add one short comment on the db startup probe: a startup probe must never be what kills a recovering database, so its budget is one hour.

- [ ] **Step 1: Write the failing census test.** Walk every YAML document under `carbon/k8s/base/` (use the `yaml` package, `parseAllDocuments`) and collect each container in a Deployment or StatefulSet that has a `readinessProbe`. Assert for each, by name in the failure message:
  - `startupProbe` exists;
  - `startupProbe.periodSeconds <= 2`;
  - `readinessProbe.initialDelaySeconds` is `0` or absent;
  - `livenessProbe.initialDelaySeconds` is `0` or absent, except the `app` container, which keeps its reviewed 10 s;
  - `startupProbe.failureThreshold * startupProbe.periodSeconds >= 60`, except the `app` container, whose 5 s budget predates this work;
  - for the `db` container: `failureThreshold * periodSeconds >= 3600` and no `livenessProbe`.
  The census must fail if it finds fewer than 4 containers, so a moved directory cannot pass it empty.
- [ ] **Step 2: Run it.** `pnpm exec vitest run tests/unit/k8s/startup-probe-census.test.ts`. Expected: FAIL naming the autoscaler sidecar, traefik, local registry and db.
- [ ] **Step 3: Edit the four manifests** with the values above.
- [ ] **Step 4: Run it and its neighbours.** `pnpm exec vitest run tests/unit/k8s tests/unit/autoscaler`. Expected: PASS. Update any test that pinned an old initial delay, and say why in the commit.
- [ ] **Step 5: Commit.** `perf(k8s): startup probes end the rollout waits, the slow probes stay for runtime`

### Task 2: Fast database health checks in compose

**Files:**
- Modify: `carbon/docker-compose.yml:187-201`
- Create: `tests/unit/template/db-healthcheck-start-interval.test.ts`

**Interfaces:** none.

The db healthcheck runs every 5 s, and `app` and `app-migrate` both wait on `condition: service_healthy`, so every start pays up to 5 s after Postgres is ready. Add `start_interval: 1s` directly after `start_period: 180s`, with a comment: Docker checks every second during the start period only, then returns to `interval`. It needs Docker Engine 25 or newer. `start_period: 180s`, `interval: 5s`, `timeout: 5s` and `retries: 10` do not change, and the dated comment about start_period stays.

- [ ] **Step 1: Write the failing test.** Parse `carbon/docker-compose.yml` with `yaml`. Assert `services.db.healthcheck.start_interval === '1s'`, `start_period === '180s'`, `interval === '5s'`.
- [ ] **Step 2: Run it.** `pnpm exec vitest run tests/unit/template/db-healthcheck-start-interval.test.ts`. Expected: FAIL.
- [ ] **Step 3: Add the line and comment.**
- [ ] **Step 4: Run it plus the template tier that reads compose.** `pnpm exec vitest run tests/unit/template tests/unit/deploy/compose-port-publication.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `perf(compose): the db reports healthy within a second of being ready`

### Task 3: One held app health probe

**Files:**
- Modify: `src/lib/deploy/compose/index.js:914-1010` (`healthProbeDelayMs`, `verifyAppHealth`)
- Modify: `src/lib/deploy/effects/index.js:585` only if the option it passes changes
- Test: the existing `verifyAppHealth` test file (find it with `grep -rl verifyAppHealth tests/unit`), plus `tests/unit/deploy/app-health-probe-script.test.ts`

**Interfaces:**
- Produces: `export function appHealthProbeScript(path: string, budgetMs: number): string`, a node program that exits 0 on the first 2xx from `localhost:3000<path>`, and 1 once `budgetMs` has passed.
- Produces: `export const APP_HEALTH_PROBE_BUDGET_MS = 180_000`, replacing `attempts` and `delayMs`. Remove `healthProbeDelayMs`, and adjust the caller and tests to pass `budgetMs` if they passed either option.

Today each probe is one ssh, one `docker compose exec` and one node process, on a 2 s then 10 s ramp. New shape: one ssh, one `exec`, one node process, which requests `/api/health` every 200 ms inside the container and exits as soon as it gets a 2xx. A single request never hangs the loop (2 s request timeout). The outer loop in `verifyAppHealth` stays only for the case where the container is restarting and `exec` fails: it re-runs the held probe after 1 s until the budget is spent. Keep the base64 delivery, the `2xx`/`fail` token on stdout, the `waitForServicesHealthy` call on success and the whole diagnostics path on failure. The ssh `timeout` is the remaining budget plus 10 s.

- [ ] **Step 1: Write the failing tests.**
  - `appHealthProbeScript`: run the script with `node -e` against a local `http.createServer` that answers 503 twice, then 200. Assert exit 0 in under 2 s. Against a closed port with `budgetMs` 600, assert exit 1 in under 3 s. Against a server that never answers, with `budgetMs` 2500, assert exit 1, so one hung request cannot outlive the budget.
  - `verifyAppHealth` with a mocked runner: returns `healthy: true` after one ssh call when the probe prints `2xx`; when the probe prints `fail` until the budget ends, it returns `healthy: false` and still ran the `ps` and log commands (Review Focus 5); when `exec` fails on the first call and succeeds on the second, it returns `healthy: true`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `appHealthProbeScript`, then rework `verifyAppHealth` around it.
- [ ] **Step 4: Run them plus `tests/unit/deploy`.** Expected: PASS. `pnpm lint` passes.
- [ ] **Step 5: Commit.** `perf(deploy): one held probe sees the app come up the moment it does`

### Task 4: Boot waits as one held session, with live progress

**Files:**
- Create: `src/lib/deploy/remote-marker.js`
- Modify: `src/lib/command.js` (`runCommandAsync`: new `onStdoutLine` option)
- Modify: `src/lib/deploy/compose/index.js:232` (`sshRunAsync` passes the option through) and `:441-512` (`setupServer`)
- Modify: `src/lib/deploy/k8s/k3s.js:1205-1262` (`waitForK3sReady`)
- Modify: `src/lib/deploy/boot-timing.js` (export `BOOT_STAGE_LABELS` beside `PHASE_IDS`)
- Create: `tests/unit/deploy/remote-marker.test.ts`
- Update: existing tests for `setupServer` and `waitForK3sReady`, and any ssh call-site census

**Interfaces:**
- Produces, in `remote-marker.js`:
  - `markerWaitScript(markerPath: string, { holdS: number, logPath?: string }): string`
  - `waitForRemoteMarker({ run, markerPath, logPath, deadlineMs, holdS = 30, reconnectDelayMs = 750, onLine, onConnected, now = Date.now, sleep }): Promise<{ ready: boolean, connected: boolean }>`, where `run(script, { timeoutMs, onLine })` resolves to stdout or `null`, and never throws.
- Produces, in `command.js`: `runCommandAsync(cmd, { onStdoutLine })`, called with each complete stdout line as it arrives. Output capture and the resolved value do not change.
- Produces, in `boot-timing.js`: `BOOT_STAGE_LABELS`, plain words per phase id, for example `d: 'starting Docker'`, `a: 'installing the firewall'`, `k: 'installing Kubernetes'`, `r: 'waiting for Kubernetes'`, `x: 'installing cluster add-ons'`. Cover every id in `PHASE_IDS`. `e` needs no label.

`markerWaitScript` prints `CONNECTED`, then returns `READY` the moment the marker exists. When `logPath` is given it streams that log while it waits, starting from the first line, so a slow boot shows real progress. It ends by itself after `holdS`, so a half-open connection cannot use up the deadline. Shape, for `holdS` 30:

```sh
echo CONNECTED
timeout 30 sh -c '
  [ -f "$1" ] && exit 0
  ( until [ -f "$1" ]; do sleep 0.2; done ) & w=$!
  [ -z "$2" ] || tail -n +1 -s 0.2 -F --pid="$w" "$2" 2>/dev/null
  wait "$w"
' _ "<marker>" "<log>" && echo READY
```

Quote both paths for the shell with the existing helper in `src/lib/shell.js`. `waitForRemoteMarker` loops until `deadlineMs`: run the script with `timeoutMs` of `min(holdS, remaining) * 1000 + 5000`. Any output means `connected`, and `onConnected` fires once. A `READY` line (use `hasSentinelLine`) returns `{ ready: true, connected }`. Otherwise it sleeps `reconnectDelayMs` and tries again. Lines other than the sentinels go to `onLine`.

`setupServer` keeps its spinner, `noteBootPull`, `deadline`, error and tail capture exactly. A 1 s timer drives `s.message`, showing the same two messages as today plus the latest stage label after the elapsed time, for example `Waiting for cloud-init to finish on 1.2.3.4 (24s): installing the firewall`. Clear the timer in every exit path. Pass `sshRunAsync` with `retries: 1, ignoreError: true`. `waitForK3sReady` uses the same helper with marker `/tmp/k3s-ready`, log `BOOT_MARK_LOG`, the same ssh options it uses today, and the same error and `captureK3sInstallDiag` path. `maxWaitSec` keeps its meaning. Its `pollUntil` goes away.

- [ ] **Step 1: Write the failing tests** in `remote-marker.test.ts`.
  - `markerWaitScript`: run the real script with `sh -c` in a temp dir. Marker already present: prints `READY`, exits within 1 s, and `tail` is not left running (Review Focus 3). Marker created after 500 ms: prints `READY` within 1.5 s and the log lines written before and during the wait appear on stdout. No marker with `holdS` 1: exits non-zero within 2.5 s and prints no `READY`. Paths with a space work.
  - `waitForRemoteMarker` with a fake `run` and injected clock: first `run` returns `null` (SSH not up), second returns `CONNECTED` then drops with no `READY`, third returns `READY`: returns `{ ready: true, connected: true }` after 3 runs (Review Focus 1). `run` always returns `CONNECTED`: returns `{ ready: false, connected: true }` at the deadline (Review Focus 2). `run` always returns `null`: `{ ready: false, connected: false }`. `onLine` receives log lines and never `CONNECTED` or `READY`. `timeoutMs` never exceeds remaining time plus 5000.
  - `runCommandAsync` with `onStdoutLine`: `sh -c 'printf "a\nb"; sleep 0.2; printf "c\n"'` calls back with `a`, `bc`, and the resolved value matches a call without the option.
- [ ] **Step 2: Run them.** `pnpm exec vitest run tests/unit/deploy/remote-marker.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `onStdoutLine`, `sshRunAsync` passthrough, `remote-marker.js` and `BOOT_STAGE_LABELS`.
- [ ] **Step 4: Convert `setupServer` and `waitForK3sReady`.** Update their tests.
- [ ] **Step 5: Run `pnpm lint && pnpm typecheck && pnpm test:unit`.** Expected: PASS.
- [ ] **Step 6: Commit.** `perf(deploy): boot waits hold one session and show what the server is doing`

## Verification (controller)

- `pnpm lint && pnpm typecheck && pnpm test:unit`, then `pnpm test:integration`.
- A local compose project named `vctest-*` with the db healthcheck: time from Postgres ready to `healthy` is under 2 s.
- Real hardware, one DigitalOcean run per mode: compare `deploy.ha.compose.cloudInitReady.both`, `clusterAutoscaler.rollout`, `waitForK3sReady` and `deploy.total` against the same region and server class before this branch.
