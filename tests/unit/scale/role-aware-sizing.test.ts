import { beforeEach, describe, expect, it, vi } from 'vitest';

// Task 11: role-aware HA scale sizing. Stacks are cluster IDENTITIES named at
// birth ("<env>-primary" / "<env>-standby"); ROLES flip at failover, persisted
// under envConfig.ha.{primary,standby}.stack (Task 6/7). A scale run after a
// failover must:
//   1. Resolve the two stacks/regions to converge from the persisted role
//      mapping (not the stack-birth `${environment}-primary/-standby` names),
//      falling back to those names only when no mapping is persisted yet.
//   2. Force the ACTING-standby invocation to minWorkers:0/maxWorkers:0 —
//      the pilot-light cluster must never be re-warmed by a routine scale —
//      while the acting-primary keeps envConfig's persisted sizing.
//   3. Persist a `-type` change into envConfig.ha.standbyWorkerSpec.serverType
//      so the NEXT failover provisions the new hardware.
//   4. Gate the standby's app-tier pod-Ready wait off the ROLE the cluster is
//      currently playing, not a suffix sniff over the (possibly swapped)
//      stack name.

vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    spinner: () => ({ start() {}, stop() {}, message() {} }),
    log: { info() {}, warn() {}, error() {}, step() {}, success() {} },
    note() {},
    outro() {},
  };
});

