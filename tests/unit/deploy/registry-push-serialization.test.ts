import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Concurrent tunnel pushes contend on the operator uplink.
 *
 * `applyK3sManifests` fans primary + standby out concurrently in an HA deploy,
 * and each side kicks off its own `pushImageOverSshTunnel` in the background.
 * On a slow/asymmetric uplink the two multi-hundred-MB uploads thrash each
 * other: an SSH-tunnelled blob PUT stalls mid-transfer, the registry drops the
 * upload session, and every subsequent layer PUT comes back `unknown blob` /
 * `blob upload unknown` / `500`. Live evidence (2026-08-12 hetzner/k8s-ha
 * restore re-deploy): primary burned 5/5 attempts while standby only succeeded
 * on the one attempt that ran ALONE, after primary had given up.
 *
 * These tests pin the structural fix: at most one `pushImageOverSshTunnel`
 * transfer runs per process, and the lock survives a failed peer.
 *
 * Harness note: `node:child_process` is deliberately NOT mocked — builtin
 * mocks are non-deterministic under the parallel unit run (sibling files
 * import the same src modules unmocked). Instead we hand `pushImageOverSshTunnel`
 * a fake `spawn` through its `deps` seam, and mock the two src modules it
 * shells out / logs through (`command.js`, `cli/progress.js`).
 */

const hoisted = vi.hoisted(() => ({
  progressLines: [] as string[],
  runCommandCalls: [] as string[][],
}));

vi.mock('../../../src/lib/cli/progress.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/cli/progress.js')>();
  return {
    ...actual,
    progressLog: (message: string) => {
      hoisted.progressLines.push(message);
    },
  };
});

vi.mock('../../../src/lib/command.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/command.js')>();
  return {
    ...actual,
    // docker tag / pkill teardown / docker rmi cleanup — all no-op successes.
    runCommandAsync: async (argv: string[]) => {
      hoisted.runCommandCalls.push(argv);
      return { success: true, stdout: '', stderr: '', code: 0 };
    },
  };
});

const modulePromise = import('../../../src/lib/deploy/registry-push.js');

// --- fake spawn -------------------------------------------------------------

type SpawnState = {
  /** Ordered transfer-phase log: `start:<repo>` / `end:<repo>`. */
  events: string[];
  /** Per-repo docker push exit codes, shifted per attempt (empty → 0). */
  pushCodes: Record<string, number[]>;
  /** Resolves when the in-flight `docker push` for `repo` should exit. */
  settle: (repo: string) => Promise<void>;
};

/** Fake `ssh -N -f` child: settles on 'exit' only (never 'close'), like `-f`. */
function fakeTunnelChild(code: number) {
  const child: Record<string, unknown> = {
    unref() {},
    stdout: null,
    stderr: { on() {}, destroy() {} },
    on(event: string, cb: (...a: unknown[]) => void) {
      if (event === 'exit') Promise.resolve().then(() => cb(code, null));
      return child;
    },
  };
  return child;
}

/** Fake `docker push` child that brackets its transfer phase in `events`. */
function fakePushChild(state: SpawnState, repo: string, code: number) {
  state.events.push(`start:${repo}`);
  const child: Record<string, unknown> = {
    stderr: { on() {} },
    on(event: string, cb: (...a: unknown[]) => void) {
      if (event === 'exit') {
        state.settle(repo).then(() => {
          state.events.push(`end:${repo}`);
          cb(code);
        });
      }
      return child;
    },
  };
  return child;
}

function makeFakeSpawn(state: SpawnState) {
  return (cmd: string, args: string[]) => {
    if (cmd === 'ssh') return fakeTunnelChild(0);
    if (cmd === 'docker' && args[0] === 'push') {
      // localTag is `localhost:<port>/<repo>:<tag>`.
      const repo = String(args[1]).split('/')[1].split(':')[0];
      const codes = state.pushCodes[repo] ?? [];
      return fakePushChild(state, repo, codes.length ? (codes.shift() as number) : 0);
    }
    throw new Error(`unexpected spawn in test: ${cmd} ${args.join(' ')}`);
  };
}

