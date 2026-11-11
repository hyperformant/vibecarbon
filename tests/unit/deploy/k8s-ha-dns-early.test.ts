import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * k8s-ha writes its DNS records as soon as both clusters' ingress IPs (the
 * floating IP, or a DigitalOcean cluster's master) are known, so the first
 * certificate's issuance overlaps the rest of the deploy, instead of after the
 * replication gate.
 *
 * Why the step sat after the replication gate (archived history: the step
 * was "5." in the first deployK8sHA, after replication, with no comment or
 * commit tying the two): plain sequence, not an invariant. The invariants that
 * do matter hold before the write:
 *   - DNS only ever points at the SERVING primary: the role primary comes
 *     from the persisted role mapping (haStacks, which swapHaRoles flips), so
 *     after a failover it is the promoted cluster;
 *   - never during a failover: every HA deploy refuses a failover in flight
 *     at entry, before any work (assertNoFailoverInFlight);
 *   - the same records: the same setupHA call and arguments as before.
 * Failover and failback flips live in src/failover.js, untouched.
 */
const setupHA = vi.fn();
vi.mock('../../../src/lib/dns-provider.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getDnsProvider: async () => ({ setupHA }),
}));

let gate: Promise<void> | null = null;
let failRole: string | null = null;
const FLOATING = {
  'e4-primary': { masterIp: '10.9.0.1', floatingIp: '203.0.113.1' },
  'e4-standby': { masterIp: '10.9.0.2', floatingIp: '203.0.113.2' },
};
/** What deployK3s reports per stack; no floatingIp is a DigitalOcean cluster. */
let IPS: Record<string, { masterIp: string; floatingIp?: string }> = FLOATING;
const deployK3s = vi.fn(async (opts: Record<string, unknown>) => {
  const ips = IPS[opts.environment as string];
  (opts.onInfraReady as (i: object) => void)?.({
    ...ips,
    dbIp: '1.1.1.1',
    dbPrivateIp: '10.0.1.2',
  });
  if (gate) await gate; // the slow steps (manifests, rollout)
  if (failRole === opts.role) throw new Error(`${opts.role} rollout failed`);
  if (opts.role === 'primary') (opts.onImageBuilt as (t: string) => void)?.('10.0.1.1:5000/q:t');
  return { ...ips, dbIp: '1.1.1.1', dbPrivateIp: '10.0.1.2', kubeconfig: '/k', imageTag: 'x' };
});
vi.mock('../../../src/lib/deploy/k8s/k3s.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/deploy/k8s/k3s.js')>()),
  deployK3s,
}));
vi.mock('../../../src/lib/iac/index.js', () => ({
  summarizePulumiError: (err: unknown) => String((err as Error)?.message ?? err),
}));
vi.mock('../../../src/lib/deploy/k8s/ha/index.js', () => ({
  prepareReplicationTransport: vi.fn(async () => {}),
  configurePrimaryForReplication: vi.fn(async () => {}),
  setupReplication: vi.fn(async () => ({ streaming: true, lastState: '' })),
}));
vi.mock('../../../src/lib/deploy/k8s/ha/image-copy.js', () => ({
  copyAppImageToStandby: vi.fn(async () => ({ digest: 'sha256:aa', skipped: true })),
}));

const { K8S_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/k8s-ha.js');
const { haStacksFrom } = await import('../../../src/lib/deploy/standby-types.js');
const { swapHaRoles } = await import('../../../src/failover.js');
const { planDestroyTargets, planK8sBackstopTargets } = await import('../../../src/destroy.js');

let dir: string;
const config = () => JSON.parse(readFileSync(join(dir, '.vibecarbon.json'), 'utf8'));
const options = (extra: Record<string, unknown> = {}) => ({
  projectName: 'q',
  environment: 'e4',
  region: 'nbg1',
  secondaryRegion: 'hel1',
  domain: 'e4.example.com',
  dnsProvider: 'cloudflare',
  dnsToken: 'tok',
  dnsZoneId: 'zone-1',
  ...extra,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-k8s-ha-dns-'));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  writeFileSync(
    join(dir, '.vibecarbon.json'),
    JSON.stringify({
      projectName: 'q',
      environments: {
        e4: { deployMode: 'kubernetes', ha: { enabled: true }, status: 'deploying' },
      },
    }),
  );
  setupHA.mockReset();
  setupHA.mockResolvedValue({ success: true });
  deployK3s.mockClear();
  gate = null;
  failRole = null;
  IPS = FLOATING;
});
afterEach(() => vi.restoreAllMocks());

