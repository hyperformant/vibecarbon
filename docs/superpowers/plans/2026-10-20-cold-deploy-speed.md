# Cold Deploy Speed (all four modes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Refresh 2026-10-21.** Re-checked against `feat/cold-deploy-speed` at `65a05ff`, stacked on #239 (TLS reuse) → #238 (registry copy) → #237 (backup/restore) → #236 (add-ons) → #235 (HA correctness) → #234 (security), all open; #233 (project app bucket) is on main. Every file:line below was re-read on that tree. What changed:
> - **All three sibling plans have landed in the stack** (TLS pending, non-blocking bucket settle, k8s-ha registry copy), so Task 8 is no longer blocked on them.
> - **New steps on the critical path** are accounted for in the new "Steps the stack added" table below. The two that matter: compose `restore-tls` pulls Traefik from Docker Hub on a cold server before `start-compose-stack` (new Task 4A), and the TLS **first look** still blocks every mode for up to 180 s on a first-ever deploy (a decision for Task 8, D1).
> - **Task 4:** `stackPullPromise` must start after `setup-server-files` (the compose files it reads are not on the server before that), not after `dockerhub-login`. `transferImageBetweenServers` has no caller left: delete it instead of exempting it.
> - **Task 4 and Task 5 both edit the registry-copy census** (`k8s-image-delivery-census.test.ts`); Task 4 folds its new census into it (ruling R2; rulings R1-R9 live in the SDD ledger, `.superpowers/sdd/2026-10-20-cold-deploy-speed/progress.md`, and the ones that change a task are written into it here).
> - **Task 5:** the k8s image is now delivered by `deliverAppImage` (`k3s.js:4873`), and only the app image is sideloaded (no backup image). Delivery cannot finish "before applyBase", because the registry pod is part of base; the barrier is "after `localRegistry.wait`, before the step-6 `deployment/app` patch".
> - **Task 6:** the Ruling A gate was run during the refresh (the job log is still downloadable); it passes on its letter but shows the young-bucket hazard on an HA pair, so Ruling A is reshaped to scope the lock by the provider's declared settle window (A′). Ruling C's second half (`primaryDbReady`) is dropped: `configurePrimaryForReplication` recreates the primary db pod (hostPort patch), which must not overlap the primary's migrations and audits, and with the seed path gone nothing consumes an early primary config. The release-order constraint is corrected: Task 6 Cause B must ship with Task 5, not with the registry-copy plan.
> - **Task 7:** refs moved (two socket-proxy services now, the registry relay exists, the backup CronJob is deploy-rendered); k3s's own system images still come from Docker Hub (decision D3).
> - **Task 8:** the "cold" definition is the e2e db's `classifyColdWarm`, not `iac.upStack > 30 s`; `lock-waits 0` is impossible after a scoped lock and becomes a bound.

**Goal:** Cold deploys get much faster in every mode. Compose finishes in under 180 s of deploy-owned work (under 300 s end to end on a first-ever deploy, TLS issuance included; see D1), and each other mode gets an honest, enforced budget. The main change is that the operator uplink stops carrying bytes a datacenter can fetch itself.

**Architecture:**
- **A published runtime base image.** The app runs on our own image: Alpine, libstdc++, the node binary, and the `hono` user. Its layers are byte-stable, so servers pull them from GHCR at datacenter speed.
- **A diffID-keyed layer delta.** The operator sends only the layers the target lacks. The target rebuilds a complete archive from layers it already holds and loads it.
- **One delivery path.** Compose and k8s both use the delta. k8s delivers once, to the master's registry, and every node pulls from there. The double upload goes, and so does the per-node sideload.
- **No dead waits.** The HA state lock stops serializing provisioning outside a young bucket, the k8s-ha standby stops waiting out a seed that never succeeds, and compose stops pulling Traefik just to look for a certificate that cannot exist yet.

**Tech Stack:** Node ESM CLI, Docker Engine 29 (`docker save`/`docker load`), k3s `ctr`, registry:2 (in-cluster, k8s only), GitHub Actions (GHCR publish), vitest (unit, integration/docker, e2e).

**Spec:** Brandon, 2026-10-20 in-session: "I just want to make sure our compose cold deploys are sub 5 minutes. I was actually hoping for sub 3 with our new lightweight stack updates." Then, via the coordinator: "All our deployment modes need to be blazing fast." And: never slow other providers to fix a Hetzner-only problem (the Hetzner bucket settle window is a provider-declared static; every other provider declares 0). There is no separate spec doc; this plan's Context is the evidence base, and rulings made without a spec are provisional.

## Context

### Critical path per mode (Hetzner, main 350af90, 2026-10-20 cold deploys, `[perf]` markers)

No real-infra run has happened on the stacked branches yet, so these are still the latest measurements. The "Steps the stack added" table below says what each new step adds.

**compose (e1, `e1-2026-10-20T04-15-47-252Z.log`), 810 s:**
- Serial: s3-setup and preamble (not instrumented), then `iac.upStack` 67, `waitForSSH` 3, `cloudInitReady` 2.
- **`image.transfer` 562 s**: a cold registry push, `[push] ... dur=556s`. The empty server registry has nothing to diff against.
- Then `compose.up` 28 (pulls plus up), `waitAdminReady` 3.5, `databaseAudits` 1.2, `health.probe` 12, **`tls.ready` 109**, `backupCron` 4.4.
- On the server everything takes about 155 s. The rest is the uplink and TLS.

**compose-ha (e2, `e2-2026-10-20T09-33-51-610Z.log`), 437 s (other cold runs 380-450):**
- `iac.upStack.fan` 196: the standby takes 188-198 s against the primary's 92-96, consistent across 4 cold runs.
- `remoteBuild.fan` 97, of which `remoteBuild.await` 60 is on the critical path. Cold builds take 60-93 s; warm builds take 10-12.
- `pullFan` 27, `composeUp.both` 10, `replication.setup` 30, **`tls.ready` 86**.
- No operator uplink is involved (`haRemoteBuild`).

**k8s (e3, `e3-2026-10-20T06-43-27-805Z.log`), 1,413 s (other runs similar):**
- `iac.upStack` 96, `waitForReady` 17.
- **`sideload.app` 629 s** (operator to 3 nodes; other runs 515-555), then `applyManifests` 657.
- **`applyManifests` contains `registryPush.app` 523 s**: a second operator upload of the same image to the master registry for autoscaler-spawned workers. It is started after `localRegistry.wait` (`src/lib/deploy/k8s/k3s.js:4301`) and awaited at the end of `applyK3sManifests` (`:4854`).
- Also `certManager.install` 36, `applyBase` 30, `applyObservability` 11, `traefik.restart` 11, `rolloutApp` 10, `health.probe` 21.
- **The image crosses the uplink twice, serially.**

**k8s-ha (e4, `e4-2026-10-20T13-33-52-910Z.log`), 853 s:**
- The primary arm takes 770 s (`primary.sideload.app` 612) and the standby arm 698 s (`standby.sideload.app` 501), in parallel. Then replication takes about 80 s.
- The standby arm has since been rewritten by #238 (registry copy): the standby builds, sideloads and pushes nothing, and receives the primary's image over wg0 (`copyAppImageToStandby`, step `copy-standby-image`). This plan removes the **primary** cluster's sideload and push through the shared k8s delivery in Task 5.

### Steps the stack added since the baseline (critical path or not)

Read from the step lists in `src/lib/deploy/plan/deploy-plan.js:69-152` and the effects. None has a real-infra measurement yet; the cost column is from the code's own bounds and work, and Task 9 records the real numbers.

