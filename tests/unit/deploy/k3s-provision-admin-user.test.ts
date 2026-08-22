import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for k3s.js `provisionAdminUser`'s budgeted retry (M3 Task 9h).
 *
 * Battery d3 run 6: a single port-forward + GoTrue-health attempt failed,
 * the deploy logged a warning ("re-run `vibecarbon deploy` to retry") and
 * "succeeded" anyway with no admin.users row — verify-deploy's
 * auth_admin_login check then failed. The fix wraps the whole port-forward +
 * HTTP reach in a runWithRetry budget (mirrors pushImageToLocalRegistry's
 * tunnel-retry idiom) and throws loudly once that budget is exhausted.
 *
 * The `kubectl port-forward` child is supplied through `provisionAdminUser`'s
 * injected `spawnImpl` seam rather than by mocking `node:child_process`: k3s.js
 * is imported (unmocked w.r.t. child_process) by many sibling k3s-*.test.ts
 * files, and under the full parallel unit run a builtin module's mock identity
 * is not reliably scoped per test file the way a regular src/ module's is —
 * asserting on the raw `spawn` call count proved flaky on the compose twin
 * (passes in isolation, intermittently 0-called in the full suite) even though
 * the retry behavior was correct throughout. See
 * compose-admin-user-retry.test.ts's header for that history. The forward's own
 * diagnostics contract is asserted separately in
 * k3s-admin-port-forward-diagnostics.test.ts.
 *
 * The tunnel-agnostic HTTP half (`../../../src/lib/deploy/admin-user.js`'s
 * waitForGotrueHealth/postAdminUser — already unit-tested on its own contract
 * in admin-user.test.ts) is mocked the reliable src/-module way; retry.js
 * stays real so these tests exercise the actual runWithRetry budget/backoff.
 */

const waitForGotrueHealth = vi.fn();
const postAdminUser = vi.fn();
vi.mock('../../../src/lib/deploy/admin-user.js', () => ({
  waitForGotrueHealth: (...args: unknown[]) => waitForGotrueHealth(...args),
  postAdminUser: (...args: unknown[]) => postAdminUser(...args),
}));

const k3sPromise = import('../../../src/lib/deploy/k8s/k3s.js');

/**
 * Fake `kubectl port-forward` child that opens and stays up — the lifecycle
 * these tests care about is "one per attempt, always reaped"; the death /
 * bind-collision paths live in k3s-admin-port-forward-diagnostics.test.ts.
 */
function fakePortForwardChild() {
  const child = {
    stderr: { on: vi.fn(), destroy: vi.fn() },
    on: vi.fn(() => child),
    kill: vi.fn(),
  };
  return child;
}

const spawnImpl = vi.fn(() => fakePortForwardChild());

const baseArgs = {
  kubeconfig: '/tmp/kubeconfig',
  envLocal: {
    ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD: 'Sup3r!',
    SERVICE_ROLE_KEY: 'svc-role-key',
  },
  localPort: 15000,
  // Zero backoff keeps the suite fast — production callers omit this and
  // get the real [3s, 6s, 12s] ladder (see the function's own JSDoc).
  // The port-forward child seam.
  spawnImpl,
};

