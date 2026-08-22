/**
 * Unit tests for compose/index.js `createAdminUser`'s budgeted retry (fast-
 * follow to M3 Task 9h — see k3s-provision-admin-user.test.ts for the k8s
 * counterpart this mirrors).
 *
 * Background: the compose deploy path (vibecarbon.com's production path) had
 * `createAdminUser` implemented as warn-and-continue — a single failed
 * attempt logged a warning ("Run `vibecarbon deploy` again to retry") and the
 * deploy reported SUCCESS with no admin.users row. This is the exact bug
 * class M3 Task 9h fixed on the k8s path. Unlike k8s (where `helm --wait`
 * already guarantees GoTrue is Available before provisionAdminUser runs),
 * compose has no such upstream gate, so BOTH phases of reaching GoTrue are
 * folded into the retried unit:
 *   - Phase A: poll the auth container's own health endpoint over SSH exec
 *     (`sshRunAsync`, backed by `runCommandAsync`) until it reports healthy.
 *   - Phase B: open a fresh `ssh -L` tunnel to Kong, wait for it to answer
 *     (`waitForGotrueHealth`), then POST the admin user (`postAdminUser`) —
 *     both from the tunnel-agnostic `../../../src/lib/deploy/admin-user.js`,
 *     already unit-tested on its own HTTP contract in admin-user.test.ts.
 *
 * `.env` is a REAL file in a real temp dir (process.cwd() spied to point at
 * it) rather than a mocked `node:fs` — mirrors bundle-digest.test.ts /
 * state-tracker.test.ts's established convention, and sidesteps builtin-
 * module mock reliability issues under the full parallel unit-test run.
 *
 * The `ssh -L` tunnel child is supplied through `createAdminUser`'s injected
 * `spawnImpl` seam rather than by mocking `node:child_process`: compose/
 * index.js is imported (unmocked w.r.t. child_process) by many sibling
 * compose-*.test.ts files, and under the full parallel unit run a builtin
 * module's mock identity is not reliably scoped per test file the way a
 * regular src/ module's is — asserting on the raw `spawn` call count proved
 * flaky (passes in isolation, intermittently 0-called in the full suite)
 * even though the actual retry/attempt behavior was correct throughout. The
 * injected fake has no such problem; the tunnel's own diagnostics contract is
 * asserted on it in compose-admin-tunnel-diagnostics.test.ts. The retry
 * contract here is verified through `waitForGotrueHealth` / `postAdminUser` /
 * `runCommandAsync` call counts — regular src/ module mocks, which stayed
 * reliable across every run — plus the resolved/thrown value.
 * `../../../src/lib/command.js`'s `runCommandAsync` (Phase A's
 * SSH-exec health polls) is mocked the same reliable way; retry.js stays
 * real so these tests exercise the actual runWithRetry budget/backoff.
 * `node:timers/promises` is shimmed onto the faked global `setTimeout`
 * (vi.useFakeTimers() does not fake it directly — mirrors
 * k3s-kubectl-retry.test.ts) so Phase A's 30-poll inner loop and the outer
 * retry's backoff both run under fake time instead of real wall-clock delay.
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

vi.mock('../../../src/lib/cli/progress.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/lib/cli/progress.js')>(
    '../../../src/lib/cli/progress.js',
  );
  return { ...actual, progressLog: vi.fn() };
});

const composePromise = import('../../../src/lib/deploy/compose/index.js');

/**
 * Fake `ssh -L` tunnel child that opens and stays up — the tunnel lifecycle
 * these tests care about is "one per attempt, always reaped"; the death /
 * bind-collision paths live in compose-admin-tunnel-diagnostics.test.ts.
 */
function fakeTunnelChild() {
  const child = {
    stderr: { on: vi.fn(), destroy: vi.fn() },
    on: vi.fn(() => child),
    kill: vi.fn(),
  };
  return child;
}

const spawnImpl = vi.fn(() => fakeTunnelChild());

