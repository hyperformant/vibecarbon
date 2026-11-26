/**
 * What each pass of the four non-Hetzner sweeps does, line for line.
 *
 * Every pass has the same outline: list, keep this run's resources, delete
 * each, count it or fail the sweep, and mark the sweep incomplete when the
 * listing cannot be read. The passes differ in the details that cost money
 * when wrong: which delete failures stop at the one resource and which end
 * the whole pass, what a 404 means, which lines are printed. The other sweep
 * tests assert verdicts; this one records everything a sweep prints and
 * every call it makes, in order, so a change to the outline cannot move any
 * of it unseen.
 *
 * Four runs per cloud:
 *   - `mixed`: every class holds resources that delete, that refuse, that
 *     throw where a throw stops at the resource, and that are not this run's;
 *   - `incomplete listings`: every listing answers short or with HTTP 503;
 *   - `throwing listings`: every listing throws;
 *   - `a delete that throws`: in the classes where a throw is not caught per
 *     resource, the first delete throws and a second owned resource follows.
 *
 * The snapshot was taken from the passes as they were written out in each
 * file, before they shared one outline.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sweepOrphanedDigitalOceanResources } from '../../e2e/utils/sweep-digitalocean.js';
import { sweepOrphanedLinodeResources } from '../../e2e/utils/sweep-linode.js';
import { sweepOrphanedScalewayResources } from '../../e2e/utils/sweep-scaleway.js';
import { sweepOrphanedVultrResources } from '../../e2e/utils/sweep-vultr.js';

const TAG = '[t]';
const P = 'testapp-tr';
const boom = () => new Error('connect ETIMEDOUT');

type Json = Record<string, unknown>;
type Row = Record<string, unknown>;
/** A listing body, an HTTP status to fail with, or a thrown error. */
type Get = Json | number | 'throw';
type ProviderFns = Record<string, (...args: never[]) => unknown>;

interface Scenario {
  /** Provider method overrides (listings and deletes). */
  provider?: ProviderFns;
  /** GET pathname to what it answers; anything else answers `empty`. */
  gets?: Record<string, Get>;
  /** Every GET the scenario does not name answers this instead of `empty`. */
  everyGet?: number | 'throw';
  /** DELETE pathname to a status (default 204) or a throw. */
  deletes?: Record<string, number | 'throw'>;
}

interface Cloud {
  name: string;
  empty: Json;
  run: (fetchImpl: typeof fetch, provider: never) => Promise<unknown>;
  mixed: Scenario;
  deleteThrows: Scenario;
}

/** Provider listings every scenario starts from: nothing there, all read. */
function baseProvider(): ProviderFns {
  return {
    listServersDetailed: async () => ({ items: [], complete: true }),
    deleteServer: async () => undefined,
    listVolumesDetailed: async () => ({ items: [], complete: true }),
    deleteVolume: async () => true,
    deleteFirewallByName: async () => ({ deleted: true }),
    deleteSSHKeyById: async () => 'deleted',
    deleteSSHKeyByName: async () => true,
    listFlexibleIPsDetailed: async () => ({ items: [], complete: true }),
    releaseFlexibleIP: async () => true,
    deleteLoadBalancer: async () => true,
  };
}

