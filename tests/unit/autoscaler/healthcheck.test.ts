/**
 * In-process tests for src/autoscaler/healthcheck.js's `probe()` — the
 * liveness/readiness split behind Task 7's sidecar probes (see
 * deployment.yaml: livenessProbe runs --liveness, readinessProbe runs
 * --readiness). Liveness must pass as soon as the gRPC socket answers ANY
 * Health/Check response, even NOT_SERVING (pre-first-Refresh) — otherwise
 * kubelet restarts a perfectly healthy-but-still-warming-up sidecar, per
 * the controller note that reopened this defect. Readiness must only pass
 * once SERVING, mirroring service-roundtrip.test.ts's "NOT_SERVING before
 * the first Refresh, SERVING after" contract (assumed here, not re-proven).
 *
 * Drives a REAL in-process server via startServer() — same pattern as
 * service-roundtrip.test.ts — and calls the exported `probe()` directly
 * (never spawns the CLI), so these tests exercise the real wire call
 * without process-spawn overhead.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import grpc from '@grpc/grpc-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — JS module without types
import { probe } from '../../../src/autoscaler/healthcheck.js';
// @ts-expect-error — JS module without types
import { loadExternalGrpcDefinition } from '../../../src/autoscaler/proto.js';
// @ts-expect-error — JS module without types
import { startServer } from '../../../src/autoscaler/server.js';

// biome-ignore lint/suspicious/noExplicitAny: grpc-js client stubs are untyped in JS
function call(client: any, method: string, request: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    client[method](request, (err: grpc.ServiceError | null, response: unknown) => {
      if (err) reject(err);
      else resolve(response);
    });
  });
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

// biome-ignore lint/suspicious/noExplicitAny: grpc-js client stubs are untyped in JS
async function withServer(testFn: (ctx: { bind: string; client: any }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'carbon-autoscaler-healthcheck-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      provider: 'testprov',
      providerIdPrefix: 'testprov://',
      clusterName: 'acme-prod',
      nodeGroups: {
        'worker-pool': {
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
        },
      },
      sshKeyName: 'acme-prod-nbg1-key',
      firewallName: 'acme-prod-firewall',
      networkName: 'acme-prod-network',
    }),
  );

  const provider = {
    listServers: vi.fn().mockResolvedValue([]),
    findFirewallByName: vi.fn().mockResolvedValue(null),
    listNetworks: vi.fn().mockResolvedValue([{ id: 999, name: 'acme-prod-network' }]),
    getServerType: vi
      .fn()
      .mockResolvedValue({ cores: 2, memoryGb: 4, architecture: 'x86', disk: 40 }),
  };

  const { port, stop } = await startServer({
    configPath,
    token: 'test-token',
    bind: '127.0.0.1:0',
    log: vi.fn(),
    provider,
  });
  cleanups.push(() => stop());

  const bind = `127.0.0.1:${port}`;
  const { CloudProvider } = loadExternalGrpcDefinition();
  const client = new CloudProvider(bind, grpc.credentials.createInsecure());
  cleanups.push(() => client.close());

  await testFn({ bind, client });
}

describe('healthcheck.js probe() — liveness vs readiness', () => {
  it('before any Refresh: --liveness passes (process alive, answered NOT_SERVING); --readiness and the default fail', async () => {
    await withServer(async ({ bind }) => {
      expect(await probe({ bind, mode: 'liveness' })).toBe(0);
      expect(await probe({ bind, mode: 'readiness' })).toBe(1);
      expect(await probe({ bind })).toBe(1); // no mode === readiness
    });
  });

  it('after a Refresh: --liveness, --readiness, and the default all pass', async () => {
    await withServer(async ({ bind, client }) => {
      await call(client, 'Refresh', {});

      expect(await probe({ bind, mode: 'liveness' })).toBe(0);
      expect(await probe({ bind, mode: 'readiness' })).toBe(0);
      expect(await probe({ bind })).toBe(0);
    });
  });

  it('a connection error (nothing listening) fails both --liveness and --readiness', async () => {
    // Port 0 never resolves to a listener when used as a dial target —
    // grpc-js fails the call with UNAVAILABLE well inside the 3s deadline
    // rather than waiting it out, so this stays fast.
    expect(await probe({ bind: '127.0.0.1:0', mode: 'liveness' })).toBe(1);
    expect(await probe({ bind: '127.0.0.1:0', mode: 'readiness' })).toBe(1);
  });
});