describe('k8s-ha DNS: written once both ingress IPs are known', () => {
  it('starts before the slow cluster steps finish, with the same setupHA arguments', async () => {
    let release!: () => void;
    gate = new Promise((r) => {
      release = r;
    });
    const ctx: Record<string, unknown> = {
      options: options(),
      dnsWarmupPromise: Promise.resolve(),
    };
    const run = K8S_HA_EFFECTS.haK8sProvisionClusters(ctx);
    await vi.waitFor(() => expect(setupHA).toHaveBeenCalledTimes(1));
    release();
    await run;
    expect(setupHA).toHaveBeenCalledWith(
      'tok',
      'zone-1',
      'e4.example.com',
      [
        { name: 'q-nbg1', ip: '203.0.113.1' },
        { name: 'q-hel1', ip: '203.0.113.2' },
      ],
      { onProgress: expect.any(Function) },
    );
    // The old position is now the barrier: it awaits the write, writes nothing more.
    await K8S_HA_EFFECTS.haK8sUpdateDns(ctx);
    expect(setupHA).toHaveBeenCalledTimes(1);
  });

  it('the targets are on disk before the write', async () => {
    const ctx: Record<string, unknown> = {
      options: options(),
      dnsWarmupPromise: Promise.resolve(),
    };
    setupHA.mockImplementation(async () => {
      // At write time, destroy already owns both IPs.
      const { ownedIps } = planDestroyTargets(config().environments.e4, { projectName: 'q' }, 'e4');
      expect(ownedIps).toEqual(expect.arrayContaining(['203.0.113.1', '203.0.113.2']));
      return { success: true };
    });
    await K8S_HA_EFFECTS.haK8sProvisionClusters(ctx);
    expect(setupHA).toHaveBeenCalledTimes(1);
  });

  it('waits for the 0.0.0.0 warm-up write first', async () => {
    let releaseWarm!: () => void;
    const warm = new Promise<void>((r) => {
      releaseWarm = r;
    });
    let release!: () => void;
    gate = new Promise((r) => {
      release = r;
    });
    const ctx: Record<string, unknown> = { options: options(), dnsWarmupPromise: warm };
    const run = K8S_HA_EFFECTS.haK8sProvisionClusters(ctx);
    await new Promise((r) => setTimeout(r, 20));
    expect(setupHA).not.toHaveBeenCalled();
    releaseWarm();
    await vi.waitFor(() => expect(setupHA).toHaveBeenCalledTimes(1));
    release();
    await run;
  });

  it('after swapHaRoles the early write targets the promoted (new) primary', async () => {
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({
        projectName: 'q',
        environments: {
          e4: {
            deployMode: 'kubernetes',
            region: 'nbg1',
            secondaryRegion: 'hel1',
            status: 'deployed',
            ha: {
              enabled: true,
              primary: { stack: 'e4-primary', region: 'nbg1', floatingIp: '203.0.113.1' },
              standby: { stack: 'e4-standby', region: 'hel1', floatingIp: '203.0.113.2' },
            },
          },
        },
      }),
    );
    swapHaRoles('e4');
    const env = config().environments.e4;
    const ctx: Record<string, unknown> = {
      options: options({
        region: env.region,
        secondaryRegion: env.secondaryRegion,
        haStacks: haStacksFrom(env),
      }),
      dnsWarmupPromise: Promise.resolve(),
    };
    await K8S_HA_EFFECTS.haK8sProvisionClusters(ctx);
    const servers = setupHA.mock.calls[0][3] as Array<{ ip: string }>;
    // e4-standby was promoted: its ingress IP is the serving primary now.
    expect(servers[0].ip).toBe('203.0.113.2');
    expect(servers[1].ip).toBe('203.0.113.1');
    expect((ctx.primaryResult as { floatingIp: string }).floatingIp).toBe('203.0.113.2');
    // Persisted into the role slots the failover wrote.
    expect(config().environments.e4.ha.primary.floatingIp).toBe('203.0.113.2');
  });

  it('a deploy that fails after the write leaves records destroy owns', async () => {
    failRole = 'primary';
    const ctx: Record<string, unknown> = {
      options: options(),
      dnsWarmupPromise: Promise.resolve(),
    };
    await expect(K8S_HA_EFFECTS.haK8sProvisionClusters(ctx)).rejects.toThrow(
      /primary rollout failed/,
    );
    expect(setupHA).toHaveBeenCalledTimes(1);
    const { ownedIps } = planDestroyTargets(config().environments.e4, { projectName: 'q' }, 'e4');
    expect(ownedIps).toEqual(expect.arrayContaining(['203.0.113.1', '203.0.113.2']));
  });

  it('a refused early write fails the deploy at update-dns', async () => {
    setupHA.mockResolvedValue({ success: false, error: 'zone locked' });
    const ctx: Record<string, unknown> = {
      options: options(),
      dnsWarmupPromise: Promise.resolve(),
    };
    await K8S_HA_EFFECTS.haK8sProvisionClusters(ctx);
    await expect(K8S_HA_EFFECTS.haK8sUpdateDns(ctx)).rejects.toThrow(/zone locked/);
  });

  it('no floating IP (DigitalOcean): the masters, on disk as ingressIp only, before the write', async () => {
    IPS = {
      'e4-primary': { masterIp: '198.51.100.1' },
      'e4-standby': { masterIp: '198.51.100.2' },
    };
    const ctx: Record<string, unknown> = {
      options: options(),
      dnsWarmupPromise: Promise.resolve(),
    };
    setupHA.mockImplementation(async () => {
      const env = config().environments.e4;
      expect(env.ha.primary.ingressIp).toBe('198.51.100.1');
      expect(env.ha.standby.ingressIp).toBe('198.51.100.2');
      return { success: true };
    });
    await K8S_HA_EFFECTS.haK8sProvisionClusters(ctx);
    expect(setupHA.mock.calls[0][3]).toEqual([
      { name: 'q-nbg1', ip: '198.51.100.1' },
      { name: 'q-hel1', ip: '198.51.100.2' },
    ]);
    const env = config().environments.e4;
    expect(env.ha.primary).not.toHaveProperty('floatingIp');
    expect(env.ha.standby).not.toHaveProperty('floatingIp');
    // destroy owns both records, and its reserved-IP backstop is never
    // handed a master's own address.
    const plan = planDestroyTargets(env, { projectName: 'q' }, 'e4');
    expect(plan.ownedIps).toEqual(expect.arrayContaining(['198.51.100.1', '198.51.100.2']));
    const targets = planK8sBackstopTargets({
      plan,
      envConfig: env,
      projectConfig: { projectName: 'q' },
    });
    expect(targets.map((t: { reservedIps: unknown[] }) => t.reservedIps)).toEqual([[], []]);
    // The barrier finds the same addresses and writes nothing more.
    await K8S_HA_EFFECTS.haK8sUpdateDns(ctx);
    expect(setupHA).toHaveBeenCalledTimes(1);
  });

  it('no floating IP: a retired reserved IP on record survives the write, for its release', async () => {
    // A DigitalOcean env made before 2026-11: each side still records the
    // reserved IP its domain pointed at. The write moves the records to the
    // masters and keeps the reserved IP on record, where the deploy's
    // release (and destroy's backstop) find it.
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({
        projectName: 'q',
        environments: {
          e4: {
            deployMode: 'kubernetes',
            status: 'deployed',
            ha: {
              enabled: true,
              primary: { stack: 'e4-primary', floatingIp: '203.0.113.1' },
              standby: { stack: 'e4-standby', floatingIp: '203.0.113.2' },
            },
          },
        },
      }),
    );
    IPS = {
      'e4-primary': { masterIp: '198.51.100.1' },
      'e4-standby': { masterIp: '198.51.100.2' },
    };
    const ctx: Record<string, unknown> = {
      options: options(),
      dnsWarmupPromise: Promise.resolve(),
    };
    await K8S_HA_EFFECTS.haK8sProvisionClusters(ctx);
    expect((setupHA.mock.calls[0][3] as Array<{ ip: string }>).map((s) => s.ip)).toEqual([
      '198.51.100.1',
      '198.51.100.2',
    ]);
    const { ha } = config().environments.e4;
    expect(ha.primary).toMatchObject({ ingressIp: '198.51.100.1', floatingIp: '203.0.113.1' });
    expect(ha.standby).toMatchObject({ ingressIp: '198.51.100.2', floatingIp: '203.0.113.2' });
  });

  it('the barrier reports where the records point and since when (ctx.dnsWrite)', async () => {
    // The orchestrator releases a DigitalOcean env's retired reserved IP only
    // once the record's TTL has passed since this write (retired-reserved-ip.js).
    IPS = {
      'e4-primary': { masterIp: '198.51.100.1' },
      'e4-standby': { masterIp: '198.51.100.2' },
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-11-11T09:00:00Z'));
      const ctx: Record<string, unknown> = {
        options: options(),
        dnsWarmupPromise: Promise.resolve(),
      };
      await K8S_HA_EFFECTS.haK8sProvisionClusters(ctx);
      vi.setSystemTime(Date.parse('2026-11-11T09:20:00Z'));
      await K8S_HA_EFFECTS.haK8sUpdateDns(ctx);
      // The early write's time, not the barrier's: nothing was written then.
      expect(ctx.dnsWrite).toEqual({
        target: '198.51.100.1',
        changedAt: Date.parse('2026-11-11T09:00:00Z'),
      });

      // A primary whose address moved after the early write: the barrier's own write.
      ctx.primaryResult = { masterIp: '198.51.100.11' };
      await K8S_HA_EFFECTS.haK8sUpdateDns(ctx);
      expect(ctx.dnsWrite).toEqual({
        target: '198.51.100.11',
        changedAt: Date.parse('2026-11-11T09:20:00Z'),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('manual DNS: the barrier reports no write', async () => {
    const ctx: Record<string, unknown> = {
      options: options({ dnsProvider: 'manual' }),
      dnsWarmupPromise: Promise.resolve(),
    };
    await K8S_HA_EFFECTS.haK8sProvisionClusters(ctx);
    await K8S_HA_EFFECTS.haK8sUpdateDns(ctx);
    expect(ctx.dnsWrite).toBeUndefined();
  });

  it('manual DNS: nothing written early', async () => {
    const ctx: Record<string, unknown> = {
      options: options({ dnsProvider: 'manual' }),
      dnsWarmupPromise: Promise.resolve(),
    };
    await K8S_HA_EFFECTS.haK8sProvisionClusters(ctx);
    expect(setupHA).not.toHaveBeenCalled();
  });
});
