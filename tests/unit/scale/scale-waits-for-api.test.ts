/**
 * After a resize, scale touches a cluster's API only once it answers: the
 * autoscaler re-patch (after every cluster is resized) and the k8s-ha
 * replication tunnel's gateway restart (kubectl on each master).
 *
 * 2026-11-13 matrix: a type change reboots the master, and the re-patch read
 * the Secret straight after the up, while the API server was still down. Three
 * of eight k8s scales (digitalocean/k8s twice, a hetzner/k8s-ha standby) lost
 * it to `kubectl ... get secret carbon-autoscaler-config` exit 1, reported only
 * a warning, and left the autoscaler making workers of the old type.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    spinner: () => ({ start() {}, stop() {}, message() {} }),
    log: { info() {}, warn: vi.fn(), error() {}, step() {}, success() {} },
    note() {},
    outro() {},
  };
});

vi.mock('node:fs', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, existsSync: vi.fn(() => true) };
});

// pollUntil sleeps through node:timers/promises, which fake timers don't
// reach: resolve every sleep at once so a down API server costs no wall time.
vi.mock('node:timers/promises', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, setTimeout: vi.fn(async () => undefined) };
});

vi.mock('../../../src/lib/iac/converge-cluster.js', () => ({
  convergeClusterInfra: vi.fn(async () => ({ outputs: {} })),
}));

vi.mock('../../../src/failover.js', () => ({
  identifyServers: vi.fn(() => ({
    primary: { ip: '1.1.1.1', dbIp: '3.3.3.3', dbPrivateIp: '10.0.1.2' },
    standby: { ip: '2.2.2.2', dbIp: '4.4.4.4', dbPrivateIp: '10.0.1.2' },
  })),
}));

vi.mock('../../../src/lib/deploy/k8s/ha/index.js', () => ({
  reestablishReplicationTransport: vi.fn(async () => {}),
}));

const CA_CONFIG = {
  provider: 'hetzner',
  providerIdPrefix: 'hcloud://',
  clusterName: 'proj-prod',
  nodeGroups: { 'worker-pool': { minSize: 0, maxSize: 1, serverType: 'cx22', region: 'nbg1' } },
};

/** What the fake cluster does: whether /healthz answers, and whether reads work. */
const cluster = { healthzFailures: 0, secretReadFails: false };

vi.mock('../../../src/lib/command.js', () => ({
  runCommand: vi.fn((args: unknown) => {
    if (!Array.isArray(args)) return '';
    if (args.includes('--raw=/healthz')) {
      if (cluster.healthzFailures > 0) {
        cluster.healthzFailures -= 1;
        throw new Error('The connection to the server was refused');
      }
      return 'ok';
    }
    if (args.includes('get') && args.includes('secret')) {
      if (cluster.secretReadFails) throw new Error('Command failed with exit code 1: kubectl');
      const jsonpath = args.find((a) => typeof a === 'string' && a.startsWith('jsonpath='));
      if (jsonpath === 'jsonpath={.data.config\\.json}') {
        return Buffer.from(JSON.stringify(CA_CONFIG)).toString('base64');
      }
      return Buffer.from('tok').toString('base64');
    }
    return '';
  }),
}));

const { SCALE_EFFECTS } = await import('../../../src/scale.js');
const { convergeClusterInfra } = await import('../../../src/lib/iac/converge-cluster.js');
const { runCommand } = await import('../../../src/lib/command.js');
const prompts = await import('@clack/prompts');
const { reestablishReplicationTransport } = await import('../../../src/lib/deploy/k8s/ha/index.js');

const ctx = {
  environment: 'prod',
  projectConfig: { projectName: 'proj' },
  apiToken: 'tok',
  Provider: { K8S_ASSETS: { csiNodeDaemonSet: 'daemonset/hcloud-csi-node' } },
  infraChanges: ['workerType'],
  changes: ['workerType'],
  newValues: { workerType: 'cx33' },
  currentWorkerType: 'cx22',
  envConfig: { minWorkers: 1, maxWorkers: 3 },
  region: 'nbg1',
};

