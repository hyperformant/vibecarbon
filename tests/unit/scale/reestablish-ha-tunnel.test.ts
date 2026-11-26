import { beforeEach, describe, expect, it, vi } from 'vitest';

// The k8s-ha scale belt (item I-1): after a database-node resize reboots the
// node that owns the host `wg0`, the repl-gateway crash-loops and the primary's
// pods-Ready wait would time out. `scaleReestablishHaTunnel` recreates the
// transport BEFORE that wait — but ONLY when the env is HA AND the database node
// was actually resized (a master/worker-only resize leaves wg0 intact, so we
// must not needlessly tear down a healthy tunnel).

vi.mock('@clack/prompts', async (orig) =>
  (await import('../../_shared/clack-fake.js')).quietClack(await orig(), {
    log: ['info', 'warn', 'error', 'step', 'success'],
    spinner: true,
    fns: ['note', 'outro'],
  }),
);

vi.mock('../../../src/failover.js', () => ({
  identifyServers: vi.fn(() => ({
    primary: {
      ip: '1.1.1.1',
      dbIp: '167.233.150.173',
      dbPrivateIp: '10.0.1.2',
    },
    standby: {
      ip: '2.2.2.2',
      dbIp: '157.180.115.19',
      dbPrivateIp: '10.0.1.2',
    },
  })),
}));

vi.mock('../../../src/lib/deploy/k8s/ha/index.js', () => ({
  reestablishReplicationTransport: vi.fn(async () => {}),
  // Imported by effects/k8s-ha.js, whose replication opener the belt calls.
  prepareReplicationTransport: vi.fn(async () => {}),
  configurePrimaryForReplication: vi.fn(async () => {}),
  setupReplication: vi.fn(async () => ({ streaming: true, lastState: '' })),
}));

vi.mock('../../../src/lib/iac/converge-cluster.js', () => ({
  convergeClusterInfra: vi.fn(async () => ({ outputs: {} })),
}));

const { SCALE_EFFECTS } = await import('../../../src/scale.js');
const { identifyServers } = await import('../../../src/failover.js');
const { reestablishReplicationTransport } = await import('../../../src/lib/deploy/k8s/ha/index.js');
const { convergeClusterInfra } = await import('../../../src/lib/iac/converge-cluster.js');
const { HetznerProvider } = await import('../../../src/lib/providers/hetzner.js');

const baseCtx = {
  environment: 'prod',
  envConfig: {},
  projectConfig: {},
  region: 'nbg1',
  secondaryRegion: 'ash',
};

describe('scaleReestablishHaTunnel gating', () => {
  beforeEach(() => {
    vi.mocked(reestablishReplicationTransport).mockClear();
    vi.mocked(identifyServers).mockClear();
  });

  it('is registered as the k8s scale-tier effect', () => {
    expect(typeof SCALE_EFFECTS.scaleReestablishHaTunnel).toBe('function');
  });

  it('no-ops for a non-HA env (single-cluster k8s has no tunnel)', async () => {
    await SCALE_EFFECTS.scaleReestablishHaTunnel({
      ...baseCtx,
      isHA: false,
      infraChanges: ['dbType'],
    });
    expect(reestablishReplicationTransport).not.toHaveBeenCalled();
    expect(identifyServers).not.toHaveBeenCalled();
  });

  it('no-ops when the database node was not resized (wg0 not disrupted)', async () => {
    await SCALE_EFFECTS.scaleReestablishHaTunnel({
      ...baseCtx,
      isHA: true,
      infraChanges: ['workerType', 'masterType'],
    });
    expect(reestablishReplicationTransport).not.toHaveBeenCalled();
  });

  it('re-establishes the transport when HA + database node resized', async () => {
    await SCALE_EFFECTS.scaleReestablishHaTunnel({
      ...baseCtx,
      isHA: true,
      infraChanges: ['dbType', 'workerType'],
    });
    expect(reestablishReplicationTransport).toHaveBeenCalledTimes(1);
    expect(reestablishReplicationTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryIp: '1.1.1.1',
        standbyIp: '2.2.2.2',
        primaryDbIp: '167.233.150.173',
        standbyDbIp: '157.180.115.19',
        primaryDbPrivateIp: '10.0.1.2',
        standbyDbPrivateIp: '10.0.1.2',
        sshKeyPath: expect.stringContaining('deploy_key_prod'),
      }),
    );
  });

  it('never throws out of the belt — a transport failure only warns', async () => {
    vi.mocked(reestablishReplicationTransport).mockRejectedValueOnce(new Error('ssh boom'));
    await expect(
      SCALE_EFFECTS.scaleReestablishHaTunnel({
        ...baseCtx,
        isHA: true,
        infraChanges: ['dbType'],
      }),
    ).resolves.toBeUndefined();
  });
});

