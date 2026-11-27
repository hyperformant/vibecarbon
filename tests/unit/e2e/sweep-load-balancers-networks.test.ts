/**
 * The load-balancer and network (VPC, Private Network) passes of the four
 * non-Hetzner sweeps.
 *
 * Until 2026-11-17 these passes listed through the provider's
 * `listLoadBalancers()` / `listNetworks()`, which answer `[]` when the API
 * call fails (their soft-fail contract for destroy). The sweep could not
 * tell "none" from "could not read", so an unreadable listing left the class
 * unchecked under a clean banner. The sweeps now walk these listings
 * themselves, with the same walker and the same `complete` signal as their
 * firewall and ssh-key passes; deletion still goes through the provider.
 *
 * One table drives all four clouds. `lb` and `net` name the listing each
 * sweep reads and the row shape that listing returns.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCALEWAY_TEST_PROJECT } from '../../_shared/scaleway-project.js';
import { sweepOrphanedDigitalOceanResources } from '../../e2e/utils/sweep-digitalocean.js';
import { sweepOrphanedLinodeResources } from '../../e2e/utils/sweep-linode.js';
import { sweepOrphanedScalewayResources } from '../../e2e/utils/sweep-scaleway.js';
import { sweepOrphanedVultrResources } from '../../e2e/utils/sweep-vultr.js';

const TAG = '[test]';
const PROJECT = 'testapp-lbnet';

type Json = Record<string, unknown>;
type Row = Record<string, unknown>;

interface Listing {
  /** URL path of the listing the test serves rows on. */
  path: string;
  body: (rows: Row[]) => Json;
  row: (id: string, name: string) => Row;
  /** The markIncomplete label the sweep prints for this listing. */
  what: string;
}

interface Cloud {
  name: string;
  /** A final, empty page for every listing the test does not serve. */
  empty: Json;
  lb: Listing;
  net: Listing;
  /** Path the sweep DELETEs a network on (first attempt). */
  netDeletePath: (id: string) => string;
  run: (
    fetchImpl: typeof fetch,
    provider: Record<string, unknown>,
  ) => Promise<{
    counts: { loadBalancers?: number; networks: number };
    enumFailed: boolean;
  }>;
}

