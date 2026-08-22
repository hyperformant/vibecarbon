import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Task 7 — DO-shaped fixture proof for `cleanupAutoscalerWorkers`
 * (destroy.js): a `cluster-autoscaler/node=worker-pool` droplet in the
 * cluster VPC WOULD be swept, and a `cluster-autoscaler/node=static` droplet
 * in the same VPC is spared. Mirrors ca-worker-cleanup.test.ts's Hetzner
 * fixture router, wired to DO's wire shapes: `vpc_uuid` instead of
 * `private_net`, encoded `tags[]` instead of `labels`, `/v2/vpcs` +
 * `/v2/droplets` instead of `/v1/networks` + `/v1/servers`.
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
import { DigitalOceanProvider, encodeLabels } from '../../../src/lib/providers/digitalocean.js';

const TOKEN = 'test-do-token';
const provider = new DigitalOceanProvider(TOKEN);
const CLUSTER_NAME = 'proj-prod';
const VPC_ID = 'vpc-abc-123';

type DropletFixture = {
  id: number;
  name: string;
  tags?: string[];
  vpc_uuid?: string;
  volume_ids?: string[];
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
 *   GET    /v2/vpcs?...      -> vpcs list
 *   GET    /v2/droplets?...  -> droplets list
 *   DELETE /v2/droplets/<id> -> 204 (droplet queued for delete)
 */
function installFetchRouter({
  vpcs,
  droplets,
}: {
  vpcs: { id: string; name: string }[];
  droplets: DropletFixture[];
}) {
  fetchWithRetryMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';

    if (url.includes('/v2/vpcs') && method === 'GET') {
      return jsonResp({ vpcs, links: {} });
    }
    if (url.includes('/v2/droplets') && method === 'GET') {
      return jsonResp({ droplets, links: {} });
    }
    if (url.includes('/v2/droplets/') && method === 'DELETE') {
      return jsonResp({}, 204);
    }
    throw new Error(`unexpected fetchWithRetry: ${method} ${url}`);
  });

  // DO's deleteServer(waitUntilGone:true) polls the global `fetch` (NOT
  // fetchWithRetry) for a 404 after a successful DELETE. Stub it to return
  // 404 immediately so the poll loop exits on the first iteration.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/v2/droplets/')) {
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }
      throw new Error(`unexpected global fetch: ${url}`);
    }),
  );
}

describe('cleanupAutoscalerWorkers — DigitalOcean fixtures (Task 7)', () => {
  beforeEach(() => {
    fetchWithRetryMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sweeps a cluster-autoscaler/node=worker-pool droplet and spares a static one in the same VPC', async () => {
    installFetchRouter({
      vpcs: [{ id: VPC_ID, name: `${CLUSTER_NAME}-network` }],
      droplets: [
        {
          id: 200,
          name: 'proj-prod-ca-worker-1',
          vpc_uuid: VPC_ID,
          tags: encodeLabels({ 'cluster-autoscaler/node': 'worker-pool', cluster: CLUSTER_NAME }),
          volume_ids: ['vol-1', 'vol-2'],
        },
        {
          id: 300,
          name: 'proj-prod-worker-1',
          vpc_uuid: VPC_ID,
          tags: encodeLabels({
            role: 'worker',
            'cluster-autoscaler/node': 'static',
            cluster: CLUSTER_NAME,
          }),
        },
      ],
    });

    const result = await cleanupAutoscalerWorkers(provider, CLUSTER_NAME);

    // The worker-pool droplet is swept; the static one is spared and never deleted.
    expect(result.deleted).toEqual(['proj-prod-ca-worker-1']);
    expect(result.volumeIds).toEqual(['vol-1', 'vol-2']);
  });

  it('returns empty when the cluster VPC does not exist', async () => {
    installFetchRouter({
      vpcs: [{ id: 'vpc-other', name: 'some-other-network' }],
      droplets: [],
    });

    const result = await cleanupAutoscalerWorkers(provider, CLUSTER_NAME);

    expect(result).toEqual({ deleted: [], failed: [], volumeIds: [] });
    // Short-circuited on missing VPC — never listed droplets.
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
  });

  it('returns empty when no droplets are attached to the cluster VPC', async () => {
    installFetchRouter({
      vpcs: [{ id: VPC_ID, name: `${CLUSTER_NAME}-network` }],
      droplets: [
        // Droplet in a DIFFERENT VPC — must not be touched.
        { id: 100, name: 'unrelated', vpc_uuid: 'vpc-other', tags: [] },
      ],
    });

    const result = await cleanupAutoscalerWorkers(provider, CLUSTER_NAME);

    expect(result).toEqual({ deleted: [], failed: [], volumeIds: [] });
  });

  it('excludes Pulumi-managed droplets tagged role=master/supabase/worker', async () => {
    installFetchRouter({
      vpcs: [{ id: VPC_ID, name: `${CLUSTER_NAME}-network` }],
      droplets: [
        { id: 401, name: 'master-1', vpc_uuid: VPC_ID, tags: encodeLabels({ role: 'master' }) },
        {
          id: 402,
          name: 'supabase-1',
          vpc_uuid: VPC_ID,
          tags: encodeLabels({ role: 'supabase' }),
        },
        { id: 403, name: 'worker-1', vpc_uuid: VPC_ID, tags: encodeLabels({ role: 'worker' }) },
      ],
    });

    const result = await cleanupAutoscalerWorkers(provider, CLUSTER_NAME);

    expect(result).toEqual({ deleted: [], failed: [], volumeIds: [] });
  });

  it('falls back to "in-VPC without role" for an unlabeled CA worker (upgrade case)', async () => {
    installFetchRouter({
      vpcs: [{ id: VPC_ID, name: `${CLUSTER_NAME}-network` }],
      droplets: [
        {
          id: 500,
          name: 'legacy-ca-worker',
          vpc_uuid: VPC_ID,
          tags: [], // no role, no cluster-autoscaler/node tag
          volume_ids: ['vol-9'],
        },
      ],
    });

    const result = await cleanupAutoscalerWorkers(provider, CLUSTER_NAME);

    expect(result.deleted).toEqual(['legacy-ca-worker']);
    expect(result.volumeIds).toEqual(['vol-9']);
  });
});
