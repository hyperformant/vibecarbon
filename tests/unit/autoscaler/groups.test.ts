/**
 * Tests for src/autoscaler/groups.js — the node-group state machine.
 *
 * GroupManager tracks three quantities per group (VSHN model): desired
 * target size, in-flight intents (creates issued but not yet visible in the
 * cloud, deletes issued but not yet gone), and cloud reality (refresh()'s
 * label-scoped listServers snapshot). The RPC layer (Task 5) has a hard 5s
 * deadline, so every mutator here records intent and returns — the actual
 * provider.createServer/deleteServer calls run in the background, outside
 * the FIFO mutex, and their outcomes are folded back in via the lock.
 *
 * The mock provider is a plain object with vi.fn() methods — never real
 * network. providerIdPrefix uses a neutral 'testprov://' token (no
 * 'hetzner'/'hcloud' literals in autoscaler code or tests, per the
 * no-hardcoded-provider-dispatch structural pin).
 */
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error — JS module without types
import { GroupManager } from '../../../src/autoscaler/groups.js';

function baseGroup(overrides: Record<string, unknown> = {}) {
  return {
    minSize: 0,
    maxSize: 4,
    serverType: 'cx23',
    region: 'nbg1',
    image: 'ubuntu-24.04',
    cloudInit: '#cloud-config\nruncmd: []\n',
    serverLabels: {
      'cluster-autoscaler/node': 'worker-pool',
      'managed-by': 'vibecarbon',
      environment: 'prod',
      cluster: 'acme-prod',
    },
    nodeLabels: {},
    taints: [],
    podsPerNode: 110,
    ...overrides,
  };
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'testprov',
    providerIdPrefix: 'testprov://',
    clusterName: 'acme-prod',
    nodeGroups: {
      'worker-pool': baseGroup(),
    },
    sshKeyName: 'acme-prod-nbg1-key',
    firewallName: 'acme-prod-firewall',
    networkName: 'acme-prod-network',
    ...overrides,
  };
}

function twoGroupConfig() {
  return baseConfig({
    nodeGroups: {
      'worker-pool': baseGroup({ maxSize: 4 }),
      'gpu-pool': baseGroup({
        maxSize: 2,
        serverLabels: {
          'cluster-autoscaler/node': 'gpu-pool',
          'managed-by': 'vibecarbon',
          environment: 'prod',
          cluster: 'acme-prod',
        },
      }),
    },
  });
}

function createProvider(overrides: Record<string, unknown> = {}) {
  return {
    createServer: vi.fn(),
    deleteServer: vi.fn().mockResolvedValue(undefined),
    listServers: vi.fn().mockResolvedValue([]),
    findFirewallByName: vi.fn().mockResolvedValue(null),
    listNetworks: vi.fn().mockResolvedValue([{ id: 999, name: 'acme-prod-network' }]),
    ...overrides,
  };
}

function makeGroupManager(overrides: Record<string, unknown> = {}) {
  const provider = createProvider();
  return {
    provider,
    gm: new GroupManager({
      config: baseConfig(),
      provider,
      providerIdPrefix: 'testprov://',
      log: vi.fn(),
      ...overrides,
    }),
  };
}

