import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

// Same spawn-mock harness as k3s-push-image.test.ts (which pins the k8s
// delegate path exhaustively — 13 tests, untouched by this refactor). This
// file exercises the SHARED helper directly with a COMPOSE-shaped call
// (remotePrefix '127.0.0.1:5000/', a plain host serverIp instead of a
// cluster-private IP) to lock the generalized-param entrypoint the compose
// tier's registry push will call.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const modulePromise = import('../../../src/lib/deploy/registry-push.js');

// Codes the next spawn()ed `docker push` calls should exit with (shift per
// call). Empty → success (0).
let pushExitCodes: number[] = [];

// stderr text the next `docker push` spawns should emit (shift per call).
let pushStderrs: string[] = [];

// Outcomes the next `ssh -N -f` tunnel-open spawns should produce (shift per
// call). Empty → success (exit 0).
let sshTunnelOutcomes: { code: number; stderr?: string }[] = [];

/**
 * Fake child for the hand-rolled `docker push` spawn (listens on 'exit').
 * Emits stderr 'data' BEFORE 'exit' (microtask FIFO), matching real spawn
 * event ordering the retry classifier depends on.
 */
function fakePushChild(code: number, stderrText = '') {
  const child = {
    stderr: {
      on(event: string, cb: (chunk: unknown) => void) {
        if (event === 'data' && stderrText) {
          Promise.resolve().then(() => cb(Buffer.from(stderrText)));
        }
      },
    },
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === 'exit') Promise.resolve().then(() => cb(code));
      return child;
    },
  };
  return child;
}

/**
 * Fake child for the `ssh -N -f` tunnel open. Settles on 'exit', NEVER
 * 'close' — mirrors OpenSSH's `-f` daemonizing behavior (the -f daemon
 * inherits the piped stderr fd and holds it open for the tunnel's whole
 * lifetime, so 'close' never fires on success; see k3s-push-image.test.ts
 * for the full regression rationale this locks in on the shared helper).
 */
function fakeTunnelChild(code: number, stderrText = '') {
  const child = {
    unref() {},
    stdout: null,
    stderr: {
      on(event: string, cb: (chunk: unknown) => void) {
        if (event === 'data' && stderrText) {
          Promise.resolve().then(() => cb(Buffer.from(stderrText)));
        }
      },
    },
    on(event: string, cb: (...a: unknown[]) => void) {
      // Only 'exit' ever fires.
      if (event === 'exit') Promise.resolve().then(() => cb(code));
      return child;
    },
  };
  return child;
}

/** Fake child for a runCommandAsync-driven call (listens on 'close'). */
function fakeExecChild(code: number) {
  const child = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on(event: string, cb: (...a: unknown[]) => void) {
      if (event === 'close') Promise.resolve().then(() => cb(code));
      return child;
    },
  };
  return child;
}

function installSpawnMock() {
  vi.mocked(spawn).mockImplementation(((cmd: string, args: string[]) => {
    if (cmd === 'docker' && args[0] === 'push') {
      const code = pushExitCodes.length ? (pushExitCodes.shift() as number) : 0;
      const stderrText = pushStderrs.length ? (pushStderrs.shift() as string) : '';
      return fakePushChild(code, stderrText) as unknown as ReturnType<typeof spawn>;
    }
    if (cmd === 'ssh' && args.includes('-N')) {
      // Tunnel open (-N) — settles on 'exit', never 'close'. Success by
      // default. Plain ssh execs (the failed-attempt node-listener census)
      // route through runCommandAsync and settle on 'close' like any exec.
      const outcome = sshTunnelOutcomes.length
        ? (sshTunnelOutcomes.shift() as { code: number; stderr?: string })
        : { code: 0 };
      return fakeTunnelChild(outcome.code, outcome.stderr) as unknown as ReturnType<typeof spawn>;
    }
    // docker tag / pkill teardown / docker rmi cleanup all route through
    // runCommandAsync (settle-on-close) and succeed by default.
    return fakeExecChild(0) as unknown as ReturnType<typeof spawn>;
  }) as unknown as typeof spawn);
}

/** All spawn() calls except the `docker push` ones, in call order. */
function nonPushCalls() {
  return vi
    .mocked(spawn)
    .mock.calls.filter((c) => !(c[0] === 'docker' && (c[1] as string[])[0] === 'push'));
}

