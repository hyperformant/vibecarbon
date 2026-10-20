# k8s-ha: one operator upload, then a primary → standby registry copy

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In k8s-ha, the operator uploads the app image to the primary cluster only; the standby's in-cluster registry gets it server-to-server from the primary's registry over the existing WireGuard tunnel.

**Architecture:** Today each cluster runs its own `buildAppImage` → `sideloadK3s` (operator → every node, `docker save | gzip | ssh ... k3s ctr import`) → `pushImageToLocalRegistry` (operator → master registry over an SSH tunnel). On the e2e runs of 2026-10-20 the standby's share was `sideload.app` 500–567 s plus `registryPush.app` 6–954 s, all on the operator uplink and contending with the primary's own sideload. The standby's app tier is zeroed (pilot light), so the image is only needed at promotion, and at promotion kubelet pulls it from the standby's own registry (`registries.yaml` mirrors `<masterPrivateIp>:5000`). So the standby skips build, sideload and push. After the fan-out, the standby's **database node** (the only standby node on `wg0`) runs `k3s ctr` to pull from the primary registry through a new `registry-relay` socat pod on the primary database node (`10.99.0.1:15000` → `<primaryMasterPrivateIp>:5000`, admitting only `10.99.0.2`). It then pushes into the standby master's registry over the standby private network and compares the manifest digests on both sides.

**Tech Stack:** Node ESM CLI (`src/`), k3s `ctr` (containerd), socat (`alpine/socat:1.8.1.3`, already pinned in `repl-gateway.yaml`), WireGuard (`src/lib/deploy/wireguard.js`), vitest.

**Spec:** No separate spec. The design was agreed in conversation on 2026-10-20 (item 4: "copy image between the two k8s-ha clusters, never tried; server-to-server avoids object storage"). History constraints:
- `5834bdf` removed the S3-backed shared registry because of Hetzner Object Storage NoSuchBucket weather, so the copy must never touch object storage.
- 2026-08 remote-build flake history, so nothing here builds on a server.

## Global Constraints
- No object storage anywhere in the image path. The registry stays filesystem-backed (`tests/unit/template/registry-no-object-storage.test.ts` must stay green).
- No retry ladders and no fallback to the old operator push. If the copy fails, the deploy fails with ONE line: `standby image copy failed: <cause>`. The cause is either the first stderr line or `digest mismatch: primary <d1>, standby <d2>`.
- The copy traffic rides `wg0` only. No new cloud-firewall rule; the Hetzner and DO firewalls keep admitting only UDP 51821 cross-cluster.
- The relay admits exactly one peer: socat `range=10.99.0.2/32`, bound to `10.99.0.1`.
- New constant `REGISTRY_RELAY_PORT = 15000` in `src/lib/deploy/wireguard.js`, next to `REPL_GATEWAY_PORT`.
- Copy namespace on the standby db node: `vibecarbon-imgcopy` (never `k8s.io`). Its images are removed after the copy, whether it succeeds or fails.
- Image refs keep the existing scheme `<masterPrivateIp>:5000/<project>:<sha>[-dirty]-<ts>`. The standby ref is the primary's `<repo>:<tag>` under the standby's `<masterPrivateIp>:5000/` prefix (they differ on DO).
- Manifest digest comes from a `HEAD /v2/<repo>/manifests/<tag>` request with this Accept list, read from the `Docker-Content-Digest` header: `application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json`.
- ctr invocations, checked against the containerd docs via context7:
  - `k3s ctr -n vibecarbon-imgcopy images pull --plain-http --all-platforms <src>`
  - `k3s ctr -n vibecarbon-imgcopy images push --plain-http <dst> <src>`, where push takes the remote ref first and the local ref second, so no tag step is needed
