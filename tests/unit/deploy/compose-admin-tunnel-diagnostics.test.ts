/**
 * Unit tests for the DIAGNOSTICS half of compose/index.js `createAdminUser`'s
 * Phase B (the `ssh -L` tunnel to Kong) — the retry/budget contract itself is
 * pinned separately in compose-admin-user-retry.test.ts.
 *
 * Motivating incident (compose-ha warm redeploy, 2026-07-31 ~23:07Z): Phase A
 * passed (GoTrue answered its own health check in-container), Phase B failed
 * all three attempts with the bare wrapper message "Could not reach auth
 * service via SSH tunnel", and the deploy correctly failed loud — but with
 * ZERO evidence of WHY. The tunnel child was spawned `stdio: 'ignore'` (so a
 * bind collision, an sshd MaxStartups drop or an auth error were all
 * invisible), `waitForGotrueHealth` returns a bare boolean (so the per-poll
 * fetch errors were discarded), and the retry log line only carried the
 * wrapper message. RCA was impossible without re-running.
 *
 * These tests pin the evidence that must now survive a failure:
 *   - the ssh child's stderr tail + exit code/signal (or spawn error),
 *   - the LAST fetch error from the health poll (code + message),
 *   - both of the above in every per-attempt retry log line,
 *   - the tunnel child killed on success, failure AND throw,
 *   - the bind-conflict class made visible AND survivable via a port walk
 *     (19876 → 19885), mirroring registry-push.js's ssh-tunnel port walk.
 *
 * Seams: `spawnImpl` / `fetchImpl` are injected through `createAdminUser`'s
 * opts (same DI convention as admin-user.js's `fetchImpl`) rather than
 * mocking `node:child_process` — builtin-module mocks are not reliably
 * scoped per test file under the full parallel unit run (see
 * compose-admin-user-retry.test.ts's header for the full rationale), and the
 * whole point of these tests is to assert on the spawned child.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:timers/promises', () => ({
  setTimeout: (ms?: number, value?: unknown) =>
    new Promise((resolve) => setTimeout(() => resolve(value), ms)),
}));

const runCommandAsync = vi.fn();
vi.mock('../../../src/lib/command.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/lib/command.js')>(
    '../../../src/lib/command.js',
  );
  return { ...actual, runCommandAsync: (...args: unknown[]) => runCommandAsync(...args) };
});

const waitForGotrueHealth = vi.fn();
const postAdminUser = vi.fn();
vi.mock('../../../src/lib/deploy/admin-user.js', () => ({
  waitForGotrueHealth: (...args: unknown[]) => waitForGotrueHealth(...args),
  postAdminUser: (...args: unknown[]) => postAdminUser(...args),
}));

const progressLog = vi.fn();
vi.mock('../../../src/lib/cli/progress.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/lib/cli/progress.js')>(
    '../../../src/lib/cli/progress.js',
  );
  return { ...actual, progressLog: (...args: unknown[]) => progressLog(...args) };
});

const composePromise = import('../../../src/lib/deploy/compose/index.js');

/** GoTrue's own /health response text — what Phase A greps for. */
const GOTRUE_HEALTHY = 'GoTrue is healthy';

type TunnelBehavior = {
  /** stderr text ssh emits before exiting (feeds the bounded stderr tail). */
  stderr?: string;
  /** Present → the child exits with this code (255 = ssh's own failure code). */
  exitCode?: number;
  signal?: string;
  /** Present → the child emits 'error' instead (spawn-level failure, ENOENT). */
  spawnError?: Error;
  /** Suppress the 'close' event to exercise the exit-without-flush fallback. */
  noClose?: boolean;
};

type FakeChild = {
  kill: ReturnType<typeof vi.fn>;
  stderr: { destroy: ReturnType<typeof vi.fn> };
};

/**
 * Fake `ssh -N -L` child. Emits in real spawn order (stderr 'data' → 'exit' →
 * 'close'); a behavior with no `exitCode`/`spawnError` models a HEALTHY tunnel
 * that just sits there forwarding until it is killed.
 */