/** Global call order of each kind of call, for one cluster's kubeconfig. */
const order = (stack: string) => {
  const calls = vi.mocked(runCommand).mock.calls;
  const orders = vi.mocked(runCommand).mock.invocationCallOrder;
  const forStack = (pred: (a: string[]) => boolean) =>
    calls
      .map((c, i) => ({ args: c[0] as string[], at: orders[i] }))
      .filter(({ args }) => args.some((a) => String(a).endsWith(`kubeconfig-${stack}`)))
      .filter(({ args }) => pred(args))
      .map(({ at }) => at);
  return {
    healthz: forStack((a) => a.includes('--raw=/healthz')),
    secretRead: forStack((a) => a.includes('get') && a.includes('secret')),
  };
};

beforeEach(() => {
  vi.mocked(convergeClusterInfra).mockClear();
  vi.mocked(runCommand).mockClear();
  vi.mocked(prompts.log.warn).mockClear();
  cluster.healthzFailures = 0;
  cluster.secretReadFails = false;
});

describe('scale re-patches the cluster autoscaler only once the API server answers', () => {
  it('single cluster: /healthz answers before the Secret is read', async () => {
    await SCALE_EFFECTS.scaleApplyK8sChanges({ ...ctx, isHA: false });
    const { healthz, secretRead } = order('prod');
    expect(healthz.length).toBeGreaterThan(0);
    expect(secretRead.length).toBeGreaterThan(0);
    expect(Math.max(...healthz)).toBeLessThan(Math.min(...secretRead));
    const convergedAt = vi.mocked(convergeClusterInfra).mock.invocationCallOrder;
    expect(Math.max(...convergedAt)).toBeLessThan(Math.min(...healthz));
  });

  it('k8s-ha: both clusters are resized before either re-patch, each after its own /healthz', async () => {
    await SCALE_EFFECTS.scaleApplyK8sChanges({
      ...ctx,
      isHA: true,
      secondaryRegion: 'hel1',
      envConfig: { ...ctx.envConfig, ha: {} },
    });
    const convergedAt = vi.mocked(convergeClusterInfra).mock.invocationCallOrder;
    expect(convergedAt).toHaveLength(2);
    for (const stack of ['prod-primary', 'prod-standby']) {
      const { healthz, secretRead } = order(stack);
      expect(secretRead.length, stack).toBeGreaterThan(0);
      expect(Math.max(...convergedAt), stack).toBeLessThan(Math.min(...secretRead));
      expect(Math.max(...healthz), stack).toBeLessThan(Math.min(...secretRead));
    }
  });

  it('waits while the API server is down, then re-patches', async () => {
    cluster.healthzFailures = 2; // the master is still rebooting
    await SCALE_EFFECTS.scaleApplyK8sChanges({ ...ctx, isHA: false });
    const { healthz, secretRead } = order('prod');
    expect(healthz).toHaveLength(3);
    expect(secretRead.length).toBeGreaterThan(0);
    expect(Math.max(...healthz)).toBeLessThan(Math.min(...secretRead));
    expect(prompts.log.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Could not update the cluster autoscaler'),
    );
  });

  it('a re-patch that still fails names the deploy that writes the settings again', async () => {
    cluster.secretReadFails = true;
    await SCALE_EFFECTS.scaleApplyK8sChanges({ ...ctx, isHA: false });
    const warned = vi.mocked(prompts.log.warn).mock.calls.map((c) => String(c[0]));
    const line = warned.find((w) => w.startsWith('Could not update the cluster autoscaler'));
    expect(line).toBeDefined();
    expect(line).toContain('makes new workers with the old ones');
    expect(line).toContain('`vibecarbon deploy prod`');
  });
});

describe('the k8s-ha tunnel step restarts the gateways only once both API servers answer', () => {
  const tunnelCtx = {
    ...ctx,
    isHA: true,
    secondaryRegion: 'hel1',
    envConfig: { ...ctx.envConfig, ha: {} },
    infraChanges: ['dbType', 'masterType'],
  };

  it('waits through a rebooting master, then re-establishes the tunnel', async () => {
    vi.mocked(reestablishReplicationTransport).mockClear();
    cluster.healthzFailures = 2;
    await SCALE_EFFECTS.scaleReestablishHaTunnel(tunnelCtx);
    const transportAt = vi.mocked(reestablishReplicationTransport).mock.invocationCallOrder;
    expect(transportAt).toHaveLength(1);
    for (const stack of ['prod-primary', 'prod-standby']) {
      const { healthz } = order(stack);
      expect(healthz.length, stack).toBeGreaterThan(0);
      expect(Math.max(...healthz), stack).toBeLessThan(transportAt[0]);
    }
  });
});