- Single-cluster `k8s` mode is byte-for-byte unchanged in behaviour. Primary-cluster delivery in k8s-ha is unchanged.
- Perf marker: `deploy.ha.image.copyToStandby`. The `deploy.k3s.standby.sideload.app` and `deploy.k3s.standby.registryPush.app` markers disappear.
- Repo conventions: conventional commits, pathspec commits, never `--no-verify`, no `!:` footers. Commits end with `Claude-Session: https://claude.ai/code/session_01PqVojR4yFYgCf5xxZC6CnK`.

## Review Focus
1. **Warm redeploy with an unchanged image.** The copy finds equal digests and skips with `[image-copy] standby already has <digest>`, without re-pulling. Test in Task 3.
2. **The primary cluster's deploy fails before its image is built.** The standby deploy must not hang waiting for a tag. It rejects with `primary image unavailable: primary deploy failed`. Test in Task 4.
3. **The early transport prep failed, so the serial `setupReplication` brought the tunnel up.** The copy must start only after a transport is known up, never against a missing relay. Test in Task 5.
4. **Post-failover reconverge (roles swapped, the old standby is now primary).** The relay lands on the NEW primary's db node, any relay on the new standby is deleted, and the copy runs new primary → new standby. Tests in Tasks 2 and 5.
5. **Failover on a standby whose registry lacks the app image** (for example, an env deployed before this change whose push failed). Preflight refuses before mutating anything, naming the missing ref. Test in Task 6.

---

### Task 1: Pure image-delivery helpers

**Files:**
- Create: `src/lib/deploy/k8s/image-delivery.js`
- Test: `tests/unit/deploy/k8s-image-delivery.test.ts`

**Interfaces:**
- Produces:
  - `parseLocalRegistryRef(ref: string) -> { host: string, repo: string, tag: string, repoTag: string }`. It throws `not a local-registry ref: <ref>` unless the host ends in `:5000` and the tag is present.
  - `standbyImageRef({ primaryRef: string, standbyMasterPrivateIp: string }) -> string`.
  - `planImageDelivery({ role: 'primary'|'standby'|undefined }) -> { build: boolean, sideload: boolean, registryPush: boolean, awaitPeerImage: boolean }`.
  - `MANIFEST_ACCEPT: string` (the Accept list from Global Constraints).

- [ ] **Step 1: Write the failing tests**
  - `parseLocalRegistryRef('10.0.1.1:5000/quorum:abc123-20261020T120000Z')` deep-equals `{ host: '10.0.1.1:5000', repo: 'quorum', tag: 'abc123-20261020T120000Z', repoTag: 'quorum:abc123-20261020T120000Z' }`.
  - `parseLocalRegistryRef('ghcr.io/o/r:main')` throws `/not a local-registry ref/`.
  - `standbyImageRef({ primaryRef: '10.110.0.2:5000/quorum:t1', standbyMasterPrivateIp: '10.120.0.3' })` equals `'10.120.0.3:5000/quorum:t1'`.
  - `planImageDelivery({ role: 'standby' })` deep-equals `{ build: false, sideload: false, registryPush: false, awaitPeerImage: true }`.
  - `planImageDelivery({ role: 'primary' })` and `planImageDelivery({})` both deep-equal `{ build: true, sideload: true, registryPush: true, awaitPeerImage: false }`.