/** GoTrue's own /health response text — what Phase A greps for. */
const GOTRUE_HEALTHY = 'GoTrue is healthy';

const baseArgs = {
  serverIp: '10.0.0.1',
  sshKeyPath: '/tmp/deploy_key_prod',
  projectName: 'proj',
  // Single-attempt since the 2026-08-16 band-aid removal: the retry ladder is
  // gone (its db-driven GoTrue-500 trigger is closed by the pg_isready gate),
  // so opts carries only the tunnel-child seam.
  opts: { spawnImpl },
};

function renderEnv(): string {
  return [
    'ADMIN_EMAIL="admin@example.com"',
    "ADMIN_PASSWORD='Sup3r!'",
    'SUPABASE_SERVICE_ROLE_KEY="svc-role-key"',
    '',
  ].join('\n');
}

// pollUntil/runWithRetry (and Phase A's own inner poll) schedule a NEW timer
// after each attempt, so a single runAllTimersAsync can't drain the chain —
// advance the clock in fixed steps and stop as soon as the promise actually
// settles. Mirrors k3s-kubectl-retry.test.ts. Capped so a real bug (a promise
// that never settles) fails fast instead of hanging CI.
async function settled<T>(p: Promise<T>) {
  let done = false;
  const r = p.then(
    (v) => {
      done = true;
      return { ok: true as const, v };
    },
    (e) => {
      done = true;
      return { ok: false as const, e };
    },
  );
  for (let i = 0; !done && i < 400; i++) {
    await vi.advanceTimersByTimeAsync(5000);
  }
  if (!done) throw new Error('settled(): promise never resolved within the fake-timer budget');
  return r;
}

