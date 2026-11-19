/**
 * The k8s teardown finishes a stack whose `pulumi destroy` failed, when the
 * sweeps after it removed something of that stack.
 *
 * Evidence (DigitalOcean k8s-ha, e2e run of 2026-11-15): the standby's
 * `pulumi destroy` failed on its VPC (`409 Can not delete VPC with members`:
 * a droplet from an interrupted create that no stack recorded). The
 * orphaned-server sweep deleted the droplet, the backstop deleted the VPC,
 * the provider was clean, and destroy still reported the VPC UNVERIFIED,
 * exited 2 and left the stack in the state bucket.
 *
 * The real k8s teardown effect runs here against a fake provider and a
 * scripted `pulumi destroy` (destroyK8s), so what is pinned is the wiring:
 *   - which stacks get a second pass (only a failed one a sweep removed
 *     something of, by the orphaned-server sweep or the backstop);
 *   - that it is one pass, never more;
 *   - that a finished stack leaves no line, no kept entry and exit 0, and one
 *     that is not finished is reported as before.
 * The engine side (the refresh, the unfinished create, the stack's files) is
 * tests/integration/iac/destroy-finishes-stack-after-sweeps.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { teardownProvider } from '../../_shared/teardown-provider.js';

vi.mock('@clack/prompts', async (orig) =>
  (await import('../../_shared/clack-fake.js')).quietClack(await orig(), {
    log: ['warn', 'error', 'info', 'success', 'message', 'step'],
  }),
);

type Server = { id: number; name: string; labels: Record<string, string> };

/** What the fake provider holds and does; each test sets it. */
const cloud = {
  backstop: true,
  servers: [] as Server[],
  /** Network names the backstop's delete by name finds and deletes. */
  networks: [] as string[],
  deletedServers: [] as string[],
};

function FakeProvider() {
  return teardownProvider({
    ctor: FakeProvider,
    methods: {
      listServersDetailed: async () => ({ items: cloud.servers, complete: true }),
      listVolumesDetailed: async () => ({ items: [], complete: true }),
      serverLabels: (sv: Server) => sv.labels,
      serverRegion: () => 'nyc3',
      labelValue: (_key: string, value: string) => value,
      deleteServer: async (id: number) => {
        const server = cloud.servers.find((sv) => sv.id === id);
        cloud.servers = cloud.servers.filter((sv) => sv.id !== id);
        if (server) cloud.deletedServers.push(server.name);
      },
      deleteFirewallByName: async () => ({ deleted: false, apiError: null }),
      deleteSSHKeyByName: async () => false,
      deleteNetworkByName: async (name: string) => {
        const found = cloud.networks.includes(name);
        cloud.networks = cloud.networks.filter((n) => n !== name);
        return { deleted: found, apiError: null };
      },
      deleteReservedIpsByLabels: async () => ({ deleted: [], failed: [] }),
      detachVolume: undefined,
      reservedIpLabelMatch: undefined,
    },
    serverIdsEmpty: true,
    // No detach: detachVolume is absent above, and any other detach answers nothing.
    deleteVerbs: /^(delete|remove|destroy|release)/,
    deleted: () => ({ deleted: false, apiError: null }),
  });
}
Object.assign(FakeProvider, { NAME: 'FakeCloud', getPublicIP: () => null });
Object.defineProperty(FakeProvider, 'K8S_DESTROY_BACKSTOP', { get: () => cloud.backstop });

vi.mock('../../../src/lib/providers/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, providerFor: () => FakeProvider };
});

/** Each stack's `pulumi destroy` outcomes, in order; the calls made. */
let script: Record<string, Array<Error | { destroyed: boolean; resourceCount?: number }>> = {};
const destroyCalls: string[] = [];
vi.mock('../../../src/lib/deploy/k8s/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    destroyK8s: async ({ environment }: { environment: string }) => {
      destroyCalls.push(environment);
      const next = script[environment]?.shift();
      if (!next) throw new Error(`destroyK8s was called once too often for ${environment}`);
      if (next instanceof Error) throw next;
      return next;
    },
  };
});

const { createLeakLedger } = await import('../../../src/lib/destroy/leak-ledger.js');
const { DESTROY_EFFECTS, entryKeptReason } = await import('../../../src/destroy.js');

const REFUSAL = '409 Can not delete VPC with members';

/** destroyStack's error for a destroy that left the stack's VPC behind. */
function vpcRefused(stackEnv: string) {
  const error = new Error(
    `pulumi destroy for stack "${stackEnv}" failed, 1 resource(s) remain in its state: ${REFUSAL}`,
  ) as Error & { remainingResources: unknown[] };
  error.remainingResources = [
    {
      type: 'digitalocean:index/vpc:Vpc',
      logicalName: 'network',
      name: `proj-${stackEnv}-network`,
      id: 'vpc-1',
      error: REFUSAL,
    },
  ];
  return error;
}

