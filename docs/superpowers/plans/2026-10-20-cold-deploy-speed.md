# Cold Deploy Speed (all four modes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cold deploys get much faster in every mode. Compose finishes in under 180 s, and each other mode gets an honest, enforced budget. The main change is that the operator uplink stops carrying bytes a datacenter can fetch itself.

**Architecture:**
- **A published runtime base image.** The app runs on our own image: Alpine, libstdc++, the node binary, and the `hono` user. Its layers are byte-stable, so servers pull them from GHCR at datacenter speed.
- **A diffID-keyed layer delta.** The operator sends only the layers the target lacks. The target rebuilds a complete archive from layers it already holds and loads it.
- **One delivery path.** Compose and k8s both use the delta. k8s delivers once, to the master's registry, and every node pulls from there. The double upload goes, and so does the per-node sideload.
- **Non-blocking tails.** TLS issuance and bucket settling no longer block success (owned by sibling plans), so budgets measure the deploy's own critical path.

**Tech Stack:** Node ESM CLI, Docker Engine 29 (`docker save`/`docker load`), k3s `ctr`, registry:2 (in-cluster, k8s only), GitHub Actions (GHCR publish), vitest (unit, integration/docker, e2e).

**Spec:** Brandon, 2026-10-20 in-session: "I just want to make sure our compose cold deploys are sub 5 minutes. I was actually hoping for sub 3 with our new lightweight stack updates." Then, via the coordinator: "All our deployment modes need to be blazing fast." There is no separate spec doc; this plan's Context is the evidence base, and rulings made without a spec are provisional.

## Context

### Critical path per mode (Hetzner, main 350af90, 2026-10-20 cold deploys, `[perf]` markers)

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
- **`applyManifests` contains `registryPush.app` 523 s**: a second operator upload of the same image to the master registry for autoscaler-spawned workers. It is awaited at `src/lib/deploy/k8s/k3s.js:4105`.
- Also `certManager.install` 36, `applyBase` 30, `applyObservability` 11, `traefik.restart` 11, `rolloutApp` 10, `health.probe` 21.
- **The image crosses the uplink twice, serially.**

**k8s-ha (e4, `e4-2026-10-20T13-33-52-910Z.log`), 853 s:**
- The primary arm takes 770 s (`primary.sideload.app` 612) and the standby arm 698 s (`standby.sideload.app` 501), in parallel. Then replication takes about 80 s.
- The standby arm is owned by `docs/superpowers/plans/2026-10-20-k8s-ha-registry-copy.md`, which removes the standby sideload and push. This plan does not duplicate it. It removes the **primary** cluster's sideload through the shared k8s delivery in Task 5.

**Candidates recorded, outside the cold-deploy budgets:**
- **k8s-ha standby `awaitDb` takes 345-360 s** on every cold deploy (1.2 s on a redeploy with data): the `seed-standby` init container waits out its 360 s deadline and never seeds; the serial reseed does the work in ~30 s. Masked today by the standby's registry push; Task 6 deletes the seed path (root-caused 2026-10-20).
- **compose-ha standby `upStack` is ~100 s late** on every cold run since 2026-09-01: the state lock (`de0f522`) serializes the HA pair's Pulumi `up`. Task 6 scopes the lock (root-caused 2026-10-20).
- **k8s-ha scale runs primary and standby converge serially** (6.1-6.8 min, perf-analysis.md). That belongs to a separate scale plan.

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
- **This plan pre-pulls only after `dockerhub-login`, from the CLI, without blocking. Nothing goes in cloud-init.**

**The compose layer-diff push exists but cannot help a cold deploy:**
- `676e113` / PR #201 (2026-07-29) added warm compose redeploys that "ship only changed layers (registry push, sideload fallback)".
- `56e68df` records that on a cold deploy it is "identical work either way (an empty registry has no layers to diff against)". That is tonight's 556 s.
- It also carries a settle ladder `COMPOSE_PUSH_SETTLE_DELAYS_MS` [1 s, 5 s, 15 s] and an unbounded registry volume (`src/lib/deploy/compose/registry-config.js`).

**Tunnel push into in-cluster registries had a long flake class:**
- `91a66a3` (2026-08-11): concurrent pushes stall the uplink, and the registry drops the upload session.
- `a895caa` (2026-08-15): a cross-process uplink lock was needed. It records "mitigation-audit cluster 2 (uplink/image transfer, 16 commits 2026-03 -> 2026-08)".
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

## Global Constraints
- **No retry ladders.** A failed delta transfer, reconstruct or load fails the deploy with one line, `image delivery failed: <cause>`. There is no fallback to a full sideload.
- A delta that has to send every layer is not a fallback. That is the algorithm itself, for example with a custom Dockerfile or an empty target.
- **No provider-specific slowdowns.** Every change is provider-neutral. GHCR pulls work from every provider. No new firewall rules.
- No cloud-init pre-pulls (`7babb8e`, `e9192f9`). Server-side pulls start only after `dockerhub-login` (Docker Hub images) or need no auth (public GHCR).
- **Core-path images never come from Docker Hub** (Task 7): traefik, docker-socket-proxy, alpine, registry, socat and alpine/k8s are pulled from `ghcr.io/hyperformant` mirrors, copied as amd64 manifests by `publish-images.yml`, and enforced by `core-images-from-mirror-census.test.ts`. Optional add-ons keep their upstream registries.
- **Images are pinned by digest everywhere.** The runtime base joins the `image-digest-census` and dependabot like every other pin.
- **The runtime image stays minimal:** Alpine, libstdc++ and the node binary only. No npm, yarn or corepack in the running image.
- **No customers, no compatibility shims.** The compose per-server registry is deleted outright (container, volume, `registryEnsureShell`, settle ladder). Ship with a Compatibility note and no `!:` footer.
- **Pre-existing servers:** a leftover `vibecarbon-registry` container is removed by reconcile one time. Its volume is removed in the same step.
- Template uses npm; root uses pnpm. Conventional commits, pathspec commits, never `--no-verify`. dotenv writes only through `formatDotenvLine`.
- **This plan depends on three sibling plans:**
  - `docs/superpowers/plans/2026-10-20-tls-cert-reuse.md` (TLS pending, so `tls.ready` stops blocking success);
  - `docs/superpowers/plans/2026-10-20-project-app-bucket.md` (non-blocking settle, option 1);
  - `docs/superpowers/plans/2026-10-20-k8s-ha-registry-copy.md` (k8s-ha standby).