| Step (branch) | Modes | On the critical path? | Cost on a cold deploy | Can it overlap? |
|---|---|---|---|---|
| `restore-tls` (#239), `src/lib/deploy/effects/index.js:646`, `compose/tls-restore.js:184` | compose, compose-ha (primary) | **Yes**, between `update-dns` and `start-compose-stack` | Its live check runs `docker compose run traefik` (`tls-restore.js:84-92`, bound 300 s "a fresh server pulls the traefik image here"), so a cold server pulls Traefik from Docker Hub here, serially, before it even asks S3 whether a snapshot exists. On a first-ever deploy there is never a snapshot. | It overlaps the image transfer (still in flight until the `start-compose-stack` barrier). **Task 4A** reads the snapshot first and skips the server on a miss. |
| `verify-tls` first look (#239), `effects/index.js:571`, `orchestrator.js:659` (k8s), `compose/ha.js:2595` | all | **Yes** | Up to `TLS_FIRST_LOOK_BUDGET_MS` = 180 s (`src/lib/deploy/tls-ready.js:38`). A fresh certificate takes about 120 s from Traefik/cert-manager start (DNS-01 settle floor 90 s on Hetzner and DigitalOcean, 60 s on Vultr, `src/lib/dns-provider.js:128,163,203`). A redeploy, or a rebuild that restores a snapshot, is near 0. | Issuance overlaps everything after `start-compose-stack` (compose) or `applyBase` (k8s); only the residual blocks. **Decision D1** (what the budgets count). |
| `snapshot-tls` (#239), `effects/index.js:679`; k8s `orchestrator.js:715` | all, only when trusted | Yes, after `verify-tls` | One SSH + one S3 PUT (compose bound 180 s, `tls-restore.js:61`), a few seconds. | Could run beside `setup-backup-cron`; a few seconds, not worth a task. |
| k8s `tlsRestore` (#239), `k3s.js:4135` | k8s, k8s-ha primary | Yes, before `applyBase` | One S3 GET (404 on a first deploy) plus kubectl only on a hit; about 1-2 s. | No change. |
| `copy-standby-image` (#238), `effects/k8s-ha.js:452,673` | k8s-ha | **Yes on a cold deploy**: the copy starts in the fan-out only when early transport prep succeeded (`:422-430`), which it never does cold (Task 6 Cause B), so cold it starts serially after `verify-streaming`. | Registry-to-registry over wg0, about 155 MB; unmeasured. | **Task 6 Ruling C** makes early prep succeed cold, so the copy starts as soon as the fan-out ends and overlaps `configure-replication`. |
| Post-promote base push (#237), `src/lib/walg/post-promote-backup.js` | failover, scale, `deploy -restore` | **No** on a plain deploy (only `k3s.js:5459` under `options.restore`, and the compose-ha promotion paths). | n/a | n/a |
| Deploy-owned backup CronJob + retention ConfigMap (#237), `k3s.js:2968`, `:4160` | k8s | Inside `applyManifests` | Two small kubectl applies, about 1-2 s. | No change. |
| Atomic locked `.vibecarbon.json` writes (#237), `updateProjectConfig` | all | Yes, a few writes | Milliseconds each. | No change. |
| App-key readiness poll and Hetzner deny-fence (#234), `orchestrator.js:385-470`, awaited at `:2491` | all | Only if longer than IaC: they start beside `upStack` and are awaited before the outro. | App-key poll 5-10 s (R9); fence probes unmeasured. | Already overlapped. Task 8 adds a `deploy.storage.finish` marker so a slow fence shows. |
| Bucket settle (#233, on main) | all | **No**: one read on a non-zero-window provider (Hetzner 20 min, `src/lib/providers/hetzner-s3.js:30`; every other provider 0), and a note. | n/a | n/a |
| `LOCK_WAIT`, scale cutover + Pulumi state sync (#237) | backup Job, scale | No (not deploy) | n/a | n/a |

### Expected critical path after this plan (estimates, Hetzner)

| Mode | Deploy-owned work | Plus TLS first look (first-ever deploy) | Main contributors |
|---|---|---|---|
| compose | ~165-180 s | ~255-290 s | upStack 67, preamble ~15, delta 10-45 overlapped with logins/bundle/DNS, stack up ~15 (pulls overlapped), admin/audits/health ~17, backup cron 5; TLS residual ~85-110 |
| compose-ha | ~260-290 s | ~300-340 s | infra fan ~100 (Task 6), cold remote build 60-90, pulls/up ~35, replication ~30, health/audits ~20 |
| k8s | ~280-300 s | ~330-380 s | upStack 96, ready 17, cert-manager 36, base 30, delta 10-45 overlapped with CA/observability, rollout 10, traefik 11, health 21 |
| k8s-ha | ~380-420 s | ~430-480 s | max(primary arm ~260, standby arm ~230) + reseed ~30 + verify + copy (overlapped) + DNS |

Sub-3-minute compose holds for deploy-owned work, and for any deploy that reuses a certificate. A first-ever deploy on a provider with a 90 s DNS-01 floor cannot be sub-3 while the first look blocks (D1).

**Candidates recorded, outside this plan:**
- **k8s-ha scale runs primary and standby converge serially** (6.1-6.8 min, perf-analysis.md). That belongs to a separate scale plan.
- **TLS issuance could start earlier on compose.** Traefik asks for a certificate only once a router with `tls.certresolver` exists, and today the routers are labels on the app container, so issuance starts at `start-compose-stack`. A static file-provider router for the apex (and wildcard), started with the bundle, could start the DNS-01 floor ~45-60 s earlier. Needs a spike; owned by a TLS follow-up, not here.
- **k8s-ha db hostPort rendered at apply.** `configurePrimaryForReplication`'s `dbHostPort` patch recreates the primary db pod (`src/lib/deploy/k8s/ha/index.js:629-645`). Rendering the hostPort into the HA db StatefulSet would remove a pod recreate and let primary config run inside the fan-out. It touches the role code #235 just rewrote; measure first.

### History check (required by Brandon before reviving any approach)

Sources: the archived private repo `brandonpowers/vibecarbon` (cloned, filter=blob:none) and this repo's `git log`.

**Why the node binary is copied into bare alpine:**
- Present since the first import (`32afb12` public, `f91eb6f` 2026-03-11 private).
- The stated rationale is size and minimalism ("Production stage — minimal Alpine with just the node binary") plus the alpine-minor coupling to the musl/libstdc++ of the node image (`carbon/Dockerfile:9-12`).
- No CVE-scanner or scorecard rationale was found.
- It is why 131 MB of the 155 MB image is a private, non-pullable layer.

**Cloud-init pre-pull was tried and reverted:**
- `7babb8e` (2026-05-05, "net-negative due to rate limits"): unauthenticated Docker Hub pulls from shared Hetzner IPs throttled. Blocking runcmd also pushed `cloudInitReady` from 5 s to 66 s.
- `e9192f9` (2026-07-29, Option B ruled by Brandon): no cloud-init pre-pull of `registry:2`.
- **This plan pre-pulls only from the CLI, after the server is up, without blocking. Nothing goes in cloud-init.**

**The compose layer-diff push exists but cannot help a cold deploy:**
- `676e113` / PR #201 (2026-07-29) added warm compose redeploys that "ship only changed layers (registry push, sideload fallback)".
- `56e68df` records that on a cold deploy it is "identical work either way (an empty registry has no layers to diff against)". That is tonight's 556 s.
- It also carries a settle ladder `COMPOSE_PUSH_SETTLE_DELAYS_MS` [1 s, 5 s, 15 s] and an unbounded registry volume (`src/lib/deploy/compose/registry-config.js`).

**Tunnel push into in-cluster registries had a long flake class:**
- `91a66a3` (2026-08-11): concurrent pushes stall the uplink, and the registry drops the upload session.
- `a895caa` (2026-08-15): a cross-process uplink lock was needed (`src/lib/deploy/uplink-lock.js`). It records "mitigation-audit cluster 2 (uplink/image transfer, 16 commits 2026-03 -> 2026-08)".
- `3571418`, `b71a00c`, `7e0a277` (2026-08-16/17): registry-500, S3 read-after-write, and two speakers behind the hostPort.
- `5834bdf` (2026-08-30): moved the registry off S3.
- **Lesson: long-lived multi-hundred-MB tunnel pushes from the operator are the fragile part. This plan removes them, and does not harden them further.**

**Sideload and push parallelism was already squeezed:**
- `702d6e7` (2026-05-01) parallelized sideload and push per cluster.
- It is still two full uploads per cluster. Nobody tried sending once and pulling inside the cluster.

**Remote and local builds:**
- `4ed810f` (2026-03-28) moved builds remote to avoid QEMU on ARM operators.
- `2576821` (2026-05-05) made compose default to `local` for speed.
- compose-ha keeps `haRemoteBuild`.
- **This plan does not move compose-ha to local builds.** The QEMU risk for Mac operators is the reason it went remote.

**Parallel transfer streams:**
- Only sideload fan-out across nodes (`702d6e7`).
- No split-stream single-target transfer has ever been tried. The delta makes it unnecessary, since a cold app delta is about 4-5 MB.

**unregistry / `docker pussh`, checked via `gh api`:**
- Apache-2.0, v0.4.3 (2026-06-12), about 4.9k stars, active.
- It requires the containerd image store on the server.
- On first use it pulls `ghcr.io/psviderski/unregistry:latest`, unpinned.
- The operator must install a CLI plugin.

**Docker storage (context7, `/docker/docs`):**
- The containerd image store keeps pulled layers compressed, as received.
- The classic overlay2 store keeps only uncompressed layers, so its pushes recompress and cannot match a registry's existing compressed digests.
- `docker save` has emitted OCI-compliant archives (with a legacy `manifest.json`) since Engine 25.
- Brandon's operator machine is Docker 29.9.0 on **overlay2 (classic)**.

**The HA state lock (refresh 2026-10-21, run 31898658781 in `brandonpowers/vibecarbon`, job 95045761606 log):**
- All 11 `up` throttle events landed 39-150 s after their state bucket was created (18:07:31-44 against 18:05:57; 18:12:18-18:13:55 against 18:11:39; 19:07:01-19:08:23 against 19:06:10). Every `stack-select` throttle landed 2-14 s after its bucket's creation.
- Four of the 11 (18:12-18:13) came from single-cluster k8s (ci3), with no second engine at all: young buckets throttle without any concurrency.
- The compose-ha pair at 18:07 overlapped two `up`s on a ~95 s old bucket and the deploy **failed** (`no stack named 'ci2-primary' found` after the in-place re-run). That bucket was young because the restore flow of that era recreated buckets; a customer's first HA deploy also runs on a minutes-old bucket.
- e2e now pins one long-lived shared state bucket (`tests/e2e/scenarios/_run-lifecycle.ts:2832-2870`), so e2e never exercises the young-bucket path unless `VC_E2E_STATE_BUCKET` names a throwaway bucket.

## Global Constraints
- **No retry ladders.** A failed delta transfer, reconstruct or load fails the deploy with one line, `image delivery failed: <cause>`. There is no fallback to a full sideload. A proposal that adds a ladder is itself the red flag: first ask whether the dependency can be removed (`no-retry-ladders-root-fix-first`).
- A delta that has to send every layer is not a fallback. That is the algorithm itself, for example with a custom Dockerfile or an empty target.
- **No provider-specific slowdowns.** Every change is provider-neutral, or keyed on a provider-declared static (like `bucketSettleWindowMs`, Hetzner 20 min, every other provider 0) so other providers pay nothing. GHCR pulls work from every provider. No new firewall rules.
- No cloud-init pre-pulls (`7babb8e`, `e9192f9`). Server-side pulls start only after `dockerhub-login` (Docker Hub images) or need no auth (public GHCR).
- **Core-path images never come from Docker Hub** (Task 7): traefik, docker-socket-proxy, alpine, registry, socat and alpine/k8s are pulled from `ghcr.io/hyperformant` mirrors, copied as amd64 manifests by `publish-images.yml`, and enforced by `core-images-from-mirror-census.test.ts`. Optional add-ons keep their upstream registries.
- **Images are pinned by digest everywhere.** The runtime base joins the `image-digest-census` and dependabot like every other pin.
- **The runtime image stays minimal:** Alpine, libstdc++ and the node binary only. No npm, yarn or corepack in the running image.
- **No customers, no compatibility shims (pre-1.0).** The compose per-server registry is deleted outright (container, volume, `registryEnsureShell`, settle ladder). Ship with a Compatibility note and never a `!:` / BREAKING CHANGE footer.
- **Pre-existing servers (refresh ruling R5):** no cleanup line for a leftover `vibecarbon-registry` container. There are no customers, e2e servers are fresh, and the one long-lived env (vibecarbon-web) stays on the old CLI; a reconcile line that runs on every deploy for a container nobody has would be the compatibility shim the line above forbids.
- **e2e reproduces the customer cold-start path.** No test-only caches, pre-baked images, pre-pulled layers or warm registries. The runtime base is pulled from public GHCR by the server exactly as a customer's server pulls it.
- **Never print secrets.** Registry tokens, keys and passwords never reach argv, logs, errors or perf markers; the delta's stderr line is the first line of the remote error, which carries no secret by construction (the remote script never echoes env).
- **dotenv writes only through `formatDotenvLine`; `.vibecarbon.json` writes only through `updateProjectConfig`.** No new parser or writer.
- **No Supabase vocabulary** in code, comments, docs or commit messages (the Context's Aug baseline is described as "the previous stack").
- Template uses npm; root uses pnpm. Conventional commits, pathspec commits (`git commit -- <files>`), never `--no-verify`.
- **Sibling plans: all landed in the stack.** `2026-10-20-tls-cert-reuse.md` (#239), `2026-10-20-project-app-bucket.md` (#233, main), `2026-10-20-k8s-ha-registry-copy.md` (#238). Task 8 is unblocked.
- **Release order:** Task 5 must not ship without Task 6 Cause B (the dead seed wait). After #238 the k8s-ha primary arm (~770 s) still masks the standby's 346 s `awaitDb`; Task 5 shortens the primary arm to ~260 s and unmasks it. Both are in this branch; never cut a release between them.
- **The state lock is scoped by bucket age, not removed** (Task 6, Ruling A′): inside the provider's declared settle window the whole `upStack` stays serialized; past it, select, refresh and state repair stay serialized and `stack.up()` runs outside the lock.
- **HA-correctness (#235) is the base, not a peer:** Task 6 must not change the bodies of `configureStandbyReplication`, `promoteStandby` or the reseed functions.

## Review Focus
1. **A user's custom Dockerfile with no runtime base** (or any FROM): the delta sends every layer the target lacks, and the deploy still succeeds. Tested in Task 3.
2. **A warm redeploy whose only change is `dist`:** the delta sends one layer, and the bytes marker shows it. Tested in Task 3 (unit) and Task 4 (docker integration).
3. **The reconstruct dies halfway** (disk full, killed SSH): no partial image is tagged and the temp dir is removed. The next deploy starts clean. Tested in Task 3 (the script's trap, under real bash).
4. **An autoscaler-spawned k8s worker** joining after delivery still pulls the app image. Delivery has to put it in the master registry before any workload references it. Tested in Task 5.
5. **An ARM Mac operator:** the local build still targets linux/amd64 (`src/lib/deploy/platform.js`), and the runtime base is published for amd64 and arm64 (release gate). Tested in Task 2 (workflow-platforms census).
6. **A freshly mirrored GHCR package that is still private:** every anonymous server pull fails with `unauthorized`, while CI's authenticated verify step passes. Task 7 Step 4 checks with an empty Docker config before merge.
7. **A customer's first HA deploy on a young state bucket** (Hetzner): the two engines' `up` must not overlap there, because that is the shape that failed in run 31898658781. Past the window they overlap, and any throttle still shows as `backpressure` in the `[state]` line, which Task 8 turns into a failure. Tested in Task 6 (both arms of the window).
8. **The standby image copy reads what the primary registry now holds:** after Task 5 the primary registry is filled by `ctr images push` from the master's containerd, not `docker push`. `copyAppImageToStandby` and `primaryRegistryHasImage` must still resolve the tag. Tested in Task 5.
9. **A compose server that already serves a certificate** (redeploy): Task 4A must still leave a live certificate alone, and a rebuilt server with a snapshot must still get it restored. Tested in Task 4A.

---

### Task 1: Spike: prove the layer delta round trip on every target store

Status (refresh): **still needed**, unchanged in substance. One fact added (media types for Task 5).

**Files:**
- Create: `tests/integration/docker/layer-delta-roundtrip.test.ts` (gated `DOCKER_INTEGRATION=true`, like `tests/integration/docker/docker-services.test.ts`).
- Create: `tests/integration/docker/fixtures/layer-delta/Dockerfile` (FROM a pinned small base plus one `COPY` layer).

**Interfaces:**
- Produces: a recorded go/no-go in the ledger, plus the exact archive facts Task 3 codes against:
  - the `manifest.json` `Layers[i]` ↔ config `rootfs.diff_ids[i]` pairing;
  - whether `docker load` accepts a legacy `manifest.json` whose `Layers` paths point at gzip or uncompressed files under other names;
  - whether `k3s ctr images import` accepts the same archive;
  - the layer media types `ctr images push` writes to a registry after an import, and whether `ctr images pull --plain-http` (the call `src/lib/deploy/k8s/ha/image-copy.js:64` makes) reads them back (Review Focus 8).

- [ ] **Step 1: Write the test** with three targets:
  - (a) a `docker:29-dind` container with the classic store;
  - (b) `docker:29-dind` with `{"features":{"containerd-snapshotter":true}}`;
  - (c) `rancher/k3s:v1.31.5-k3s1` (the `K3S_VERSION` pin at `src/lib/deploy/k8s/k3s.js:130`), using `ctr images import`, plus a `registry:2.8.3` sidecar for the push/pull round trip.

  For each target:
  - the target pre-pulls the fixture's base;
  - the host builds the fixture and runs `docker save`, then drops every layer blob whose diffID the target reports;
  - the target fills the gaps from its own `docker save <base>` (or `ctr export`), rewrites `manifest.json` `Layers`, and loads.

  Assertions:
  ```ts
  expect(loaded.RootFS.Layers).toEqual(host.RootFS.Layers);
  expect(loaded.Id).toBe(host.Id); // config digest
  expect(run(target, ['run', '--rm', tag, 'cat', '/marker'])).toBe(MARKER);
  expect(deltaBytes).toBeLessThan(fullSaveBytes / 10);
  // (c) only: the pushed tag pulls back through the registry
  expect(ctr(target, ['images', 'pull', '--plain-http', `${reg}/${repo}:${tagName}`]).status).toBe(0);
  ```
- [ ] **Step 2: Run** `DOCKER_INTEGRATION=true pnpm vitest run tests/integration/docker/layer-delta-roundtrip.test.ts`. Expected: all three targets PASS.
  - If (c) fails, record it and rule: Task 5 loads on the master through `docker`-free `ctr import` of a full archive that the master reconstructs with the same script. Re-run.
  - **If (a) or (b) fails, stop the plan.** The delta is the foundation.
- [ ] **Step 3: Commit** `test(deploy): prove the diffID layer delta loads on classic, containerd and k3s targets`.

### Task 2: Publish the runtime base image and run the app on it

Status (refresh): **still needed**. Paths re-checked: `carbon/Dockerfile:13` (`NODE_IMAGE`), `:87-90` (deps stage), `:93-105` (runner `FROM alpine:3.24@sha256:294b683c…`, `apk add`, `adduser`, node `COPY`); `release.yml` `db-image` job is `:44-79`; `node:sync` is `scripts/sync-node-version.js`.

**Files:**
- Create: `docker/node-runtime/Dockerfile`: `FROM alpine:3.24@sha256:294b683c…` (the digest `carbon/Dockerfile:93` pins now). It adds `apk add --no-cache libstdc++`, the `hono` group and user (1001), and `COPY --from=node` of the `NODE_IMAGE` stage's `/usr/local/bin/node`. LABELs follow `docker/postgres-walg/Dockerfile`.
- Create: `.github/workflows/publish-node-runtime-image.yml`, modeled on `.github/workflows/publish-db-image.yml`:
  - amd64 and arm64;
  - tag `ghcr.io/hyperformant/node-runtime:<NODE_VERSION>-alpine3.24`;
  - auto-runs on changes under `docker/node-runtime/**`.
- Modify: `carbon/Dockerfile`:
  - the runner becomes `FROM ${RUNTIME_IMAGE}`, with the global ARG `RUNTIME_IMAGE=ghcr.io/hyperformant/node-runtime:<ver>@sha256:<digest>`;
  - delete the runner's `apk add`, `adduser` and node `COPY` (`:95-105`);
  - keep `COPY --from=deps node_modules`, `dist`, `db/migrations`, entrypoint, `USER hono`.
  - The alpine-minor comment (`:9-12`) moves to the runtime Dockerfile.
- Modify: `src/lib/images.js`: export `NODE_RUNTIME_IMAGE` (full digest ref), the single CLI pin.
- Modify: `scripts/sync-node-version.js` (`pnpm node:sync`) so it writes both Node pins.
- Modify: `.github/workflows/release.yml:44-79`: the "public and multi-arch" job also verifies `NODE_RUNTIME_IMAGE` anonymously.
- Modify: `.github/dependabot.yml` and `.github/image-pins/Dockerfile`: add the pin.
- Test: update `tests/unit/lib/node-version-pins.test.ts`, `tests/unit/deploy/image-digest-census.test.ts`, `tests/unit/deploy/oci-image-metadata.test.ts`, `tests/unit/deploy/workflow-platforms.test.ts`, and `tests/unit/lib/images.test.ts`.

**Interfaces:**
- Produces: `NODE_RUNTIME_IMAGE: string` from `src/lib/images.js`, equal byte-for-byte to the `RUNTIME_IMAGE` ARG default in `carbon/Dockerfile`, enforced by the census.

- [ ] **Step 1: Write failing census assertions:**
  ```ts
  const df = readFileSync('carbon/Dockerfile', 'utf8');
  expect(df).toMatch(new RegExp(`^ARG RUNTIME_IMAGE=${escape(NODE_RUNTIME_IMAGE)}$`, 'm'));
  const runner = df.slice(df.indexOf('AS runner'));
  expect(runner).not.toMatch(/\bapk\b|\badduser\b|COPY[^\n]*\/usr\/local\/bin\/node/);
  ```
  plus: the runtime Dockerfile's alpine digest equals the `NODE_IMAGE` alpine minor; the publish workflow builds `linux/amd64,linux/arm64`; release.yml verifies the runtime ref.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/lib/node-version-pins.test.ts tests/unit/deploy/image-digest-census.test.ts tests/unit/lib/images.test.ts tests/unit/deploy/workflow-platforms.test.ts tests/unit/deploy/oci-image-metadata.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the files above.** Publish the first tag with `gh workflow run publish-node-runtime-image.yml`, flip the new `node-runtime` package PUBLIC (a new GHCR package is created private), then pin the resulting index digest.
- [ ] **Step 4: Verify:**
  - the step 2 tests PASS;
  - `cd carbon && docker build -t rt-check . && docker run --rm rt-check node -e 'console.log(process.version)'` prints the `.nvmrc` version;
  - `docker history rt-check` shows a private top of ≤ 15 MB above the runtime base;
  - `docker run --rm rt-check sh -c 'command -v npm'` exits non-zero;
  - `DOCKER_CONFIG=$(mktemp -d) docker buildx imagetools inspect <NODE_RUNTIME_IMAGE>` succeeds (anonymous);
  - carbon `npm run test:prepush` passes.
- [ ] **Step 5: Commit** `feat(image): run the app on a published node runtime base so servers pull it at datacenter speed`.

### Task 3: The layer delta module

Status (refresh): **still needed**. SSH-option source moved: `sideloadCompose` is now `src/lib/deploy/image.js:174-243`. Added: the send holds the cross-process uplink lock, so `uplink-lock.js` keeps an owner when Task 5 deletes `registry-push.js`.

**Files:**
- Create: `src/lib/deploy/layer-delta.js`.
- Create: `src/lib/deploy/layer-delta-remote.sh` (target-side reconstruct and load, shipped inline over SSH like `reconcile.sh`).
- Test: `tests/unit/deploy/layer-delta.test.ts`, `tests/unit/deploy/layer-delta-remote.test.ts` (runs the script under real bash with a stub `docker`/`ctr`, in the `compose-registry-config` stub-docker style).

**Interfaces:**
- Consumes: Task 1's recorded archive facts.
- Produces:
  - `listTargetDiffIds({ run }) -> Promise<Set<string>>`.
    - `run(cmd) -> Promise<string>` is an SSH runner.
    - The remote command prints every local image's `RootFS.Layers` (docker), or `ctr` content diffIDs for `runtime: 'k3s'`.
  - `buildDelta({ archiveDir, have }) -> { sendPaths: string[], keep: Array<{ index: number, diffId: string }>, totalLayers: number }`.
    - It is pure.
    - It works from an extracted `docker save` directory and the target's diffID set.
    - `sendPaths` always includes `manifest.json`, `index.json`, `oci-layout`, the config blob and every layer blob not in `have`.
  - `deliverImage({ tag, sshTarget, sshKey, runtime: 'docker' | 'k3s', registryRef?: string, basePull?: Promise<void> }) -> Promise<{ bytes: number, layersSent: number, layersReused: number }>`.
    - It awaits `basePull` (when given) before `listTargetDiffIds`, so a base pull still in flight cannot make the delta send base layers.
    - It saves, extracts to a temp dir, calls `listTargetDiffIds` and `buildDelta`, then runs `tar -c <sendPaths> | gzip -1 | ssh <opts> 'sh -s' < layer-delta-remote.sh`.
    - The `ssh` send runs inside `acquireUplinkLock` (`src/lib/deploy/uplink-lock.js:84`), held for the send only.
    - It counts the bytes written to ssh stdin and emits `[perf] deploy.image.delta bytes=<n> sent=<k> reused=<m>`.
    - It throws `image delivery failed: <first stderr line>` on any non-zero exit.
    - SSH opts come from `SSH_CONNECTION_OPTS` and the per-env known_hosts, exactly as `sideloadCompose` builds them today (`src/lib/deploy/image.js:174-243`).
  - The remote script:
    - uses `mktemp -d` under `/var/lib/vibecarbon/delta`, with `trap 'rm -rf "$d"' EXIT`;
    - fills each missing `Layers[i]` from a local `docker save` (or `ctr export`) of an image that holds that diffID;
    - rewrites `manifest.json` `Layers[i]` to the filled path, then loads with `docker load` or `k3s ctr -n k8s.io images import`;
    - with `registryRef` set, tags and pushes into the in-cluster registry (`ctr images push --plain-http`);
    - verifies the loaded image's diffIDs equal the manifest's, and exits non-zero otherwise.

- [ ] **Step 1: Write the failing unit tests:**
  ```ts
  it('sends only the app layers when the target holds the base', () => {
    const d = buildDelta({ archiveDir: fixture, have: new Set(BASE_DIFF_IDS) });
    expect(d.sendPaths.filter(isLayerBlob)).toEqual(APP_LAYER_BLOBS);
    expect(d.sendPaths).toEqual(expect.arrayContaining(['manifest.json', 'index.json', 'oci-layout', CONFIG_BLOB]));
  });
  it('sends every layer to an empty target', () => { /* Review Focus 1 */ });
  it('sends exactly one layer when only dist changed', () => { /* Review Focus 2 */ });
  it('maps a failed remote load to one line and never retries', async () => {
    const ssh = stubSsh({ exit: 1, stderr: 'no space left on device\nmore' });
    await expect(deliverImage({ ...args, deps: { ssh } })).rejects.toThrow('image delivery failed: no space left on device');
    expect(ssh.calls).toBe(1);
  });
  it('waits for the base pull before listing diffIDs', async () => { /* basePull resolves after list would have run */ });
  ```
  - the remote script, under bash with a stub `docker load` that exits 1, leaves no dir under the delta root and no tag (Review Focus 3).
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/layer-delta.test.ts tests/unit/deploy/layer-delta-remote.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** to the interfaces above.
- [ ] **Step 4: Run** the step 2 tests and `DOCKER_INTEGRATION=true pnpm vitest run tests/integration/docker/layer-delta-roundtrip.test.ts`, switched to call `deliverImage` against the dind targets. Expected: PASS.
- [ ] **Step 5: Commit** `feat(deploy): ship only the image layers the target lacks, keyed by diffID`.

### Task 4: compose delivers by delta, pulls overlap the transfer, and the per-server registry goes

Status (refresh): **reshape**. Lines moved; the stack-pull start point moves to after `setup-server-files`; `transferImageBetweenServers` is dead and is deleted; the census merges into the registry-copy census (R2). Expected saving: `image.transfer` 562 s → ~10-45 s on a cold compose deploy, and `compose.up` 28 → ~15 s with pulls overlapped.

**Files:**
- Modify: `src/lib/deploy/effects/index.js:166-253` (`transferImage`, local mode):
  - start `basePull = sshRunAsync(serverIp, key, 'docker pull ' + baseRef)`, where `baseRef` is the `RUNTIME_IMAGE` ARG default parsed from the project's own `Dockerfile` (none found means no base pull);
  - then `deliverImage({ tag: localImageTag, sshTarget: 'root@' + serverIp, sshKey, runtime: 'docker', basePull })`;
  - delete the registry branch and the `sideloadCompose` fallback (`:189-230`), and the `sideloadCompose` import (`:24`).
- Modify: `src/lib/deploy/effects/index.js` `setupServerFiles` (the effect behind `setup-server-files`, step order in `src/lib/deploy/plan/deploy-plan.js:72-78`): after the bundle lands, start `pullComposeImages(...)` (`src/lib/deploy/compose/index.js:1103`, already excludes `app`) without awaiting. It reads the compose files the bundle just wrote, and both registry logins (`:73-74`) have already run. Store it as `ctx.stackPullPromise`, attach a no-op catch the way `transferImagePromise` does (`:252`), and await it in `startComposeStack` (`:465`) beside the transfer barrier, before `deploy.reconcile.run`.
- Delete:
  - `src/lib/deploy/compose/registry.js` and `src/lib/deploy/compose/registry-config.js`;
  - `registryEnsureShell()` and its call from `src/lib/deploy/bundle.js:16,174-176`, with nothing in its place (R5);
  - `sideloadCompose` from `src/lib/deploy/image.js:158-243` and its file-header note (`:9`);
  - `transferImageBetweenServers` (`src/lib/deploy/compose/index.js:674`, no caller in `src/`) and `tests/unit/deploy/image-transfer.test.ts`.
- Modify: `src/lib/deploy/registry-push.js`: drop the compose-only comments (`:6`, `:221-253`, `:684`). It remains k8s-only until Task 5.
- Test:
  - delete `tests/unit/deploy/compose-registry.test.ts`, `compose-registry-transfer.test.ts`, `compose-registry-config.test.ts` and `image-transfer.test.ts`, and the `sideloadCompose` cases in `tests/unit/deploy/image.test.ts`, with the justification in the commit;
  - update `tests/unit/deploy/effect-concurrency.test.ts`;
  - `git mv tests/unit/deploy/k8s-image-delivery-census.test.ts tests/unit/deploy/image-delivery-census.test.ts` (R2): add `deliverImage` to `PRIMITIVES`, change the `lib/deploy/effects/index.js:transferImage` row to `calls: ['deliverImage']`, and add a second `describe` that walks the same `parseAst` tree and fails on any string literal or template containing `docker save`, `docker load` or `ctr images import`/`ctr -n k8s.io images import` outside `layer-delta.js`, `layer-delta-remote.sh` and `k3s.js:sideloadK3s` (k8s, until Task 5). Comments never count.

**Interfaces:**
- Consumes: Task 3 `deliverImage`; Task 2 `RUNTIME_IMAGE` ARG convention.
- Produces: `ctx.stackPullPromise: Promise<void>`, started at the end of `setupServerFiles`, awaited in `startComposeStack` before `deploy.reconcile.run`.

- [ ] **Step 1: Write the failing tests:**
  - the census, which currently fails on `effects/index.js:transferImage` (`pushImageOverSshTunnel`) and `image.js` (`docker load`);
  - an effect test: `transferImage` starts `docker pull <baseRef>`, passes that promise as `basePull`, and never calls `pushImageOverSshTunnel`;
  - a step-order test:
    ```ts
    const order = await runComposePlanWithFakes();
    expect(order.indexOf('stackPull:start')).toBeGreaterThan(order.indexOf('setup-server-files:bundle'));
    expect(order.indexOf('stackPull:awaited')).toBeLessThan(order.indexOf('reconcile.run'));
    ```
  - a structural test: no file under `carbon/cloud-init/` gains a `docker pull` (re-pins `7babb8e`).
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/image-delivery-census.test.ts tests/unit/deploy/effect-concurrency.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes above.
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm test:unit && DOCKER_INTEGRATION=true pnpm test:docker`. Expected: PASS.
- [ ] **Step 5: Commit** `perf(compose): cold deploys ship only the app layers and overlap stack pulls with the transfer`.

### Task 4A (new): restore-tls asks S3 before it touches the server

Status (refresh): **new**, from the critical-path audit. Today `restoreComposeTls` (`src/lib/deploy/compose/tls-restore.js:184`) runs the live check first (`:205-215`), and the live check is `docker compose run --rm traefik` (`:84-92`). On a cold server that pulls Traefik from Docker Hub, serially, before `start-compose-stack`, only to learn that a brand-new server has no certificate, and on a first-ever deploy there is no snapshot to restore anyway. Expected saving: a Traefik pull plus one container run on every first deploy (~5-20 s, unmeasured; Task 9 records `deploy.tls.restore`). No change to what gets restored.

**Files:**
- Modify: `src/lib/deploy/compose/tls-restore.js` `restoreComposeTls`: read the snapshot (`readTlsSnapshot`, keyed by `tlsSnapshotKey`) first; on no snapshot (or a refused one) return its reason without any SSH; only with a valid snapshot in hand run `readLiveApexCertificate` and the write, unchanged. `restoreFailoverTls` (`:323`) keeps its order (the promoted standby already runs Traefik, so its check is local).
- Test: `tests/unit/deploy/compose-tls-restore.test.ts` (extend).

**Interfaces:**
- Unchanged signature and result shape: `{ restored: boolean, reason: string, dropped?: number }`. The reasons `no snapshot`, `snapshot refused: …`, `live certificate present` keep their spelling, so `tlsRestoreLine` (`:294`) is unchanged.

- [ ] **Step 1: Write the failing tests:**
  ```ts
  it('never touches the server when there is no snapshot', async () => {
    const ssh = vi.fn();
    const r = await restoreComposeTls({ ...args, deps: { read: async () => ({ text: null, reason: 'no snapshot' }), ssh } });
    expect(r).toEqual({ restored: false, reason: 'no snapshot' });
    expect(ssh).not.toHaveBeenCalled();
  });
  it('still leaves a live certificate alone when a snapshot exists', async () => { /* Review Focus 9 */ });
  it('still restores onto a rebuilt server that has none', async () => { /* Review Focus 9 */ });
  ```
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/compose-tls-restore.test.ts`. Expected: the first case FAILS.
- [ ] **Step 3: Implement** the reorder.
- [ ] **Step 4: Run** `pnpm vitest run tests/unit/deploy/compose-tls-restore.test.ts tests/unit/deploy/final-save-tls.test.ts && pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `perf(deploy): restore-tls reads the snapshot before it touches the server, so a first deploy pulls nothing for it`.

### Task 5: k8s delivers once, into the master registry, and nodes pull

Status (refresh): **reshape**. #238 replaced the sideload call site with `deliverAppImage` (`src/lib/deploy/k8s/k3s.js:4873-4945`, `planImageDelivery` in `src/lib/deploy/k8s/image-delivery.js:29`); only the app image is sideloaded today (no backup image); the registry push now starts at `k3s.js:4301` and is awaited at `:4854`. The barrier moves from "before applyBase" (impossible: the registry pod is in base) to "before the step-6 app patch". Expected saving: k8s `sideload.app` 629 s + `registryPush.app` 523 s → one ~10-45 s delta overlapped with the CA and observability applies (~1,100 s on a cold k8s deploy); k8s-ha primary arm ~770 s → ~260 s.

**Files:**
- R7 (registry-copy plan): this task lands second, so it updates the census `SITES` table (now `tests/unit/deploy/image-delivery-census.test.ts` after Task 4).
- Modify: `src/lib/deploy/k8s/k3s.js`:
  - `deliverAppImage` (`:4873`): keep the build gate (`k3s-build`); delete the `k3s-sideload` branch (`:4921-4935`) and the `sideloadK3s` dep. It returns the built tag only.
  - `planImageDelivery` (`image-delivery.js:29`): `{ build, deliver, awaitPeerImage }` replaces `{ build, sideload, registryPush, awaitPeerImage }`; the standby row stays all-false except `awaitPeerImage`. Update `shouldSkipK3sApply` (`k3s.js:4977`) and the apply gate's registry probe (`primaryRegistryHasImage`, `:4950`) to read `deliver`.
  - `deployK3s`, right after `onInfraReady` (`:5238-5244`): start `basePull = sshRun(masterIp, 'k3s ctr -n k8s.io images pull ' + baseRef)` without awaiting (beside `prePullImages`, `:5257`), and pass it to `applyK3sManifests`.
  - `applyK3sManifests`: replace the backgrounded `pushImageToLocalRegistry` (`:4268-4319`) with `deliveryPromise = perfAsync('deploy.${perfPrefix}.image.deliver', () => deliverImage({ tag: imageTag, sshTarget: 'root@' + masterIp, sshKey, runtime: 'k3s', registryRef: imageTag, basePull }))`, started right after `localRegistry.wait` (`:4242`). Await it immediately before the step-6 `deployment/app` patch (`:4610-4650`), so the CA apply, observability apply and CA rollout overlap it. Delete the end-of-function await (`:4854`).
  - delete `sideloadK3s` (`:1753-1840`, with its `SIDELOAD_DELAYS_MS` ladder) and `pushImageToLocalRegistry` (`:1879`).
- Modify: no `imagePullPolicy` change needed: `carbon/k8s/base/app/deployment.yaml:46,100` are already `IfNotPresent`, and the patched tag is the `<masterPrivateIp>:5000/...` ref the master's `registries.yaml` mirror serves (`carbon/cloud-init/k3s/master-init.sh:57-62`). Update the comments at `k3s.js:4667-4669` that say "sideloaded image".
- Delete: `src/lib/deploy/registry-push.js` (no caller left), `tests/unit/deploy/registry-push.test.ts`, `registry-push-serialization.test.ts`, `k3s-push-image.test.ts`, the `pushImageToLocalRegistry` cases in `k3s-hetzner-byte-identical.test.ts`, and the `pushImageOverSshTunnel` row in `tests/unit/lib/shared-helper-consumers.test.ts:68`. `uplink-lock.js` stays (Task 3 owns it now).
- Test:
  - update `tests/unit/deploy/k3s-prepull-images.test.ts`, `k3s-standby-image-delivery.test.ts`, `k8s-image-delivery.test.ts`, `k3s-apply-gate-registry-verify.test.ts`;
  - new `tests/unit/deploy/k8s-image-delivery-order.test.ts`: delivery starts after `localRegistry.wait`, is awaited before the `deployment/app` patch, and runs once per image, never once per node (Review Focus 4);
  - in `image-delivery-census.test.ts`: `PRIMITIVES` loses `sideloadK3s`, `pushImageToLocalRegistry`, `pushImageOverSshTunnel`; the `deliverAppImage` row becomes `calls: ['buildAppImage']`; a new `applyK3sManifests` row `calls: ['deliverImage'], gated: true, why: 'primary only: planImageDelivery deliver is false for role standby'`; the forbidden-string arm drops its `sideloadK3s` exemption.

**Interfaces:**
- Consumes: Task 3 `deliverImage` (`runtime: 'k3s'`, `registryRef`, `basePull`).
- Produces: the in-cluster registry holds the app tag before any workload references it. The registry-copy path (`copyAppImageToStandby`) and `primaryRegistryHasImage` read it from there (Review Focus 8).

- [ ] **Step 1: Write the failing tests** above, plus:
  ```ts
  it('the standby copy and the apply-gate probe resolve a ctr-pushed tag', async () => {
    // fixture registry filled by `ctr images push` (Task 1 media types)
    expect(await primaryRegistryHasImage({ ...fixture, run })).toBe(true);
  });
  ```
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/k8s-image-delivery-order.test.ts tests/unit/deploy/image-delivery-census.test.ts tests/unit/deploy/k3s-standby-image-delivery.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use the marker name `deploy.${perfPrefix}.image.deliver`, so the e2e collector can attribute it.
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration`. Expected: PASS.
- [ ] **Step 5: Commit** `perf(k8s): deliver the app once to the master registry; nodes pull in-cluster instead of a sideload per node`.

### Task 6: compose-ha and k8s-ha serial waits: lock scope, dead seed path, event-triggered transport

Status (refresh): **reshape**. Cause A's gate was run (History check); Ruling A becomes A′ (window-gated). Cause B unchanged except paths. Ruling C keeps `namespaceReady` and drops `primaryDbReady`. HA-correctness (#235) has landed, so this task rebases onto it rather than landing first. Expected saving: compose-ha `iac.upStack.fan` 196 → ~100 s on every deploy past the bucket's settle window (every deploy on a 0-window provider); k8s-ha standby `awaitDb` 346 → ~5 s (on the critical path once Task 5 lands); k8s-ha serial `replication.transport` ~26 s and the serial `copy-standby-image` move into the fan-out.

Both waits are root-caused (2026-10-20 RCAs, summarized here so this plan stands alone; full reports were written to the session scratchpad as `arch-review/rca-composeha-upstack.md` and `arch-review/rca-k8sha-awaitdb.md`).

**Cause A, compose-ha standby `upStack` ~100 s late: our state lock.**
- `withStateLock` (`src/lib/iac/state-lock.js:96`) wraps the whole of `upStack` (`src/lib/iac/index.js:1086-1098`), provisioning included. compose-ha fans the primary and standby `upStack` out under `Promise.all` (`src/lib/deploy/effects/compose-ha.js:237-262`) against one state bucket, so they run one after the other. The k8s-ha clusters (`k3s.js:5150`, fanned out by `effects/k8s-ha.js:223-280`) share the same lock and the same serialization.
- Evidence: `e2-2026-10-20T09-17…log` prints `state lock acquired after 93s`; primary 92.9 s, standby 188.8 s, standby's own work 95.8 s. Every e2 log since 2026-09-01 shows a lock wait equal to the primary's up; none before 2026-08-12 shows any wait.
- Origin: `de0f522` (2026-08-15, archived private repo, shipped via `32afb12`), a deliberate trade against throttle events in run 31898658781.

**Ruling A′ (refresh): scope the lock by the state bucket's age against the provider's declared settle window.**
- The gate was run during the refresh (History check, "The HA state lock"). Every `up` throttle landed inside a young bucket's first 150 s, so the steady-state case the original Ruling A relied on holds. But the same log shows an HA pair overlapping `up` on a ~95 s old bucket and failing, and a customer's first HA deploy is exactly a young bucket.
- So: `upStackImpl` (`src/lib/iac/index.js:545`) runs `select`, `cancel`, `refresh` and the Vultr repair under the lock, then releases it before `stack.up()` (`:629`), **unless** the state bucket is inside its provider's settle window (`storageSettleStatus(createdAt, now, bucketSettleWindowMs)` from `src/lib/deploy/bucket-settle.js`), in which case the whole `upStackImpl` stays under the lock exactly as today. Hetzner declares 20 min; every other provider declares 0, so they never read the age and never wait.
- The state bucket's creation time is read once per deploy, only on a non-zero-window provider, beside IaC the way `readBucketSettleState` (`orchestrator.js:460`) reads the app bucket's; an unreadable age counts as young (the safe side).
- Why not one stack for the pair: about 18 files key on the `-primary`/`-standby` stack names, and #235 just rewrote role tracking in them. Not for ~90 s.
- Cost if wrong: two engines' `up` overlap past the window; any throttle is still caught by `withStateBackendRetry` and shows as `backpressure` in the `[state]` line, which Task 8 turns into a failure.
- `syncServerState` (`src/lib/iac/server-state.js:112`, #237) keeps its whole-operation lock: it is a state read-modify-write, not provisioning.

**Cause B, k8s-ha standby `awaitDb` 345-360 s: a seed path that never succeeds on a cold deploy.**
- The `seed-standby` init container (`carbon/k8s/base/db/statefulset.yaml:374-416`, volume `:577-579`; script `buildStandbySeedInitScript`, `src/lib/deploy/replication.js:483`, `deadlineSeconds: 360`; ConfigMap applied by `applyDbSeedConfigMap`, `k3s.js:2603-2640`, called at `:4051`) waits its full budget, exits unseeded and runs initdb. 8 cold runs on 2026-10-20 took 345-359 s; the one redeploy with existing data took 1.2 s.
- Nothing it needs exists in its window: early prep's `waitForNamespace` (`src/lib/deploy/k8s/ha/index.js:362`, 36 × 5 s) gives up before the cold standby namespace exists (`transportEarly ~197s (failed)` in every cold run since 2026-08-28), and the primary's replication config is chained on the whole primary deploy (`effects/k8s-ha.js:340-346`).
- What seeds the standby is the serial `setupReplication` reseed, every time (~30 s). Masked today by the primary arm's sideload and push; unmasked by Task 5 (release order in Global Constraints).

**Ruling B: delete the first-boot seed path; the reseed is the single owner of standby seeding.** Unchanged. Cost if wrong: none observable; the reseed already does the work.

**Ruling C (refresh): signal the namespace; leave primary config where it is.**
- The `vibecarbon` namespace is created by `applyVibecarbonSecrets` (`k3s.js:2086-2107`, called at `:3988`), before base, not by applyBase. Each cluster's deploy resolves an `onNamespaceReady` callback right after that call, the same pattern as `onInfraReady` (`k3s.js:5238`). `effects/k8s-ha.js` turns both into deferreds; early prep starts `prepareReplicationTransport` when both have resolved. `waitForNamespace` and its 180 s budget are deleted, and so is the namespace poll inside `prepareReplicationTransport` (`ha/index.js:431-445`).
- **Dropped: `primaryDbReady`.** `configurePrimaryForReplication` (`ha/index.js:552`) patches the db StatefulSet's hostPort and waits for the pod to be recreated (`:629-645`). Starting it at the primary's `awaitPostgresAccepting` would recreate the primary db pod under its own migrations, admin creation, RLS audit and `verifyWalgBackups` (`k3s.js:5446`). With the seed path deleted, nothing inside the fan-out needs the primary configured early; the chain stays on `primaryPromise` and overlaps the standby arm whenever the primary finishes first.
- With early prep succeeding cold, `startStandbyImageCopy` (`effects/k8s-ha.js:428`) starts as soon as the fan-out ends, overlapping `configure-replication` instead of waiting behind `verify-streaming`.

**Files:**
- Modify: `src/lib/iac/state-lock.js` (header: the new scope and the 2026-10-21 evidence replace the "COST" paragraph) and `src/lib/iac/index.js` (`upStackImpl` `:545-630`, `upStack` `:1086`): lock held for select, cancel, refresh and repair; released before `stack.up()` past the window; whole operation inside it.
- Modify: `src/lib/deploy/orchestrator.js` (read the state bucket's creation time beside IaC, non-zero window only) and the `upStack` callers that need it threaded (`effects/index.js:74`, `effects/compose-ha.js:240,253`, `k3s.js:5150`) as an `options.stateBucketYoung: boolean`.
- Modify: `carbon/k8s/base/db/statefulset.yaml` (delete the `seed-standby` init container, its volume, and the header lines `:29-30`); `src/lib/deploy/k8s/k3s.js` (delete `applyDbSeedConfigMap` (`:2603-2638`) and its call (`:4049-4051`), the `buildStandbySeedInitScript` import, the `REPL_RELAY_HOST/PORT` values at `:2719-2720` and the comment at `:3599`, after grepping that nothing else reads them); `src/lib/deploy/replication.js` (delete `buildStandbySeedInitScript` and its doc, `:450-532`; it composes the shared `buildStagedBasebackupScript` and `buildPrimaryConninfo`, which the reseeds keep, but its `exhaustExitZero` and `deadlineSeconds` options (`:270-290`, `:399`) have no other caller and go with it, taking the 24 × 15 s basebackup ladder along; fix the stale `reseed-standby.test.ts` reference at `:36`); comments in `src/lib/deploy/db-workload.js:22`, `src/lib/deploy/walg-role.js:241`, `src/lib/walg/restore-marker.js:11` (RESTORE_TARGET stays: the walg-restore init reads it, `statefulset.yaml:316`).
- Modify: `src/lib/deploy/effects/k8s-ha.js` (`namespaceReady` deferreds fed by `onNamespaceReady`; early prep awaits them instead of infra alone; the stale "backend pre-init" comment at `:186-194` says select stays serialized), `src/lib/deploy/k8s/ha/index.js` (delete `waitForNamespace` and the poll), `src/lib/deploy/k8s/k3s.js` (`onNamespaceReady` after `applyVibecarbonSecrets`).
- Test: `tests/unit/iac/state-lock-wiring.test.ts` (rewrite: its "never runs two ups against one state bucket at the same time" becomes the young-bucket arm), `tests/unit/iac/state-lock-scope.test.ts` (new), `tests/unit/deploy/db-init-no-peer-census.test.ts` (new), `tests/unit/deploy/k8s-ha-signalled-preconditions.test.ts` (new); delete `tests/unit/deploy/standby-seed-script.test.ts`, `standby-seed-wiring.test.ts` and the `waitForNamespace` cases in `k8s-ha-transport-prep.test.ts`; trim the seed pins in `k8s-db-statefulset.test.ts:121,136,277` and `db-sts-boot-timeout-census.test.ts:20` (justify each in the commit).

**Interfaces:**
- Produces: `withStateLock(key, label, fn)` keeps its signature (the label prefix still feeds `recordStateOp`); `upStackImpl` takes `options.stateBucketYoung` and calls the lock with labels `stack-select <s>` and `refresh <s>`, plus `up <s>` only when young. `deployK3s` accepts `onNamespaceReady: () => void`. `effects/k8s-ha.js` keeps `namespaceReady: { primary: Promise<void>, standby: Promise<void> }` local to `haK8sProvisionClusters`.
- Consumes: Task 5's apply ordering (it rebases onto it in `applyK3sManifests`); nothing else from Tasks 1-5.

- [ ] **Step 1: Ruling A′ evidence is recorded** (done in the refresh; History check). Re-read it into the ledger with the job id `95045761606`; no rerun needed.
- [ ] **Step 2: Write the failing tests.**
  ```ts
  // state-lock-scope.test.ts
  it('past the window, two ups on one bucket overlap while selects stay serial', async () => {
    const { peakUp, peakSelect } = await runPair({ stateBucketYoung: false });
    expect(peakUp).toBe(2);
    expect(peakSelect).toBe(1);
  });
  it('inside the window, the ups never overlap (Review Focus 7)', async () => {
    const { peakUp } = await runPair({ stateBucketYoung: true });
    expect(peakUp).toBe(1);
  });
  it('a 0-window provider never reads the bucket age', async () => {
    const age = vi.fn();
    await provisionHaPair({ provider: 'digitalocean', deps: { bucketCreatedAt: age } });
    expect(age).not.toHaveBeenCalled();
  });
  ```
  - `db-init-no-peer-census.test.ts`: no init container in `carbon/k8s/base/db/statefulset.yaml` references `SEED_PRIMARY_`, `REPL_RELAY_` or `pg_basebackup`; no manifest under `carbon/k8s/base` references `vibecarbon-seed-standby`.
  - `k8s-ha-signalled-preconditions.test.ts`: `prepareReplicationTransport` is called exactly once, after both `namespaceReady` resolve and never before; `waitForNamespace` is not exported; with early prep resolved true, `startStandbyImageCopy` starts before `haK8sConfigureReplication` returns.
- [ ] **Step 3: Run** `pnpm vitest run tests/unit/iac/state-lock-scope.test.ts tests/unit/iac/state-lock-wiring.test.ts tests/unit/deploy/db-init-no-peer-census.test.ts tests/unit/deploy/k8s-ha-signalled-preconditions.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** the Files list.
- [ ] **Step 5: Run** `pnpm test:unit`. Expected: PASS. Prove each census arm bites (temporarily re-add the seed init container; temporarily hold the lock through `up` past the window) and record it in the report.
- [ ] **Step 6: Commit**, one commit per cause:
  - `perf(iac): past a bucket's settle window, hold the state lock for select and refresh only, so an HA pair provisions in parallel`;
  - `perf(k8s-ha): drop the standby first-boot seed that never succeeded, and start transport when both namespaces are signalled`.
- **No retry ladders and no deadline changes:** conditions are fixed, not timers.

### Task 7: Core-path Docker Hub images come from our GHCR mirror

Status (refresh): **still needed**, refs updated. Brandon approved this on 2026-10-20. Docker Hub rate-limits anonymous pulls per IP, and cloud servers often inherit IPs that have already hit the limit. A cloud-init pre-pull was reverted over exactly this (`7babb8e`). No time claim: a throttled pull costs minutes or fails the deploy; this removes the exposure.

**Scope** (core path only; every ref is already digest-pinned today):

| Upstream (docker.io) | Where it runs |
|---|---|
| `traefik:v3.6.11` | compose (`carbon/docker-compose.yml:9`), k8s (`carbon/k8s/base/traefik/deployment.yaml:28`); also pulled by `restore-tls` before Task 4A skips it |
| `tecnativa/docker-socket-proxy:v0.4.2` | compose prod, **two services** since #234: `docker-socket-proxy` (`carbon/docker-compose.prod.yml:98`) and `app-docker-proxy` (`:146`) |
| `alpine:3.24.2` | the DO CSI init-container pin (`src/lib/images.js:452`, `CSI_UPSTREAM_IMAGE_PINS`) |
| `registry:2.8.3` | k8s in-cluster registry (`carbon/k8s/base/registry/local-registry.yaml:40,50`). The compose per-server registry (`src/lib/deploy/compose/registry-config.js:31`) is deleted by Task 4, so it is out of scope. |
| `alpine/socat:1.8.1.3` | k8s-ha `carbon/k8s/base/repl-gateway/repl-gateway.yaml:80` and `registry-relay.yaml:52` (#238), compose-ha `SOCAT_IMAGE` (`src/lib/deploy/compose/ha.js:266-267`) |
| `alpine/k8s:1.31.12` | the deploy-rendered backup CronJob (`carbon/k8s/base/backup/cronjob.yaml:84`, rendered at `k3s.js:2968`). Not on the deploy path, but every k8s cluster pulls it daily. |

Out of scope: n8n, Metabase, Redis, observability (the add-ons in `services/index.json`), the n8n and Metabase `alpine` helpers (`carbon/docker-compose.n8n.yml:81`, `docker-compose.metabase.yml:69`), the diagnose-only `DIAG_*` images (`images.js:594-597`), and `BINFMT_IMAGE` (`src/lib/deploy/platform.js:64`, runs on the operator's machine). **k3s's own system images** (coredns, local-path-provisioner, metrics-server, `rancher/mirrored-pause`) also come from docker.io on every k8s node; they are out of scope until D3 is ruled.

**Files:**
- Modify: `src/lib/images.js`. Generalize the registry.k8s.io mirror set and do not duplicate it:
  - Add `DOCKERHUB_UPSTREAM_REGISTRY = 'docker.io'` and `DOCKERHUB_MIRRORS`, a list of `MirroredImage` entries `{ repo, tag, digest }`, where `repo` is the Docker Hub path (`library/traefik`, `tecnativa/docker-socket-proxy`, `library/alpine`, `library/registry`, `alpine/socat`, `alpine/k8s`).
  - Give each `MirroredImage` an `upstream` registry field, defaulting to `K8S_UPSTREAM_REGISTRY` (`:278`) for existing entries. Rename `MIRRORED_K8S_IMAGES` (`:483`) to `MIRRORED_IMAGES` (the union, still `dedupeImages` `:502`), `k8sUpstreamRef` (`:528`) to `upstreamRef`, and `mirroredK8sPackageNames` (`:556`) to `mirroredPackageNames`, and update every importer.
  - Package names stay flat basenames (`traefik`, `docker-socket-proxy`, `alpine`, `registry`, `socat`, `k8s`). `mirroredImageName` must refuse a basename collision between two different repos. `alpine/k8s` → `k8s` and `library/alpine` → `alpine` do not collide today; the guard keeps it that way.
  - Add ref helpers per image (`traefikImageRef()`, `socatImageRef()`, …) returning `ghcr.io/hyperformant/<name>:<tag>@<digest>`.
- Modify: `scripts/mirror-matrix.mjs`: emit from `MIRRORED_IMAGES`. `src` is `upstreamRef(image)`, so the copy reads `docker.io/library/traefik:v3.6.11`.
- Modify: `.github/workflows/publish-images.yml` `mirror-upstream-images`: no logic change. Add a `docker/login-action` step for Docker Hub using the existing Docker Hub CI credential (read its secret name from the repo's workflows), so the mirror job itself is not rate-limited. Update the header comments that say "registry.k8s.io". Add a weekly `schedule:` job, `mirror-upstream-drift`, that lists newer upstream tags per mirrored repo (registry `tags/list` with a semver filter) into the job summary. It only reports, never re-pins.
- Modify every core-path ref in the scope table to the ghcr mirror, pinned by digest. `MirroredImage.digest` is upstream's **linux/amd64 child** digest (`src/lib/images.js:280-293`, read with the `imagetools inspect --raw | jq` command there), and the mirror job copies exactly that manifest. Where today's Docker Hub pin is the multi-arch index digest, the mirrored ref's digest therefore changes to the amd64 child's; check each of the six before rewriting.
  - `carbon/docker-compose.yml` and `carbon/docker-compose.prod.yml` (both socket-proxy services): literal refs, since compose files cannot import JS.
  - The k8s base YAMLs, including `registry-relay.yaml` and `cronjob.yaml`: literal refs.
  - `compose/ha.js` `SOCAT_IMAGE` and `CSI_UPSTREAM_IMAGE_PINS`: through the `images.js` helpers.
- Modify: `.github/dependabot.yml`. Dependabot stops seeing these images once the refs point at our mirror. Bumps follow the existing registry.k8s.io mirrors' flow: edit `{tag, digest}` in `images.js` and the literal refs, merge, and `publish-images` mirrors the new tag. Add a comment block saying so.
- Create: `tests/unit/deploy/core-images-from-mirror-census.test.ts` (a walk, not a hand list):
  - (a) Walk `carbon/docker-compose*.yml` minus the add-on overlays, derived from `services/index.json` names (`docker-compose.<addon>*.yml`) rather than a hand list; plus `carbon/k8s/base/**/*.yaml` minus the add-on directories, `carbon/cloud-init/**`, and `src/**/*.js` (AST string literals, the same `parseAst` walk the image-delivery census uses).
  - (b) Every `image:` value, and every string literal matching `^[a-z0-9./-]+:[^@\s]+@sha256:`, must start with `ghcr.io/hyperformant/`, `{{`, `${`, or be in a short documented allowlist (the app image placeholders, `DIAG_*`, `BINFMT_IMAGE`). A bare Docker Hub name fails with `core-path image <ref> pulls from Docker Hub; mirror it in DOCKERHUB_MIRRORS`.
  - (c) Every `ghcr.io/hyperformant/<name>:<tag>@<digest>` literal must match a `MIRRORED_IMAGES` entry on name, tag and digest.
  - Prove each arm bites: revert `traefik` in `docker-compose.yml` to the docker.io ref (b fails), and change one mirror ref's digest (c fails). Restore both.
- Modify: `tests/unit/deploy/k8s-image-mirrors.test.ts` and its importers for the renames. Add a case where `node scripts/mirror-matrix.mjs` includes `docker.io/library/traefik:v3.6.11` → `ghcr.io/hyperformant/traefik:v3.6.11`.

**Interfaces:**
- Consumes: nothing from Tasks 1-6. It can land any time before Task 9.
- Produces: `MIRRORED_IMAGES`, `DOCKERHUB_MIRRORS`, `upstreamRef`, `mirroredPackageNames`, and the per-image ref helpers (`traefikImageRef`, `socatImageRef`, `registryImageRef`, `alpineImageRef`, `dockerSocketProxyImageRef`, `alpineK8sImageRef`).

**Rulings:**
- **amd64-only copy, as today.** Deploy is amd64-only (`assertAmd64ServerType`), and the existing mirror job copies only the linux/amd64 child manifest. Cost if wrong: none until ARM is supported.
- **Release gate:** a newly mirrored package is created PRIVATE, and servers pull anonymously. The six new packages must be flipped PUBLIC by hand before this task's refs merge. Add the six names to `mirroredPackageNames()`, the operator checklist. Run the mirror job on the branch, flip the packages public, then merge.
- **`dockerhub-login` stays for the add-ons.** After this task it only matters for n8n, Metabase, Redis and observability pulls.

- [ ] **Step 1: Write the census and the matrix case.** Run `pnpm vitest run tests/unit/deploy/core-images-from-mirror-census.test.ts tests/unit/deploy/k8s-image-mirrors.test.ts`. Expected: FAIL. Arm (b) names every docker.io ref in the scope table.
- [ ] **Step 2: Implement** the `images.js` generalization, the matrix, the workflow login and drift job, and the ref rewrites.
- [ ] **Step 3: Run** the same command plus `pnpm test:unit`. Expected: PASS, with both arm-bite proofs recorded in the report.
- [ ] **Step 4: Publish.** Run `gh workflow run publish-images.yml --ref <branch>`. Then confirm `docker buildx imagetools inspect ghcr.io/hyperformant/<name>:<tag>@<digest>` for all six with no login (`DOCKER_CONFIG=$(mktemp -d)`). Stop and ask Brandon to flip any package that still reports unauthorized.
- [ ] **Step 5: Commit** `feat(images): core-path Docker Hub images come from our ghcr mirror`.

### Task 8: Per-mode cold-deploy budgets, enforced in e2e

Status (refresh): **reshape**, unblocked (all three sibling plans landed). The cold definition, the TLS accounting (D1) and the lock invariant change.

**Files:**
- Modify: `src/lib/deploy/orchestrator.js`: emit `[perf] deploy.total <ms>` from deploy start to the success outro, and `[perf] deploy.storage.finish <ms>` around `appBucketFinalize.finish` (`:2491`).
- Create: `tests/e2e/checks/deploy-budget.ts` (beside `tests/e2e/checks/tls-reuse.ts`). It reads the scenario's deploy CLI log through the existing `[perf]` parser (`tests/e2e/metrics/collector.ts`). It fails when:
  - `deploy.total − deploy.tls.ready − deploy.tls.snapshot` exceeds the mode's **deploy-owned** budget (D1 recommendation), or `deploy.total` exceeds the mode's **end-to-end** budget;
  - a cold compose or k8s `deploy.image.delta bytes` exceeds 10 MB;
  - on HA cold deploys: the `[state] up` lines show any `backpressure`, or a lock wait over 15 s (select and refresh still serialize, so `lock-waits 0` is impossible; 15 s bounds a select plus refresh), or `iac.upStack.fan > 1.25 × max(primary, standby)`;
  - on k8s-ha: `deploy.k3s.standby.awaitDb ≥ 60 s`, or `deploy.ha.replication.transportEarly` ends `(failed)`.
  It prints the top three serial markers, so the failure names its cause.
- Modify: the compose, compose-ha, k8s and k8s-ha initial `deploy` step in `tests/e2e/scenarios/_run-lifecycle.ts`, to run the check when the step is cold by the e2e db's own definition (`classifyColdWarm` in `tests/e2e/metrics/db.ts:700`: no passing deploy for the project and env prefix in 24 h; every scenario's first deploy, since project names are unique per run).
- Test: `tests/unit/e2e/deploy-budget.test.ts` with fixture logs, covering each mode's pass, fail on time (each budget), fail on bytes, and the HA invariants.

**Budgets (hard, no uplink exemption; D1 decides whether the end-to-end column is enforced):**

| Mode | Deploy-owned | End-to-end (first-ever deploy, TLS issued) | What it assumes |
|---|---|---|---|
| compose | **180 s** | **300 s** | upStack about 70, SSH and cloud-init 5, base pull plus 4-5 MB delta 10-45 overlapped with logins/bundle/DNS, stack up about 15 with pulls overlapped, restore-tls ~0 on a first deploy (Task 4A), admin, audits and health about 17, backup cron 5, preamble about 15; TLS residual 85-110 |
| compose-ha | **300 s** | **360 s** | infra fan ≈ max(primary, standby) ≈ 100 s past the window (Task 6); cold remote build 60-90 s; pulls and up about 35; replication 30; health and audits about 20 |
| k8s | **300 s** | **390 s** | upStack about 96, k3s ready 17, cert-manager 36, base apply 30, delta 10-45 overlapped with the CA and observability applies, traefik 11, app rollout 10, health 21 |
| k8s-ha | **420 s** | **480 s** | primary arm about 260 after Task 5; standby arm about 230 with no lock wait (Task 6) and no seed wait; reseed about 30 and replication verify serial; the standby image copy overlaps `configure-replication` |

Rationale for the hard limit:
- After Tasks 3-5, uplink cost is bounded by the delta's byte count, which is also asserted. A slow uplink can then move a deploy by tens of seconds, not minutes, so an exemption would only hide regressions.
- e2e pins a warm shared state bucket, so the HA lock runs in its past-the-window mode in every scenario. Task 9 runs the young-bucket mode once on purpose.

- [ ] **Step 1: Write failing fixture tests** for every mode: pass, fail on each time budget, and fail on bytes; plus the HA invariants:
  ```ts
  it('fails a compose-ha cold deploy whose standby waited on the lock', () => {
    const r = checkDeployBudget(fixture('e2-locked.log'), 'compose-ha');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/lock wait 93s > 15s/);
  });
  ```
  The fail-on-time message must contain the top three markers.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/e2e/deploy-budget.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the markers, the check and the wiring.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `test(e2e): enforce per-mode cold-deploy budgets and the cold image-bytes ceiling`.

### Task 9: Real-infra verification (needs Brandon's OK for spend)

Status (refresh): **still needed**; one compose-ha young-bucket run added (Review Focus 7).

- [ ] **Step 1: Ask Brandon for spend approval.** Then run `pnpm test:e2e:batch -- --provider hetzner` from a dedicated worktree (see the `running-e2e-matrix` skill), then `--scenario digitalocean/compose` and `--scenario digitalocean/k8s` to show there's no provider-specific regression, then one `--scenario hetzner/compose-ha` with `VC_E2E_STATE_BUCKET` set to a throwaway name, to exercise the young-bucket lock on the customer's first-deploy path.
- [ ] **Step 2: Record per-mode `deploy.total`,** the deploy-owned figure, the delta bytes, `deploy.tls.restore`, `deploy.tls.ready`, `deploy.storage.finish`, `deploy.ha.image.copyToStandby` and the top serial markers in the ledger, then compare with the Context tables. Expected: every cold deploy within budget and every cold delta ≤ 10 MB; on the young-bucket run, no `backpressure` and an `upStack.fan` near the sum (the lock held).
- [ ] **Step 3: Any budget miss gets RCA** under the same no-ladder rule before any budget number moves. A budget only moves with a ledger ruling that cites the log.

## Decisions needed (Brandon)

- **D1, what the budgets count.** The TLS first look still blocks a first-ever deploy for up to 180 s (~85-110 s residual on Hetzner and DigitalOcean, whose DNS-01 floor is 90 s). Recommendation: enforce both columns of Task 8, and call "sub-3" the deploy-owned number. Sub-3 end to end is reachable only when a certificate is reused, or after the compose "start issuance earlier" candidate.
- **D2, Ruling A′.** Scope the state lock by the provider's settle window (Hetzner's first-20-minute deploys keep today's serialized `up`; every other provider and every later Hetzner deploy runs the pair in parallel). The alternative is the original Ruling A (always scoped), which the 2026-08-15 log shows can fail an HA pair on a young bucket.
- **D3, k3s system images.** coredns, local-path-provisioner, metrics-server and k3s's pause image come from docker.io anonymously on every k8s node. Options: extend Task 7 with a `registries.yaml` docker.io mirror with rewrites onto ghcr (a cloud-init config file, not a pull), or leave it out and record the exposure.
- **D4, Task 4A is new scope.** It edits #239's `restoreComposeTls` (order only, results unchanged). Recommendation: take it here, since it is on this plan's critical path and the TLS plan has landed.