/** All `docker push` spawn() calls, in call order. */
function pushCalls() {
  return vi
    .mocked(spawn)
    .mock.calls.filter((c) => c[0] === 'docker' && (c[1] as string[])[0] === 'push');
}

/**
 * Happy-path fake of the registry v2 API for the round-trip probe: POST
 * starts an upload (202 + Location), PUT commits (201), HEAD reads back
 * (200), DELETE cleans up (202). Installed as the global fetch so the
 * DEFAULT probe wiring is exercised by every push test.
 */
function happyRegistryFetch() {
  return vi.fn(async (url: string | URL, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    const headers = {
      get: (h: string) => {
        if (method === 'POST' && h.toLowerCase() === 'location') {
          return `${String(url)}probe-upload-1`;
        }
        if (h.toLowerCase() === 'docker-distribution-api-version') return 'registry/2.0';
        return null;
      },
    };
    if (method === 'POST') return { status: 202, headers };
    if (method === 'PUT') return { status: 201, headers };
    if (method === 'HEAD') return { status: 200, headers };
    return { status: 200, headers, text: async () => '{}' };
  });
}

describe('pushImageOverSshTunnel (compose-shaped)', () => {
  let khPath: string;
  let fetchStub: ReturnType<typeof happyRegistryFetch>;

  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    pushExitCodes = [];
    pushStderrs = [];
    sshTunnelOutcomes = [];
    installSpawnMock();
    fetchStub = happyRegistryFetch();
    vi.stubGlobal('fetch', fetchStub);
    const tmp = mkdtempSync(join(tmpdir(), 'vc-registry-push-'));
    khPath = join(tmp, '.vibecarbon', 'known_hosts_e2e');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('R1: resolves on tunnel child exit, never close', async () => {
    // Regression for the settle-on-close hang, exercised through the
    // generalized entrypoint: fakeTunnelChild emits 'exit' (code 0) but
    // NEVER 'close'. A settle-on-close open would hang here; the exit-based
    // openSshTunnel resolves.
    const { pushImageOverSshTunnel } = await modulePromise;

    await expect(
      Promise.race([
        pushImageOverSshTunnel({
          tag: '127.0.0.1:5000/myproj:abc1234',
          remotePrefix: '127.0.0.1:5000/',
          serverIp: '1.2.3.4',
          sshKey: '/tmp/key',
          khPath,
          settleDelaysMs: [0, 0, 0, 0, 0],
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('tunnel open hung (never settled)')), 2_000),
        ),
      ]),
    ).resolves.toBeUndefined();

    const sshCalls = nonPushCalls().filter((c) => c[0] === 'ssh');
    expect(sshCalls.length).toBe(1);
    const sshArgv = sshCalls[0][1] as string[];
    expect(sshArgv).toContain('root@1.2.3.4');
  });

  it('the tunnel argv resolves to NO multiplexing under first-obtained-value semantics', async () => {
    // OpenSSH takes the FIRST value seen for each option (ssh_config(5));
    // buildHostKeyOptsForPath embeds ControlMaster=auto, so the no-mux
    // opt-out must precede it in the argv or it is inert (run 31927810430).
    const { pushImageOverSshTunnel } = await modulePromise;

    await pushImageOverSshTunnel({
      tag: '127.0.0.1:5000/myproj:abc1234',
      remotePrefix: '127.0.0.1:5000/',
      serverIp: '1.2.3.4',
      sshKey: '/tmp/key',
      khPath,
      settleDelaysMs: [0, 0, 0, 0, 0],
    });

    const sshArgv = nonPushCalls().filter((c) => c[0] === 'ssh')[0][1] as string[];
    const firstOptValue = (key: string) => {
      for (let i = 0; i < sshArgv.length - 1; i++) {
        if (sshArgv[i] === '-o' && String(sshArgv[i + 1]).startsWith(`${key}=`)) {
          return String(sshArgv[i + 1]).slice(key.length + 1);
        }
      }
      return undefined;
    };
    expect(firstOptValue('ControlMaster')).toBe('no');
    expect(firstOptValue('ControlPath')).toBe('none');
  });

  it('R3: bind failure walks to the next port, and the pushed tag follows the chosen port', async () => {
    const { pushImageOverSshTunnel } = await modulePromise;
    sshTunnelOutcomes = [
      { code: 255, stderr: 'bind [127.0.0.1]:5000: Address already in use' },
      { code: 0 },
    ];

    await expect(
      pushImageOverSshTunnel({
        tag: '127.0.0.1:5000/myproj:abc1234',
        remotePrefix: '127.0.0.1:5000/',
        serverIp: '1.2.3.4',
        sshKey: '/tmp/key',
        khPath,
        settleDelaysMs: [0, 0, 0, 0, 0],
      }),
    ).resolves.toBeUndefined();

    // Two ssh opens: port 5000 (failed) then port 5001 (succeeded).
    const sshCalls = nonPushCalls().filter((c) => c[0] === 'ssh');
    expect(sshCalls.length).toBe(2);
    const firstArgv = sshCalls[0][1] as string[];
    const secondArgv = sshCalls[1][1] as string[];
    expect(firstArgv[firstArgv.indexOf('-L') + 1]).toBe('5000:localhost:5000');
    expect(secondArgv[secondArgv.indexOf('-L') + 1]).toBe('5001:localhost:5000');

    // The push must dial the walked-to port.
    const pushCall = pushCalls()[0];
    expect(pushCall).toBeDefined();
    expect((pushCall as unknown as [string, string[]])[1][1]).toBe('localhost:5001/myproj:abc1234');
  });

  it('R7: REJECTS (not resolves-false) after exhausting every push attempt', async () => {
    const { pushImageOverSshTunnel } = await modulePromise;
    pushExitCodes = [1, 1, 1]; // every push attempt fails

    await expect(
      pushImageOverSshTunnel({
        tag: '127.0.0.1:5000/myproj:abc1234',
        remotePrefix: '127.0.0.1:5000/',
        serverIp: '1.2.3.4',
        sshKey: '/tmp/key',
        khPath,
        settleDelaysMs: [0, 0, 0],
      }),
    ).rejects.toThrow(/docker push.*failed after 3 attempts/);

    expect(pushCalls().length).toBe(3);
  });

  it('fails FAST (single push attempt) on a permanent error (denied/auth) — no settle-ladder burn', async () => {
    const { pushImageOverSshTunnel } = await modulePromise;
    pushExitCodes = [1, 1, 1];
    pushStderrs = ['denied: requested access to the resource is denied'];

    await expect(
      pushImageOverSshTunnel({
        tag: '127.0.0.1:5000/myproj:abc1234',
        remotePrefix: '127.0.0.1:5000/',
        serverIp: '1.2.3.4',
        sshKey: '/tmp/key',
        khPath,
        settleDelaysMs: [0, 0, 0, 0, 0],
      }),
    ).rejects.toThrow(/denied/);

    // Exactly ONE push attempt — the permanent error short-circuited the ladder.
    expect(pushCalls().length).toBe(1);
  });

  it('rejects a tag missing the remotePrefix', async () => {
    const { pushImageOverSshTunnel } = await modulePromise;

    await expect(
      pushImageOverSshTunnel({
        tag: 'wrong.example.com:5000/myproj:abc1234',
        remotePrefix: '127.0.0.1:5000/',
        serverIp: '1.2.3.4',
        sshKey: '/tmp/key',
        khPath,
      }),
    ).rejects.toThrow(/expected tag prefixed with '127\.0\.0\.1:5000\/'/);
  });
});