- [ ] **Step 2:** Run `pnpm vitest run tests/unit/deploy/k8s-image-delivery.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement the four exports in `image-delivery.js`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit with `feat(k8s-ha): image-delivery plan and local-registry ref helpers`.

### Task 2: `registry-relay` pod on the primary database node

**Files:**
- Create: `carbon/k8s/base/repl-gateway/registry-relay.yaml`. It is a bare Pod named `registry-relay`, labelled `app: registry-relay`, with the same `hostNetwork`, `nodeSelector: dedicated: db`, toleration, resources and `alpine/socat:1.8.1.3@sha256:fb3862c9…` image as `repl-gateway.yaml`.
  - args: `TCP-LISTEN:__RELAY_PORT__,bind=__WG_PRIMARY_IP__,fork,reuseaddr,range=__WG_STANDBY_IP__/32` and `TCP:__REGISTRY_TARGET__`.
  - Header comment explaining why it exists (standby image copy over wg0) and that it is NOT in the kustomization.
- Modify: `src/lib/deploy/wireguard.js` (add `REGISTRY_RELAY_PORT = 15000`).
- Modify: `src/lib/deploy/k8s/ha/index.js`.
  - Add `renderRegistryRelayManifest({ template, primaryMasterPrivateIp })`.
  - `applyGatewaysAndBringUpTunnel` gains `primaryMasterPrivateIp`. On the primary master it applies the rendered relay, using the same delete-and-reapply-on-`Forbidden` handling as `applyGatewayPod`. On the standby master it runs `kubectl delete pod registry-relay -n vibecarbon --ignore-not-found`, which covers the role swap.
  - Thread `primaryMasterPrivateIp` (required, never defaulted, same guard style as `primaryDbPrivateIp`) through `prepareReplicationTransport` and `setupReplication`.
- Modify: `src/lib/deploy/k8s/k3s.js:4363`. `onInfraReady` also passes `masterPrivateIp`, and the `deployK3s` return object (`:4587`) adds `masterPrivateIp`.
- Test: `tests/unit/deploy/k8s-ha-registry-relay.test.ts`; extend `tests/unit/deploy/k8s-ha-transport-prep.test.ts`.

**Interfaces:**
- Consumes: `WG_PRIMARY_IP`, `WG_STANDBY_IP`, `REGISTRY_RELAY_PORT`.
- Produces: `renderRegistryRelayManifest({ template: string, primaryMasterPrivateIp: string }) -> string`. `deployK3s(...)` resolves with `masterPrivateIp`, and the `onInfraReady` payload carries it.

- [ ] **Step 1: Write the failing tests**
  - The render with `primaryMasterPrivateIp: '10.0.1.1'`:
    - contains `TCP-LISTEN:15000,bind=10.99.0.1,fork,reuseaddr,range=10.99.0.2/32`;
    - contains `TCP:10.0.1.1:5000`;
    - has no `__` placeholders left.
  - The render throws `/primaryMasterPrivateIp is required/` when the IP is empty.
  - `carbon/k8s/base/kustomization.yaml` and `carbon/k8s/base/repl-gateway/` kustomizations (if any) do not list `registry-relay.yaml`.
  - The transport-prep test with a recording `runCommandAsync` mock:
    - the primary master receives a `kubectl apply -f -` whose input contains `name: registry-relay`;
    - the standby master receives `kubectl delete pod registry-relay -n vibecarbon --ignore-not-found`;
    - a missing `primaryMasterPrivateIp` rejects `/primaryMasterPrivateIp is required/`.
- [ ] **Step 2:** Run `pnpm vitest run tests/unit/deploy/k8s-ha-registry-relay.test.ts tests/unit/deploy/k8s-ha-transport-prep.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the manifest, render, apply/delete and threading above. Update existing callers and tests that construct the `prepareReplicationTransport` and `setupReplication` args (`k8s-ha-repl-gateway`, `repl-gateway-reapply`).
- [ ] **Step 4:** Run the same command plus `pnpm vitest run tests/unit/deploy/repl-gateway-reapply.test.ts tests/unit/deploy/k8s-ha-repl-gateway.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit with `feat(k8s-ha): registry relay on the primary database node, wg0-only`.

### Task 3: `copyAppImageToStandby`

**Files:**
- Create: `src/lib/deploy/k8s/ha/image-copy.js`
- Test: `tests/unit/deploy/k8s-ha-image-copy.test.ts`

**Interfaces:**
- Consumes:
  - `parseLocalRegistryRef`, `standbyImageRef`, `MANIFEST_ACCEPT` from Task 1;
  - `WG_PRIMARY_IP`, `REGISTRY_RELAY_PORT`;
  - `buildHostKeyOptsForPath`, `runCommandAsync`.
- Produces:
  - `buildImageCopyScript({ srcRef: string, dstRef: string }) -> string`, a POSIX `sh` script run on the standby db node.
  - `copyAppImageToStandby({ primaryRef, standbyMasterPrivateIp, standbyDbIp, sshKeyPath, run? }) -> Promise<{ digest: string, skipped: boolean }>`.
    - `srcRef` is `${WG_PRIMARY_IP}:${REGISTRY_RELAY_PORT}/<repoTag>`.
    - `dstRef` is `standbyImageRef(...)`.
    - `run` is a test seam that defaults to ssh `root@<standbyDbIp> sh -s` with the script on stdin.

The script, in order (`set -eu`), prints the machine-readable lines `SRC_DIGEST=`, `DST_DIGEST=`, `SKIPPED=1` or `COPIED=1`:
1. `digest()` helper: `curl -fsSI -H "Accept: $ACCEPT" http://$1/v2/$2/manifests/$3 | tr -d '\r' | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}'`.
2. Read the source digest. If it is empty, `echo "ERR=primary registry has no <repoTag>" >&2; exit 3`.
3. Read the destination digest (empty is allowed). If it equals the source, print `SKIPPED=1` and exit 0.
4. `trap 'k3s ctr -n vibecarbon-imgcopy images rm "$SRC" >/dev/null 2>&1 || true' EXIT`. Then run the pull and push from Global Constraints.
5. Re-read the destination digest. If it differs from the source, `echo "ERR=digest mismatch: primary $S, standby $D" >&2; exit 4`. Otherwise print `COPIED=1`.