describe('createAdminUser retry (fast-follow to M3 Task 9h)', () => {
  let projectDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    // Real temp dir + real .env file — createAdminUser reads `.env` off
    // process.cwd() with plain node:fs calls; spying process.cwd (not
    // mocking node:fs) mirrors bundle-digest.test.ts / state-tracker.test.ts
    // and avoids builtin-module mock flakiness under the full parallel run.
    projectDir = mkdtempSync(join(tmpdir(), 'vc-admin-user-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    writeFileSync(join(projectDir, '.env'), renderEnv());

    spawnImpl.mockClear();
    runCommandAsync.mockReset().mockResolvedValue(GOTRUE_HEALTHY);
    waitForGotrueHealth.mockReset();
    postAdminUser.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    cwdSpy.mockRestore();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('already-exists: succeeds on the first attempt with no retry (idempotent no-op)', async () => {
    const { createAdminUser } = await composePromise;
    waitForGotrueHealth.mockResolvedValueOnce(true);
    postAdminUser.mockResolvedValueOnce({
      success: true,
      message: 'Admin user already exists: admin@example.com',
    });

    const r = await settled(
      createAdminUser(baseArgs.serverIp, baseArgs.sshKeyPath, baseArgs.projectName, baseArgs.opts),
    );

    expect(r).toEqual({
      ok: true,
      v: { success: true, message: 'Admin user already exists: admin@example.com' },
    });
    // +1: the db accepting-gate (pg_isready over ssh) now precedes Phase A
    // (mitigation-audit cluster 5); healthy mock -> one gate probe.
    expect(runCommandAsync).toHaveBeenCalledTimes(2); // db gate + Phase A read
    expect(waitForGotrueHealth).toHaveBeenCalledTimes(1);
    expect(postAdminUser).toHaveBeenCalledTimes(1);
  });

  it('an unreachable tunnel FAILS the deploy on the first attempt — no silent retry', async () => {
    // Band-aid removal 2026-08-16: with the db-driven trigger closed at the
    // source, a reach failure here is a real defect and must surface
    // immediately instead of being absorbed by a second attempt.
    const { createAdminUser } = await composePromise;
    waitForGotrueHealth.mockResolvedValue(false);
    postAdminUser.mockResolvedValue({ success: true, message: 'unreached' });

    const r = await settled(
      createAdminUser(baseArgs.serverIp, baseArgs.sshKeyPath, baseArgs.projectName, baseArgs.opts),
    );

    expect(r.ok).toBe(false);
    expect(waitForGotrueHealth).toHaveBeenCalledTimes(1);
    expect(postAdminUser).not.toHaveBeenCalled();
  });

  it('a failing postAdminUser call (non-422) FAILS the deploy on the first attempt', async () => {
    const { createAdminUser } = await composePromise;
    waitForGotrueHealth.mockResolvedValue(true);
    postAdminUser.mockResolvedValue({
      success: false,
      message: 'GoTrue admin API returned 500: internal error',
    });

    const r = await settled(
      createAdminUser(baseArgs.serverIp, baseArgs.sshKeyPath, baseArgs.projectName, baseArgs.opts),
    );

    expect(r.ok).toBe(false);
    expect(postAdminUser).toHaveBeenCalledTimes(1);
  });

  it('the single-attempt failure still names the cause, consequence, and attempt', async () => {
    // The ladder is gone but its diagnostic quality survives: one numbered
    // attempt, the consequence, and the per-phase cause.
    const { createAdminUser } = await composePromise;
    waitForGotrueHealth.mockResolvedValue(false);

    const r = await settled(
      createAdminUser(baseArgs.serverIp, baseArgs.sshKeyPath, baseArgs.projectName, baseArgs.opts),
    );

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.e.message).toMatch(
        /GoTrue admin-user provisioning failed after 1 attempt\b.*admin login will not work.*\[#1\]/is,
      );
    }
    expect(spawnImpl).toHaveBeenCalledTimes(1); // one fresh tunnel, torn down
  });

  it('auth never becoming ready throws with the Phase A failure folded in — Phase B never reached', async () => {
    const { createAdminUser } = await composePromise;
    runCommandAsync.mockResolvedValue(''); // never reports GoTrue

    const r = await settled(
      createAdminUser(baseArgs.serverIp, baseArgs.sshKeyPath, baseArgs.projectName, baseArgs.opts),
    );

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.e.message).toMatch(/GoTrue admin-user provisioning failed after 1 attempt\b/);
      expect(r.e.message).toMatch(/Auth service not ready/);
    }
    expect(waitForGotrueHealth).not.toHaveBeenCalled();
    expect(postAdminUser).not.toHaveBeenCalled();
    // 30 db-gate probes (never-ready mock starves pg_isready too) + 30 Phase A
    // polls, ONCE — the ladder that tripled this is gone.
    expect(runCommandAsync).toHaveBeenCalledTimes(60); // 30 gate + 30 polls x 1 attempt
  });

  it('credentials-missing (no .env file) throws loudly naming every missing key', async () => {
    const { createAdminUser } = await composePromise;
    rmSync(join(projectDir, '.env'), { force: true });

    const r = await settled(
      createAdminUser(baseArgs.serverIp, baseArgs.sshKeyPath, baseArgs.projectName, baseArgs.opts),
    );

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.e.message).toMatch(
        /Admin credentials missing \(ADMIN_EMAIL, ADMIN_PASSWORD, SUPABASE_SERVICE_ROLE_KEY\).*admin login will not work.*\.env.*GitHub Environment/is,
      );
    }
    expect(runCommandAsync).not.toHaveBeenCalled();
    expect(waitForGotrueHealth).not.toHaveBeenCalled();
  });

  it('credentials-missing names only the ONE missing key when the rest are present', async () => {
    const { createAdminUser } = await composePromise;
    writeFileSync(
      join(projectDir, '.env'),
      ['ADMIN_EMAIL="admin@example.com"', "ADMIN_PASSWORD='pw'", ''].join('\n'),
    );

    const r = await settled(
      createAdminUser(baseArgs.serverIp, baseArgs.sshKeyPath, baseArgs.projectName, baseArgs.opts),
    );

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.e.message).toMatch(/Admin credentials missing \(SUPABASE_SERVICE_ROLE_KEY\)/);
    }
  });
});
