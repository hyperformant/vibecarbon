# k8s-ha: one operator upload, then a primary → standby registry copy

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Refresh 2026-10-21

The plan was written on 2026-10-20, before #234 (security), #235 (HA), #236 (add-ons) and #237 (backup/restore) landed on this stack. Every task was re-checked against `feat/k8s-ha-registry-copy` at `5822822`. What changed, and why:

- **Line numbers.** `k3s.js` grew by about 700 lines. `onInfraReady` is now at `:5011-5017`, the build step at `:5076-5105`, the sideload at `:5107-5133`, the `deployK3s` return at `:5280-5292`, the backgrounded registry push at `:4120-4170`, and its await at `:4752`. All paths and lines below are current.
- **Task 2 reshaped: the relay is now ephemeral and owned by the copy, not by the transport.**
  - `repl-gateway` is now a one-replica Deployment (#235). `applyGatewayPod` and its delete-and-reapply-on-`Forbidden` handling are gone, so the old Task 2 step had nothing to copy.
  - `applyGatewaysAndBringUpTunnel` applies the gateways *before* `exchangeAndBringUpTunnel` brings `wg0` up. A relay applied there cannot bind `10.99.0.1` yet. It crash-loops and backs off for up to 5 minutes, and the copy runs straight after and would hit a relay in backoff. Applying the relay in the copy step (`wg0` is already up) and waiting for `Ready` removes that race at the root.
  - An ephemeral relay (applied for the copy, deleted after it either way) also shrinks the accepted "unauthenticated registry reachable over the tunnel" risk to the copy window. And `prepareReplicationTransport` / `setupReplication` stay as they are: no new required argument for every caller and test to thread.
  - `onInfraReady` no longer needs `masterPrivateIp`. Only the `deployK3s` return does, because the copy runs after both clusters settle.
- **Census constraint (new).** `tests/unit/deploy/compose-ha-primary-address-census.test.ts` (R11) allows `WG_PRIMARY_IP` only in `wireguard.js` and `k8s/ha/index.js`. The relay's tunnel address and the copy's source host are therefore built in `k8s/ha/index.js` (the census-exempt k8s-ha role model) and exported. `image-copy.js` never names the constant.
- **Task 3: ssh goes through `sshRun`.** The copy script and the failover check use `sshRun` from `src/lib/ssh.js` with `input`, instead of a hand-built `runCommandAsync(['ssh', ...])`. That is the shared chokepoint (host-key pinning, BatchMode, keepalives). Its built-in never-started-transport retry is the repo-wide transport policy, not a copy retry. A rejection's `err.message` starts with `Command failed: ssh ...`, so the one-line cause is parsed from `err.stderr`: the `ERR=` line first, otherwise the first non-empty stderr line that is not an ssh `Warning:`.
- **Task 3/6 shared helper.** Both remote scripts read a manifest digest. The `digest()` shell function now comes from one export (`MANIFEST_DIGEST_SH` in Task 1), so it is not written twice.
- **Task 4 reshaped: testable seam, and no new `applyK3sManifests` option.**
  - `buildAppImage`, `sideloadK3s` and `pushImageToLocalRegistry` are same-module calls inside `deployK3s`, so `vi.mock` cannot intercept them. There is no harness that drives `deployK3s` past infra. The build and sideload block moves into an exported `deliverAppImage(...)` with injectable `deps`, and that is what gets tested.
  - `applyK3sManifests` already receives `role`. It derives the push from `planImageDelivery({ role }).registryPush` itself instead of taking a new `registryPush` flag, so the role → delivery decision lives in one function. It is tested in the existing spawn-mock harness, `tests/unit/deploy/k3s-apply-manifests-ordering.test.ts`.
  - The app image now lands through a strategic-merge `kubectl patch deployment/app` that sets both `app` and the `migrate` init container (`:4517-4548`). `kubectl set image` is gone, so the assertion targets the patch JSON.
  - `localTunnelPort` was there only for two concurrent HA pushes. With one push per deploy it goes, along with its `5000`/`5001` threading and comments (`k3s.js:3444-3449`, `effects/k8s-ha.js:191-197`, `:216`, `:248`). The port walk inside `registry-push.js` stays for cross-process siblings.
- **Task 5 reshaped: a plan step, not an inline await.**
  - The k8s-ha deploy is now a `planDeploy` step list (`src/lib/deploy/plan/deploy-plan.js:127-145`, `steps.js:283-310`). The copy becomes a new required step `copy-standby-image` (effect `haK8sCopyStandbyImage`) after `verify-streaming`.
  - When early prep succeeded, `haK8sProvisionClusters` starts the copy in the background so it overlaps `setupReplication`, and the step awaits it. Otherwise the step starts it.
  - `tests/unit/deploy/plan/deploy-plan.test.ts` pins the sequence and the effect map, so it is updated.
- **Task 6 re-placed.** `failoverHA` now has a step 1b (replica proof) and a `liftStranded` write before it (`failover.js:1825-1880`). The image check therefore goes right after `preflight` and before `liftStranded`, which is the first mutation.
  - On a journal resume (`ha.failoverInFlight`) the standby is already promoted, so refusing would strand it. The check is skipped there (see ruling R6 in the ledger).
  - Nine test files drive `failoverHA` and must inject the new seam, or the real one would ssh.
- **Task 7 corrected.** `registry-push.js`'s "matrix siblings" remark is stale: the cross-process `uplink-lock.js` now covers siblings. The census call-site table follows Task 4's `deliverAppImage`, and it parses with vite's `parseAst`, the same way the R11 census does.
- **Acceptance corrected.** On the 2026-10-20 runs the primary arm (770 s) was already longer than the standby arm (698 s), so removing the standby's share cannot cut wall clock by "8 to 11 min" on its own. The gain comes from the primary sideload getting the whole uplink. Acceptance now records the change and does not gate on that number.
- **Cross-plan coordination (new).** `docs/superpowers/plans/2026-10-20-cold-deploy-speed.md`:
  - Its Task 5 deletes `sideloadK3s` and `pushImageToLocalRegistry` and delivers once to the master registry. Whichever plan lands second updates this plan's census table and `deliverAppImage`.
  - Its Task 6 deletes the standby seed path, which this change unmasks (standby `awaitDb` 345-360 s). That plan says it must land before or with this one.
- **Constraints carried in.** The Global Constraints now name the secret, dotenv, project-config and vocabulary rules for this stack. The fixed `Claude-Session` trailer from the earlier session is dropped: commits carry whatever attribution the executing session is told to add.
- **Pre-flight scan fixes, applied in place** (the ledger has the rows):
  - Tasks 1 and 3 gain executed shell tests (stub `curl`/`k3s` on `PATH`), so the scripts' skip, mismatch and trap behaviour is run, not only string-matched.
  - Task 4 spells its calls `d.buildAppImage(` / `d.sideloadK3s(` so the Task 7 census can see them.
  - Task 6's seam is a dynamic import.
  - Task 4's commit notes the gap until Task 5 lands.
- **Nothing obsolete was dropped.** All 7 tasks are still needed. Tasks 2, 4, 5 and 6 are reshaped, and Tasks 1, 3 and 7 are partly updated.

---

**Goal:** In k8s-ha, the operator uploads the app image to the primary cluster only. The standby's in-cluster registry gets it server-to-server from the primary's registry, over the existing WireGuard tunnel.

**Architecture:** Today each cluster runs `buildAppImage` → `sideloadK3s` (operator → every node: `docker save | gzip | ssh ... k3s ctr import`) → `pushImageToLocalRegistry` (operator → master registry over an SSH tunnel).
- On the 2026-10-20 e2e runs the standby's share was `sideload.app` 500–567 s plus `registryPush.app` 6–954 s, all on the operator uplink and contending with the primary's own sideload.
- The standby's app tier is zeroed (pilot light), so the image is only needed at promotion. At promotion kubelet pulls it from the standby's own registry (`registries.yaml` mirrors `<masterPrivateIp>:5000`). So the standby skips build, sideload and push.
- After both clusters settle and the transport is up, a short-lived `registry-relay` socat Pod runs on the primary database node: `10.99.0.1:15000` → `<primaryMasterPrivateIp>:5000`, admitting only `10.99.0.2`.
- The standby's **database node** (the only standby node on `wg0`) runs `k3s ctr` to pull from the primary registry through that relay. It pushes into the standby master's registry over the standby private network and compares the manifest digests on both sides.
- The relay is deleted afterwards, whether the copy succeeded or failed.

**Tech Stack:** Node ESM CLI (`src/`), k3s `ctr` (containerd), socat (`alpine/socat:1.8.1.3@sha256:fb3862c949af7c79996d0e514ee96128644d840835ed5368eeecb14a869de361`, the pin already in `repl-gateway.yaml`), WireGuard (`src/lib/deploy/wireguard.js`), vitest.

**Spec:** No separate spec. The design was agreed in conversation on 2026-10-20 (item 4: "copy image between the two k8s-ha clusters, never tried; server-to-server avoids object storage"). History constraints:
- `5834bdf` removed the S3-backed shared registry because of Hetzner Object Storage NoSuchBucket weather, so the copy must never touch object storage.
- 2026-08 remote-build flake history, so nothing here builds on a server.

## Global Constraints
- No object storage anywhere in the image path. The registry stays filesystem-backed (`tests/unit/template/registry-no-object-storage.test.ts` must stay green).
- No retry ladders and no fallback to the old operator push. If the copy fails, the deploy fails with ONE line: `standby image copy failed: <cause>`. The cause is one of:
  - the `ERR=` line the script printed;
  - `digest mismatch: primary <d1>, standby <d2>`;
  - `registry relay not ready on the primary: <first line>`;
  - otherwise the first non-empty stderr line.
- Root fixes only. A failure is explained and its cause removed, never wrapped in a wider timeout or another attempt.
- The copy traffic rides `wg0` only. No new cloud-firewall rule: the Hetzner and DO firewalls keep admitting only UDP 51821 cross-cluster.
- The relay admits exactly one peer: socat `range=10.99.0.2/32`, bound to `10.99.0.1`. It exists only for the duration of the copy.
- New constant `REGISTRY_RELAY_PORT = 15000` in `src/lib/deploy/wireguard.js`, next to `REPL_GATEWAY_PORT`.
- `WG_PRIMARY_IP` / `WG_STANDBY_IP` are named only in `wireguard.js` and `k8s/ha/index.js` (the R11 census). `image-copy.js` gets the relay host from `k8s/ha/index.js`.
- Copy namespace on the standby db node: `vibecarbon-imgcopy` (never `k8s.io`). Its images are removed after the copy, whether it succeeds or fails.
- Image refs keep the existing scheme `<masterPrivateIp>:5000/<project>:<sha>[-dirty]-<ts>`. The standby ref is the primary's `<repo>:<tag>` under the standby's `<masterPrivateIp>:5000/` prefix. On Hetzner both masters are `10.0.1.1`, so the refs are equal. On DO they differ.
- Manifest digest comes from a `HEAD /v2/<repo>/manifests/<tag>` request with this Accept list, read from the `Docker-Content-Digest` header: `application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json`.
- ctr invocations, re-checked against the containerd docs via context7 on 2026-10-21 (`push` takes the remote ref first and the local ref second, so no tag step is needed):
  - `k3s ctr -n vibecarbon-imgcopy images pull --plain-http --all-platforms <src>`
  - `k3s ctr -n vibecarbon-imgcopy images push --plain-http <dst> <src>`
- Remote commands go through `sshRun` (`src/lib/ssh.js`). No hand-built `ssh` argv and no `| ssh` strings (`raw-ssh-opts-census`).
- Single-cluster `k8s` mode is byte-for-byte unchanged in behaviour. Primary-cluster delivery in k8s-ha is unchanged.
- Perf marker: `deploy.ha.image.copyToStandby`. The `deploy.k3s.standby.sideload.app` and `deploy.k3s.standby.registryPush.app` markers disappear.
- Never print secrets: no token, key or `.env` value in any log line, error, perf marker or test snapshot.
- Dotenv is written only via `formatDotenvLine`, and `.vibecarbon.json` only via `updateProjectConfig`. This plan writes neither, and no task may add a write.
- No Supabase vocabulary in code, comments, docs or messages. No legacy compat for Supabase-era envs.
- Pre-1.0: no `!:` footers and no `BREAKING CHANGE`. The PR body carries a Compatibility note: "k8s-ha standby now receives its app image from the primary; the first redeploy after upgrading copies it."
- Repo conventions: conventional commits, pathspec commits (`git commit -- <files>`), never `--no-verify`. Attribution lines only as the executing session's instructions specify.

## Review Focus
1. **Warm redeploy with an unchanged image.** The copy finds equal digests and skips with `[image-copy] standby already has <digest>`, without pulling. Test in Task 3.
2. **The primary cluster's deploy fails before its image is built.** The standby deploy must not hang waiting for a tag. It rejects with `primary image unavailable: primary deploy failed`. Tests in Tasks 4 and 5.
3. **The copy starts only after a transport is known up.** It starts early only when `ctx.transportPrepared` is true. Otherwise it starts in `copy-standby-image`, which runs after `configure-replication` and `verify-streaming`. The relay is applied after `wg0` exists and is waited `Ready` before the pull. Tests in Tasks 2 and 5.
4. **Post-failover reconverge (roles swapped, the old standby is now primary).** The relay lands on the NEW primary's master (`ctx.primaryResult`), any leftover relay on the new standby is deleted, and the copy runs new primary → new standby. Tests in Tasks 2 and 5.
5. **Failover on a standby whose registry lacks the app image** (for example, a standby master that was replaced, since its registry is a hostPath on the master disk). Preflight refuses before anything mutates, naming the missing ref. Test in Task 6.
6. **No unread-seam regressions.** Every test that drives `failoverHA` or the k8s-ha effects with module mocks still passes, because the new seams are injected or mocked, never reached for real. Tasks 5 and 6.

---

### Task 1: Pure image-delivery helpers

Status: **still needed**, plus one shared export (`MANIFEST_DIGEST_SH`).

**Files:**
- Create: `src/lib/deploy/k8s/image-delivery.js`
- Test: `tests/unit/deploy/k8s-image-delivery.test.ts`

**Interfaces:**
- Produces:
  - `parseLocalRegistryRef(ref: string) -> { host: string, repo: string, tag: string, repoTag: string }`. It throws `not a local-registry ref: <ref>` unless the host ends in `:5000` and the tag is present.
  - `standbyImageRef({ primaryRef: string, standbyMasterPrivateIp: string }) -> string`. It throws `/standbyMasterPrivateIp is required/` when the IP is empty.
  - `planImageDelivery({ role: 'primary'|'standby'|undefined }) -> { build: boolean, sideload: boolean, registryPush: boolean, awaitPeerImage: boolean }`.
  - `MANIFEST_ACCEPT: string` (the Accept list from Global Constraints).
  - `MANIFEST_DIGEST_SH: string`: the POSIX `digest()` shell function, used by both Task 3 and Task 6. `digest host repo tag` prints the `Docker-Content-Digest` header value, or nothing.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  MANIFEST_ACCEPT,
  MANIFEST_DIGEST_SH,
  parseLocalRegistryRef,
  planImageDelivery,
  standbyImageRef,
} from '../../../src/lib/deploy/k8s/image-delivery.js';

