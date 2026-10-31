/**
 * Task 6: fan-out asymmetry + role↔stack mapping.
 *
 * haK8sProvisionClusters fans out deployK3s ×2 (primary + standby in
 * parallel). Pilot-light standby needs it to
 * produce a specific ASYMMETRY, not a symmetric HA pair:
 *   - primary: role 'primary', full sizing (minWorkers/maxWorkers as
 *     configured).
 *   - standby: role 'standby', minWorkers 0 (no Pulumi-provisioned worker
 *     nodes — just master + database), maxWorkers carried through unchanged,
 *     and caBoundsMin set to the PRIMARY's minWorkers (dormant CA bounds —
 *     the standby's cluster-autoscaler is rendered pre-sized for promotion
 *     day so a failover only has to flip its replica count 0→1, never
 *     re-render --nodes).
 *
 * It also owns the role↔stack MAPPING: stacks are cluster identities named
 * at birth ("e4-primary"/"e4-standby"); roles flip at failover, and failover
 * persists the swap under envConfig.ha.{primary,standby}.stack. A redeploy
 * after a failover must follow that persisted mapping (via
 * options.haStacks) for BOTH the stack name AND region fed to deployK3s —
 * otherwise it would re-warm the dormant pilot cluster and zero out the one
 * actually serving traffic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const deployK3s = vi.fn(async (opts: Record<string, unknown>) => ({
  masterIp: '1.1.1.1',
  dbIp: '2.2.2.2',
  floatingIp: '3.3.3.3',
  dbPrivateIp: '10.0.1.2',
  kubeconfig: `/tmp/kubeconfig-${opts.environment}`,
}));

vi.mock('../../../src/lib/deploy/k8s/k3s.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/deploy/k8s/k3s.js')>()),
  deployK3s,
}));

// Stubbed so the fan-out doesn't touch real infra. `initBackend` used to be
// mocked here too; it is gone — the per-bucket state lock serializes the stack
// operations it existed to keep from racing.
vi.mock('../../../src/lib/iac/index.js', () => ({
  summarizePulumiError: (err: unknown) => String((err as Error)?.message ?? err),
}));

// The WireGuard transport prep + primary replication config the early-prep
// task chains off both cluster's onInfraReady/settlement — heavy SSH work in
// reality, no-ops here. setupReplication is imported by k8s-ha.js too
// (used by a different effect, not haK8sProvisionClusters) so it's stubbed
// for completeness even though this test never reaches it.
vi.mock('../../../src/lib/deploy/k8s/ha/index.js', () => ({
  prepareReplicationTransport: vi.fn(async () => {}),
  configurePrimaryForReplication: vi.fn(async () => {}),
  setupReplication: vi.fn(async () => ({ streaming: true, lastState: '' })),
}));

// The standby image copy runs once the transport is up; stubbed so no test
// reaches the real ssh copy.
vi.mock('../../../src/lib/deploy/k8s/ha/image-copy.js', () => ({
  copyAppImageToStandby: vi.fn(async () => ({ digest: 'sha256:aa', skipped: true })),
}));

const { K8S_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/k8s-ha.js');

/** Minimal ctx = { options } — mirrors how the orchestrator invokes k8s-ha effects. */
async function runFanOut(options: Record<string, unknown>) {
  const ctx: Record<string, unknown> = { options };
  await K8S_HA_EFFECTS.haK8sProvisionClusters(ctx);
  return ctx;
}

beforeEach(() => {
  deployK3s.mockClear();
});

