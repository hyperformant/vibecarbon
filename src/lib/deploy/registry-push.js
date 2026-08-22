/**
 * Push a locally-built image to a loopback OCI registry via an SSH
 * local-port-forward.
 *
 * Shared by both deploy tiers: k8s (the registry pod hostPorted on the
 * master, `10.0.1.1:5000`) and compose (a standalone `registry:2` container
 * on the server, `127.0.0.1:5000`). Callers supply the registry's
 * `remotePrefix` (the tag prefix the image was BUILT with, e.g.
 * `10.0.1.1:5000/` or `127.0.0.1:5000/`) and the `serverIp` to tunnel to;
 * everything else — settle-on-exit tunnel lifecycle, bind-race port walk,
 * idempotent teardown, BatchMode, transient/permanent push classification —
 * is identical between tiers.
 *
 * Why an SSH tunnel: the registry listens on a port that isn't exposed to
 * the public internet (firewalled). Without DNS/L4 pointing the operator at
 * `server:5000`, we forward locally:
 *
 *     ssh -L 5000:localhost:5000 -N -f <server>
 *     docker tag <remotePrefix><repo>:<tag> localhost:5000/<repo>:<tag>
 *     docker push localhost:5000/<repo>:<tag>
 *     pkill -f "ssh -L 5000:localhost:5000"
 *
 * Why retag to localhost first: docker resolves the registry hostname in a
 * tag literally, so `docker push <remotePrefix>...` would dial the
 * remote-prefix host directly — bypassing the SSH tunnel (which is bound to
 * `localhost:5000`) and timing out, since that host is a provider-private IP
 * (k8s) or otherwise unreachable from the operator. Pushing through
 * `localhost:5000` routes through the tunnel AND inherits docker's loopback
 * insecure-by-default behavior (the registry serves plain HTTP). The OCI
 * registry stores content by `<repo>:<tag>` only — the host portion is just
 * used to find the registry — so pulls of the original
 * `<remotePrefix><repo>:<tag>` reference resolve to the same content
 * (each tier's own registry-mirror config maps that hostname to the
 * registry).
 *
 * The `remotePrefix` MUST match the prefix the image was built with
 * (`buildAppImage` for k8s, the compose build path's own tagPrefix) — keep
 * builder and pusher in sync.
 *
 * Sideload remains the primary distribution path for static workers/servers;
 * the registry push is additive — it lets late-joining consumers (CA-spawned
 * k8s workers that don't exist at sideload time; a compose warm-redeploy
 * pulling only changed layers) fetch the same tag afterward.
 *
 * Idempotency: a stale forward from a prior crashed run blocks `-L 5000`
 * binding. We tear down any existing tunnel first (best-effort), open a
 * fresh one, push, then tear it down again. If the push fails because the
 * tunnel didn't bind in time, we retry with a fresh tunnel per the settle
 * ladder below.
 *
 * Per `feedback_ssh_batchmode_required.md`, every ssh invocation includes
 * `-o BatchMode=yes` so a key-auth failure aborts cleanly instead of falling
 * back to interactive prompt (via `buildHostKeyOptsForPath`).
 *
 * Concurrency: calls are SERIALIZED process-wide by a mutex — an HA deploy
 * fans primary + standby out concurrently, and two simultaneous uploads over
 * one operator uplink stall each other's blobs into `unknown blob` failures.
 * See the "Uplink serialization" block below for the evidence and the
 * alternatives that were rejected.
 *
 * Throws on persistent push failure; tunnel-teardown and local-tag cleanup
 * failures are non-fatal.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { progressLog } from '../cli/progress.js';
import { runCommandAsync } from '../command.js';
import { buildHostKeyOptsForPath, SSH_TUNNEL_NO_MUX_OPTS } from '../host-keys.js';
import { runWithRetry } from '../retry.js';
import { acquireUplinkLock } from './uplink-lock.js';

/**
 * Permanent `docker push` failure signatures — retrying can NEVER succeed, so
 * the push retry loop fails fast on a match instead of burning the full settle
 * ladder. Deliberately narrow: only authentication/authorization denials and
 * malformed-image rejections. Everything else (registry 503/SlowDown, blob
 * unknown mid-push after a registry-pod restart, unexpected EOF, connection
 * reset, tunnel-bind races, bare non-zero exits) is potentially transient and
 * MUST be retried — misclassifying a recoverable blip as permanent would abort
 * an otherwise-healthy deploy. Exported so a caller adding a new permanent
 * signature has one obvious place to do it (mirrors KUBECTL_TRANSIENT_PATTERN).
 */
