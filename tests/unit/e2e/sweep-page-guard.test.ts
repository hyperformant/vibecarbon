/**
 * A listing that runs into the sweeps' 20-page guard is an INCOMPLETE
 * listing. The DigitalOcean, Linode and Vultr walkers used to return
 * `complete: true` there, and three hand-rolled loops (DigitalOcean and
 * Linode reserved IPs, the Linode bucket listing) simply stopped, so residue
 * past the guard was unseen and the sweep still printed "No orphans found".
 * Scaleway's walker and every product walker already answered `false`.
 *
 * Each test serves one listing as a chain that never ends and every other
 * listing as one final page, so the incomplete mark can only come from the
 * loop under test.
 */
import { describe, expect, it, vi } from 'vitest';
import { sweepOrphanedDigitalOceanResources } from '../../e2e/utils/sweep-digitalocean.js';
import { sweepOrphanedLinodeResources } from '../../e2e/utils/sweep-linode.js';
import { sweepOrphanedVultrResources } from '../../e2e/utils/sweep-vultr.js';

const TAG = '[test]';
const PROJECT = 'testapp-guard';

type Json = Record<string, unknown>;

/**
 * `endless(url)` returns the page body for a listing that always has a next
 * page; every other URL gets `lastPage`. Returns the URLs asked for.
 */
function chainFetch(isEndless: (url: string) => boolean, endlessPage: Json, lastPage: Json) {
  const urls: string[] = [];
  const impl = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    urls.push(u);
    return { ok: true, status: 200, json: async () => (isEndless(u) ? endlessPage : lastPage) };
  }) as unknown as typeof fetch;
  return { impl, urls };
}

function warnings(): { text: () => string; restore: () => void } {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  return {
    text: () => warn.mock.calls.flat().join('\n'),
    restore: () => {
      warn.mockRestore();
      log.mockRestore();
    },
  };
}

const baseProvider = {
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
  deleteLoadBalancer: vi.fn().mockResolvedValue(true),
};

const emptySpaces = {
  regions: () => [],
  listBuckets: vi.fn().mockResolvedValue([]),
  emptyAndDeleteBucket: vi.fn().mockResolvedValue({ objectsRemoved: 0 }),
  locateBucket: vi.fn().mockResolvedValue(null),
};

describe('DigitalOcean sweep: the 20-page guard', () => {
  const run = async (isEndless: (url: string) => boolean) => {
    const out = warnings();
    const { impl, urls } = chainFetch(
      isEndless,
      { links: { pages: { next: 'https://api.digitalocean.com/v2/next' } } },
      {},
    );
    const result = await sweepOrphanedDigitalOceanResources(TAG, PROJECT, {
      provider: baseProvider,
      spaces: emptySpaces,
      fetchImpl: impl,
    });
    const text = out.text();
    out.restore();
    return { ...result, text, urls };
  };

  it('a firewall listing that never ends is incomplete, not clean', async () => {
    const { enumFailed, text, urls } = await run((u) => u.includes('/v2/firewalls'));
    expect(urls.filter((u) => u.includes('/v2/firewalls'))).toHaveLength(20);
    expect(enumFailed).toBe(true);
    expect(text).toContain('firewall list enumeration incomplete');
    expect(text).not.toContain('No DigitalOcean orphans found');
  });

  it('a reserved-IP listing that never ends is incomplete, not clean', async () => {
    const { enumFailed, text } = await run(
      (u) => u.includes('/reserved_ips') || u.endsWith('/v2/next'),
    );
    expect(enumFailed).toBe(true);
    expect(text).toContain('reserved-ip list enumeration incomplete');
  });

  it('a listing that ends inside the guard stays clean', async () => {
    const { enumFailed } = await run(() => false);
    expect(enumFailed).toBe(false);
  });
});

describe('Linode sweep: the 20-page guard', () => {
  const run = async (
    isEndless: (url: string) => boolean,
    deps: Partial<Parameters<typeof sweepOrphanedLinodeResources>[2]> = {},
  ) => {
    const out = warnings();
    const { impl, urls } = chainFetch(
      isEndless,
      { data: [], page: 1, pages: 999 },
      { data: [], page: 1, pages: 1 },
    );
    const result = await sweepOrphanedLinodeResources(TAG, PROJECT, {
      provider: baseProvider,
      objectStorage: {
        listAllBuckets: vi.fn().mockResolvedValue([]),
        emptyAndDeleteBucket: vi.fn().mockResolvedValue({ objectsRemoved: 0 }),
        locateBucket: vi.fn().mockResolvedValue(null),
      },
      fetchImpl: impl,
      ...deps,
    });
    const text = out.text();
    out.restore();
    return { ...result, text, urls };
  };

  it('a firewall listing that never ends is incomplete, not clean', async () => {
    const { enumFailed, text, urls } = await run((u) => u.includes('/networking/firewalls'));
    expect(urls.filter((u) => u.includes('/networking/firewalls'))).toHaveLength(20);
    expect(enumFailed).toBe(true);
    expect(text).toContain('firewall list enumeration incomplete');
  });

  it('a reserved-IP listing that never ends is incomplete, not clean', async () => {
    const { enumFailed, text } = await run((u) => u.includes('/networking/ips'));
    expect(enumFailed).toBe(true);
    expect(text).toContain('reserved-ip list enumeration incomplete');
  });

  it('a bucket listing that never ends is unreadable, not an empty account', async () => {
    const { enumFailed, text } = await run((u) => u.includes('/object-storage/buckets'), {
      objectStorage: undefined,
      token: 'fake-token',
      storageKey: 'fake-key',
      storageSecret: 'fake-secret',
    });
    expect(enumFailed).toBe(true);
    expect(text).toContain('Object Storage bucket list enumeration incomplete');
  });

  it('a listing that ends inside the guard stays clean', async () => {
    const { enumFailed } = await run(() => false);
    expect(enumFailed).toBe(false);
  });
});

describe('Vultr sweep: the 20-page guard', () => {
  const run = async (isEndless: (url: string) => boolean) => {
    const out = warnings();
    const { impl, urls } = chainFetch(
      isEndless,
      { meta: { links: { next: 'more' } } },
      { meta: { links: { next: '' } } },
    );
    const result = await sweepOrphanedVultrResources(TAG, PROJECT, {
      provider: baseProvider,
      objectStorage: {
        listBuckets: vi.fn().mockResolvedValue([]),
        emptyAndDeleteBucket: vi.fn().mockResolvedValue({ objectsRemoved: 0 }),
        locateBucket: vi.fn().mockResolvedValue(null),
      },
      fetchImpl: impl,
    });
    const text = out.text();
    out.restore();
    return { ...result, text, urls };
  };

  it('a firewall listing that never ends is incomplete, not clean', async () => {
    const { enumFailed, text, urls } = await run((u) => u.includes('/v2/firewalls'));
    expect(urls.filter((u) => u.includes('/v2/firewalls'))).toHaveLength(20);
    expect(enumFailed).toBe(true);
    expect(text).toContain('firewall list enumeration incomplete');
  });

  it('a listing that ends inside the guard stays clean', async () => {
    const { enumFailed } = await run(() => false);
    expect(enumFailed).toBe(false);
  });
});
