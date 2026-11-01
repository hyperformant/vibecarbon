import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createK8sDnsWriter } from '../../../src/lib/deploy/k8s/dns-record.js';
import { StateTracker } from '../../../src/lib/deploy/state.js';

/**
 * Single-cluster k8s writes the domain's A record the moment deployK3s
 * reports the cluster's addresses (onInfraReady), not after the whole cluster
 * deploy (DO e2e 2026-10-31: dns.create ran after k3s.full, 290 s in). The
 * record, its value (the floating IP, else the master) and the k8s-dns-update
 * gate are unchanged; the post-deploy block still awaits it before the public
 * probe and writes it itself when nothing did (k8s-ha, a rerun).
 */
let setupSimple: ReturnType<typeof vi.fn>;
let calls: string[];

function writer(overrides: Record<string, unknown> = {}) {
  vi.spyOn(process, 'cwd').mockReturnValue(mkdtempSync(join(tmpdir(), 'vc-k8s-dns-')));
  const state = new StateTracker('quorum', 'e3');
  return {
    state,
    w: createK8sDnsWriter({
      domain: 'e3.example.com',
      dnsProvider: 'cloudflare',
      dnsToken: 'tok',
      dnsZoneId: 'zone-1',
      state,
      dnsWarmupPromise: Promise.resolve(),
      getDnsProvider: async () => ({ setupSimple }),
      ...overrides,
    }),
  };
}

beforeEach(() => {
  calls = [];
  setupSimple = vi.fn(async (_t, _z, _d, ip) => {
    calls.push(`write ${ip}`);
    return { success: true };
  });
});
afterEach(() => vi.restoreAllMocks());