export const PUSH_PERMANENT_PATTERN =
  /\b(denied|unauthorized|authentication required|no basic auth credentials|manifest invalid|invalid reference format)\b/i;

/** True when a docker push error is permanent (never worth retrying). */
export function isPermanentPushError(err) {
  return PUSH_PERMANENT_PATTERN.test(String(err?.stderr ?? err?.message ?? ''));
}

// --- Uplink serialization ---------------------------------------------------
//
// CLASS: concurrent tunnel pushes contend on the operator uplink.
//
// An HA deploy fans `applyK3sManifests` out over primary + standby at once,
// and each side backgrounds its own `pushImageOverSshTunnel`. That puts TWO
// multi-hundred-MB image uploads on the operator's single uplink
// simultaneously, both funnelled through SSH tunnels. When the link can't
// carry both, a blob PUT stalls long enough for the registry to drop the
// upload session, and every following layer PUT returns `unknown blob` /
// `blob upload unknown` / `500` — errors that look like registry faults but
// are pure congestion. Live evidence (2026-08-12 hetzner/k8s-ha restore
// re-deploy, ~/.vibecarbon/logs/e4-2026-08-12T02-46-37-941Z.log): primary
// failed all 5 ladder attempts, standby failed every attempt that overlapped
// primary and succeeded only on attempt 5 — the one that ran ALONE on the
// link after primary gave up. The same code had passed hours earlier on a
// cold deploy, which is exactly the point: the failure is congestion-marginal,
// so it has to be prevented structurally rather than retried harder.
//
// FIX: a module-level async mutex (promise chain) around the whole push, so at
// most one tunnel transfer is in flight per deploy process.
//
// Why a mutex and not:
//   - Jittered stagger between the two pushes: probabilistic, not bounded. A
//     push takes 90-140s; no realistic stagger keeps two of them apart, it
//     only shifts where they collide.
//   - Bandwidth shaping (trickle/tc, per-cluster rate caps): needs privileged,
//     platform-specific tooling on the OPERATOR's machine, and it doesn't
//     remove the failure mode — a shaped-but-still-shared link can still stall
//     a blob past the registry's session window. It just makes both slower.
//   - Distinct tunnel ports per cluster: already done (the port walk below).
//     Ports were never the constraint; the shared uplink is.
//   - A longer/wider retry ladder: tonight's 5/5 primary failure IS the
//     evidence against it — retrying while the peer is still uploading
//     re-enters the same congested state.
// The mutex costs one push of wall clock in the HA case (the pushes are
// off the critical path inside each cluster — they overlap helm/rollout —
// so this rarely extends the deploy), is bounded and deterministic, needs no
// external tooling, and turns a 5-attempt thrash into two clean transfers.
//
// Scope: per-PROCESS. Two separate `vibecarbon deploy` processes (or e2e
// matrix siblings) still share the uplink; that's what the retry ladder and
// the bind-race port walk remain for.

/**
 * Tail of the push chain. Only ever RESOLVES — each holder's slot is a promise
 * settled by its release callback, never by the push's own outcome — so a push
 * that throws after exhausting its ladder cannot poison the chain for the
 * waiters behind it.
 * @type {Promise<void>}
 */
let pushLockTail = Promise.resolve();

/** Holders + waiters, tracked synchronously so contention is logged accurately. */
let pushLockDepth = 0;

/**
 * Acquire the tunnel-push mutex. Resolves with an idempotent release callback.
 * @param {string} label - short tag label for the progress lines.
 * @returns {Promise<() => void>}
 */
function acquireTunnelPushLock(label) {
  const prior = pushLockTail;
  let releaseSlot;
  const slot = new Promise((resolve) => {
    releaseSlot = resolve;
  });
  pushLockTail = prior.then(() => slot);

  // Read depth BEFORE incrementing, synchronously — two calls made in the same
  // tick would both still see depth 0 after an `await`.
  const contended = pushLockDepth > 0;
  pushLockDepth++;
  const queuedAt = Date.now();
  if (contended) {
    // Without this line a waiting push looks like a hang: no docker output, no
    // [push] attempt= line, nothing until the peer drains.
    progressLog(`[push] tag=${label} waiting for concurrent push to finish`);
  }

  return prior.then(async () => {
    if (contended) {
      progressLog(
        `[push] tag=${label} acquired push lock after ${Math.round((Date.now() - queuedAt) / 1000)}s wait`,
      );
    }
    // CROSS-PROCESS half of the lock (mitigation-audit cluster 2, 2026-08-16).
    // The promise chain above serializes pushes within THIS process; matrix
    // siblings and second operators on the same machine still shared the
    // uplink — the registry's open class-level item, and the reason a push
    // failed after 5 attempts one day after the per-process mutex landed.
    // Only one holder per process reaches this point (the chain guarantees
    // it), so the file lock cannot self-deadlock.
    const releaseUplink = await acquireUplinkLock({ label: `push tag=${label}` });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pushLockDepth--;
      releaseUplink();
      releaseSlot();
    };
  });
}

