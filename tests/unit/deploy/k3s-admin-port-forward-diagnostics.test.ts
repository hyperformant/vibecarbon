/**
 * Unit tests for the DIAGNOSTICS half of k3s.js `provisionAdminUser`'s
 * `kubectl port-forward` child — the retry/budget contract itself is pinned
 * separately in k3s-provision-admin-user.test.ts.
 *
 * This is the k8s twin of compose-admin-tunnel-diagnostics.test.ts (#226).
 * The compose path hit the incident first (compose-ha warm redeploy,
 * 2026-07-31): the tunnel child was spawned `stdio: 'ignore'`,
 * `waitForGotrueHealth` returns a bare boolean, and the retry log line only
 * carried the wrapper message — so a failure produced ZERO evidence of why and
 * RCA was impossible without re-running. The k8s path had the identical hole,
 * with `kubectl port-forward` in place of `ssh -L`.
 *
 * These tests pin the evidence that must now survive a failure:
 *   - the kubectl child's stderr tail + exit code/signal (or spawn error),
 *   - the LAST fetch error from the health poll (code + message),
 *   - both of the above in every per-attempt retry log line,
 *   - the forward child killed on success, failure AND throw,
 *   - a local-bind collision named as such, with the actionable remedy —
 *     this path deliberately does NOT walk the port (see below).
 *
 * NOT ported from the compose twin: the local-port WALK. The HA pair
 * provisions primary and standby in parallel on fixed adjacent bases
 * (15000/15001), so a walk could step one cluster's retry straight onto the
 * other's. A bind collision here is reported, not routed around.
 *
 * Seams: `spawnImpl` / `fetchImpl` are injected through `provisionAdminUser`'s
 * args (same DI convention as admin-user.js's `fetchImpl`) rather than mocking
 * `node:child_process` — builtin-module mocks are not reliably scoped per test
 * file under the full parallel unit run, and the whole point of these tests is
 * to assert on the spawned child.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const k3sPromise = import('../../../src/lib/deploy/k8s/k3s.js');

type ForwardBehavior = {
  /** stderr text kubectl emits before exiting (feeds the bounded tail). */
  stderr?: string;
  /** Present → the child exits with this code. */
  exitCode?: number | null;
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
 * Fake `kubectl port-forward` child. Emits in real spawn order (stderr 'data'
 * → 'exit' → 'close'); a behavior with no `exitCode`/`spawnError` models a
 * HEALTHY forward that just sits there until it is killed.
 */
function fakeForwardChild(behavior: ForwardBehavior) {
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
  // Handlers are registered synchronously by the production helper, so a
  // microtask is late enough to reach all of them and early enough to beat
  // any timer.
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

/** Real `kubectl port-forward` stderr for a local bind collision. */
function bindConflictStderr(port: number) {
  return (
    `Unable to listen on port ${port}: Listeners failed to create with the following errors: ` +
    `[unable to create listener: Error listen tcp4 127.0.0.1:${port}: bind: address already in use]\n` +
    'error: unable to listen on any of the requested ports: [{15000 9999}]\n'
  );
}

/** Node's `fetch` failure shape: TypeError('fetch failed') + a coded cause. */
function fetchFailed(detail = 'connect ECONNREFUSED 127.0.0.1:15000', code = 'ECONNREFUSED') {
  const cause = new Error(detail) as Error & { code?: string };
  cause.code = code;
  const err = new TypeError('fetch failed') as TypeError & { cause?: unknown };
  err.cause = cause;
  return err;
}

function makeFakeSpawn(pick: (index: number, args: string[]) => ForwardBehavior) {
  const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const children: FakeChild[] = [];
  const spawnImpl = vi.fn((cmd: string, args: string[], opts: Record<string, unknown>) => {
    const index = calls.length;
    calls.push({ cmd, args, opts });
    const child = fakeForwardChild(pick(index, args));
    children.push(child as unknown as FakeChild);
    return child;
  });
  return { spawnImpl, calls, children };
}

/** A forward that opens and stays up. */
const HEALTHY_FORWARD: ForwardBehavior = {};

/** waitForGotrueHealth stub that never settles (the child decides the race). */
const neverHealthy = () => new Promise<boolean>(() => {});

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
  kubeconfig: '/tmp/kubeconfig',
  envLocal: {
    ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD: 'Sup3r!',
    SERVICE_ROLE_KEY: 'svc-role-key',
  },
  localPort: 15000,
  // Zero backoff keeps the suite fast — production callers omit this and get
  // the real [3s, 6s, 12s] ladder (see provisionAdminUser's own JSDoc).
};