- [ ] **Step 1: Write the failing tests**
  - `buildImageCopyScript({ srcRef: '10.99.0.1:15000/quorum:t1', dstRef: '10.0.1.1:5000/quorum:t1' })`:
    - contains `images pull --plain-http --all-platforms 10.99.0.1:15000/quorum:t1`;
    - contains `images push --plain-http 10.0.1.1:5000/quorum:t1 10.99.0.1:15000/quorum:t1`;
    - contains `-n vibecarbon-imgcopy`, and never `-n k8s.io`;
    - contains `trap`;
    - contains the exact `MANIFEST_ACCEPT` string.
  - A `run` mock returning `SRC_DIGEST=sha256:aa\nDST_DIGEST=sha256:aa\nSKIPPED=1` resolves `{ digest: 'sha256:aa', skipped: true }`.
  - A `run` mock returning the `COPIED=1` lines resolves `{ digest: 'sha256:aa', skipped: false }`.
  - A `run` mock rejecting with stderr `ERR=digest mismatch: primary sha256:aa, standby sha256:bb\n...` rejects with the message exactly `standby image copy failed: digest mismatch: primary sha256:aa, standby sha256:bb`, which is one line.
  - A `run` mock rejecting with arbitrary multi-line stderr rejects with `standby image copy failed: <first non-empty line>`.
  - The `run` mock is called exactly once in every case (no retry).
