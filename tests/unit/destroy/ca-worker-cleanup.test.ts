import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 7: cleanupAutoscalerWorkers reaps CA-spawned servers BEFORE
 * `pulumi destroy` so the network/firewall destroy doesn't fail with
 * "still in use".
 *
 * C10a — cleanupAutoscalerWorkers is now a POLICY function that takes a
 * provider INSTANCE (the raw-API teardown primitives it used to call moved onto
 * HetznerProvider). These tests mock `fetchWithRetry` (used by the provider's
 * listNetworks / listServers / deleteServer) AND the global `fetch` (used by
 * deleteServer's post-DELETE 404-poll) so the helper runs end to end without
 * hitting Hetzner.
 */

const fetchWithRetryMock = vi.fn();

vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  };
});

import { cleanupAutoscalerWorkers } from '../../../src/destroy.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

const TOKEN = 'test-token';
const provider = new HetznerProvider(TOKEN);
const CLUSTER_NAME = 'vibecarbon-prod';
const NETWORK_ID = 4242;

type ServerFixture = {
  id: number;
  name: string;
  labels?: Record<string, string>;
  private_net?: { network_id: number }[];
  volumes?: number[];
};

type FetchResp = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

function jsonResp(body: unknown, status = 200): FetchResp {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/**
 * Wire `fetchWithRetry` to dispatch by URL. Each call site:
 *   GET  /v1/networks               -> networks list
 *   GET  /v1/servers?per_page=50    -> servers list
 *   DELETE /v1/servers/<id>         -> 204 (server queued for delete)
 */
function installFetchRouter({
  networks,
  servers,
  deleteResultByServerId,
}: {
  networks: { id: number; name: string }[];
  servers: ServerFixture[];
  deleteResultByServerId?: Record<number, { ok: boolean; throws?: boolean }>;
}) {
  fetchWithRetryMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';

    if (url.includes('/v1/networks')) {
      return jsonResp({ networks });
    }
    if (url.includes('/v1/servers') && method === 'GET') {
      return jsonResp({ servers });
    }
    if (url.includes('/v1/servers/') && method === 'DELETE') {
      const idMatch = url.match(/\/v1\/servers\/(\d+)/);
      const id = idMatch ? Number(idMatch[1]) : -1;
      const cfg = deleteResultByServerId?.[id];
      if (cfg?.throws) throw new Error('hetzner DELETE failed');
      // 204 is "ok and not 404" — triggers the post-delete 404 poll, which
      // we short-circuit below by stubbing the global `fetch`.
      return {
        ok: cfg?.ok !== false,
        status: cfg?.ok === false ? 500 : 204,
        json: async () => ({}),
      };
    }
    throw new Error(`unexpected fetchWithRetry: ${method} ${url}`);
  });

  // hetznerDeleteServer polls the global `fetch` (NOT fetchWithRetry) for
  // 404 after a successful DELETE. Stub it to return 404 immediately so
  // the poll loop exits on the first iteration.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/v1/servers/')) {
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }
      throw new Error(`unexpected global fetch: ${url}`);
    }),
  );
}

