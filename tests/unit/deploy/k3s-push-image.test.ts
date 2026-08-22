import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every execFileSync call this module used to make (ssh tunnel open, docker
// tag, pkill teardown, docker rmi cleanup) now routes through
// runCommandAsync, which spawns rather than execFileSync's. Only `spawn`
// needs mocking post-migration; it plays two roles distinguished by argv:
//   - `docker push` — still a hand-rolled spawn (unchanged; a multi-minute
//     push must not block the event loop), listens on 'exit'.
//   - everything else (ssh -L / docker tag / pkill / docker rmi) — via
//     runCommandAsync, which listens on 'close' and (silent:true) reads
//     child.stdout/stderr 'data' events.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const k3sModulePromise = import('../../../src/lib/deploy/k8s/k3s.js');

// Codes the next spawn()ed `docker push` calls should exit with (shift per
// call). Empty → success (0). Lets retry/failure tests drive the push outcome.
let pushExitCodes: number[] = [];

// stderr text the next `docker push` spawns should emit (shift per call).
// Empty string → no stderr. Lets the transient/permanent classifier tests
// drive docker's error output (e.g. a `denied:` permanent failure).
let pushStderrs: string[] = [];

// Outcomes the next `ssh -N -f` tunnel-open spawns should produce (shift per
// call). Empty → success (exit 0). Lets the port-walk test drive a bind
// collision on the first port and success on the next.
let sshTunnelOutcomes: { code: number; stderr?: string }[] = [];

/**
 * Fake child for the hand-rolled `docker push` spawn (listens on 'exit').
 * The push spawn now pipes stderr (stdio ['ignore','inherit','pipe']) so the
 * transient/permanent classifier can read docker's error text — this fake
 * emits the stderr 'data' BEFORE 'exit' (microtask FIFO: the push()'s
 * stderr.on('data') registers before its child.on('exit'), so the accumulated
 * buffer is populated by the time the 'exit' handler builds the error).
 */
// When set, the next fake docker-push child defers its 'exit' until this
// promise resolves — lets a test observe held-during-push state (the uplink
// lock wiring test).
let pushHoldGate: Promise<void> | null = null;

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
      if (event === 'exit') {
        const gate = pushHoldGate ?? Promise.resolve();
        pushHoldGate = null;
        gate.then(() => cb(code));
      }
      return child;
    },
  };
  return child;
}

/**
 * Fake child for the `ssh -N -f` tunnel open. The real openSshTunnel helper
 * settles on 'exit', NOT 'close' — because OpenSSH's `-f` daemonizes and the
 * background child keeps the piped stdout/stderr fds open for the tunnel's
 * whole lifetime, so 'close' never fires on SUCCESS. This fake mirrors that:
 * it emits 'exit' (and stderr data on failure) but DELIBERATELY NEVER emits
 * 'close' and never ends its stderr stream. Against the old settle-on-close
 * code this would hang forever (RED); the new exit-based helper resolves
 * promptly (GREEN).
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
      // Only 'exit' ever fires — the ssh -f daemon holds the fds open so
      // 'close' would never arrive on a real successful tunnel open.
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
    // runCommandAsync (settle-on-close) and succeed by default in every test.
    return fakeExecChild(0) as unknown as ReturnType<typeof spawn>;
  }) as unknown as typeof spawn);
}

/** All spawn() calls except the `docker push` ones, in call order. */
function nonPushCalls() {
  return vi
    .mocked(spawn)
    .mock.calls.filter((c) => !(c[0] === 'docker' && (c[1] as string[])[0] === 'push'));
}

