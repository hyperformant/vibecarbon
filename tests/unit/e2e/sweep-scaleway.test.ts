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
 */
import { describe, expect, it, vi } from 'vitest';
import { ScalewayProvider } from '../../../src/lib/providers/scaleway.js';
import { ScalewayObjectStorageProvider } from '../../../src/lib/providers/scaleway-objectstorage.js';
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
    deleteFirewallByName: vi.fn().mockResolvedValue({ deleted: true, everExisted: true }),
    deleteSSHKeyByName: vi.fn().mockResolvedValue(true),
    listFlexibleIPsDetailed: vi.fn().mockResolvedValue({ items: [], complete: true }),
    releaseFlexibleIP: vi.fn().mockResolvedValue(true),
    listLoadBalancers: vi.fn().mockResolvedValue([]),
    deleteLoadBalancer: vi.fn().mockResolvedValue(true),
    listNetworks: vi.fn().mockResolvedValue([]),
    serverLabels: (s: { tags?: string[] }) =>
      Object.fromEntries((s.tags ?? []).map((t) => t.split(':') as [string, string])),
    ...overrides,
  };
}

function fakeStore(overrides: Partial<StoreLike> = {}): StoreLike {
  return {
    listBuckets: vi.fn().mockResolvedValue([]),
    emptyAndDeleteBucket: vi.fn().mockResolvedValue({ objectsRemoved: 0 }),
    ...overrides,
  };
}

function fakeStores(): NonNullable<StoresLike> {
  return { 'fr-par': fakeStore(), 'nl-ams': fakeStore() };
}

/** fetch stub for the security-group / ssh-key direct walks (Scaleway's
 * per-zone page/per_page envelope — a short page ends the walk). */
function fakeFetch(pages: Record<string, unknown>): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'DELETE') return { ok: true, status: 200, json: async () => ({}) };
    for (const [prefix, body] of Object.entries(pages)) {
      if (u.includes(prefix)) return { ok: true, status: 200, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

const TAG = '[test]';

describe('sweepOrphanedScalewayResources', () => {
  it('zone/region constants stay in lockstep with the live provider classes', () => {
    expect([...SWEEP_ZONES]).toEqual(Object.keys(ScalewayProvider.REGIONS));
    expect([...SWEEP_S3_REGIONS]).toEqual(Object.keys(ScalewayObjectStorageProvider.REGIONS));
  });

  it('refuses to sweep with an empty project name (an empty prefix matches everything)', async () => {
    await expect(
      sweepOrphanedScalewayResources(TAG, '', {
        provider: fakeProvider(),
        objectStorageByRegion: fakeStores(),
        fetchImpl: fakeFetch({}),
      }),
    ).rejects.toThrow(/project name/i);
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
    const { counts } = await sweepOrphanedScalewayResources(TAG, 'testapp-s1', {
      provider,
      objectStorageByRegion: fakeStores(),
      fetchImpl: fakeFetch({
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
      }),
    });

    expect(provider.deleteFirewallByName).toHaveBeenCalledTimes(1);
    expect(provider.deleteFirewallByName).toHaveBeenCalledWith('testapp-s1-prod-firewall');
    expect(counts.firewalls).toBe(1);
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
