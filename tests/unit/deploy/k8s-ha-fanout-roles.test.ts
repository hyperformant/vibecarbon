/**
 * Task 6: fan-out asymmetry + role↔stack mapping.
 *
 * haK8sProvisionClusters fans out deployK3s ×2 (primary + standby in
 * parallel). Pilot-light standby (spec: standby-init-seeding) needs it to
 * produce a specific ASYMMETRY, not a symmetric HA pair:
 *   - primary: role 'primary', full sizing (minWorkers/maxWorkers as
 *     configured).
 *   - standby: role 'standby', minWorkers 0 (no Pulumi-provisioned worker
 *     nodes — just master + supabase), maxWorkers carried through unchanged,
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
  supabaseIp: '2.2.2.2',
  floatingIp: '3.3.3.3',
  supabasePrivateIp: '10.0.1.2',
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
      supabaseServerType: 'cx23',
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
    // .{master,supabase}ServerType from these, not the options-level flags).
    expect((ctx.primaryResult as Record<string, unknown>).stack).toBe('e4-primary');
    expect((ctx.standbyResult as Record<string, unknown>).stack).toBe('e4-standby');
    expect((ctx.primaryResult as Record<string, unknown>).workerServerType).toBe('cpx21');
    expect((ctx.primaryResult as Record<string, unknown>).region).toBe('nbg1');
    expect((ctx.standbyResult as Record<string, unknown>).region).toBe('hel1');
    expect((ctx.primaryResult as Record<string, unknown>).masterServerType).toBe('cx23');
    expect((ctx.primaryResult as Record<string, unknown>).supabaseServerType).toBe('cx23');
    expect((ctx.standbyResult as Record<string, unknown>).masterServerType).toBe('cx23');
    expect((ctx.standbyResult as Record<string, unknown>).supabaseServerType).toBe('cx23');
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
