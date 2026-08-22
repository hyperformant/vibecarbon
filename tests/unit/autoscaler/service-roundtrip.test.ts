/**
 * In-process round-trip tests for the carbon-autoscaler externalgrpc
 * service (src/autoscaler/service.js + server.js + healthcheck.js).
 *
 * Unlike groups.test.ts/config.test.ts/node-template.test.ts, which unit
 * test each module directly, this suite starts a REAL grpc-js server via
 * `startServer()` on `127.0.0.1:0` and drives it with a REAL grpc-js client
 * built from the SAME `loadExternalGrpcDefinition()` proto.js uses — proving
 * the whole wire contract (request/response encoding, error-code mapping,
 * the 5s-deadline async contract, the config-reload rule) actually holds
 * through real protobuf serialization, not just in-memory JS calls.
 *
 * The mock provider is a plain object with vi.fn() methods — never real
 * network. providerIdPrefix uses the neutral 'testprov://' token (no
 * 'hetzner'/'hcloud' literals in autoscaler code or tests, per the
 * no-hardcoded-provider-dispatch structural pin — see structure.test.ts).
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — JS module without types
import { loadExternalGrpcDefinition, PROTO_DIR } from '../../../src/autoscaler/proto.js';
// @ts-expect-error — JS module without types
import { startServer } from '../../../src/autoscaler/server.js';

// ── fixtures ────────────────────────────────────────────────────────────

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

function createProvider(overrides: Record<string, unknown> = {}) {
  return {
    createServer: vi.fn().mockResolvedValue({ id: 'srv-default' }),
    deleteServer: vi.fn().mockResolvedValue(undefined),
    listServers: vi.fn().mockResolvedValue([]),
    findFirewallByName: vi.fn().mockResolvedValue(null),
    listNetworks: vi.fn().mockResolvedValue([{ id: 999, name: 'acme-prod-network' }]),
    getServerType: vi
      .fn()
      .mockResolvedValue({ cores: 2, memoryGb: 4, architecture: 'x86', disk: 40 }),
    ...overrides,
  };
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function loadHealthPackage() {
  const def = protoLoader.loadSync(join(PROTO_DIR, 'grpc/health/v1/health.proto'), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_DIR],
  });
  return grpc.loadPackageDefinition(def).grpc.health.v1;
}

// biome-ignore lint/suspicious/noExplicitAny: grpc-js client stubs are untyped in JS
function call(client: any, method: string, request: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    client[method](request, (err: grpc.ServiceError | null, response: unknown) => {
      if (err) reject(err);
      else resolve(response);
    });
  });
}

type ProviderMock = ReturnType<typeof createProvider>;

interface Ctx {
  // biome-ignore lint/suspicious/noExplicitAny: grpc-js client stubs are untyped in JS
  client: any;
  // biome-ignore lint/suspicious/noExplicitAny: grpc-js client stubs are untyped in JS
  healthClient: any;
  provider: ProviderMock;
  configPath: string;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

async function withServer(
  opts: { config?: Record<string, unknown>; provider?: ProviderMock },
  testFn: (ctx: Ctx) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'carbon-autoscaler-roundtrip-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(opts.config ?? baseConfig()));

  const provider = opts.provider ?? createProvider();
  const log = vi.fn();

  const { port, stop } = await startServer({
    configPath,
    token: 'test-token',
    bind: '127.0.0.1:0',
    log,
    provider,
  });
  cleanups.push(() => stop());

  const { CloudProvider } = loadExternalGrpcDefinition();
  const client = new CloudProvider(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
  cleanups.push(() => client.close());

  const { Health } = loadHealthPackage();
  const healthClient = new Health(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
  cleanups.push(() => healthClient.close());

  await testFn({ client, healthClient, provider, configPath });
}

// ── tests ───────────────────────────────────────────────────────────────

describe('carbon-autoscaler externalgrpc service round-trip', () => {
  it('NodeGroups returns the configured groups with id/minSize/maxSize', async () => {
    await withServer({}, async ({ client }) => {
      const response = await call(client, 'NodeGroups', {});
      expect(response.nodeGroups).toEqual([
        { id: 'worker-pool', minSize: 0, maxSize: 4, debug: '' },
      ]);
    });
  });

  it('NodeGroupForNode resolves a managed node to its group, and id:"" (no error) for an unmanaged one', async () => {
    const provider = createProvider({
      listServers: vi.fn().mockResolvedValue([{ id: 123, name: 'w1' }]),
    });
    await withServer({ provider }, async ({ client }) => {
      await call(client, 'Refresh', {});

      const managed = await call(client, 'NodeGroupForNode', {
        node: { providerID: 'testprov://123', name: 'w1', labels: {}, annotations: {} },
      });
      expect(managed.nodeGroup).toEqual({ id: 'worker-pool', minSize: 0, maxSize: 4, debug: '' });

      const unmanaged = await call(client, 'NodeGroupForNode', {
        node: { providerID: 'testprov://999', name: 'other', labels: {}, annotations: {} },
      });
      expect(unmanaged.nodeGroup.id).toBe('');
    });
  });

  it('NodeGroupTargetSize returns NOT_FOUND for an unknown group id', async () => {
    await withServer({}, async ({ client }) => {
      await expect(
        call(client, 'NodeGroupTargetSize', { id: 'does-not-exist' }),
      ).rejects.toMatchObject({ code: grpc.status.NOT_FOUND });
    });
  });

  it('NodeGroupTargetSize returns the current desired size for a known group', async () => {
    await withServer({}, async ({ client }) => {
      const response = await call(client, 'NodeGroupTargetSize', { id: 'worker-pool' });
      expect(response.targetSize).toBe(0);
    });
  });

  it('NodeGroupIncreaseSize returns almost immediately even while the provider create call hangs (5s CA deadline)', async () => {
    const provider = createProvider({ createServer: vi.fn(() => new Promise(() => {})) });
    await withServer({ provider }, async ({ client }) => {
      const start = Date.now();
      const response = await call(client, 'NodeGroupIncreaseSize', { id: 'worker-pool', delta: 2 });
      const elapsed = Date.now() - start;
      expect(response).toEqual({});
      expect(elapsed).toBeLessThan(100);
    });
  });

  it('NodeGroupIncreaseSize past maxSize maps to INVALID_ARGUMENT', async () => {
    await withServer({}, async ({ client }) => {
      await expect(
        call(client, 'NodeGroupIncreaseSize', { id: 'worker-pool', delta: 99 }),
      ).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
    });
  });

  it('NodeGroupDeleteNodes on an unknown group maps to NOT_FOUND', async () => {
    await withServer({}, async ({ client }) => {
      await expect(
        call(client, 'NodeGroupDeleteNodes', { id: 'does-not-exist', nodes: [] }),
      ).rejects.toMatchObject({ code: grpc.status.NOT_FOUND });
    });
  });

  it('NodeGroupNodes reflects instanceCreating immediately, then instanceRunning after a Refresh sees the server', async () => {
    let resolveCreate!: (value: { id: string }) => void;
    const createPromise = new Promise<{ id: string }>((resolve) => {
      resolveCreate = resolve;
    });
    const provider = createProvider({ createServer: vi.fn(() => createPromise) });

    await withServer({ provider }, async ({ client }) => {
      await call(client, 'NodeGroupIncreaseSize', { id: 'worker-pool', delta: 1 });

      const creating = await call(client, 'NodeGroupNodes', { id: 'worker-pool' });
      expect(creating.instances).toHaveLength(1);
      expect(creating.instances[0].status.instanceState).toBe('instanceCreating');
      const createdName = String(creating.instances[0].id).replace(/^pending:/, '');

      resolveCreate({ id: 'srv-1' });
      await flush();

      provider.listServers.mockResolvedValue([{ id: 'srv-1', name: createdName }]);
      await call(client, 'Refresh', {});

      const running = await call(client, 'NodeGroupNodes', { id: 'worker-pool' });
      expect(running.instances).toHaveLength(1);
      expect(running.instances[0].id).toBe('testprov://srv-1');
      expect(running.instances[0].status.instanceState).toBe('instanceRunning');
    });
  });

  it('NodeGroupTemplateNodeInfo response decodes through real grpc serialization — allocatable.pods.string === "110"', async () => {
    await withServer({}, async ({ client }) => {
      const response = await call(client, 'NodeGroupTemplateNodeInfo', { id: 'worker-pool' });
      expect(response.nodeInfo.status.allocatable.pods.string).toBe('110');
    });
  });

  it.each([
    [
      'PricingNodePrice',
      {
        node: { providerID: 'testprov://1', name: 'n', labels: {}, annotations: {} },
        startTime: {},
        endTime: {},
      },
    ],
    ['PricingPodPrice', { pod: {}, startTime: {}, endTime: {} }],
    ['NodeGroupGetOptions', { id: 'worker-pool', defaults: {} }],
  ])('%s returns UNIMPLEMENTED', async (method, request) => {
    await withServer({}, async ({ client }) => {
      await expect(call(client, method, request)).rejects.toMatchObject({
        code: grpc.status.UNIMPLEMENTED,
      });
    });
  });

  it('GPULabel, GetAvailableGPUTypes, and Cleanup return their fixed stub shapes', async () => {
    await withServer({}, async ({ client }) => {
      const gpuLabel = await call(client, 'GPULabel', {});
      expect(gpuLabel.label).toBe('vibecarbon.dev/gpu');

      const gpuTypes = await call(client, 'GetAvailableGPUTypes', {});
      expect(gpuTypes.gpuTypes).toEqual({});

      const cleanup = await call(client, 'Cleanup', {});
      expect(cleanup).toEqual({});
    });
  });

  it('Refresh reloads a changed config file and recreates the group manager (NodeGroups reflects the new maxSize)', async () => {
    await withServer({}, async ({ client, configPath }) => {
      const before = await call(client, 'NodeGroups', {});
      expect(before.nodeGroups[0].maxSize).toBe(4);

      writeFileSync(
        configPath,
        JSON.stringify(baseConfig({ nodeGroups: { 'worker-pool': baseGroup({ maxSize: 9 }) } })),
      );
      const future = new Date(Date.now() + 5000);
      utimesSync(configPath, future, future);

      await call(client, 'Refresh', {});

      const after = await call(client, 'NodeGroups', {});
      expect(after.nodeGroups[0].maxSize).toBe(9);
    });
  });

  it("Refresh still returns success even when one group's listServers rejects", async () => {
    const provider = createProvider({
      listServers: vi.fn((selector: Record<string, string>) =>
        selector['cluster-autoscaler/node'] === 'pool-b'
          ? Promise.reject(new Error('boom'))
          : Promise.resolve([]),
      ),
    });
    const config = baseConfig({
      nodeGroups: {
        'worker-pool': baseGroup(),
        'pool-b': baseGroup({ serverLabels: { 'cluster-autoscaler/node': 'pool-b' } }),
      },
    });

    await withServer({ config, provider }, async ({ client }) => {
      await expect(call(client, 'Refresh', {})).resolves.toEqual({});
    });
  });

  it('health Check reports NOT_SERVING before the first Refresh, SERVING after', async () => {
    await withServer({}, async ({ client, healthClient }) => {
      const before = await call(healthClient, 'Check', { service: '' });
      expect(before.status).toBe('NOT_SERVING');

      await call(client, 'Refresh', {});

      const after = await call(healthClient, 'Check', { service: '' });
      expect(after.status).toBe('SERVING');
    });
  });

  it('health Watch (server-streaming) surfaces UNIMPLEMENTED, not a swallowed handler TypeError', async () => {
    await withServer({}, async ({ healthClient }) => {
      const err = await new Promise<grpc.ServiceError>((resolve) => {
        const stream = healthClient.Watch({ service: '' });
        stream.on('error', (e: grpc.ServiceError) => resolve(e));
        stream.on('data', () => {});
      });
      expect(err.code).toBe(grpc.status.UNIMPLEMENTED);
    });
  });

  it('Refresh succeeds and health flips SERVING even when the provider is fully unreachable (stale-but-sane is still serving)', async () => {
    const provider = createProvider();
    provider.listServers.mockRejectedValue(new Error('provider down'));
    await withServer({ provider }, async ({ client, healthClient }) => {
      await call(client, 'Refresh', {});
      const after = await call(healthClient, 'Check', { service: '' });
      // Liveness must not restart the container on a cloud outage — a
      // restart fixes nothing and drops in-flight intent state.
      expect(after.status).toBe('SERVING');
    });
  });

  it('a synchronously-thrown handler error maps to INTERNAL and does not take down the server', async () => {
    await withServer({}, async ({ client }) => {
      await expect(call(client, 'NodeGroupNodes', { id: 'does-not-exist' })).rejects.toMatchObject({
        code: grpc.status.INTERNAL,
      });

      const stillAlive = await call(client, 'NodeGroups', {});
      expect(stillAlive.nodeGroups).toHaveLength(1);
    });
  });
});