/** Flush pending microtask + one macrotask tick — enough for a background
 * create/delete's promise chain (including its lock re-acquisition) to
 * settle before the test asserts on the resulting state. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function withRunningServer(
  // biome-ignore lint/suspicious/noExplicitAny: gm is an untyped .js GroupManager instance
  gm: any,
  // biome-ignore lint/suspicious/noExplicitAny: provider is the untyped mock from createProvider()
  provider: any,
  { id = 101, name = 'worker-pool-node', groupId = 'worker-pool' } = {},
) {
  provider.listServers.mockResolvedValueOnce([{ id, name, labels: {}, status: 'running' }]);
  await gm.refresh();
  return { id, name, groupId };
}

describe('GroupManager.increaseSize', () => {
  it('bumps targetSize and fires createServer for each new node with correct name/labels/userData/sshKeys', async () => {
    const provider = createProvider({ createServer: vi.fn(() => new Promise(() => {})) });
    const gm = new GroupManager({
      config: baseConfig(),
      provider,
      providerIdPrefix: 'testprov://',
      log: vi.fn(),
    });

    await gm.increaseSize('worker-pool', 2);
    // increaseSize's own returned promise must settle fast (RPC 5s deadline) —
    // it never awaits the firewall lookup or createServer itself, both of
    // which run fully inside the backgrounded dispatch. Flush one tick to
    // let that background dispatch actually fire before inspecting it.
    await flush();

    expect(gm.targetSize('worker-pool')).toBe(2);
    expect(provider.createServer).toHaveBeenCalledTimes(2);

    const group = baseConfig().nodeGroups['worker-pool'] as Record<string, unknown>;
    const names: string[] = [];
    for (const call of provider.createServer.mock.calls) {
      const cfg = call[0];
      expect(cfg.name).toMatch(/^acme-prod-ca-[0-9a-z]{8}$/);
      expect(cfg.serverType).toBe(group.serverType);
      expect(cfg.region).toBe(group.region);
      expect(cfg.image).toBe(group.image);
      expect(cfg.userData).toBe(group.cloudInit);
      expect(cfg.labels).toEqual(group.serverLabels);
      expect(cfg.sshKeys).toEqual(['acme-prod-nbg1-key']);
      expect(cfg.networks).toEqual([999]);
      names.push(cfg.name);
    }
    expect(new Set(names).size).toBe(2);

    const nodes = gm.nodeGroupNodes('worker-pool');
    expect(nodes).toHaveLength(2);
    for (const n of nodes) {
      expect(n.status.instanceState).toBe('instanceCreating');
      expect(n.status.errorInfo).toBeUndefined();
      expect(n.id).toMatch(/^pending:acme-prod-ca-[0-9a-z]{8}$/);
    }
  });

  it('rejects a non-positive delta without calling createServer', async () => {
    const { gm, provider } = makeGroupManager();
    await expect(gm.increaseSize('worker-pool', 0)).rejects.toThrow();
    await expect(gm.increaseSize('worker-pool', -1)).rejects.toThrow();
    expect(provider.createServer).not.toHaveBeenCalled();
  });

  it('throws when the increase would exceed maxSize, and allows exactly up to it', async () => {
    const config = baseConfig({ nodeGroups: { 'worker-pool': baseGroup({ maxSize: 2 }) } });
    const provider = createProvider({ createServer: vi.fn(() => new Promise(() => {})) });
    const gm = new GroupManager({
      config,
      provider,
      providerIdPrefix: 'testprov://',
      log: vi.fn(),
    });

    await expect(gm.increaseSize('worker-pool', 3)).rejects.toThrow();
    expect(gm.targetSize('worker-pool')).toBe(0);
    expect(provider.createServer).not.toHaveBeenCalled();

    await gm.increaseSize('worker-pool', 2);
    expect(gm.targetSize('worker-pool')).toBe(2);

    await expect(gm.increaseSize('worker-pool', 1)).rejects.toThrow();
    expect(gm.targetSize('worker-pool')).toBe(2);
  });
});

describe('GroupManager.refresh', () => {
  it('moves materialized creates from creating to running and clears in-flight state', async () => {
    const provider = createProvider({ createServer: vi.fn(() => new Promise(() => {})) });
    const gm = new GroupManager({
      config: baseConfig(),
      provider,
      providerIdPrefix: 'testprov://',
      log: vi.fn(),
    });

    await gm.increaseSize('worker-pool', 2);
    await flush(); // let the backgrounded dispatch actually call createServer
    // biome-ignore lint/suspicious/noExplicitAny: vi.fn() mock.calls entries are untyped
    const names = provider.createServer.mock.calls.map((c: any[]) => c[0].name);

    provider.listServers.mockResolvedValueOnce([
      { id: 101, name: names[0], labels: {}, status: 'running' },
      { id: 102, name: names[1], labels: {}, status: 'running' },
    ]);
    await gm.refresh();

    const nodes = gm.nodeGroupNodes('worker-pool');
    expect(nodes).toHaveLength(2);
    for (const n of nodes) expect(n.status.instanceState).toBe('instanceRunning');
    // biome-ignore lint/suspicious/noExplicitAny: nodeGroupNodes() returns untyped .js instances
    expect(nodes.map((n: any) => n.id).sort()).toEqual(['testprov://101', 'testprov://102']);
    expect(gm.targetSize('worker-pool')).toBe(2);
  });

  it('scopes listServers by the group + cluster label selector', async () => {
    const { gm, provider } = makeGroupManager();
    await gm.refresh();
    expect(provider.listServers).toHaveBeenCalledWith({
      'cluster-autoscaler/node': 'worker-pool',
      cluster: 'acme-prod',
    });
  });
});

describe('GroupManager.refresh — desired snap semantics (reality + in-flight intents)', () => {
  it('drops desired to reality on a manual out-of-band delete (no tracked intent), and a subsequent increaseSize from the corrected desired works', async () => {
    const { gm, provider } = makeGroupManager();

    provider.listServers.mockResolvedValueOnce([
      { id: 1, name: 'a', labels: {}, status: 'running' },
      { id: 2, name: 'b', labels: {}, status: 'running' },
      { id: 3, name: 'c', labels: {}, status: 'running' },
    ]);
    await gm.refresh();
    expect(gm.targetSize('worker-pool')).toBe(3);

    // Operator deletes server 3 directly against the cloud, out of band —
    // carbon-autoscaler never tracked an intent for it.
    provider.listServers.mockResolvedValueOnce([
      { id: 1, name: 'a', labels: {}, status: 'running' },
      { id: 2, name: 'b', labels: {}, status: 'running' },
    ]);
    await gm.refresh();

    expect(gm.targetSize('worker-pool')).toBe(2);
    const ids = gm
      .nodeGroupNodes('worker-pool')
      // biome-ignore lint/suspicious/noExplicitAny: nodeGroupNodes() returns untyped .js instances
      .map((n: any) => n.id)
      .sort();
    expect(ids).toEqual(['testprov://1', 'testprov://2']);

    // maxSize is 4 (baseGroup default); desired corrected to 2, so +2 must
    // now succeed instead of being rejected against a phantom desired of 3
    // (the pre-fix bug: max(desired, runningCount) never lowers desired).
    provider.createServer.mockImplementation(() => new Promise(() => {}));
    await gm.increaseSize('worker-pool', 2);
    expect(gm.targetSize('worker-pool')).toBe(4);
  });

  it('rises desired to include out-of-band extra matching servers, capped at maxSize', async () => {
    const config = baseConfig({ nodeGroups: { 'worker-pool': baseGroup({ maxSize: 2 }) } });
    const provider = createProvider();
    const gm = new GroupManager({
      config,
      provider,
      providerIdPrefix: 'testprov://',
      log: vi.fn(),
    });

    // Three servers with matching labels show up in one shot (e.g. created
    // manually outside carbon-autoscaler) — desired must rise to cover
    // them, but never past the configured ceiling.
    provider.listServers.mockResolvedValueOnce([
      { id: 1, name: 'a', labels: {}, status: 'running' },
      { id: 2, name: 'b', labels: {}, status: 'running' },
      { id: 3, name: 'c', labels: {}, status: 'running' },
    ]);
    await gm.refresh();

    expect(gm.targetSize('worker-pool')).toBe(2);
  });

  it('drops desired to exactly effectiveRunning + creatingCount on a failed create, without double-decrementing', async () => {
    const provider = createProvider({
      createServer: vi
        .fn()
        .mockResolvedValueOnce({ id: 1 })
        .mockResolvedValueOnce({ id: 2 })
        .mockRejectedValueOnce(new Error('out of capacity')),
    });
    const gm = new GroupManager({
      config: baseConfig(),
      provider,
      providerIdPrefix: 'testprov://',
      log: vi.fn(),
    });

    await gm.increaseSize('worker-pool', 3);
    await flush();
    expect(gm.targetSize('worker-pool')).toBe(3);

    // biome-ignore lint/suspicious/noExplicitAny: vi.fn() mock.calls entries are untyped
    const names = provider.createServer.mock.calls.map((c: any[]) => c[0].name);
    // Two materialize (calls #1/#2 resolved); the third's intent carries
    // errorInfo from the reject (call #3).
    provider.listServers.mockResolvedValueOnce([
      { id: 1, name: names[0], labels: {}, status: 'running' },
      { id: 2, name: names[1], labels: {}, status: 'running' },
    ]);
    await gm.refresh();

    // effectiveRunning(2) + creatingCount(0) = 2 — not 1 (which a
    // double-decrement would produce) and not 3 (which no decrement at all
    // would leave).
    expect(gm.targetSize('worker-pool')).toBe(2);
    expect(gm.nodeGroupNodes('worker-pool')).toHaveLength(2);
  });

  it('rises desired back to include a node whose background delete failed and reverted to running', async () => {
    const provider = createProvider({
      deleteServer: vi.fn().mockRejectedValue(new Error('locked')),
    });
    const gm = new GroupManager({
      config: baseConfig(),
      provider,
      providerIdPrefix: 'testprov://',
      log: vi.fn(),
    });

    provider.listServers.mockResolvedValueOnce([
      { id: 1, name: 'a', labels: {}, status: 'running' },
      { id: 2, name: 'b', labels: {}, status: 'running' },
    ]);
    await gm.refresh();
    expect(gm.targetSize('worker-pool')).toBe(2);

    await gm.deleteNodes('worker-pool', [{ providerID: 'testprov://2' }]);
    expect(gm.targetSize('worker-pool')).toBe(1);
    await flush(); // let the background deleteServer rejection mark deleting.failed

    // Server 2 is still present in the cloud (delete failed) — refresh
    // reverts it to running and desired rises back to include it, so CA
    // will re-request the delete.
    provider.listServers.mockResolvedValueOnce([
      { id: 1, name: 'a', labels: {}, status: 'running' },
      { id: 2, name: 'b', labels: {}, status: 'running' },
    ]);
    await gm.refresh();

    expect(gm.targetSize('worker-pool')).toBe(2);
    expect(
      gm
        .nodeGroupNodes('worker-pool')
        // biome-ignore lint/suspicious/noExplicitAny: nodeGroupNodes() returns untyped .js instances
        .every((n: any) => n.status.instanceState === 'instanceRunning'),
    ).toBe(true);
  });

  it('excludes an in-flight (unresolved) delete from desired without reverting it', async () => {
    const provider = createProvider({
      deleteServer: vi.fn(() => new Promise(() => {})), // never resolves or rejects
    });
    const gm = new GroupManager({
      config: baseConfig(),
      provider,
      providerIdPrefix: 'testprov://',
      log: vi.fn(),
    });

    await withRunningServer(gm, provider, { id: 1, name: 'a' });
    expect(gm.targetSize('worker-pool')).toBe(1);

    await gm.deleteNodes('worker-pool', [{ providerID: 'testprov://1' }]);
    expect(gm.targetSize('worker-pool')).toBe(0);

    // Cloud hasn't caught up yet — the server is still listed, and the
    // delete call itself is still pending (neither succeeded nor failed).
    provider.listServers.mockResolvedValueOnce([
      { id: 1, name: 'a', labels: {}, status: 'running' },
    ]);
    await gm.refresh();

    expect(gm.targetSize('worker-pool')).toBe(0);
    expect(gm.nodeGroupNodes('worker-pool')).toEqual([
      { id: 'testprov://1', status: { instanceState: 'instanceDeleting' } },
    ]);
  });

  it('is a no-op on desired across repeated refreshes in steady state (no drift)', async () => {
    const provider = createProvider({ createServer: vi.fn(() => new Promise(() => {})) });
    const gm = new GroupManager({
      config: baseConfig(),
      provider,
      providerIdPrefix: 'testprov://',
      log: vi.fn(),
    });

    await gm.increaseSize('worker-pool', 2);
    await flush();
    // biome-ignore lint/suspicious/noExplicitAny: vi.fn() mock.calls entries are untyped
    const names = provider.createServer.mock.calls.map((c: any[]) => c[0].name);

    const listed = [
      { id: 101, name: names[0], labels: {}, status: 'running' },
      { id: 102, name: names[1], labels: {}, status: 'running' },
    ];
    provider.listServers.mockResolvedValueOnce(listed);
    await gm.refresh();
    expect(gm.targetSize('worker-pool')).toBe(2);

    // Same reality again — a second refresh with no drift must not move it.
    provider.listServers.mockResolvedValueOnce(listed);
    await gm.refresh();
    expect(gm.targetSize('worker-pool')).toBe(2);
  });
});

describe('GroupManager — failed create', () => {
  it('records errorInfo on the intent (still instanceCreating); refresh with server absent drops it and clamps desired back', async () => {
    const provider = createProvider({
      createServer: vi.fn().mockRejectedValue(new Error('out of capacity')),
    });
    const gm = new GroupManager({
      config: baseConfig(),
      provider,
      providerIdPrefix: 'testprov://',
      log: vi.fn(),
    });

    await gm.increaseSize('worker-pool', 1);
    await flush();

    let nodes = gm.nodeGroupNodes('worker-pool');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].status.instanceState).toBe('instanceCreating');
    expect(nodes[0].status.errorInfo).toEqual({
      errorCode: 'provider-error',
      errorMessage: 'out of capacity',
      instanceErrorClass: 3,
    });
    expect(gm.targetSize('worker-pool')).toBe(1);

    provider.listServers.mockResolvedValueOnce([]);
    await gm.refresh();

    nodes = gm.nodeGroupNodes('worker-pool');
    expect(nodes).toHaveLength(0);
    expect(gm.targetSize('worker-pool')).toBe(0);
  });
});

describe('GroupManager.deleteNodes', () => {
  it('throws for a providerID under a foreign prefix or an unrecognized id, without calling deleteServer', async () => {
    const { gm, provider } = makeGroupManager();
    await withRunningServer(gm, provider);

    await expect(
      gm.deleteNodes('worker-pool', [{ providerID: 'other-prefix://101' }]),
    ).rejects.toThrow();
    await expect(
      gm.deleteNodes('worker-pool', [{ providerID: 'testprov://999' }]),
    ).rejects.toThrow();
    expect(provider.deleteServer).not.toHaveBeenCalled();
  });

  it('deletes a known server with the bare id and marks it instanceDeleting until refresh shows it gone', async () => {
    const { gm, provider } = makeGroupManager();
    await withRunningServer(gm, provider, { id: 101, name: 'worker-pool-node' });
    expect(gm.targetSize('worker-pool')).toBe(1);

    await gm.deleteNodes('worker-pool', [{ providerID: 'testprov://101' }]);

    expect(provider.deleteServer).toHaveBeenCalledWith('101');
    expect(gm.targetSize('worker-pool')).toBe(0);

    let nodes = gm.nodeGroupNodes('worker-pool');
    expect(nodes).toEqual([
      { id: 'testprov://101', status: { instanceState: 'instanceDeleting' } },
    ]);

    provider.listServers.mockResolvedValueOnce([]);
    await gm.refresh();

    nodes = gm.nodeGroupNodes('worker-pool');
    expect(nodes).toHaveLength(0);
  });

  it('reverts a node to running if the background deleteServer call fails and the server is still present at refresh', async () => {
    const provider = createProvider({
      deleteServer: vi.fn().mockRejectedValue(new Error('locked')),
    });
    const gm = new GroupManager({
      config: baseConfig(),
      provider,
      providerIdPrefix: 'testprov://',
      log: vi.fn(),
    });
    await withRunningServer(gm, provider, { id: 101, name: 'worker-pool-node' });

    await gm.deleteNodes('worker-pool', [{ providerID: 'testprov://101' }]);
    await flush();

    // Still present in the cloud (delete failed) — refresh should revert it.
    provider.listServers.mockResolvedValueOnce([
      { id: 101, name: 'worker-pool-node', labels: {}, status: 'running' },
    ]);
    await gm.refresh();

    const nodes = gm.nodeGroupNodes('worker-pool');
    expect(nodes).toEqual([{ id: 'testprov://101', status: { instanceState: 'instanceRunning' } }]);
  });
});

describe('GroupManager.decreaseTargetSize', () => {
  it('throws when it would drop desired below the running count', async () => {
    const { gm, provider } = makeGroupManager();
    provider.listServers.mockResolvedValueOnce([
      { id: 1, name: 'a', labels: {}, status: 'running' },
      { id: 2, name: 'b', labels: {}, status: 'running' },
    ]);
    await gm.refresh();
    expect(gm.targetSize('worker-pool')).toBe(2);

    await expect(gm.decreaseTargetSize('worker-pool', -3)).rejects.toThrow();
    expect(gm.targetSize('worker-pool')).toBe(2);
  });

  it('rejects a non-negative delta', async () => {
    const { gm } = makeGroupManager();
    await expect(gm.decreaseTargetSize('worker-pool', 0)).rejects.toThrow();
    await expect(gm.decreaseTargetSize('worker-pool', 1)).rejects.toThrow();
  });

  it('lowers desired without touching running nodes when the floor allows it', async () => {
    const provider = createProvider({ createServer: vi.fn(() => new Promise(() => {})) });
    const gm = new GroupManager({
      config: baseConfig(),
      provider,
      providerIdPrefix: 'testprov://',
      log: vi.fn(),
    });
    await withRunningServer(gm, provider, { id: 1, name: 'a' });
    await gm.increaseSize('worker-pool', 1);
    expect(gm.targetSize('worker-pool')).toBe(2);

    await gm.decreaseTargetSize('worker-pool', -1);

    expect(gm.targetSize('worker-pool')).toBe(1);
    expect(provider.deleteServer).not.toHaveBeenCalled();
  });
});

describe('GroupManager.groupForProviderId', () => {
  it('returns null for a providerID under a different prefix', () => {
    const { gm } = makeGroupManager();
    expect(gm.groupForProviderId('hcloud://999')).toBeNull();
  });

  it('returns null for an unrecognized id under the right prefix', async () => {
    const { gm, provider } = makeGroupManager();
    await withRunningServer(gm, provider, { id: 101 });
    expect(gm.groupForProviderId('testprov://999')).toBeNull();
  });

  it('returns the owning group id for a known running server', async () => {
    const { gm, provider } = makeGroupManager();
    await withRunningServer(gm, provider, { id: 101 });
    expect(gm.groupForProviderId('testprov://101')).toBe('worker-pool');
  });

  it('returns the owning group id for a resolved (not-yet-refreshed) in-flight create', async () => {
    let resolveCreate: (v: unknown) => void = () => {};
    const provider = createProvider({
      createServer: vi.fn(
        () =>
          new Promise((res) => {
            resolveCreate = res;
          }),
      ),
    });
    const gm = new GroupManager({
      config: baseConfig(),
      provider,
      providerIdPrefix: 'testprov://',
      log: vi.fn(),
    });

    await gm.increaseSize('worker-pool', 1);
    await flush(); // let the backgrounded dispatch actually call createServer
    resolveCreate({ id: 555, server: { id: 555 } });
    await flush(); // let the resolution's lock re-entry set resolvedId

    expect(gm.groupForProviderId('testprov://555')).toBe('worker-pool');
  });
});

describe('GroupManager.groups', () => {
  it('returns id/minSize/maxSize for every configured group', () => {
    const { gm } = makeGroupManager({ config: twoGroupConfig() });
    expect(gm.groups()).toEqual(
      expect.arrayContaining([
        { id: 'worker-pool', minSize: 0, maxSize: 4 },
        { id: 'gpu-pool', minSize: 0, maxSize: 2 },
      ]),
    );
  });
});

describe('GroupManager — multiple node groups stay isolated', () => {
  it('mutating one group never affects another', async () => {
    const provider = createProvider({ createServer: vi.fn(() => new Promise(() => {})) });
    const gm = new GroupManager({
      config: twoGroupConfig(),
      provider,
      providerIdPrefix: 'testprov://',
      log: vi.fn(),
    });

    await gm.increaseSize('worker-pool', 2);
    await flush(); // let the backgrounded dispatch actually call createServer

    expect(gm.targetSize('worker-pool')).toBe(2);
    expect(gm.targetSize('gpu-pool')).toBe(0);
    expect(gm.nodeGroupNodes('gpu-pool')).toEqual([]);
    expect(provider.createServer).toHaveBeenCalledTimes(2);
    for (const call of provider.createServer.mock.calls) {
      expect(call[0].name).toMatch(/^acme-prod-ca-/);
      expect(call[0].labels['cluster-autoscaler/node']).toBe('worker-pool');
    }

    await expect(gm.increaseSize('gpu-pool', 3)).rejects.toThrow();
    expect(gm.targetSize('gpu-pool')).toBe(0);

    await gm.increaseSize('gpu-pool', 2);
    expect(gm.targetSize('gpu-pool')).toBe(2);
    expect(gm.targetSize('worker-pool')).toBe(2);
  });
});

describe('GroupManager — refresh/increaseSize mutex', () => {
  it('does not lose a concurrent increaseSize bump while refresh is awaiting the cloud list', async () => {
    let resolveList: (v: unknown[]) => void = () => {};
    const listPromise = new Promise<unknown[]>((res) => {
      resolveList = res;
    });
    const provider = createProvider({
      listServers: vi.fn(() => listPromise),
      createServer: vi.fn(() => new Promise(() => {})),
    });
    const gm = new GroupManager({
      config: baseConfig(),
      provider,
      providerIdPrefix: 'testprov://',
      log: vi.fn(),
    });

    const refreshPromise = gm.refresh();
    await gm.increaseSize('worker-pool', 2);
    await flush(); // let the backgrounded dispatch actually call createServer

    expect(gm.targetSize('worker-pool')).toBe(2);
    expect(provider.createServer).toHaveBeenCalledTimes(2);

    resolveList([]);
    await refreshPromise;

    expect(gm.targetSize('worker-pool')).toBe(2);
    const nodes = gm.nodeGroupNodes('worker-pool');
    expect(nodes).toHaveLength(2);
    for (const n of nodes) expect(n.status.instanceState).toBe('instanceCreating');
  });
});

describe('GroupManager — firewall resolution', () => {
  it('resolves the firewall once per refresh cycle and reuses it across creates in the same cycle', async () => {
    const provider = createProvider({
      findFirewallByName: vi.fn().mockResolvedValue({ id: 555 }),
      createServer: vi.fn(() => new Promise(() => {})),
    });
    const gm = new GroupManager({
      config: baseConfig(),
      provider,
      providerIdPrefix: 'testprov://',
      log: vi.fn(),
    });

    await gm.increaseSize('worker-pool', 2);
    await flush();

    expect(provider.findFirewallByName).toHaveBeenCalledTimes(1);
    expect(provider.findFirewallByName).toHaveBeenCalledWith('acme-prod-firewall');
    for (const call of provider.createServer.mock.calls) {
      expect(call[0].firewalls).toEqual([555]);
    }

    await gm.refresh();
    await gm.increaseSize('worker-pool', 1);
    await flush();

    expect(provider.findFirewallByName).toHaveBeenCalledTimes(2);
  });

  it('creates without a firewall and logs loudly when the lookup returns null', async () => {
    const log = vi.fn();
    const provider = createProvider({
      findFirewallByName: vi.fn().mockResolvedValue(null),
      createServer: vi.fn(() => new Promise(() => {})),
    });
    const gm = new GroupManager({
      config: baseConfig(),
      provider,
      providerIdPrefix: 'testprov://',
      log,
    });

    await gm.increaseSize('worker-pool', 1);
    await flush();

    expect(provider.createServer.mock.calls[0][0].firewalls).toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  it('creates without a firewall and logs loudly when the lookup rejects', async () => {
    const log = vi.fn();
    const provider = createProvider({
      findFirewallByName: vi.fn().mockRejectedValue(new Error('network down')),
      createServer: vi.fn(() => new Promise(() => {})),
    });
    const gm = new GroupManager({
      config: baseConfig(),
      provider,
      providerIdPrefix: 'testprov://',
      log,
    });

    await gm.increaseSize('worker-pool', 1);
    await flush();

    expect(provider.createServer.mock.calls[0][0].firewalls).toBeUndefined();
    expect(log).toHaveBeenCalled();
  });
});

describe('GroupManager — network resolution', () => {
  it('resolves the network once per refresh cycle and reuses it across creates in the same cycle', async () => {
    const provider = createProvider({
      listNetworks: vi.fn().mockResolvedValue([{ id: 4242, name: 'acme-prod-network' }]),
      createServer: vi.fn(() => new Promise(() => {})),
    });
    const gm = new GroupManager({
      config: baseConfig(),
      provider,
      providerIdPrefix: 'testprov://',
      log: vi.fn(),
    });

    await gm.increaseSize('worker-pool', 2);
    await flush();

    expect(provider.listNetworks).toHaveBeenCalledTimes(1);
    for (const call of provider.createServer.mock.calls) {
      expect(call[0].networks).toEqual([4242]);
    }

    await gm.refresh();
    await gm.increaseSize('worker-pool', 1);
    await flush();

    expect(provider.listNetworks).toHaveBeenCalledTimes(2);
  });

  it('refuses to create and fails the intent with network-not-found when the named network is missing, snapping desired back at next refresh', async () => {
    const log = vi.fn();
    const provider = createProvider({
      listNetworks: vi.fn().mockResolvedValue([{ id: 1, name: 'some-other-network' }]),
    });
    const gm = new GroupManager({
      config: baseConfig(),
      provider,
      providerIdPrefix: 'testprov://',
      log,
    });

    await gm.increaseSize('worker-pool', 1);
    await flush();

    // Unlike a missing firewall (best-effort — create proceeds without
    // one), a missing network must never reach createServer at all.
    expect(provider.createServer).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();

    const nodes = gm.nodeGroupNodes('worker-pool');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].status.instanceState).toBe('instanceCreating');
    expect(nodes[0].status.errorInfo).toMatchObject({
      errorCode: 'network-not-found',
      instanceErrorClass: 3,
    });
    expect(nodes[0].status.errorInfo.errorMessage).toContain('acme-prod-network');
    expect(gm.targetSize('worker-pool')).toBe(1);

    // Next refresh drops the failed intent (no server was ever created) and
    // desired snaps back to reality.
    provider.listServers.mockResolvedValueOnce([]);
    await gm.refresh();

    expect(gm.nodeGroupNodes('worker-pool')).toHaveLength(0);
    expect(gm.targetSize('worker-pool')).toBe(0);
  });

  it('refuses to create and fails the intent with network-not-found when listNetworks rejects', async () => {
    const log = vi.fn();
    const provider = createProvider({
      listNetworks: vi.fn().mockRejectedValue(new Error('network down')),
    });
    const gm = new GroupManager({
      config: baseConfig(),
      provider,
      providerIdPrefix: 'testprov://',
      log,
    });

    await gm.increaseSize('worker-pool', 1);
    await flush();

    expect(provider.createServer).not.toHaveBeenCalled();
    const nodes = gm.nodeGroupNodes('worker-pool');
    expect(nodes[0].status.errorInfo).toMatchObject({ errorCode: 'network-not-found' });
    expect(nodes[0].status.errorInfo.errorMessage).toContain('acme-prod-network');
  });
});

describe('GroupManager — background create/delete never reject (fire-and-forget safety)', () => {
  it('does not unhandled-reject a background create when the group is dropped from config, and marks the tracked intent failed', async () => {
    const { gm, provider } = makeGroupManager();
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      // Seed a real in-flight creating-intent the way increaseSize would,
      // holding createServer open so this first dispatch is harmless and
      // runs against the (still-present) config normally.
      provider.createServer.mockImplementation(() => new Promise(() => {}));
      await gm.increaseSize('worker-pool', 1);
      await flush();
      // biome-ignore lint/suspicious/noExplicitAny: vi.fn() mock.calls entries are untyped
      const name = (provider.createServer.mock.calls[0][0] as any).name;

      // Config reload drops the group entirely — the intent above is still
      // tracked in internal group state, but its static config is gone.
      // biome-ignore lint/suspicious/noExplicitAny: gm is an untyped .js GroupManager instance
      delete (gm as any).config.nodeGroups['worker-pool'];

      // A second background dispatch attempt for the same already-recorded
      // intent (e.g. a retry) races the reload — fire-and-forget, exactly
      // like the real call sites (no await, no .catch from the caller).
      // biome-ignore lint/suspicious/noExplicitAny: _createInBackground is an untyped .js internal
      (gm as any)._createInBackground('worker-pool', name);
      await flush();

      expect(unhandled).toEqual([]);
      // Bailed out before ever reaching the provider a second time.
      expect(provider.createServer).toHaveBeenCalledTimes(1);

      // Group is still known internally (the config drop hasn't been
      // reconciled into _groups yet) — the intent is marked failed sanely
      // rather than silently vanishing or corrupting state.
      const nodes = gm.nodeGroupNodes('worker-pool');
      expect(nodes).toHaveLength(1);
      expect(nodes[0].status.instanceState).toBe('instanceCreating');
      expect(nodes[0].status.errorInfo).toMatchObject({ errorCode: 'group-removed' });
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('does not unhandled-reject a background create for a group missing from internal state entirely', async () => {
    const { gm } = makeGroupManager();
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      // biome-ignore lint/suspicious/noExplicitAny: _createInBackground is an untyped .js internal
      (gm as any)._createInBackground('does-not-exist', 'acme-prod-ca-deadbeef');
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('does not unhandled-reject a background delete for a group missing from internal state', async () => {
    const { gm } = makeGroupManager();
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      // biome-ignore lint/suspicious/noExplicitAny: _deleteInBackground is an untyped .js internal
      (gm as any)._deleteInBackground('does-not-exist', '101');
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});

describe('GroupManager.refresh — per-group failure isolation', () => {
  it('keeps a group whose listServers rejects untouched, applies the other group snap, and returns a refreshed/failed summary', async () => {
    const config = twoGroupConfig();
    const provider = createProvider({
      createServer: vi.fn(() => new Promise(() => {})),
      listServers: vi.fn((selector: Record<string, string>) => {
        if (selector['cluster-autoscaler/node'] === 'gpu-pool') {
          return Promise.reject(new Error('provider timeout'));
        }
        return Promise.resolve([{ id: 1, name: 'a', labels: {}, status: 'running' }]);
      }),
    });
    const gm = new GroupManager({
      config,
      provider,
      providerIdPrefix: 'testprov://',
      log: vi.fn(),
    });

    // Give gpu-pool prior in-flight state so we can verify it's untouched.
    await gm.increaseSize('gpu-pool', 1);
    await flush();

    const result = await gm.refresh();

    expect(result.refreshed).toEqual(['worker-pool']);
    expect(result.failed).toEqual([{ groupId: 'gpu-pool', error: 'provider timeout' }]);

    // worker-pool got its snap applied from the successful listServers.
    expect(gm.targetSize('worker-pool')).toBe(1);

    // gpu-pool's desired/intents are exactly what they were before the
    // failed refresh — no snap, no intent processing this cycle.
    expect(gm.targetSize('gpu-pool')).toBe(1);
    const gpuNodes = gm.nodeGroupNodes('gpu-pool');
    expect(gpuNodes).toHaveLength(1);
    expect(gpuNodes[0].status.instanceState).toBe('instanceCreating');
  });

  it('resolves (never rejects) refresh() when every group fails listServers', async () => {
    const config = twoGroupConfig();
    const provider = createProvider({
      listServers: vi.fn().mockRejectedValue(new Error('provider down')),
    });
    const gm = new GroupManager({
      config,
      provider,
      providerIdPrefix: 'testprov://',
      log: vi.fn(),
    });

    const result = await gm.refresh();

    expect(result.refreshed).toEqual([]);
    expect([...result.failed].sort((a, b) => a.groupId.localeCompare(b.groupId))).toEqual([
      { groupId: 'gpu-pool', error: 'provider down' },
      { groupId: 'worker-pool', error: 'provider down' },
    ]);
  });
});

describe('GroupManager.deleteNodes — duplicate delete isolation', () => {
  it('skips an id already marked deleting on an overlapping call — single deleteServer dispatch, single desired decrement', async () => {
    const { gm, provider } = makeGroupManager();
    provider.listServers.mockResolvedValueOnce([
      { id: 1, name: 'a', labels: {}, status: 'running' },
      { id: 2, name: 'b', labels: {}, status: 'running' },
    ]);
    await gm.refresh();
    expect(gm.targetSize('worker-pool')).toBe(2);

    await gm.deleteNodes('worker-pool', [{ providerID: 'testprov://1' }]);
    expect(gm.targetSize('worker-pool')).toBe(1);

    // Overlapping/duplicate delete request for the same still-in-flight id
    // — must be a no-op: no second decrement, no second deleteServer call.
    await gm.deleteNodes('worker-pool', [{ providerID: 'testprov://1' }]);
    expect(gm.targetSize('worker-pool')).toBe(1);

    await flush();
    expect(provider.deleteServer).toHaveBeenCalledTimes(1);
    expect(provider.deleteServer).toHaveBeenCalledWith('1');

    const nodes = gm.nodeGroupNodes('worker-pool');
    expect(nodes.find((n) => n.id === 'testprov://1')?.status.instanceState).toBe(
      'instanceDeleting',
    );
  });

  it('skips a duplicate id within a single deleteNodes call the same way', async () => {
    const { gm, provider } = makeGroupManager();
    await withRunningServer(gm, provider, { id: 101, name: 'worker-pool-node' });
    expect(gm.targetSize('worker-pool')).toBe(1);

    await gm.deleteNodes('worker-pool', [
      { providerID: 'testprov://101' },
      { providerID: 'testprov://101' },
    ]);

    expect(gm.targetSize('worker-pool')).toBe(0);
    await flush();
    expect(provider.deleteServer).toHaveBeenCalledTimes(1);
  });
});

describe('GroupManager — unknown group id', () => {
  it('throws from targetSize/increaseSize/deleteNodes/decreaseTargetSize/nodeGroupNodes for an unmanaged group', async () => {
    const { gm } = makeGroupManager();
    expect(() => gm.targetSize('does-not-exist')).toThrow();
    expect(() => gm.nodeGroupNodes('does-not-exist')).toThrow();
    await expect(gm.increaseSize('does-not-exist', 1)).rejects.toThrow();
    await expect(gm.decreaseTargetSize('does-not-exist', -1)).rejects.toThrow();
    await expect(
      gm.deleteNodes('does-not-exist', [{ providerID: 'testprov://1' }]),
    ).rejects.toThrow();
  });
});
