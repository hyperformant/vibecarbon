/**
 * Vultr orphan sweep (2026-08 provider expansion, PR 2).
 *
 * Mirrors sweep-linode.test.ts's contract pins via injected fakes: prefix
 * scoping on instance/volume/firewall/ssh-key identity, the cross-run
 * CSI-volume safety rule, deletes through the provider instance API, the
 * Object Storage bucket sweep, and enumeration-incomplete accounting.
 *
 * Two Vultr-specific pins on top of the Linode set:
 *   - the direct-API walks use CURSOR pagination (`meta.links.next` fed back
 *     as `&cursor=`), not Linode's `{data, page, pages}` page counter;
 *   - the bucket half is scoped to ONE cluster because Vultr object-storage
 *     keys are per-subscription — with no cluster configured the bucket half
 *     must report itself incomplete rather than guess a cluster the keys
 *     cannot authenticate against.
 *
 * Like Linode, Vultr has no anchor-bucket equivalent of DO's vc-local-e2e,
 * so the PROTECTED set is pinned empty for structural parity.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PROTECTED_OBJECT_STORAGE_BUCKETS,
  sweepOrphanedVultrResources,
} from '../../e2e/utils/sweep-vultr.js';

type ProviderLike = Parameters<typeof sweepOrphanedVultrResources>[2]['provider'];
type StorageLike = Parameters<typeof sweepOrphanedVultrResources>[2]['objectStorage'];

function fakeProvider(
  overrides: Partial<NonNullable<ProviderLike>> = {},
): NonNullable<ProviderLike> {
  return {
    listServersDetailed: vi.fn().mockResolvedValue({ items: [], complete: true }),
    deleteServer: vi.fn().mockResolvedValue(undefined),
    listVolumesDetailed: vi.fn().mockResolvedValue({ items: [], complete: true }),
    volumeAttachedServerIds: (v: { attached_to_instance?: string | null }) =>
      v.attached_to_instance ? [v.attached_to_instance] : [],
    volumeLabels: (v: { tags?: string[] }) =>
      Object.fromEntries((v.tags ?? []).map((t) => t.split(':') as [string, string])),
    deleteVolume: vi.fn().mockResolvedValue(true),
    deleteFirewallByName: vi.fn().mockResolvedValue({ deleted: true, everExisted: true }),
    deleteSSHKeyByName: vi.fn().mockResolvedValue(true),
    listLoadBalancers: vi.fn().mockResolvedValue([]),
    deleteLoadBalancer: vi.fn().mockResolvedValue(true),
    listNetworks: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function fakeStorage(overrides: Partial<NonNullable<StorageLike>> = {}): NonNullable<StorageLike> {
  return {
    listBuckets: vi.fn().mockResolvedValue([]),
    emptyAndDeleteBucket: vi.fn().mockResolvedValue({ objectsRemoved: 0 }),
    ...overrides,
  };
}

/** fetch stub for the firewall / ssh-key / vpc enumeration walks (Vultr's
 * `{<key>: [...], meta: {links: {next}}}` cursor envelope). */
function fakeFetch(pages: Record<string, unknown>): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'DELETE') return { ok: true, status: 200, json: async () => ({}) };
    for (const [prefix, body] of Object.entries(pages)) {
      if (u.includes(prefix)) return { ok: true, status: 200, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => ({ meta: { links: { next: '' } } }) };
  }) as unknown as typeof fetch;
}

const TAG = '[test]';