describe('createK8sDnsWriter', () => {
  it('writes the floating IP as soon as the infra is ready, silently', async () => {
    const { w, state } = writer();
    w.onInfraReady({ masterIp: '198.51.100.7', floatingIp: '203.0.113.9' });
    await vi.waitFor(() => expect(setupSimple).toHaveBeenCalledTimes(1));
    expect(setupSimple).toHaveBeenCalledWith('tok', 'zone-1', 'e3.example.com', '203.0.113.9', {
      onProgress: expect.any(Function),
    });
    await w.finish('203.0.113.9');
    // The post-deploy write finds the gate already satisfied: one write.
    expect(setupSimple).toHaveBeenCalledTimes(1);
    expect(state.getStepResult('k8s-dns-update')).toEqual({ serverIp: '203.0.113.9' });
  });

  it('the post-deploy block still falls back to the master IP', async () => {
    const { w } = writer();
    w.onInfraReady({ masterIp: '198.51.100.7' });
    await w.finish('198.51.100.7');
    expect(calls).toEqual(['write 198.51.100.7']);
  });

  it('a refused early write fails the deploy at the post-deploy barrier', async () => {
    setupSimple.mockResolvedValue({ success: false, error: 'zone not found' });
    const { w } = writer();
    w.onInfraReady({ masterIp: '198.51.100.7', floatingIp: '203.0.113.9' });
    await expect(w.finish('203.0.113.9')).rejects.toThrow(
      'DNS A record for e3.example.com was not set: zone not found',
    );
  });

  it('a refused early write is not an unhandled rejection before the barrier', async () => {
    setupSimple.mockResolvedValue({ success: false, error: 'zone not found' });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      writer().w.onInfraReady({ floatingIp: '203.0.113.9' });
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('nothing started it (k8s-ha, no hook): the post-deploy block writes it, once', async () => {
    const { w } = writer();
    await w.finish('203.0.113.9');
    expect(setupSimple).toHaveBeenCalledExactlyOnceWith(
      'tok',
      'zone-1',
      'e3.example.com',
      '203.0.113.9',
    );
  });

  it('waits for the 0.0.0.0 warm-up write before writing the real IP', async () => {
    let releaseWarm!: () => void;
    const warm = new Promise<void>((r) => {
      releaseWarm = r;
    });
    const { w } = writer({ dnsWarmupPromise: warm });
    w.onInfraReady({ floatingIp: '203.0.113.9' });
    await new Promise((r) => setTimeout(r, 20));
    expect(setupSimple).not.toHaveBeenCalled();
    releaseWarm();
    await w.finish('203.0.113.9');
    expect(setupSimple).toHaveBeenCalledTimes(1);
  });

  it('manual DNS: the hook writes nothing', async () => {
    const { w } = writer({ dnsProvider: 'manual' });
    w.onInfraReady({ floatingIp: '203.0.113.9' });
    await new Promise((r) => setTimeout(r, 20));
    expect(setupSimple).not.toHaveBeenCalled();
  });

  it('a second infra signal does not write twice', async () => {
    const { w } = writer();
    w.onInfraReady({ floatingIp: '203.0.113.9' });
    w.onInfraReady({ floatingIp: '203.0.113.9' });
    await w.finish('203.0.113.9');
    expect(setupSimple).toHaveBeenCalledTimes(1);
  });
});

/**
 * I2: destroy deletes only records whose target it can attribute to the env
 * (planDestroyTargets ownedIps, which reads envConfig.floatingIp for single
 * k8s). The writer persists the IP before writing the record, so a deploy
 * that fails afterwards leaves a record destroy removes.
 */
describe('createK8sDnsWriter persists the target before writing', () => {
  it('the floating IP is on disk before the early write starts', async () => {
    const persisted: string[] = [];
    const persistOwnedIp = vi.fn((ip: string) => {
      persisted.push(ip);
      calls.push(`persist ${ip}`);
    });
    const { w } = writer({ persistOwnedIp });
    w.onInfraReady({ masterIp: '198.51.100.7', floatingIp: '203.0.113.9' });
    await w.finish('203.0.113.9');
    expect(calls[0]).toBe('persist 203.0.113.9');
    expect(calls.indexOf('persist 203.0.113.9')).toBeLessThan(calls.indexOf('write 203.0.113.9'));
    // destroy, reading what was persisted after a failed deploy, owns it.
    const { planDestroyTargets } = await import('../../../src/destroy.js');
    const { ownedIps } = planDestroyTargets(
      { deployMode: 'kubernetes', floatingIp: persisted[0] },
      { projectName: 'quorum' },
      'e3',
    );
    expect(ownedIps).toContain('203.0.113.9');
  });

  it('a target that could not be persisted is not written early', async () => {
    const persistOwnedIp = vi.fn(() => {
      throw new Error('config lock timeout');
    });
    const { w } = writer({ persistOwnedIp });
    w.onInfraReady({ floatingIp: '203.0.113.9' });
    await new Promise((r) => setTimeout(r, 20));
    expect(setupSimple).not.toHaveBeenCalled();
    // The post-deploy write persists first too, and fails loudly on it.
    await expect(w.finish('203.0.113.9')).rejects.toThrow('config lock timeout');
    expect(setupSimple).not.toHaveBeenCalled();
  });

  it('no floating IP: the early hook writes nothing (only the floating IP is persisted)', async () => {
    const persistOwnedIp = vi.fn();
    const { w } = writer({ persistOwnedIp });
    w.onInfraReady({ masterIp: '198.51.100.7' });
    await new Promise((r) => setTimeout(r, 20));
    expect(setupSimple).not.toHaveBeenCalled();
    expect(persistOwnedIp).not.toHaveBeenCalled();
  });
});

describe('the orchestrator wires it', () => {
  const src = readFileSync(join(__dirname, '../../../src/lib/deploy/orchestrator.js'), 'utf-8');

  it("single k8s passes the writer's onInfraReady into deployK3s's options", () => {
    const branch = src.slice(src.indexOf("} else if (tier === 'k8s') {"));
    const body = branch.slice(0, branch.indexOf('} else {'));
    expect(body).toMatch(/onInfraReady: k8sDns\.onInfraReady/);
  });

  it('single k8s, and only single k8s, persists envConfig.floatingIp through updateProjectConfig', () => {
    const wiring = src.slice(src.indexOf('createK8sDnsWriter({'));
    const args = wiring.slice(0, wiring.indexOf('})'));
    expect(args).toMatch(/persistOwnedIp:\s*tier === 'k8s'/);
    expect(args).toContain('updateProjectConfig(');
    expect(args).toMatch(/\.floatingIp = ip/);
  });

  it('the post-deploy DNS block goes through the same writer', () => {
    expect(src).toMatch(/await k8sDns\.finish\(k8sFloatingIp\)/);
  });
});
