/**
 * Destroying a k8s environment whose deploy stopped before anything was made.
 *
 * Evidence (e2e hetzner/k8s final destroy, 2026-11-13): the deploy stopped
 * while creating the app bucket ("Nothing was provisioned"), so the
 * environment's entry is the deploy's skeleton: a mode and a storage record,
 * no servers, no ingress or floating IP, no kubeconfig, and no state bucket.
 * `vibecarbon destroy` then printed an UNVERIFIED pulumi-stack (the state
 * bucket's NoSuchBucket read as unverified) and a volume-identity line (the
 * PersistentVolume capture asked a cluster that never existed), kept the
 * entry, and every rerun did the same.
 *
 * Such a destroy is clean: no Pulumi stack (its state bucket is in no region
 * of the store) and no cluster to capture CSI volumes from. The same answers
 * stay loud whenever the record says infrastructure existed, or a kubeconfig
 * is there to ask.
 *
 * Runs the real k8s teardown effect over the real iac layer, with a mocked
 * Pulumi workspace whose select fails the way a missing bucket does, a fake
 * object store answering where the bucket lives, and a recording provider
 * that owns nothing.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';

vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const noop = () => {};
  return {
    ...actual,
    log: { warn: noop, error: noop, info: noop, success: noop, message: noop, step: noop },
  };
});

vi.mock('../../../src/lib/state-passphrase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/state-passphrase.js')>()),
  ensureStatePassphrase: async () => 'test-passphrase',
}));

// The exact `pulumi stack select` failure of a backend whose bucket was never
// created (excitingai, 2026-10-16).
const NO_SUCH_BUCKET =
  'code: -2\n stdout: \n stderr: Command failed with exit code 1: pulumi stack select --stack e3 --non-interactive\n' +
  'error: error listing stacks: could not list bucket: blob (code=NotFound): operation error S3: ListObjectsV2, ' +
  'https response error StatusCode: 404, RequestID: N/A, HostID: N/A, NoSuchBucket: The specified bucket does not exist.\n';
const selects: string[] = [];
vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    selectStack: async (args: { stackName: string }) => {
      selects.push(args.stackName);
      throw new Error(NO_SUCH_BUCKET);
    },
    createStack: async () => {
      throw new Error('createStack must not be called: destroy never conjures a stack');
    },
    create: async () => ({ listStacks: async () => [] }),
  },
}));

// Which kubeconfigs the capture was asked to read: it must not be asked about
// a cluster the environment never had.
const captureAsked: string[] = [];
vi.mock('../../../src/lib/csi-volumes.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    captureClusterCsiVolumes: (kubeconfigPath: string, deps?: unknown) => {
      captureAsked.push(kubeconfigPath);
      return (real.captureClusterCsiVolumes as (p: string, d?: unknown) => unknown)(
        kubeconfigPath,
        {
          ...(deps as object),
          // A kubeconfig that exists answers as a live, empty cluster.
          runCommand: () => JSON.stringify({ items: [] }),
        },
      );
    },
  };
});

/** Where the object store says the bucket lives: null = no region has it. */
let bucketRegion: string | null = null;
const SPECIFIC: Record<string, (...args: unknown[]) => unknown> = {
  listServersDetailed: async () => ({ items: [], complete: true }),
  listVolumesDetailed: async () => ({ items: [], complete: true }),
  listNetworks: async () => [],
  listServers: async () => [],
  serverLabels: () => ({}),
  labelValue: (_k: unknown, v: unknown) => v,
  deleteReservedIpsByLabels: async () => ({ deleted: [], failed: [] }),
};
vi.mock('../../../src/lib/providers/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  function FakeProvider() {
    return new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (typeof prop !== 'string' || prop === 'then') return undefined;
          if (prop === 'constructor') return FakeProvider;
          if (prop in SPECIFIC) return SPECIFIC[prop];
          if (prop === 'reservedIpLabelMatch' || prop === 'detachVolume') return undefined;
          if (/^(delete|remove|destroy|release)/.test(prop)) {
            return async () => ({ deleted: false, apiError: null });
          }
          if (/^(list|find|get)/.test(prop)) return async () => [];
          return () => undefined;
        },
      },
    );
  }
  Object.assign(FakeProvider, {
    NAME: 'Hetzner',
    K8S_DESTROY_BACKSTOP: false,
    getPublicIP: () => null,
    promptObjectStorageCredentials: async () => ({
      accessKey: 'ABCDEFGHIJ0123456789',
      secretKey: 'x'.repeat(40),
    }),
  });
  return {
    ...real,
    providerFor: () => FakeProvider,
    getObjectStorageProvider: async () => ({ locateBucket: async () => bucketRegion }),
  };
});

const { createLeakLedger } = await import('../../../src/lib/destroy/leak-ledger.js');
const { DESTROY_EFFECTS, entryKeptReason } = await import('../../../src/destroy.js');
const { localKubeconfigPath } = await import('../../../src/lib/kubeconfig.js');

