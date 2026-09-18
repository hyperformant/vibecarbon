# Remote container health in `vibecarbon status` — design

**Date:** 2026-09-18
**Status:** approved in conversation (Brandon), pending spec review
**Depends on:** PR #110 (`fix/status-docker-native-health`): `classifyContainer`, `formatDockerServiceLines`, the row shape `{ name, container, health, label, detail, latencyMs }`.
**Release gate:** no `release.yml` dispatch until this ships and the e2e matrix proves it (memory: `release-hold-until-remote-health`).

## Problem

For a deployed environment, `status` reports server VM state (provider API), one `GET https://<domain>/api/health` (liveness of the app container through Traefik, no DB touch), git sync, and replication lag for HA. It never looks at the stack's containers or pods. Kong, auth, rest, realtime, storage or the database can be down and the Health line stays green as long as the app container answers. The renderer also looks for `database`/`supabase` fields that only `/api/health/ready` returns, so the `(db: connected …)` detail has never rendered.

## Goal

`status` shows the actual health of every container (compose modes) or pod (k8s modes) on every server of every environment, in a display that stays short when things are healthy and shows exactly what is wrong when they are not. `-json` carries the full data. The e2e lifecycle proves it on real infra for all four modes without polluting performance stats.

## Non-goals

- Restarting or repairing anything (read-only, as today).
- A new flag to expand healthy servers (exceptions-only is the design; `-json` has every row).
- Changing what the deployed app exposes over HTTP.
- Worker-node-level pod tables for k8s (pods are listed per cluster; nodes get a readiness count).

## Facts the design rests on

- Transport is SSH. The deployed app's `/api/_internal/services/status` is public through Traefik but gated on a super_admin Supabase JWT the CLI does not have. `status` already SSHes to the primary for replication lag (`sshRun`, `sshKubectl`, `getSSHKeyPath(env)` in `src/lib/ssh.js`) with a hard time bound and best-effort semantics; this follows the same pattern.
- Prod compose (`carbon/docker-compose.prod.yml`) names containers `${PROJECT_NAME}-<service>` exactly like dev, plus `socket-proxy`, `supavisor`, `functions`. So `docker ps -a --filter name=^<project>- --format '{{.Names}}\t{{.State}}\t{{.Status}}'` over SSH yields the line shape `checkDockerContainers` already parses, and `classifyContainer` applies unchanged.
- k8s pods live in `vibecarbon` (app, Supabase chart, Traefik) plus `flux-system`, `cert-manager`, `kube-system` (autoscaler). Kubeconfig on the master is at `K3S_KUBECONFIG`; `sshKubectl` wraps it.
- `envConfig.deployMode` ∈ `compose` | `compose-ha` | `kubernetes` | `kubernetes-ha`. `envConfig.servers[]` entries carry `{ id?, name, ip, role?, serverType? }`, and `role` is NOT reliably present: compose has none (single server); kubernetes writes `master` + `worker-N` (+ optional `supabase`); compose-ha is written either by `effects/compose-ha.js` as `{ name: '<project>-<env>-primary'|'-standby', role: 'primary'|'standby' }` or by `orchestrator.js` as `{ name: 'primary'|'standby' }` with no role; kubernetes-ha is always `{ name: 'primary'|'standby' }` with no role, plus `ha.primary.masterIp` / `ha.standby.masterIp`. Failovers mutate different fields: `failoverComposeHA` flips `role` in place (names are Pulumi identities and never change), `swapHaRoles` (k8s-ha) swaps `ha.primary`/`ha.standby` and leaves `servers[]` alone. So HA target selection is a ladder: `ha.<side>.masterIp` match, then `role`, then `name` (`primary`/`-primary`), then array position, the same ladder `failover.js`'s `identifyServers` walks.
- Published perf numbers come only from steps whitelisted in `PERF_TABLE_ROWS` (`tests/e2e/metrics/reporter.ts`); the reporter's per-scenario total is a sum over all steps and needs an explicit exclusion.

## Design

### 1. Data collection (`src/status.js`, new module `src/lib/status/remote-containers.js`)

New module `src/lib/status/remote-containers.js` (keeps `status.js` from growing further; pure functions exported for tests):

```js
// Which servers get a table, and how, for a given env config.
export function planContainerTargets(envConfig)
// -> Array<{ serverName, ip, kind: 'compose' | 'k8s', label }>
//    compose:        [{ name, ip, kind:'compose' }]                       (servers[0])
//    compose-ha:     primary + standby, kind 'compose'
//    kubernetes:     the `master` (or servers[0]) as kind 'k8s'; workers/supabase omitted
//    kubernetes-ha:  primary + standby, kind 'k8s'

// compose: parse `docker ps -a` lines (same parser as local) into rows.
export function rowsFromDockerPs(listing, projectName)   // -> ContainerRow[]

// k8s: parse `kubectl get pods -A -o json` + `kubectl get nodes -o json`.
export function rowsFromPods(podsJson)                    // -> { app: ContainerRow[], platform: Record<ns, {healthy, total}> }
export function classifyPod(pod)                          // -> { health, label, detail }
export function nodeReadiness(nodesJson)                  // -> { ready, total }

// Orchestration, best-effort, hard-bounded, injectable for tests.
export async function checkRemoteContainers(envName, envConfig, projectName, deps = {})
// deps: { sshRun?, sshKubectl?, getSSHKeyPath?, timeoutMs? = 10_000 }
// -> Record<serverName, ServerContainers>
```

