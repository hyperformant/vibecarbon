import { describe, expect, it, vi } from 'vitest';

// waitForK3sReady holds ONE ssh session for /tmp/k3s-ready (remote-marker.js)
// instead of polling over repeated connects. The marker helper is mocked so
// nothing SSHes; the assertions are on what k3s.js hands it and on the error
// it raises when the wait runs out.
vi.mock('../../../src/lib/deploy/remote-marker.js', () => ({
  waitForRemoteMarker: vi.fn(),
  markerWaitScript: vi.fn(),
}));
vi.mock('../../../src/lib/command.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/command.js')>()),
  runCommandAsync: vi.fn(async () => {
    throw new Error('ssh: connect to host refused');
  }),
}));

describe('waitForK3sReady holds one session', () => {
  it('waits on /tmp/k3s-ready with the boot log and a deadline of maxWaitSec', async () => {
    const { waitForRemoteMarker } = await import('../../../src/lib/deploy/remote-marker.js');
    const { waitForK3sReady } = await import('../../../src/lib/deploy/k8s/k3s.js');
    vi.mocked(waitForRemoteMarker).mockReset();
    vi.mocked(waitForRemoteMarker).mockResolvedValue({ ready: true, connected: true });

    const before = Date.now();
    await waitForK3sReady('1.2.3.4', '/tmp/key', '/tmp/kh', 600);

    expect(waitForRemoteMarker).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(waitForRemoteMarker).mock.calls[0][0];
    expect(opts.markerPath).toBe('/tmp/k3s-ready');
    expect(opts.logPath).toBe('/var/log/vcboot');
    expect(opts.deadlineMs - before).toBeGreaterThanOrEqual(600_000);
    expect(opts.deadlineMs - before).toBeLessThan(601_000);
  });

  it('keeps the Last SSH error text when the wait runs out', async () => {
    const { waitForRemoteMarker } = await import('../../../src/lib/deploy/remote-marker.js');
    const { waitForK3sReady } = await import('../../../src/lib/deploy/k8s/k3s.js');
    vi.mocked(waitForRemoteMarker).mockReset();
    vi.mocked(waitForRemoteMarker).mockImplementation(async ({ run }) => {
      // run must absorb the ssh failure (the helper's contract: never throws).
      expect(await run('script', { timeoutMs: 1000, onLine: () => {} })).toBeNull();
      return { ready: false, connected: false };
    });

    await expect(waitForK3sReady('1.2.3.4', '/tmp/key', '/tmp/kh', 1)).rejects.toThrow(
      /k3s did not become ready on 1\.2\.3\.4 within 1s\. Last SSH error: ssh: connect to host refused/,
    );
  });

  it('hands the marker wait a stage reader that reports labels from real boot marks', async () => {
    const { waitForRemoteMarker } = await import('../../../src/lib/deploy/remote-marker.js');
    const { waitForK3sReady } = await import('../../../src/lib/deploy/k8s/k3s.js');
    vi.mocked(waitForRemoteMarker).mockReset();
    const stages: string[] = [];
    vi.mocked(waitForRemoteMarker).mockImplementation(async ({ onLine }) => {
      onLine?.('k 1762300000.5');
      onLine?.('a 1762299990.5'); // a reconnect's replay of an older mark
      onLine?.('r 1762300010.25');
      onLine?.('r 1762300010.25');
      return { ready: true, connected: true };
    });

    await waitForK3sReady('1.2.3.4', '/tmp/key', '/tmp/kh', 600, {
      onStage: (label: string) => stages.push(label),
    });

    expect(stages).toEqual(['installing Kubernetes', 'waiting for Kubernetes']);
  });

  it('works without an onStage callback', async () => {
    const { waitForRemoteMarker } = await import('../../../src/lib/deploy/remote-marker.js');
    const { waitForK3sReady } = await import('../../../src/lib/deploy/k8s/k3s.js');
    vi.mocked(waitForRemoteMarker).mockReset();
    vi.mocked(waitForRemoteMarker).mockImplementation(async ({ onLine }) => {
      onLine?.('k 1762300000.5');
      return { ready: true, connected: true };
    });
    await expect(waitForK3sReady('1.2.3.4', '/tmp/key', '/tmp/kh', 600)).resolves.toBeUndefined();
  });
});