// ---------------------------------------------------------------------------
// Per-tier settle ladders. The shared helper's DEFAULT is the k8s budget and
// must stay that way; the compose tier passes its own, much shorter one. A
// single ladder cannot serve both: k8s needs the long tail for S3 SlowDown
// under parallel HA cluster pushes, while compose (filesystem-backed, one
// pusher, automatic sideload fallback) only pays dead time for it.
// ---------------------------------------------------------------------------
describe('settle ladders are per-tier', () => {
  it('k8s default ladder carries the bucket-propagation-weather tail (proven external)', async () => {
    // History: the 60s/120s tail was deleted 2026-08-16 on the premise it
    // absorbed OUR parallel-push load, fixed by the push mutex. Runs
    // 31997668866 + 32005301329 falsified that premise with registry-side
    // evidence: mutex held (150s lock waits logged), round-trip probe
    // passing, and the 500s were `s3aws: NoSuchBucket` — Hetzner's
    // per-frontend bucket-metadata propagation flapping for MINUTES after
    // the sustained-visibility gate passed. In 32005301329 the standby push
    // rode the weather out on attempt 3 while the primary exhausted its 3
    // attempts and failed the deploy — ladder depth was the only difference.
    // A proven-EXTERNAL class carries its one mitigation: the tail returns
    // under the corrected rationale. If pushes start failing with the probe
    // passing and locks held for some OTHER cause, that's a new class — do
    // not widen this ladder for it.
    const { DEFAULT_PUSH_SETTLE_DELAYS_MS } = await modulePromise;
    expect(DEFAULT_PUSH_SETTLE_DELAYS_MS).toEqual([1_000, 10_000, 20_000, 60_000, 120_000]);
  });

  it('the k8s call site passes NO settleDelaysMs, so it keeps taking the default', () => {
    // Structural: applyK3sManifests' pushImageToLocalRegistry(...) call must
    // stay free of a ladder override, and pushImageToLocalRegistry itself
    // forwards whatever it got (undefined -> default).
    const src = readFileSync(join(ROOT, 'src/lib/deploy/k8s/k3s.js'), 'utf8');
    // The lookbehind skips the declaration itself, whose own destructured
    // params legitimately name settleDelaysMs; only invocations are scanned.
    const callSites = [
      ...src.matchAll(/(?<!function )pushImageToLocalRegistry\(\{[\s\S]*?\n\s*\}\)/g),
    ].map((m) => m[0]);
    expect(callSites.length).toBeGreaterThan(0);
    for (const call of callSites) expect(call).not.toContain('settleDelaysMs');
  });

  it('compose is strictly cheaper to abandon than k8s (it has a sideload fallback)', async () => {
    const { DEFAULT_PUSH_SETTLE_DELAYS_MS } = await modulePromise;
    const { COMPOSE_PUSH_SETTLE_DELAYS_MS } = await import(
      '../../../src/lib/deploy/compose/registry-config.js'
    );
    const sum = (a: number[]) => a.reduce((t, n) => t + n, 0);
    // Post-shrink the two tiers are the same order of magnitude; compose must
    // simply never exceed k8s — it has a sideload fallback to reach for.
    expect(sum(COMPOSE_PUSH_SETTLE_DELAYS_MS)).toBeLessThanOrEqual(
      sum(DEFAULT_PUSH_SETTLE_DELAYS_MS),
    );
    // Head entry is the tunnel-bind settle, not a backoff — it applies before
    // the FIRST push in both tiers, so the happy path stays equally fast.
    expect(COMPOSE_PUSH_SETTLE_DELAYS_MS[0]).toBe(DEFAULT_PUSH_SETTLE_DELAYS_MS[0]);
    // Monotonic, so a later attempt always waits longer than an earlier one.
    for (let i = 1; i < COMPOSE_PUSH_SETTLE_DELAYS_MS.length; i++) {
      expect(COMPOSE_PUSH_SETTLE_DELAYS_MS[i]).toBeGreaterThan(
        COMPOSE_PUSH_SETTLE_DELAYS_MS[i - 1],
      );
    }
  });
});