- [ ] **Step 2:** Run `pnpm vitest run tests/unit/deploy/k8s-ha-image-copy.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement both exports. `progressLog` emits `[image-copy] standby already has <digest>` on skip and `[image-copy] copied <repoTag> (<digest>)` on copy.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit with `feat(k8s-ha): copy the app image primary → standby registry over wg0`.

### Task 4: The standby `deployK3s` stops building, sideloading and pushing

**Files:**
- Modify: `src/lib/deploy/k8s/k3s.js`.
  - At the build step (`:4420-4440`): consult `planImageDelivery({ role: options.role })`.
    - When `build` is false, skip `buildAppImage` and the `k3s-build` state step. Set `imageTag = standbyImageRef({ primaryRef: await options.peerImageRef, standbyMasterPrivateIp: masterPrivateIp })`.
    - When `options.peerImageRef` is absent on a standby, throw `deployK3s: role standby requires peerImageRef`.
  - Sideload (`:4442-4466`): skipped when `sideload` is false.
  - `applyK3sManifests` (`:3546-3601`): gains `registryPush` (default true). When it is false, keep the `localRegistry.wait` and skip `pushImageToLocalRegistry` and its await at `:4105`.
  - New option `onImageBuilt(ref)`: called on the primary after the build step, whether it built or was skipped, with the final `imageTag`.
- Test: `tests/unit/deploy/k3s-standby-image-delivery.test.ts`. Reuse the module-mock pattern of `tests/unit/deploy/k8s-ha-fanout-roles.test.ts`.

**Interfaces:**
- Consumes: `planImageDelivery` and `standbyImageRef` from Task 1.
- Produces:
  - `deployK3s` options `peerImageRef?: Promise<string>` and `onImageBuilt?: (ref: string) => void`;
  - the `applyK3sManifests` option `registryPush?: boolean`.

- [ ] **Step 1: Write the failing tests**
  - With `role: 'standby'` and `peerImageRef: Promise.resolve('10.0.1.1:5000/quorum:t1')`:
    - `buildAppImage`, `sideloadK3s` and `pushImageToLocalRegistry` are never called;
    - `kubectl set image deployment/app app=10.0.1.1:5000/quorum:t1` is issued;
    - the result's `imageTag` equals that ref.
  - With `role: 'standby'` and `peerImageRef: Promise.reject(new Error('primary image unavailable: primary deploy failed'))`: `deployK3s` rejects with that message.
  - With `role: 'primary'`: `onImageBuilt` is called once with the built tag, and sideload and push are both called (unchanged).
  - With no `role` (single k8s): the calls are identical to `primary`, and `onImageBuilt` is not required.
- [ ] **Step 2:** Run `pnpm vitest run tests/unit/deploy/k3s-standby-image-delivery.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the changes above. Update the comments at `:3563-3580` (the HA uplink-contention note no longer applies) and the `buildAppImage` doc block (`:1396-1401`).
- [ ] **Step 4:** Run the same command plus `pnpm vitest run tests/unit/deploy/` (the k3s suite). Expected: PASS.
- [ ] **Step 5:** Commit with `feat(k8s-ha): pilot-light standby takes its image from the primary, not the operator`.

### Task 5: Wire the copy into the k8s-ha deploy

**Files:**
- Modify: `src/lib/deploy/effects/k8s-ha.js`.
  - Create `primaryImage = deferInfra()`. Pass `onImageBuilt: primaryImage.resolve` to the primary and `peerImageRef: primaryImage.promise` to the standby.
  - On `primaryPromise` rejection, reject the deferred with `primary image unavailable: primary deploy failed`. Give it a `.catch(() => {})` guard against unhandled rejection.
  - Delete `localTunnelPort: 5001` and its comment on the standby, since no standby push exists any more.
  - Pass `primaryMasterPrivateIp` (from `pInfra.masterPrivateIp` / `primaryResult.masterPrivateIp`) to `prepareReplicationTransport` and `setupReplication`.
  - After both clusters settle OK, run `perfAsync('deploy.ha.image.copyToStandby', () => copyAppImageToStandby({ primaryRef: primary.imageTag, standbyMasterPrivateIp: standby.masterPrivateIp, standbyDbIp: standby.dbIp, sshKeyPath: sharedSshKeyPath }))`. Await it before the deploy reports success, and let a rejection fail the deploy.
- Test: extend `tests/unit/deploy/k8s-ha-fanout-roles.test.ts`, or create `tests/unit/deploy/k8s-ha-image-copy-wiring.test.ts`.

**Interfaces:**
- Consumes: `copyAppImageToStandby` (Task 3); `deployK3s` options and `masterPrivateIp` (Tasks 2 and 4).
- Produces: the ordering invariant "copy starts after transport is up". It starts when `earlyPrep` resolved `true`, or else after `setupReplication` resolves. When `earlyPrep` is true it runs concurrently with `setupReplication`.