const spinner = { start: () => {}, stop: () => {}, message: () => {} };

/** The skeleton the deploy saved before s3-setup: no servers, no state bucket. */
function skeleton(tier: 'k8s' | 'k8s-ha') {
  return {
    provider: 'hetzner',
    deployMode: 'kubernetes',
    status: 'deploying',
    region: 'nbg1',
    ...(tier === 'k8s-ha' && { secondaryRegion: 'fsn1', ha: { enabled: true } }),
    s3: {
      bucket: 'proj-8aded2-e3-storage',
      region: 'nbg1',
      endpoint: 'https://nbg1.your-objectstorage.com',
    },
  } as Record<string, unknown>;
}

function makeCtx(tier: 'k8s' | 'k8s-ha', envConfig: Record<string, unknown>, cwd: string) {
  const stackEnvs = tier === 'k8s-ha' ? ['e3-primary', 'e3-standby'] : ['e3'];
  return {
    plan: {
      tier,
      stackEnvs,
      hasPulumiStack: true,
      clusterNames: stackEnvs.map((e) => `proj-${e}`),
      ownedIps: [],
    },
    envConfig,
    projectConfig: { projectName: 'proj' },
    environment: 'e3',
    args: {},
    providerToken: 'tok',
    results: {
      leaks: createLeakLedger(),
      servers: [] as string[],
      firewalls: [] as string[],
      sshKeys: [] as string[],
      dns: [] as string[],
      healthChecks: [] as string[],
      volumes: [] as string[],
      loadBalancers: [] as string[],
      pulumiDestroyFailed: false,
    },
    spinner,
    tracker: { spinner: () => spinner },
    cwd,
  };
}
type Ctx = ReturnType<typeof makeCtx>;

const teardown = (ctx: Ctx) =>
  (DESTROY_EFFECTS as Record<string, (c: unknown, a: unknown) => Promise<void>>).destroyK8sInfra(
    ctx,
    {},
  );
const classes = (ctx: Ctx) =>
  ctx.results.leaks.entries.map((e: { resourceClass: string }) => e.resourceClass);

let dir: string;
let printed: string[];
beforeEach(() => {
  dir = createTempDir('never-provisioned-k8s-');
  selects.length = 0;
  captureAsked.length = 0;
  bucketRegion = null;
  printed = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(' '));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(['k8s', 'k8s-ha'] as const)('%s', (tier) => {
  it('nothing was provisioned: no Pulumi stack, no capture, a clean destroy that lets the entry go', async () => {
    const ctx = makeCtx(tier, skeleton(tier), dir);
    await teardown(ctx);

    expect(selects).toEqual(ctx.plan.stackEnvs);
    expect(classes(ctx)).toEqual([]);
    expect(ctx.results.pulumiDestroyFailed).toBe(false);
    expect(entryKeptReason(ctx.results, ctx.envConfig)).toBeNull();
    expect(captureAsked).toEqual([]);
    expect(printed.some((l) => l.includes('Capturing CSI volume identities'))).toBe(false);
    expect(printed.some((l) => l.includes('CSI volume release attempted'))).toBe(false);
    expect(printed.join('\n')).toContain("its state bucket doesn't exist");
  });

  it('the bucket answers from another region: the stack stays unverified', async () => {
    bucketRegion = 'fsn1';
    const ctx = makeCtx(tier, skeleton(tier), dir);
    await teardown(ctx);

    expect(classes(ctx)).toContain('pulumi-stack');
    expect(ctx.results.pulumiDestroyFailed).toBe(true);
    expect(entryKeptReason(ctx.results, ctx.envConfig)).not.toBeNull();
  });

  it('the record names servers: the capture still runs, and a missing state bucket stays unverified', async () => {
    const envConfig = {
      ...skeleton(tier),
      servers: [{ role: 'master', name: 'master', ip: '203.0.113.7', id: 7 }],
    };
    const ctx = makeCtx(tier, envConfig, dir);
    await teardown(ctx);

    expect(captureAsked).toHaveLength(ctx.plan.stackEnvs.length);
    expect(classes(ctx)).toContain('volume-identity');
    // Servers on record and no state anywhere: what Pulumi held is unknown.
    expect(classes(ctx)).toContain('pulumi-stack');
    expect(ctx.results.pulumiDestroyFailed).toBe(true);
  });

  it('a kubeconfig is there: the capture asks the cluster', async () => {
    for (const stackEnv of tier === 'k8s-ha' ? ['e3-primary', 'e3-standby'] : ['e3']) {
      const path = localKubeconfigPath(dir, stackEnv);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'apiVersion: v1\n');
    }
    const ctx = makeCtx(tier, skeleton(tier), dir);
    await teardown(ctx);

    expect(captureAsked).toHaveLength(ctx.plan.stackEnvs.length);
    expect(printed.some((l) => l.includes('Capturing CSI volume identities'))).toBe(true);
    expect(classes(ctx)).toEqual([]);
  });
});