describe('image-delivery helpers', () => {
  it('parses a local-registry ref', () => {
    expect(parseLocalRegistryRef('10.0.1.1:5000/quorum:abc123-20261020T120000Z')).toEqual({
      host: '10.0.1.1:5000',
      repo: 'quorum',
      tag: 'abc123-20261020T120000Z',
      repoTag: 'quorum:abc123-20261020T120000Z',
    });
  });
  it('refuses a non-local ref and a tagless one', () => {
    expect(() => parseLocalRegistryRef('ghcr.io/o/r:main')).toThrow(/not a local-registry ref/);
    expect(() => parseLocalRegistryRef('10.0.1.1:5000/quorum')).toThrow(/not a local-registry ref/);
  });
  it('re-prefixes the primary ref for the standby registry', () => {
    expect(
      standbyImageRef({ primaryRef: '10.110.0.2:5000/quorum:t1', standbyMasterPrivateIp: '10.120.0.3' }),
    ).toBe('10.120.0.3:5000/quorum:t1');
    expect(() => standbyImageRef({ primaryRef: '10.0.1.1:5000/q:t', standbyMasterPrivateIp: '' })).toThrow(
      /standbyMasterPrivateIp is required/,
    );
  });
  it('plans delivery by role', () => {
    const operator = { build: true, sideload: true, registryPush: true, awaitPeerImage: false };
    expect(planImageDelivery({ role: 'standby' })).toEqual({
      build: false,
      sideload: false,
      registryPush: false,
      awaitPeerImage: true,
    });
    expect(planImageDelivery({ role: 'primary' })).toEqual(operator);
    expect(planImageDelivery({})).toEqual(operator);
  });
  it('the digest helper sends the full Accept list and reads the header case-insensitively', () => {
    expect(MANIFEST_DIGEST_SH).toContain(MANIFEST_ACCEPT);
    expect(MANIFEST_DIGEST_SH).toMatch(/curl -fsSI/);
    expect(MANIFEST_DIGEST_SH).toContain('tolower($1)=="docker-content-digest"');
  });
});
```

  Plus one executed test (`tests/unit/deploy/k8s-image-delivery.test.ts`, `describe('MANIFEST_DIGEST_SH runs')`). It writes a stub `curl` into a temp dir that prints `HTTP/1.1 200 OK\r\ndocker-content-digest: sha256:aa\r\n`, prepends that dir to `PATH`, runs `sh -c "$MANIFEST_DIGEST_SH; digest h r t"` with `spawnSync`, and expects stdout `sha256:aa\n`. A stub that exits 22 (curl's 404) gives empty stdout and exit 0.
- [ ] **Step 2:** Run `pnpm vitest run tests/unit/deploy/k8s-image-delivery.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement the five exports in `image-delivery.js`. `MANIFEST_DIGEST_SH` is:
  `digest() { curl -fsSI -H "Accept: <MANIFEST_ACCEPT>" "http://$1/v2/$2/manifests/$3" 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}'; }`
  A 404 prints nothing; the callers decide what an empty digest means.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit with `feat(k8s-ha): image-delivery plan and local-registry ref helpers`.