describe('provisionAdminUser retry (M3 Task 9h)', () => {
  beforeEach(() => {
    spawnImpl.mockClear();
    waitForGotrueHealth.mockReset();
    postAdminUser.mockReset();
  });

  it('already-exists: succeeds on the first attempt with no retry (idempotent no-op)', async () => {
    const { provisionAdminUser } = await k3sPromise;
    waitForGotrueHealth.mockResolvedValueOnce(true);
    postAdminUser.mockResolvedValueOnce({
      success: true,
      message: 'Admin user already exists: admin@example.com',
    });

    const result = await provisionAdminUser(baseArgs);

    expect(result).toEqual({
      success: true,
      message: 'Admin user already exists: admin@example.com',
    });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith(
      'kubectl',
      ['-n', 'vibecarbon', 'port-forward', 'svc/supabase-supabase-auth', '15000:9999'],
      // stderr is PIPED, not ignored — it is the forward's only evidence
      // channel (k3s-admin-port-forward-diagnostics.test.ts owns that contract).
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'pipe'] }),
    );
    // Each attempt's port-forward is killed in `finally`, success included.
    const child = spawnImpl.mock.results[0].value as ReturnType<typeof fakePortForwardChild>;
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('an unreachable forward FAILS on the first attempt — no silent retry', async () => {
    // Band-aid removal 2026-08-16: the ladder's triggers (db-driven GoTrue
    // 500s, forward wedges) are closed at their sources, so a reach failure is
    // a defect that surfaces immediately.
    const { provisionAdminUser } = await k3sPromise;
    waitForGotrueHealth.mockResolvedValue(false);

    await expect(provisionAdminUser(baseArgs)).rejects.toThrow(
      /GoTrue admin-user provisioning failed after 1 attempt\b.*admin login will not work.*\[#1\]/is,
    );
    expect(waitForGotrueHealth).toHaveBeenCalledTimes(1);
    expect(postAdminUser).not.toHaveBeenCalled();
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    // The single attempt's port-forward is still torn down on failure.
    for (const r of spawnImpl.mock.results) {
      expect((r.value as ReturnType<typeof fakePortForwardChild>).kill).toHaveBeenCalledTimes(1);
    }
  });

  it('a failing postAdminUser (non-422) FAILS on the first attempt, without claiming "unreachable"', async () => {
    // Reachable-but-erroring is not unreachable — the single-attempt message
    // must keep that distinction (fix round 1's correction survives the
    // ladder's removal).
    const { provisionAdminUser } = await k3sPromise;
    waitForGotrueHealth.mockResolvedValue(true);
    postAdminUser.mockResolvedValue({
      success: false,
      message: 'GoTrue admin API returned 500: internal error',
    });

    let caught: Error | undefined;
    try {
      await provisionAdminUser(baseArgs);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/GoTrue admin-user provisioning failed after 1 attempt\b/);
    expect(caught?.message).toMatch(/GoTrue admin API returned 500/);
    expect(caught?.message).not.toMatch(/unreachable/);
    expect(postAdminUser).toHaveBeenCalledTimes(1);
  });

  it('credentials-missing throws loudly naming every missing key (M3 Task 9h fix round 1)', async () => {
    // Reachable in real customer deploys: `create` always writes
    // ADMIN_EMAIL/ADMIN_PASSWORD into .env.local, and these are also
    // GH-Environment-managed CI secrets — a missing/misnamed one must fail
    // the deploy, not degrade to a soft {success: false} (the exact bug
    // class this task exists to kill).
    const { provisionAdminUser } = await k3sPromise;

    await expect(
      provisionAdminUser({
        kubeconfig: '/tmp/kubeconfig',
        envLocal: {},
        retryDelaysMs: [0, 0, 0],
        spawnImpl,
      }),
    ).rejects.toThrow(
      /Admin credentials missing \(ADMIN_EMAIL, ADMIN_PASSWORD, SUPABASE_SERVICE_ROLE_KEY\).*admin login will not work.*\.env\.local.*GitHub Environment/is,
    );
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(waitForGotrueHealth).not.toHaveBeenCalled();
  });

  it('credentials-missing names only the ONE missing key when the rest are present', async () => {
    const { provisionAdminUser } = await k3sPromise;

    await expect(
      provisionAdminUser({
        kubeconfig: '/tmp/kubeconfig',
        envLocal: { ADMIN_EMAIL: 'a@b.test', ADMIN_PASSWORD: 'pw' }, // SERVICE_ROLE_KEY missing
        retryDelaysMs: [0, 0, 0],
        spawnImpl,
      }),
    ).rejects.toThrow(/Admin credentials missing \(SUPABASE_SERVICE_ROLE_KEY\)/);
  });

  it('the SUPABASE_SERVICE_ROLE_KEY fallback alias counts as present (no false-positive missing)', async () => {
    const { provisionAdminUser } = await k3sPromise;
    waitForGotrueHealth.mockResolvedValueOnce(true);
    postAdminUser.mockResolvedValueOnce({
      success: true,
      message: 'Admin user created: admin@example.com',
    });

    await expect(
      provisionAdminUser({
        kubeconfig: '/tmp/kubeconfig',
        envLocal: {
          ADMIN_EMAIL: 'a@b.test',
          ADMIN_PASSWORD: 'pw',
          SUPABASE_SERVICE_ROLE_KEY: 'svc',
        },
        retryDelaysMs: [0, 0, 0],
        spawnImpl,
      }),
    ).resolves.toEqual({ success: true, message: 'Admin user created: admin@example.com' });
  });
});