/** A push that finishes only when its gate is released. */
function makeGate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

/**
 * True when `events` ever has two transfer phases open at once — the exact
 * condition that produced the `unknown blob` cascade in production.
 */
function everOverlapped(events: string[]) {
  let open = 0;
  for (const e of events) {
    if (e.startsWith('start:')) open++;
    else open--;
    if (open > 1) return true;
  }
  return false;
}

describe('pushImageOverSshTunnel serializes concurrent tunnel pushes', () => {
  let khPath: string;
  let state: SpawnState;

  // settleDelaysMs [0,0,0] keeps the suite fast (the real k8s default ladder
  // opens with a 1s tunnel-bind settle per attempt) and fixes the attempt
  // count at 3 for the ladder-scoped-lock assertions.
  const args = (repo: string) => ({
    tag: `10.0.1.1:5000/${repo}:abc1234`,
    remotePrefix: '10.0.1.1:5000/',
    serverIp: '1.2.3.4',
    sshKey: '/tmp/key',
    khPath,
    settleDelaysMs: [0, 0, 0],
  });

  beforeEach(() => {
    hoisted.progressLines = [];
    hoisted.runCommandCalls = [];
    // Happy registry v2 fake for the round-trip probe that now gates every
    // push attempt — this file pins the mutex mechanics around it.
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
    const tmp = mkdtempSync(join(tmpdir(), 'vc-push-serial-'));
    khPath = join(tmp, '.vibecarbon', 'known_hosts_e2e');
    state = {
      events: [],
      pushCodes: {},
      // Default: a push occupies the link for a real (short) interval, so two
      // unserialized pushes WOULD demonstrably overlap.
      settle: () => new Promise<void>((r) => setTimeout(r, 25)),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('S1: two concurrent pushes never overlap their transfer phases', async () => {
    const { pushImageOverSshTunnel } = await modulePromise;
    const spawnFn = makeFakeSpawn(state);

    const primary = pushImageOverSshTunnel(args('proja'), { spawn: spawnFn });
    const standby = pushImageOverSshTunnel(args('projb'), { spawn: spawnFn });
    await Promise.all([primary, standby]);

    // Strict ordering: the second push does not even START until the first
    // has finished. Per-attempt interleaving would show up as
    // start:proja, start:projb, ...
    expect(state.events).toEqual(['start:proja', 'end:proja', 'start:projb', 'end:projb']);
    expect(everOverlapped(state.events)).toBe(false);
  });

  it('S2: the waiting push surfaces a diagnosable progress line', async () => {
    const { pushImageOverSshTunnel } = await modulePromise;
    const spawnFn = makeFakeSpawn(state);

    await Promise.all([
      pushImageOverSshTunnel(args('proja'), { spawn: spawnFn }),
      pushImageOverSshTunnel(args('projb'), { spawn: spawnFn }),
    ]);

    const waiting = hoisted.progressLines.filter((l) =>
      l.includes('waiting for concurrent push to finish'),
    );
    expect(waiting.length).toBe(1);
    expect(waiting[0]).toContain('projb');
    // ...and the acquisition is logged too, so a stalled peer's cost is minable.
    expect(hoisted.progressLines.some((l) => /acquired push lock after \d+s/.test(l))).toBe(true);
  });

  it('S3: the lock is held across the WHOLE retry ladder, not per attempt', async () => {
    const { pushImageOverSshTunnel } = await modulePromise;
    const spawnFn = makeFakeSpawn(state);
    // proja fails its first two attempts, succeeds on the third. If the lock
    // were per-attempt, projb would slip in between proja's attempts.
    state.pushCodes = { proja: [1, 1, 0] };

    const primary = pushImageOverSshTunnel(args('proja'), { spawn: spawnFn });
    const standby = pushImageOverSshTunnel(args('projb'), { spawn: spawnFn });
    await Promise.all([primary, standby]);

    expect(state.events).toEqual([
      'start:proja',
      'end:proja',
      'start:proja',
      'end:proja',
      'start:proja',
      'end:proja',
      'start:projb',
      'end:projb',
    ]);
  });

  it('S4: a push that exhausts its ladder does not poison the lock for the next one', async () => {
    const { pushImageOverSshTunnel } = await modulePromise;
    const spawnFn = makeFakeSpawn(state);
    state.pushCodes = { proja: [1, 1, 1] };

    const primary = pushImageOverSshTunnel(args('proja'), { spawn: spawnFn });
    const standby = pushImageOverSshTunnel(args('projb'), { spawn: spawnFn });
    const [a, b] = await Promise.allSettled([primary, standby]);

    expect(a.status).toBe('rejected');
    expect((a as PromiseRejectedResult).reason.message).toMatch(/failed after 3 attempts/);
    // The whole point: B still ran, and ran alone.
    expect(b.status).toBe('fulfilled');
    expect(state.events.filter((e) => e === 'start:projb')).toEqual(['start:projb']);
    expect(everOverlapped(state.events)).toBe(false);
  });

  it('S5: a permanently-failing push releases the lock too (fast-fail path)', async () => {
    const { pushImageOverSshTunnel } = await modulePromise;
    const spawnFn = (cmd: string, argv: string[]) => {
      if (cmd === 'docker' && argv[0] === 'push') {
        const repo = String(argv[1]).split('/')[1].split(':')[0];
        if (repo === 'proja') {
          state.events.push(`start:${repo}`);
          const child: Record<string, unknown> = {
            stderr: {
              on(event: string, cb: (chunk: unknown) => void) {
                if (event === 'data') {
                  Promise.resolve().then(() =>
                    cb(Buffer.from('denied: requested access to the resource is denied')),
                  );
                }
              },
            },
            on(event: string, cb: (...a: unknown[]) => void) {
              if (event === 'exit') {
                state.settle(repo).then(() => {
                  state.events.push(`end:${repo}`);
                  cb(1);
                });
              }
              return child;
            },
          };
          return child;
        }
      }
      return makeFakeSpawn(state)(cmd, argv);
    };

    const primary = pushImageOverSshTunnel(args('proja'), { spawn: spawnFn });
    const standby = pushImageOverSshTunnel(args('projb'), { spawn: spawnFn });
    const [a, b] = await Promise.allSettled([primary, standby]);

    expect(a.status).toBe('rejected');
    expect(b.status).toBe('fulfilled');
    // Permanent error short-circuits the ladder after ONE attempt, and the
    // lock is handed over immediately rather than after the full ladder.
    expect(state.events).toEqual(['start:proja', 'end:proja', 'start:projb', 'end:projb']);
  });

  it('S6: argument validation rejects WITHOUT queueing behind an in-flight push', async () => {
    const { pushImageOverSshTunnel } = await modulePromise;
    const gate = makeGate();
    state.settle = () => gate.promise;
    const spawnFn = makeFakeSpawn(state);

    const inflight = pushImageOverSshTunnel(args('proja'), { spawn: spawnFn });
    // Let the in-flight push reach its (gated) transfer phase.
    await vi.waitFor(() => expect(state.events).toEqual(['start:proja']));

    await expect(
      pushImageOverSshTunnel(
        { ...args('projb'), tag: 'wrong.example.com:5000/projb:abc1234' },
        { spawn: spawnFn },
      ),
    ).rejects.toThrow(/expected tag prefixed with '10\.0\.1\.1:5000\/'/);

    // The bad call did not wait for the lock: proja is still mid-transfer.
    expect(state.events).toEqual(['start:proja']);
    gate.release();
    await inflight;
  });
});