`ServerContainers`:

```js
{
  kind: 'compose' | 'k8s',
  ip: string,
  rows: ContainerRow[],                       // app-level rows (compose: every container; k8s: vibecarbon namespace pods)
  platform?: Record<string, { healthy: number, total: number }>,  // k8s only: flux-system, cert-manager, kube-system
  nodes?: { ready: number, total: number },   // k8s only
  error?: string,                             // when SSH/kubectl failed: 'ssh timeout', 'ssh: <first line>', 'no ssh key'
}
```

`ContainerRow` is the PR #110 row shape. `latencyMs` is always 0 remotely (no probes; Docker/kube verdicts only).

**Compose collection.** One `sshRun(ip, key, ['docker','ps','-a','--filter',`name=^${project}-`,'--format','{{.Names}}\t{{.State}}\t{{.Status}}'], { silent: true, timeout })`. Rows via `rowsFromDockerPs`, which is the extracted line parser from `checkDockerContainers` (PR #110) so local and remote share one implementation; `checkDockerContainers` is refactored to call it. No Kong probe remotely: a container with no healthcheck verdict renders `● running` and counts healthy, as locally.

**k8s collection.** Two `sshKubectl` calls on the master: `get pods -A -o json` and `get nodes -o json`. `classifyPod`:

| Pod state | health | label | detail |
|---|---|---|---|
| phase Running, all containerStatuses ready | healthy | healthy | '' |
| phase Running, some not ready, no waiting reason | starting | starting | `ready 1/2` |
| any container waiting with a transient reason (`ContainerCreating`, `PodInitializing`, `ErrImagePull`) | starting | that reason | `restarts N` if > 0 |
| any container waiting with any other reason (CrashLoopBackOff, ImagePullBackOff, CreateContainerConfigError, …) | unhealthy | that reason | `restarts N` if > 0 |
| phase Pending | starting | pending | scheduling message if present |
| phase Succeeded (Job/one-shot) | done | done | '' |
| phase Failed | unhealthy | failed | container terminated reason |
| phase Unknown | unknown | unknown | '' |

`classifyPod` tests the terminal phases (`Succeeded`, `Failed`) before any waiting reason, so a one-shot that finished with a stale `waiting` status on a sidecar is still `done`. Pods in `vibecarbon` become `rows` named by their controller (`metadata.ownerReferences[0].name` with the ReplicaSet hash stripped, e.g. `supabase-kong`, `app`; StatefulSet pods keep their ordinal, `supabase-db-0`). Pods in other namespaces are counted into `platform[ns] = { healthy, total }` where `done` pods are excluded from both. Nodes: `ready` = count of nodes whose `Ready` condition is `True`.

**Bounding.** Each server is one `Promise` with its own timeout; servers run in parallel inside the environment's existing `Promise.allSettled`. Missing SSH key → every server `error: 'no ssh key'` immediately, no network. Any throw → `error` set, `rows: []`. Nothing here can reject the environment's checks entry.

**Wiring.** In `main`'s environment loop, after replication: `checks.containers = await checkRemoteContainers(envName, envConfig, projectConfig.projectName)`. Runs regardless of `noLocal` (it is remote), skipped when `envConfig.servers` is empty.

### 2. Health probe

`checkRemoteHealth` targets `https://<domain>/api/health/ready`. Its 200 body includes `database`/`supabase`, so the existing renderer's `(db: connected, supabase: connected, ready)` detail finally appears. A 503 `not_ready` renders `unhealthy (HTTP 503)` as today. Timeout stays 5s.

### 3. Display (exceptions-only rollup)

In `renderEnvironment`, each server line in the **Servers** block is followed by one indented rollup line, and then only the rows that are not `healthy`/`done`:

```
Servers
  prod-primary     95.217.1.10     ● running  cpx31
    containers ● 14/14 healthy
  prod-standby     65.108.2.20     ● running  cpx31
    containers ● 12/14 healthy
      kong                        ● exited     Exited (128) 3 hours ago
      supavisor                   ● unhealthy
```

k8s:

```
  prod-primary     95.217.1.10     ● running  cpx41
    pods ● 9/9 healthy · nodes 3/3 ready · flux-system 4/4 · cert-manager 3/3 · kube-system 7/7
  prod-standby     65.108.2.20     ● running  cpx21
    pods ● 8/9 healthy · nodes 2/2 ready · flux-system 4/4 · cert-manager 2/3 · kube-system 5/5
      supabase-realtime           ● CrashLoopBackOff  restarts 12
```

Rules:
- Rollup colour: green when every counted row is healthy and (k8s) every platform namespace is full and every node ready; yellow otherwise; red when `error` is set (`containers ● unreachable  ssh timeout`).
- Counted = rows whose health is not `done` (same as local).
- A platform namespace that is not full is itself an exception line: `      cert-manager                ○ 2/3 healthy` (no per-pod detail; run `diagnose` for that).
- `starting` rows are exceptions (yellow), so a rolling restart is visible without being red.
- Exception rows use the same 28-col name padding and `●`/`○` icons as `formatDockerServiceLines`; the row formatter is extracted from it into `formatContainerRow(row, indent)` so the two blocks cannot drift.
- Compose deploys (single server) render the same way; there is no special case.

Summary block: `Environments N deployed, M unhealthy` counts an environment unhealthy when the Health probe fails **or** any server has `error` or a non-`healthy`/`done` row **or** a k8s platform namespace/node shortfall. Today only the Health probe counts.

### 4. `-json`

`environments.<env>.checks.containers` = the `Record<serverName, ServerContainers>` above, verbatim. `checks.remoteHealth.url` now ends in `/ready`. Nothing else in the JSON changes shape.

### 5. e2e verification (`tests/e2e/scenarios/_run-lifecycle.ts`, metrics)

- New `StepName` `'verify-status'`. Inserted after `verify-deploy` in every mode, and after `verify-failover` in HA modes (proves the promoted side reports healthy and the demoted side reports what it should).
- The step runs `vibecarbon status -json` via the harness CLI runner from the project dir, parses it, and asserts for the environment under test: `remoteHealth.ok === true`; for every server in `checks.containers`: no `error`, every row `healthy` or `done`, (k8s) every platform namespace `healthy === total`, `nodes.ready === nodes.total`. Failure output lists the offending rows. Because `starting` fails the assertion, the step polls up to 3 minutes (10s interval) before failing, which absorbs a pod still rolling after verify-deploy.
- **Perf exclusion.** `verify-status` is not added to `PERF_TABLE_ROWS` (so it never reaches `docs/perf-data.json`). A `NON_PERF_STEPS = new Set(['verify-status'])` in `tests/e2e/metrics/reporter.ts` is applied to the per-scenario total (`reporter.ts` ~line 709) and any other sum over `steps[].duration_ms`; the step still appears in the pass/fail matrix with its duration for debugging. `rto-rpo.ts` only reads failover/restore steps and is unaffected.
- The `TODO (deferred from Phase 9)` comment gains a line noting `verify-status` is done.

### 6. Error handling summary

| Failure | Outcome |
|---|---|
| No SSH key locally | every server `error: 'no ssh key'`, rollup red `unreachable  no ssh key`; env counted unhealthy |
| SSH timeout / refused / host key | `error` with first stderr line, same rendering |
| `docker` missing on host (compose) | `sshRun` non-zero → `error: 'docker ps failed'` |
| `kubectl` returns invalid JSON | `error: 'kubectl output unparseable'` |
| Server has no `ip` | skipped with `error: 'no ip recorded'` |
| Project name missing | `containers` omitted entirely (same guard as local) |

### 7. Testing

Unit (`tests/unit/status/remote-containers.test.ts`): `planContainerTargets` for all four modes (+ workers/supabase omitted, missing role fallback to `servers[0]`); `rowsFromDockerPs` parity with local (same fixture lines as `docker-services.test.ts`); `classifyPod` for each table row above using minimal pod JSON fixtures; `rowsFromPods` naming (ReplicaSet hash stripped, StatefulSet ordinal kept, platform rollup, `done` exclusion); `nodeReadiness`; `checkRemoteContainers` with injected `sshRun`/`sshKubectl`/`getSSHKeyPath` covering success, timeout, missing key, per-server isolation (one server failing does not affect the other).

Unit (`tests/unit/status/docker-services.test.ts`): `checkDockerContainers` still passes after delegating its parser to `rowsFromDockerPs`; `formatContainerRow` extraction leaves `formatDockerServiceLines` output byte-identical.

Unit (new `tests/unit/status/render-environment.test.ts`): rollup line and exception expansion for compose (all healthy → one line; one exited → two lines), k8s (platform shortfall line, node shortfall in rollup), `error` rendering, summary unhealthy count.

Unit (`tests/unit/e2e/...`): `NON_PERF_STEPS` exclusion in the reporter's scenario total; `verify-status` assertion helper against fixture JSON (green, one unhealthy row, platform shortfall, `starting` treated as retry-then-fail).

Integration (`pnpm test:cli`): `status -json` on a project with a fake environment and no SSH key emits `containers` with `error: 'no ssh key'` per server and exits 0.

e2e: one full matrix run on Hetzner (`pnpm test:e2e:batch -- --provider hetzner`) with `verify-status` green in all four modes is the acceptance gate for lifting the release hold.

## Open points resolved during design

- Every server, not primary only (Brandon).
- k8s: `vibecarbon` namespace as rows, platform namespaces as rollups (Brandon).
- Display A: exceptions-only rollup under each server (Brandon).
- e2e `verify-status` step, excluded from perf stats (Brandon).