/** A droplet an interrupted create left running, labelled for `stackEnv`. */
const strayMaster = (stackEnv: string): Server => ({
  id: 7,
  name: `proj-${stackEnv}-master`,
  labels: { 'managed-by': 'vibecarbon', project: 'proj', environment: stackEnv },
});

const spinner = { start: () => {}, stop: () => {}, message: () => {} };

function makeCtx(tier: 'k8s' | 'k8s-ha') {
  const stackEnvs = tier === 'k8s-ha' ? ['cid4-primary', 'cid4-standby'] : ['cid4'];
  return {
    plan: {
      tier,
      stackEnvs,
      hasPulumiStack: true,
      clusterNames: stackEnvs.map((e) => `proj-${e}`),
      ownedIps: [],
    },
    // No domain (DNS is out of this test) and no servers on record: the
    // deploy stopped before it saved any.
    envConfig: { provider: 'digitalocean', tier, servers: [], region: 'nyc3' },
    projectConfig: { projectName: 'proj' },
    environment: 'cid4',
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
    cwd: '/tmp/vibecarbon-second-pass-nowhere',
  };
}
type Ctx = ReturnType<typeof makeCtx>;

const teardown = (ctx: Ctx) =>
  (DESTROY_EFFECTS as Record<string, (c: unknown, a: unknown) => Promise<void>>).destroyK8sInfra(
    ctx,
    {},
  );
const lines = (ctx: Ctx) =>
  ctx.results.leaks.entries.map(
    (e: { severity: string; resourceClass: string; reason: string }) =>
      `${e.severity} ${e.resourceClass}: ${e.reason}`,
  );

