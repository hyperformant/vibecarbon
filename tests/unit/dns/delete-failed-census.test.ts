/**
 * A record delete the DNS API refuses is counted, per backend.
 *
 * Every backend used to count a successful delete and nothing else, so a
 * refused one (a 403 from a token without write scope, a 5xx that outlived
 * its retries) was neither deleted, skipped nor failed, and destroy printed
 * "DNS records not found" over a record still pointing at an address it was
 * releasing. Now each backend's `deleteApexAndWildcard` returns `failed`: one
 * entry per record the API refused, by fully qualified name, target and
 * status, which destroy reports as a leak. A 404 means the record is already
 * gone, which is no failure.
 *
 * The table is keyed by DNS_PROVIDERS, so a new backend fails the census
 * until it says how its fake API answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DNS_PROVIDERS } from '../../../src/lib/dns-provider.js';

vi.mock('../../../src/lib/cli/progress.js', () => ({
  spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
  progressLog: () => {},
}));

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const OURS = '203.0.113.9';
const DOMAIN = 'example.com';
type Which = 'apex' | 'wildcard';

type Row = {
  zoneId: string;
  /** The body a GET answers, or undefined for a 404. */
  list: (url: string) => unknown;
  /** Which record a mutating call removes, or null when it removes none. */
  removes: (url: string, body: string) => Which | null;
};

const rows: Record<string, Row> = {
  cloudflare: {
    zoneId: 'zone',
    list: (url) => {
      const name = decodeURIComponent(url.match(/[?&]name=([^&]+)/)?.[1] ?? '');
      const id = name.startsWith('*.') ? 'w' : 'a';
      return { success: true, result: [{ id, name, type: 'A', content: OURS }] };
    },
    removes: (url) =>
      (({ a: 'apex', w: 'wildcard' }) as const)[url.split('/dns_records/')[1]] ?? null,
  },
  hetzner: {
    zoneId: 'z1',
    list: (url) =>
      url.includes('/rrsets')
        ? {
            rrsets: [
              { name: '@', type: 'A', records: [{ value: OURS }] },
              { name: '*', type: 'A', records: [{ value: OURS }] },
            ],
            meta: { pagination: {} },
          }
        : { zone: { id: 'z1', name: DOMAIN } },
    removes: (url) =>
      (({ '@': 'apex', '*': 'wildcard' }) as const)[
        url.match(/\/rrsets\/([^/]+)\/A$/)?.[1] ?? ''
      ] ?? null,
  },
  digitalocean: {
    zoneId: DOMAIN,
    list: () => ({
      domain_records: [
        { id: 1, type: 'A', name: '@', data: OURS },
        { id: 2, type: 'A', name: '*', data: OURS },
      ],
      links: {},
    }),
    removes: (url) =>
      (({ 1: 'apex', 2: 'wildcard' }) as const)[Number(url.split('/records/')[1])] ?? null,
  },
  linode: {
    zoneId: '42',
    list: (url) =>
      url.includes('/records')
        ? {
            data: [
              { id: 1, type: 'A', name: '', target: OURS },
              { id: 2, type: 'A', name: '*', target: OURS },
            ],
            pages: 1,
          }
        : { domain: DOMAIN },
    removes: (url) =>
      (({ 1: 'apex', 2: 'wildcard' }) as const)[Number(url.split('/records/')[1])] ?? null,
  },
  scaleway: {
    zoneId: DOMAIN,
    list: () => ({
      records: [
        { id: '1', type: 'A', name: '', data: OURS },
        { id: '2', type: 'A', name: '*', data: OURS },
      ],
    }),
    // One PATCH per name, carrying a delete change per doomed record.
    removes: (_url, body) => {
      const ids = (JSON.parse(body).changes as Array<{ delete?: { id: string } }>).map(
        (c) => c.delete?.id,
      );
      return ids.includes('2') ? 'wildcard' : ids.includes('1') ? 'apex' : null;
    },
  },
  vultr: {
    zoneId: DOMAIN,
    list: () => ({
      records: [
        { id: '1', type: 'A', name: '', data: OURS },
        { id: '2', type: 'A', name: '*', data: OURS },
      ],
      meta: { links: { next: '' } },
    }),
    removes: (url) =>
      (({ 1: 'apex', 2: 'wildcard' }) as const)[Number(url.split('/records/')[1])] ?? null,
  },
};