/**
 * The registry ROUND-TRIP probe — the condition gate in front of every
 * tunnel push (RCA 2026-08-16, run 31970876667 k8s-ha restore re-deploy).
 *
 * The failure the de-noised registry logs finally evidenced: the standby
 * registry ACCEPTED an upload POST (202) and answered "blob upload unknown"
 * on the PATCH 0.35s later — same pod, zero restarts. With registry:2's S3
 * driver, upload sessions live in the object-storage bucket, and Hetzner
 * object storage can fail read-after-write on session state. Pod-Ready and
 * `GET /v2/` prove none of that. The one condition a push actually depends
 * on is "a blob can round-trip through this tunnel to the backend and be
 * read back" — so that is what gets probed, polled, before docker push
 * spends minutes uploading layers into a backend that loses them.
 */
describe('awaitRegistryRoundTrip', () => {
  const load = () => modulePromise;

  it('round-trips a probe blob: start upload → commit → read back → clean up', async () => {
    const { awaitRegistryRoundTrip } = await load();
    const calls: { method: string; url: string }[] = [];
    const fetchImpl = happyRegistryFetch();
    const recording = async (url: string | URL, init?: { method?: string }) => {
      calls.push({ method: init?.method ?? 'GET', url: String(url) });
      return fetchImpl(url, init);
    };

    await awaitRegistryRoundTrip({ port: 5000, repository: 'myproj', fetchImpl: recording });

    expect(calls.map((c) => c.method)).toEqual(['POST', 'PUT', 'HEAD', 'DELETE']);
    expect(calls[0].url).toBe('http://localhost:5000/v2/myproj/blobs/uploads/');
    // The commit PUT goes to the Location the registry returned (resolving
    // the upload session — the exact step run 31970876667 lost) and carries
    // the content digest.
    expect(calls[1].url).toContain('probe-upload-1');
    expect(calls[1].url).toContain('digest=sha256%3A');
    // Read-back is by digest, proving the backend serves what it accepted.
    expect(calls[2].url).toMatch(/\/v2\/myproj\/blobs\/sha256:/);
  });

  it('polls through a lost upload session (the run-31970876667 signature) until it holds', async () => {
    const { awaitRegistryRoundTrip } = await load();
    const happy = happyRegistryFetch();
    let puts = 0;
    const fetchImpl = async (url: string | URL, init?: { method?: string }) => {
      if (init?.method === 'PUT' && ++puts === 1) {
        return { status: 404, headers: { get: () => null } }; // blob upload unknown
      }
      return happy(url, init);
    };
    const sleeps: number[] = [];

    await awaitRegistryRoundTrip({
      port: 5000,
      repository: 'myproj',
      fetchImpl,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    expect(puts).toBe(2);
    expect(sleeps.length).toBe(1);
  });

  it('exhausts its budget with the LAST real error, naming the port', async () => {
    const { awaitRegistryRoundTrip } = await load();
    const fetchImpl = async () => ({ status: 500, headers: { get: () => null } });
    let t = 0;

    await expect(
      awaitRegistryRoundTrip({
        port: 5001,
        repository: 'myproj',
        fetchImpl,
        sleep: async () => {},
        nowFn: () => (t += 30_000),
      }),
    ).rejects.toThrow(/localhost:5001.*HTTP 500/s);
  });
});

describe('push gating on the round-trip probe', () => {
  let khPath: string;
  let fetchStub: ReturnType<typeof happyRegistryFetch>;

  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    pushExitCodes = [];
    pushStderrs = [];
    sshTunnelOutcomes = [];
    installSpawnMock();
    fetchStub = happyRegistryFetch();
    vi.stubGlobal('fetch', fetchStub);
    const tmp = mkdtempSync(join(tmpdir(), 'vc-registry-push-'));
    khPath = join(tmp, '.vibecarbon', 'known_hosts_e2e');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const args = () => ({
    tag: '127.0.0.1:5000/myproj:abc1234',
    remotePrefix: '127.0.0.1:5000/',
    serverIp: '1.2.3.4',
    sshKey: '/tmp/key',
    khPath,
    settleDelaysMs: [0, 0, 0],
  });

  it('the probe runs BEFORE any docker push, against the chosen port + repository', async () => {
    const { pushImageOverSshTunnel } = await modulePromise;
    const probeCalls: { port: number; repository: string; pushesAtProbeTime: number }[] = [];
    const registryProbe = async ({ port, repository }: { port: number; repository: string }) => {
      probeCalls.push({ port, repository, pushesAtProbeTime: pushCalls().length });
    };

    await pushImageOverSshTunnel(args(), { registryProbe });

    expect(probeCalls).toEqual([{ port: 5000, repository: 'myproj', pushesAtProbeTime: 0 }]);
    expect(pushCalls().length).toBe(1);
  });

  it('a probe failure consumes the attempt — the push waits for the condition instead of uploading into the void', async () => {
    const { pushImageOverSshTunnel } = await modulePromise;
    let probes = 0;
    const registryProbe = async () => {
      if (++probes === 1) throw new Error('registry round-trip probe: not serving yet');
    };

    await pushImageOverSshTunnel(args(), { registryProbe });

    expect(probes).toBe(2);
    expect(pushCalls().length).toBe(1);
  });

  it('probe exhaustion on every attempt fails the push WITHOUT ever spawning docker push', async () => {
    const { pushImageOverSshTunnel } = await modulePromise;
    const registryProbe = async () => {
      throw new Error('registry round-trip probe: backend never served read-after-write');
    };

    await expect(pushImageOverSshTunnel(args(), { registryProbe })).rejects.toThrow(
      /round-trip probe/,
    );
    expect(pushCalls().length).toBe(0);
  });

  it('default wiring: with no deps override, the real probe traffic hits the registry first', async () => {
    const { pushImageOverSshTunnel } = await modulePromise;

    await pushImageOverSshTunnel(args());

    const methods = fetchStub.mock.calls.map((c) => (c[1] as { method?: string })?.method);
    expect(methods).toContain('POST');
    expect(methods).toContain('PUT');
    expect(methods).toContain('HEAD');
    expect(String(fetchStub.mock.calls[0][0])).toContain('/v2/myproj/blobs/uploads/');
    expect(pushCalls().length).toBe(1);
  });
});

describe('push-failure endpoint fingerprint', () => {
  let khPath: string;
  let fetchStub: ReturnType<typeof happyRegistryFetch>;

  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    pushExitCodes = [];
    pushStderrs = [];
    sshTunnelOutcomes = [];
    installSpawnMock();
    fetchStub = happyRegistryFetch();
    vi.stubGlobal('fetch', fetchStub);
    const tmp = mkdtempSync(join(tmpdir(), 'vc-registry-push-'));
    khPath = join(tmp, '.vibecarbon', 'known_hosts_e2e');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a failed docker push records WHO answered /v2/ on that port — the 500-emitter gets named', async () => {
    // Run 31984725162: the round-trip probe PASSED seconds before docker push
    // got three 500s — and NEITHER registry logged any docker traffic, so the
    // 500s came from something else on the path that no captured log
    // identifies. The attempt error must therefore carry the endpoint's own
    // fingerprint (status, Docker-Distribution-Api-Version, body snippet)
    // taken through the SAME port immediately after the failure: a real
    // registry:2 answers /v2/ with the Distribution header; anything else
    // names itself by its absence.
    const { pushImageOverSshTunnel } = await modulePromise;
    pushExitCodes = [1, 1, 1];
    pushStderrs = [
      'received unexpected HTTP status: 500 Internal Server Error',
      'received unexpected HTTP status: 500 Internal Server Error',
      'received unexpected HTTP status: 500 Internal Server Error',
    ];

    await expect(
      pushImageOverSshTunnel({
        tag: '127.0.0.1:5000/myproj:abc1234',
        remotePrefix: '127.0.0.1:5000/',
        serverIp: '1.2.3.4',
        sshKey: '/tmp/key',
        khPath,
        settleDelaysMs: [0, 0, 0],
      }),
    ).rejects.toThrow(/endpoint after failure: GET \/v2\/ → HTTP 200.*registry\/2\.0/);
  });

  it('a failed attempt also carries the node-side :5000 listener census', async () => {
    // Run 31990220178 proved TWO distribution-API speakers: the fingerprint
    // got a registry/2.0 answer while the captured registry pod (0 restarts,
    // log covering the whole window) saw neither the docker traffic NOR the
    // fingerprint's own /v2/ GETs. Whatever else answers on the master's
    // :5000 path can only be identified from the node itself: ss -tlnp and
    // the NAT rules, captured over ssh into the same attempt error.
    const { pushImageOverSshTunnel } = await modulePromise;
    pushExitCodes = [1, 1, 1];
    pushStderrs = ['received unexpected HTTP status: 500 Internal Server Error', '', ''];

    await expect(
      pushImageOverSshTunnel({
        tag: '127.0.0.1:5000/myproj:abc1234',
        remotePrefix: '127.0.0.1:5000/',
        serverIp: '1.2.3.4',
        sshKey: '/tmp/key',
        khPath,
        settleDelaysMs: [0, 0, 0],
      }),
    ).rejects.toThrow(/node :5000 listeners\/rules:/);
  });

  it('the fingerprint reports a dead endpoint too (fetch itself failing)', async () => {
    const { pushImageOverSshTunnel } = await modulePromise;
    pushExitCodes = [1, 1, 1];
    pushStderrs = ['received unexpected HTTP status: 500 Internal Server Error', '', ''];
    // The probe must still pass (via deps) while the post-failure fingerprint
    // fetch (global) dies — mirrors a tunnel that collapses mid-push.
    fetchStub.mockImplementation(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5000');
    });

    await expect(
      pushImageOverSshTunnel(
        {
          tag: '127.0.0.1:5000/myproj:abc1234',
          remotePrefix: '127.0.0.1:5000/',
          serverIp: '1.2.3.4',
          sshKey: '/tmp/key',
          khPath,
          settleDelaysMs: [0, 0, 0],
        },
        { registryProbe: async () => {} },
      ),
    ).rejects.toThrow(/endpoint after failure: GET \/v2\/ failed: connect ECONNREFUSED/);
  });
});