vi.mock('node:fs', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

vi.mock('../../../src/lib/iac/converge-cluster.js', () => ({
  convergeClusterInfra: vi.fn(async () => ({ outputs: {} })),
}));

// Fixture representing the carbon-autoscaler-config Secret's config.json
// BEFORE a scale re-patch — mirrors renderCarbonAutoscalerConfig's shape
// (Task 8) without importing k3s.js (which pulls in Pulumi/provider modules
// this test doesn't need). Every `get secret ... config.json` call returns
// the SAME base fixture, base64-encoded like a real Secret's .data value —
// the re-patch mutates it independently per invocation (primary vs standby).
const BASE_CA_CONFIG = {
  provider: 'hetzner',
  providerIdPrefix: 'hcloud://',
  clusterName: 'proj-prod',
  nodeGroups: {
    'worker-pool': {
      minSize: 0,
      maxSize: 1,
      serverType: 'cx22',
      region: 'nbg1',
      image: 'ubuntu-24.04',
      cloudInit: '#cloud-config\n',
      serverLabels: { 'cluster-autoscaler/node': 'worker-pool' },
      nodeLabels: {},
      taints: [],
      podsPerNode: 110,
    },
  },
  sshKeyName: 'proj-prod-nbg1-key',
  firewallName: 'proj-prod-firewall',
  networkName: 'proj-prod-network',
};

vi.mock('../../../src/lib/command.js', () => ({
  runCommand: vi.fn((args: unknown) => {
    if (!Array.isArray(args)) return '';
    if (args.includes('get') && args.includes('secret')) {
      const jsonpathArg = args.find((a) => typeof a === 'string' && a.startsWith('jsonpath='));
      if (jsonpathArg === 'jsonpath={.data.config\\.json}') {
        return Buffer.from(JSON.stringify(BASE_CA_CONFIG)).toString('base64');
      }
      if (jsonpathArg === 'jsonpath={.data.token}') {
        return Buffer.from('tok-secret').toString('base64');
      }
    }
    return '';
  }),
}));

vi.mock('../../../src/lib/config.js', () => ({
  saveProjectConfig: vi.fn(),
}));

const { SCALE_EFFECTS } = await import('../../../src/scale.js');
const { convergeClusterInfra } = await import('../../../src/lib/iac/converge-cluster.js');
const { runCommand } = await import('../../../src/lib/command.js');
const { saveProjectConfig } = await import('../../../src/lib/config.js');

const Provider = { K8S_ASSETS: { csiNodeDaemonSet: 'daemonset/hcloud-csi-node' } };

const baseApplyCtx = {
  environment: 'prod',
  projectConfig: { projectName: 'proj' },
  apiToken: 'tok',
  Provider,
  infraChanges: ['workerType'],
  changes: ['workerType'],
  newValues: { workerType: 'cx33' },
  currentWorkerType: 'cx22',
};

describe('scaleApplyK8sChanges — role-aware HA stack/region resolution', () => {
  beforeEach(() => {
    vi.mocked(convergeClusterInfra).mockClear();
    vi.mocked(runCommand).mockClear();
  });

  it('targets the ACTING stacks/regions from a swapped ha mapping, forcing the standby to 0/0 workers', async () => {
    const envConfig = {
      minWorkers: 3,
      maxWorkers: 6,
      ha: {
        // A prior failover swapped roles: the physically "-standby"-named
        // stack now serves primary, and vice versa.
        primary: { stack: 'prod-standby', region: 'ash' },
        standby: { stack: 'prod-primary', region: 'nbg1' },
      },
    };
    await SCALE_EFFECTS.scaleApplyK8sChanges({
      ...baseApplyCtx,
      envConfig,
      region: 'nbg1',
      secondaryRegion: 'ash',
      isHA: true,
    });

    expect(convergeClusterInfra).toHaveBeenCalledTimes(2);
    const [primaryCall, standbyCall] = vi
      .mocked(convergeClusterInfra)
      .mock.calls.map((c) => c[0] as Record<string, unknown>);

    expect(primaryCall.clusterEnv).toBe('prod-standby');
    expect(primaryCall.clusterRegion).toBe('ash');
    expect(primaryCall.overrides).toEqual({ workerType: 'cx33' });

    expect(standbyCall.clusterEnv).toBe('prod-primary');
    expect(standbyCall.clusterRegion).toBe('nbg1');
    expect(standbyCall.overrides).toEqual({
      workerType: 'cx33',
      minWorkers: 0,
      maxWorkers: 0,
    });
  });

  it('falls back to stack-birth defaults when no ha mapping is persisted yet', async () => {
    const envConfig = { minWorkers: 2, maxWorkers: 4 };
    await SCALE_EFFECTS.scaleApplyK8sChanges({
      ...baseApplyCtx,
      envConfig,
      region: 'nbg1',
      secondaryRegion: 'ash',
      isHA: true,
    });

    const [primaryCall, standbyCall] = vi
      .mocked(convergeClusterInfra)
      .mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(primaryCall.clusterEnv).toBe('prod-primary');
    expect(primaryCall.clusterRegion).toBe('nbg1');
    expect(standbyCall.clusterEnv).toBe('prod-standby');
    expect(standbyCall.clusterRegion).toBe('ash');
    expect(standbyCall.overrides).toEqual(
      expect.objectContaining({ minWorkers: 0, maxWorkers: 0 }),
    );
  });

  it('the acting-primary keeps envConfig sizing (no min/max override forced)', async () => {
    const envConfig = {
      minWorkers: 3,
      maxWorkers: 6,
      ha: {
        primary: { stack: 'prod-primary', region: 'nbg1' },
        standby: { stack: 'prod-standby', region: 'ash' },
      },
    };
    await SCALE_EFFECTS.scaleApplyK8sChanges({
      ...baseApplyCtx,
      envConfig,
      region: 'nbg1',
      secondaryRegion: 'ash',
      isHA: true,
    });
    const [primaryCall] = vi
      .mocked(convergeClusterInfra)
      .mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect((primaryCall.overrides as Record<string, unknown>).minWorkers).toBeUndefined();
    expect((primaryCall.overrides as Record<string, unknown>).maxWorkers).toBeUndefined();
  });

  it('non-HA scale converges a single cluster keyed on the bare environment name', async () => {
    const envConfig = { minWorkers: 1, maxWorkers: 2 };
    await SCALE_EFFECTS.scaleApplyK8sChanges({
      ...baseApplyCtx,
      envConfig,
      region: 'nbg1',
      secondaryRegion: undefined,
      isHA: false,
    });
    expect(convergeClusterInfra).toHaveBeenCalledTimes(1);
    const [call] = vi
      .mocked(convergeClusterInfra)
      .mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(call.clusterEnv).toBe('prod');
    expect(call.clusterRegion).toBe('nbg1');
  });

  it('re-patches the standby carbon-autoscaler config to the DORMANT bounds (primary floor:max), never 0:0', async () => {
    const envConfig = {
      minWorkers: 3,
      maxWorkers: 6,
      ha: {
        primary: { stack: 'prod-primary', region: 'nbg1' },
        standby: { stack: 'prod-standby', region: 'ash' },
      },
    };
    await SCALE_EFFECTS.scaleApplyK8sChanges({
      ...baseApplyCtx,
      envConfig,
      region: 'nbg1',
      secondaryRegion: 'ash',
      isHA: true,
    });

    // Finds the `kubectl apply -f -` call for this clusterEnv and decodes
    // the worker-pool node group off the re-applied config.json (the YAML
    // is built with JSON.stringify per field, so each stringData key is a
    // single line — see the caSecretYaml block in src/scale.js).
    const findAppliedWorkerPool = (clusterEnv: string) => {
      const call = vi
        .mocked(runCommand)
        .mock.calls.find(
          ([args, options]) =>
            Array.isArray(args) &&
            args.includes('apply') &&
            args.some((a) => typeof a === 'string' && a.includes(`kubeconfig-${clusterEnv}`)) &&
            typeof (options as { input?: string } | undefined)?.input === 'string',
        );
      if (!call) return null;
      const yaml = (call[1] as { input: string }).input;
      const line = yaml.split('\n').find((l) => l.startsWith('  config.json: '));
      if (!line) return null;
      const configJson = JSON.parse(line.slice('  config.json: '.length));
      return JSON.parse(configJson).nodeGroups['worker-pool'];
    };

    // Primary keeps envConfig sizing: min=3 max=6 → CA ceiling = max-min = 3.
    expect(findAppliedWorkerPool('prod-primary')).toMatchObject({ maxSize: 3, serverType: 'cx33' });
    // Standby's Pulumi floor is 0/0, but its CA config keeps the DORMANT
    // bounds a failover relies on: min = the primary's floor (envConfig
    // minWorkers=3), max = the primary's max (envConfig maxWorkers=6) → the
    // same maxSize=3 ceiling deploy rendered, at the new type. Rendering it
    // 0:0 (the old bug) would leave a promoted standby's CA unable to spawn a
    // single worker.
    expect(findAppliedWorkerPool('prod-standby')).toMatchObject({ maxSize: 3, serverType: 'cx33' });
  });

  it('preserves the token key verbatim across a re-patch (never re-derived from ctx.apiToken)', async () => {
    const envConfig = { minWorkers: 1, maxWorkers: 2 };
    await SCALE_EFFECTS.scaleApplyK8sChanges({
      ...baseApplyCtx,
      envConfig,
      region: 'nbg1',
      secondaryRegion: undefined,
      isHA: false,
    });

    const applyCall = vi
      .mocked(runCommand)
      .mock.calls.find(
        ([args, options]) =>
          Array.isArray(args) &&
          args.includes('apply') &&
          typeof (options as { input?: string } | undefined)?.input === 'string',
      );
    if (!applyCall) throw new Error('expected an `apply -f -` call with input');
    const yaml = (applyCall[1] as { input: string }).input;
    const tokenLine = yaml.split('\n').find((l) => l.startsWith('  token: '));
    expect(tokenLine).toBeDefined();
    const token = JSON.parse((tokenLine as string).slice('  token: '.length));
    // 'tok-secret' is the base64-decoded value the mocked `get secret ...
    // jsonpath={.data.token}` call returns — round-tripped, not re-derived
    // from ctx.apiToken ('tok' in baseApplyCtx).
    expect(token).toBe('tok-secret');
  });
});

type SavedProjectConfig = {
  environments: Record<
    string,
    {
      workerServerType?: string;
      ha?: {
        primary?: { stack?: string };
        standby?: { stack?: string };
        standbyWorkerSpec?: { count?: number; serverType?: string };
        scaleUpList?: unknown[];
      };
    }
  >;
};

describe('scaleUpdateK8sConfig — persists a worker-type scale into ha.standbyWorkerSpec', () => {
  beforeEach(() => {
    vi.mocked(saveProjectConfig).mockClear();
  });

  it('updates ha.standbyWorkerSpec.serverType when HA and workerType changed, preserving the rest of ha', async () => {
    const envConfig = {
      workerServerType: 'cx22',
      ha: {
        primary: { stack: 'prod-primary', region: 'nbg1' },
        standby: { stack: 'prod-standby', region: 'ash' },
        standbyWorkerSpec: { count: 1, serverType: 'cx22' },
        scaleUpList: [{ id: 1 }],
      },
    };
    const projectConfig = { projectName: 'proj', environments: { prod: envConfig } };
    await SCALE_EFFECTS.scaleUpdateK8sConfig({
      environment: 'prod',
      envConfig,
      projectConfig,
      newValues: { workerType: 'cx33', masterType: 'cx33', supabaseType: 'cx33' },
      isHA: true,
    });

    expect(saveProjectConfig).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(saveProjectConfig).mock.calls[0][0] as SavedProjectConfig;
    const savedEnv = saved.environments.prod;
    expect(savedEnv.ha.standbyWorkerSpec.serverType).toBe('cx33');
    expect(savedEnv.ha.standbyWorkerSpec.count).toBe(1);
    expect(savedEnv.ha.primary.stack).toBe('prod-primary');
    expect(savedEnv.ha.standby.stack).toBe('prod-standby');
    expect(savedEnv.ha.scaleUpList).toEqual([{ id: 1 }]);
    expect(savedEnv.workerServerType).toBe('cx33');
  });

  it('does not add an ha block for non-HA environments', async () => {
    const envConfig = { workerServerType: 'cx22' };
    const projectConfig = { projectName: 'proj', environments: { prod: envConfig } };
    await SCALE_EFFECTS.scaleUpdateK8sConfig({
      environment: 'prod',
      envConfig,
      projectConfig,
      newValues: { workerType: 'cx33' },
      isHA: false,
    });
    const saved = vi.mocked(saveProjectConfig).mock.calls[0][0] as SavedProjectConfig;
    expect(saved.environments.prod.ha).toBeUndefined();
  });

  it('leaves ha.standbyWorkerSpec.serverType untouched on a bounds-only scale (no workerType change)', async () => {
    const envConfig = { ha: { standbyWorkerSpec: { count: 1, serverType: 'cx22' } } };
    const projectConfig = { projectName: 'proj', environments: { prod: envConfig } };
    await SCALE_EFFECTS.scaleUpdateK8sConfig({
      environment: 'prod',
      envConfig,
      projectConfig,
      newValues: { minWorkers: 2 },
      isHA: true,
    });
    const saved = vi.mocked(saveProjectConfig).mock.calls[0][0] as SavedProjectConfig;
    expect(saved.environments.prod.ha.standbyWorkerSpec.serverType).toBe('cx22');
  });
});

describe('scaleVerifyK8sReady — role-derived standby gate (not a stack-name suffix sniff)', () => {
  beforeEach(() => {
    vi.mocked(runCommand).mockClear();
  });

  it('skips the pod-Ready wait for the ACTING standby even when its stack name ends in "-primary" (swapped mapping)', async () => {
    const envConfig = {
      ha: {
        // Swapped: the physically "-standby"-named stack now serves primary;
        // the physically "-primary"-named stack is the pilot standby.
        primary: { stack: 'prod-standby', region: 'ash' },
        standby: { stack: 'prod-primary', region: 'nbg1' },
      },
    };

    await SCALE_EFFECTS.scaleVerifyK8sReady({
      environment: 'prod',
      envConfig,
      region: 'nbg1',
      secondaryRegion: 'ash',
      isHA: true,
      Provider,
    });

    const waitCalls = vi
      .mocked(runCommand)
      .mock.calls.filter(
        ([args]) => Array.isArray(args) && args.includes('wait') && args.includes('pods'),
      );
    const kubeconfigsWaited = waitCalls.map(([args]) => (args as string[])[2]);

    // The ACTING primary is the stack named 'prod-standby' — it must be waited on.
    expect(kubeconfigsWaited.some((k) => k.includes('kubeconfig-prod-standby'))).toBe(true);
    // The ACTING standby is the stack named 'prod-primary' — it must be
    // SKIPPED despite its stack name ending in '-primary'.
    expect(kubeconfigsWaited.some((k) => k.includes('kubeconfig-prod-primary'))).toBe(false);
  });

  it('waits on the standby too when no ha mapping is persisted (stack-birth defaults, unswapped)', async () => {
    const envConfig = {};
    await SCALE_EFFECTS.scaleVerifyK8sReady({
      environment: 'prod',
      envConfig,
      region: 'nbg1',
      secondaryRegion: 'ash',
      isHA: true,
      Provider,
    });
    const waitCalls = vi
      .mocked(runCommand)
      .mock.calls.filter(
        ([args]) => Array.isArray(args) && args.includes('wait') && args.includes('pods'),
      );
    const kubeconfigsWaited = waitCalls.map(([args]) => (args as string[])[2]);
    expect(kubeconfigsWaited.some((k) => k.includes('kubeconfig-prod-primary'))).toBe(true);
    expect(kubeconfigsWaited.some((k) => k.includes('kubeconfig-prod-standby'))).toBe(false);
  });
});