/**
 * Default per-attempt settle ladder (5 attempts, 226s of settle total).
 *
 * Budgeted for the K8S tier and left as the default because k8s is the caller
 * that omits `settleDelaysMs` — see the failure-mode breakdown at the retry
 * loop below. The long 60s/120s tail exists specifically for the k8s
 * registry's object-storage backend throttling (503 SlowDown) and for a
 * registry POD reschedule (~10-20s to Ready). The in-PROCESS source of that
 * throttling (an HA deploy pushing primary and standby into the same S3
 * account at once) is now removed by the push mutex, but cross-process
 * siblings — a parallel e2e matrix, a second operator — still share the
 * account, so the tail stays.
 *
 * Compose's registry is a filesystem-backed container on a single server with
 * one pusher, and compose has an automatic sideload fallback — neither
 * condition holds — so it passes its own much shorter ladder
 * (`COMPOSE_PUSH_SETTLE_DELAYS_MS` in `compose/registry-config.js`). Keep the
 * two separate: shortening this one would regress k8s-HA.
 */
// Shrunk 2026-08-16 (band-aid removal) on the premise the 60s/120s tail
// absorbed OUR parallel-push load, fixed by the push mutex. RE-GROWN
// 2026-08-17: runs 31997668866 + 32005301329 falsified that premise with
// registry-side evidence — mutex held, round-trip probe passing, and the
// 500s were `s3aws: NoSuchBucket`: Hetzner propagates bucket metadata
// per-frontend and keeps flapping for MINUTES after the creation-time
// sustained-visibility gate (s3-base.js#waitForBucketVisible) passes. In
// 32005301329 the standby push rode the weather out on attempt 3 while the
// primary exhausted 3 attempts and failed the deploy — ladder depth was the
// only difference. A proven-EXTERNAL class carries its one mitigation; the
// root fixes (visibility gate, per-attempt probe) stay in front of it.
export const DEFAULT_PUSH_SETTLE_DELAYS_MS = [1_000, 10_000, 20_000, 60_000, 120_000];

/**
 * @param {{
 *   tag: string,
 *   remotePrefix: string,
 *   serverIp: string,
 *   sshKey: string,
 *   khPath: string,
 *   settleDelaysMs?: number[],
 *   localTunnelPort?: number,
 * }} args
 *   `remotePrefix` is the tag prefix the image was built with (e.g.
 *   `'10.0.1.1:5000/'` for k8s, `'127.0.0.1:5000/'` for compose) — `tag`
 *   MUST start with it. `settleDelaysMs` controls the per-attempt sleep
 *   between opening the tunnel and dialing it. Length of the array is the
 *   attempt count. Omitting it takes `DEFAULT_PUSH_SETTLE_DELAYS_MS`, the
 *   k8s budget (see comment in the loop); the compose tier passes its own
 *   shorter `COMPOSE_PUSH_SETTLE_DELAYS_MS`. Tests pass `[0, 0, 0]` to keep
 *   the suite fast.
 * @param {{ spawn?: typeof spawn }} [deps] - injection seam for tests. Mocking
 *   `node:child_process` itself is flaky under the parallel unit run (sibling
 *   files import this module unmocked), so the serialization tests hand in a
 *   fake `spawn` instead.
 * @returns {Promise<void>}
 */
/** Round-trip probe budget per push attempt / poll interval. */
export const REGISTRY_PROBE_BUDGET_MS = 60_000;
const REGISTRY_PROBE_INTERVAL_MS = 2_000;