function baseProvider(overrides: Record<string, unknown> = {}) {
  return {
    listServersDetailed: vi.fn().mockResolvedValue({ items: [], complete: true }),
    deleteServer: vi.fn().mockResolvedValue(undefined),
    listVolumesDetailed: vi.fn().mockResolvedValue({ items: [], complete: true }),
    volumeAttachedServerIds: () => [],
    volumeLabels: () => ({}),
    labelValue: (_key: string, value: string) => value,
    deleteVolume: vi.fn().mockResolvedValue(true),
    deleteFirewallByName: vi.fn().mockResolvedValue({ deleted: true }),
    deleteSSHKeyById: vi.fn().mockResolvedValue('deleted' as const),
    deleteSSHKeyByName: vi.fn().mockResolvedValue(true),
    listFlexibleIPsDetailed: vi.fn().mockResolvedValue({ items: [], complete: true }),
    releaseFlexibleIP: vi.fn().mockResolvedValue(true),
    serverLabels: () => ({}),
    deleteLoadBalancer: vi.fn().mockResolvedValue(true),
    // The soft-failing provider listings the sweeps must no longer rely on:
    // they answer "none" whatever the API said.
    listLoadBalancers: vi.fn().mockResolvedValue([]),
    listNetworks: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

const noBuckets = {
  listBuckets: vi.fn().mockResolvedValue([]),
  listAllBuckets: vi.fn().mockResolvedValue([]),
  emptyAndDeleteBucket: vi.fn().mockResolvedValue({ objectsRemoved: 0 }),
  locateBucket: vi.fn().mockResolvedValue(null),
};

const CLOUDS: Cloud[] = [
  {
    name: 'DigitalOcean',
    empty: {},
    lb: {
      path: '/v2/load_balancers',
      body: (rows) => ({ load_balancers: rows }),
      row: (id, name) => ({ id, name }),
      what: 'load-balancer list',
    },
    net: {
      path: '/v2/vpcs',
      body: (rows) => ({ vpcs: rows }),
      row: (id, name) => ({ id, name }),
      what: 'vpc list',
    },
    netDeletePath: (id) => `/v2/vpcs/${id}`,
    run: (fetchImpl, provider) =>
      sweepOrphanedDigitalOceanResources(TAG, PROJECT, {
        provider: provider as never,
        spaces: { regions: () => [], ...noBuckets },
        fetchImpl,
      }),
  },
  {
    name: 'Linode',
    empty: { data: [], page: 1, pages: 1 },
    lb: {
      path: '/v4/nodebalancers',
      body: (rows) => ({ data: rows, page: 1, pages: 1 }),
      row: (id, name) => ({ id, label: name }),
      what: 'NodeBalancer list',
    },
    net: {
      path: '/v4/vpcs',
      body: (rows) => ({ data: rows, page: 1, pages: 1 }),
      row: (id, name) => ({ id, label: name }),
      what: 'vpc list',
    },
    netDeletePath: (id) => `/v4/vpcs/${id}`,
    run: (fetchImpl, provider) =>
      sweepOrphanedLinodeResources(TAG, PROJECT, {
        provider: provider as never,
        objectStorage: noBuckets,
        fetchImpl,
      }),
  },
  {
    name: 'Vultr',
    empty: { meta: { links: { next: '' } } },
    lb: {
      path: '/v2/load-balancers',
      body: (rows) => ({ load_balancers: rows, meta: { links: { next: '' } } }),
      row: (id, name) => ({ id, label: name }),
      what: 'load-balancer list',
    },
    net: {
      path: '/v2/vpcs',
      body: (rows) => ({ vpcs: rows, meta: { links: { next: '' } } }),
      // A Vultr VPC's identity field is `description`; it has no label.
      row: (id, name) => ({ id, description: name }),
      what: 'vpc list',
    },
    netDeletePath: (id) => `/v2/vpcs/${id}`,
    run: (fetchImpl, provider) =>
      sweepOrphanedVultrResources(TAG, PROJECT, {
        provider: provider as never,
        objectStorage: noBuckets,
        fetchImpl,
      }),
  },
  {
    name: 'Scaleway',
    empty: {},
    // The sweep keeps only the configured project's rows (scaleway-project.ts).
    lb: {
      path: '/lb/v1/zones/nl-ams-1/lbs',
      body: (rows) => ({ lbs: rows }),
      row: (id, name) => ({ id, name, project_id: SCALEWAY_TEST_PROJECT }),
      what: 'load-balancer list (nl-ams-1)',
    },
    net: {
      path: '/vpc/v2/regions/nl-ams/private-networks',
      body: (rows) => ({ private_networks: rows }),
      row: (id, name) => ({ id, name, project_id: SCALEWAY_TEST_PROJECT }),
      what: 'private-network list (nl-ams)',
    },
    netDeletePath: (id) => `/vpc/v2/regions/fr-par/private-networks/${id}`,
    run: (fetchImpl, provider) =>
      sweepOrphanedScalewayResources(TAG, PROJECT, {
        provider: provider as never,
        objectStorageByRegion: { 'fr-par': noBuckets, 'nl-ams': noBuckets },
        fetchImpl,
        projectId: SCALEWAY_TEST_PROJECT,
      }),
  },
];

interface Served {
  /** Listing path → rows, or an HTTP status to fail it with. */
  listings?: Record<string, Row[] | number>;
  /** DELETE path → status; default 204. */
  deletes?: Record<string, number>;
}

function fakeApi(cloud: Cloud, served: Served) {
  const deleted: string[] = [];
  const listed: string[] = [];
  const bodyFor = (path: string, rows: Row[]) =>
    path === cloud.lb.path ? cloud.lb.body(rows) : cloud.net.body(rows);
  const impl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === 'DELETE') {
      deleted.push(path);
      const status = served.deletes?.[path] ?? 204;
      return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
    }
    listed.push(path);
    const hit = served.listings?.[path];
    if (typeof hit === 'number') return { ok: false, status: hit, json: async () => ({}) };
    if (hit) return { ok: true, status: 200, json: async () => bodyFor(path, hit) };
    return { ok: true, status: 200, json: async () => cloud.empty };
  }) as unknown as typeof fetch;
  return { impl, deleted, listed };
}

async function sweep(
  cloud: Cloud,
  served: Served,
  providerOverrides: Record<string, unknown> = {},
) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const api = fakeApi(cloud, served);
  const provider = baseProvider(providerOverrides);
  const result = await cloud.run(api.impl, provider);
  const warned = warn.mock.calls.map((c) => String(c[0])).join('\n');
  return { ...result, warned, provider, deleted: api.deleted, listed: api.listed };
}

afterEach(() => {
  vi.restoreAllMocks();
});