function fakeTunnelChild(behavior: TunnelBehavior) {
  const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  const add = (ev: string, cb: (...a: unknown[]) => void) => {
    handlers[ev] = [...(handlers[ev] ?? []), cb];
  };
  const emit = (ev: string, ...args: unknown[]) => {
    for (const cb of handlers[ev] ?? []) cb(...args);
  };
  const child = {
    stderr: {
      on(ev: string, cb: (...a: unknown[]) => void) {
        add(`stderr:${ev}`, cb);
        return child.stderr;
      },
      destroy: vi.fn(),
    },
    on(ev: string, cb: (...a: unknown[]) => void) {
      add(ev, cb);
      return child;
    },
    kill: vi.fn(),
  };
  // Handlers are registered synchronously by openAdminTunnel, so a microtask
  // is late enough to reach all of them and early enough to beat any timer.
  queueMicrotask(() => {
    if (behavior.spawnError) {
      emit('error', behavior.spawnError);
      return;
    }
    if (behavior.stderr) emit('stderr:data', Buffer.from(behavior.stderr));
    if (behavior.exitCode !== undefined) {
      emit('exit', behavior.exitCode, behavior.signal ?? null);
      if (!behavior.noClose) emit('close', behavior.exitCode, behavior.signal ?? null);
    }
  });
  return child;
}

/** Real OpenSSH stderr for a local-forward bind collision on `port`. */
function bindConflictStderr(port: number) {
  return (
    `bind [127.0.0.1]:${port}: Address already in use\n` +
    `channel_setup_fwd_listener_tcpip: cannot listen to port: ${port}\n` +
    'Could not request local forwarding.\n'
  );
}

/** Node's `fetch` failure shape: TypeError('fetch failed') + a coded cause. */
function fetchFailed(detail = 'connect ECONNREFUSED 127.0.0.1:19876', code = 'ECONNREFUSED') {
  const cause = new Error(detail) as Error & { code?: string };
  cause.code = code;
  const err = new TypeError('fetch failed') as TypeError & { cause?: unknown };
  err.cause = cause;
  return err;
}

function makeFakeSpawn(pick: (index: number, args: string[]) => TunnelBehavior) {
  const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const children: FakeChild[] = [];
  const spawnImpl = vi.fn((cmd: string, args: string[], opts: Record<string, unknown>) => {
    const index = calls.length;
    calls.push({ cmd, args, opts });
    const child = fakeTunnelChild(pick(index, args));
    children.push(child as unknown as FakeChild);
    return child;
  });
  return { spawnImpl, calls, children };
}

/** A tunnel that opens and stays up. */
const HEALTHY_TUNNEL: TunnelBehavior = {};

/** waitForGotrueHealth stub that never settles (the tunnel decides the race). */
const neverHealthy = () => new Promise<boolean>(() => {});

/**
 * waitForGotrueHealth stub that reports healthy only after a tick. A real
 * poll always costs at least one fetch round-trip, so an instantly-resolved
 * stub would let "healthy" win a race against a tunnel that died in the same
 * microtask queue — an artifact of the fake, not of the code under test.
 */
const healthyAfterTick = () => new Promise<boolean>((resolve) => setTimeout(resolve, 50, true));

/**
 * waitForGotrueHealth stub that actually drives the injected fetchImpl `n`
 * times (like the real poll does) and then reports unreachable, so the LAST
 * fetch error is the one the production wrapper recorded.
 */
const pollsThenFails =
  (n = 3) =>
  async (url: string, opts: { fetchImpl: (u: string, init?: unknown) => Promise<unknown> }) => {
    for (let i = 0; i < n; i++) {
      await opts.fetchImpl(url, {}).catch(() => {});
    }
    return false;
  };

const baseArgs = {
  serverIp: '10.0.0.1',
  sshKeyPath: '/tmp/deploy_key_prod',
  projectName: 'proj',
};

// Same fake-timer drain helper as compose-admin-user-retry.test.ts: each
// attempt schedules a NEW timer, so one runAllTimersAsync can't drain the
// chain. Capped so a never-settling promise fails fast instead of hanging CI.
async function settled<T>(p: Promise<T>) {
  let done = false;
  const r = p.then(
    (v) => {
      done = true;
      return { ok: true as const, v };
    },
    (e) => {
      done = true;
      return { ok: false as const, e: e as Error };
    },
  );
  for (let i = 0; !done && i < 400; i++) {
    await vi.advanceTimersByTimeAsync(5000);
  }
  if (!done) throw new Error('settled(): promise never resolved within the fake-timer budget');
  return r;
}