/**
 * Prove the registry at localhost:<port> can ROUND-TRIP a blob: start an
 * upload session (POST), commit a probe blob to the returned Location (PUT
 * with digest — which resolves the session state), read it back by digest
 * (HEAD), then delete it. Polled until the whole chain holds in ONE pass.
 *
 * THE CONDITION, not its proxies (RCA 2026-08-16, run 31970876667 k8s-ha):
 * the registry pod was Ready, `GET /v2/` answered 200 — and the push still
 * died, because registry:2's S3 driver keeps blobs AND upload-session state
 * in the object-storage bucket, and Hetzner object storage failed
 * read-after-write on the session: upload POST 202'd, the PATCH 0.35s later
 * got "blob upload unknown" from the same pod. Third occurrence of the
 * registry-500 class (31763728135, 31857911325); first with captured
 * evidence. This probe exercises tunnel → service → pod → S3 write → S3
 * read-back — everything a real push depends on — for one tiny blob before
 * docker spends minutes uploading layers into a backend that loses them.
 *
 * On budget exhaustion, throws the LAST real error (readiness.js contract:
 * a genuinely broken registry fails the deploy with its own message).
 *
 * @param {object} params
 * @param {number} params.port - local tunnel port
 * @param {string} params.repository - image repository name (no tag)
 * @param {number} [params.budgetMs]
 * @param {typeof fetch} [params.fetchImpl] - test seam
 * @param {(ms: number) => Promise<void>} [params.sleep] - test seam
 * @param {() => number} [params.nowFn] - test seam
 */
export async function awaitRegistryRoundTrip({
  port,
  repository,
  budgetMs = REGISTRY_PROBE_BUDGET_MS,
  fetchImpl = fetch,
  sleep = (ms) => delay(ms),
  nowFn = Date.now,
}) {
  const base = `http://localhost:${port}/v2/${repository}`;
  const payload = Buffer.from('vibecarbon-registry-round-trip-probe');
  const digest = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
  const deadline = nowFn() + budgetMs;
  let lastErr;
  for (;;) {
    try {
      const start = await fetchImpl(`${base}/blobs/uploads/`, { method: 'POST' });
      if (start.status !== 202) throw new Error(`upload start: HTTP ${start.status}`);
      const location = start.headers.get('location');
      if (!location) throw new Error('upload start: 202 without a Location header');
      const commitUrl = new URL(location, `http://localhost:${port}`);
      commitUrl.searchParams.set('digest', digest);
      const commit = await fetchImpl(commitUrl.toString(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: payload,
      });
      if (commit.status !== 201) throw new Error(`blob commit: HTTP ${commit.status}`);
      const readBack = await fetchImpl(`${base}/blobs/${digest}`, { method: 'HEAD' });
      if (readBack.status !== 200) throw new Error(`blob read-back: HTTP ${readBack.status}`);
      // Best-effort cleanup — a leftover 36-byte probe blob is harmless.
      await fetchImpl(`${base}/blobs/${digest}`, { method: 'DELETE' }).catch(() => {});
      return;
    } catch (err) {
      lastErr = err;
      if (nowFn() >= deadline) break;
      await sleep(REGISTRY_PROBE_INTERVAL_MS);
    }
  }
  throw new Error(
    `registry round-trip probe: the registry at localhost:${port} did not serve a blob ` +
      `upload → commit → read-back within ${Math.round(budgetMs / 1000)}s. ` +
      `Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr ?? '(none)')}`,
  );
}

/**
 * Fingerprint whatever answers `/v2/` on the tunnel port, for a FAILED push
 * attempt's error message.
 *
 * Run 31984725162: the round-trip probe PASSED seconds before docker push got
 * three 500s — and NEITHER cluster's registry logged any docker traffic, so
 * the 500s came from something on the path that no captured log identifies.
 * A real registry:2 answers `GET /v2/` with a Docker-Distribution-Api-Version
 * header; anything else names itself by its absence, status, and body. Taken
 * immediately after the failure through the SAME port, this rides into the
 * attempt error so the next occurrence is self-identifying.
 *
 * @param {number} port
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string>} one log-safe line
 */