describe('pushImageToLocalRegistry (Phase 6)', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    pushExitCodes = [];
    pushStderrs = [];
    sshTunnelOutcomes = [];
    installSpawnMock();
    // Happy registry v2 fake for the round-trip probe that now gates every
    // push attempt (see registry-push.test.ts's probe suites for its own
    // coverage) — these tests pin the tunnel/push mechanics around it.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: { method?: string }) => {
        const method = init?.method ?? 'GET';
        const headers = {
          get: (h: string) =>
            method === 'POST' && h.toLowerCase() === 'location'
              ? `${String(url)}probe-upload-1`
              : null,
        };
        if (method === 'POST') return { status: 202, headers };
        if (method === 'PUT') return { status: 201, headers };
        if (method === 'HEAD') return { status: 200, headers };
        return { status: 202, headers };
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('tunnel open resolves on ssh exit even when the child never fires close (ssh -f holds pipes open)', async () => {
    // Regression for the settle-on-close hang: the ssh -f daemon inherits the
    // piped stdout/stderr fds and keeps them open for the tunnel's lifetime,
    // so 'close' never fires on success. fakeTunnelChild emits 'exit' (code 0)
    // but NEVER 'close'. The old runCommandAsync-based open listened on
    // 'close' and would hang here; the exit-based openSshTunnel resolves.
    const { pushImageToLocalRegistry } = await k3sModulePromise;

    const tmp = mkdtempSync(join(tmpdir(), 'vc-k3s-push-'));
    const khPath = join(tmp, '.vibecarbon', 'known_hosts_e2e');

    // A generous-but-finite timeout: if the open ever regresses to
    // settle-on-close, this rejects instead of hanging the whole suite.
    await expect(
      Promise.race([
        pushImageToLocalRegistry({
          tag: '10.0.1.1:5000/p:t',
          masterIp: '1.2.3.4',
          sshKey: '/tmp/k',
          khPath,
          settleDelaysMs: [0, 0, 0, 0, 0],
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('tunnel open hung (never settled)')), 2_000),
        ),
      ]),
    ).resolves.toBeUndefined();

    // Exactly one ssh tunnel-open call succeeded on the first port.
    const sshCalls = nonPushCalls().filter((c) => c[0] === 'ssh');
    expect(sshCalls.length).toBe(1);
  });

  it('bind failure (ssh exit 255) walks forward to the next port', async () => {
    // First port collides (ExitOnForwardFailure=yes → exit 255 with a
    // bind-diagnostic on stderr); the walk must advance to the next port and
    // succeed there. Proves the failure path is still detectable now that we
    // settle on 'exit' rather than 'close'.
    const { pushImageToLocalRegistry } = await k3sModulePromise;
    sshTunnelOutcomes = [
      { code: 255, stderr: 'bind [127.0.0.1]:5000: Address already in use' },
      { code: 0 },
    ];

    const tmp = mkdtempSync(join(tmpdir(), 'vc-k3s-push-'));
    const khPath = join(tmp, '.vibecarbon', 'known_hosts_e2e');

    await expect(
      pushImageToLocalRegistry({
        tag: '10.0.1.1:5000/p:t',
        masterIp: '1.2.3.4',
        sshKey: '/tmp/k',
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
    const pushCall = vi
      .mocked(spawn)
      .mock.calls.find((c) => c[0] === 'docker' && (c[1] as string[])[0] === 'push');
    expect(pushCall).toBeDefined();
    expect((pushCall as unknown as [string, string[]])[1][1]).toBe('localhost:5001/p:t');
  });

  it('holds the cross-process uplink lock for the duration of the push, then frees it', async () => {
    // Wiring pin for mitigation-audit cluster 2: the per-process chain cannot
    // see matrix siblings, so every push must hold the HOST-wide file lock
    // (real fs, per-worker temp dir via VIBECARBON_UPLINK_LOCK_DIR). Unwiring
    // acquireUplinkLock from acquireTunnelPushLock makes this fail.
    const { pushImageToLocalRegistry } = await k3sModulePromise;
    const { UPLINK_LOCK_DIR } = await import('../../../src/lib/deploy/uplink-lock.js');
    const { existsSync, readFileSync } = await import('node:fs');
    const { join: joinPath } = await import('node:path');

    const tmp = mkdtempSync(join(tmpdir(), 'vc-k3s-push-'));
    const khPath = join(tmp, '.vibecarbon', 'known_hosts_e2e');

    let openGate!: () => void;
    pushHoldGate = new Promise<void>((r) => {
      openGate = r;
    });

    const pending = pushImageToLocalRegistry({
      tag: '10.0.1.1:5000/myproj:abc1234-20260428000000',
      masterIp: '1.2.3.4',
      sshKey: '/tmp/key',
      khPath,
      settleDelaysMs: [0, 0, 0, 0, 0],
    });

    // While the docker push is gated open, the host-wide lock must be held by
    // THIS process.
    await vi.waitFor(() => {
      expect(existsSync(UPLINK_LOCK_DIR)).toBe(true);
    });
    const holder = JSON.parse(readFileSync(joinPath(UPLINK_LOCK_DIR, 'holder.json'), 'utf-8'));
    expect(holder.pid).toBe(process.pid);

    openGate();
    await pending;
    // Released on completion — a held lock after the push would serialize the
    // NEXT process against a finished transfer.
    expect(existsSync(UPLINK_LOCK_DIR)).toBe(false);
  });

  it('opens SSH tunnel, retags, async-pushes the localhost alias, tears down + cleans up', async () => {
    const { pushImageToLocalRegistry } = await k3sModulePromise;

    const tmp = mkdtempSync(join(tmpdir(), 'vc-k3s-push-'));
    const khPath = join(tmp, '.vibecarbon', 'known_hosts_e2e');

    const tag = '10.0.1.1:5000/myproj:abc1234-20260428000000';
    const localTag = 'localhost:5000/myproj:abc1234-20260428000000';

    await pushImageToLocalRegistry({
      tag,
      masterIp: '1.2.3.4',
      sshKey: '/tmp/key',
      khPath,
      settleDelaysMs: [0, 0, 0, 0, 0],
    });

    // Non-push call order: ssh tunnel open, docker tag, pkill teardown
    // (finally), docker rmi cleanup (after success).
    const calls = nonPushCalls();
    expect(calls.length).toBe(4);

    // Call 0: ssh tunnel open with proper host-key opts + BatchMode=yes
    const [sshBin, sshArgv] = calls[0] as [string, string[]];
    expect(sshBin).toBe('ssh');
    expect(sshArgv).toContain('-L');
    expect(sshArgv).toContain('5000:localhost:5000');
    expect(sshArgv).toContain('-N');
    expect(sshArgv).toContain('-f');
    expect(sshArgv).toContain('root@1.2.3.4');
    expect(sshArgv).toContain('BatchMode=yes');
    expect(sshArgv).toContain('ExitOnForwardFailure=yes');

    // Call 1: docker tag <orig> <localhost-alias>
    expect(calls[1][0]).toBe('docker');
    expect(calls[1][1]).toEqual(['tag', tag, localTag]);

    // Call 2: pkill teardown in finally — scoped to OUR port.
    expect(calls[2][0]).toBe('pkill');
    expect(calls[2][1]).toEqual(['-f', 'ssh.*-L.*5000:localhost:5000']);

    // Call 3: best-effort cleanup of the localhost alias
    expect(calls[3][0]).toBe('docker');
    expect(calls[3][1]).toEqual(['rmi', localTag]);

    // The push went through spawn (async), targeting the localhost alias.
    const pushCalls = vi
      .mocked(spawn)
      .mock.calls.filter((c) => c[0] === 'docker' && (c[1] as string[])[0] === 'push');
    expect(pushCalls.length).toBe(1);
    const pushArgv = pushCalls[0][1] as string[];
    expect(pushArgv).toEqual(['push', localTag]);
  });

  it('docker push targets localhost:5000 (not the cluster-internal IP)', async () => {
    const { pushImageToLocalRegistry } = await k3sModulePromise;

    const tmp = mkdtempSync(join(tmpdir(), 'vc-k3s-push-'));
    const khPath = join(tmp, '.vibecarbon', 'known_hosts_e2e');

    const tag = '10.0.1.1:5000/foo-bar:deadbee-dirty-20260428120000';
    await pushImageToLocalRegistry({
      tag,
      masterIp: '5.6.7.8',
      sshKey: '/tmp/k',
      khPath,
      settleDelaysMs: [0, 0, 0, 0, 0],
    });

    const pushCall = vi
      .mocked(spawn)
      .mock.calls.find((c) => c[0] === 'docker' && (c[1] as string[])[0] === 'push');
    expect(pushCall).toBeDefined();
    const pushArgv = (pushCall as unknown as [string, string[]])[1];
    expect(pushArgv).toEqual(['push', 'localhost:5000/foo-bar:deadbee-dirty-20260428120000']);
    // Regression guard: the push argv must NOT carry the cluster-internal IP.
    expect(pushArgv[1]).not.toMatch(/^10\.0\.1\.1:/);
  });

  it('localTunnelPort scopes both the SSH -L spec and the docker push tag', async () => {
    const { pushImageToLocalRegistry } = await k3sModulePromise;

    const tmp = mkdtempSync(join(tmpdir(), 'vc-k3s-push-'));
    const khPath = join(tmp, '.vibecarbon', 'known_hosts_e2e');

    await pushImageToLocalRegistry({
      tag: '10.0.1.1:5000/proj:tag',
      masterIp: '9.9.9.9',
      sshKey: '/tmp/k',
      khPath,
      localTunnelPort: 5001,
      settleDelaysMs: [0, 0, 0, 0, 0],
    });

    // SSH tunnel must use port 5001 on the operator side, 5000 on master.
    const sshCall = nonPushCalls().find((c) => c[0] === 'ssh' && (c[1] as string[]).includes('-L'));
    expect(sshCall).toBeDefined();
    const sshArgv = (sshCall as [string, string[]])[1];
    const lIdx = sshArgv.indexOf('-L');
    expect(sshArgv[lIdx + 1]).toBe('5001:localhost:5000');

    // The pushed tag must dial localhost:5001, not :5000.
    const pushCall = vi
      .mocked(spawn)
      .mock.calls.find((c) => c[0] === 'docker' && (c[1] as string[])[0] === 'push');
    expect(pushCall).toBeDefined();
    const pushArgv = (pushCall as unknown as [string, string[]])[1];
    expect(pushArgv[1]).toBe('localhost:5001/proj:tag');

    // pkill teardown pattern must include the same port.
    const pkillCall = nonPushCalls().find((c) => c[0] === 'pkill');
    expect(pkillCall).toBeDefined();
    const pkillArgv = (pkillCall as [string, string[]])[1];
    expect(pkillArgv).toEqual(['-f', 'ssh.*-L.*5001:localhost:5000']);
  });

  it('rejects an invalid localTunnelPort', async () => {
    const { pushImageToLocalRegistry } = await k3sModulePromise;
    await expect(
      pushImageToLocalRegistry({
        tag: '10.0.1.1:5000/p:t',
        masterIp: '1.2.3.4',
        sshKey: '/tmp/k',
        khPath: '/tmp/kh',
        localTunnelPort: 70000,
      }),
    ).rejects.toThrow(/localTunnelPort/);
  });

  it('idempotency: succeeds even when a stale tunnel exists at start', async () => {
    const { pushImageToLocalRegistry } = await k3sModulePromise;

    const tmp = mkdtempSync(join(tmpdir(), 'vc-k3s-push-'));
    const khPath = join(tmp, '.vibecarbon', 'known_hosts_e2e');

    await expect(
      pushImageToLocalRegistry({
        tag: '10.0.1.1:5000/p:t',
        masterIp: '1.2.3.4',
        sshKey: '/tmp/k',
        khPath,
        settleDelaysMs: [0, 0, 0, 0, 0],
      }),
    ).resolves.toBeUndefined();

    // ssh, tag, pkill, rmi (push is on its own spawn role).
    expect(nonPushCalls().length).toBe(4);
    const pushCalls = vi
      .mocked(spawn)
      .mock.calls.filter((c) => c[0] === 'docker' && (c[1] as string[])[0] === 'push');
    expect(pushCalls.length).toBe(1);
  });

  it('retries with backoff and succeeds on a later attempt', async () => {
    const { pushImageToLocalRegistry } = await k3sModulePromise;
    pushExitCodes = [1, 0]; // attempt 1 push fails, attempt 2 push ok

    const tmp = mkdtempSync(join(tmpdir(), 'vc-k3s-push-'));
    const khPath = join(tmp, '.vibecarbon', 'known_hosts_e2e');

    await expect(
      pushImageToLocalRegistry({
        tag: '10.0.1.1:5000/p:t',
        masterIp: '1.2.3.4',
        sshKey: '/tmp/k',
        khPath,
        settleDelaysMs: [0, 0, 0],
      }),
    ).resolves.toBeUndefined();

    // Two push attempts.
    const pushCalls = vi
      .mocked(spawn)
      .mock.calls.filter((c) => c[0] === 'docker' && (c[1] as string[])[0] === 'push');
    expect(pushCalls.length).toBe(2);
    // Non-push calls: attempt1 ssh+tag+pkill, attempt2 ssh+pkill (tag dedup),
    // then rmi. Tunnel opens (-N) stay at exactly 2; the failed attempt also
    // runs one plain-ssh node-listener census, which is not a tunnel.
    const ef = nonPushCalls();
    expect(ef.filter((c) => c[0] === 'ssh' && (c[1] as string[]).includes('-N')).length).toBe(2);
    expect(ef.filter((c) => c[0] === 'docker' && (c[1] as string[])[0] === 'tag').length).toBe(1);
    expect(ef.filter((c) => c[0] === 'docker' && (c[1] as string[])[0] === 'rmi').length).toBe(1);
  });

  it('fails FAST (single push attempt) on a permanent error (denied/auth) — no settle-ladder burn', async () => {
    // A `denied:`/`unauthorized:` push can never succeed on retry — retrying
    // just burns the ~3.5min settle ladder before the inevitable failure.
    // The classifier must recognize the permanent stderr and stop after ONE
    // attempt. pushExitCodes has three 1s available but only the first is used.
    const { pushImageToLocalRegistry } = await k3sModulePromise;
    pushExitCodes = [1, 1, 1];
    pushStderrs = ['denied: requested access to the resource is denied'];

    const tmp = mkdtempSync(join(tmpdir(), 'vc-k3s-push-'));
    const khPath = join(tmp, '.vibecarbon', 'known_hosts_e2e');

    await expect(
      pushImageToLocalRegistry({
        tag: '10.0.1.1:5000/p:t',
        masterIp: '1.2.3.4',
        sshKey: '/tmp/k',
        khPath,
        settleDelaysMs: [0, 0, 0, 0, 0],
      }),
    ).rejects.toThrow(/denied/);

    // Exactly ONE push attempt — the permanent error short-circuited the ladder.
    const pushCalls = vi
      .mocked(spawn)
      .mock.calls.filter((c) => c[0] === 'docker' && (c[1] as string[])[0] === 'push');
    expect(pushCalls.length).toBe(1);
  });

  it('RETRIES a transient push error (503 SlowDown) and succeeds on a later attempt', async () => {
    // A registry/S3 blip (`503 Service Unavailable`) IS recoverable — the
    // classifier must NOT fail fast on it; the settle ladder rides it out.
    const { pushImageToLocalRegistry } = await k3sModulePromise;
    pushExitCodes = [1, 0];
    pushStderrs = ['received unexpected HTTP status: 503 Service Unavailable', ''];

    const tmp = mkdtempSync(join(tmpdir(), 'vc-k3s-push-'));
    const khPath = join(tmp, '.vibecarbon', 'known_hosts_e2e');

    await expect(
      pushImageToLocalRegistry({
        tag: '10.0.1.1:5000/p:t',
        masterIp: '1.2.3.4',
        sshKey: '/tmp/k',
        khPath,
        settleDelaysMs: [0, 0, 0],
      }),
    ).resolves.toBeUndefined();

    const pushCalls = vi
      .mocked(spawn)
      .mock.calls.filter((c) => c[0] === 'docker' && (c[1] as string[])[0] === 'push');
    expect(pushCalls.length).toBe(2);
  });

  it('throws after exhausting all attempts', async () => {
    const { pushImageToLocalRegistry } = await k3sModulePromise;
    pushExitCodes = [1, 1, 1]; // every push attempt fails

    await expect(
      pushImageToLocalRegistry({
        tag: '10.0.1.1:5000/p:t',
        masterIp: '1.2.3.4',
        sshKey: '/tmp/k',
        khPath: '/tmp/kh',
        settleDelaysMs: [0, 0, 0],
      }),
    ).rejects.toThrow(/docker push.*failed after 3 attempts/);

    const pushCalls = vi
      .mocked(spawn)
      .mock.calls.filter((c) => c[0] === 'docker' && (c[1] as string[])[0] === 'push');
    expect(pushCalls.length).toBe(3);
  });

  it('rejects tags missing the 10.0.1.1:5000/ build prefix', async () => {
    const { pushImageToLocalRegistry } = await k3sModulePromise;
    await expect(
      pushImageToLocalRegistry({
        tag: 'wrong.example.com:5000/p:t',
        masterIp: '1.2.3.4',
        sshKey: '/tmp/k',
        khPath: '/tmp/kh',
      }),
    ).rejects.toThrow(/expected tag prefixed with '10\.0\.1\.1:5000\/'/);
  });

  it('throws on missing required args', async () => {
    const { pushImageToLocalRegistry } = await k3sModulePromise;
    await expect(
      pushImageToLocalRegistry({
        tag: '',
        masterIp: '1.2.3.4',
        sshKey: '/tmp/k',
        khPath: '/tmp/kh',
      }),
    ).rejects.toThrow(/tag is required/);
    await expect(
      pushImageToLocalRegistry({
        tag: 't',
        masterIp: '',
        sshKey: '/tmp/k',
        khPath: '/tmp/kh',
      }),
    ).rejects.toThrow(/masterIp is required/);
  });
});