describe('createAdminUser Phase B tunnel diagnostics', () => {
  let projectDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Real temp dir + real .env (process.cwd() spied) — repo convention, see
    // bundle-digest.test.ts / state-tracker.test.ts.
    projectDir = mkdtempSync(join(tmpdir(), 'vc-admin-tunnel-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    writeFileSync(
      join(projectDir, '.env'),
      [
        'ADMIN_EMAIL="admin@example.com"',
        "ADMIN_PASSWORD='Sup3r!'",
        'SUPABASE_SERVICE_ROLE_KEY="svc-role-key"',
        '',
      ].join('\n'),
    );
    runCommandAsync.mockReset().mockResolvedValue(GOTRUE_HEALTHY); // Phase A ready
    waitForGotrueHealth.mockReset();
    postAdminUser.mockReset();
    progressLog.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    cwdSpy.mockRestore();
    rmSync(projectDir, { recursive: true, force: true });
  });

  const run = (opts: Record<string, unknown>) =>
    composePromise.then(({ createAdminUser }) =>
      settled(
        createAdminUser(baseArgs.serverIp, baseArgs.sshKeyPath, baseArgs.projectName, {
          ...opts,
        }),
      ),
    );

  it('opens the tunnel with ExitOnForwardFailure and a PIPED stderr (the evidence channel)', async () => {
    const { spawnImpl, calls } = makeFakeSpawn(() => HEALTHY_TUNNEL);
    waitForGotrueHealth.mockResolvedValue(true);
    postAdminUser.mockResolvedValue({ success: true, message: 'Admin user created' });

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('ssh');
    expect(calls[0].args).toEqual(
      expect.arrayContaining([
        '-o',
        'ExitOnForwardFailure=yes',
        '-N',
        '-L',
        '19876:localhost:8000',
      ]),
    );
    expect(calls[0].args.at(-1)).toBe('root@10.0.0.1');
    // stdio: stdin+stdout ignored, stderr PIPED — without this the whole
    // diagnostics chain below is dark (tonight's incident).
    expect(calls[0].opts.stdio).toEqual(['ignore', 'ignore', 'pipe']);
  });

  it('the tunnel argv resolves to NO multiplexing under first-obtained-value semantics', async () => {
    // OpenSSH takes the FIRST value seen for each option (ssh_config(5): "the
    // first obtained value for each parameter is used"; verified against
    // OpenSSH 9.6 with `ssh -o ControlMaster=auto -o ControlMaster=no -G` →
    // `controlmaster auto`). Run 31927810430: the no-mux opt-out APPENDED
    // after the shared opts' ControlMaster=auto was inert — the tunnel still
    // muxed, its client exited 0, and the single-attempt createAdminUser
    // failed ECONNREFUSED on both compose scenarios. So the assertion is on
    // EFFECTIVE resolution order, not on mere presence of the opt-out.
    const { spawnImpl, calls } = makeFakeSpawn(() => HEALTHY_TUNNEL);
    waitForGotrueHealth.mockResolvedValue(true);
    postAdminUser.mockResolvedValue({ success: true, message: 'Admin user created' });

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(true);
    const args = calls[0].args;
    const firstOptValue = (key: string) => {
      for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === '-o' && String(args[i + 1]).startsWith(`${key}=`)) {
          return String(args[i + 1]).slice(key.length + 1);
        }
      }
      return undefined;
    };
    expect(firstOptValue('ControlMaster')).toBe('no');
    expect(firstOptValue('ControlPath')).toBe('none');
  });

  it("surfaces the ssh child's stderr AND exit code when the tunnel dies", async () => {
    const { spawnImpl } = makeFakeSpawn(() => ({
      exitCode: 255,
      stderr: 'root@10.0.0.1: Permission denied (publickey).\n',
    }));
    waitForGotrueHealth.mockImplementation(neverHealthy);

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.e.message).toMatch(/Could not reach auth service via SSH tunnel/);
    expect(r.e.message).toMatch(/ssh: exited 255/);
    expect(r.e.message).toMatch(/Permission denied \(publickey\)/);
  });

  it("surfaces the ssh child's signal when the tunnel is killed out from under us", async () => {
    // A signal-killed child reports through 'exit' with a null code.
    const { spawnImpl } = makeFakeSpawn(() => ({
      exitCode: null as unknown as number,
      signal: 'SIGKILL',
    }));
    waitForGotrueHealth.mockImplementation(neverHealthy);

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.e.message).toMatch(/ssh: killed by SIGKILL/);
  });

  it('surfaces a spawn-level failure (ssh binary missing) instead of a bare timeout', async () => {
    const enoent = new Error('spawn ssh ENOENT') as Error & { code?: string };
    enoent.code = 'ENOENT';
    const { spawnImpl } = makeFakeSpawn(() => ({ spawnError: enoent }));
    waitForGotrueHealth.mockImplementation(neverHealthy);

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.e.message).toMatch(/ssh: spawn failed/);
    expect(r.e.message).toMatch(/ENOENT/);
  });

  it('surfaces the LAST fetch error from the health poll (code + message)', async () => {
    const { spawnImpl } = makeFakeSpawn(() => HEALTHY_TUNNEL);
    const fetchImpl = vi.fn().mockRejectedValue(fetchFailed());
    waitForGotrueHealth.mockImplementation(pollsThenFails(3));

    const r = await run({ spawnImpl, fetchImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(fetchImpl).toHaveBeenCalled();
    expect(r.e.message).toMatch(/last error: .*connect ECONNREFUSED 127\.0\.0\.1:19876/);
    // The tunnel itself was fine — say so rather than implying ssh died.
    expect(r.e.message).toMatch(/ssh: still running/);
  });

  it('surfaces a non-2xx health response as the last error (Kong up, GoTrue not)', async () => {
    const { spawnImpl } = makeFakeSpawn(() => HEALTHY_TUNNEL);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 502 });
    waitForGotrueHealth.mockImplementation(pollsThenFails(2));

    const r = await run({ spawnImpl, fetchImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.e.message).toMatch(/last error: .*502/);
  });

  it('the single failure carries the per-attempt cause in the thrown message — no retry lines', async () => {
    // Band-aid removal 2026-08-16: no retry announcements exist any more; the
    // diagnostic payload the retry lines used to carry must survive in the ONE
    // thrown error instead.
    const { spawnImpl } = makeFakeSpawn(() => HEALTHY_TUNNEL);
    const fetchImpl = vi.fn().mockRejectedValue(fetchFailed());
    waitForGotrueHealth.mockImplementation(pollsThenFails(2));

    const r = await run({ spawnImpl, fetchImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.e.message).toMatch(/connect ECONNREFUSED 127\.0\.0\.1:19876/);
    expect(r.e.message).toMatch(/ssh: still running/);
    const lines = progressLog.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('createAdminUser attempt'))).toHaveLength(0);
  });

  it('kills the tunnel child on the SUCCESS path', async () => {
    const { spawnImpl, children } = makeFakeSpawn(() => HEALTHY_TUNNEL);
    waitForGotrueHealth.mockResolvedValue(true);
    postAdminUser.mockResolvedValue({ success: true, message: 'Admin user created' });

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(true);
    expect(children).toHaveLength(1);
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    expect(children[0].stderr.destroy).toHaveBeenCalled();
  });

  it('kills the tunnel child on the failed attempt (no leaked forward)', async () => {
    const { spawnImpl, children } = makeFakeSpawn(() => HEALTHY_TUNNEL);
    waitForGotrueHealth.mockResolvedValue(false);

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(false);
    expect(children).toHaveLength(1); // single attempt, single tunnel
    for (const child of children) expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('kills the tunnel child when postAdminUser THROWS mid-attempt', async () => {
    const { spawnImpl, children } = makeFakeSpawn(() => HEALTHY_TUNNEL);
    waitForGotrueHealth.mockResolvedValue(true);
    postAdminUser.mockRejectedValue(new Error('socket hang up'));

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.e.message).toMatch(/socket hang up/);
    for (const child of children) expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('walks to the next local port when the bind collides, and says so', async () => {
    // Port 19876 is held (leaked tunnel / sibling deploy on this machine);
    // 19877 is free. This is the class that made tonight's failure look like
    // an unreachable auth service.
    const { spawnImpl, calls, children } = makeFakeSpawn((index) =>
      index === 0 ? { exitCode: 255, stderr: bindConflictStderr(19876) } : HEALTHY_TUNNEL,
    );
    // The poll on the collided port can never succeed (nothing is forwarding
    // through it); only the port the walk lands on answers.
    waitForGotrueHealth.mockImplementationOnce(neverHealthy).mockImplementation(healthyAfterTick);
    postAdminUser.mockResolvedValue({ success: true, message: 'Admin user created' });

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual(expect.arrayContaining(['-L', '19877:localhost:8000']));
    // The POST must go through the port we actually bound, not the base.
    expect(postAdminUser).toHaveBeenCalledWith(
      expect.objectContaining({ adminUsersUrl: 'http://localhost:19877/auth/v1/admin/users' }),
    );
    expect(waitForGotrueHealth).toHaveBeenCalledWith(
      'http://localhost:19877/auth/v1/health',
      expect.anything(),
    );
    const walkLine = progressLog.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('19876') && l.includes('19877'));
    expect(walkLine).toMatch(/Address already in use/);
    expect(children[0].kill).toHaveBeenCalled(); // the collided child is reaped
  });

  it('still reports the bind conflict when ssh exits before its stderr pipe closes', async () => {
    // 'exit' can fire without a subsequent 'close' being observed; the
    // diagnostics must not be lost (or the attempt hang) in that case.
    const { spawnImpl, calls } = makeFakeSpawn((index) =>
      index === 0
        ? { exitCode: 255, stderr: bindConflictStderr(19876), noClose: true }
        : HEALTHY_TUNNEL,
    );
    // The poll on the collided port can never succeed (nothing is forwarding
    // through it); only the port the walk lands on answers.
    waitForGotrueHealth.mockImplementationOnce(neverHealthy).mockImplementation(healthyAfterTick);
    postAdminUser.mockResolvedValue({ success: true, message: 'Admin user created' });

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual(expect.arrayContaining(['-L', '19877:localhost:8000']));
  });

  it('throws naming the whole walked range and every port’s stderr when all ports are bound', async () => {
    const { spawnImpl, calls } = makeFakeSpawn((_index, args) => {
      const spec = args[args.indexOf('-L') + 1];
      const port = Number(spec.split(':')[0]);
      return { exitCode: 255, stderr: bindConflictStderr(port) };
    });
    waitForGotrueHealth.mockImplementation(neverHealthy);

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.e.message).toMatch(/any local port in \[19876, 19885\]/);
    expect(r.e.message).toMatch(/port 19876:/);
    expect(r.e.message).toMatch(/port 19885:/);
    expect(r.e.message).toMatch(/Address already in use/);
    expect(calls).toHaveLength(10); // 10-port walk, single attempt
    expect(postAdminUser).not.toHaveBeenCalled(); // never got a tunnel to POST through
  });

  it('does NOT walk when the tunnel dies for a non-bind reason (no sshd hammering)', async () => {
    // An sshd MaxStartups drop / auth failure is not a port problem — walking
    // it would just re-hammer the server 10x per attempt.
    const { spawnImpl, calls } = makeFakeSpawn(() => ({
      exitCode: 255,
      stderr: 'kex_exchange_identification: Connection closed by remote host\n',
    }));
    waitForGotrueHealth.mockImplementation(neverHealthy);

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(calls).toHaveLength(1); // single attempt, no walk
    expect(r.e.message).toMatch(/kex_exchange_identification/);
  });

  it('bounds the captured stderr instead of pasting a runaway log into the error', async () => {
    const noisy = Array.from({ length: 200 }, (_, i) => `ssh debug line ${i}`).join('\n');
    const { spawnImpl } = makeFakeSpawn(() => ({
      exitCode: 255,
      stderr: `${noisy}\nbind [127.0.0.1]:19876: Address already in use\n`,
    }));
    waitForGotrueHealth.mockImplementation(neverHealthy);

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    // The tail (the part that matters) is kept; the head is dropped.
    expect(r.e.message).toMatch(/Address already in use/);
    expect(r.e.message).toMatch(/ssh debug line 199/);
    expect(r.e.message).not.toMatch(/ssh debug line 0\b/);
  });

  // Phase A is the same evidence problem one step earlier: "not ready" was
  // indistinguishable between a broken SSH hop and a container that answers
  // with nothing, and no tunnel is ever opened to say otherwise.
  it('Phase A: distinguishes a silent auth container from a broken SSH hop', async () => {
    const { spawnImpl, calls } = makeFakeSpawn(() => HEALTHY_TUNNEL);
    runCommandAsync.mockResolvedValue(''); // probe runs, container says nothing

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.e.message).toMatch(/Auth service not ready/);
    expect(r.e.message).toMatch(/answered with nothing/);
    expect(calls).toHaveLength(0); // no port spent on an unready auth service
  });

  it('Phase A: says so when the SSH probe itself never ran', async () => {
    const { spawnImpl } = makeFakeSpawn(() => HEALTHY_TUNNEL);
    runCommandAsync.mockRejectedValue(new Error('ssh: connect to host 10.0.0.1 port 22: refused'));

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.e.message).toMatch(/SSH health probe itself failed/);
  });

  it('Phase A: quotes what a non-GoTrue responder actually returned', async () => {
    const { spawnImpl } = makeFakeSpawn(() => HEALTHY_TUNNEL);
    runCommandAsync.mockResolvedValue('<html>502 Bad Gateway</html>');

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.e.message).toMatch(/last probe output: .*502 Bad Gateway/);
  });
});