describe('cleanupAutoscalerWorkers', () => {
  beforeEach(() => {
    fetchWithRetryMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns empty when the cluster network does not exist', async () => {
    installFetchRouter({
      networks: [{ id: 1, name: 'some-other-network' }],
      servers: [],
    });

    const result = await cleanupAutoscalerWorkers(provider, CLUSTER_NAME);

    expect(result).toEqual({ deleted: [], failed: [], volumeIds: [] });
    // Should never have listed servers — short-circuited on missing network.
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
  });

  it('returns empty when no servers are attached to the cluster network', async () => {
    installFetchRouter({
      networks: [{ id: NETWORK_ID, name: `${CLUSTER_NAME}-network` }],
      servers: [
        // Server in a DIFFERENT network — must not be touched.
        {
          id: 100,
          name: 'unrelated',
          private_net: [{ network_id: 9999 }],
          labels: {},
        },
      ],
    });

    const result = await cleanupAutoscalerWorkers(provider, CLUSTER_NAME);

    expect(result).toEqual({ deleted: [], failed: [], volumeIds: [] });
  });

  it('matches a server with the explicit cluster-autoscaler/node=worker-pool label', async () => {
    installFetchRouter({
      networks: [{ id: NETWORK_ID, name: `${CLUSTER_NAME}-network` }],
      servers: [
        {
          id: 200,
          name: 'ca-worker-1',
          private_net: [{ network_id: NETWORK_ID }],
          labels: { 'cluster-autoscaler/node': 'worker-pool' },
          volumes: [501, 502],
        },
      ],
    });

    const result = await cleanupAutoscalerWorkers(provider, CLUSTER_NAME);

    expect(result.deleted).toEqual(['ca-worker-1']);
    expect(result.volumeIds).toEqual([501, 502]);
  });

  it('excludes static workers (cluster-autoscaler/node=static) even if they look unlabeled', async () => {
    installFetchRouter({
      networks: [{ id: NETWORK_ID, name: `${CLUSTER_NAME}-network` }],
      servers: [
        {
          id: 300,
          name: 'static-worker-1',
          private_net: [{ network_id: NETWORK_ID }],
          // Phase 3 attaches `cluster-autoscaler/node: static` to Pulumi-
          // managed workers. The role label may or may not be present.
          labels: { 'cluster-autoscaler/node': 'static' },
        },
      ],
    });

    const result = await cleanupAutoscalerWorkers(provider, CLUSTER_NAME);

    expect(result).toEqual({ deleted: [], failed: [], volumeIds: [] });
  });

  it('excludes Pulumi-managed servers tagged with role=master/supabase/worker', async () => {
    installFetchRouter({
      networks: [{ id: NETWORK_ID, name: `${CLUSTER_NAME}-network` }],
      servers: [
        {
          id: 401,
          name: 'master-1',
          private_net: [{ network_id: NETWORK_ID }],
          labels: { role: 'master' },
        },
        {
          id: 402,
          name: 'supabase-1',
          private_net: [{ network_id: NETWORK_ID }],
          labels: { role: 'supabase' },
        },
        {
          id: 403,
          name: 'worker-1',
          private_net: [{ network_id: NETWORK_ID }],
          labels: { role: 'worker' },
        },
      ],
    });

    const result = await cleanupAutoscalerWorkers(provider, CLUSTER_NAME);

    expect(result).toEqual({ deleted: [], failed: [], volumeIds: [] });
  });

  it('falls back to "in-network without role" for unlabeled CA workers (upgrade case)', async () => {
    // Pre-Phase-4 deploys spawned CA workers without the explicit
    // `cluster-autoscaler/node` label. They sit in the cluster network
    // and lack the Pulumi `role` label — the fallback heuristic catches
    // them.
    installFetchRouter({
      networks: [{ id: NETWORK_ID, name: `${CLUSTER_NAME}-network` }],
      servers: [
        {
          id: 500,
          name: 'legacy-ca-worker',
          private_net: [{ network_id: NETWORK_ID }],
          labels: {}, // no role, no cluster-autoscaler/node label
          volumes: [777],
        },
      ],
    });

    const result = await cleanupAutoscalerWorkers(provider, CLUSTER_NAME);

    expect(result.deleted).toEqual(['legacy-ca-worker']);
    expect(result.volumeIds).toEqual([777]);
  });

  it('continues deletion when one server delete fails (best-effort)', async () => {
    installFetchRouter({
      networks: [{ id: NETWORK_ID, name: `${CLUSTER_NAME}-network` }],
      servers: [
        {
          id: 601,
          name: 'ca-worker-good',
          private_net: [{ network_id: NETWORK_ID }],
          labels: { 'cluster-autoscaler/node': 'worker-pool' },
        },
        {
          id: 602,
          name: 'ca-worker-broken',
          private_net: [{ network_id: NETWORK_ID }],
          labels: { 'cluster-autoscaler/node': 'worker-pool' },
        },
        {
          id: 603,
          name: 'ca-worker-also-good',
          private_net: [{ network_id: NETWORK_ID }],
          labels: { 'cluster-autoscaler/node': 'worker-pool' },
        },
      ],
      deleteResultByServerId: {
        602: { ok: false, throws: true },
      },
    });

    const result = await cleanupAutoscalerWorkers(provider, CLUSTER_NAME);

    // The two healthy deletions still succeed — one refusal must not strand
    // the rest of the sweep.
    expect(result.deleted).toEqual(['ca-worker-good', 'ca-worker-also-good']);
    // ...and the broken one is REPORTED, not silently skipped. A surviving CA
    // worker is outside Pulumi state (no destroy retry reaches it), bills, and
    // makes the cluster network delete fail with "still in use" — so destroy
    // needs it in the leak report and the exit code.
    expect(result.failed).toEqual([
      { name: 'ca-worker-broken', id: 602, reason: expect.stringContaining('delete failed') },
    ]);
  });

  it('aggregates volume IDs across all deleted CA-spawned servers', async () => {
    installFetchRouter({
      networks: [{ id: NETWORK_ID, name: `${CLUSTER_NAME}-network` }],
      servers: [
        {
          id: 701,
          name: 'ca-worker-a',
          private_net: [{ network_id: NETWORK_ID }],
          labels: { 'cluster-autoscaler/node': 'worker-pool' },
          volumes: [11, 12],
        },
        {
          id: 702,
          name: 'ca-worker-b',
          private_net: [{ network_id: NETWORK_ID }],
          labels: { 'cluster-autoscaler/node': 'worker-pool' },
          volumes: [13],
        },
        {
          id: 703,
          name: 'ca-worker-c-no-volumes',
          private_net: [{ network_id: NETWORK_ID }],
          labels: { 'cluster-autoscaler/node': 'worker-pool' },
          // no volumes field
        },
      ],
    });

    const result = await cleanupAutoscalerWorkers(provider, CLUSTER_NAME);

    expect(result.deleted).toEqual(['ca-worker-a', 'ca-worker-b', 'ca-worker-c-no-volumes']);
    expect(result.volumeIds).toEqual([11, 12, 13]);
  });
});
