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
    deleteSSHKeyById: vi.fn().mockResolvedValue('deleted'),
    deleteLoadBalancer: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeSpaces(overrides: Partial<NonNullable<SpacesLike>> = {}): NonNullable<SpacesLike> {
  return {
    regions: () => ['nyc3', 'sfo3'],
    listBuckets: vi.fn().mockResolvedValue([]),
    emptyAndDeleteBucket: vi.fn().mockResolvedValue({ objectsRemoved: 0 }),
    locateBucket: vi.fn().mockResolvedValue(null),
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

/**
 * fetch stub for the DO tag API: the list, one tag's resource count, and
 * DELETE. Every call is logged so a test can check what ran and in what order.
 */
function doTagFetch(
  tags: Record<string, number>,
  log: string[],
  opts: { listStatus?: number } = {},
): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const one = u.pathname.match(/^\/v2\/tags\/(.+)$/);
    if (init?.method === 'DELETE') {
      if (one) log.push(`delete ${decodeURIComponent(one[1])}`);
      return { ok: true, status: 204, json: async () => ({}) };
    }
    if (one) {
      const name = decodeURIComponent(one[1]);
      log.push(`count ${name}`);
      return {
        ok: true,
        status: 200,
        json: async () => ({ tag: { name, resources: { count: tags[name] ?? 0 } } }),
      };
    }
    if (u.pathname === '/v2/tags') {
      const status = opts.listStatus ?? 200;
      return {
        ok: status < 400,
        status,
        json: async () => ({
          tags: Object.entries(tags).map(([name, count]) => ({ name, resources: { count } })),
          links: {},
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

const TAG = '[test]';

/** What the sweep's delete threw in run 43757126064 (real SDK shape). */
const STALE_LISTING_ERROR = Object.assign(new Error('UnknownError'), {
  name: 'NoSuchBucket',
  Code: 'NoSuchBucket',
  $metadata: { httpStatusCode: 404 },
});

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

  it('deletes prefix-matching firewalls via the provider name API and ssh-keys/vpcs/load-balancers by id', async () => {
    const provider = fakeProvider();
    const fetchImpl = fakeFetch({
      '/load_balancers': {
        load_balancers: [
          { id: 'lb1', name: 'testapp-d3-lb' },
          { id: 'lb2', name: 'other' },
        ],
      },
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
    expect(provider.deleteSSHKeyById).toHaveBeenCalledWith(9);
    expect(provider.deleteLoadBalancer).toHaveBeenCalledWith('lb1');
    expect(provider.deleteLoadBalancer).not.toHaveBeenCalledWith('lb2');
    expect(counts.firewalls).toBe(1);
    expect(counts.sshKeys).toBe(1);
    expect(counts.networks).toBe(1);
  });

  it('does not call a deleted key an orphan just because the list was stale', async () => {
    const provider = fakeProvider({ deleteSSHKeyById: vi.fn().mockResolvedValue('absent') });
    const { counts, enumFailed } = await sweepOrphanedDigitalOceanResources(TAG, 'testapp-d3', {
      provider,
      spaces: fakeSpaces(),
      fetchImpl: fakeFetch({ '/account/keys': { ssh_keys: [{ id: 9, name: 'testapp-d3-key' }] } }),
    });
    expect(provider.deleteSSHKeyById).toHaveBeenCalledWith(9);
    expect(counts.sshKeys).toBe(0);
    expect(enumFailed).toBe(false);
  });

  it('reports a key that will not go as an incomplete sweep', async () => {
    const provider = fakeProvider({ deleteSSHKeyById: vi.fn().mockResolvedValue('stuck') });
    const { counts, enumFailed } = await sweepOrphanedDigitalOceanResources(TAG, 'testapp-d3', {
      provider,
      spaces: fakeSpaces(),
      fetchImpl: fakeFetch({ '/account/keys': { ssh_keys: [{ id: 9, name: 'testapp-d3-key' }] } }),
    });
    expect(counts.sshKeys).toBe(0);
    expect(enumFailed).toBe(true);
  });

  it('sweeps prefix-matching Spaces buckets once across regions', async () => {
    const spaces = fakeSpaces({
      regions: () => ['nyc3', 'sfo3'],
      // The dedupe guard: a name in two regions' listings is deleted once.
      // (Live, each endpoint lists only its own region's buckets; probed
      // 2026-11-15.)
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

  it('a bucket destroy removed seconds earlier reads clean once no region holds it and a second listing has dropped it (run 43757126064)', async () => {
    // For 1-3 s after a delete, Spaces still lists the bucket and answers
    // ListObjectsV2 with a 404 NoSuchBucket whose message is empty, which the
    // SDK words "UnknownError" (shape pinned in bucket-already-gone.test.ts).
    const locateBucket = vi.fn().mockResolvedValue(null);
    const spaces = fakeSpaces({
      regions: () => ['nyc3'],
      listBuckets: vi.fn().mockResolvedValueOnce(['testapp-d3-backups']).mockResolvedValue([]),
      emptyAndDeleteBucket: vi.fn().mockRejectedValue(STALE_LISTING_ERROR),
      locateBucket,
    });
    const { counts, enumFailed } = await sweepOrphanedDigitalOceanResources(TAG, 'testapp-d3', {
      provider: fakeProvider(),
      spaces,
      fetchImpl: fakeFetch({}),
    });
    expect(locateBucket).toHaveBeenCalledWith('nyc3', 'testapp-d3-backups');
    // Read once to enumerate and once more after the search, never again.
    expect(spaces.listBuckets).toHaveBeenCalledTimes(2);
    expect(enumFailed).toBe(false);
    expect(counts.s3Buckets).toBe(0);
  });

  it('the 2026-11-16 leak: no such bucket and no region holds it, but the listing still shows it, so the sweep FAILS and never says gone', async () => {
    // A new Hetzner bucket answered this way for 20 minutes while it existed
    // and billed. The listing was the one answer that told the truth.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // For 1-3 s after a delete, Spaces still lists the bucket and answers
    // ListObjectsV2 with a 404 NoSuchBucket whose message is empty, which the
    // SDK words "UnknownError" (shape pinned in bucket-already-gone.test.ts).
    const locateBucket = vi.fn().mockResolvedValue(null);
    const spaces = fakeSpaces({
      regions: () => ['nyc3'],
      listBuckets: vi.fn().mockResolvedValue(['testapp-d3-backups']),
      emptyAndDeleteBucket: vi.fn().mockRejectedValue(STALE_LISTING_ERROR),
      locateBucket,
    });
    const { counts, enumFailed } = await sweepOrphanedDigitalOceanResources(TAG, 'testapp-d3', {
      provider: fakeProvider(),
      spaces,
      fetchImpl: fakeFetch({}),
    });
    expect(locateBucket).toHaveBeenCalledWith('nyc3', 'testapp-d3-backups');
    const said = (spy: typeof log) => spy.mock.calls.map((c) => String(c[0])).join('\n');
    const logged = said(log);
    const warned = said(warn);
    log.mockRestore();
    warn.mockRestore();
    expect(enumFailed).toBe(true);
    expect(counts.s3Buckets).toBe(0);
    expect(logged).not.toMatch(/already gone/);
    expect(warned).toMatch(/FAILED testapp-d3-backups: .*listing still shows it/);
    expect(spaces.listBuckets).toHaveBeenCalledTimes(2);
  });

  it('a NoSuchBucket for a bucket some region still holds FAILS the sweep', async () => {
    const spaces = fakeSpaces({
      regions: () => ['nyc3'],
      listBuckets: vi.fn().mockResolvedValue(['testapp-d3-backups']),
      emptyAndDeleteBucket: vi.fn().mockRejectedValue(STALE_LISTING_ERROR),
      locateBucket: vi.fn().mockResolvedValue('sfo3'),
    });
    const { enumFailed } = await sweepOrphanedDigitalOceanResources(TAG, 'testapp-d3', {
      provider: fakeProvider(),
      spaces,
      fetchImpl: fakeFetch({}),
    });
    expect(enumFailed).toBe(true);
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

  it("revokes this run's app storage keys (vc-app-<project>…) and leaves every other key", async () => {
    const fetchImpl = fakeFetch({
      '/spaces/keys': {
        keys: [
          { access_key: 'SENTINEL_AK_1', name: 'vc-app-testapp-d3-abc123-prod' },
          { access_key: 'SENTINEL_AK_2', name: 'vc-app-otherapp-prod' },
          { access_key: 'SENTINEL_AK_3', name: 'operator-spaces-key' },
        ],
      },
    });
    const { counts, enumFailed } = await sweepOrphanedDigitalOceanResources(TAG, 'testapp-d3', {
      provider: fakeProvider(),
      spaces: fakeSpaces(),
      fetchImpl,
    });
    const deletes = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')
      .map(([url]) => String(url));
    expect(deletes).toEqual(['https://api.digitalocean.com/v2/spaces/keys/SENTINEL_AK_1']);
    expect(counts.storageKeys).toBe(1);
    expect(enumFailed).toBe(false);
  });

  it("deletes the run's empty project tag once its droplets are gone, and no other tag", async () => {
    const log: string[] = [];
    const provider = fakeProvider({
      listServersDetailed: vi.fn().mockResolvedValue({
        items: [{ id: 1, name: 'testapp-d3-master' }],
        complete: true,
      }),
      deleteServer: vi.fn(async () => {
        log.push('deleteServer');
      }),
    });
    const fetchImpl = doTagFetch(
      {
        'project:testapp-d3': 0,
        'project:otherapp-d1': 0,
        // Pulumi owns the k8s cluster tag (digitalocean.Tag) and destroy
        // deletes it; a live deploy's can be empty before its droplets exist.
        'cluster:testapp-d3-d3': 0,
        'role:master': 0,
        'environment:d3': 0,
      },
      log,
    );
    const { enumFailed } = await sweepOrphanedDigitalOceanResources(TAG, 'testapp-d3', {
      provider,
      spaces: fakeSpaces(),
      fetchImpl,
    });
    expect(log).toEqual(['deleteServer', 'count project:testapp-d3', 'delete project:testapp-d3']);
    expect(enumFailed).toBe(false);
  });

  it('keeps a project tag that is still on a resource, and the sweep stays clean', async () => {
    const log: string[] = [];
    const { counts, enumFailed } = await sweepOrphanedDigitalOceanResources(TAG, 'testapp-d3', {
      provider: fakeProvider(),
      spaces: fakeSpaces(),
      fetchImpl: doTagFetch({ 'project:testapp-d3': 1 }, log),
    });
    expect(log).toEqual(['count project:testapp-d3']);
    expect(enumFailed).toBe(false);
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });

  it('an unreadable tag list is a warning, not a failed sweep (tags cost nothing)', async () => {
    const log: string[] = [];
    const { enumFailed } = await sweepOrphanedDigitalOceanResources(TAG, 'testapp-d3', {
      provider: fakeProvider(),
      spaces: fakeSpaces(),
      fetchImpl: doTagFetch({ 'project:testapp-d3': 0 }, log, { listStatus: 500 }),
    });
    expect(log).toEqual([]);
    expect(enumFailed).toBe(false);
  });
});