// Review Focus 4. A database-node resize that REPLACED the node gives it a new
// public address. The record (identifyServers) still holds the old one until
// a deploy saves again, so the belt takes the converge's outputs, rebuilds the
// tunnel to the new addresses, and then re-opens UDP 51821 on both clusters'
// firewalls for them (openReplicationFirewallForPeers, the deploy's opener).
describe('scaleReestablishHaTunnel after a resize that replaced the database nodes', () => {
  const OLD = { primary: '167.233.150.173', standby: '157.180.115.19' };
  const NEW = { primary: '198.51.100.98', standby: '198.51.100.99' };
  const hetzner = new HetznerProvider('t');
  /** A firewall holding the peer rule the deploy wrote, by the provider's own builder. */
  const firewallAdmitting = (id: number, peer: string) => ({
    id,
    rules: hetzner.buildReplicationFirewallRules({ rules: [] }, peer),
  });

  function haCtx() {
    return {
      ...baseCtx,
      isHA: true,
      Provider: HetznerProvider,
      apiToken: 't',
      projectConfig: { projectName: 'acme' },
      envConfig: {
        ha: {
          primary: { stack: 'prod-primary', region: 'nbg1', dbIp: OLD.primary },
          standby: { stack: 'prod-standby', region: 'ash', dbIp: OLD.standby },
        },
      },
      changes: ['dbType'],
      newValues: { dbType: 'cx33' },
      infraChanges: ['dbType'],
      currentWorkerType: 'cx23',
    } as Record<string, unknown>;
  }

  function firewalls() {
    const byName: Record<string, ReturnType<typeof firewallAdmitting>> = {
      'acme-prod-primary-firewall': firewallAdmitting(1, OLD.standby),
      'acme-prod-standby-firewall': firewallAdmitting(2, OLD.primary),
    };
    const find = vi
      .spyOn(HetznerProvider.prototype, 'findFirewallByName')
      .mockImplementation(async (name: string) => structuredClone(byName[name]) ?? null);
    const set = vi
      .spyOn(HetznerProvider.prototype, 'setFirewallRules')
      .mockResolvedValue(undefined as never);
    return { find, set };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(reestablishReplicationTransport).mockClear();
    vi.mocked(convergeClusterInfra).mockReset();
  });

  it('both clusters: the tunnel and both firewalls take the new addresses, the firewalls after the tunnel', async () => {
    vi.mocked(convergeClusterInfra).mockImplementation(async ({ clusterEnv }) => ({
      outputs:
        clusterEnv === 'prod-standby'
          ? { masterIp: '2.2.2.2', dbIp: NEW.standby, dbPrivateIp: '10.0.1.2' }
          : { masterIp: '1.1.1.1', dbIp: NEW.primary, dbPrivateIp: '10.0.1.2' },
    }));
    const { find, set } = firewalls();
    const ctx = haCtx();

    await SCALE_EFFECTS.scaleApplyK8sChanges(ctx);
    await SCALE_EFFECTS.scaleReestablishHaTunnel(ctx);

    expect(reestablishReplicationTransport).toHaveBeenCalledWith(
      expect.objectContaining({ primaryDbIp: NEW.primary, standbyDbIp: NEW.standby }),
    );
    const written = Object.fromEntries(
      set.mock.calls.map(([id, rules]) => [id, JSON.stringify(rules)]),
    );
    // prod-primary's firewall admits the standby's new database node, and
    // prod-standby's the primary's; neither old address stays.
    expect(Object.keys(written).sort()).toEqual(['1', '2']);
    expect(written[1]).toContain(`"${NEW.standby}/32"`);
    expect(written[2]).toContain(`"${NEW.primary}/32"`);
    for (const rules of Object.values(written)) {
      expect(rules).not.toContain(OLD.primary);
      expect(rules).not.toContain(OLD.standby);
    }
    const transportAt = vi.mocked(reestablishReplicationTransport).mock.invocationCallOrder[0];
    expect(Math.min(...find.mock.invocationCallOrder)).toBeGreaterThan(transportAt);
  });

  it('the standby only: the primary firewall moves to it, the standby firewall is left as it is', async () => {
    vi.mocked(convergeClusterInfra).mockImplementation(async ({ clusterEnv }) => ({
      outputs:
        clusterEnv === 'prod-standby'
          ? { masterIp: '2.2.2.2', dbIp: NEW.standby, dbPrivateIp: '10.0.1.2' }
          : { masterIp: '1.1.1.1', dbIp: OLD.primary, dbPrivateIp: '10.0.1.2' },
    }));
    const { set } = firewalls();
    const ctx = haCtx();

    await SCALE_EFFECTS.scaleApplyK8sChanges(ctx);
    await SCALE_EFFECTS.scaleReestablishHaTunnel(ctx);

    expect(reestablishReplicationTransport).toHaveBeenCalledWith(
      expect.objectContaining({ primaryDbIp: OLD.primary, standbyDbIp: NEW.standby }),
    );
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][0]).toBe(1);
    expect(JSON.stringify(set.mock.calls[0][1])).toContain(`"${NEW.standby}/32"`);
    expect(JSON.stringify(set.mock.calls[0][1])).not.toContain(OLD.standby);
  });

  it('a firewall the provider cannot read only warns: the belt never throws', async () => {
    vi.mocked(convergeClusterInfra).mockResolvedValue({ outputs: {} });
    vi.spyOn(HetznerProvider.prototype, 'findFirewallByName').mockRejectedValue(
      new Error('hetzner 503'),
    );
    await expect(SCALE_EFFECTS.scaleReestablishHaTunnel(haCtx())).resolves.toBeUndefined();
    expect(reestablishReplicationTransport).toHaveBeenCalledTimes(1);
  });
});