### Task 2: Ephemeral `registry-relay` Pod on the primary database node

Status: **reshaped** (see Refresh). The relay is no longer applied by the transport. It is a bare Pod that lives only for the copy, applied after `wg0` is up and waited `Ready`. It is still a separate Pod, never a second container in `repl-gateway`: a spec change to that Deployment would roll the replication relay.

**Files:**
- Create: `carbon/k8s/base/repl-gateway/registry-relay.yaml`. It is a bare Pod named `registry-relay`, labelled `app: registry-relay`, in `vibecarbon`.
  - It copies the `repl-gateway` pod spec: `hostNetwork: true`, `dnsPolicy: ClusterFirstWithHostNet`, `nodeSelector: dedicated: db`, the `dedicated=db:NoSchedule` toleration, the resources, and the full `alpine/socat:1.8.1.3@sha256:fb3862c949af7c79996d0e514ee96128644d840835ed5368eeecb14a869de361` image with `IfNotPresent`. The `image-digest-census` sweeps `carbon/k8s` and requires the full digest.
  - `restartPolicy: Never`: a relay that dies mid-copy fails the copy loudly instead of coming back.
  - args: `"__RELAY_LISTEN__"` and `"__RELAY_TARGET__"`.
  - The header comment says why it exists (the standby image copy over `wg0`), that it is applied and deleted per copy by `withRegistryRelay`, and that it is NOT in any kustomization.
  - `repl-gateway/kustomization.yaml` keeps listing only `repl-gateway.yaml`.
- Modify: `src/lib/deploy/wireguard.js`. Add `export const REGISTRY_RELAY_PORT = 15000;` after `REPL_GATEWAY_PORT` (`:47`), with a comment that it is the standby image copy's relay port, bound only on `wg0`.
- Modify: `src/lib/deploy/k8s/ha/index.js` (it is R11-exempt, so it may name `WG_PRIMARY_IP`/`WG_STANDBY_IP`).
  - `export const REGISTRY_RELAY_SOURCE_HOST = \`${WG_PRIMARY_IP}:${REGISTRY_RELAY_PORT}\``. k8s-ha addresses wg0 by ROLE: `exchangeAndBringUpTunnel` is always called with the role primary's db node first (`:221-225`), so the role primary is always `10.99.0.1`.
  - `export function renderRegistryRelayManifest({ template, primaryMasterPrivateIp })`. It throws `renderRegistryRelayManifest: primaryMasterPrivateIp is required` when the IP is empty. It substitutes:
    - `__RELAY_LISTEN__` → `TCP-LISTEN:${REGISTRY_RELAY_PORT},bind=${WG_PRIMARY_IP},fork,reuseaddr,range=${WG_STANDBY_IP}/32`
    - `__RELAY_TARGET__` → `TCP:${primaryMasterPrivateIp}:5000`
  - `export async function withRegistryRelay({ primaryIp, standbyIp, primaryMasterPrivateIp, sshKeyPath, run? }, fn)`:
    1. On the standby master, `kubectl delete pod registry-relay -n vibecarbon --ignore-not-found`. That clears a relay left over from before a role swap.
    2. On the primary master, `kubectl delete pod registry-relay -n vibecarbon --ignore-not-found && kubectl apply -f -` with the rendered manifest on stdin. A bare Pod's spec is immutable, and the delete waits for the old pod, which frees the port.
    3. `kubectl wait --for=condition=Ready pod/registry-relay -n vibecarbon --timeout=60s`. A failure rejects with `registry relay not ready on the primary: <first stderr line>`.
    4. `return await fn()`, then in `finally` delete the relay on the primary master (`--ignore-not-found`, `--wait=false`). A failed delete is logged with `[image-copy]` and does not mask `fn`'s result: the next copy's step 2 deletes it anyway.
    - `run` defaults to `(ip, script, input) => sshRun(ip, sshKeyPath, ['sh', '-c', script], { input, timeout: 120_000 })`.
- Modify: `src/lib/deploy/k8s/k3s.js`. The `deployK3s` return object (`:5280-5292`) adds `masterPrivateIp`, which is already in scope from `infraOutputs`. `onInfraReady` is unchanged.
- Test: `tests/unit/deploy/k8s-ha-registry-relay.test.ts`.

**Interfaces:**
- Consumes: `WG_PRIMARY_IP`, `WG_STANDBY_IP`, `REGISTRY_RELAY_PORT`, `sshRun`.
- Produces: `REGISTRY_RELAY_SOURCE_HOST`, `renderRegistryRelayManifest(...)`, `withRegistryRelay(...)`; `deployK3s(...)` resolves with `masterPrivateIp`.

- [ ] **Step 1: Write the failing tests**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REGISTRY_RELAY_SOURCE_HOST,
  renderRegistryRelayManifest,
  withRegistryRelay,
} from '../../../src/lib/deploy/k8s/ha/index.js';

const ROOT = join(__dirname, '../../..');
const TEMPLATE = readFileSync(join(ROOT, 'carbon/k8s/base/repl-gateway/registry-relay.yaml'), 'utf-8');