for (const cloud of CLOUDS) {
  describe(`${cloud.name} sweep: load balancers`, () => {
    it('reads the listing itself, not the soft-failing provider method', async () => {
      const { listed, provider } = await sweep(cloud, {});
      expect(listed).toContain(cloud.lb.path);
      expect(provider.listLoadBalancers).not.toHaveBeenCalled();
    });

    it('an unreadable listing marks the sweep incomplete', async () => {
      const { enumFailed, warned } = await sweep(cloud, { listings: { [cloud.lb.path]: 503 } });
      expect(enumFailed).toBe(true);
      expect(warned).toContain(`${cloud.lb.what} enumeration incomplete`);
      expect(warned).toContain('could not enumerate');
    });

    it('deletes the project-prefixed one through the provider and leaves a foreign one', async () => {
      const { counts, enumFailed, provider } = await sweep(cloud, {
        listings: {
          [cloud.lb.path]: [
            cloud.lb.row('lb-1', `${PROJECT}-prod-lb`),
            cloud.lb.row('lb-2', 'someone-elses-lb'),
          ],
        },
      });
      expect(provider.deleteLoadBalancer.mock.calls).toEqual([['lb-1']]);
      expect(counts.loadBalancers).toBe(1);
      expect(enumFailed).toBe(false);
    });

    it('a delete the provider reports as refused is not counted and fails the sweep', async () => {
      const { counts, enumFailed, warned } = await sweep(
        cloud,
        { listings: { [cloud.lb.path]: [cloud.lb.row('lb-1', `${PROJECT}-prod-lb`)] } },
        { deleteLoadBalancer: vi.fn().mockResolvedValue(false) },
      );
      expect(counts.loadBalancers).toBe(0);
      expect(enumFailed).toBe(true);
      expect(warned).toContain('lb-1 delete failed');
    });

    it('a delete that throws is not counted and fails the sweep', async () => {
      const { counts, enumFailed, warned } = await sweep(
        cloud,
        { listings: { [cloud.lb.path]: [cloud.lb.row('lb-1', `${PROJECT}-prod-lb`)] } },
        { deleteLoadBalancer: vi.fn().mockRejectedValue(new Error('connect ETIMEDOUT')) },
      );
      expect(counts.loadBalancers).toBe(0);
      expect(enumFailed).toBe(true);
      expect(warned).toContain('connect ETIMEDOUT');
    });
  });

  describe(`${cloud.name} sweep: networks`, () => {
    it('reads the listing itself, not the soft-failing provider method', async () => {
      const { listed, provider } = await sweep(cloud, {});
      expect(listed).toContain(cloud.net.path);
      expect(provider.listNetworks).not.toHaveBeenCalled();
    });

    it('an unreadable listing marks the sweep incomplete', async () => {
      const { enumFailed, warned } = await sweep(cloud, { listings: { [cloud.net.path]: 503 } });
      expect(enumFailed).toBe(true);
      expect(warned).toContain(`${cloud.net.what} enumeration incomplete`);
    });

    it('deletes the project-prefixed one and leaves a foreign one', async () => {
      const { counts, enumFailed, deleted } = await sweep(cloud, {
        listings: {
          [cloud.net.path]: [
            cloud.net.row('net-1', `${PROJECT}-prod-network`),
            cloud.net.row('net-2', 'someone-elses-network'),
          ],
        },
      });
      expect(deleted).toEqual([cloud.netDeletePath('net-1')]);
      expect(counts.networks).toBe(1);
      expect(enumFailed).toBe(false);
    });

    it('a refused delete is not counted and fails the sweep', async () => {
      const refuse =
        cloud.name === 'Scaleway'
          ? {
              '/vpc/v2/regions/fr-par/private-networks/net-1': 409,
              '/vpc/v2/regions/nl-ams/private-networks/net-1': 409,
            }
          : { [cloud.netDeletePath('net-1')]: 409 };
      const { counts, enumFailed, warned } = await sweep(cloud, {
        listings: { [cloud.net.path]: [cloud.net.row('net-1', `${PROJECT}-prod-network`)] },
        deletes: refuse,
      });
      expect(counts.networks).toBe(0);
      expect(enumFailed).toBe(true);
      expect(warned).toContain('net-1 delete');
    });
  });
}

describe('Scaleway sweep: a Private Network is deleted in the region that holds it', () => {
  const scaleway = CLOUDS[3];

  it('a 404 from the first region is not a failure when the second region deletes it', async () => {
    const { counts, enumFailed, deleted } = await sweep(scaleway, {
      listings: { [scaleway.net.path]: [scaleway.net.row('net-1', `${PROJECT}-prod-network`)] },
      deletes: { '/vpc/v2/regions/fr-par/private-networks/net-1': 404 },
    });
    expect(deleted).toEqual([
      '/vpc/v2/regions/fr-par/private-networks/net-1',
      '/vpc/v2/regions/nl-ams/private-networks/net-1',
    ]);
    expect(counts.networks).toBe(1);
    expect(enumFailed).toBe(false);
  });

  it('a network gone from both regions (404, 404) is reported as a failed delete', async () => {
    // Current behaviour, unlike the VPC passes of the other three sweeps,
    // which count a 404 as swept: pinned as it is, not as it should be.
    const { counts, enumFailed } = await sweep(scaleway, {
      listings: { [scaleway.net.path]: [scaleway.net.row('net-1', `${PROJECT}-prod-network`)] },
      deletes: {
        '/vpc/v2/regions/fr-par/private-networks/net-1': 404,
        '/vpc/v2/regions/nl-ams/private-networks/net-1': 404,
      },
    });
    expect(counts.networks).toBe(0);
    expect(enumFailed).toBe(true);
  });
});
