/**
 * Ruling C (cold-deploy speed, Task 6): the k8s-ha fan-out starts the
 * replication transport on SIGNALS, never on a timed poll.
 *
 * Each cluster's deployK3s calls `onInfraReady` once its nodes answer and
 * `onNamespaceReady` right after applyVibecarbonSecrets creates the
 * `vibecarbon` namespace. prepareReplicationTransport needs both clusters'
 * infra and both namespaces, so it runs once all four have fired, and never
 * before. The bounded `waitForNamespace` poll (36 x 5 s) it replaces gave up
 * before a cold standby's namespace existed on every cold run since
 * 2026-08-28.
 *
 * Once the transport is up the standby image copy starts as soon as the
 * fan-out ends: it overlaps the primary's replication config and the
 * configure-replication step instead of waiting behind either.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const events: string[] = [];
const PRIMARY_REF = '10.0.1.11:5000/app:abc123';

type Gate = { promise: Promise<void>; open: () => void };
const gate = (): Gate => {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
};

let namespaceGates: Record<string, Gate>;
let deployGates: Record<string, Gate>;

const clusterFor = (role: string) =>
  role === 'primary'
    ? {
        masterIp: '1.1.1.1',
        dbIp: '1.1.1.2',
        dbPrivateIp: '10.0.1.2',
        masterPrivateIp: '10.0.1.11',
      }
    : {
        masterIp: '2.2.2.1',
        dbIp: '2.2.2.2',
        dbPrivateIp: '10.0.1.2',
        masterPrivateIp: '10.0.1.21',
      };

const deployK3s = vi.fn(async (opts: Record<string, unknown>) => {
  const role = String(opts.role);
  const c = clusterFor(role);
  (opts.onInfraReady as (i: unknown) => void)({ ...c, floatingIp: '9.9.9.9' });
  if (role === 'primary') (opts.onImageBuilt as (t: string) => void)(PRIMARY_REF);
  await namespaceGates[role].promise;
  events.push(`${role}:namespace`);
  (opts.onNamespaceReady as () => void)();
  await deployGates[role].promise;
  events.push(`${role}:deployed`);
  return {
    ...c,
    floatingIp: '9.9.9.9',
    kubeconfig: `/tmp/kc-${role}`,
    imageTag: role === 'primary' ? PRIMARY_REF : 'standby',
  };
});

vi.mock('../../../src/lib/deploy/k8s/k3s.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/deploy/k8s/k3s.js')>()),
  deployK3s,
}));

vi.mock('../../../src/lib/iac/index.js', () => ({
  summarizePulumiError: (err: unknown) => String((err as Error)?.message ?? err),
}));

const prepareReplicationTransport = vi.fn(async () => {
  events.push('prep');
});
let primaryConfigGate: Gate;
const configurePrimaryForReplication = vi.fn(async () => {
  events.push('primaryConfig:start');
  await primaryConfigGate.promise;
  events.push('primaryConfig:done');
});
const setupReplication = vi.fn(async () => {
  events.push('setupReplication');
  return { streaming: true, lastState: '', systemIdentifier: '7' };
});
vi.mock('../../../src/lib/deploy/k8s/ha/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/deploy/k8s/ha/index.js')>()),
  prepareReplicationTransport,
  configurePrimaryForReplication,
  setupReplication,
}));

const copyAppImageToStandby = vi.fn(async () => {
  events.push('copy');
  return { digest: 'sha256:aa', skipped: false };
});
vi.mock('../../../src/lib/deploy/k8s/ha/image-copy.js', () => ({ copyAppImageToStandby }));

vi.mock('@clack/prompts', async (orig) => ({
  ...(await orig<typeof import('@clack/prompts')>()),
  log: { info: vi.fn(), warn: vi.fn(), step: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

const haIndex = await import('../../../src/lib/deploy/k8s/ha/index.js');
const { K8S_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/k8s-ha.js');

const spinner = () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() });
const newCtx = () =>
  ({
    s: spinner(),
    sharedSshKeyPath: '/k/deploy_key_e4',
    options: { environment: 'e4', region: 'nbg1', secondaryRegion: 'hel1' },
  }) as Record<string, unknown>;

/** Run every timer-free continuation that can run. */
const drain = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  events.length = 0;
  namespaceGates = { primary: gate(), standby: gate() };
  deployGates = { primary: gate(), standby: gate() };
  primaryConfigGate = gate();
  for (const m of [
    deployK3s,
    prepareReplicationTransport,
    configurePrimaryForReplication,
    setupReplication,
    copyAppImageToStandby,
  ]) {
    m.mockClear();
  }
});

describe('k8s-ha transport preconditions are signalled', () => {
  it('waitForNamespace is gone: nothing polls for the namespace', () => {
    expect('waitForNamespace' in haIndex).toBe(false);
  });

  it('prepares the transport exactly once, after both namespaces are signalled and never before', async () => {
    const ctx = newCtx();
    const run = K8S_HA_EFFECTS.haK8sProvisionClusters(ctx);

    await drain();
    // Infra is up on both clusters, but neither namespace exists yet.
    expect(prepareReplicationTransport).not.toHaveBeenCalled();

    namespaceGates.primary.open();
    await drain();
    expect(prepareReplicationTransport).not.toHaveBeenCalled();

    namespaceGates.standby.open();
    await drain();
    // Both namespaces exist and both cluster deploys are still running: the
    // transport comes up inside the fan-out.
    expect(prepareReplicationTransport).toHaveBeenCalledOnce();
    expect(events).toEqual(['primary:namespace', 'standby:namespace', 'prep']);

    deployGates.primary.open();
    deployGates.standby.open();
    primaryConfigGate.open();
    await run;
    expect(prepareReplicationTransport).toHaveBeenCalledOnce();
    expect(ctx.transportPrepared).toBe(true);
    expect(ctx.primaryReplicationConfigured).toBe(true);
  });

  it('a cluster that fails before its namespace exists ends early prep without a transport', async () => {
    deployK3s.mockImplementationOnce(async (opts: Record<string, unknown>) => {
      (opts.onInfraReady as (i: unknown) => void)({ ...clusterFor('primary') });
      throw new Error('primary k3s install failed');
    });
    namespaceGates.standby.open();
    deployGates.standby.open();
    const ctx = newCtx();
    await expect(K8S_HA_EFFECTS.haK8sProvisionClusters(ctx)).rejects.toThrow(/primary/);
    expect(prepareReplicationTransport).not.toHaveBeenCalled();
  });

  it('with early prep resolved true, the image copy starts before configure-replication returns', async () => {
    for (const g of [...Object.values(namespaceGates), ...Object.values(deployGates)]) g.open();
    const ctx = newCtx();
    // The primary's replication config is still running (its hostPort patch
    // recreates the primary db pod): the copy must not wait behind it.
    const provisioned = K8S_HA_EFFECTS.haK8sProvisionClusters(ctx);
    await drain();
    await drain();
    expect(events).toContain('copy');
    expect(events).not.toContain('primaryConfig:done');

    primaryConfigGate.open();
    await provisioned;
    expect(ctx.transportPrepared).toBe(true);
    expect(ctx.primaryReplicationConfigured).toBe(true);

    await K8S_HA_EFFECTS.haK8sConfigureReplication(ctx);
    expect(events.indexOf('copy')).toBeLessThan(events.indexOf('setupReplication'));
    expect(copyAppImageToStandby).toHaveBeenCalledOnce();
  });
});
