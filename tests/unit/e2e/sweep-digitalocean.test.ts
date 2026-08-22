/**
 * DigitalOcean orphan sweep (2026-08-07 test-architecture audit).
 *
 * Until now the lifecycle teardown called the HETZNER sweep unconditionally
 * — after a d1/d2/d3 run it enumerated the wrong cloud, found nothing, and
 * printed "No orphans found — destroy worked cleanly" over any amount of
 * leaked DO residue. These tests pin the DO sweep's contract via injected
 * fakes: prefix scoping, the cross-run CSI-volume safety rule, name-based
 * deletes through the provider instance API, the Spaces sweep, and the
 * vc-local-e2e anchor-bucket guard (the deliberate subscription anchor that
 * must NEVER be swept — encoded here as a hard in-code exclusion, not an
 * accident of prefix scoping).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PROTECTED_SPACES_BUCKETS,
  sweepOrphanedDigitalOceanResources,
} from '../../e2e/utils/sweep-digitalocean.js';

type ProviderLike = Parameters<typeof sweepOrphanedDigitalOceanResources>[2]['provider'];
type SpacesLike = Parameters<typeof sweepOrphanedDigitalOceanResources>[2]['spaces'];

function fakeProvider(
  overrides: Partial<NonNullable<ProviderLike>> = {},
): NonNullable<ProviderLike> {
  return {
    listServersDetailed: vi.fn().mockResolvedValue({ items: [], complete: true }),
    deleteServer: vi.fn().mockResolvedValue(undefined),
    listVolumesDetailed: vi.fn().mockResolvedValue({ items: [], complete: true }),
    volumeAttachedServerIds: (v: { droplet_ids?: number[] }) => v.droplet_ids ?? [],
    volumeLabels: (v: { tags?: string[] }) =>
      Object.fromEntries((v.tags ?? []).map((t) => t.split(':') as [string, string])),
    deleteVolume: vi.fn().mockResolvedValue(undefined),
    deleteFirewallByName: vi.fn().mockResolvedValue({ deleted: true, everExisted: true }),
    deleteSSHKeyByName: vi.fn().mockResolvedValue(true),
    listLoadBalancers: vi.fn().mockResolvedValue([]),
    deleteLoadBalancer: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeSpaces(overrides: Partial<NonNullable<SpacesLike>> = {}): NonNullable<SpacesLike> {
  return {
    regions: () => ['nyc3', 'sfo3'],
    listBuckets: vi.fn().mockResolvedValue([]),
    emptyAndDeleteBucket: vi.fn().mockResolvedValue({ objectsRemoved: 0 }),
    ...overrides,
  };
}

/** fetch stub for the firewall / ssh-key / vpc enumeration walks. */
function fakeFetch(pages: Record<string, unknown>): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'DELETE') return { ok: true, status: 204, json: async () => ({}) };
    for (const [prefix, body] of Object.entries(pages)) {
      if (u.includes(prefix)) return { ok: true, status: 200, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

const TAG = '[test]';

describe('sweepOrphanedDigitalOceanResources', () => {
  it('refuses to sweep with an empty project name (an empty prefix matches everything)', async () => {
    await expect(
      sweepOrphanedDigitalOceanResources(TAG, '', {
        provider: fakeProvider(),
        spaces: fakeSpaces(),
        fetchImpl: fakeFetch({}),
      }),
    ).rejects.toThrow(/project name/i);
  });

  it('deletes prefix-matching droplets (settled) and leaves foreign ones', async () => {
    const provider = fakeProvider({
      listServersDetailed: vi.fn().mockResolvedValue({
        items: [
          { id: 1, name: 'testapp-d1-primary' },
          { id: 2, name: 'someone-elses-droplet' },
        ],
        complete: true,
      }),
    });
    const { counts, enumFailed } = await sweepOrphanedDigitalOceanResources(TAG, 'testapp-d1', {
      provider,
      spaces: fakeSpaces(),
      fetchImpl: fakeFetch({}),
    });
    expect(provider.deleteServer).toHaveBeenCalledTimes(1);
    expect(provider.deleteServer).toHaveBeenCalledWith(1, { waitUntilGone: true });
    expect(counts.servers).toBe(1);
    expect(enumFailed).toBe(false);
  });

  it('volume rule: deletes unattached project-named and project-tagged pvc volumes; skips attached and foreign pvc', async () => {
    const provider = fakeProvider({
      listVolumesDetailed: vi.fn().mockResolvedValue({
        items: [
          { id: 'v1', name: 'testapp-d3-data', droplet_ids: [] },
          { id: 'v2', name: 'pvc-1111', droplet_ids: [], tags: ['project:testapp-d3'] },
          { id: 'v3', name: 'pvc-2222', droplet_ids: [] }, // no project tag → NOT ours to delete
          { id: 'v4', name: 'testapp-d3-live', droplet_ids: [77] }, // attached → never
        ],
        complete: true,
      }),
    });
    const { counts } = await sweepOrphanedDigitalOceanResources(TAG, 'testapp-d3', {
      provider,
      spaces: fakeSpaces(),
      fetchImpl: fakeFetch({}),
    });
    expect(provider.deleteVolume).toHaveBeenCalledWith('v1');
    expect(provider.deleteVolume).toHaveBeenCalledWith('v2');
    expect(provider.deleteVolume).not.toHaveBeenCalledWith('v3');
    expect(provider.deleteVolume).not.toHaveBeenCalledWith('v4');
    expect(counts.volumes).toBe(2);
  });

  it('deletes prefix-matching firewalls/ssh-keys via the provider name API and vpcs/load-balancers by id', async () => {
    const provider = fakeProvider({
      listLoadBalancers: vi.fn().mockResolvedValue([
        { id: 'lb1', name: 'testapp-d3-lb' },
        { id: 'lb2', name: 'other' },
      ]),
    });
    const fetchImpl = fakeFetch({
      '/firewalls': {
        firewalls: [
          { id: 'f1', name: 'testapp-d3-fw' },
          { id: 'f2', name: 'other-fw' },
        ],
      },
      '/account/keys': { ssh_keys: [{ id: 9, name: 'testapp-d3-nyc3-key' }] },
      '/vpcs': {
        vpcs: [
          { id: 'net1', name: 'testapp-d3-network' },
          { id: 'net2', name: 'default-nyc3' },
        ],
      },
    });
    const { counts } = await sweepOrphanedDigitalOceanResources(TAG, 'testapp-d3', {
      provider,
      spaces: fakeSpaces(),
      fetchImpl,
    });
    expect(provider.deleteFirewallByName).toHaveBeenCalledWith('testapp-d3-fw');
    expect(provider.deleteFirewallByName).not.toHaveBeenCalledWith('other-fw');
    expect(provider.deleteSSHKeyByName).toHaveBeenCalledWith('testapp-d3-nyc3-key');
    expect(provider.deleteLoadBalancer).toHaveBeenCalledWith('lb1');
    expect(provider.deleteLoadBalancer).not.toHaveBeenCalledWith('lb2');
    expect(counts.firewalls).toBe(1);
    expect(counts.sshKeys).toBe(1);
    expect(counts.networks).toBe(1);
  });

  it('sweeps prefix-matching Spaces buckets once across regions', async () => {
    const spaces = fakeSpaces({
      regions: () => ['nyc3', 'sfo3'],
      // The same bucket shows up in both regions' listings (DO ListBuckets is
      // account-wide) — it must be deleted exactly once.
      listBuckets: vi.fn().mockResolvedValue(['testapp-d3-backups', 'unrelated-bucket']),
      emptyAndDeleteBucket: vi.fn().mockResolvedValue({ objectsRemoved: 3 }),
    });
    const { counts } = await sweepOrphanedDigitalOceanResources(TAG, 'testapp-d3', {
      provider: fakeProvider(),
      spaces,
      fetchImpl: fakeFetch({}),
    });
    expect(spaces.emptyAndDeleteBucket).toHaveBeenCalledTimes(1);
    expect(counts.s3Buckets).toBe(1);
  });

  it('NEVER deletes the vc-local-e2e anchor Space, even when the prefix matches', async () => {
    expect(PROTECTED_SPACES_BUCKETS.has('vc-local-e2e')).toBe(true);
    const spaces = fakeSpaces({
      listBuckets: vi.fn().mockResolvedValue(['vc-local-e2e', 'vc-local-scratch']),
      emptyAndDeleteBucket: vi.fn().mockResolvedValue({ objectsRemoved: 0 }),
    });
    const { counts } = await sweepOrphanedDigitalOceanResources(TAG, 'vc-local', {
      provider: fakeProvider(),
      spaces,
      fetchImpl: fakeFetch({}),
    });
    expect(spaces.emptyAndDeleteBucket).not.toHaveBeenCalledWith(expect.anything(), 'vc-local-e2e');
    expect(spaces.emptyAndDeleteBucket).toHaveBeenCalledWith(expect.anything(), 'vc-local-scratch');
    expect(counts.s3Buckets).toBe(1);
  });

  it('an incomplete droplet listing flips enumFailed instead of posing as clean', async () => {
    const provider = fakeProvider({
      listServersDetailed: vi.fn().mockResolvedValue({ items: [], complete: false }),
    });
    const { counts, enumFailed } = await sweepOrphanedDigitalOceanResources(TAG, 'testapp-d1', {
      provider,
      spaces: fakeSpaces(),
      fetchImpl: fakeFetch({}),
    });
    expect(enumFailed).toBe(true);
    expect(counts.servers).toBe(0);
  });

  it('an unreadable Spaces region flips enumFailed', async () => {
    const spaces = fakeSpaces({
      listBuckets: vi.fn().mockResolvedValue(null),
    });
    const { enumFailed } = await sweepOrphanedDigitalOceanResources(TAG, 'testapp-d1', {
      provider: fakeProvider(),
      spaces,
      fetchImpl: fakeFetch({}),
    });
    expect(enumFailed).toBe(true);
  });
});
