/**
 * Linode orphan sweep (2026-08 provider expansion, PR 1).
 *
 * Mirrors sweep-digitalocean.test.ts's contract pins via injected fakes:
 * prefix scoping on instance/volume/firewall/ssh-key labels, the cross-run
 * CSI-volume safety rule, deletes through the provider instance API, the
 * Object Storage bucket sweep, and enumeration-incomplete accounting.
 * Linode has no anchor-bucket equivalent of DO's vc-local-e2e (Object
 * Storage cancellation is explicit on Linode, never a side effect of
 * deleting the last bucket) — the PROTECTED set exists for structural
 * parity and is pinned empty.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PROTECTED_OBJECT_STORAGE_BUCKETS,
  sweepOrphanedLinodeResources,
} from '../../e2e/utils/sweep-linode.js';

type ProviderLike = Parameters<typeof sweepOrphanedLinodeResources>[2]['provider'];
type StorageLike = Parameters<typeof sweepOrphanedLinodeResources>[2]['objectStorage'];

function fakeProvider(
  overrides: Partial<NonNullable<ProviderLike>> = {},
): NonNullable<ProviderLike> {
  return {
    listServersDetailed: vi.fn().mockResolvedValue({ items: [], complete: true }),
    deleteServer: vi.fn().mockResolvedValue(undefined),
    listVolumesDetailed: vi.fn().mockResolvedValue({ items: [], complete: true }),
    volumeAttachedServerIds: (v: { linode_id?: number | null }) =>
      v.linode_id != null ? [v.linode_id] : [],
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
    listAllBuckets: vi.fn().mockResolvedValue([]),
    emptyAndDeleteBucket: vi.fn().mockResolvedValue({ objectsRemoved: 0 }),
    ...overrides,
  };
}

/** fetch stub for the firewall / ssh-key / vpc enumeration walks
 * (Linode's `{data, page, pages}` envelope). */
function fakeFetch(pages: Record<string, unknown>): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'DELETE') return { ok: true, status: 200, json: async () => ({}) };
    for (const [prefix, body] of Object.entries(pages)) {
      if (u.includes(prefix)) return { ok: true, status: 200, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => ({ data: [], page: 1, pages: 1 }) };
  }) as unknown as typeof fetch;
}

const TAG = '[test]';