async function describeRegistryEndpoint(port, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`http://localhost:${port}/v2/`, { method: 'GET' });
    const dist = res.headers.get('docker-distribution-api-version') ?? '(no Distribution header)';
    const server = res.headers.get('server') ?? '(no Server header)';
    let body = '';
    try {
      body = String(await res.text())
        .slice(0, 200)
        .replace(/\s+/g, ' ')
        .trim();
    } catch {
      // body unreadable — status + headers still identify the responder
    }
    return (
      `endpoint after failure: GET /v2/ → HTTP ${res.status}; ` +
      `Distribution: ${dist}; Server: ${server}${body ? `; body: ${body}` : ''}`
    );
  } catch (err) {
    return `endpoint after failure: GET /v2/ failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Node-side census of the master's :5000 path, for a FAILED push attempt.
 *
 * Run 31990220178 proved TWO distribution-API speakers behind one tunnel
 * port: describeRegistryEndpoint got a registry/2.0 answer while the captured
 * registry pod — zero restarts, log covering the whole window — saw neither
 * the docker traffic nor the fingerprint's own /v2/ GETs. The second speaker
 * can only be identified from the node itself: what actually LISTENS on
 * :5000 (both address families) and what the NAT layer rewrites. Best-effort
 * and bounded; its output rides in the attempt error next to the endpoint
 * fingerprint.
 *
 * @param {{serverIp: string, sshKey: string, khPath: string}} args
 * @param {typeof runCommandAsync} [execImpl]
 * @returns {Promise<string>} one log-safe line
 */
async function describeNodeListeners({ serverIp, sshKey, khPath }, execImpl = runCommandAsync) {
  try {
    const out = await execImpl(
      [
        'ssh',
        '-i',
        sshKey,
        ...buildHostKeyOptsForPath(khPath),
        '--',
        `root@${serverIp}`,
        "sh -c 'ss -tlnp 2>/dev/null | grep 5000; iptables -t nat -S 2>/dev/null | grep 5000 | head -6' || true",
      ],
      { silent: true, returnOutput: true, timeout: 20_000, ignoreError: true },
    );
    const text =
      typeof out === 'string'
        ? out
            .trim()
            .replace(/\s*\n\s*/g, ' // ')
            .slice(0, 400)
        : '';
    return `node :5000 listeners/rules: ${text || '(none reported)'}`;
  } catch (err) {
    return `node :5000 listeners/rules: census failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function pushImageOverSshTunnel(args, deps = {}) {
  // Validate BEFORE queueing: a malformed call is a programming error and must
  // surface immediately, not after a peer's multi-minute upload drains.
  assertPushArgs(args);
  // Serialize the whole push — settle ladder included. Holding the mutex per
  // ATTEMPT instead would interleave the two clusters attempt-by-attempt and
  // recreate the exact contention this exists to prevent.
  const release = await acquireTunnelPushLock(String(args.tag).split('/').pop());
  try {
    await runTunnelPush(args, deps);
  } finally {
    release();
  }
}

/**
 * Reject malformed push arguments. Split out of the push body so the exported
 * entrypoint can validate before taking the mutex.
 * @param {Parameters<typeof pushImageOverSshTunnel>[0]} args
 */
function assertPushArgs({ tag, remotePrefix, serverIp, sshKey, khPath, localTunnelPort = 5000 }) {
  if (!tag) throw new Error('pushImageOverSshTunnel: tag is required');
  if (!remotePrefix) throw new Error('pushImageOverSshTunnel: remotePrefix is required');
  if (!serverIp) throw new Error('pushImageOverSshTunnel: serverIp is required');
  if (!sshKey) throw new Error('pushImageOverSshTunnel: sshKey is required');
  if (!khPath) throw new Error('pushImageOverSshTunnel: khPath is required');
  if (!Number.isInteger(localTunnelPort) || localTunnelPort < 1 || localTunnelPort > 65535) {
    throw new Error(
      `pushImageOverSshTunnel: localTunnelPort must be a port in [1, 65535], got: ${localTunnelPort}`,
    );
  }
  // The push rewrites the build-time remotePrefix to localhost:<chosenPort> so
  // it hits THIS deploy's SSH tunnel and uses HTTP, which only works if the tag
  // actually carries that prefix.
  if (!tag.startsWith(remotePrefix)) {
    throw new Error(
      `pushImageOverSshTunnel: expected tag prefixed with '${remotePrefix}', got: ${tag}`,
    );
  }
}

/**
 * The push itself. ALWAYS runs under the tunnel-push mutex — call it through
 * `pushImageOverSshTunnel`, never directly.
 * @param {Parameters<typeof pushImageOverSshTunnel>[0]} args
 * @param {{ spawn?: typeof spawn }} [deps]
 * @returns {Promise<void>}
 */
async function runTunnelPush(
  { tag, remotePrefix, serverIp, sshKey, khPath, settleDelaysMs, localTunnelPort = 5000 },
  { spawn: spawnFn = spawn, registryProbe = awaitRegistryRoundTrip } = {},
) {
  const target = `root@${serverIp}`;
  const repository = tag.slice(remotePrefix.length).split(':')[0];

  // chosenPort + localTag get re-bound on each open-tunnel attempt below.
  // We can't pick the port up-front because of a TOCTOU race: probing
  // `isPortFree(5000)`, releasing the listener, then `ssh -L 5000:...` is
  // not atomic — a sibling deploy in the matrix (k8s + k8s-ha primary
  // both default to 5000) can win the bind in between. The fix is to try
  // ssh directly and walk forward on failure, treating "tunnel open" as
  // the only true free-port signal. Observed iter-wave1b 2026-05-01:
  // single-k8s and k8s-ha-primary collided here.
  let localTag = '';
  let forwardSpec = '';
  let tunnelPattern = '';
  let chosenPort = localTunnelPort;
  const setPort = (port) => {
    chosenPort = port;
    forwardSpec = `${port}:localhost:5000`;
    tunnelPattern = `ssh.*-L.*${forwardSpec}`;
    localTag = `localhost:${port}/${tag.slice(remotePrefix.length)}`;
  };
  setPort(localTunnelPort);

  /** Best-effort teardown of any existing tunnel on localhost:<port>. */
  const teardown = async () => {
    // pkill exits 1 when no matching process — that's fine, hence ignoreError.
    await runCommandAsync(['pkill', '-f', tunnelPattern], { silent: true, ignoreError: true });
  };

  /**
   * Open a backgrounding SSH tunnel (`-N -f`) and settle on the child's
   * 'exit' event — NOT 'close'.
   *
   * OpenSSH's `-f` forks a daemon that inherits the tunnel's stdout/stderr
   * fds and holds them open for the tunnel's entire lifetime. With piped
   * stdio the parent process therefore never sees 'close' on SUCCESS (the
   * fds stay open in the daemon), so a runCommandAsync-style settle-on-close
   * would hang the whole deploy. 'exit' fires when the foreground ssh
   * process exits, which happens right after the successful fork (code 0)
   * or immediately on a pre-fork bind failure (nonzero under
   * ExitOnForwardFailure=yes). stdout is ignored; only stderr is piped so a
   * bind failure's diagnostic text survives for the port-walk catch below.
   * The rejected error mirrors runCommandAsync's shape (.status + .stderr +
   * `Command failed: …` message) so the surrounding catch is unchanged. The
   * daemon reaps itself, so we don't register it in command.js's
   * activeChildren (which isn't exported anyway).
   */
  const openSshTunnel = (argv) =>
    new Promise((resolve, reject) => {
      const child = spawnFn(argv[0], argv.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] });
      // Do NOT unref() the child before 'exit': an unref'd child holds no
      // event-loop reference, so if this promise is the only pending work the
      // process drains and exits 0 BEFORE 'exit' can fire — the deploy
      // vanishes mid-plan (live-diagnosed on k8s-ha: silent exit-0 at the
      // standby registry push). The -f daemon holding the stderr pipe is the
      // real leak concern; sever it in the 'exit' handler instead so a missed
      // pkill teardown can't pin the loop afterwards.
      let stderr = '';
      child.stderr?.on('data', (d) => {
        stderr += d;
      });
      const releaseDaemonPipe = () => {
        child.stderr?.destroy?.();
        child.unref?.();
      };
      child.on('error', (err) => {
        releaseDaemonPipe();
        reject(err);
      });
      child.on('exit', (code, signal) => {
        releaseDaemonPipe();
        if (code === 0) return resolve(undefined);
        const cmdStr = argv.join(' ');
        const trimmed = stderr.trim();
        const error = new Error(
          trimmed ? `Command failed: ${cmdStr}\n${trimmed}` : `Command failed: ${cmdStr}`,
        );
        error.status = code;
        error.stderr = stderr;
        error.signal = signal;
        reject(error);
      });
    });

  /**
   * Try to open the SSH tunnel on the currently-set port; if SSH bind
   * fails (sibling deploy holds the port), walk forward up to 20 ports.
   * Does NOT call teardown() in the walk — the pkill pattern would
   * match sibling processes' tunnels too. The walk is bind-race-resilient
   * because ssh exits non-zero immediately on bind failure (via
   * ExitOnForwardFailure=yes).
   */
  const openTunnelOrWalk = async () => {
    const errors = [];
    for (let probe = 0; probe < 20; probe++) {
      const candidate = localTunnelPort + probe;
      if (candidate > 65535) break;
      setPort(candidate);
      try {
        await openSshTunnel([
          'ssh',
          '-i',
          sshKey,
          // Tunnels opt OUT of multiplexing — see SSH_TUNNEL_NO_MUX_OPTS.
          // MUST precede buildHostKeyOptsForPath (which embeds
          // ControlMaster=auto): OpenSSH takes the FIRST -o value per option.
          ...SSH_TUNNEL_NO_MUX_OPTS,
          ...buildHostKeyOptsForPath(khPath),
          '-o',
          'ExitOnForwardFailure=yes',
          '-L',
          forwardSpec,
          '-N',
          '-f',
          target,
        ]);
        return;
      } catch (err) {
        errors.push(`port ${candidate}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(
      `pushImageOverSshTunnel: failed to open SSH tunnel on any port in [${localTunnelPort}, ${localTunnelPort + 19}]. ` +
        `Errors: ${errors.join(' | ')}`,
    );
  };
  // openTunnel signature stays the same so the retry loop below is
  // unchanged; it's now bind-race-resilient instead of TOCTOU-racy.
  const openTunnel = openTunnelOrWalk;

  /** Push the localhost-aliased tag through the local-forwarded port. */
  // Async spawn (not execFileSync): a docker push of a multi-hundred-MB image
  // takes minutes, and a synchronous call blocks Node's event loop the whole
  // time — freezing the spinner/log output and leaking unreaped child
  // processes (SIGCHLD can't fire while blocked). spawn keeps the loop live.
  //
  // stderr is PIPED (was 'inherit') so the transient/permanent classifier
  // (PUSH_PERMANENT_PATTERN, below) can read docker's error text — but it's
  // teed straight back to the operator's terminal so live visibility is
  // unchanged. stdout stays inherited (push progress bars). The accumulated
  // stderr is attached to the rejected error so runWithRetry's isTransient can
  // fail fast on a hopeless push (denied/auth/manifest-invalid) instead of
  // burning the whole settle ladder.
  const push = () =>
    new Promise((resolve, reject) => {
      const child = spawnFn('docker', ['push', localTag], {
        stdio: ['ignore', 'inherit', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        const s = chunk.toString();
        stderr += s;
        process.stderr.write(s);
      });
      child.on('error', (err) => reject(new Error(`docker push spawn failed: ${err.message}`)));
      child.on('exit', (code) => {
        if (code === 0) return resolve(undefined);
        const tail = stderr.trim().slice(-500);
        const err = new Error(`docker push exited with code ${code}${tail ? `: ${tail}` : ''}`);
        err.stderr = stderr;
        reject(err);
      });
    });

  // Progressive backoff across attempts. Failure modes we're covering, in
  // priority order:
  //   1. Stale tunnel from a parallel run holds :5000 → reopen tunnel.
  //      Recovers in seconds (handled by the per-attempt teardown).
  //   2. Registry restarted between back-to-back pushes (e.g. probe-killed
  //      mid-prior-push) → manifest PUT returns EOF or `manifest blob
  //      unknown to registry`. Registry recovery is ~10–20s, so the later
  //      attempts have the longer backoff to let the replacement become
  //      Ready before re-pushing.
  //   3. S3 throttle (object-storage-backed registry 503 SlowDown during
  //      blob upload) → the registry propagates a `503 Service Unavailable`
  //      to the docker client. This is LOAD-induced. The in-process cause
  //      (k8s-HA pushing primary and standby into the same S3-compatible
  //      account at once) is now eliminated by the push mutex above, but
  //      cross-process load — a parallel e2e matrix, another operator on the
  //      same account — remains. 3 short attempts (~46s of settle) couldn't
  //      ride it out; the longer tail (60s/120s) extends past the throttle
  //      window.
  // The 1s/15s head keeps the happy path fast (single attempt ~6s end-to-end)
  // while the 30s/60s/120s tail rides out genuine restarts + S3 throttling.
  // Note docker push is content-addressable: layers whose S3 write already
  // succeeded are skipped on retry, so later attempts get progressively cheaper.
  //
  // Modes 2 and 3 are BOTH k8s-shaped, which is why the default is the k8s
  // budget and the compose tier passes its own (COMPOSE_PUSH_SETTLE_DELAYS_MS):
  // a filesystem-backed registry container restarts in ~1-2s rather than
  // ~10-20s, there is no object-storage account to throttle and no sibling
  // cluster pushing into it, and a compose push that gives up falls back to
  // sideload instead of failing the deploy.
  const settleDelays = settleDelaysMs ?? DEFAULT_PUSH_SETTLE_DELAYS_MS;
  const maxAttempts = settleDelays.length;
  const attemptErrors = [];
  const taggedAliases = new Set();
  // Per-attempt structured logging — without this, the only visible signal
  // for a slow push is the final perf duration (which collapses retry
  // count + per-attempt time into a single number). iter-perfwave2 showed
  // primary registryPush.backup 2m53s vs standby 41s with no way to tell
  // if the gap was 1 slow push or 3 retried pushes. The log lines below
  // make next run's analysis trivial: count `[push] attempt=` lines for
  // attempt-count, sum `dur=` for actual push wall-clock.
  const startedAt = Date.now();

  // The per-attempt work, folded onto runWithRetry below. The settle delay
  // stays INSIDE this function (keyed by the same `attempt` index
  // runWithRetry hands us) because it must apply before every push,
  // including the very first — the freshly-opened tunnel needs a moment to
  // bind, it's not just a backoff between failures. runWithRetry's own
  // inter-attempt delay is left at 0ms (see below) so the total attempt
  // count matches settleDelays.length exactly, same as the old hand-rolled
  // loop; the meaningful delay is the one computed here.
  const runAttempt = async (attempt) => {
    const attemptStart = Date.now();
    let outcome = 'ok';
    try {
      // openTunnel may walk to a different port on bind-collision; localTag
      // is updated in lockstep so push targets the actual chosen port.
      await openTunnel();
      // Add the localhost-prefixed alias for the chosen port. Skip the
      // re-tag if we already aliased this port on an earlier attempt
      // (same port → same alias, docker tag is idempotent but the call
      // is wasteful). Track all aliases for cleanup so a port walk
      // doesn't leak local image refs.
      if (!taggedAliases.has(localTag)) {
        await runCommandAsync(['docker', 'tag', tag, localTag], { silent: true });
        taggedAliases.add(localTag);
      }
      await delay(settleDelays[attempt]);
      // Condition gate before the upload: the registry must round-trip a
      // probe blob through THIS tunnel to its backend (awaitRegistryRoundTrip
      // — the run-31970876667 S3 read-after-write class). A probe failure
      // consumes this attempt like any push failure, so the settle ladder
      // still paces genuine backend outages.
      await registryProbe({ port: chosenPort, repository });
      await push();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Fingerprint the endpoint through the same port BEFORE teardown kills
      // the tunnel — the one moment the mystery responder is still reachable —
      // then census the node's :5000 path over ssh (who listens, what NAT
      // rewrites) so the second-speaker mystery self-identifies.
      const endpoint = await describeRegistryEndpoint(chosenPort);
      const listeners = await describeNodeListeners({ serverIp, sshKey, khPath });
      attemptErrors.push(`${message} | ${endpoint} | ${listeners}`);
      outcome = `fail(${message.split('\n')[0].slice(0, 80)})`;
      throw err;
    } finally {
      // Tear down between attempts so a stuck tunnel from this attempt
      // doesn't bind-block the next attempt's openTunnel walk.
      await teardown();
      const dur = Math.round((Date.now() - attemptStart) / 1000);
      const totalDur = Math.round((Date.now() - startedAt) / 1000);
      progressLog(
        `[push] tag=${tag.split('/').pop()} attempt=${attempt + 1}/${maxAttempts} port=${localTag.split('/')[0]} settle=${settleDelays[attempt] / 1000}s dur=${dur}s totalDur=${totalDur}s ${outcome}`,
      );
    }
  };

  let pushed = false;
  try {
    await runWithRetry(runAttempt, {
      delaysMs: new Array(Math.max(maxAttempts - 1, 0)).fill(0),
      // Fail FAST on a permanent push failure (denied/auth/manifest-invalid):
      // retrying can never succeed, so short-circuit the settle ladder (up to
      // ~3.5min of dead waiting) instead of grinding through every attempt.
      // Everything NOT matched by PUSH_PERMANENT_PATTERN — bare exit codes,
      // registry/S3 503s, tunnel-bind races, EOF/blob-unknown mid-push — is
      // treated as transient and retried: a recoverable blip must never be
      // misclassified as permanent and abort an otherwise-healthy deploy.
      isTransient: (err) => !isPermanentPushError(err),
    });
    pushed = true;
  } catch {
    // attemptErrors was already populated inside runAttempt; the
    // exhausted-attempts error below is what the caller actually sees.
  }
  // Cleanup every localhost alias we created. Underlying image content
  // stays addressable as the original `tag` (used by sideload + Deployment).
  for (const alias of taggedAliases) {
    await runCommandAsync(['docker', 'rmi', alias], { silent: true, ignoreError: true });
  }
  if (!pushed) {
    // Report the ACTUAL number of attempts made (attemptErrors.length), not the
    // ladder ceiling — a fast-fail on a permanent error stops after one attempt
    // and a "failed after 5 attempts" message would misreport that.
    throw new Error(
      `pushImageOverSshTunnel: docker push for ${tag} failed after ${attemptErrors.length} attempt${attemptErrors.length === 1 ? '' : 's'}. ` +
        `Errors: ${attemptErrors.map((m, i) => `[#${i + 1}] ${m}`).join(' | ')}`,
    );
  }
}