- Tasks 1-7 can land before those. **Task 8 (the budgets) lands only after all three.**
- **Task 6 must land before, or in the same release as, the registry-copy plan:** removing the standby's registry push unmasks the 346 s seed wait Task 6 deletes. Task 6 also lands before `docs/superpowers/plans/2026-10-20-ha-correctness.md`'s replication changes; that plan rebases onto Task 6's deferreds.
- **The state lock is scoped, not removed** (Task 6, Ruling A): select, refresh and state repair stay serialized per backend; `stack.up()` runs outside it.

## Review Focus
1. **A user's custom Dockerfile with no runtime base** (or any FROM): the delta sends every layer the target lacks, and the deploy still succeeds. Tested in Task 3.
2. **A warm redeploy whose only change is `dist`:** the delta sends one layer, and the bytes marker shows it. Tested in Task 3 (unit) and Task 4 (docker integration).
3. **The reconstruct dies halfway** (disk full, killed SSH): no partial image is tagged and the temp dir is removed. The next deploy starts clean. Tested in Task 3 (the script's trap, under real bash).
4. **An autoscaler-spawned k8s worker** joining after delivery still pulls the app image. Delivery has to put it in the master registry before any workload references it. Tested in Task 5.
5. **An ARM Mac operator:** the local build still targets linux/amd64 (`src/lib/deploy/platform.js`), and the runtime base is published for amd64 and arm64 (release gate). Tested in Task 2 (workflow-platforms census).
6. **A freshly mirrored GHCR package that is still private:** every anonymous server pull fails with `unauthorized`, while CI's authenticated verify step passes. Task 7 Step 4 checks with an empty Docker config before merge.
7. **A real state-backend throttle after the lock scope change:** two HA engines' `up` overlap and the backend answers 503/SlowDown. The existing `withStateBackendRetry` classifier absorbs it and the `[state]` line reports `backpressure`, which Task 8's e2e invariant turns into a failure instead of a silent slowdown. Tested in Task 6 (state-lock-scope test drives a fake 503 during overlapping `up`).

---

### Task 1: Spike: prove the layer delta round trip on every target store

**Files:**
- Create: `tests/integration/docker/layer-delta-roundtrip.test.ts` (gated `DOCKER_INTEGRATION=true`, like `tests/integration/docker/docker-services.test.ts`).
- Create: `tests/integration/docker/fixtures/layer-delta/Dockerfile` (FROM a pinned small base plus one `COPY` layer).

**Interfaces:**
- Produces: a recorded go/no-go in the ledger, plus the exact archive facts Task 3 codes against:
  - the `manifest.json` `Layers[i]` ↔ config `rootfs.diff_ids[i]` pairing;
  - whether `docker load` accepts a legacy `manifest.json` whose `Layers` paths point at gzip or uncompressed files under other names;
  - whether `k3s ctr images import` accepts the same archive.

- [ ] **Step 1: Write the test** with three targets:
  - (a) a `docker:29-dind` container with the classic store;
  - (b) `docker:29-dind` with `{"features":{"containerd-snapshotter":true}}`;
  - (c) `rancher/k3s` pinned to the version `src/lib/deploy/k8s/k3s.js` installs, using `ctr images import`.

  For each target:
  - the target pre-pulls the fixture's base;
  - the host builds the fixture and runs `docker save`, then drops every layer blob whose diffID the target reports;
  - the target fills the gaps from its own `docker save <base>` (or `ctr export`), rewrites `manifest.json` `Layers`, and loads.

  Assertions:
  - the loaded image's `RootFS.Layers` equals the host image's;
  - its config digest (image ID) equals the host's;
  - `docker run --rm <img> cat /marker` prints the fixture's marker;
  - the delta archive is smaller than 1/10 of the full save.
- [ ] **Step 2: Run** `DOCKER_INTEGRATION=true pnpm vitest run tests/integration/docker/layer-delta-roundtrip.test.ts`. Expected: all three targets PASS.
  - If (c) fails, record it and rule: Task 5 loads on the master through `docker`-free `ctr import` of a full archive that the master reconstructs with the same script. Re-run.
  - **If (a) or (b) fails, stop the plan.** The delta is the foundation.
- [ ] **Step 3: Commit** `test(deploy): prove the diffID layer delta loads on classic, containerd and k3s targets`.

### Task 2: Publish the runtime base image and run the app on it

**Files:**
- Create: `docker/node-runtime/Dockerfile`: `FROM alpine:3.24@sha256:294b683c…` (the digest `carbon/Dockerfile:93` pins now). It adds `apk add --no-cache libstdc++`, the `hono` group and user (1001), and `COPY --from=node` of the `NODE_IMAGE` stage's `/usr/local/bin/node`. LABELs follow `docker/postgres-walg/Dockerfile`.
- Create: `.github/workflows/publish-node-runtime-image.yml`, modeled on `publish-db-image.yml`:
  - amd64 and arm64;
  - tag `ghcr.io/hyperformant/node-runtime:<NODE_VERSION>-alpine3.24`;
  - auto-runs on changes under `docker/node-runtime/**`.
- Modify: `carbon/Dockerfile`:
  - the runner becomes `FROM ${RUNTIME_IMAGE}`, with the global ARG `RUNTIME_IMAGE=ghcr.io/hyperformant/node-runtime:<ver>@sha256:<digest>`;
  - delete the runner's `apk add`, `adduser` and node `COPY`;
  - keep `COPY --from=deps node_modules`, `dist`, `db/migrations`, entrypoint, `USER hono`.
  - The alpine-minor comment moves to the runtime Dockerfile.
- Modify: `src/lib/images.js`: export `NODE_RUNTIME_IMAGE` (full digest ref), the single CLI pin.
- Modify: the `pnpm node:sync` script (find it via `package.json` `node:sync`) so it writes both Node pins.
- Modify: `.github/workflows/release.yml:46-57`: the "public and multi-arch" verification also covers `NODE_RUNTIME_IMAGE`.
- Modify: `.github/dependabot.yml` and `.github/image-pins/Dockerfile`: add the pin.
- Test: update `tests/unit/lib/node-version-pins.test.ts`, `tests/unit/deploy/image-digest-census.test.ts`, the OCI metadata test, the workflow-platforms test, and `tests/unit/lib/images.test.ts`.

**Interfaces:**
- Produces: `NODE_RUNTIME_IMAGE: string` from `src/lib/images.js`, equal byte-for-byte to the `RUNTIME_IMAGE` ARG default in `carbon/Dockerfile`, enforced by the census.

- [ ] **Step 1: Write failing census assertions:**
  - `carbon/Dockerfile`'s `ARG RUNTIME_IMAGE=` equals `NODE_RUNTIME_IMAGE`;
  - the runner stage has no `apk`, `adduser` or `/usr/local/bin/node` `COPY`;
  - the runtime Dockerfile's alpine digest equals the `NODE_IMAGE` alpine minor;
  - the publish workflow builds `linux/amd64,linux/arm64`;
  - release.yml verifies the runtime ref.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/lib/node-version-pins.test.ts tests/unit/deploy/image-digest-census.test.ts tests/unit/lib/images.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the files above.** Publish the first tag with `gh workflow run publish-node-runtime-image.yml`, then pin the resulting index digest.
- [ ] **Step 4: Verify:**
  - the step 2 tests PASS;
  - `cd carbon && docker build -t rt-check . && docker run --rm rt-check node -e 'console.log(process.version)'` prints the `.nvmrc` version;
  - `docker history rt-check` shows a private top of ≤ 15 MB above the runtime base;
  - `docker run --rm rt-check sh -c 'command -v npm'` exits non-zero;
  - carbon `npm run test:prepush` passes.
- [ ] **Step 5: Commit** `feat(image): run the app on a published node runtime base so servers pull it at datacenter speed`.

### Task 3: The layer delta module

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
  - `deliverImage({ tag, sshTarget, sshKey, runtime: 'docker' | 'k3s', registryRef?: string }) -> Promise<{ bytes: number, layersSent: number, layersReused: number }>`.
    - It saves, extracts to a temp dir, calls `listTargetDiffIds` and `buildDelta`, then runs `tar -c <sendPaths> | gzip -1 | ssh <opts> 'sh -s' < layer-delta-remote.sh`.
    - It counts the bytes written to ssh stdin and emits `[perf] deploy.image.delta bytes=<n> sent=<k> reused=<m>`.
    - It throws `image delivery failed: <first stderr line>` on any non-zero exit.
    - SSH opts come from `SSH_CONNECTION_OPTS` and the per-env known_hosts, exactly as `sideloadCompose` builds them today (`src/lib/deploy/image.js:174-210`).
  - The remote script:
    - uses `mktemp -d` under `/var/lib/vibecarbon/delta`, with `trap 'rm -rf "$d"' EXIT`;
    - fills each missing `Layers[i]` from a local `docker save` (or `ctr export`) of an image that holds that diffID;
    - rewrites `manifest.json` `Layers[i]` to the filled path, then loads with `docker load` or `k3s ctr -n k8s.io images import`;
    - with `registryRef` set, tags and pushes into the in-cluster registry (`ctr images push --plain-http`);
    - verifies the loaded image's diffIDs equal the manifest's, and exits non-zero otherwise.

- [ ] **Step 1: Write the failing unit tests:**
  - `buildDelta` with `have` holding the base layers returns only the app layers plus the metadata files;
  - with an empty `have`, it returns every layer (Review Focus 1);
  - with every layer but `dist`, it returns exactly one layer blob (Review Focus 2);
  - `deliverImage` maps a stub exit 1 with stderr `no space left on device` to `image delivery failed: no space left on device`, and makes no second attempt;
  - the remote script, under bash with a stub `docker load` that exits 1, leaves no dir under the delta root and no tag (Review Focus 3).
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/layer-delta.test.ts tests/unit/deploy/layer-delta-remote.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** to the interfaces above.
- [ ] **Step 4: Run** the step 2 tests and `DOCKER_INTEGRATION=true pnpm vitest run tests/integration/docker/layer-delta-roundtrip.test.ts`, switched to call `deliverImage` against the dind targets. Expected: PASS.
- [ ] **Step 5: Commit** `feat(deploy): ship only the image layers the target lacks, keyed by diffID`.

### Task 4: compose delivers by delta, pulls overlap the transfer, and the per-server registry goes

**Files:**
- Modify: `src/lib/deploy/effects/index.js:163-245` (`transferImage`, local mode):
  - first `sshRunAsync(serverIp, key, 'docker pull ' + baseRef)`, where `baseRef` is the `RUNTIME_IMAGE` ARG default parsed from the project's own `Dockerfile` (none found means skip the pull);
  - then `deliverImage({ tag: localImageTag, sshTarget: 'root@' + serverIp, sshKey, runtime: 'docker' })`;
  - delete the registry branch and the `sideloadCompose` fallback.
- Modify: the same file's step after `dockerhubLogin`: start `pullComposeImages(...)` (`src/lib/deploy/compose/index.js:1069`, already excludes `app`) without awaiting. Store it as `ctx.stackPullPromise`, attach a no-op catch the way `transferImagePromise` does, and await it in `startComposeStack` beside the transfer barrier.
- Delete:
  - `src/lib/deploy/compose/registry.js` and `src/lib/deploy/compose/registry-config.js`;
  - `registryEnsureShell()` from `src/lib/deploy/bundle.js:14,122-124`, replaced with a one-time `docker rm -f vibecarbon-registry; docker volume rm <REGISTRY_VOLUME>` line (both `|| true`) in reconcile;
  - `sideloadCompose` from `src/lib/deploy/image.js`.
- Modify: `src/lib/deploy/registry-push.js`: drop the compose-only comments. It remains k8s-only until Task 5.
- Test:
  - delete `tests/unit/deploy/compose-registry.test.ts`, `compose-registry-transfer.test.ts` and `compose-registry-config.test.ts`, with the justification in the commit;
  - update `effect-concurrency.test.ts`;
  - new `tests/unit/deploy/image-delivery-census.test.ts` walks `src/` and fails on any `docker save`, `docker load`, `ctr images import` or `pushImageOverSshTunnel` outside `layer-delta.js`, `registry-push.js` (k8s, until Task 5) and `compose/index.js` `transferImageBetweenServers` (server-to-server, inside the datacenter).

**Interfaces:**
- Consumes: Task 3 `deliverImage`; Task 2 `RUNTIME_IMAGE` ARG convention.
- Produces: `ctx.stackPullPromise: Promise<void>`, awaited in `startComposeStack` before reconcile.

- [ ] **Step 1: Write the failing tests:**
  - the census, which currently fails on `image.js` sideload and the registry path;
  - an effect test: `transferImage` calls `docker pull <baseRef>` before `deliverImage`, and never calls `pushImageOverSshTunnel`;
  - a step-order test: `stackPullPromise` starts after `dockerhub-login` and is awaited before `reconcile.run`;
  - a structural test: no cloud-init file gains a `docker pull` (re-pins `7babb8e`).
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/image-delivery-census.test.ts tests/unit/deploy/effect-concurrency.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes above.
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm test:unit && DOCKER_INTEGRATION=true pnpm test:docker`. Expected: PASS.
- [ ] **Step 5: Commit** `perf(compose): cold deploys ship only the app layers and overlap stack pulls with the transfer`.

### Task 5: k8s delivers once, into the master registry, and nodes pull

**Files:**
- Modify: `src/lib/deploy/k8s/k3s.js`:
  - replace the `sideloadK3s` fan-out (`:4458`, app and backup images) and the backgrounded `pushImageToLocalRegistry` (`:3583-3601`, awaited `:4105`) with one `deliverImage({ tag, sshTarget: master, runtime: 'k3s', registryRef: tag })` per image;
  - before it, run `k3s ctr -n k8s.io images pull <baseRef>` on the master;
  - it must complete after `localRegistry.wait` and before `applyBase` references the image;
  - delete `sideloadK3s`, plus `pushImageToLocalRegistry` if nothing else calls it after the k8s-ha registry-copy plan lands (coordinate: that plan owns the standby path).
- Modify: the app and backup workload `imagePullPolicy`, so static nodes pull the `<masterPrivateIp>:5000/...` tag through the existing `registries.yaml`. Confirm the policy in `carbon/k8s/base`.
- Modify: `src/lib/deploy/registry-push.js`: delete it if the census shows no callers. Otherwise keep it scoped to the registry-copy plan's needs.
- Test:
  - update `tests/unit/deploy/k3s-prepull-images.test.ts` and the sideload tests;
  - new `tests/unit/deploy/k8s-image-delivery-order.test.ts`: delivery is awaited after the registry-ready wait and before `applyBase`, and runs once per image, never once per node (Review Focus 4);
  - extend the Task 4 census to forbid `sideloadK3s`.

**Interfaces:**
- Consumes: Task 3 `deliverImage` (`runtime: 'k3s'`, `registryRef`).
- Produces: the in-cluster registry holds the app and backup tags before any manifest references them. The k8s-ha registry-copy plan copies from there.

- [ ] **Step 1: Write the failing tests** above.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/k8s-image-delivery-order.test.ts tests/unit/deploy/image-delivery-census.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep the `[perf] deploy.${perfPrefix}.image.deliver` marker name, so the e2e collector can attribute it.
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration`. Expected: PASS.
- [ ] **Step 5: Commit** `perf(k8s): deliver the app once to the master registry; nodes pull in-cluster instead of a sideload per node`.

### Task 6: compose-ha and k8s-ha serial waits: lock scope, dead seed path, event-triggered transport

Both waits are root-caused (2026-10-20 RCAs, evidence quoted below; full reports were written to the session scratchpad `arch-review/rca-composeha-upstack.md` and `arch-review/rca-k8sha-awaitdb.md` and are summarized here so this plan stands alone).

**Cause A, compose-ha standby `upStack` ~100 s late: our state lock.**
- `withStateLock` (`src/lib/iac/state-lock.js`) wraps the whole of `upStack` (`src/lib/iac/index.js` ~1086), provisioning included. compose-ha fans the primary and standby `upStack` out under `Promise.all` (`src/lib/deploy/effects/compose-ha.js` ~176-201) against one state bucket, so they run one after the other. The k8s-ha infra fan-out shares the same lock and the same serialization.
- Evidence: `e2-2026-10-20T09-17…log` prints `state lock acquired after 93s`; primary 92.9 s, standby 188.8 s, standby's own work 95.8 s. Every e2 log since 2026-09-01 shows a lock wait equal to the primary's up; none before 2026-08-12 shows any wait, and back then standby ≈ primary. The standby's own up is 91-103 s in hel1 against 90-97 s for the primary in nbg1, so there is no location effect.
- Origin: `de0f522` (2026-08-15, archived private repo, shipped via `32afb12`), "one Pulumi engine at a time per state bucket", a deliberate trade against throttle events in CI run 31898658781 (38 of 40 recovery events classified as throttle: 24 `stack-select`, 11 `up`). Since then every run logs `backpressure none` with `ops up=2 stack-select=1`, orders of magnitude under Hetzner's documented 750 rps per bucket.

**Ruling A: scope the lock to the select/refresh/state-repair phases and release it before `stack.up()`; do not merge the HA pair into one stack.**
- Why not one stack for the pair (the RCA's first option): about 18 files key on the `-primary`/`-standby` stack names (role swap, reconverge, failover, destroy, status, diagnose), and the HA-correctness plan (`docs/superpowers/plans/2026-10-20-ha-correctness.md`) is rewriting role tracking in exactly those files. Renaming stacks under it doubles the blast radius for the same ~90 s.
- Why scoping is enough: the measured throttle mass was `stack-select` (24 of 35 events), which stays serialized. The 11 `up` events are consistent with the young-state-bucket window. The bucket plan (`2026-10-20-project-app-bucket.md`) makes the state bucket stable across redeploys and only rotates its name on the last environment's `-purge`, so steady-state deploys never meet a young state bucket.
- Gate before the change (Step 1): pull the run 31898658781 telemetry (`gh run view 31898658781 --log`) and check the 11 `up` throttle timestamps against the state bucket's creation time. If any landed outside the young-bucket window, this ruling flips to the one-stack design, recorded as a new ruling, and Task 6 stops for a plan amendment.
- Cost if wrong: two engines' `up` checkpoint traffic overlaps; any real throttle is still caught by the existing `withStateBackendRetry` classifier and shows as `backpressure` in the `[state]` line, which the e2e invariant below turns into a failure.

**Cause B, k8s-ha standby `awaitDb` 345-360 s: a seed path that never succeeds on a cold deploy.**
- The `seed-standby` init container (built by `buildStandbySeedInitScript`, `deadlineSeconds: 360`, applied via the `vibecarbon-seed-standby` ConfigMap in `k3s.js`) waits its full budget, exits unseeded and runs initdb. 8 cold runs on 2026-10-20 took 345-359 s; the one redeploy with existing data took 1.2 s (the "already initialized" branch); the primary's awaitDb is about 1 s.
- Nothing it needs exists in its window (about T+820 to T+1180 s in `e4-2026-10-20T00-57-18-475Z.log`):
  - **no transport:** early prep (`prepareReplicationTransport`) polls for the standby namespace with a fixed 180 s budget (`waitForNamespace`, 36 × 5 s, `src/lib/deploy/k8s/ha/index.js` ~255) counted from infra-ready; on a cold deploy the namespace appears after the 8-9 min sideload, so prep gives up first (`transportEarly ~197s (failed)` in every cold run since 2026-08-28);
  - **no primary replication config:** `configurePrimaryForReplication` awaits the whole primary deploy (`await primaryPromise`, including its 546 s registry push), finishing at about T+1268, though it only needs the primary db Ready (about T+640).
- What actually seeds the standby is the serial `setupReplication` reseed, every time (`reseed: staged=yes swapped=yes`, about 30 s). The 346 s is masked today by the standby's ~1047 s registry push; it becomes the k8s-ha critical path the moment `2026-10-20-k8s-ha-registry-copy.md` removes that push. **So this task must land before, or in the same release as, the registry-copy plan.**

**Ruling B: delete the first-boot seed path; the reseed is the single owner of standby seeding.** Making the seed work would need a cross-cluster happens-before (standby db apply after primary db Ready and after the tunnel) inside the parallel fan-out, which is the coupling the fan-out exists to avoid, and would only replace a 30 s reseed. Cost if wrong: none observable; the reseed already does the work.

**Ruling C: replace poll-and-give-up with signalled preconditions** (not retries):
- each cluster's deploy resolves a `namespaceReady` deferred right after `applyK3sManifests` creates the namespace (applyBase), the same pattern as the existing `onInfraReady` deferreds in `src/lib/deploy/effects/k8s-ha.js`; `prepareReplicationTransport` starts when both have resolved; `waitForNamespace` and its 180 s budget are deleted;
- `configurePrimaryForReplication` starts on a `primaryDbReady` deferred, resolved after the primary's `awaitPostgresAccepting`, not on `primaryPromise`.

**Coordination with `2026-10-20-ha-correctness.md`:** that plan changes failover/reseed role detection inside `replication.js` (`configureStandbyReplication`, the promote guards). This task touches only the **deploy-time** callers' timing (`effects/k8s-ha.js` ordering, `k8s/ha/index.js` transport start, the seed init) and must not change the bodies of `configureStandbyReplication`, `promoteStandby` or the reseed functions. If both plans are in flight, land this task first; the HA-correctness plan rebases onto the deferreds.

**Files:**
- Modify: `src/lib/iac/state-lock.js` and `src/lib/iac/index.js` (`upStack`): lock held for select, refresh and state repair; released before `stack.up()`; the lock header's "compose-ha provisioning roughly doubles" note replaced with the new scope and its evidence.
- Modify: `carbon/k8s/base/db/statefulset.yaml` (delete the `seed-standby` init container), `src/lib/deploy/k8s/k3s.js` (delete the `vibecarbon-seed-standby` ConfigMap apply, `buildStandbySeedInitScript`, and the `REPL_RELAY_HOST/PORT` render tokens if nothing else reads them — grep first).
- Modify: `src/lib/deploy/effects/k8s-ha.js` (the `namespaceReady` and `primaryDbReady` deferreds), `src/lib/deploy/k8s/ha/index.js` (delete `waitForNamespace`; start transport on both `namespaceReady`), the primary-config call site.
- Test: `tests/unit/iac/state-lock-scope.test.ts` (new), `tests/unit/deploy/ha-upstack-fan-census.test.ts` (new), `tests/unit/deploy/db-init-no-peer-census.test.ts` (new), `tests/unit/deploy/k8s-ha-signalled-preconditions.test.ts` (new); trim the seed pins in `db-sts-boot-timeout-census.test.ts` and `reseed-standby.test.ts` (justify in the commit).

**Interfaces:**
- Produces: `withStateLock(backendKey, phase, fn)` where `phase` is `'select' | 'refresh' | 'repair'`; `upStack` calls it for those phases only. `effects/k8s-ha.js` exposes `namespaceReady: { primary: Promise<void>, standby: Promise<void> }` and `primaryDbReady: Promise<void>` to the HA orchestration.
- Consumes: nothing from earlier tasks in this plan; independent of Tasks 1-5.

- [ ] **Step 1: The Ruling A gate.** Run `gh run view 31898658781 --log | grep -i throttle` (or the telemetry artifact) and record, in the ledger, each of the 11 `up` events' timestamp against the state bucket's creation time. Expected: all inside the young-bucket window. If not, stop: record the flip to the one-stack design and ask for a plan amendment.
- [ ] **Step 2: Write the failing tests.**
  - `state-lock-scope.test.ts`: with a fake Pulumi stack whose `up()` resolves only when released by the test, two concurrent `upStack` calls on one backend reach `up()` together (peak concurrent `up` = 2) while peak concurrent `select` stays 1.
  - `ha-upstack-fan-census.test.ts` (a walk over `src/lib/deploy/effects/*.js` and `src/lib/iac/`): any `Promise.all`/fan containing two or more `upStack(` calls against one backend requires that `upStack` releases the lock before `up` — asserted by importing the real `upStack` with a fake engine and measuring overlap, not by a source regex.
  - `db-init-no-peer-census.test.ts`: no init container in `carbon/k8s/base/db/statefulset.yaml` references `SEED_PRIMARY_`, `REPL_RELAY_` or `pg_basebackup`; no manifest under `carbon/k8s/base` references the `vibecarbon-seed-standby` ConfigMap.
  - `k8s-ha-signalled-preconditions.test.ts`: with a fake where `primaryPromise` never resolves, `configurePrimaryForReplication` still runs once `primaryDbReady` resolves; `prepareReplicationTransport` is called exactly once, after both `namespaceReady` resolve, and never before; `waitForNamespace` is not exported.
- [ ] **Step 3: Run** `pnpm vitest run tests/unit/iac/state-lock-scope.test.ts tests/unit/deploy/ha-upstack-fan-census.test.ts tests/unit/deploy/db-init-no-peer-census.test.ts tests/unit/deploy/k8s-ha-signalled-preconditions.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** the Files list.
- [ ] **Step 5: Run** `pnpm test:unit`. Expected: PASS. Prove each census arm bites (temporarily re-add the seed init container; temporarily hold the lock through `up`) and record it in the report.
- [ ] **Step 6: Commit**, one commit per cause:
  - `perf(iac): hold the state lock for select and refresh only, so an HA pair provisions in parallel`;
  - `perf(k8s-ha): drop the standby first-boot seed that never succeeded, and start transport and primary config when their preconditions are signalled`.
- **No retry ladders and no deadline changes:** conditions are fixed, not timers.

### Task 7: Core-path Docker Hub images come from our GHCR mirror

Brandon approved this on 2026-10-20. Docker Hub rate-limits anonymous pulls per IP, and cloud servers often inherit IPs that have already hit the limit. A cloud-init pre-pull was reverted over exactly this (`7babb8e`). After this task, a cold deploy's core path pulls nothing from Docker Hub.

**Scope** (core path only; every ref is already digest-pinned today):

| Upstream (docker.io) | Where it runs |
|---|---|
| `traefik:v3.6.11` | compose (`carbon/docker-compose.yml:9`), k8s (`carbon/k8s/base/traefik/deployment.yaml:28`) |
| `tecnativa/docker-socket-proxy:v0.4.2` | compose prod (`carbon/docker-compose.prod.yml:81`) |
| `alpine:3.24.2` | the DO CSI init-container pin (`src/lib/images.js:452`, `CSI_UPSTREAM_IMAGE_PINS`) |
| `registry:2.8.3` | k8s in-cluster registry (`carbon/k8s/base/registry/local-registry.yaml:35,45`). The compose per-server registry (`src/lib/deploy/compose/registry-config.js:31`) is deleted by Task 4, so it is out of scope. |
| `alpine/socat:1.8.1.3` | k8s-ha `repl-gateway.yaml:61`, compose-ha `src/lib/deploy/compose/ha.js:213`, and the registry-copy plan's `registry-relay.yaml` |
| `alpine/k8s:1.31.12` | the k8s backup CronJob (`carbon/k8s/base/backup/cronjob.yaml:48`). It is not on the deploy path, but every k8s cluster pulls it daily, so it gets the same rate-limit exposure. |

Out of scope: n8n, Metabase, Redis, observability (Grafana, Prometheus, Loki, Promtail, postgres-exporter), garage, the n8n `alpine` helper, and the diagnose-only `DIAG_*` images. They are optional or not part of a deploy.

**Files:**
- Modify: `src/lib/images.js`. Generalize the registry.k8s.io mirror set and do not duplicate it:
  - Add `DOCKERHUB_UPSTREAM_REGISTRY = 'docker.io'` and `DOCKERHUB_MIRRORS`, a list of `MirroredImage` entries `{ repo, tag, digest }`, where `repo` is the Docker Hub path (`library/traefik`, `tecnativa/docker-socket-proxy`, `library/alpine`, `library/registry`, `alpine/socat`, `alpine/k8s`).
  - Give each `MirroredImage` an `upstream` registry field, defaulting to `K8S_UPSTREAM_REGISTRY` for existing entries. Rename `MIRRORED_K8S_IMAGES` to `MIRRORED_IMAGES` (the union, still `dedupeImages`), `k8sUpstreamRef` to `upstreamRef`, and `mirroredK8sPackageNames` to `mirroredPackageNames`, and update every importer.
  - Package names stay flat basenames (`traefik`, `docker-socket-proxy`, `alpine`, `registry`, `socat`, `k8s`). `mirroredImageName` must refuse a basename collision between two different repos. `alpine/k8s` → `k8s` and `library/alpine` → `alpine` do not collide today; the guard keeps it that way.
  - Add `mirrorRef(repoTag)` helpers per image, e.g. `traefikImageRef()`, returning `ghcr.io/hyperformant/<name>:<tag>@<digest>`.
- Modify: `scripts/mirror-matrix.mjs`: emit from `MIRRORED_IMAGES`. `src` is `upstreamRef(image)`, so the copy reads `docker.io/library/traefik:v3.6.11`.
- Modify: `.github/workflows/publish-images.yml` `mirror-upstream-images`: no logic change. The same amd64-only `imagetools create` copy and verify steps serve both registries. Add a `docker/login-action` step for Docker Hub using the existing Docker Hub CI credential (the one `dockerhub-login` uses; read its name from the repo), so the mirror job itself is not rate-limited. Update the header comments that say "registry.k8s.io".
- Modify every core-path ref in the scope table to the ghcr mirror, pinned by digest. The digest is unchanged, because an amd64 manifest copy is bit-identical.
  - `carbon/docker-compose.yml` and `carbon/docker-compose.prod.yml`: the literal `ghcr.io/hyperformant/traefik:v3.6.11@sha256:…` and `ghcr.io/hyperformant/docker-socket-proxy:v0.4.2@sha256:…`, since compose files cannot import JS.
  - The k8s base YAMLs: literal refs as well.
  - `ha.js`, `CSI_UPSTREAM_IMAGE_PINS` and the registry-copy plan's relay: through the `images.js` helpers.
- Modify: `.github/dependabot.yml`. Dependabot stops seeing these images once the refs point at our mirror, and they never had a dependabot path that could re-pin the mirror anyway. Bumps follow the existing registry.k8s.io mirrors' flow: edit `{tag, digest}` in `images.js` and the literal refs, merge, and `publish-images` mirrors the new tag. Add a comment block in `dependabot.yml` saying so.
  - Add a weekly `schedule:` job to `publish-images.yml`, `mirror-upstream-drift`. It lists newer upstream tags for each mirrored repo (registry `tags/list` with a semver filter) and writes them to the job summary. It only reports, never re-pins.
- Create: `tests/unit/deploy/core-images-from-mirror-census.test.ts` (a walk, not a hand list):
  - (a) Walk `carbon/docker-compose*.yml`, skipping add-on overlay files (`docker-compose.n8n*.yml`, `docker-compose.metabase*.yml`, `docker-compose.observability*.yml`, and `services/**`, read from the add-on registry the primary-only-addons plan introduces if it has landed, otherwise a named skip list with a comment), plus `carbon/k8s/base/**/*.yaml` excluding the add-on directories, `carbon/cloud-init/**`, and `src/**/*.js`.
  - (b) Every `image:` value, and every string literal matching `^[a-z0-9./-]+:[^@\s]+@sha256:`, must start with `ghcr.io/hyperformant/`, `{{`, `${`, or be in a short documented allowlist (the app image placeholders). A bare Docker Hub name (no registry host, or `docker.io/`) fails with `core-path image <ref> pulls from Docker Hub; mirror it in DOCKERHUB_MIRRORS`.
  - (c) Every `ghcr.io/hyperformant/<name>:<tag>@<digest>` literal found must match a `MIRRORED_IMAGES` entry on name, tag and digest, so no ref can point at a tag the workflow never mirrors.
  - Prove each arm bites: revert `traefik` in `docker-compose.yml` to the docker.io ref (b fails), and change one mirror ref's digest (c fails). Restore both.
- Modify: `tests/unit/deploy/k8s-image-mirrors.test.ts` and its importers for the renames. Add a case where `node scripts/mirror-matrix.mjs` includes `docker.io/library/traefik:v3.6.11` → `ghcr.io/hyperformant/traefik:v3.6.11`.

**Interfaces:**
- Consumes: nothing from Tasks 1-6. It can land any time before Task 8.
- Produces: `MIRRORED_IMAGES`, `DOCKERHUB_MIRRORS`, `upstreamRef`, `mirroredPackageNames`, and the per-image ref helpers (`traefikImageRef`, `socatImageRef`, `registryImageRef`, `alpineImageRef`, `dockerSocketProxyImageRef`, `alpineK8sImageRef`). The registry-copy plan's relay uses `socatImageRef()`.

**Rulings:**
- **amd64-only copy, as today.** Deploy is amd64-only (`assertAmd64ServerType`), and the existing mirror job copies only the linux/amd64 child manifest. Copying full indexes would bring in blobs for platforms nothing runs. When the price plan's ARM "Later" section lands, it switches the job to copy the amd64 and arm64 children for every `MIRRORED_IMAGES` entry, in one place. Cost if wrong: none until ARM is supported.
- **Release gate:** a newly mirrored package is created PRIVATE, and servers pull anonymously. The six new packages (`traefik`, `docker-socket-proxy`, `alpine`, `registry`, `socat`, `k8s`) must be flipped PUBLIC by hand in the org's package settings before this task's refs merge. The verify step authenticates, so it cannot catch a private package. Add the six names to `mirroredPackageNames()`, which is the operator checklist. The step is: run the mirror job on the branch, flip the packages public, then merge.
- **`dockerhub-login` stays for the add-ons.** After this task it only matters for n8n, Metabase, Redis and observability pulls.

- [ ] **Step 1: Write the census and the matrix case.** Run `pnpm vitest run tests/unit/deploy/core-images-from-mirror-census.test.ts tests/unit/deploy/k8s-image-mirrors.test.ts`. Expected: FAIL. Arm (b) names every docker.io ref in the scope table.
- [ ] **Step 2: Implement** the `images.js` generalization, the matrix, the workflow login and drift job, and the ref rewrites.
- [ ] **Step 3: Run** the same command plus `pnpm test:unit`. Expected: PASS, with both arm-bite proofs recorded in the report.
- [ ] **Step 4: Publish.** Run `gh workflow run publish-images.yml --ref <branch>`. Then confirm `docker buildx imagetools inspect ghcr.io/hyperformant/<name>:<tag>@<digest>` for all six with no login (`DOCKER_CONFIG=$(mktemp -d)`). Stop and ask Brandon to flip any package that still reports unauthorized.
- [ ] **Step 5: Commit** `feat(images): core-path Docker Hub images come from our ghcr mirror`.

### Task 8: Per-mode cold-deploy budgets, enforced in e2e

Lands only after the TLS-pending, bucket-settle and k8s-ha registry-copy plans.

**Files:**
- Modify: `src/lib/deploy/orchestrator.js`: emit `[perf] deploy.total <ms>` from deploy start to the success outro, excluding the TLS-pending and bucket-settle background tails.
- Create: `tests/e2e/checks/deploy-budget.ts`. It reads the scenario's deploy CLI log through the existing `[perf]` parser (`tests/e2e/metrics/collector.ts`). It fails when `deploy.total` exceeds the mode budget, or when a cold compose or k8s `deploy.image.delta bytes` exceeds 10 MB. It prints the top three serial markers, so the failure names its cause. It also enforces Task 6's invariants on HA cold deploys: the `[state] up` lines show `lock-waits 0` and no `backpressure`; `iac.upStack.fan ≤ 1.25 × max(primary, standby)` (2.0× before Task 6); on k8s-ha, `deploy.k3s.standby.awaitDb < 60 s` and `deploy.ha.replication.transportEarly` not `(failed)`.
- Modify: the compose, compose-ha, k8s and k8s-ha cold-deploy steps in `tests/e2e/scenarios/_run-lifecycle.ts`, to run the check on cold deploys only (`iac.upStack` > 30 s, the existing cold definition).
- Test: `tests/unit/e2e/deploy-budget.test.ts` with fixture logs, covering each mode's pass, fail on time, and fail on bytes.

**Budgets (hard, no uplink exemption):**

| Mode | Budget | What it assumes |
|---|---|---|
| compose | **180 s** | upStack about 70, SSH and cloud-init 5, base pull plus 4-5 MB delta 10-45 (45 at last night's 0.1 MB/s), stack up about 15 with pulls overlapped, admin, audits and health about 17, backup cron 5, preamble about 15 |
| compose-ha | **300 s** | Task 6 removes the ~93 s lock wait, so the infra fan is max(primary, standby) ≈ 100 s instead of ~190; cold remote build 60-90 s; replication 30; health and audits about 20; TLS pending and bucket settle non-blocking. The Aug baseline before the lock (533 s total, with TLS and Supabase start-up) minus those gives about 280 s |
| k8s | **300 s** | upStack about 96, k3s ready 17, delta about 10-45, cert-manager 36, base apply 30, observability 11, traefik 11, app rollout 10, health 21 |
| k8s-ha | **420 s** | The registry-copy plan has landed; the primary arm is about 230 s after Task 5; Task 6's lock scope lets the standby upStack (~105 s) overlap instead of queueing; with the seed path deleted the standby db is up in seconds, and transport plus primary config run inside the fan-out (signalled), leaving the reseed (~30 s) and replication verify serial, about 60-80 s |

Rationale for the hard limit:
- After Tasks 3-5, uplink cost is bounded by the delta's byte count, which is also asserted. A slow uplink can then move a deploy by tens of seconds, not minutes, so an exemption would only hide regressions.
- The bytes assertion makes the uplink part deterministic.

- [ ] **Step 1: Write failing fixture tests** for every mode: pass, fail on time, and fail on bytes. The fail-on-time message must contain the top three markers.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/e2e/deploy-budget.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the marker, the check and the wiring.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `test(e2e): enforce per-mode cold-deploy budgets and the cold image-bytes ceiling`.

### Task 9: Real-infra verification (needs Brandon's OK for spend)

- [ ] **Step 1: Ask Brandon for spend approval.** Then run `pnpm test:e2e:batch -- --provider hetzner` from a dedicated worktree (see the `running-e2e-matrix` skill), then `--scenario digitalocean/compose` and `--scenario digitalocean/k8s` to show there's no provider-specific regression.
- [ ] **Step 2: Record per-mode `deploy.total`,** the delta bytes and the top serial markers in the ledger, then compare with the Context table. Expected: every cold deploy within budget and every cold delta ≤ 10 MB.
- [ ] **Step 3: Any budget miss gets RCA** under the same no-ladder rule before any budget number moves. A budget only moves with a ledger ruling that cites the log.