describe('sweepOrphanedLinodeResources', () => {
  it('refuses to sweep with an empty project name (an empty prefix matches everything)', async () => {
    await expect(
      sweepOrphanedLinodeResources(TAG, '', {
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
          { id: 1, label: 'testapp-l1-primary' },
          { id: 2, label: 'someone-elses-box' },
        ],
        complete: true,
      }),
      deleteServer,
    });

    const { counts, enumFailed } = await sweepOrphanedLinodeResources(TAG, 'testapp-l1', {
      provider,
      objectStorage: fakeStorage(),
      fetchImpl: fakeFetch({}),
    });

    expect(deleteServer).toHaveBeenCalledTimes(1);
    expect(deleteServer).toHaveBeenCalledWith(1, { waitUntilGone: true });
    expect(counts.servers).toBe(1);
    expect(enumFailed).toBe(false);
  });

  it('deletes an unattached project-prefixed volume, skips attached ones', async () => {
    const deleteVolume = vi.fn().mockResolvedValue(true);
    const provider = fakeProvider({
      listVolumesDetailed: vi.fn().mockResolvedValue({
        items: [
          { id: 10, label: 'testapp_l1_data', linode_id: null, tags: [] },
          { id: 11, label: 'testapp_l1_live', linode_id: 5, tags: [] },
        ],
        complete: true,
      }),
      volumeAttachedServerIds: (v: { linode_id?: number | null }) =>
        v.linode_id != null ? [v.linode_id] : [],
      deleteVolume,
    });

    const { counts } = await sweepOrphanedLinodeResources(TAG, 'testapp_l1', {
      provider,
      objectStorage: fakeStorage(),
      fetchImpl: fakeFetch({}),
    });

    expect(deleteVolume).toHaveBeenCalledTimes(1);
    expect(deleteVolume).toHaveBeenCalledWith(10);
    expect(counts.volumes).toBe(1);
  });

  it('never deletes an untagged unattached pvc-* volume — reports it instead (cross-run safety)', async () => {
    const deleteVolume = vi.fn().mockResolvedValue(true);
    const provider = fakeProvider({
      listVolumesDetailed: vi.fn().mockResolvedValue({
        items: [
          { id: 20, label: 'pvc-aaaa', linode_id: null, tags: [] },
          { id: 21, label: 'pvc-bbbb', linode_id: null, tags: ['project:testapp-l1'] },
        ],
        complete: true,
      }),
      deleteVolume,
    });

    const { counts } = await sweepOrphanedLinodeResources(TAG, 'testapp-l1', {
      provider,
      objectStorage: fakeStorage(),
      fetchImpl: fakeFetch({}),
    });

    // Only the project-tagged CSI volume goes; the untagged one is reported.
    expect(deleteVolume).toHaveBeenCalledTimes(1);
    expect(deleteVolume).toHaveBeenCalledWith(21);
    expect(counts.volumes).toBe(1);
  });

  it('deletes prefix-matching firewalls and ssh keys through the provider name APIs', async () => {
    const provider = fakeProvider();
    const { counts } = await sweepOrphanedLinodeResources(TAG, 'testapp-l1', {
      provider,
      objectStorage: fakeStorage(),
      fetchImpl: fakeFetch({
        '/networking/firewalls': {
          data: [
            { id: 1, label: 'testapp-l1-prod-firewall' },
            { id: 2, label: 'other-fw' },
          ],
          page: 1,
          pages: 1,
        },
        '/profile/sshkeys': {
          data: [
            { id: 3, label: 'testapp-l1-prod-us-iad-key' },
            { id: 4, label: 'laptop' },
          ],
          page: 1,
          pages: 1,
        },
      }),
    });

    expect(provider.deleteFirewallByName).toHaveBeenCalledTimes(1);
    expect(provider.deleteFirewallByName).toHaveBeenCalledWith('testapp-l1-prod-firewall');
    expect(provider.deleteSSHKeyByName).toHaveBeenCalledTimes(1);
    expect(provider.deleteSSHKeyByName).toHaveBeenCalledWith('testapp-l1-prod-us-iad-key');
    expect(counts.firewalls).toBe(1);
    expect(counts.sshKeys).toBe(1);
  });

  it('deletes a squeezed-label firewall via its project tag (label no longer prefix-matches)', async () => {
    // A 48-char logical name squeezed to 32 chars is not a projectName
    // prefix anymore — ownership comes from the program-stamped tag.
    const provider = fakeProvider();
    const { counts } = await sweepOrphanedLinodeResources(
      TAG,
      'testapp-compose-1786199806402-g444o5',
      {
        provider,
        objectStorage: fakeStorage(),
        fetchImpl: fakeFetch({
          '/networking/firewalls': {
            data: [
              {
                id: 9,
                label: 'testapp-compose-1786199-ab12cd34',
                tags: ['project:testapp-compose-1786199806402-g444o5'],
              },
              { id: 10, label: 'other-project-fw', tags: ['project:someone-else'] },
            ],
            page: 1,
            pages: 1,
          },
        }),
      },
    );

    expect(provider.deleteFirewallByName).toHaveBeenCalledTimes(1);
    expect(provider.deleteFirewallByName).toHaveBeenCalledWith('testapp-compose-1786199-ab12cd34');
    expect(counts.firewalls).toBe(1);
  });

  it('sweeps prefix-matching Object Storage buckets against their listed cluster', async () => {
    // Bucket enumeration is the Linode MANAGEMENT API (account ListBuckets
    // over S3 fails with SignatureDoesNotMatch on Linode RGW — live-probed
    // 2026-08-08 — while bucket-level S3 ops work), which reports each
    // bucket's assigned cluster.
    const emptyAndDeleteBucket = vi.fn().mockResolvedValue({ objectsRemoved: 3 });
    const storage = fakeStorage({
      listAllBuckets: vi.fn().mockResolvedValue([
        { name: 'testapp-l1-backups', cluster: 'us-iad-10' },
        { name: 'unrelated', cluster: 'us-iad-10' },
      ]),
      emptyAndDeleteBucket,
    });

    const { counts } = await sweepOrphanedLinodeResources(TAG, 'testapp-l1', {
      provider: fakeProvider(),
      objectStorage: storage,
      fetchImpl: fakeFetch({}),
    });

    expect(emptyAndDeleteBucket).toHaveBeenCalledTimes(1);
    expect(emptyAndDeleteBucket).toHaveBeenCalledWith('us-iad-10', 'testapp-l1-backups');
    expect(counts.s3Buckets).toBe(1);
  });

  it('marks enumeration incomplete (enumFailed) when a listing cannot be walked', async () => {
    const provider = fakeProvider({
      listServersDetailed: vi.fn().mockResolvedValue({ items: [], complete: false, status: 403 }),
    });

    const { enumFailed } = await sweepOrphanedLinodeResources(TAG, 'testapp-l1', {
      provider,
      objectStorage: fakeStorage(),
      fetchImpl: fakeFetch({}),
    });

    expect(enumFailed).toBe(true);
  });

  it('marks enumFailed when the bucket listing is unreadable', async () => {
    const storage = fakeStorage({
      listAllBuckets: vi.fn().mockResolvedValue(null),
    });

    const { enumFailed } = await sweepOrphanedLinodeResources(TAG, 'testapp-l1', {
      provider: fakeProvider(),
      objectStorage: storage,
      fetchImpl: fakeFetch({}),
    });

    expect(enumFailed).toBe(true);
  });

  it('pins the protected-bucket set empty — Linode has no subscription-anchor bucket', () => {
    expect([...PROTECTED_OBJECT_STORAGE_BUCKETS]).toEqual([]);
  });
});
