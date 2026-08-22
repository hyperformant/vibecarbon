import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

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
function fakeChild(code = 0) {
  const child = {
    stdout: { on: vi.fn() },
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
    // First (and only) ssh probe resolves exit 0 → marker present → pollUntil
    // returns without a second attempt.
    spawnMock.mockImplementationOnce(() => fakeChild(0) as unknown as ReturnType<typeof spawn>);

    const tmp = mkdtempSync(join(tmpdir(), 'vc-k3s-test-'));
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

  it('fetchKubeconfig passes UserKnownHostsFile=<env known_hosts> to scp', async () => {
    // fetchKubeconfig's scp now goes through runCommandAsync (Task A3).
    const { fetchKubeconfig } = await k3sModulePromise;
    const spawnMock = vi.mocked(spawn);
    spawnMock.mockReset();
    spawnMock.mockImplementationOnce(() => fakeChild(0) as unknown as ReturnType<typeof spawn>);

    const tmp = mkdtempSync(join(tmpdir(), 'vc-k3s-test-'));
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
