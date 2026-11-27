/**
 * The reserved-IP passes of the DigitalOcean and Linode sweeps.
 *
 * A reserved IP bills while unassigned and outlives the server it was on, so
 * these passes are the only thing that looks for one after a failed destroy.
 * Until this file they were pinned by source text only
 * (sweep-reserved-ip-coverage.test.ts); these tests run them.
 *
 * DigitalOcean and Linode cannot attribute an unassigned reserved IP, so
 * they delete nothing, report it and mark the sweep incomplete. Vultr makes
 * no reserved IP, and its sweep never asks for one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sweepOrphanedDigitalOceanResources } from '../../e2e/utils/sweep-digitalocean.js';
import { sweepOrphanedLinodeResources } from '../../e2e/utils/sweep-linode.js';
import { sweepOrphanedVultrResources } from '../../e2e/utils/sweep-vultr.js';

const TAG = '[test]';
const PROJECT = 'testapp-rip';

type Json = Record<string, unknown>;

const provider = {
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

const noBuckets = {
  regions: () => [],
  listBuckets: vi.fn().mockResolvedValue([]),
  listAllBuckets: vi.fn().mockResolvedValue([]),
  emptyAndDeleteBucket: vi.fn().mockResolvedValue({ objectsRemoved: 0 }),
  locateBucket: vi.fn().mockResolvedValue(null),
};

interface Served {
  /** The reserved-IP listing: a body, an HTTP status to fail with, or 'throw'. */
  listing: Json | number | 'throw';
  /** Status for a DELETE of a reserved IP; default 204. */
  deleteStatus?: number;
}

/** Serves `listing` on `listPath`; every other listing gets `empty`. */
function fakeApi(listPath: string, empty: Json, served: Served) {
  const deleted: string[] = [];
  const impl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === 'DELETE') {
      deleted.push(path);
      const status = served.deleteStatus ?? 204;
      return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
    }
    if (path === listPath) {
      if (served.listing === 'throw') throw new Error('connect ETIMEDOUT');
      if (typeof served.listing === 'number') {
        return { ok: false, status: served.listing, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => served.listing };
    }
    return { ok: true, status: 200, json: async () => empty };
  }) as unknown as typeof fetch;
  return { impl, deleted };
}

function capture() {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  return {
    warned: () => warn.mock.calls.map((c) => String(c[0])).join('\n'),
    logged: () => log.mock.calls.map((c) => String(c[0])).join('\n'),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Vultr sweep: no reserved IPs', () => {
  it('never lists reserved IPs, and reads clean without them', async () => {
    const out = capture();
    const api = fakeApi('/v2/reserved-ips', { meta: { links: { next: '' } } }, { listing: 503 });
    const { counts, enumFailed } = await sweepOrphanedVultrResources(TAG, PROJECT, {
      provider,
      objectStorage: noBuckets,
      fetchImpl: api.impl,
    });
    const asked = (api.impl as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      ([url]) => new URL(String(url)).pathname,
    );
    expect(asked).not.toContain('/v2/reserved-ips');
    expect(counts.floatingIps).toBe(0);
    expect(enumFailed).toBe(false);
    expect(out.logged()).toContain('No Vultr orphans found');
    expect(out.warned()).not.toContain('reserved-ip');
  });
});

describe('DigitalOcean sweep: reserved IPs (reported, never deleted)', () => {
  const run = async (served: Served) => {
    const out = capture();
    const api = fakeApi('/v2/reserved_ips', {}, served);
    const result = await sweepOrphanedDigitalOceanResources(TAG, PROJECT, {
      provider,
      spaces: noBuckets,
      fetchImpl: api.impl,
    });
    return { ...result, deleted: api.deleted, warned: out.warned(), logged: out.logged() };
  };

  it('an unassigned reserved IP is reported, not deleted, and marks the sweep incomplete', async () => {
    const { counts, enumFailed, deleted, warned } = await run({
      listing: {
        reserved_ips: [
          { ip: '203.0.113.7', droplet: null },
          { ip: '203.0.113.8', droplet: { id: 42 } },
        ],
      },
    });
    expect(deleted).toEqual([]);
    expect(counts.floatingIps).toBe(0);
    expect(enumFailed).toBe(true);
    expect(warned).toContain('UNASSIGNED reserved IP 203.0.113.7');
    expect(warned).not.toContain('203.0.113.8');
    expect(warned).toContain('unassigned reserved IPs present enumeration incomplete');
  });

  it('reserved IPs that are all assigned read clean', async () => {
    const { enumFailed, logged } = await run({
      listing: { reserved_ips: [{ ip: '203.0.113.8', droplet: { id: 42 } }] },
    });
    expect(enumFailed).toBe(false);
    expect(logged).toContain('No DigitalOcean orphans found');
  });

  it('an unreadable listing marks the sweep incomplete', async () => {
    const { enumFailed, warned } = await run({ listing: 500 });
    expect(enumFailed).toBe(true);
    expect(warned).toContain('reserved-ip list enumeration incomplete');
  });

  it('a listing that throws marks the sweep incomplete', async () => {
    const { enumFailed, warned } = await run({ listing: 'throw' });
    expect(enumFailed).toBe(true);
    expect(warned).toContain('reserved-ip list enumeration incomplete');
    expect(warned).toContain('connect ETIMEDOUT');
  });
});

describe('Linode sweep: reserved IPs (reported, never deleted)', () => {
  const linodeEmpty = { data: [], page: 1, pages: 1 };
  const run = async (served: Served) => {
    const out = capture();
    const api = fakeApi('/v4/networking/ips', linodeEmpty, served);
    const result = await sweepOrphanedLinodeResources(TAG, PROJECT, {
      provider,
      objectStorage: noBuckets,
      fetchImpl: api.impl,
    });
    return { ...result, deleted: api.deleted, warned: out.warned(), logged: out.logged() };
  };

  it('a reserved address on no instance is reported, not deleted, and marks the sweep incomplete', async () => {
    const { counts, enumFailed, deleted, warned } = await run({
      listing: {
        data: [
          { address: '203.0.113.7', reserved: true, linode_id: null },
          { address: '203.0.113.8', reserved: true, linode_id: 99 },
          { address: '203.0.113.9', reserved: false, linode_id: null },
        ],
        page: 1,
        pages: 1,
      },
    });
    expect(deleted).toEqual([]);
    expect(counts.floatingIps).toBe(0);
    expect(enumFailed).toBe(true);
    expect(warned).toContain('UNASSIGNED reserved IP 203.0.113.7');
    expect(warned).not.toContain('203.0.113.8');
    expect(warned).not.toContain('203.0.113.9');
  });

  it('reserved addresses that are all assigned read clean', async () => {
    const { enumFailed, logged } = await run({
      listing: {
        data: [{ address: '203.0.113.8', reserved: true, linode_id: 99 }],
        page: 1,
        pages: 1,
      },
    });
    expect(enumFailed).toBe(false);
    expect(logged).toContain('No Linode orphans found');
  });

  it('an unreadable listing marks the sweep incomplete', async () => {
    const { enumFailed, warned } = await run({ listing: 500 });
    expect(enumFailed).toBe(true);
    expect(warned).toContain('reserved-ip list enumeration incomplete');
  });

  it('a listing that throws marks the sweep incomplete', async () => {
    const { enumFailed, warned } = await run({ listing: 'throw' });
    expect(enumFailed).toBe(true);
    expect(warned).toContain('reserved-ip list enumeration incomplete');
  });
});
