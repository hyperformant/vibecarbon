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
 * record's value is the cluster's ingress IP (clusterIngressIp: the floating
 * IP, else the master, which is every DigitalOcean cluster's), gated by
 * k8s-dns-update; the post-deploy block still awaits it before the public
 * probe and writes it itself when nothing set that IP. Single k8s only: k8s-ha
 * never builds this writer (k8s-ha-dns-single-writer.test.ts).
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
    await w.finish({ masterIp: '198.51.100.7', floatingIp: '203.0.113.9' });
    // The post-deploy write finds the gate already satisfied: one write.
    expect(setupSimple).toHaveBeenCalledTimes(1);
    expect(state.getStepResult('k8s-dns-update')).toEqual({ serverIp: '203.0.113.9' });
  });

  it('a cluster without a floating IP (DigitalOcean) gets its master IP, early, once', async () => {
    const { w } = writer();
    w.onInfraReady({ masterIp: '198.51.100.7' });
    await vi.waitFor(() => expect(setupSimple).toHaveBeenCalledTimes(1));
    await w.finish({ masterIp: '198.51.100.7' });
    expect(calls).toEqual(['write 198.51.100.7']);
  });

  it('a master replaced in this run: the record moves to the new master IP in the same run', async () => {
    // The last run left the record at the old master (DigitalOcean: no
    // floating IP to keep the address across a replacement).
    const { w, state } = writer();
    state.startStep('k8s-dns-update', {
      domain: 'e3.example.com',
      dnsProvider: 'cloudflare',
      serverIp: '198.51.100.7',
    });
    state.completeStep('k8s-dns-update', { serverIp: '198.51.100.7' });
    w.onInfraReady({ masterIp: '198.51.100.70' });
    await w.finish({ masterIp: '198.51.100.70' });
    expect(calls).toEqual(['write 198.51.100.70']);
    expect(state.getStepResult('k8s-dns-update')).toEqual({ serverIp: '198.51.100.70' });
  });

  it('a refused early write fails the deploy at the post-deploy barrier', async () => {
    setupSimple.mockResolvedValue({ success: false, error: 'zone not found' });
    const { w } = writer();
    w.onInfraReady({ masterIp: '198.51.100.7', floatingIp: '203.0.113.9' });
    await expect(w.finish({ floatingIp: '203.0.113.9' })).rejects.toThrow(
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

  it('nothing started it (the hook never fired): the post-deploy block writes it, once', async () => {
    const { w } = writer();
    await w.finish({ masterIp: '198.51.100.7', floatingIp: '203.0.113.9' });
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
    await w.finish({ floatingIp: '203.0.113.9' });
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
    await w.finish({ floatingIp: '203.0.113.9' });
    expect(setupSimple).toHaveBeenCalledTimes(1);
  });
});

/**
 * finish() reports where the records point and when the write that put them
 * there completed. The deploy releases a retired DigitalOcean reserved IP only
 * once the record's TTL has passed since then (k8s/retired-reserved-ip.js),
 * so an earlier run's write the gate found unchanged keeps its own time, and
 * a write this run made starts the wait now.
 */
describe('createK8sDnsWriter.finish reports the write', () => {
  const T0 = Date.parse('2026-11-10T08:00:00Z');
  const T1 = Date.parse('2026-11-11T09:30:00Z');
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const earlierRunWrote = (state: StateTracker, ip: string) => {
    vi.setSystemTime(T0);
    state.startStep('k8s-dns-update', {
      domain: 'e3.example.com',
      dnsProvider: 'cloudflare',
      serverIp: ip,
    });
    state.completeStep('k8s-dns-update', { serverIp: ip });
    vi.setSystemTime(T1);
  };

  it("this run's write: the master's address, from now", async () => {
    vi.setSystemTime(T1);
    const { w } = writer();
    w.onInfraReady({ masterIp: '198.51.100.7' });
    expect(await w.finish({ masterIp: '198.51.100.7' })).toEqual({
      target: '198.51.100.7',
      changedAt: T1,
    });
  });

  it("an earlier run's write the gate found unchanged keeps that run's time", async () => {
    const { w, state } = writer();
    earlierRunWrote(state, '198.51.100.7');
    expect(await w.finish({ masterIp: '198.51.100.7' })).toEqual({
      target: '198.51.100.7',
      changedAt: T0,
    });
    expect(setupSimple).not.toHaveBeenCalled();
  });

  it('a record this run moved (the reserved IP to the master) starts from this run', async () => {
    const { w, state } = writer();
    earlierRunWrote(state, '203.0.113.9');
    expect(await w.finish({ masterIp: '198.51.100.7' })).toEqual({
      target: '198.51.100.7',
      changedAt: T1,
    });
    expect(calls).toEqual(['write 198.51.100.7']);
  });

  it('no ingress IP: nothing to report', async () => {
    const { w } = writer();
    expect(await w.finish({})).toBeNull();
  });
});

/**
 * I2: destroy deletes only records whose target it can attribute to the env
 * (planDestroyTargets ownedIps, which reads envConfig.ingressIp for single
 * k8s). The writer persists the IP before writing the record, so a deploy
 * that fails afterwards leaves a record destroy removes. The floating IP is
 * persisted beside it only where the cluster has one: destroy's backstop
 * releases a recorded floatingIp by address, and must never be handed a
 * DigitalOcean master's own address.
 */
describe('createK8sDnsWriter persists the target before writing', () => {
  type Target = { ingressIp: string; floatingIp: string | null };
  const recorder = () => {
    const persisted: Target[] = [];
    const persistOwnedIp = vi.fn((t: Target) => {
      persisted.push(t);
      calls.push(`persist ${t.ingressIp}`);
    });
    return { persisted, persistOwnedIp };
  };
  const destroyPlanFor = async (t: Target) => {
    const { planDestroyTargets, planK8sBackstopTargets } = await import('../../../src/destroy.js');
    const envConfig = {
      deployMode: 'kubernetes',
      region: 'nyc3',
      ingressIp: t.ingressIp,
      ...(t.floatingIp && { floatingIp: t.floatingIp }),
    };
    const plan = planDestroyTargets(envConfig, { projectName: 'quorum' }, 'e3');
    const [backstop] = planK8sBackstopTargets({
      plan,
      envConfig,
      projectConfig: { projectName: 'quorum' },
    });
    return { ownedIps: plan.ownedIps, releases: backstop.floatingIp };
  };

  it('the floating IP is on disk before the early write starts', async () => {
    const { persisted, persistOwnedIp } = recorder();
    const { w } = writer({ persistOwnedIp });
    w.onInfraReady({ masterIp: '198.51.100.7', floatingIp: '203.0.113.9' });
    await w.finish({ masterIp: '198.51.100.7', floatingIp: '203.0.113.9' });
    expect(calls[0]).toBe('persist 203.0.113.9');
    expect(calls.indexOf('persist 203.0.113.9')).toBeLessThan(calls.indexOf('write 203.0.113.9'));
    expect(persisted[0]).toEqual({ ingressIp: '203.0.113.9', floatingIp: '203.0.113.9' });
    // destroy, reading what was persisted after a failed deploy, owns it.
    const { ownedIps, releases } = await destroyPlanFor(persisted[0]);
    expect(ownedIps).toContain('203.0.113.9');
    expect(releases).toBe('203.0.113.9');
  });

  it('no floating IP (DigitalOcean): the master IP is on disk as ingressIp only, before the write', async () => {
    const { persisted, persistOwnedIp } = recorder();
    const { w } = writer({ persistOwnedIp });
    w.onInfraReady({ masterIp: '198.51.100.7' });
    await w.finish({ masterIp: '198.51.100.7' });
    expect(calls.indexOf('persist 198.51.100.7')).toBeLessThan(calls.indexOf('write 198.51.100.7'));
    expect(persisted[0]).toEqual({ ingressIp: '198.51.100.7', floatingIp: null });
    // destroy owns the record, and its reserved-IP backstop has nothing to
    // release: the master's own address is never treated as a reserved IP.
    const { ownedIps, releases } = await destroyPlanFor(persisted[0]);
    expect(ownedIps).toContain('198.51.100.7');
    expect(releases).toBeNull();
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
    await expect(w.finish({ floatingIp: '203.0.113.9' })).rejects.toThrow('config lock timeout');
    expect(setupSimple).not.toHaveBeenCalled();
  });

  it('no address at all: the early hook writes and persists nothing', async () => {
    const persistOwnedIp = vi.fn();
    const { w } = writer({ persistOwnedIp });
    w.onInfraReady({ dbIp: '192.0.2.10' });
    await new Promise((r) => setTimeout(r, 20));
    await w.finish({});
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

  it('single k8s, and only single k8s, persists envConfig.ingressIp through updateProjectConfig', () => {
    const wiring = src.slice(src.indexOf('createK8sDnsWriter({'));
    const args = wiring.slice(0, wiring.indexOf('\n        })'));
    expect(args).toMatch(/persistOwnedIp:\s*tier === 'k8s'/);
    expect(args).toContain('updateProjectConfig(');
    expect(args).toMatch(/env\.ingressIp = ingressIp/);
    // The floating IP only when the cluster has one, never the ingress IP.
    expect(args).toMatch(/if \(floatingIp\) env\.floatingIp = floatingIp/);
    expect(args).not.toMatch(/\.floatingIp = ingressIp/);
  });

  it("the post-deploy DNS block goes through the same writer, with deployK3s's result", () => {
    expect(src).toMatch(/await k8sDns\.finish\(deployResult\)/);
  });
});
