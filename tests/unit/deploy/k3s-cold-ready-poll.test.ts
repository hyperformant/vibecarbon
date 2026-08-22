import { describe, expect, it, vi } from 'vitest';

// The two cold-ready waits (waitForK3sReady + waitForK3sBinary) poll an SSH
// marker under a time budget. They MUST pass a tight `maxDelayMs` so the
// exponential backoff tail doesn't add up to ~15s of dead time past the moment
// the node actually becomes ready (the shared pollUntil default is 15_000,
// tuned for multi-minute waits — over-long for a 34–50s cold-ready event).
//
// We mock retry.js so the probe never actually SSHes; the assertion is purely
// on the OPTIONS the callers hand to pollUntil. runWithRetry is re-exported as
// a passthrough because other k3s.js code paths import it (unused here).
//
// Both modules are imported INSIDE each test (not via top-level `import()`
// promises): under full-suite parallel load, a top-level dynamic import can
// evaluate k3s.js before this file's hoisted retry.js mock has finished
// applying to the transitive import, leaving waitForK3sReady bound to the REAL
// pollUntil — the mock then sees 0 calls (an intermittent, suite-only flake).
// A plain `await import()` inside the test runs after the mock is fully live.
vi.mock('../../../src/lib/retry.js', () => ({
  pollUntil: vi.fn(async () => true),
  runWithRetry: vi.fn(),
}));

describe('cold-ready polls pass a tight maxDelayMs (not the 15s shared default)', () => {
  it('waitForK3sReady caps the poll tail at 5s', async () => {
    const { pollUntil } = await import('../../../src/lib/retry.js');
    const { waitForK3sReady } = await import('../../../src/lib/deploy/k8s/k3s.js');
    vi.mocked(pollUntil).mockClear();

    await waitForK3sReady('1.2.3.4', '/tmp/key', '/tmp/kh', 600);

    expect(pollUntil).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(pollUntil).mock.calls[0][1];
    expect(opts?.maxDelayMs).toBe(5000);
    // Budget must still be honoured (derived from maxWaitSec).
    expect(opts?.budgetMs).toBe(600_000);
  });

  it('waitForK3sBinary caps the poll tail at 5s', async () => {
    const { pollUntil } = await import('../../../src/lib/retry.js');
    const { waitForK3sBinary } = await import('../../../src/lib/deploy/k8s/k3s.js');
    vi.mocked(pollUntil).mockClear();

    await waitForK3sBinary('root@1.2.3.4', '/tmp/key', '/tmp/kh', 300);

    expect(pollUntil).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(pollUntil).mock.calls[0][1];
    expect(opts?.maxDelayMs).toBe(5000);
    expect(opts?.budgetMs).toBe(300_000);
  });
});