/** Serve `row`'s zone; a mutating call answers `status[which]` (204 by default). */
function serve(row: Row, status: Partial<Record<Which, number>>) {
  const removed: Which[] = [];
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      const body = row.list(String(url));
      return body === undefined
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 });
    }
    const which = row.removes(String(url), String(init?.body ?? '{}'));
    if (!which) throw new Error(`unexpected ${method} ${url}`);
    const code = status[which] ?? 204;
    if (code < 300) removed.push(which);
    return new Response(code === 204 ? null : JSON.stringify({ message: 'refused' }), {
      status: code,
    });
  });
  return removed;
}

const census = (registered: string[], covered: string[]) => ({
  missing: registered.filter((id) => !covered.includes(id)),
  stale: covered.filter((id) => !registered.includes(id)),
});

describe('deleteApexAndWildcard failed census', () => {
  it('covers every DNS_PROVIDERS backend, and nothing else', () => {
    expect(census(Object.keys(DNS_PROVIDERS), Object.keys(rows))).toEqual({
      missing: [],
      stale: [],
    });
  });

  it('bites: a backend registered without a row is named', () => {
    expect(census([...Object.keys(DNS_PROVIDERS), 'newdns'], Object.keys(rows)).missing).toEqual([
      'newdns',
    ]);
  });
});

for (const [id, provider] of Object.entries(DNS_PROVIDERS)) {
  const row = rows[id];
  if (!row) continue;
  const load = async () =>
    (await import(`../../../src/lib/${provider.modulePath.replace(/^\.\//, '')}`)) as {
      deleteApexAndWildcard: (
        t: string,
        z: string,
        d: string,
        owned: string[],
      ) => Promise<{
        deletedAny: boolean;
        preservedTargets: string[];
        failed: Array<{ name: string; target: string; reason: string }>;
      }>;
    };

  describe(`${id}: deleteApexAndWildcard`, () => {
    it('a refused delete is counted as failed, by name, target and status', async () => {
      const removed = serve(row, { wildcard: 403 });
      const out = await (await load()).deleteApexAndWildcard('t', row.zoneId, DOMAIN, [OURS]);
      expect(removed).toEqual(['apex']);
      expect(out.deletedAny).toBe(true);
      expect(out.preservedTargets).toEqual([]);
      expect(out.failed).toEqual([
        { name: `*.${DOMAIN}`, target: OURS, reason: expect.stringContaining('403') },
      ]);
    });

    it('both refused: nothing deleted, both named', async () => {
      serve(row, { apex: 403, wildcard: 403 });
      const out = await (await load()).deleteApexAndWildcard('t', row.zoneId, DOMAIN, [OURS]);
      expect(out.deletedAny).toBe(false);
      expect(out.failed.map((f) => f.name).sort()).toEqual([`*.${DOMAIN}`, DOMAIN]);
    });

    it('a 404 is a record already gone, not a failure', async () => {
      serve(row, { apex: 404, wildcard: 404 });
      const out = await (await load()).deleteApexAndWildcard('t', row.zoneId, DOMAIN, [OURS]);
      expect(out).toEqual({ deletedAny: false, preservedTargets: [], failed: [] });
    });

    it('a clean delete fails nothing', async () => {
      const removed = serve(row, {});
      const out = await (await load()).deleteApexAndWildcard('t', row.zoneId, DOMAIN, [OURS]);
      expect(removed.sort()).toEqual(['apex', 'wildcard']);
      expect(out).toEqual({ deletedAny: true, preservedTargets: [], failed: [] });
    });
  });
}