describe('registry relay manifest', () => {
  it('binds the tunnel IP, admits only the standby, targets the primary registry', () => {
    const out = renderRegistryRelayManifest({ template: TEMPLATE, primaryMasterPrivateIp: '10.0.1.1' });
    expect(out).toContain('TCP-LISTEN:15000,bind=10.99.0.1,fork,reuseaddr,range=10.99.0.2/32');
    expect(out).toContain('TCP:10.0.1.1:5000');
    expect(out).toContain('restartPolicy: Never');
    expect(out).not.toMatch(/__[A-Z_]+__/);
    expect(REGISTRY_RELAY_SOURCE_HOST).toBe('10.99.0.1:15000');
  });
  it('refuses an empty primary master IP', () => {
    expect(() => renderRegistryRelayManifest({ template: TEMPLATE, primaryMasterPrivateIp: '' })).toThrow(
      /primaryMasterPrivateIp is required/,
    );
  });
  it('is in no kustomization', () => {
    for (const k of ['carbon/k8s/base/kustomization.yaml', 'carbon/k8s/base/repl-gateway/kustomization.yaml']) {
      expect(readFileSync(join(ROOT, k), 'utf-8')).not.toContain('registry-relay');
    }
  });
});

describe('withRegistryRelay', () => {
  const args = { primaryIp: 'P', standbyIp: 'S', primaryMasterPrivateIp: '10.0.1.1', sshKeyPath: '/k' };
  it('clears the standby, applies on the primary, waits Ready, runs fn, deletes after', async () => {
    const calls: Array<[string, string, string | undefined]> = [];
    const run = async (ip: string, script: string, input?: string) => {
      calls.push([ip, script, input]);
      return '';
    };
    const order: string[] = [];
    const result = await withRegistryRelay({ ...args, run }, async () => {
      order.push(`fn after ${calls.length} calls`);
      return 'done';
    });
    expect(result).toBe('done');
    expect(calls[0]).toEqual(['S', 'kubectl delete pod registry-relay -n vibecarbon --ignore-not-found', undefined]);
    expect(calls[1][0]).toBe('P');
    expect(calls[1][1]).toMatch(/delete pod registry-relay .*&& kubectl apply -f -/);
    expect(calls[1][2]).toContain('name: registry-relay');
    expect(calls[2]).toEqual([
      'P',
      'kubectl wait --for=condition=Ready pod/registry-relay -n vibecarbon --timeout=60s',
      undefined,
    ]);
    expect(order).toEqual(['fn after 3 calls']);
    expect(calls[3][0]).toBe('P');
    expect(calls[3][1]).toMatch(/delete pod registry-relay .*--ignore-not-found/);
  });
  it('a relay that never gets Ready fails with one line, fn never runs, and the relay is still deleted', async () => {
    const calls: string[] = [];
    const run = async (ip: string, script: string) => {
      calls.push(`${ip} ${script}`);
      if (script.startsWith('kubectl wait')) {
        throw Object.assign(new Error('Command failed: ssh ...'), {
          stderr: 'error: timed out waiting for the condition on pods/registry-relay\n',
        });
      }
      return '';
    };
    let ran = false;
    await expect(
      withRegistryRelay({ ...args, run }, async () => {
        ran = true;
      }),
    ).rejects.toThrow(
      /^registry relay not ready on the primary: error: timed out waiting for the condition on pods\/registry-relay$/,
    );
    expect(ran).toBe(false);
    expect(calls.at(-1)).toMatch(/^P kubectl delete pod registry-relay/);
  });
  it('a missing primary master IP rejects before any remote call', async () => {
    const calls: string[] = [];
    await expect(
      withRegistryRelay(
        {
          ...args,
          primaryMasterPrivateIp: '',
          run: async (ip: string) => {
            calls.push(ip);
            return '';
          },
        },
        async () => {},
      ),
    ).rejects.toThrow(/primaryMasterPrivateIp is required/);
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 2:** Run `pnpm vitest run tests/unit/deploy/k8s-ha-registry-relay.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the manifest, the constant, the three `ha/index.js` exports and the `deployK3s` return field.
- [ ] **Step 4:** Run the same command, plus `pnpm vitest run tests/unit/deploy/compose-ha-primary-address-census.test.ts tests/unit/deploy/image-digest-census.test.ts tests/unit/deploy/hostport-binding-census.test.ts tests/unit/deploy/flux-base-placeholder-census.test.ts tests/unit/deploy/k8s-ha-repl-gateway.test.ts tests/unit/deploy/repl-gateway-kind.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit with `feat(k8s-ha): a per-copy registry relay on the primary database node, wg0-only`.

### Task 3: `copyAppImageToStandby`

Status: **partly done in design, updated.** The relay lifecycle now comes from Task 2's `withRegistryRelay`, ssh goes through `sshRun`, the cause is parsed from `err.stderr`, and the digest helper is Task 1's.

**Files:**
- Create: `src/lib/deploy/k8s/ha/image-copy.js`
- Test: `tests/unit/deploy/k8s-ha-image-copy.test.ts`

**Interfaces:**
- Consumes:
  - `parseLocalRegistryRef`, `standbyImageRef`, `MANIFEST_DIGEST_SH` (Task 1);
  - `REGISTRY_RELAY_SOURCE_HOST`, `withRegistryRelay` (Task 2);
  - `sshRun` (`src/lib/ssh.js`), `progressLog` (`src/lib/cli/progress.js`).
- Produces:
  - `buildImageCopyScript({ srcRef: string, dstRef: string }) -> string`, a POSIX `sh` script run on the standby db node.
  - `firstCauseLine(err) -> string`: the one-line cause from a rejected `sshRun`. It is the `ERR=` payload if present, else the first non-empty `err.stderr` line that is not an ssh `Warning:`, else `err.message`'s first line. Task 6 reuses it.
  - `copyAppImageToStandby({ primaryRef, primaryIp, standbyIp, primaryMasterPrivateIp, standbyMasterPrivateIp, standbyDbIp, sshKeyPath, run?, relay? }) -> Promise<{ digest: string, skipped: boolean }>`.
    - `srcRef` is `${REGISTRY_RELAY_SOURCE_HOST}/<repoTag>`.
    - `dstRef` is `standbyImageRef(...)`.
    - `run` is a test seam that defaults to `sshRun(standbyDbIp, sshKeyPath, ['sh', '-s'], { input: script, timeout: 600_000 })`.
    - `relay` is a test seam that defaults to `withRegistryRelay` with `{ primaryIp, standbyIp, primaryMasterPrivateIp, sshKeyPath }`.
    - A relay failure maps to `standby image copy failed: registry relay not ready on the primary: ...`.

The script, in order (`set -eu`), prints the machine-readable lines `SRC_DIGEST=`, `DST_DIGEST=`, `SKIPPED=1` or `COPIED=1`:
1. `MANIFEST_DIGEST_SH` (the `digest()` helper).
2. Read the source digest. If it is empty, `echo "ERR=primary registry has no <repoTag>" >&2; exit 3`.
3. Read the destination digest (empty is allowed). If it equals the source, print `SKIPPED=1` and exit 0.
4. `trap 'k3s ctr -n vibecarbon-imgcopy images rm "$SRC" >/dev/null 2>&1 || true' EXIT`. Then run the pull and push from Global Constraints.
5. Re-read the destination digest. If it differs from the source, `echo "ERR=digest mismatch: primary $S, standby $D" >&2; exit 4`. Otherwise print `COPIED=1`.

Note: on a skip the relay was still applied, because the source digest is read through it. That costs about 5 s and keeps one code path.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { MANIFEST_ACCEPT } from '../../../src/lib/deploy/k8s/image-delivery.js';
import { buildImageCopyScript, copyAppImageToStandby } from '../../../src/lib/deploy/k8s/ha/image-copy.js';

const base = {
  primaryRef: '10.0.1.1:5000/quorum:t1',
  primaryIp: 'P',
  standbyIp: 'S',
  primaryMasterPrivateIp: '10.0.1.1',
  standbyMasterPrivateIp: '10.0.1.1',
  standbyDbIp: 'SDB',
  sshKeyPath: '/k',
  relay: async (_a: unknown, fn: () => Promise<unknown>) => fn(),
};
const stderrErr = (stderr: string) => Object.assign(new Error('Command failed: ssh -i /k root@SDB sh -s'), { stderr });

describe('buildImageCopyScript', () => {
  const s = buildImageCopyScript({ srcRef: '10.99.0.1:15000/quorum:t1', dstRef: '10.0.1.1:5000/quorum:t1' });
  it('pulls through the relay and pushes remote-first, in the copy namespace only', () => {
    expect(s).toContain('images pull --plain-http --all-platforms 10.99.0.1:15000/quorum:t1');
    expect(s).toContain('images push --plain-http 10.0.1.1:5000/quorum:t1 10.99.0.1:15000/quorum:t1');
    expect(s).toContain('-n vibecarbon-imgcopy');
    expect(s).not.toContain('-n k8s.io');
    expect(s).toMatch(/trap '.*images rm/);
    expect(s).toContain(MANIFEST_ACCEPT);
    expect(s.indexOf('SKIPPED=1')).toBeLessThan(s.indexOf('images pull'));
  });
});

describe('copyAppImageToStandby', () => {
  it('skips on equal digests without pulling', async () => {
    const run = vi.fn(async () => 'SRC_DIGEST=sha256:aa\nDST_DIGEST=sha256:aa\nSKIPPED=1');
    await expect(copyAppImageToStandby({ ...base, run })).resolves.toEqual({ digest: 'sha256:aa', skipped: true });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('reports a copy', async () => {
    const run = vi.fn(async () => 'SRC_DIGEST=sha256:aa\nDST_DIGEST=\nCOPIED=1');
    await expect(copyAppImageToStandby({ ...base, run })).resolves.toEqual({ digest: 'sha256:aa', skipped: false });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('a digest mismatch fails with exactly one line', async () => {
    const run = vi.fn(async () => {
      throw stderrErr('ERR=digest mismatch: primary sha256:aa, standby sha256:bb\nmore\n');
    });
    const err = await copyAppImageToStandby({ ...base, run }).catch((e) => e);
    expect(err.message).toBe('standby image copy failed: digest mismatch: primary sha256:aa, standby sha256:bb');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('any other failure reports the first real stderr line, never the ssh argv', async () => {
    const run = vi.fn(async () => {
      throw stderrErr("Warning: Permanently added 'SDB'\n\nctr: failed to resolve reference\nsecond\n");
    });
    const err = await copyAppImageToStandby({ ...base, run }).catch((e) => e);
    expect(err.message).toBe('standby image copy failed: ctr: failed to resolve reference');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('a relay failure is the copy failure', async () => {
    const run = vi.fn();
    const relay = async () => {
      throw new Error('registry relay not ready on the primary: timed out');
    };
    await expect(copyAppImageToStandby({ ...base, run, relay })).rejects.toThrow(
      /^standby image copy failed: registry relay not ready on the primary: timed out$/,
    );
    expect(run).not.toHaveBeenCalled();
  });
  it('runs the script on the standby DB node against the standby master registry', async () => {
    let seen = '';
    const run = vi.fn(async (script: string) => {
      seen = script;
      return 'SRC_DIGEST=sha256:aa\nDST_DIGEST=sha256:aa\nSKIPPED=1';
    });
    await copyAppImageToStandby({ ...base, standbyMasterPrivateIp: '10.120.0.3', run });
    expect(seen).toContain('10.120.0.3:5000/quorum:t1');
    expect(seen).toContain('10.99.0.1:15000/quorum:t1');
  });
});
```

  Plus `describe('the copy script runs')`, which executes `buildImageCopyScript(...)` under `sh` with stub `curl` and `k3s` scripts on `PATH` (each appends its argv to a log file) and checks three things:
  - Equal digests: exit 0, stdout has `SKIPPED=1`, and the log has no `k3s` line.
  - The destination digest differs after the push: exit 4, stderr's first line is `ERR=digest mismatch: primary sha256:aa, standby sha256:bb`, and the log's last `k3s` line is `ctr -n vibecarbon-imgcopy images rm 10.99.0.1:15000/quorum:t1` (the trap ran).
  - An empty source digest: exit 3 with `ERR=primary registry has no quorum:t1`.
- [ ] **Step 2:** Run `pnpm vitest run tests/unit/deploy/k8s-ha-image-copy.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. `progressLog` emits `[image-copy] standby already has <digest>` on a skip and `[image-copy] copied <repoTag> (<digest>)` on a copy. The `run` seam receives the script as its first argument.
- [ ] **Step 4:** Run the same command, plus `pnpm vitest run tests/unit/deploy/raw-ssh-opts-census.test.ts tests/unit/deploy/compose-ha-primary-address-census.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit with `feat(k8s-ha): copy the app image primary → standby registry over wg0`.

### Task 4: The standby `deployK3s` stops building, sideloading and pushing

Status: **reshaped** (see Refresh): an extracted, injectable `deliverAppImage`, a role-derived push in `applyK3sManifests`, the patch-based image assertion, and `localTunnelPort` removed.

**Files:**
- Modify: `src/lib/deploy/k8s/k3s.js`.
  - Extract the build + sideload block (`:5076-5133`) into `export async function deliverAppImage({ role, peerImageRef, onImageBuilt, state, buildInputs, projectDir, projectName, domain, masterPrivateIp, sshTargets, privateKeyPath, khPath, perfPrefix, spinner, deps = {} })`, which returns `imageTag`. Inside it, `const d = { buildAppImage, sideloadK3s, ...deps }`, and the calls are spelled `d.buildAppImage(...)` / `d.sideloadK3s(...)`, never through a renamed local, so the Task 7 census sees them. `deployK3s` calls it.
    - `const plan = planImageDelivery({ role })`.
    - When `plan.awaitPeerImage`: with no `peerImageRef`, throw `deployK3s: role standby requires peerImageRef`. Otherwise `imageTag = standbyImageRef({ primaryRef: await peerImageRef, standbyMasterPrivateIp: masterPrivateIp })`. Neither the `k3s-build` nor the `k3s-sideload` state step is touched.
    - When `plan.build`: the `k3s-build` gate exactly as today, then `onImageBuilt?.(imageTag)`, whether the gate built or skipped.
    - When `plan.sideload`: the `k3s-sideload` gate and the `deploy.${perfPrefix}.sideload.app` perf marker exactly as today.
  - `applyK3sManifests` (`:3393`): `const { registryPush } = planImageDelivery({ role })`. When it is false, keep the `localRegistry.wait` (`:4095-4111`) and skip the `pushImageToLocalRegistry` block (`:4113-4170`) and its await (`:4752`). The `masterIp`/`sshKeyPath`/`khPath` guards (`:4119-4127`) apply only when pushing.
  - Delete the `localTunnelPort` parameter and its comment (`:3444-3449`). `pushImageToLocalRegistry` keeps its own default of 5000, and its port walk handles cross-process collisions. Delete the `localTunnelPort` pass-through in `deployK3s` (`:5211-5214`).
  - Update the comments that described the HA two-push contention: `:4144-4150` (one push per deploy in HA now), the `buildAppImage` doc block (`:1436-1459`: the standby receives the tag from the primary's registry), and the step-7b comment (`:5107-5113`).
- Modify: `tests/unit/deploy/k3s-apply-manifests-ordering.test.ts` (drop `localTunnelPort: 5000` from `baseArgs`, `:384`) and `tests/unit/deploy/k8s-deploy-restore.test.ts` (`:443`).
- Test: `tests/unit/deploy/k3s-standby-image-delivery.test.ts` (new; `deliverAppImage` with fake deps and a real `StateTracker` under a `process.cwd` spy, the `k3s-build-gate-inputs.test.ts:184-196` pattern; restore the spy in `afterEach`), and two new cases in `tests/unit/deploy/k3s-apply-manifests-ordering.test.ts` (spawn-mock harness).

**Interfaces:**
- Consumes: `planImageDelivery`, `standbyImageRef` (Task 1).
- Produces:
  - `deliverAppImage(...) -> Promise<string>`;
  - `deployK3s` options `peerImageRef?: Promise<string>` and `onImageBuilt?: (ref: string) => void`.
  - The `applyK3sManifests` signature loses `localTunnelPort` and gains nothing.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/deploy/k3s-standby-image-delivery.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliverAppImage } from '../../../src/lib/deploy/k8s/k3s.js';
import { StateTracker } from '../../../src/lib/deploy/state.js';

function harness(role?: 'primary' | 'standby', extra: Record<string, unknown> = {}) {
  // StateTracker writes under process.cwd()/.vibecarbon (state.js:26).
  vi.spyOn(process, 'cwd').mockReturnValue(mkdtempSync(join(tmpdir(), 'vc-deliver-')));
  const buildAppImage = vi.fn(async () => ({ tag: '10.0.1.1:5000/quorum:built', gitSha: 'abc', isDirty: false }));
  const sideloadK3s = vi.fn(async () => {});
  const onImageBuilt = vi.fn();
  const args = {
    role,
    onImageBuilt,
    state: new StateTracker('quorum', `e4-${role ?? 'single'}`),
    buildInputs: { projectName: 'quorum', masterPrivateIp: '10.0.1.1', sourceDigest: 'd', buildArgsDigest: 'b' },
    projectDir: '/p',
    projectName: 'quorum',
    masterPrivateIp: '10.0.1.1',
    sshTargets: ['root@m', 'root@d'],
    privateKeyPath: '/k',
    khPath: '/kh',
    perfPrefix: `k3s.${role ?? 'x'}`,
    spinner: { start() {}, stop() {} },
    deps: { buildAppImage, sideloadK3s },
    ...extra,
  };
  return { args, buildAppImage, sideloadK3s, onImageBuilt };
}

describe('deliverAppImage', () => {
  afterEach(() => vi.restoreAllMocks());
  it('standby: no build, no sideload, the peer ref re-prefixed', async () => {
    const h = harness('standby', {
      masterPrivateIp: '10.120.0.3',
      peerImageRef: Promise.resolve('10.110.0.2:5000/quorum:t1'),
    });
    await expect(deliverAppImage(h.args)).resolves.toBe('10.120.0.3:5000/quorum:t1');
    expect(h.buildAppImage).not.toHaveBeenCalled();
    expect(h.sideloadK3s).not.toHaveBeenCalled();
    expect(h.onImageBuilt).not.toHaveBeenCalled();
  });
  it('standby: a failed primary rejects with its message, nothing built', async () => {
    const h = harness('standby', {
      peerImageRef: Promise.reject(new Error('primary image unavailable: primary deploy failed')),
    });
    await expect(deliverAppImage(h.args)).rejects.toThrow('primary image unavailable: primary deploy failed');
    expect(h.buildAppImage).not.toHaveBeenCalled();
  });
  it('standby without peerImageRef is a programming error', async () => {
    const h = harness('standby');
    await expect(deliverAppImage(h.args)).rejects.toThrow('deployK3s: role standby requires peerImageRef');
  });
  it('primary: build, sideload, onImageBuilt once with the built tag; a warm rerun still reports the tag', async () => {
    const h = harness('primary');
    await expect(deliverAppImage(h.args)).resolves.toBe('10.0.1.1:5000/quorum:built');
    expect(h.sideloadK3s).toHaveBeenCalledTimes(1);
    expect(h.onImageBuilt).toHaveBeenCalledExactlyOnceWith('10.0.1.1:5000/quorum:built');
    h.onImageBuilt.mockClear();
    await deliverAppImage(h.args); // same state: the k3s-build gate skips
    expect(h.buildAppImage).toHaveBeenCalledTimes(1);
    expect(h.onImageBuilt).toHaveBeenCalledExactlyOnceWith('10.0.1.1:5000/quorum:built');
  });
  it('single k8s (no role): same calls as primary, onImageBuilt optional', async () => {
    const h = harness(undefined, { onImageBuilt: undefined });
    await expect(deliverAppImage(h.args)).resolves.toBe('10.0.1.1:5000/quorum:built');
    expect(h.buildAppImage).toHaveBeenCalledTimes(1);
    expect(h.sideloadK3s).toHaveBeenCalledTimes(1);
  });
});
```

In `k3s-apply-manifests-ordering.test.ts`, add:
  - `role: 'standby'`: no spawned `docker push` and no `ssh ... -L` tunnel; the `wait --for=condition=Ready pod -l app=local-registry` is still issued; the `patch deployment/app` stdin JSON sets `containers[0].image` and `initContainers[0].image` to `imageTag`.
  - `role: 'primary'`: the `docker push` is spawned exactly as before (the existing concurrency test stays the guard).
- [ ] **Step 2:** Run `pnpm vitest run tests/unit/deploy/k3s-standby-image-delivery.test.ts tests/unit/deploy/k3s-apply-manifests-ordering.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the changes above.
- [ ] **Step 4:** Run the same command, plus `pnpm vitest run tests/unit/deploy/`. Expected: PASS.
- [ ] **Step 5:** Commit with `feat(k8s-ha): pilot-light standby takes its image from the primary, not the operator`. Until Task 5 lands, a real k8s-ha standby deploy refuses with `role standby requires peerImageRef`. Unit tests mock `deployK3s` in the effects, and no real infra runs between tasks; say so in the commit body.

### Task 5: Wire the copy into the k8s-ha deploy

Status: **reshaped** (see Refresh): a plan step plus an early start, the relay arguments from Task 2, and the `localTunnelPort` lines removed.

**Files:**
- Modify: `src/lib/deploy/effects/k8s-ha.js`.
  - In `haK8sProvisionClusters` (`:107`): create `primaryImage`, a rejectable deferred. The existing `deferInfra` (`:206-213`) only resolves, so add a sibling `deferValue()` with `{ promise, resolve, reject }` and attach `promise.catch(() => {})` once at creation. Pass `onImageBuilt: primaryImage.resolve` to the primary `deployK3s` and `peerImageRef: primaryImage.promise` to the standby.
  - Extend the `primaryPromise.then(...)` settlement (`:281-284`) so a rejection also calls `primaryImage.reject(new Error('primary image unavailable: primary deploy failed'))`. A resolve after `onImageBuilt` is a no-op.
  - Delete `localTunnelPort: 5000` (`:231`), `localTunnelPort: 5001` (`:265`) and the port comment (`:191-197`).
  - After `ctx.transportPrepared = await earlyPrep` (`:450`): when it is true, set `ctx.standbyImageCopy = startStandbyImageCopy(ctx)` and attach `.catch(() => {})`.
  - New effect `haK8sCopyStandbyImage(ctx)`: `await (ctx.standbyImageCopy ?? startStandbyImageCopy(ctx))`, and record `ctx.standbyImageDigest`. A rejection propagates and fails the deploy.
  - `startStandbyImageCopy(ctx)` is `perfAsync('deploy.ha.image.copyToStandby', () => copyAppImageToStandby({ primaryRef: ctx.primaryResult.imageTag, primaryIp: ctx.primaryResult.masterIp, standbyIp: ctx.standbyResult.masterIp, primaryMasterPrivateIp: ctx.primaryResult.masterPrivateIp, standbyMasterPrivateIp: ctx.standbyResult.masterPrivateIp, standbyDbIp: ctx.standbyResult.dbIp, sshKeyPath: ctx.sharedSshKeyPath }))`. `ctx.primaryResult` and `ctx.standbyResult` are already role-mapped (`:124-127`), so a reconverge copies new primary → new standby.
  - Add `haK8sCopyStandbyImage` to `K8S_HA_EFFECTS` and to the ctx contract header (`standbyImageCopy`, `standbyImageDigest`).
- Modify: `src/lib/deploy/plan/steps.js`. Add `haK8sCopyStandbyImageStep = () => defineStep({ name: 'copy-standby-image', effect: 'haK8sCopyStandbyImage', required: true })`.
- Modify: `src/lib/deploy/plan/deploy-plan.js` (`:136-145`). Insert it after `haK8sVerifyStreamingStep()`.
- Modify: `tests/unit/deploy/plan/deploy-plan.test.ts`: `EXPECTED_K8S_HA_SEQUENCE` (`:164`) and the stub-effects map (`:248`), now 9 effects.
- Modify the module mocks so no test reaches the real copy: `tests/unit/deploy/k8s-ha-fanout-roles.test.ts` and `tests/unit/deploy/ha-system-identifier-record.test.ts` each add `vi.mock('../../../src/lib/deploy/k8s/ha/image-copy.js', () => ({ copyAppImageToStandby: vi.fn(async () => ({ digest: 'sha256:aa', skipped: true })) }))`.
- Test: `tests/unit/deploy/k8s-ha-image-copy-wiring.test.ts` (new; the `k8s-ha-fanout-roles.test.ts` mock pattern, with call order recorded).

**Interfaces:**
- Consumes: `copyAppImageToStandby` (Task 3); the `deployK3s` options and the `masterPrivateIp` field (Tasks 2 and 4).
- Produces:
  - the plan step `copy-standby-image` (required), after `verify-streaming`;
  - the ordering invariant: the copy starts only when `ctx.transportPrepared === true` (inside `provision-clusters`) or in `copy-standby-image`. It is awaited before `update-dns` and `finalize`.

- [ ] **Step 1: Write the failing tests** (mocked `deployK3s`, `prepareReplicationTransport`, `configurePrimaryForReplication`, `setupReplication`, `copyAppImageToStandby`; the call order is recorded):
  - **earlyPrep succeeds:** after `haK8sProvisionClusters`, the copy has been invoked once, after `prepareReplicationTransport` resolved, with `primaryRef` equal to the primary result's `imageTag`. `haK8sCopyStandbyImage` then awaits that same promise and does not call the copy a second time.
  - **earlyPrep rejects** (`prepareReplicationTransport` throws): `haK8sProvisionClusters` does not call the copy, and `haK8sCopyStandbyImage` calls it once.
  - **The copy rejects** with `standby image copy failed: x`: `haK8sCopyStandbyImage` rejects with exactly that message, in both the early-start and late-start cases. In the early case no unhandled rejection is reported: the test asserts `process.on('unhandledRejection')` saw nothing.
  - **Primary `deployK3s` rejects:** the standby's `peerImageRef` rejects with `primary image unavailable: primary deploy failed`, `haK8sProvisionClusters` rejects with the existing `HA deploy failed — primary: ...`, and the copy is not called.
  - **Role swap (reconverge):** with `haStacks` swapped (the existing fixture in `k8s-ha-fanout-roles.test.ts:127`), the copy receives `primaryIp` and `primaryMasterPrivateIp` from the cluster deployed with `role: 'primary'`, and `standbyDbIp` from the one deployed with `role: 'standby'`.
  - **Plan:** `planStepNames(planDeploy('k8s-ha', {}))` has `copy-standby-image` right after `verify-streaming`, and the step is `required`.
- [ ] **Step 2:** Run `pnpm vitest run tests/unit/deploy/k8s-ha-image-copy-wiring.test.ts tests/unit/deploy/plan/deploy-plan.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the wiring.
- [ ] **Step 4:** Run the same command, plus `pnpm vitest run tests/unit/deploy/k8s-ha-*.test.ts tests/unit/deploy/ha-system-identifier-record.test.ts tests/unit/deploy/plan/`. Expected: PASS.
- [ ] **Step 5:** Commit with `feat(k8s-ha): copy the image to the standby once replication transport is up`.

### Task 6: Failover preflight refuses a standby without the app image

Status: **reshaped**: re-placed in `failoverHA`, skipped on resume, `sshRun` instead of a hand-built ssh, Task 1's digest helper, and nine existing test files given the seam.

**Files:**
- Modify: `src/lib/deploy/k8s/ha/image-copy.js`. Add `assertStandbyHasAppImage({ standbyIp, sshKeyPath, run? }) -> Promise<string>`.
  - One remote script over `sshRun(standbyIp, sshKeyPath, ['sh', '-s'], { input })` on the standby master:
    - prints `IMAGE=$(kubectl -n vibecarbon get deployment app -o jsonpath='{.spec.template.spec.containers[0].image}')`;
    - when that is a local-registry ref (`*:5000/*`), splits it and prints `DIGEST=$(digest ...)` using `MANIFEST_DIGEST_SH`.
  - The JS side parses `IMAGE=`/`DIGEST=` with `parseLocalRegistryRef` and returns the digest. A non-local ref (ghcr, CI push mode) returns `'external'`.
  - A missing digest throws `standby registry lacks the app image <ref>; redeploy (vibecarbon deploy) while the primary is up`.
  - An ssh or kubectl failure throws `could not read the standby app image: <first stderr line>`, through the same stderr parse as Task 3 (`firstCauseLine`).
- Modify: `src/failover.js`.
  - Add the seam `assertStandbyImage = async (srv, key) => (await import('./lib/deploy/k8s/ha/image-copy.js')).assertStandbyHasAppImage({ standbyIp: srv.standby.ip, sshKeyPath: key })` to the `deps` destructure (`:1711-1767`). The import is dynamic, as in `prePullStandbyImages` (`:917-926`): `failover.js` imports no k8s deploy module statically, and this keeps it that way.
  - Call it right after `preflight(...)` and the `freshDbPrivateIp` refresh (`:1825-1842`), before `isPrimaryReady`/`liftStranded` (`:1849-1862`), only when `!envConfig?.ha?.failoverInFlight`.
  - On a refusal, `p.log.error(err.message)` and `process.exit(1)`, the preflight's own refusal style, so nothing has been mutated.
  - Add a step `1a. standby app image present (refuse = nothing touched)` to the order comment (`:1683-1697`).
- Modify (inject `assertStandbyImage: async () => 'sha256:aa'` wherever `failoverHA` is driven, so no test reaches ssh):
  - `tests/unit/failover/pilot-flow.test.ts`
  - `tests/unit/failover/failover-state-matrix.test.ts`
  - `tests/unit/failover/failover-step-order-census.test.ts`
  - `tests/unit/failover/walg-role-demotion-independent.test.ts`
  - `tests/unit/failover/classify-failover.test.ts`
  - `tests/unit/failover/reseed-standby.test.ts`
  - `tests/unit/deploy/retired-fence-entrypoints-census.test.ts`
  - `tests/unit/deploy/backup-fence.test.ts`
  - `tests/unit/walg/post-promote-backup-census.test.ts`
  - Where a file builds its deps in one helper, add it there once.
- Test: `tests/unit/failover/standby-image-precheck.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { assertStandbyHasAppImage } from '../../../src/lib/deploy/k8s/ha/image-copy.js';

describe('assertStandbyHasAppImage', () => {
  it('returns the digest of a local-registry image', async () => {
    const run = vi.fn(async () => 'IMAGE=10.0.1.1:5000/quorum:t1\nDIGEST=sha256:aa');
    await expect(assertStandbyHasAppImage({ standbyIp: 'S', sshKeyPath: '/k', run })).resolves.toBe('sha256:aa');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('refuses when the registry lacks it, naming the ref', async () => {
    const run = vi.fn(async () => 'IMAGE=10.0.1.1:5000/quorum:t1\nDIGEST=');
    await expect(assertStandbyHasAppImage({ standbyIp: 'S', sshKeyPath: '/k', run })).rejects.toThrow(
      'standby registry lacks the app image 10.0.1.1:5000/quorum:t1; redeploy (vibecarbon deploy) while the primary is up',
    );
  });
  it('an external image needs no registry', async () => {
    const run = vi.fn(async () => 'IMAGE=ghcr.io/o/r:main');
    await expect(assertStandbyHasAppImage({ standbyIp: 'S', sshKeyPath: '/k', run })).resolves.toBe('external');
  });
  it('an unreadable deployment is its own one-line failure', async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error('Command failed: ssh'), {
        stderr: 'Error from server (NotFound): deployments.apps "app" not found\n',
      });
    });
    await expect(assertStandbyHasAppImage({ standbyIp: 'S', sshKeyPath: '/k', run })).rejects.toThrow(
      /^could not read the standby app image: Error from server \(NotFound\)/,
    );
  });
});
```

  Plus, in the same file, `failoverHA` driven with the `pilot-flow.test.ts` deps fixture:
  - `assertStandbyImage` rejecting: `process.exit(1)` (mocked to throw) fires, and `isPrimaryReady`, `liftStranded`, `provision`, `confirmQuiesced`, `scale` and `promote` are never called.
  - With `envConfig.ha.failoverInFlight` set, `assertStandbyImage` is not called and the run proceeds to the resume path.
- [ ] **Step 2:** Run `pnpm vitest run tests/unit/failover/standby-image-precheck.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement, and inject the seam in the nine files above.
- [ ] **Step 4:** Run the same command, plus `pnpm vitest run tests/unit/failover/ tests/unit/deploy/retired-fence-entrypoints-census.test.ts tests/unit/deploy/backup-fence.test.ts tests/unit/walg/post-promote-backup-census.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit with `feat(failover): refuse a pilot-light failover when the standby registry lacks the app image`.

### Task 7: Image-delivery census and docs

Status: **partly updated**: the call-site table follows Task 4, the parse uses `parseAst`, and the `registry-push.js` note is corrected.

**Files:**
- Create: `tests/unit/deploy/k8s-image-delivery-census.test.ts`. It walks every `.js` file under `src/` (fs walk, not a hand list), parses each with vite's `parseAst` (as `compose-ha-primary-address-census.test.ts` does, so comments and doc blocks never count), and finds each `CallExpression` whose callee is the identifier `sideloadK3s`, `pushImageToLocalRegistry`, `pushImageOverSshTunnel`, `buildAppImage` or `copyAppImageToStandby`, or a member expression whose property is one of those names (`d.buildAppImage(`), on any object. Each is keyed by `file:enclosingFunctionName`.
  - It asserts the found set equals a classified table:
    - `k8s/k3s.js:deliverAppImage` for `buildAppImage` and `sideloadK3s` (as `deps.*`), gated by `planImageDelivery`;
    - `k8s/k3s.js:applyK3sManifests` for `pushImageToLocalRegistry`, gated by `planImageDelivery` (`registryPush`);
    - `k8s/k3s.js:pushImageToLocalRegistry` for `pushImageOverSshTunnel`;
    - `effects/index.js:<fn>` for `pushImageOverSshTunnel`, compose tier (`:204`);
    - `effects/k8s-ha.js:startStandbyImageCopy` for `copyAppImageToStandby`.
  - A new, unclassified call site fails with `unclassified image-delivery call site <file:fn>: decide whether a standby can reach it`.
  - It asserts that each gated `k3s.js` site's enclosing function body calls `planImageDelivery(`. That is an AST check on the same function node, not a regex over the file.
  - A positive control: the walk must find at least the five classified sites, so it can never pass vacuously.
- Modify:
  - `carbon/k8s/base/registry/local-registry.yaml` (the ROOT FIX comment, `:58-70`): "every deploy (each k8s-ha cluster separately …) builds and pushes its own image" becomes: the k8s-ha standby receives it from the primary's registry over wg0 (`registry-relay`), and a replaced master is refilled by the next deploy.
  - `src/lib/deploy/registry-push.js`: the header "Concurrency" paragraph (`:57-61`) and the "Uplink serialization" block (`:95-138`). A k8s-ha deploy now makes one tunnel push. The in-process mutex stays for compose-ha's two servers (`effects/index.js:204`). Cross-process siblings are covered by `uplink-lock.js`, not by "the retry ladder and the port walk".
  - `docs/deploy-hetzner.md`: the k8s-ha "Standby Architecture (Pilot-Light)" section (`:330`) gets one paragraph on image delivery: the operator uploads once, the standby copies over the tunnel, and the deploy fails if the copy does. The "Builds your app image locally and pushes it" step (`:148`) gets the same clause.
  - `docs/superpowers/plans/2026-10-20-cold-deploy-speed.md`, Task 5: one line noting that this census exists and that its table must follow `deliverImage` when that task lands.
  - The `e2e-perf-optimizer` notes are checked, and nothing there needs changing: `grep -rn "standby.sideload" .claude/agents` finds nothing on 2026-10-21. Re-run the grep, and edit only on a hit.
- [ ] **Step 1:** Write the census. Mutation-check it: temporarily add a `sideloadK3s(` call in a scratch function in `k3s.js`, and the test must fail naming that site. Temporarily remove the `planImageDelivery(` call from `applyK3sManifests`, and the test must fail. Revert both, and record the two failures in the task report.
- [ ] **Step 2:** Run `pnpm vitest run tests/unit/deploy/k8s-image-delivery-census.test.ts`. Expected: PASS.
- [ ] **Step 3:** Make the doc and comment edits.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test:unit`. Expected: all green.
- [ ] **Step 5:** Commit with `test(k8s-ha): census every image-delivery call site; docs for the standby copy`.

## Verification
- Every task: its vitest command green, plus `pnpm lint && pnpm typecheck`. End of branch: `pnpm test:unit && pnpm test:integration`, then `test.yml` dispatched green.
- Real infra is gated on Brandon's OK: `pnpm test:e2e:batch -- --scenario hetzner/k8s-ha`. Acceptance:
  - the CLI log has `deploy.ha.image.copyToStandby` and none of `deploy.k3s.standby.sideload.app` / `deploy.k3s.standby.registryPush.app`;
  - verify-failover and reconverge-deploy pass, so the promoted standby pulled from its own registry, and on reconverge the copy ran in the swapped direction;
  - `[image-copy]` shows `copied` on the cold deploy and `standby already has` on the warm redeploy;
  - record `deploy.k3s.primary.sideload.app`, `deploy.ha.k8s.standby` and `deploy.ha.k8s.full` against the 2026-10-20 baselines (primary sideload 612 s, standby arm 698 s, full). The primary arm was already the longer one, so the expected gain is the primary sideload no longer sharing the uplink. That number is recorded, not gated.
- A DO run (`--provider digitalocean`, d4) is the check that the per-cluster `masterPrivateIp` differs and the re-prefixed ref is right.

## Rulings and open risks
- **Ruling: the copy runs on the standby DATABASE node.** It is the only standby node on `wg0`, and it reaches the standby master's `:5000` over the private network, the same path its kubelet already pulls on. Routing `wg0` to the master would need new routes.
- **Ruling: use `k3s ctr`, not crane or skopeo.** It is already on every node, so no new image is pulled from gcr or quay, and none needs pinning. `ctr push` sends the pulled bytes unchanged, so digests are preserved, and `--all-platforms` carries any attestation manifests.
- **Ruling (2026-10-21): the relay is an ephemeral bare Pod owned by the copy.** It is applied after `wg0` is up, waited `Ready`, and deleted afterwards. It is not part of the transport and not a container in `repl-gateway` (whose Deployment would roll on a spec change).
- **Ruling (2026-10-21): the copy is a required plan step after `verify-streaming`.** It starts early only on a prepared transport. A replication failure therefore reports first, with its own message. Under `-allow-degraded` a copy failure still fails the deploy: a standby without its image cannot be promoted, and Task 6 would refuse its failover.
- **Ruling: the standby no longer sideloads to its own master and db nodes.** Its app tier is zero, and the pods that run there use ghcr or third-party images. Promotion pulls through the standby registry exactly as CA-spawned workers already do today.
- **Risk:** the registry has no auth. While the relay exists, the standby db node could also write to the primary registry. It is limited to one tunnel peer and to the copy window, and it is our own node. This is accepted; registry auth is a separate change.
- **Risk:** the standby db node briefly holds a second copy of the image's compressed layers (about 150–200 MB) in containerd content. The trap removes the image, and containerd GC reclaims the content afterwards. On the early-start path this overlaps the reseed on the same node; that much traffic is small next to a basebackup.
- **Risk:** if the process dies mid-copy, the relay Pod stays until the next copy deletes it (step 2 of `withRegistryRelay`). It admits only `10.99.0.2`.
- **Dependency:** `2026-10-20-cold-deploy-speed.md` Task 6 (delete the never-succeeding standby seed path) should land before or with this plan. Otherwise the standby's 345-360 s `awaitDb` is no longer hidden behind its push.
- **Out of scope** (noted for the parent): primary-cluster sideload still streams operator → every node. `2026-10-20-cold-deploy-speed.md` Task 5 owns moving it to a single registry delivery.