- [ ] **Step 1: Write the failing tests** (mocked `deployK3s`, `prepareReplicationTransport`, `setupReplication`, `copyAppImageToStandby`; the call order is recorded):
  - **earlyPrep succeeds:** the copy is invoked with `primaryRef` equal to the primary result's `imageTag`, after `prepareReplicationTransport` resolved, and before the effect resolves.
  - **earlyPrep rejects:** the copy is invoked only after `setupReplication` resolved.
  - **The copy rejects** with `standby image copy failed: x`: the effect rejects with that message.
  - **Primary `deployK3s` rejects:** the standby's `peerImageRef` rejects with `primary image unavailable: primary deploy failed`, and the copy is not called.
  - **Role swap (reconverge):** when `ctx` marks the old standby as primary, the copy's `standbyDbIp` is the new standby's db IP. Mirror the existing reconverge fixture in `k8s-ha-fanout-roles.test.ts`.
- [ ] **Step 2:** Run the new or extended test file. Expected: FAIL.
- [ ] **Step 3:** Implement the wiring.
- [ ] **Step 4:** Run the same command plus `pnpm vitest run tests/unit/deploy/k8s-ha-*.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit with `feat(k8s-ha): copy the image to the standby once replication transport is up`.

### Task 6: Failover preflight refuses a standby without the app image

**Files:**
- Modify: `src/lib/deploy/k8s/ha/image-copy.js`. Add `assertStandbyHasAppImage({ standbyIp, sshKeyPath, khPath, run? }) -> Promise<string>`.
  - Over ssh to the standby master, read `kubectl -n vibecarbon get deployment app -o jsonpath='{.spec.template.spec.containers[0].image}'`.
  - If the ref is a local-registry ref, `HEAD` it on `http://<host>/v2/<repo>/manifests/<tag>` with `MANIFEST_ACCEPT`.
  - Return the digest. Non-local refs (ghcr, CI push mode) return `'external'` without a HEAD.
  - When the digest is missing, throw `standby registry lacks the app image <ref>; redeploy (vibecarbon deploy) while the primary is up`.
- Modify: `src/failover.js`. Call it in `failoverHA` right after `preflight`, before step 2 (provision), as a `deps.assertStandbyImage` seam defaulting to the real function.
- Test: `tests/unit/failover/standby-image-precheck.test.ts`

- [ ] **Step 1: Write the failing tests**
  - A `run` mock returning image `10.0.1.1:5000/quorum:t1` and then a digest resolves `'sha256:aa'`.
  - An empty digest rejects with the exact message above for `10.0.1.1:5000/quorum:t1`.
  - Image `ghcr.io/o/r:main` resolves `'external'` and issues no HEAD.
  - `failoverHA` with `deps.assertStandbyImage` rejecting: the provision, quiesce and scale seams are never called.