/** Run one scenario and return its transcript. */
async function transcript(cloud: Cloud, scenario: Scenario): Promise<string> {
  const events: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line) => void events.push(`log   ${line}`));
  vi.spyOn(console, 'warn').mockImplementation((line) => void events.push(`warn  ${line}`));

  const fns = { ...baseProvider(), ...scenario.provider };
  const provider: Record<string, unknown> = {
    // Pure readers: not recorded, they are not calls on the cloud.
    volumeAttachedServerIds: (v: { attached?: unknown[] }) => v.attached ?? [],
    volumeLabels: (v: { labels?: Record<string, string> }) => v.labels ?? {},
    labelValue: (_key: string, value: string) => value,
  };
  for (const [name, fn] of Object.entries(fns)) {
    provider[name] = async (...args: unknown[]) => {
      events.push(`call  ${name}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
      return (fn as (...a: unknown[]) => unknown)(...args);
    };
  }

  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const { pathname, search } = new URL(String(url));
    if (init?.method === 'DELETE') {
      events.push(`fetch DELETE ${pathname}`);
      const status = scenario.deletes?.[pathname] ?? 204;
      if (status === 'throw') throw boom();
      return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
    }
    events.push(`fetch GET ${pathname}${search}`);
    const hit = scenario.gets?.[pathname] ?? scenario.everyGet ?? cloud.empty;
    if (hit === 'throw') throw boom();
    if (typeof hit === 'number') return { ok: false, status: hit, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => hit };
  }) as unknown as typeof fetch;

  const result = await cloud.run(fetchImpl, provider as never);
  events.push(`result ${JSON.stringify(result)}`);
  return events.join('\n');
}

const noBuckets = {
  listBuckets: async () => [],
  listAllBuckets: async () => [],
  emptyAndDeleteBucket: async () => ({ objectsRemoved: 0 }),
  locateBucket: async () => null,
};

/** Deletes that throw for one id and succeed for the rest. */
const throwsFor =
  (bad: unknown, ok: unknown = true) =>
  async (id: unknown) => {
    if (id === bad) throw boom();
    return ok;
  };

/** Servers and volumes, the same five-and-six rows on every cloud. */
function serversAndVolumes(nameKey: 'name' | 'label'): ProviderFns {
  const named = (id: string, name: string, extra: Row = {}) => ({ id, [nameKey]: name, ...extra });
  return {
    listServersDetailed: async () => ({
      items: [named('s-1', `${P}-prod`), named('s-2', `${P}-db`), named('s-3', 'someone-elses')],
      complete: true,
    }),
    deleteServer: throwsFor('s-2', undefined),
    listVolumesDetailed: async () => ({
      items: [
        named('v-1', `${P}-data`),
        named('v-2', `${P}-wal`),
        named('v-3', `${P}-attached`, { attached: ['s-9'] }),
        named('v-4', 'pvc-0001', { labels: { project: P } }),
        named('v-5', 'pvc-0002'),
        named('v-6', 'pvc0003', { labels: { project: P } }),
        named('v-7', 'someone-elses-volume'),
      ],
      complete: true,
    }),
    deleteVolume: throwsFor('v-2'),
  };
}

/** Load balancers: one deletes, one is refused, one throws, one is foreign. */
const loadBalancerDeletes: ProviderFns = {
  deleteLoadBalancer: async (id: unknown) => {
    if (id === 'lb-3') throw boom();
    return id !== 'lb-2';
  },
};
const fourLbs = (nameKey: string): Row[] => [
  { id: 'lb-1', [nameKey]: `${P}-lb` },
  { id: 'lb-2', [nameKey]: `${P}-lb-refused` },
  { id: 'lb-3', [nameKey]: `${P}-lb-throws` },
  { id: 'lb-4', [nameKey]: 'someone-elses-lb' },
];
/** Networks: 204, 404, 500, a throw, and a foreign one. */
const fiveNets = (nameKey: string): Row[] => [
  { id: 'n-1', [nameKey]: `${P}-net` },
  { id: 'n-2', [nameKey]: `${P}-net-gone` },
  { id: 'n-3', [nameKey]: `${P}-net-refused` },
  { id: 'n-4', [nameKey]: `${P}-net-throws` },
  { id: 'n-5', [nameKey]: 'someone-elses-net' },
];
const netDeletes = (base: string): Record<string, number | 'throw'> => ({
  [`${base}/n-2`]: 404,
  [`${base}/n-3`]: 500,
  [`${base}/n-4`]: 'throw',
});

const vultrEnd = { meta: { links: { next: '' } } };
const linodePage = (data: Row[]) => ({ data, page: 1, pages: 1 });

const CLOUDS: Cloud[] = [
  {
    name: 'DigitalOcean',
    empty: {},
    run: (fetchImpl, provider) =>
      sweepOrphanedDigitalOceanResources(TAG, P, {
        provider,
        spaces: { regions: () => [], ...noBuckets },
        fetchImpl,
      }),
    mixed: {
      provider: {
        ...serversAndVolumes('name'),
        ...loadBalancerDeletes,
        deleteFirewallByName: async (name: unknown) => ({ deleted: name !== `${P}-fw-refused` }),
        deleteSSHKeyById: async (id: unknown) =>
          id === 2 ? 'absent' : id === 3 ? 'stuck' : 'deleted',
      },
      gets: {
        '/v2/firewalls': {
          firewalls: [
            { id: 'f-1', name: `${P}-fw` },
            { id: 'f-2', name: `${P}-fw-refused` },
            { id: 'f-3', name: 'someone-elses-fw' },
          ],
        },
        '/v2/account/keys': {
          ssh_keys: [
            { id: 1, name: `${P}-key` },
            { id: 2, name: `${P}-key-stale` },
            { id: 3, name: `${P}-key-stuck` },
            { id: 4, name: 'someone-elses-key' },
          ],
        },
        '/v2/load_balancers': { load_balancers: fourLbs('name') },
        '/v2/vpcs': { vpcs: fiveNets('name') },
        '/v2/spaces/keys': {
          keys: [
            { access_key: 'AK1', name: `vc-app-${P}-prod` },
            { access_key: 'AK2', name: `vc-app-${P}-gone` },
            { access_key: 'AK3', name: `vc-app-${P}-refused` },
            { access_key: 'AK4', name: `vc-app-${P}-throws` },
            { access_key: 'AK5', name: 'vc-app-otherapp-prod' },
            { access_key: 'AK6' },
          ],
        },
        '/v2/reserved_ips': {
          reserved_ips: [
            { ip: '203.0.113.7', droplet: null },
            { ip: '203.0.113.8', droplet: {} },
          ],
        },
      },
      deletes: {
        ...netDeletes('/v2/vpcs'),
        '/v2/spaces/keys/AK2': 404,
        '/v2/spaces/keys/AK3': 500,
        '/v2/spaces/keys/AK4': 'throw',
      },
    },
    deleteThrows: {
      provider: {
        deleteFirewallByName: async () => {
          throw boom();
        },
        deleteSSHKeyById: async () => {
          throw boom();
        },
      },
      gets: {
        '/v2/firewalls': {
          firewalls: [
            { id: 'f-1', name: `${P}-fw` },
            { id: 'f-2', name: `${P}-fw-2` },
          ],
        },
        '/v2/account/keys': {
          ssh_keys: [
            { id: 1, name: `${P}-key` },
            { id: 2, name: `${P}-key-2` },
          ],
        },
      },
    },
  },
  {
    name: 'Linode',
    empty: linodePage([]),
    run: (fetchImpl, provider) =>
      sweepOrphanedLinodeResources(TAG, P, { provider, objectStorage: noBuckets, fetchImpl }),
    mixed: {
      provider: {
        ...serversAndVolumes('label'),
        ...loadBalancerDeletes,
        deleteFirewallByName: async (name: unknown) => ({ deleted: name !== `${P}-fw-refused` }),
        deleteSSHKeyByName: async (name: unknown) => name !== `${P}-key-refused`,
      },
      gets: {
        '/v4/networking/firewalls': linodePage([
          { id: 1, label: `${P}-fw` },
          { id: 2, label: `${P}-fw-refused` },
          { id: 3, label: 'squeezed-ab12cd34', tags: [`project:${P}`] },
          { id: 4, label: 'someone-elses-fw', tags: ['project:someone-else'] },
        ]),
        '/v4/profile/sshkeys': linodePage([
          { id: 1, label: `${P}-key` },
          { id: 2, label: `${P}-key-refused` },
          { id: 3, label: 'someone-elses-key' },
        ]),
        '/v4/networking/ips': linodePage([
          { address: '203.0.113.7', reserved: true, linode_id: null },
          { address: '203.0.113.8', reserved: true, linode_id: 5 },
          { address: '203.0.113.9', reserved: false, linode_id: null },
        ]),
        '/v4/nodebalancers': linodePage(fourLbs('label')),
        '/v4/vpcs': linodePage(fiveNets('label')),
        '/v4/object-storage/keys': linodePage([
          { id: 11, label: `vc-app-${P}-prod` },
          { id: 12, label: `vc-app-${P}-gone` },
          { id: 13, label: `vc-app-${P}-refused` },
          { id: 14, label: `vc-app-${P}-throws` },
          { id: 15, label: 'vc-app-otherapp-prod' },
          { id: 16 },
        ]),
      },
      deletes: {
        ...netDeletes('/v4/vpcs'),
        '/v4/object-storage/keys/12': 404,
        '/v4/object-storage/keys/13': 500,
        '/v4/object-storage/keys/14': 'throw',
      },
    },
    deleteThrows: {
      provider: {
        deleteFirewallByName: async () => {
          throw boom();
        },
        deleteSSHKeyByName: async () => {
          throw boom();
        },
      },
      gets: {
        '/v4/networking/firewalls': linodePage([
          { id: 1, label: `${P}-fw` },
          { id: 2, label: `${P}-fw-2` },
        ]),
        '/v4/profile/sshkeys': linodePage([
          { id: 1, label: `${P}-key` },
          { id: 2, label: `${P}-key-2` },
        ]),
      },
    },
  },
  {
    name: 'Vultr',
    empty: vultrEnd,
    run: (fetchImpl, provider) =>
      sweepOrphanedVultrResources(TAG, P, { provider, objectStorage: noBuckets, fetchImpl }),
    mixed: {
      provider: {
        ...serversAndVolumes('label'),
        ...loadBalancerDeletes,
        deleteFirewallByName: async (name: unknown) => ({ deleted: name !== `${P}-fw-refused` }),
        deleteSSHKeyByName: async (name: unknown) => name !== `${P}-key-refused`,
      },
      gets: {
        '/v2/firewalls': {
          firewall_groups: [
            { id: 'f-1', description: `${P}-fw` },
            { id: 'f-2', description: `${P}-fw-refused` },
            { id: 'f-3', description: 'someone-elses-fw' },
            { id: 'f-4' },
          ],
          ...vultrEnd,
        },
        '/v2/reserved-ips': {
          reserved_ips: [
            { id: 'r-1', label: `project:${P}:environment:e1`, subnet: '203.0.113.7' },
            { id: 'r-2', label: `project:${P}:environment:gone` },
            { id: 'r-3', label: `project:${P}:environment:refused` },
            { id: 'r-4', label: 'project:someone-else:environment:e1' },
            { id: 'r-5' },
          ],
          ...vultrEnd,
        },
        '/v2/ssh-keys': {
          ssh_keys: [
            { id: 'k-1', name: `${P}-key` },
            { id: 'k-2', name: `${P}-key-refused` },
            { id: 'k-3', name: 'someone-elses-key' },
            { id: 'k-4' },
          ],
          ...vultrEnd,
        },
        '/v2/load-balancers': { load_balancers: fourLbs('label'), ...vultrEnd },
        '/v2/vpcs': {
          vpcs: [
            ...fiveNets('description'),
            { id: 'n-6', label: `${P}-net-labelled` },
            { id: 'n-7' },
          ],
          ...vultrEnd,
        },
      },
      deletes: {
        ...netDeletes('/v2/vpcs'),
        '/v2/reserved-ips/r-2': 404,
        '/v2/reserved-ips/r-3': 500,
      },
    },
    deleteThrows: {
      provider: {
        deleteFirewallByName: async () => {
          throw boom();
        },
        deleteSSHKeyByName: async () => {
          throw boom();
        },
      },
      gets: {
        '/v2/firewalls': {
          firewall_groups: [
            { id: 'f-1', description: `${P}-fw` },
            { id: 'f-2', description: `${P}-fw-2` },
          ],
          ...vultrEnd,
        },
        '/v2/reserved-ips': {
          reserved_ips: [
            { id: 'r-1', label: `project:${P}:environment:e1` },
            { id: 'r-2', label: `project:${P}:environment:e2` },
          ],
          ...vultrEnd,
        },
        '/v2/ssh-keys': {
          ssh_keys: [
            { id: 'k-1', name: `${P}-key` },
            { id: 'k-2', name: `${P}-key-2` },
          ],
          ...vultrEnd,
        },
      },
      deletes: { '/v2/reserved-ips/r-1': 'throw' },
    },
  },
  {
    name: 'Scaleway',
    empty: {},
    run: (fetchImpl, provider) =>
      sweepOrphanedScalewayResources(TAG, P, {
        provider,
        objectStorageByRegion: { 'fr-par': noBuckets, 'nl-ams': noBuckets },
        fetchImpl,
        projectId: 'proj-1',
      }),
    mixed: {
      provider: {
        ...serversAndVolumes('name'),
        ...loadBalancerDeletes,
        deleteFirewallByName: async (name: unknown) => ({ deleted: name !== `${P}-sg-refused` }),
        deleteSSHKeyByName: async (name: unknown) => name !== `${P}-key-refused`,
        listFlexibleIPsDetailed: async () => ({
          items: [
            {
              id: 'ip-1',
              zone: 'fr-par-1',
              server: null,
              tags: [`project:${P}`],
              address: '203.0.113.9',
            },
            { id: 'ip-2', zone: 'nl-ams-1', server: null, tags: [`project:${P}`] },
            { id: 'ip-3', zone: 'fr-par-1', server: { id: 's-1' }, tags: [`project:${P}`] },
            { id: 'ip-4', zone: 'fr-par-1', server: null, tags: ['project:other-app'] },
            { id: 'ip-5', zone: 'fr-par-1', server: null },
          ],
          complete: true,
        }),
        releaseFlexibleIP: async (id: unknown) => id !== 'ip-2',
      },
      gets: {
        '/instance/v1/zones/fr-par-1/security_groups': {
          security_groups: [
            { id: 'g-1', name: `${P}-sg` },
            { id: 'g-2', name: `${P}-sg-refused` },
            { id: 'g-3', name: `${P}-default`, project_default: true },
            { id: 'g-4', name: 'someone-elses-sg' },
            { id: 'g-5' },
          ],
        },
        '/instance/v1/zones/nl-ams-2/security_groups': {
          security_groups: [{ id: 'g-6', name: `${P}-sg-ams` }],
        },
        '/iam/v1alpha1/ssh-keys': {
          ssh_keys: [
            { id: 'k-1', name: `${P}-key` },
            { id: 'k-2', name: `${P}-key-refused` },
            { id: 'k-3', name: 'someone-elses-key' },
            { id: 'k-4' },
          ],
        },
        '/lb/v1/zones/nl-ams-1/lbs': { lbs: [...fourLbs('name'), { id: 'lb-5' }] },
        '/vpc/v2/regions/nl-ams/private-networks': {
          private_networks: [...fiveNets('name'), { id: 'n-6' }],
        },
      },
      deletes: {
        // n-1 is found in the second region; n-2 is in neither; n-3 is
        // refused in both; n-4 throws on the first try.
        '/vpc/v2/regions/fr-par/private-networks/n-1': 404,
        '/vpc/v2/regions/fr-par/private-networks/n-2': 404,
        '/vpc/v2/regions/nl-ams/private-networks/n-2': 404,
        '/vpc/v2/regions/fr-par/private-networks/n-3': 500,
        '/vpc/v2/regions/nl-ams/private-networks/n-3': 500,
        '/vpc/v2/regions/fr-par/private-networks/n-4': 'throw',
      },
    },
    deleteThrows: {
      provider: {
        deleteFirewallByName: async () => {
          throw boom();
        },
        deleteSSHKeyByName: async () => {
          throw boom();
        },
        listFlexibleIPsDetailed: async () => ({
          items: [
            { id: 'ip-1', zone: 'fr-par-1', server: null, tags: [`project:${P}`] },
            { id: 'ip-2', zone: 'fr-par-1', server: null, tags: [`project:${P}`] },
          ],
          complete: true,
        }),
        releaseFlexibleIP: async () => {
          throw boom();
        },
      },
      gets: {
        '/instance/v1/zones/fr-par-1/security_groups': {
          security_groups: [
            { id: 'g-1', name: `${P}-sg` },
            { id: 'g-2', name: `${P}-sg-2` },
          ],
        },
        // The next zone's pass still runs after the first zone's ended.
        '/instance/v1/zones/fr-par-2/security_groups': {
          security_groups: [{ id: 'g-3', name: `${P}-sg-3` }],
        },
        '/iam/v1alpha1/ssh-keys': {
          ssh_keys: [
            { id: 'k-1', name: `${P}-key` },
            { id: 'k-2', name: `${P}-key-2` },
          ],
        },
      },
    },
  },
];

/** One owned server, volume and flexible IP behind a listing that stopped early. */
const incompleteListings: Scenario = {
  provider: {
    listServersDetailed: async () => ({
      items: [{ id: 's-1', name: `${P}-prod`, label: `${P}-prod` }],
      complete: false,
    }),
    listVolumesDetailed: async () => ({
      items: [{ id: 'v-1', name: `${P}-data`, label: `${P}-data` }],
      complete: false,
    }),
    listFlexibleIPsDetailed: async () => ({
      items: [{ id: 'ip-1', zone: 'fr-par-1', server: null, tags: [`project:${P}`] }],
      complete: false,
    }),
  },
  everyGet: 503,
};

const throwingListings: Scenario = {
  provider: {
    listServersDetailed: async () => {
      throw boom();
    },
    listVolumesDetailed: async () => {
      throw boom();
    },
    listFlexibleIPsDetailed: async () => {
      throw boom();
    },
  },
  everyGet: 'throw',
};

afterEach(() => {
  vi.restoreAllMocks();
});

for (const cloud of CLOUDS) {
  describe(`${cloud.name} sweep: every pass, line for line`, () => {
    it('mixed: deletes, refusals, throws and foreign resources in every class', async () => {
      expect(await transcript(cloud, cloud.mixed)).toMatchSnapshot();
    });

    it('incomplete listings: what was read is still swept, and nothing reads clean', async () => {
      const out = await transcript(cloud, incompleteListings);
      expect(out).toMatchSnapshot();
      expect(out).toContain('"enumFailed":true');
    });

    it('throwing listings: every pass reports and the sweep goes on', async () => {
      const out = await transcript(cloud, throwingListings);
      expect(out).toMatchSnapshot();
      expect(out).toContain('"enumFailed":true');
    });

    it('a delete that throws: where it is not caught per resource, it ends that pass only', async () => {
      const out = await transcript(cloud, cloud.deleteThrows);
      expect(out).toMatchSnapshot();
      expect(out).toContain('"enumFailed":true');
    });
  });
}