describe('haK8sProvisionClusters pilot-light asymmetry', () => {
  it('standby branch gets role=standby, minWorkers 0, primary CA bounds', async () => {
    const ctx = await runFanOut({
      environment: 'e4',
      region: 'nbg1',
      secondaryRegion: 'hel1',
      minWorkers: 2,
      maxWorkers: 5,
      masterServerType: 'cx23',
      dbServerType: 'cx23',
      workerServerType: 'cpx21',
    });

    const calls = deployK3s.mock.calls.map(([o]) => o as Record<string, unknown>);
    const standbyCall = calls.find((o) => o.role === 'standby');
    expect(standbyCall).toBeTruthy();
    expect(standbyCall?.environment).toBe('e4-standby');
    expect(standbyCall?.region).toBe('hel1');
    expect(standbyCall?.minWorkers).toBe(0);
    expect(standbyCall?.maxWorkers).toBe(5);
    expect(standbyCall?.caBoundsMin).toBe(2);

    const primaryCall = calls.find((o) => o.role === 'primary');
    expect(primaryCall).toBeTruthy();
    expect(primaryCall?.environment).toBe('e4-primary');
    expect(primaryCall?.region).toBe('nbg1');
    expect(primaryCall?.minWorkers).toBe(2);
    expect(primaryCall?.maxWorkers).toBe(5);

    // Task 7 persists these off ctx.primaryResult/standbyResult — both sides
    // must carry their stack identity + the region + server types actually
    // deployed (C2/I5: the orchestrator persists ha.{primary,standby}.region and
    // .{master,db}ServerType from these, not the options-level flags).
    expect((ctx.primaryResult as Record<string, unknown>).stack).toBe('e4-primary');
    expect((ctx.standbyResult as Record<string, unknown>).stack).toBe('e4-standby');
    expect((ctx.primaryResult as Record<string, unknown>).workerServerType).toBe('cpx21');
    expect((ctx.primaryResult as Record<string, unknown>).region).toBe('nbg1');
    expect((ctx.standbyResult as Record<string, unknown>).region).toBe('hel1');
    expect((ctx.primaryResult as Record<string, unknown>).masterServerType).toBe('cx23');
    expect((ctx.primaryResult as Record<string, unknown>).dbServerType).toBe('cx23');
    expect((ctx.standbyResult as Record<string, unknown>).masterServerType).toBe('cx23');
    expect((ctx.standbyResult as Record<string, unknown>).dbServerType).toBe('cx23');
  });

  it('deploy -restore seeds the primary only: the standby always deploys restore: null', async () => {
    const restore = {
      backup: 'base_000000010000000000000003',
      target: 'latest',
      recoveryConf: '-restore_command\nrestore_command = \'wal-g wal-fetch "%f" "%p"\'',
      sizeBytes: 1024,
    };
    await runFanOut({ environment: 'e4', region: 'nbg1', secondaryRegion: 'hel1', restore });
    const calls = deployK3s.mock.calls.map(([o]) => o as Record<string, unknown>);
    expect(calls.find((o) => o.role === 'primary')?.restore).toEqual(restore);
    expect(calls.find((o) => o.role === 'standby')?.restore).toBeNull();
  });

  it('follows a persisted post-failover role mapping (stacks swapped)', async () => {
    const ctx = await runFanOut({
      environment: 'e4',
      region: 'hel1',
      secondaryRegion: 'nbg1',
      minWorkers: 2,
      maxWorkers: 5,
      haStacks: {
        primary: { stack: 'e4-standby', region: 'hel1' },
        standby: { stack: 'e4-primary', region: 'nbg1' },
      },
    });

    const calls = deployK3s.mock.calls.map(([o]) => o as Record<string, unknown>);
    const primaryCall = calls.find((o) => o.role === 'primary');
    // The promoted cluster keeps its stack identity — deploy is the role
    // reconciler, it must never rename an existing cluster's Pulumi stack.
    expect(primaryCall?.environment).toBe('e4-standby');
    expect(primaryCall?.region).toBe('hel1');

    const standbyCall = calls.find((o) => o.role === 'standby');
    // The ex-primary converges to pilot-light under ITS stack identity.
    expect(standbyCall?.environment).toBe('e4-primary');
    expect(standbyCall?.region).toBe('nbg1');

    expect((ctx.primaryResult as Record<string, unknown>).stack).toBe('e4-standby');
    expect((ctx.standbyResult as Record<string, unknown>).stack).toBe('e4-primary');
    // C2: the region rides along with the ACTING side (from the haStacks
    // mapping), so the orchestrator persists the deployed region even under a
    // post-failover swap — never the un-swapped options-level flags.
    expect((ctx.primaryResult as Record<string, unknown>).region).toBe('hel1');
    expect((ctx.standbyResult as Record<string, unknown>).region).toBe('nbg1');
  });
});