describe('sweepOrphanedVultrResources', () => {
  it('refuses to sweep with an empty project name (an empty prefix matches everything)', async () => {
    await expect(
      sweepOrphanedVultrResources(TAG, '', {
        provider: fakeProvider(),
        objectStorage: fakeStorage(),
        fetchImpl: fakeFetch({}),
      }),
    ).rejects.toThrow(/project name/i);
  });

  it('deletes prefix-matching instances (settled) and leaves foreign ones', async () => {
    const deleteServer = vi.fn().mockResolvedValue(undefined);
    const provider = fakeProvider({
      listServersDetailed: vi.fn().mockResolvedValue({
        items: [
          { id: 'aaaa-1', label: 'testapp-v1-primary' },
          { id: 'bbbb-2', label: 'someone-elses-box' },
        ],
        complete: true,
      }),
      deleteServer,
    });

    const { counts, enumFailed } = await sweepOrphanedVultrResources(TAG, 'testapp-v1', {
      provider,
      objectStorage: fakeStorage(),
      fetchImpl: fakeFetch({}),
    });

    expect(deleteServer).toHaveBeenCalledTimes(1);
    expect(deleteServer).toHaveBeenCalledWith('aaaa-1', { waitUntilGone: true });
    expect(counts.servers).toBe(1);
    expect(enumFailed).toBe(false);
  });

  it('deletes an unattached project-prefixed volume, skips attached ones', async () => {
    const deleteVolume = vi.fn().mockResolvedValue(true);
    const provider = fakeProvider({
      listVolumesDetailed: vi.fn().mockResolvedValue({
        items: [
          { id: 'vol-10', label: 'testapp-v1-data', attached_to_instance: null, tags: [] },
          { id: 'vol-11', label: 'testapp-v1-live', attached_to_instance: 'aaaa-1', tags: [] },
        ],
        complete: true,
      }),
      deleteVolume,
    });

    const { counts } = await sweepOrphanedVultrResources(TAG, 'testapp-v1', {
      provider,
      objectStorage: fakeStorage(),
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
          { id: 'vol-20', label: 'pvc-aaaa', attached_to_instance: null, tags: [] },
          {
            id: 'vol-21',
            label: 'pvc-bbbb',
            attached_to_instance: null,
            tags: ['project:testapp-v1'],
          },
        ],
        complete: true,
      }),
      deleteVolume,
    });

    const { counts } = await sweepOrphanedVultrResources(TAG, 'testapp-v1', {
      provider,
      objectStorage: fakeStorage(),
      fetchImpl: fakeFetch({}),
    });

    // Only the project-tagged CSI volume goes; the untagged one is reported.
    expect(deleteVolume).toHaveBeenCalledTimes(1);
    expect(deleteVolume).toHaveBeenCalledWith('vol-21');
    expect(counts.volumes).toBe(1);
  });

  it('deletes prefix-matching firewall groups (identity = description) and ssh keys (name)', async () => {
    const provider = fakeProvider();
    const { counts } = await sweepOrphanedVultrResources(TAG, 'testapp-v1', {
      provider,
      objectStorage: fakeStorage(),
      fetchImpl: fakeFetch({
        '/firewalls': {
          firewall_groups: [
            { id: 'fw-1', description: 'testapp-v1-prod-firewall' },
            { id: 'fw-2', description: 'other-fw' },
          ],
          meta: { links: { next: '' } },
        },
        '/ssh-keys': {
          ssh_keys: [
            { id: 'key-3', name: 'testapp-v1-prod-ewr-key' },
            { id: 'key-4', name: 'laptop' },
          ],
          meta: { links: { next: '' } },
        },
      }),
    });

    expect(provider.deleteFirewallByName).toHaveBeenCalledTimes(1);
    expect(provider.deleteFirewallByName).toHaveBeenCalledWith('testapp-v1-prod-firewall');
    expect(provider.deleteSSHKeyByName).toHaveBeenCalledTimes(1);
    expect(provider.deleteSSHKeyByName).toHaveBeenCalledWith('testapp-v1-prod-ewr-key');
    expect(counts.firewalls).toBe(1);
    expect(counts.sshKeys).toBe(1);
  });

  it('follows Vultr cursor pagination (meta.links.next fed back as &cursor=)', async () => {
    // Vultr v2 has no page/pages counter — a walk that stops at the first
    // response silently leaves every later page's residue behind.
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'DELETE') return { ok: true, status: 200, json: async () => ({}) };
      seen.push(u);
      if (u.includes('/firewalls')) {
        if (u.includes('cursor=CURSOR2')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              firewall_groups: [{ id: 'fw-2', description: 'testapp-v1-second-page' }],
              meta: { links: { next: '' } },
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            firewall_groups: [{ id: 'fw-1', description: 'testapp-v1-first-page' }],
            meta: { links: { next: 'CURSOR2' } },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ meta: { links: { next: '' } } }) };
    }) as unknown as typeof fetch;

    const provider = fakeProvider();
    const { counts } = await sweepOrphanedVultrResources(TAG, 'testapp-v1', {
      provider,
      objectStorage: fakeStorage(),
      fetchImpl,
    });

    expect(provider.deleteFirewallByName).toHaveBeenCalledWith('testapp-v1-first-page');
    expect(provider.deleteFirewallByName).toHaveBeenCalledWith('testapp-v1-second-page');
    expect(counts.firewalls).toBe(2);
    expect(seen.some((u) => u.includes('/firewalls') && u.includes('cursor=CURSOR2'))).toBe(true);
  });

  it('sweeps a VPC identified only by `description` (Vultr VPCs carry no label)', async () => {
    // Matching on `label` alone would make the whole VPC pass a silent
    // no-op against raw API rows — the leak would never be reported.
    const fetchImpl = fakeFetch({});
    const provider = fakeProvider({
      listNetworks: vi.fn().mockResolvedValue([
        { id: 'vpc-1', description: 'testapp-v1-net' },
        { id: 'vpc-2', description: 'someone-elses-net' },
      ]),
    });

    const { counts } = await sweepOrphanedVultrResources(TAG, 'testapp-v1', {
      provider,
      objectStorage: fakeStorage(),
      fetchImpl,
    });

    expect(counts.networks).toBe(1);
    expect(fetchImpl).toHaveBeenCalledWith('https://api.vultr.com/v2/vpcs/vpc-1', {
      method: 'DELETE',
    });
  });

  it('sweeps prefix-matching Object Storage buckets via the subscription cluster listing', async () => {
    // Unlike Linode (account ListBuckets → SignatureDoesNotMatch on its
    // RGW), plain S3 ListBuckets WORKS on Vultr — live-probed 2026-08-08 —
    // and per-subscription keys scope it to exactly this cluster's buckets.
    const emptyAndDeleteBucket = vi.fn().mockResolvedValue({ objectsRemoved: 3 });
    const storage = fakeStorage({
      listBuckets: vi.fn().mockResolvedValue(['testapp-v1-backups', 'unrelated']),
      emptyAndDeleteBucket,
    });

    const { counts } = await sweepOrphanedVultrResources(TAG, 'testapp-v1', {
      provider: fakeProvider(),
      objectStorage: storage,
      fetchImpl: fakeFetch({}),
      storageRegion: 'ewr1',
    });

    expect(emptyAndDeleteBucket).toHaveBeenCalledTimes(1);
    expect(emptyAndDeleteBucket).toHaveBeenCalledWith('testapp-v1-backups');
    expect(counts.s3Buckets).toBe(1);
  });

  it('marks enumeration incomplete (enumFailed) when a listing cannot be walked', async () => {
    const provider = fakeProvider({
      listServersDetailed: vi.fn().mockResolvedValue({ items: [], complete: false, status: 403 }),
    });

    const { enumFailed } = await sweepOrphanedVultrResources(TAG, 'testapp-v1', {
      provider,
      objectStorage: fakeStorage(),
      fetchImpl: fakeFetch({}),
    });

    expect(enumFailed).toBe(true);
  });

  it('marks enumFailed when the bucket listing is unreadable', async () => {
    const storage = fakeStorage({
      listBuckets: vi.fn().mockResolvedValue(null),
    });

    const { enumFailed } = await sweepOrphanedVultrResources(TAG, 'testapp-v1', {
      provider: fakeProvider(),
      objectStorage: storage,
      fetchImpl: fakeFetch({}),
    });

    expect(enumFailed).toBe(true);
  });

  it('marks enumFailed rather than guessing a cluster when no storage region is configured', async () => {
    // Per-subscription keys only authenticate against their OWN cluster, so
    // a defaulted cluster would produce an authoritative-looking empty
    // listing for the wrong endpoint. Incomplete beats wrong.
    const prevRegion = process.env.VULTR_STORAGE_REGION;
    const prevKey = process.env.VULTR_ACCESS_KEY;
    const prevSecret = process.env.VULTR_SECRET_KEY;
    process.env.VULTR_STORAGE_REGION = '';
    process.env.VULTR_ACCESS_KEY = 'AKIAEXAMPLE';
    process.env.VULTR_SECRET_KEY = 'secretexample';
    try {
      const { enumFailed } = await sweepOrphanedVultrResources(TAG, 'testapp-v1', {
        provider: fakeProvider(),
        fetchImpl: fakeFetch({}),
      });
      expect(enumFailed).toBe(true);
    } finally {
      if (prevRegion === undefined) delete process.env.VULTR_STORAGE_REGION;
      else process.env.VULTR_STORAGE_REGION = prevRegion;
      if (prevKey === undefined) delete process.env.VULTR_ACCESS_KEY;
      else process.env.VULTR_ACCESS_KEY = prevKey;
      if (prevSecret === undefined) delete process.env.VULTR_SECRET_KEY;
      else process.env.VULTR_SECRET_KEY = prevSecret;
    }
  });

  it('pins the protected-bucket set empty — Vultr has no subscription-anchor bucket', () => {
    expect([...PROTECTED_OBJECT_STORAGE_BUCKETS]).toEqual([]);
  });
});