let printed: string[];
beforeEach(() => {
  cloud.backstop = true;
  cloud.servers = [];
  cloud.networks = [];
  cloud.deletedServers = [];
  script = {};
  destroyCalls.length = 0;
  printed = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(' '));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('k8s-ha: the standby destroy fails on its VPC', () => {
  it('the sweeps delete the stray droplet and the VPC: the standby is destroyed once more, and the destroy is clean', async () => {
    cloud.servers = [strayMaster('cid4-standby')];
    cloud.networks = ['proj-cid4-standby-network'];
    script = {
      'cid4-primary': [{ destroyed: true, resourceCount: 4 }],
      'cid4-standby': [vpcRefused('cid4-standby'), { destroyed: true, resourceCount: 1 }],
    };
    const ctx = makeCtx('k8s-ha');
    await teardown(ctx);

    expect(cloud.deletedServers).toEqual(['proj-cid4-standby-master']);
    expect(destroyCalls.filter((e) => e === 'cid4-primary')).toHaveLength(1);
    expect(destroyCalls.filter((e) => e === 'cid4-standby')).toHaveLength(2);
    expect(lines(ctx)).toEqual([]);
    expect(ctx.results.leaks.exitCode()).toBe(0);
    expect(ctx.results.pulumiDestroyFailed).toBe(false);
    expect(entryKeptReason(ctx.results, ctx.envConfig)).toBeNull();
    expect(printed.join('\n')).toContain('Finishing Pulumi stack cid4-standby');
    expect(printed.join('\n')).toContain('Pulumi stack cid4-standby finished');
  });

  it('the second pass fails too: it ran once, and the VPC is reported with exit 2 and a kept entry', async () => {
    cloud.servers = [strayMaster('cid4-standby')];
    script = {
      'cid4-primary': [{ destroyed: true, resourceCount: 4 }],
      'cid4-standby': [vpcRefused('cid4-standby'), vpcRefused('cid4-standby')],
    };
    const ctx = makeCtx('k8s-ha');
    await teardown(ctx);

    // Exactly two: a third call would throw out of the scripted destroy.
    expect(destroyCalls.filter((e) => e === 'cid4-standby')).toHaveLength(2);
    expect(lines(ctx)).toEqual([
      `unverified network: still in Pulumi stack cid4-standby, its delete failed: ${REFUSAL}`,
    ]);
    expect(ctx.results.leaks.exitCode()).toBe(2);
    expect(ctx.results.pulumiDestroyFailed).toBe(true);
    expect(entryKeptReason(ctx.results, ctx.envConfig)).toMatchObject({ unverified: true });
  });

  it('the second pass fails without reading what is left: the first pass names it', async () => {
    cloud.servers = [strayMaster('cid4-standby')];
    script = {
      'cid4-primary': [{ destroyed: true, resourceCount: 4 }],
      'cid4-standby': [vpcRefused('cid4-standby'), new Error('the stack is locked by another run')],
    };
    const ctx = makeCtx('k8s-ha');
    await teardown(ctx);

    expect(lines(ctx)).toEqual([
      `unverified network: still in Pulumi stack cid4-standby, its delete failed: ${REFUSAL}`,
    ]);
    expect(ctx.results.leaks.exitCode()).toBe(2);
  });

  it('the sweeps removed nothing of the standby: no second pass, and the VPC is reported', async () => {
    script = {
      'cid4-primary': [{ destroyed: true, resourceCount: 4 }],
      'cid4-standby': [vpcRefused('cid4-standby')],
    };
    const ctx = makeCtx('k8s-ha');
    await teardown(ctx);

    expect(destroyCalls.filter((e) => e === 'cid4-standby')).toHaveLength(1);
    expect(lines(ctx)).toEqual([
      `unverified network: still in Pulumi stack cid4-standby, its delete failed: ${REFUSAL}`,
    ]);
    expect(ctx.results.leaks.exitCode()).toBe(2);
    expect(ctx.results.pulumiDestroyFailed).toBe(true);
    expect(printed.join('\n')).not.toContain('Finishing Pulumi stack');
  });

  it('another run holds the standby: no destroy ran, so no second pass even after a sweep', async () => {
    cloud.servers = [strayMaster('cid4-standby')];
    script = {
      'cid4-primary': [{ destroyed: true, resourceCount: 4 }],
      // No remainingResources: the destroy never ran against the stack.
      'cid4-standby': [new Error('Stack "cid4-standby" is in use by another run')],
    };
    const ctx = makeCtx('k8s-ha');
    await teardown(ctx);

    expect(cloud.deletedServers).toEqual(['proj-cid4-standby-master']);
    expect(destroyCalls.filter((e) => e === 'cid4-standby')).toHaveLength(1);
    expect(lines(ctx)).toHaveLength(1);
    expect(lines(ctx)[0]).toContain(
      'unverified pulumi-stack: pulumi destroy failed: Stack "cid4-standby" is in use by another run',
    );
    expect(ctx.results.leaks.exitCode()).toBe(2);
    expect(ctx.results.pulumiDestroyFailed).toBe(true);
  });

  it("what the sweeps removed was the primary's: the standby gets no second pass", async () => {
    cloud.servers = [strayMaster('cid4-primary')];
    cloud.networks = ['proj-cid4-primary-network'];
    script = {
      'cid4-primary': [{ destroyed: true, resourceCount: 4 }],
      'cid4-standby': [vpcRefused('cid4-standby')],
    };
    const ctx = makeCtx('k8s-ha');
    await teardown(ctx);

    expect(cloud.deletedServers).toEqual(['proj-cid4-primary-master']);
    expect(destroyCalls.filter((e) => e === 'cid4-primary')).toHaveLength(1);
    expect(destroyCalls.filter((e) => e === 'cid4-standby')).toHaveLength(1);
    expect(ctx.results.leaks.exitCode()).toBe(2);
  });

  it('both sides fail and both are swept: each gets its one pass', async () => {
    cloud.servers = [strayMaster('cid4-primary'), { ...strayMaster('cid4-standby'), id: 8 }];
    script = {
      'cid4-primary': [vpcRefused('cid4-primary'), { destroyed: true, resourceCount: 1 }],
      'cid4-standby': [vpcRefused('cid4-standby'), { destroyed: true, resourceCount: 1 }],
    };
    const ctx = makeCtx('k8s-ha');
    await teardown(ctx);

    expect(destroyCalls).toHaveLength(4);
    expect(lines(ctx)).toEqual([]);
    expect(ctx.results.leaks.exitCode()).toBe(0);
  });
});

describe('k8s: one stack', () => {
  it.each([
    ['with the name backstop (DigitalOcean, Linode)', true],
    ['without it (Hetzner, Vultr, Scaleway): the orphaned-server sweep alone counts', false],
  ])('%s', async (_, backstop) => {
    cloud.backstop = backstop;
    cloud.servers = [strayMaster('cid4')];
    cloud.networks = ['proj-cid4-network'];
    script = { cid4: [vpcRefused('cid4'), { destroyed: true, resourceCount: 2 }] };
    const ctx = makeCtx('k8s');
    await teardown(ctx);

    expect(destroyCalls).toEqual(['cid4', 'cid4']);
    expect(lines(ctx)).toEqual([]);
    expect(ctx.results.leaks.exitCode()).toBe(0);
    expect(entryKeptReason(ctx.results, ctx.envConfig)).toBeNull();
  });

  it('the stack is gone by the second pass: nothing read its resources, so the first failure is reported', async () => {
    cloud.servers = [strayMaster('cid4')];
    script = { cid4: [vpcRefused('cid4'), { destroyed: false }] };
    const ctx = makeCtx('k8s');
    await teardown(ctx);

    expect(destroyCalls).toEqual(['cid4', 'cid4']);
    expect(lines(ctx)).toEqual([
      `unverified network: still in Pulumi stack cid4, its delete failed: ${REFUSAL}`,
    ]);
    expect(ctx.results.leaks.exitCode()).toBe(2);
  });
});