describe('haK8sProvisionClusters standby sizes', () => {
  it('Review Focus 4: each standby role is re-picked for its own location', async () => {
    const { seedCatalog } = await import('../helpers/catalog-fixtures.js');
    const { HetznerProvider } = await import('../../../src/lib/providers/hetzner.js');
    // cx23 is orderable in hel1 only in this catalog, and the cheapest 4 GB
    // server there; the 2 GB db default (cpx12) is stocked in both.
    const restore = seedCatalog(HetznerProvider, 'flux-hetzner-cx23-hel1');
    try {
      const ctx = await runFanOut({
        environment: 'e4',
        region: 'hel1',
        secondaryRegion: 'fsn1',
        masterServerType: 'cx23',
        dbServerType: 'cpx12',
        workerServerType: 'cx23',
      });
      const standby = ctx.standbyResult as Record<string, unknown>;
      expect(standby.masterServerType).toBe('cpx22');
      expect(standby.dbServerType).toBe('cpx12');
      const standbyCall = deployK3s.mock.calls
        .map(([o]) => o as Record<string, unknown>)
        .find((o) => o.role === 'standby');
      expect(standbyCall?.masterServerType).toBe('cpx22');
      expect(standbyCall?.dbServerType).toBe('cpx12');
    } finally {
      restore();
    }
  });

  it('a 4 GB db re-picks as a 4 GB db: never smaller than the primary it stands in for', async () => {
    const { seedCatalog } = await import('../helpers/catalog-fixtures.js');
    const { HetznerProvider } = await import('../../../src/lib/providers/hetzner.js');
    const restore = seedCatalog(HetznerProvider, 'flux-hetzner-cx23-hel1');
    try {
      const ctx = await runFanOut({
        environment: 'e4',
        region: 'hel1',
        secondaryRegion: 'fsn1',
        masterServerType: 'cx23',
        dbServerType: 'cx23',
        workerServerType: 'cx23',
      });
      // The db role's candidates at 4 GB+, cheapest first in fsn1: cpx22.
      expect((ctx.standbyResult as Record<string, unknown>).dbServerType).toBe('cpx22');
    } finally {
      restore();
    }
  });
});

describe('haK8sProvisionClusters keeps the standby sizes on record', () => {
  async function seededFanOut(options: Record<string, unknown>, drop: Record<string, string[]>) {
    const { seedCatalog } = await import('../helpers/catalog-fixtures.js');
    const { HetznerProvider } = await import('../../../src/lib/providers/hetzner.js');
    const restore = seedCatalog(HetznerProvider, '2026-10-22/hetzner', { drop });
    try {
      return await runFanOut({
        environment: 'e4',
        region: 'nbg1',
        secondaryRegion: 'fsn1',
        masterServerType: 'cpx22',
        dbServerType: 'cpx12',
        workerServerType: 'cpx22',
        ...options,
      });
    } finally {
      restore();
    }
  }
  const standbyOf = (ctx: Record<string, unknown>) => ctx.standbyResult as Record<string, unknown>;

  it('a recorded cpx22 master is kept when the catalog no longer stocks it there', async () => {
    const ctx = await seededFanOut(
      {
        haStacks: {
          primary: { masterServerType: 'cpx22', dbServerType: 'cpx12' },
          standby: { masterServerType: 'cpx22', dbServerType: 'cpx12', workerServerType: 'cpx22' },
        },
      },
      // Nothing 4 GB is left in fsn1: a fresh resolve would refuse.
      { fsn1: ['cpx22', 'cx23', 'cpx21'] },
    );
    expect(standbyOf(ctx).masterServerType).toBe('cpx22');
    expect(standbyOf(ctx).dbServerType).toBe('cpx12');
    expect(standbyOf(ctx).workerServerType).toBe('cpx22');
  });

  it('deploy -server-type re-sizes the standby: the record is not used', async () => {
    const ctx = await seededFanOut(
      {
        serverTypeRequested: true,
        masterServerType: 'cpx32',
        dbServerType: 'cpx32',
        workerServerType: 'cpx32',
        haStacks: { standby: { masterServerType: 'cpx22', dbServerType: 'cpx12' } },
      },
      {},
    );
    expect(standbyOf(ctx).masterServerType).toBe('cpx32');
    expect(standbyOf(ctx).dbServerType).toBe('cpx32');
  });

  it('a standby worker with nothing stocked falls back to the default and warns, naming the location and type', async () => {
    const p = await import('@clack/prompts');
    const warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});
    try {
      const ctx = await seededFanOut(
        { haStacks: { standby: { masterServerType: 'cpx22', dbServerType: 'cpx12' } } },
        { fsn1: ['cpx22', 'cx23', 'cpx21'] },
      );
      expect(standbyOf(ctx).workerServerType).toBe('cpx22'); // DEFAULT_K8S_NODE_TYPE
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.filter((l) => l.includes('fsn1') && l.includes('cpx22'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('a stocked primary worker type is the standby worker, with no warning', async () => {
    const p = await import('@clack/prompts');
    const warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});
    try {
      const ctx = await seededFanOut({}, {});
      expect(standbyOf(ctx).workerServerType).toBe('cpx22');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
