import { beforeEach, describe, expect, it, vi } from 'vitest';

// registry.js imports only sshRunAsync from compose/index.js — stub just that
// so the heavy compose module (spawn, ssh option builders, retry loops, …)
// never loads.
const sshRunAsyncMock = vi.fn();
vi.mock('../../../src/lib/deploy/compose/index.js', () => ({
  sshRunAsync: (...a: unknown[]) => sshRunAsyncMock(...a),
}));

const mod = import('../../../src/lib/deploy/compose/registry.js');

beforeEach(() => sshRunAsyncMock.mockReset());

/** command strings passed to sshRunAsync, in call order. */
function commands(): string[] {
  return sshRunAsyncMock.mock.calls.map((c) => String(c[2]));
}

describe('ensureComposeRegistry', () => {
  it('R9: is a no-op when the registry container is already running (idempotent)', async () => {
    const { ensureComposeRegistry } = await mod;
    sshRunAsyncMock.mockResolvedValueOnce('9f3c1a2b\n'); // docker ps -q returns an id
    await ensureComposeRegistry('1.2.3.4', '/tmp/key');
    expect(sshRunAsyncMock).toHaveBeenCalledTimes(1);
    expect(commands()[0]).toContain('docker ps');
    expect(commands().some((c) => c.includes('docker run'))).toBe(false);
  });

  it('R10: creates a standalone container bound to 127.0.0.1 with a persistent volume when absent', async () => {
    const { ensureComposeRegistry } = await mod;
    sshRunAsyncMock.mockResolvedValueOnce('   \n'); // ps -q empty → not running
    sshRunAsyncMock.mockResolvedValue(null); // rm + run succeed
    await ensureComposeRegistry('1.2.3.4', '/tmp/key');
    const runCmd = commands().find((c) => c.includes('docker run'));
    expect(runCmd, 'a docker run was issued').toBeDefined();
    expect(runCmd).toContain('-p 127.0.0.1:5000:5000');
    expect(runCmd).not.toContain('0.0.0.0');
    expect(runCmd).not.toMatch(/(?<!127\.0\.0\.1:)\b5000:5000\b/); // never a bare (unbound) port publish
    expect(runCmd).toContain('-v vibecarbon-registry-data:/var/lib/registry');
    expect(runCmd).toContain('--restart unless-stopped');
    expect(runCmd).toContain('--name vibecarbon-registry');
    // standalone: plain `docker run`, never `docker compose`
    expect(commands().some((c) => c.includes('docker compose'))).toBe(false);
    // pinned image tag (not latest, not a digest) as the terminal token
    expect((runCmd as string).trim().endsWith('registry:2')).toBe(true);
  });

  it('clears a stale (stopped) same-name container before running (rm-before-run ordering)', async () => {
    const { ensureComposeRegistry } = await mod;
    sshRunAsyncMock.mockResolvedValueOnce(''); // not running
    sshRunAsyncMock.mockResolvedValue(null);
    await ensureComposeRegistry('1.2.3.4', '/tmp/key');
    const rmIdx = commands().findIndex((c) => c.includes('docker rm -f vibecarbon-registry'));
    const runIdx = commands().findIndex((c) => c.includes('docker run'));
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(rmIdx).toBeLessThan(runIdx); // rm before run
    // the rm call carries { ignoreError: true } — a stopped/absent container
    // must not abort the sequence before the run is attempted.
    expect(sshRunAsyncMock.mock.calls[rmIdx][3]).toMatchObject({ ignoreError: true });
  });

  it('R7: surfaces a failed docker run (rejects — no swallow)', async () => {
    const { ensureComposeRegistry } = await mod;
    sshRunAsyncMock.mockResolvedValueOnce(''); // not running
    sshRunAsyncMock.mockResolvedValueOnce(null); // rm ok
    sshRunAsyncMock.mockRejectedValueOnce(new Error('docker: no space left on device'));
    await expect(ensureComposeRegistry('1.2.3.4', '/tmp/key')).rejects.toThrow(/no space left/);
  });

  it('re-exports the pure config constants for callers that only need registry.js', async () => {
    const registry = await mod;
    expect(registry.REGISTRY_IMAGE).toBe('registry:2');
    expect(registry.REGISTRY_CONTAINER).toBe('vibecarbon-registry');
    expect(registry.REGISTRY_PORT).toBe(5000);
    expect(registry.REGISTRY_PREFIX).toBe('127.0.0.1:5000/');
    expect(typeof registry.registryRunCommand).toBe('function');
    expect(typeof registry.registryEnsureShell).toBe('function');
  });
});
