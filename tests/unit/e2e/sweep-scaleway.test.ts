/**
 * Scaleway orphan sweep (2026-08 provider expansion, PR 3).
 *
 * Mirrors sweep-vultr.test.ts's contract pins via injected fakes: prefix
 * scoping on instance/volume/security-group/ssh-key identity, the
 * cross-run CSI-volume safety rule, deletes through the provider instance
 * API, the Object Storage bucket sweep, and enumeration-incomplete
 * accounting.
 *
 * Scaleway-specific pins on top of the family set:
 *   - the FLEXIBLE-IP arm (audit design flag 5: flexible IPv4s survive
 *     server deletion at €0.005/hr) — released only when unattached AND
 *     project-tagged, never on bare unattachment;
 *   - the per-AZ auto-created DEFAULT security group is never deleted
 *     (project_default guard on top of prefix scoping);
 *   - the bucket half walks BOTH Object Storage regions (whether Scaleway
 *     ListBuckets is region-scoped is unverified — walking both is the
 *     assume-region-scoped posture the audit prescribes);
 *   - direct-API walks are page/per_page per ZONE (no cursor).
 *
 * Like Linode/Vultr, Scaleway has no anchor-bucket equivalent of DO's
 * vc-local-e2e (pure usage billing, no subscription), so the PROTECTED set
 * is pinned empty for structural parity.
 *
 * The cases every sweep shares (the empty project name, an unreadable
 * bucket listing, a "no such bucket" answer) run once per provider in
 * sweep-shared-cases.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScalewayProvider } from '../../../src/lib/providers/scaleway.js';
import { ScalewayObjectStorageProvider } from '../../../src/lib/providers/scaleway-objectstorage.js';
import {
  SCALEWAY_OTHER_PROJECT,
  SCALEWAY_TEST_PROJECT,
  stubScalewayProject,
} from '../../_shared/scaleway-project.js';
import {
  PROTECTED_OBJECT_STORAGE_BUCKETS,
  SWEEP_S3_REGIONS,
  SWEEP_ZONES,
  sweepOrphanedScalewayResources,
} from '../../e2e/utils/sweep-scaleway.js';

type ProviderLike = Parameters<typeof sweepOrphanedScalewayResources>[2]['provider'];
type StoresLike = Parameters<typeof sweepOrphanedScalewayResources>[2]['objectStorageByRegion'];
type StoreLike = NonNullable<StoresLike>[string];

function fakeProvider(
  overrides: Partial<NonNullable<ProviderLike>> = {},
): NonNullable<ProviderLike> {
  return {
    listServersDetailed: vi.fn().mockResolvedValue({ items: [], complete: true }),
    deleteServer: vi.fn().mockResolvedValue(undefined),
    listVolumesDetailed: vi.fn().mockResolvedValue({ items: [], complete: true }),
    volumeAttachedServerIds: (v: { server?: { id: string } | null }) =>
      v.server?.id ? [v.server.id] : [],
    volumeLabels: (v: { tags?: string[] }) =>
      Object.fromEntries((v.tags ?? []).map((t) => t.split(':') as [string, string])),
    deleteVolume: vi.fn().mockResolvedValue(true),
    deleteSSHKeyByName: vi.fn().mockResolvedValue(true),
    listFlexibleIPsDetailed: vi.fn().mockResolvedValue({ items: [], complete: true }),
    releaseFlexibleIP: vi.fn().mockResolvedValue(true),
    deleteLoadBalancer: vi.fn().mockResolvedValue(true),
    serverLabels: (s: { tags?: string[] }) =>
      Object.fromEntries((s.tags ?? []).map((t) => t.split(':') as [string, string])),
    ...overrides,
  };
}

function fakeStore(overrides: Partial<StoreLike> = {}): StoreLike {
  return {
    listBuckets: vi.fn().mockResolvedValue([]),
    emptyAndDeleteBucket: vi.fn().mockResolvedValue({ objectsRemoved: 0 }),
    locateBucket: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function fakeStores(): NonNullable<StoresLike> {
  return { 'fr-par': fakeStore(), 'nl-ams': fakeStore() };
}

/**
 * Rows as the API lists them in the configured project: each row of every
 * array in `body` gets `project` (Instance API) and `project_id` (the
 * others) unless it names a project of its own.
 */