- [ ] **Step 2:** Run `pnpm vitest run tests/unit/failover/standby-image-precheck.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command plus `pnpm vitest run tests/unit/failover/`. Expected: PASS.
- [ ] **Step 5:** Commit with `feat(failover): refuse a pilot-light failover when the standby registry lacks the app image`.

### Task 7: Image-delivery census and docs

**Files:**
- Create: `tests/unit/deploy/k8s-image-delivery-census.test.ts`. It walks every `.js` file under `src/` (fs walk, not a hand list) and finds each call expression of `sideloadK3s(`, `pushImageToLocalRegistry(`, `pushImageOverSshTunnel(`, `buildAppImage(` and `copyAppImageToStandby(`, keyed by `file:enclosingFunctionName`.
  - It asserts the found set equals a classified table:
    - `k3s.js:deployK3s` for `buildAppImage` and `sideloadK3s`, gated by `planImageDelivery`;
    - `k3s.js:applyK3sManifests` for `pushImageToLocalRegistry`, gated by `registryPush`;
    - `k3s.js:pushImageToLocalRegistry` for `pushImageOverSshTunnel`;
    - `effects/index.js:<fn>` for `pushImageOverSshTunnel`, compose tier;
    - `effects/k8s-ha.js:<fn>` for `copyAppImageToStandby`.
  - A new, unclassified call site fails with `unclassified image-delivery call site <file:fn>: decide whether a standby can reach it`.
  - It asserts that each `k3s.js` gated site's enclosing function body references `planImageDelivery(` or `registryPush`.
- Modify:
  - `carbon/k8s/base/registry/local-registry.yaml`: the comment "every deploy (each k8s-ha cluster separately …) builds and pushes its own image" now says the standby receives it from the primary over wg0.
  - `src/lib/deploy/registry-push.js`: the "Uplink serialization" block notes that k8s-ha now makes one push per deploy, and the mutex stays for matrix siblings.
  - `docs/deploy-hetzner.md`: the k8s-ha deploy section gets one paragraph on image delivery.
  - The `e2e-perf-optimizer` notes, if they name `standby.sideload.app`.

- [ ] **Step 1:** Write the census. It should FAIL only if a site is misclassified. Mutation-check it by temporarily adding a `sideloadK3s(` call in a scratch function: the test must fail, then revert.
- [ ] **Step 2:** Run `pnpm vitest run tests/unit/deploy/k8s-image-delivery-census.test.ts`. Expected: PASS.
- [ ] **Step 3:** Make the doc and comment edits.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test:unit`. Expected: all green.
- [ ] **Step 5:** Commit with `test(k8s-ha): census every image-delivery call site; docs for the standby copy`.

## Verification
- Every task: its vitest command green, plus `pnpm lint && pnpm typecheck`. End of branch: `pnpm test:unit && pnpm test:integration`, then `test.yml` dispatched green.
- Real infra is gated on Brandon's OK: `pnpm test:e2e:batch -- --scenario hetzner/k8s-ha`. Acceptance:
  - the CLI log has `deploy.ha.image.copyToStandby` and none of `deploy.k3s.standby.sideload.app` / `deploy.k3s.standby.registryPush.app`;
  - verify-failover and reconverge-deploy pass, so the promoted standby pulled from its own registry;
  - `deploy.ha.k8s.full` drops by roughly the old standby share (expected −8 to −11 min).
- A DO run (`--provider digitalocean`, d4) is the check that the per-cluster `masterPrivateIp` differs and the retagged ref is right.

## Rulings and open risks
- **Ruling: the copy runs on the standby DATABASE node.** It is the only standby node on `wg0`, and it reaches the standby master's `:5000` over the private network, the same path its kubelet already pulls on. Routing `wg0` to the master would need new routes.
- **Ruling: use `k3s ctr`, not crane or skopeo.** It is already on every node, so no new image is pulled from gcr or quay, and none needs pinning. `ctr push` sends the pulled bytes unchanged, so digests are preserved, and `--all-platforms` carries any attestation manifests.
- **Ruling: the relay is a separate bare Pod, not a second container in `repl-gateway`.** A spec change to `repl-gateway` would recreate it, which drops replication briefly; a separate pod keeps the two lifecycles apart.
- **Ruling: the standby no longer sideloads to its own master and db nodes.** Its app tier is zero, and the pods that run there use ghcr or third-party images. Promotion pulls through the standby registry exactly as CA-spawned workers already do today.
- **Risk:** the registry has no auth, so through the relay the standby db node could also write to the primary registry. It is limited to one tunnel peer and is our own node. This is accepted; registry auth is a separate change.
- **Risk:** the standby db node briefly holds a second copy of the image's compressed layers (about 150–200 MB) in containerd content. The trap removes the image, and containerd GC reclaims the content afterwards.
- **Out of scope** (noted for the parent): primary-cluster sideload still streams operator → every node. Moving primary workers to registry pulls would cut the operator upload to a single stream, but that is a separate change.
