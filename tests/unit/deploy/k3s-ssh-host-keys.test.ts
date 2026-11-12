import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';

// Mock spawn: both waitForK3sReady's ssh probe and fetchKubeconfig's scp now
// go through runCommandAsync (Task A3), which spawns rather than using
// execFileSync. We rebuild the module under test inside each test so the
// mock is wired before the import.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const k3sModulePromise = import('../../../src/lib/deploy/k8s/k3s.js');

/** Minimal ChildProcess stand-in for runCommandAsync's silent:true path. */
function fakeChild(code = 0, stdout = '') {
  const child = {
    stdout: {
      on(event: string, cb: (d: string) => void) {
        if (event === 'data' && stdout) Promise.resolve().then(() => cb(stdout));
      },
    },
    stderr: { on: vi.fn() },
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === 'close') Promise.resolve().then(() => cb(code));
      return child;
    },
  };
  return child;
}

describe('k3s SSH host-key pinning (PR 1B-T6)', () => {
  it('waitForK3sReady passes UserKnownHostsFile=<env known_hosts>', async () => {
    const { waitForK3sReady } = await k3sModulePromise;
    const spawnMock = vi.mocked(spawn);
    spawnMock.mockReset();
    // First (and only) held ssh session prints READY → marker present → the
    // wait returns without reconnecting.
    spawnMock.mockImplementationOnce(
      () => fakeChild(0, 'CONNECTED\nREADY\n') as unknown as ReturnType<typeof spawn>,
    );

    const tmp = createTempDir('vc-k3s-test-');
    const khPath = join(tmp, '.vibecarbon', 'known_hosts_e2e');

    await waitForK3sReady('1.2.3.4', '/tmp/key', khPath, 5);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, argv] = spawnMock.mock.calls[0] as [string, string[]];
    expect(bin).toBe('ssh');
    expect(argv).toContain('-o');
    expect(argv).toContain(`UserKnownHostsFile=${khPath}`);
    expect(argv).toContain('GlobalKnownHostsFile=/dev/null');
    expect(argv).toContain('StrictHostKeyChecking=accept-new');
    // BatchMode=yes prevents SSH from prompting for passwords on key
    // failures (PR 1T — observed prompts hanging the runner).
    expect(argv).toContain('BatchMode=yes');
    // Sanity: the user's ~/.ssh/known_hosts is not referenced.
    expect(argv.join(' ')).not.toContain(`${process.env.HOME}/.ssh/known_hosts`);
  });

  it('waitForK3sReady gives the held ssh session a timeout bounded by the remaining budget', async () => {
    const { waitForK3sReady } = await k3sModulePromise;
    const spawnMock = vi.mocked(spawn);
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeChild(255) as unknown as ReturnType<typeof spawn>);
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const tmp = createTempDir('vc-k3s-test-');

    await expect(waitForK3sReady('1.2.3.4', '/tmp/key', join(tmp, 'kh'), 1)).rejects.toThrow(
      /k3s did not become ready/,
    );

    // min(30, ~1s) * 1000 + 5000: one real session timeout, not unbounded.
    const delays = timers.mock.calls.map((c) => Number(c[1]));
    expect(delays.some((d) => d >= 5500 && d <= 6000)).toBe(true);
    timers.mockRestore();
  });

  it('fetchKubeconfig passes UserKnownHostsFile=<env known_hosts> to scp', async () => {
    // fetchKubeconfig's scp now goes through runCommandAsync (Task A3).
    const { fetchKubeconfig } = await k3sModulePromise;
    const spawnMock = vi.mocked(spawn);
    spawnMock.mockReset();
    spawnMock.mockImplementationOnce(() => fakeChild(0) as unknown as ReturnType<typeof spawn>);

    const tmp = createTempDir('vc-k3s-test-');
    const projectDir = tmp;
    // fetchKubeconfig reads then writes the kubeconfig file. Stub the
    // intermediate file so the post-scp readFileSync doesn't crash.
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(projectDir, '.vibecarbon'), { recursive: true });
    writeFileSync(
      join(projectDir, '.vibecarbon', 'kubeconfig-e2e'),
      'apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    server: https://127.0.0.1:6443\n',
    );
    const khPath = join(tmp, '.vibecarbon', 'known_hosts_e2e');

    await fetchKubeconfig('1.2.3.4', '/tmp/key', khPath, projectDir, 'e2e');

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, argv] = spawnMock.mock.calls[0] as [string, string[]];
    expect(bin).toBe('scp');
    expect(argv).toContain('-o');
    expect(argv).toContain(`UserKnownHostsFile=${khPath}`);
    expect(argv).toContain('GlobalKnownHostsFile=/dev/null');
    expect(argv).toContain('StrictHostKeyChecking=accept-new');
    expect(argv).toContain('BatchMode=yes');
  });
});