function inProject(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.map((row) =>
            'project' in row || 'project_id' in row
              ? row
              : { project: SCALEWAY_TEST_PROJECT, project_id: SCALEWAY_TEST_PROJECT, ...row },
          )
        : value,
    ]),
  );
}

/** fetch stub for the security-group / ssh-key direct walks (Scaleway's
 * per-zone page/per_page envelope — a short page ends the walk). Rows are
 * the configured project's unless they say otherwise (inProject). */
function fakeFetch(pages: Record<string, unknown>): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'DELETE') return { ok: true, status: 200, json: async () => ({}) };
    for (const [prefix, body] of Object.entries(pages)) {
      if (u.includes(prefix)) return { ok: true, status: 200, json: async () => inProject(body) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

/** The URLs `fetchImpl` was sent a DELETE on, in order. */
function deletesOf(fetchImpl: typeof fetch): string[] {
  return (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')
    .map(([url]) => String(url));
}

const TAG = '[test]';

describe('sweepOrphanedScalewayResources', () => {
  // Every walk stays inside the configured project (scaleway-project.ts).
  beforeEach(() => {
    stubScalewayProject();
  });

  it('zone/region constants stay in lockstep with the live provider classes', () => {
    expect([...SWEEP_ZONES]).toEqual(Object.keys(ScalewayProvider.REGIONS));
    expect([...SWEEP_S3_REGIONS]).toEqual(Object.keys(ScalewayObjectStorageProvider.REGIONS));
  });

  it('deletes prefix-matching instances via the full teardown chain and leaves foreign ones', async () => {
    const deleteServer = vi.fn().mockResolvedValue(undefined);
    const provider = fakeProvider({
      listServersDetailed: vi.fn().mockResolvedValue({
        items: [
          { id: 'aaaa-1', name: 'testapp-s1-primary', zone: 'fr-par-1' },
          { id: 'bbbb-2', name: 'someone-elses-box', zone: 'fr-par-1' },
        ],
        complete: true,
      }),
      deleteServer,
    });

    const { counts, enumFailed } = await sweepOrphanedScalewayResources(TAG, 'testapp-s1', {
      provider,
      objectStorageByRegion: fakeStores(),
      fetchImpl: fakeFetch({}),
    });

    expect(deleteServer).toHaveBeenCalledTimes(1);
    // waitUntilGone is load-bearing on Scaleway: the provider's deleteServer
    // chain deletes the detached SBS volumes + releases IPs behind it.
    expect(deleteServer).toHaveBeenCalledWith('aaaa-1', { waitUntilGone: true });
    expect(counts.servers).toBe(1);
    expect(enumFailed).toBe(false);
  });

  it('deletes an unattached project-prefixed volume, skips attached ones', async () => {
    const deleteVolume = vi.fn().mockResolvedValue(true);
    const provider = fakeProvider({
      listVolumesDetailed: vi.fn().mockResolvedValue({
        items: [
          { id: 'vol-10', name: 'testapp-s1-root', server: null, tags: [] },
          { id: 'vol-11', name: 'testapp-s1-live', server: { id: 'aaaa-1' }, tags: [] },
        ],
        complete: true,
      }),
      deleteVolume,
    });

    const { counts } = await sweepOrphanedScalewayResources(TAG, 'testapp-s1', {
      provider,
      objectStorageByRegion: fakeStores(),
      fetchImpl: fakeFetch({}),
    });

    expect(deleteVolume).toHaveBeenCalledTimes(1);
    expect(deleteVolume).toHaveBeenCalledWith('vol-10');
    expect(counts.volumes).toBe(1);
  });

  it('never deletes an untagged unattached pvc-* volume — reports it instead (cross-run safety)', async () => {
    const deleteVolume = vi.fn().mockResolvedValue(true);
    const provider = fakeProvider({
      listVolumesDetailed: vi.fn().mockResolvedValue({
        items: [
          { id: 'vol-20', name: 'pvc-aaaa', server: null, tags: [] },
          { id: 'vol-21', name: 'pvc-bbbb', server: null, tags: ['project:testapp-s1'] },
        ],
        complete: true,
      }),
      deleteVolume,
    });

    const { counts } = await sweepOrphanedScalewayResources(TAG, 'testapp-s1', {
      provider,
      objectStorageByRegion: fakeStores(),
      fetchImpl: fakeFetch({}),
    });

    expect(deleteVolume).toHaveBeenCalledTimes(1);
    expect(deleteVolume).toHaveBeenCalledWith('vol-21');
    expect(counts.volumes).toBe(1);
  });

  it('deletes prefix-matching security groups but NEVER the per-AZ default group', async () => {
    const provider = fakeProvider();
    const fetchImpl = fakeFetch({
      '/zones/fr-par-1/security_groups': {
        security_groups: [
          { id: 'sg-1', name: 'testapp-s1-prod-firewall' },
          { id: 'sg-2', name: 'Default security group', project_default: true },
          // Adversarial: even a default group whose name somehow carries
          // the prefix must survive — project_default wins.
          { id: 'sg-3', name: 'testapp-s1-default', project_default: true },
          { id: 'sg-4', name: 'other-fw' },
        ],
      },
    });
    const { counts } = await sweepOrphanedScalewayResources(TAG, 'testapp-s1', {
      provider,
      objectStorageByRegion: fakeStores(),
      fetchImpl,
    });

    expect(deletesOf(fetchImpl)).toEqual([
      'https://api.scaleway.com/instance/v1/zones/fr-par-1/security_groups/sg-1',
    ]);
    expect(counts.firewalls).toBe(1);
  });

  it("never deletes another project's group, load balancer, network, VPC or key with our prefix", async () => {
    const provider = fakeProvider();
    const theirs = { project: SCALEWAY_OTHER_PROJECT, project_id: SCALEWAY_OTHER_PROJECT };
    const fetchImpl = fakeFetch({
      '/zones/fr-par-1/security_groups': {
        security_groups: [{ id: 'sg-9', name: 'testapp-s1-prod-firewall', ...theirs }],
      },
      '/lb/v1/zones/fr-par-1/lbs': { lbs: [{ id: 'lb-9', name: 'testapp-s1-prod-lb', ...theirs }] },
      '/vpc/v2/regions/fr-par/private-networks': {
        private_networks: [{ id: 'pn-9', name: 'testapp-s1-prod-network', ...theirs }],
      },
      '/vpc/v2/regions/fr-par/vpcs': {
        vpcs: [{ id: 'vpc-9', name: 'testapp-s1-prod-network', ...theirs }],
      },
      '/iam/v1alpha1/ssh-keys': {
        ssh_keys: [{ id: 'key-9', name: 'testapp-s1-prod-fr-par-1-key', ...theirs }],
      },
    });
    const { counts, enumFailed } = await sweepOrphanedScalewayResources(TAG, 'testapp-s1', {
      provider,
      objectStorageByRegion: fakeStores(),
      fetchImpl,
    });

    expect(deletesOf(fetchImpl)).toEqual([]);
    expect(provider.deleteSSHKeyByName).not.toHaveBeenCalled();
    expect(counts).toMatchObject({ firewalls: 0, loadBalancers: 0, networks: 0, sshKeys: 0 });
    expect(enumFailed).toBe(false);
    // Every walk asked the API for our project only.
    const listings = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      ([url]) => new URL(String(url)),
    );
    expect(listings.length).toBeGreaterThan(0);
    for (const u of listings) {
      const field = u.pathname.startsWith('/instance/') ? 'project' : 'project_id';
      expect(u.searchParams.get(field), u.pathname).toBe(SCALEWAY_TEST_PROJECT);
    }
  });

  it('deletes same-name twin security groups, each by its own id and zone', async () => {
    const fetchImpl = fakeFetch({
      '/zones/fr-par-1/security_groups': {
        security_groups: [
          { id: 'sg-1', name: 'testapp-s1-prod-firewall' },
          { id: 'sg-2', name: 'testapp-s1-prod-firewall' },
        ],
      },
      '/zones/nl-ams-1/security_groups': {
        security_groups: [{ id: 'sg-3', name: 'testapp-s1-prod-firewall' }],
      },
    });
    const { counts, enumFailed } = await sweepOrphanedScalewayResources(TAG, 'testapp-s1', {
      provider: fakeProvider(),
      objectStorageByRegion: fakeStores(),
      fetchImpl,
    });

    expect(deletesOf(fetchImpl)).toEqual([
      'https://api.scaleway.com/instance/v1/zones/fr-par-1/security_groups/sg-1',
      'https://api.scaleway.com/instance/v1/zones/fr-par-1/security_groups/sg-2',
      'https://api.scaleway.com/instance/v1/zones/nl-ams-1/security_groups/sg-3',
    ]);
    expect(counts.firewalls).toBe(3);
    expect(enumFailed).toBe(false);
  });

  it('a security-group delete Scaleway refuses fails the sweep, naming the group', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return { ok: false, status: 409, json: async () => ({}) };
      const rows = String(url).includes('/zones/fr-par-1/security_groups')
        ? [{ id: 'sg-1', name: 'testapp-s1-prod-firewall', project: SCALEWAY_TEST_PROJECT }]
        : [];
      return { ok: true, status: 200, json: async () => ({ security_groups: rows }) };
    }) as unknown as typeof fetch;
    try {
      const { counts, enumFailed } = await sweepOrphanedScalewayResources(TAG, 'testapp-s1', {
        provider: fakeProvider(),
        objectStorageByRegion: fakeStores(),
        fetchImpl,
      });
      expect(counts.firewalls).toBe(0);
      expect(enumFailed).toBe(true);
      expect(warn.mock.calls.map(([line]) => String(line)).join('\n')).toContain(
        'Security group sg-1 (testapp-s1-prod-firewall) delete failed (HTTP 409)',
      );
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it('without SCALEWAY_DEFAULT_PROJECT_ID it sweeps nothing and reads incomplete', async () => {
    vi.stubEnv('SCALEWAY_DEFAULT_PROJECT_ID', '');
    delete process.env.SCALEWAY_DEFAULT_PROJECT_ID;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const provider = fakeProvider();
    const fetchImpl = fakeFetch({});
    const stores = fakeStores();
    try {
      const { enumFailed } = await sweepOrphanedScalewayResources(TAG, 'testapp-s1', {
        provider,
        objectStorageByRegion: stores,
        fetchImpl,
      });
      expect(enumFailed).toBe(true);
      expect(warn.mock.calls.map(([line]) => String(line)).join('\n')).toContain(
        'Scaleway (no SCALEWAY_DEFAULT_PROJECT_ID, so nothing was swept',
      );
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(provider.listServersDetailed).not.toHaveBeenCalled();
      expect(stores['fr-par'].listBuckets).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it('deletes prefix-matching Project IAM ssh keys', async () => {
    const provider = fakeProvider();
    const { counts } = await sweepOrphanedScalewayResources(TAG, 'testapp-s1', {
      provider,
      objectStorageByRegion: fakeStores(),
      fetchImpl: fakeFetch({
        '/iam/v1alpha1/ssh-keys': {
          ssh_keys: [
            { id: 'key-3', name: 'testapp-s1-prod-fr-par-1-key' },
            { id: 'key-4', name: 'laptop' },
          ],
        },
      }),
    });

    expect(provider.deleteSSHKeyByName).toHaveBeenCalledTimes(1);
    expect(provider.deleteSSHKeyByName).toHaveBeenCalledWith('testapp-s1-prod-fr-par-1-key');
    expect(counts.sshKeys).toBe(1);
  });

  it('releases an unattached project-tagged flexible IP; leaves attached and foreign ones', async () => {
    const releaseFlexibleIP = vi.fn().mockResolvedValue(true);
    const provider = fakeProvider({
      listFlexibleIPsDetailed: vi.fn().mockResolvedValue({
        items: [
          // orphan: unattached + tagged with our project → released
          {
            id: 'ip-1',
            zone: 'fr-par-1',
            server: null,
            tags: ['project:testapp-s1', 'environment:prod'],
            address: '203.0.113.9',
          },
          // attached → the instance arm's territory, never released here
          { id: 'ip-2', zone: 'fr-par-1', server: { id: 'aaaa-1' }, tags: ['project:testapp-s1'] },
          // foreign tag → concurrent run's IP
          { id: 'ip-3', zone: 'fr-par-1', server: null, tags: ['project:other-app'] },
          // untagged → no ownership signal, never guessed at
          { id: 'ip-4', zone: 'fr-par-1', server: null, tags: [] },
        ],
        complete: true,
      }),
      releaseFlexibleIP,
    });

    const { counts } = await sweepOrphanedScalewayResources(TAG, 'testapp-s1', {
      provider,
      objectStorageByRegion: fakeStores(),
      fetchImpl: fakeFetch({}),
    });

    expect(releaseFlexibleIP).toHaveBeenCalledTimes(1);
    expect(releaseFlexibleIP).toHaveBeenCalledWith('ip-1', 'fr-par-1');
    expect(counts.floatingIps).toBe(1);
  });

  it("sweeps a k8s cluster's leftovers by prefix", async () => {
    // scaleway-k8s.js names every resource from `<project>-<env>` and tags
    // each node's flexible IP with the project and environment as two tags.
    // Its CSI volumes carry no tags (scaleway-csi sets none), so an
    // unattached one is reported, never deleted.
    const deleteServer = vi.fn().mockResolvedValue(undefined);
    const deleteVolume = vi.fn().mockResolvedValue(true);
    const releaseFlexibleIP = vi.fn().mockResolvedValue(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const k8sTags = (role: string) => ['project:acme', 'environment:s3', `role:${role}`];
    const provider = fakeProvider({
      listServersDetailed: vi.fn().mockResolvedValue({
        items: [
          { id: 'srv-1', name: 'acme-s3-master', zone: 'fr-par-1' },
          { id: 'srv-2', name: 'acme-s3-db', zone: 'fr-par-1' },
          { id: 'srv-3', name: 'acme-s3-worker-1', zone: 'fr-par-1' },
          { id: 'srv-4', name: 'someone-elses-master', zone: 'fr-par-1' },
        ],
        complete: true,
      }),
      deleteServer,
      listVolumesDetailed: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'vol-1',
            name: 'pvc-01234567-89ab-cdef-0123-456789abcdef',
            zone: 'fr-par-1',
            server: null,
            tags: [],
          },
        ],
        complete: true,
      }),
      deleteVolume,
      listFlexibleIPsDetailed: vi.fn().mockResolvedValue({
        items: [
          { id: 'ip-1', zone: 'fr-par-1', server: null, tags: k8sTags('master') },
          { id: 'ip-2', zone: 'fr-par-1', server: null, tags: k8sTags('worker') },
          { id: 'ip-3', zone: 'fr-par-1', server: null, tags: ['project:other', 'environment:s3'] },
        ],
        complete: true,
      }),
      releaseFlexibleIP,
    });
    const fetchImpl = fakeFetch({
      '/zones/fr-par-1/security_groups': {
        security_groups: [
          { id: 'sg-1', name: 'acme-s3-firewall' },
          { id: 'sg-2', name: 'Default security group', project_default: true },
        ],
      },
      '/iam/v1alpha1/ssh-keys': {
        ssh_keys: [
          { id: 'key-1', name: 'acme-s3-fr-par-1-key' },
          { id: 'key-2', name: 'laptop' },
        ],
      },
      '/vpc/v2/regions/fr-par/private-networks': {
        private_networks: [
          { id: 'pn-1', name: 'acme-s3-network' },
          { id: 'pn-2', name: 'other-network' },
        ],
      },
      '/vpc/v2/regions/fr-par/vpcs': {
        vpcs: [
          { id: 'vpc-def', name: 'default', is_default: true },
          { id: 'vpc-1', name: 'acme-s3-network' },
          // Adversarial: a default VPC whose name carries the prefix stays.
          { id: 'vpc-3', name: 'acme-default', is_default: true },
          { id: 'vpc-2', name: 'other-network' },
        ],
      },
    });

    try {
      const { counts, enumFailed } = await sweepOrphanedScalewayResources(TAG, 'acme', {
        provider,
        objectStorageByRegion: fakeStores(),
        fetchImpl,
      });

      expect(deleteServer.mock.calls.map(([id]) => id)).toEqual(['srv-1', 'srv-2', 'srv-3']);
      expect(provider.deleteSSHKeyByName).toHaveBeenCalledExactlyOnceWith('acme-s3-fr-par-1-key');
      expect(releaseFlexibleIP.mock.calls).toEqual([
        ['ip-1', 'fr-par-1'],
        ['ip-2', 'fr-par-1'],
      ]);
      const deletes = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls
        .filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')
        .map(([url]) => String(url));
      // The group goes by its id, the Private Network before its VPC: a VPC
      // holding one cannot go.
      expect(deletes).toEqual([
        'https://api.scaleway.com/instance/v1/zones/fr-par-1/security_groups/sg-1',
        'https://api.scaleway.com/vpc/v2/regions/fr-par/private-networks/pn-1',
        'https://api.scaleway.com/vpc/v2/regions/fr-par/vpcs/vpc-1',
      ]);
      expect(deleteVolume).not.toHaveBeenCalled();
      expect(warn.mock.calls.map(([line]) => String(line)).join('\n')).toContain(
        'Unattached CSI volume pvc-01234567-89ab-cdef-0123-456789abcdef carries no project=acme tag',
      );
      expect(counts).toMatchObject({
        servers: 3,
        volumes: 0,
        firewalls: 1,
        floatingIps: 2,
        sshKeys: 1,
        networks: 2,
      });
      expect(enumFailed).toBe(false);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it('a VPC delete Scaleway refuses fails the sweep, naming the VPC', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'DELETE') return { ok: false, status: 412, json: async () => ({}) };
      if (u.includes('/vpc/v2/regions/nl-ams/vpcs')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            vpcs: [{ id: 'vpc-1', name: 'acme-s3-network', project_id: SCALEWAY_TEST_PROJECT }],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    try {
      const { counts } = await sweepOrphanedScalewayResources(TAG, 'acme', {
        provider: fakeProvider(),
        objectStorageByRegion: fakeStores(),
        fetchImpl,
      });
      expect(counts.networks).toBe(0);
      expect(warn.mock.calls.map(([line]) => String(line)).join('\n')).toContain(
        'VPC vpc-1 delete failed',
      );
      const deletes = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls
        .filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')
        .map(([u]) => String(u));
      expect(deletes).toEqual(['https://api.scaleway.com/vpc/v2/regions/nl-ams/vpcs/vpc-1']);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it('sweeps prefix-matching buckets across BOTH Object Storage regions', async () => {
    const frDelete = vi.fn().mockResolvedValue({ objectsRemoved: 3 });
    const amsDelete = vi.fn().mockResolvedValue({ objectsRemoved: 1 });
    const stores: NonNullable<StoresLike> = {
      'fr-par': fakeStore({
        listBuckets: vi.fn().mockResolvedValue(['testapp-s1-backups', 'unrelated']),
        emptyAndDeleteBucket: frDelete,
      }),
      'nl-ams': fakeStore({
        listBuckets: vi.fn().mockResolvedValue(['testapp-s1-state']),
        emptyAndDeleteBucket: amsDelete,
      }),
    };

    const { counts } = await sweepOrphanedScalewayResources(TAG, 'testapp-s1', {
      provider: fakeProvider(),
      objectStorageByRegion: stores,
      fetchImpl: fakeFetch({}),
    });

    expect(frDelete).toHaveBeenCalledWith('testapp-s1-backups');
    expect(amsDelete).toHaveBeenCalledWith('testapp-s1-state');
    expect(counts.s3Buckets).toBe(2);
  });

  it('marks enumeration incomplete (enumFailed) when a listing cannot be walked', async () => {
    const provider = fakeProvider({
      listServersDetailed: vi.fn().mockResolvedValue({ items: [], complete: false, status: 403 }),
    });

    const { enumFailed } = await sweepOrphanedScalewayResources(TAG, 'testapp-s1', {
      provider,
      objectStorageByRegion: fakeStores(),
      fetchImpl: fakeFetch({}),
    });

    expect(enumFailed).toBe(true);
  });

  it('marks enumFailed when one region’s bucket listing is unreadable (the other still sweeps)', async () => {
    const amsDelete = vi.fn().mockResolvedValue({ objectsRemoved: 0 });
    const stores: NonNullable<StoresLike> = {
      'fr-par': fakeStore({ listBuckets: vi.fn().mockResolvedValue(null) }),
      'nl-ams': fakeStore({
        listBuckets: vi.fn().mockResolvedValue(['testapp-s1-state']),
        emptyAndDeleteBucket: amsDelete,
      }),
    };

    const { counts, enumFailed } = await sweepOrphanedScalewayResources(TAG, 'testapp-s1', {
      provider: fakeProvider(),
      objectStorageByRegion: stores,
      fetchImpl: fakeFetch({}),
    });

    expect(enumFailed).toBe(true);
    expect(amsDelete).toHaveBeenCalledWith('testapp-s1-state');
    expect(counts.s3Buckets).toBe(1);
  });

  it('pins the protected-bucket set empty — Scaleway has no subscription-anchor bucket', () => {
    expect([...PROTECTED_OBJECT_STORAGE_BUCKETS]).toEqual([]);
  });
});