describe('provisionAdminUser port-forward diagnostics', () => {
  beforeEach(() => {
    waitForGotrueHealth.mockReset();
    postAdminUser.mockReset();
    progressLog.mockReset();
  });

  const run = (opts: Record<string, unknown>) =>
    k3sPromise.then(({ provisionAdminUser }) =>
      provisionAdminUser({ ...baseArgs, ...opts }).then(
        (v: unknown) => ({ ok: true as const, v }),
        (e: Error) => ({ ok: false as const, e }),
      ),
    );

  it('spawns the forward with a PIPED stderr (the evidence channel)', async () => {
    const { spawnImpl, calls } = makeFakeSpawn(() => HEALTHY_FORWARD);
    waitForGotrueHealth.mockResolvedValue(true);
    postAdminUser.mockResolvedValue({ success: true, message: 'Admin user created' });

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('kubectl');
    expect(calls[0].args).toEqual([
      '-n',
      'vibecarbon',
      'port-forward',
      'svc/supabase-supabase-auth',
      '15000:9999',
    ]);
    // stdio: stdin+stdout ignored, stderr PIPED — without this the whole
    // diagnostics chain below is dark (the class #226 fixed on compose).
    expect(calls[0].opts.stdio).toEqual(['ignore', 'ignore', 'pipe']);
    // KUBECONFIG still threaded through — the port-forward has to reach a
    // cluster, not just be observable.
    expect((calls[0].opts.env as Record<string, string>).KUBECONFIG).toBe('/tmp/kubeconfig');
  });

  it("surfaces the kubectl child's stderr AND exit code when the forward dies", async () => {
    const { spawnImpl } = makeFakeSpawn(() => ({
      exitCode: 1,
      stderr: 'error: services "supabase-supabase-auth" not found\n',
    }));
    waitForGotrueHealth.mockImplementation(neverHealthy);

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.e.message).toMatch(/Could not reach GoTrue via kubectl port-forward/);
    expect(r.e.message).toMatch(/kubectl: exited 1/);
    expect(r.e.message).toMatch(/services "supabase-supabase-auth" not found/);
  });

  it("surfaces the kubectl child's signal when the forward is killed out from under us", async () => {
    const { spawnImpl } = makeFakeSpawn(() => ({ exitCode: null, signal: 'SIGKILL' }));
    waitForGotrueHealth.mockImplementation(neverHealthy);

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.e.message).toMatch(/kubectl: killed by SIGKILL/);
  });

  it('surfaces a spawn-level failure (kubectl binary missing) instead of a bare timeout', async () => {
    const enoent = new Error('spawn kubectl ENOENT') as Error & { code?: string };
    enoent.code = 'ENOENT';
    const { spawnImpl } = makeFakeSpawn(() => ({ spawnError: enoent }));
    waitForGotrueHealth.mockImplementation(neverHealthy);

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.e.message).toMatch(/kubectl: spawn failed/);
    expect(r.e.message).toMatch(/ENOENT/);
  });

  it('surfaces the LAST fetch error from the health poll (code + message)', async () => {
    const { spawnImpl } = makeFakeSpawn(() => HEALTHY_FORWARD);
    const fetchImpl = vi.fn().mockRejectedValue(fetchFailed());
    waitForGotrueHealth.mockImplementation(pollsThenFails(3));

    const r = await run({ spawnImpl, fetchImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(fetchImpl).toHaveBeenCalled();
    expect(r.e.message).toMatch(/last error: .*connect ECONNREFUSED 127\.0\.0\.1:15000/);
    // The forward itself was fine — say so rather than implying kubectl died.
    expect(r.e.message).toMatch(/kubectl: still running/);
  });

  it('surfaces a non-2xx health response as the last error (forward up, GoTrue not)', async () => {
    const { spawnImpl } = makeFakeSpawn(() => HEALTHY_FORWARD);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    waitForGotrueHealth.mockImplementation(pollsThenFails(2));

    const r = await run({ spawnImpl, fetchImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.e.message).toMatch(/last error: .*503/);
  });

  it('the single failure carries the per-attempt cause — no retry lines exist', async () => {
    // Band-aid removal 2026-08-16: the ladder is gone; the diagnostic payload
    // its retry lines carried must survive in the ONE thrown error.
    const { spawnImpl } = makeFakeSpawn(() => HEALTHY_FORWARD);
    const fetchImpl = vi.fn().mockRejectedValue(fetchFailed());
    waitForGotrueHealth.mockImplementation(pollsThenFails(2));

    const r = await run({ spawnImpl, fetchImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.e.message).toMatch(/connect ECONNREFUSED 127\.0\.0\.1:15000/);
    expect(r.e.message).toMatch(/kubectl: still running/);
    const lines = progressLog.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('createAdminUser attempt'))).toHaveLength(0);
  });

  it('the failure does not blame the forward for a reachable-but-erroring GoTrue', async () => {
    // A 500 from the admin POST is not "could not reach GoTrue"; a message
    // that says otherwise sends the next RCA at the port-forward instead of
    // at GoTrue.
    const { spawnImpl } = makeFakeSpawn(() => HEALTHY_FORWARD);
    waitForGotrueHealth.mockResolvedValue(true);
    postAdminUser.mockResolvedValue({
      success: false,
      message: 'GoTrue admin API returned 500: internal error',
    });

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.e.message).toMatch(/GoTrue admin API returned 500/);
    expect(r.e.message).not.toMatch(/could not reach/i);
  });

  it('kills the forward child on the SUCCESS path', async () => {
    const { spawnImpl, children } = makeFakeSpawn(() => HEALTHY_FORWARD);
    waitForGotrueHealth.mockResolvedValue(true);
    postAdminUser.mockResolvedValue({ success: true, message: 'Admin user created' });

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(true);
    expect(children).toHaveLength(1);
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    expect(children[0].stderr.destroy).toHaveBeenCalled();
  });

  it('kills the forward child on the failed attempt (no leaked forward)', async () => {
    const { spawnImpl, children } = makeFakeSpawn(() => HEALTHY_FORWARD);
    waitForGotrueHealth.mockResolvedValue(false);

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(false);
    expect(children).toHaveLength(1); // single attempt, single forward
    for (const child of children) expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('kills the forward child when postAdminUser THROWS mid-attempt', async () => {
    const { spawnImpl, children } = makeFakeSpawn(() => HEALTHY_FORWARD);
    waitForGotrueHealth.mockResolvedValue(true);
    postAdminUser.mockRejectedValue(new Error('socket hang up'));

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.e.message).toMatch(/socket hang up/);
    for (const child of children) expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('names a local bind collision and its remedy WITHOUT walking the port', async () => {
    // A leaked forward from an earlier run holds 15000. The compose twin walks
    // past this; here the port is fixed on purpose (HA runs primary/standby in
    // parallel on 15000/15001), so the message has to be actionable instead.
    const { spawnImpl, calls } = makeFakeSpawn(() => ({
      exitCode: 1,
      stderr: bindConflictStderr(15000),
    }));
    waitForGotrueHealth.mockImplementation(neverHealthy);

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.e.message).toMatch(/already bound/i);
    expect(r.e.message).toMatch(/address already in use/i);
    // Every attempt re-binds the SAME port — no walk to 15001, which is the
    // HA standby's base.
    for (const call of calls) {
      expect(call.args).toContain('15000:9999');
    }
    expect(calls).toHaveLength(1); // single attempt, no walk
  });

  it('still reports the failure when kubectl exits before its stderr pipe closes', async () => {
    // 'exit' can fire without a subsequent 'close' being observed; the
    // diagnostics must not be lost (or the attempt hang) in that case.
    const { spawnImpl } = makeFakeSpawn(() => ({
      exitCode: 1,
      stderr: bindConflictStderr(15000),
      noClose: true,
    }));
    waitForGotrueHealth.mockImplementation(neverHealthy);

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.e.message).toMatch(/address already in use/i);
  });

  it('bounds the captured stderr instead of pasting a runaway log into the error', async () => {
    const noisy = Array.from({ length: 200 }, (_, i) => `kubectl debug line ${i}`).join('\n');
    const { spawnImpl } = makeFakeSpawn(() => ({
      exitCode: 1,
      stderr: `${noisy}\nerror: lost connection to pod\n`,
    }));
    waitForGotrueHealth.mockImplementation(neverHealthy);

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    // The tail (the part that matters) is kept; the head is dropped.
    expect(r.e.message).toMatch(/lost connection to pod/);
    expect(r.e.message).toMatch(/kubectl debug line 199/);
    expect(r.e.message).not.toMatch(/kubectl debug line 0\b/);
  });

  it('classifies a dead forward immediately instead of burning the whole health poll', async () => {
    // The poll never settles; only the child's death can end the attempt. If
    // the race were missing this test would hang rather than fail.
    const { spawnImpl } = makeFakeSpawn(() => ({
      exitCode: 1,
      stderr: 'error: lost connection to pod\n',
    }));
    waitForGotrueHealth.mockImplementation(neverHealthy);

    const r = await run({ spawnImpl });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.e.message).toMatch(/lost connection to pod/);
  });
});
