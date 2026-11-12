/**
 * findARecordsAt, per backend: every A record in the zone whose value is the
 * address, by fully qualified name. The deploy asks it before it releases a
 * DigitalOcean k8s cluster's retired reserved IP
 * (lib/deploy/k8s/retired-reserved-ip.js), so a record the user added beside
 * the apex and the wildcard keeps the address until it moves. Each backend
 * reads its own wire shape: the apex spelling, relative and absolute names,
 * an rrset holding the address among others, and records of other types or
 * at other addresses that must not count.
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

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const OLD = '203.0.113.9';
const NEW = '198.51.100.7';
const FOUND = ['example.com', 'legacy.example.com'];

/** Route by URL substring: first matching key wins. */
function route(table: Record<string, unknown>) {
  fetchMock.mockImplementation(async (url: string) => {
    for (const [needle, body] of Object.entries(table)) {
      if (String(url).includes(needle)) return ok(body);
    }
    return new Response('{}', { status: 404 });
  });
}

const cases: Array<{ file: string; zoneId: string; routes: Record<string, unknown> }> = [
  {
    file: 'vultr-dns.js',
    zoneId: 'example.com',
    routes: {
      '/records': {
        records: [
          { id: '1', type: 'A', name: '', data: OLD },
          { id: '2', type: 'A', name: '*', data: NEW },
          { id: '3', type: 'A', name: 'legacy.example.com', data: OLD },
          { id: '4', type: 'CNAME', name: 'www', data: OLD },
          { id: '5', type: 'A', name: 'other', data: NEW },
        ],
        meta: { links: { next: '' } },
      },
    },
  },
  {
    file: 'digitalocean-dns.js',
    zoneId: 'example.com',
    routes: {
      '/records': {
        domain_records: [
          { id: 1, type: 'A', name: '@', data: OLD },
          { id: 2, type: 'A', name: '*', data: NEW },
          { id: 3, type: 'A', name: 'legacy', data: OLD },
          { id: 4, type: 'TXT', name: 'note', data: OLD },
        ],
        links: {},
      },
    },
  },
  {
    file: 'linode-dns.js',
    zoneId: '42',
    routes: {
      '/domains/42/records': {
        data: [
          { id: 1, type: 'A', name: '', target: OLD },
          { id: 2, type: 'A', name: '*', target: NEW },
          { id: 3, type: 'A', name: 'legacy', target: OLD },
          { id: 4, type: 'AAAA', name: 'legacy', target: '2001:db8::1' },
        ],
        pages: 1,
      },
      '/domains/42': { domain: 'example.com' },
    },
  },
  {
    file: 'scaleway-dns.js',
    zoneId: 'example.com',
    routes: {
      '/records': {
        records: [
          { id: '1', type: 'A', name: '', data: OLD },
          { id: '2', type: 'A', name: '*', data: NEW },
          { id: '3', type: 'A', name: 'legacy', data: OLD },
        ],
      },
    },
  },
  {
    file: 'hetzner-dns.js',
    zoneId: 'z1',
    routes: {
      '/rrsets': {
        rrsets: [
          { name: '@', type: 'A', records: [{ value: NEW }, { value: OLD }] },
          { name: '*', type: 'A', records: [{ value: NEW }] },
          { name: 'legacy', type: 'A', records: [{ value: OLD }] },
          { name: 'mail', type: 'MX', records: [{ value: OLD }] },
        ],
        meta: { pagination: {} },
      },
      '/zones/z1': { zone: { id: 'z1', name: 'example.com' } },
    },
  },
  {
    file: 'cloudflare-dns.js',
    zoneId: 'zone',
    routes: {
      '/dns_records': {
        success: true,
        result: [
          // Proxied (the orange cloud): the address is the origin, so it counts.
          { name: 'example.com', type: 'A', content: OLD, proxied: true },
          { name: '*.example.com', type: 'A', content: NEW },
          { name: 'legacy.example.com', type: 'A', content: OLD },
        ],
        result_info: { page: 1, total_pages: 1 },
      },
    },
  },
];

describe('findARecordsAt', () => {
  for (const { file, zoneId, routes } of cases) {
    it(`${file}: names every A record at the address, fully qualified, and nothing else`, async () => {
      route(routes);
      const mod = await import(`../../../src/lib/${file}`);
      await expect(mod.findARecordsAt('t', zoneId, OLD)).resolves.toEqual(FOUND);
      await expect(mod.findARecordsAt('t', zoneId, '192.0.2.1')).resolves.toEqual([]);
    });

    it(`${file}: a zone it cannot list throws, never reads as empty`, async () => {
      // 403, not a 5xx: fetchWithRetry retries those with a backoff.
      fetchMock.mockImplementation(
        async () => new Response(JSON.stringify({ message: 'forbidden' }), { status: 403 }),
      );
      const mod = await import(`../../../src/lib/${file}`);
      await expect(mod.findARecordsAt('t', zoneId, OLD)).rejects.toThrow();
    });
  }

  it('cloudflare-dns.js: deleteDNSRecord throws on a listing it cannot read, never reads it as empty', async () => {
    // Read as empty, a failed listing answered total 0 and destroy reported
    // the records gone while they still pointed at a released address.
    const mod = await import('../../../src/lib/cloudflare-dns.js');
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ success: false, errors: [] }), { status: 403 }),
    );
    await expect(mod.deleteDNSRecord('t', 'zone', 'example.com', [OLD])).rejects.toThrow(
      /HTTP 403/,
    );
    route({ '/dns_records': { success: false, errors: [{ message: 'Authentication error' }] } });
    await expect(mod.deleteDNSRecord('t', 'zone', 'example.com', [OLD])).rejects.toThrow(
      /Authentication error/,
    );
  });

  it('cloudflare-dns.js: reads every page, not just the first', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page'));
      expect(new URL(url).searchParams.get('type')).toBe('A');
      return ok({
        success: true,
        result:
          page === 1
            ? [{ name: 'example.com', type: 'A', content: NEW }]
            : [{ name: 'late.example.com', type: 'A', content: OLD }],
        result_info: { page, total_pages: 2 },
      });
    });
    const mod = await import('../../../src/lib/cloudflare-dns.js');
    await expect(mod.findARecordsAt('t', 'zone', OLD)).resolves.toEqual(['late.example.com']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cloudflare-dns.js: a 200 that says success false throws', async () => {
    route({ '/dns_records': { success: false, errors: [{ message: 'Authentication error' }] } });
    const mod = await import('../../../src/lib/cloudflare-dns.js');
    await expect(mod.findARecordsAt('t', 'zone', OLD)).rejects.toThrow(/Authentication error/);
  });
});

/**
 * Every registered DNS backend's zone walks, read past their page guard.
 *
 * Each backend walks its zone's records page by page, and most stop at a
 * page guard. A zone longer than that is not read in full, and a partial
 * read that misses the record is a false answer: findARecordsAt says no
 * record is left at the old address and the release goes ahead, and
 * deleteDNSRecord says total 0 and destroy reports the record gone while it
 * still points at an address being released. Past the guard both throw.
 *
 * The table is keyed by DNS_PROVIDERS, so a new backend fails the census
 * until it says how it pages (or why it has no guard).
 */
describe('zone walks past the page guard, per registered DNS backend', () => {
  type Ops = 'findARecordsAt' | 'deleteDNSRecord';
  type Walk = {
    zoneId: string;
    /** Pages the walk reads before it stops; null: no guard, it reads to the end. */
    guardPages: number | null;
    /** Record reads a walk past the guard makes before it throws (default guardPages). */
    readsPastGuard?: number;
    /** A zone of `last` pages (Infinity: endless), its record at OLD on the last page. */
    page: (n: number, last: number) => unknown;
    /** Ops that do not walk the zone, and why. */
    notWalked?: Partial<Record<Ops, string>>;
  };
  const rows = (n: number, last: number, row: (name: string, ip: string) => unknown) => [
    row(`r${n}`, NEW),
    ...(n === last ? [row('deep', OLD)] : []),
  ];
  const walks: Record<string, Walk> = {
    digitalocean: {
      zoneId: 'example.com',
      guardPages: 20,
      page: (n, last) => ({
        domain_records: rows(n, last, (name, data) => ({ id: name, type: 'A', name, data })),
        links: n < last ? { pages: { next: 'more' } } : {},
      }),
    },
    linode: {
      zoneId: '42',
      guardPages: 20,
      page: (n, last) => ({
        data: rows(n, last, (name, target) => ({ id: name, type: 'A', name, target })),
        page: n,
        pages: Number.isFinite(last) ? last : 25,
      }),
    },
    scaleway: {
      zoneId: 'example.com',
      guardPages: 20,
      // It reads one page past the guard: a short page there ends the zone.
      readsPastGuard: 21,
      // Scaleway's walk ends on a short page, so a zone is full pages and
      // then an empty one.
      page: (n, last) => ({
        records:
          n > last
            ? []
            : Array.from({ length: 100 }, (_, i) =>
                n === last && i === 0
                  ? { id: 'deep', type: 'A', name: 'deep', data: OLD }
                  : { id: `${n}-${i}`, type: 'A', name: `r${n}-${i}`, data: NEW },
              ),
      }),
    },
    vultr: {
      zoneId: 'example.com',
      guardPages: 20,
      page: (n, last) => ({
        records: rows(n, last, (name, data) => ({ id: name, type: 'A', name, data })),
        meta: { links: { next: n < last ? String(n) : '' } },
      }),
    },
    cloudflare: {
      zoneId: 'zone',
      guardPages: 50,
      page: (n, last) => ({
        success: true,
        result: rows(n, last, (name, content) => ({
          id: name,
          name: `${name}.example.com`,
          type: 'A',
          content,
        })),
        result_info: { page: n, total_pages: Number.isFinite(last) ? last : 999 },
      }),
      notWalked: {
        deleteDNSRecord: 'its listing is filtered to the one name and type, one page',
      },
    },
    hetzner: {
      zoneId: 'z1',
      // getRrsets has no guard: it reads to the last page.
      guardPages: null,
      page: (n, last) => ({
        rrsets: rows(n, last, (name, value) => ({ name, type: 'A', records: [{ value }] })),
        meta: { pagination: { next_page: n < last ? n + 1 : null } },
      }),
    },
  };

  /** Registered backends the table does not cover, and table rows no backend is registered for. */
  const census = (registered: string[], covered: string[]) => ({
    missing: registered.filter((id) => !covered.includes(id)),
    stale: covered.filter((id) => !registered.includes(id)),
  });

  it('covers every registered DNS backend, and nothing else', () => {
    expect(census(Object.keys(DNS_PROVIDERS), Object.keys(walks))).toEqual({
      missing: [],
      stale: [],
    });
  });

  it('bites: a backend registered without a row is named', () => {
    expect(census([...Object.keys(DNS_PROVIDERS), 'newdns'], Object.keys(walks)).missing).toEqual([
      'newdns',
    ]);
  });

  /** Serve the zone, counting record reads; answer every write. */
  const serve = (walk: Walk, last: number) => {
    const recordReads: string[] = [];
    const writes: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      const u = new URL(url);
      if (init?.method && init.method !== 'GET') {
        writes.push(`${init.method} ${u.pathname}`);
        return ok({ success: true });
      }
      if (/\/(records|dns_records|rrsets)$/.test(u.pathname)) {
        recordReads.push(url);
        return ok(walk.page(recordReads.length, last));
      }
      // The zone's name, for the backends that address it by id.
      if (u.pathname.endsWith('/domains/42')) return ok({ domain: 'example.com' });
      if (u.pathname.endsWith('/zones/z1')) return ok({ zone: { id: 'z1', name: 'example.com' } });
      return new Response('{}', { status: 404 });
    });
    return { recordReads, writes };
  };
  const ops = (walk: Walk) =>
    (['findARecordsAt', 'deleteDNSRecord'] as Ops[]).filter((op) => !walk.notWalked?.[op]);
  type Backend = Record<Ops, (...args: unknown[]) => Promise<unknown>>;
  const call = (mod: Backend, op: Ops, zoneId: string) =>
    op === 'findARecordsAt'
      ? mod.findARecordsAt('t', zoneId, OLD)
      : mod.deleteDNSRecord('t', zoneId, 'deep.example.com', [OLD]);

  for (const [id, row] of Object.entries(DNS_PROVIDERS)) {
    const walk = walks[id];
    if (!walk) continue;
    const file = row.modulePath.replace('./', '');

    for (const op of ops(walk)) {
      if (walk.guardPages !== null) {
        it(`${id}: ${op} on a zone longer than the page guard throws, never reads part as the whole`, async () => {
          const { recordReads, writes } = serve(walk, Number.POSITIVE_INFINITY);
          const mod = await import(`../../../src/lib/${file}`);
          await expect(call(mod, op, walk.zoneId)).rejects.toThrow(/more than \d+ (A )?records/);
          // The guard still bounds the walk, and nothing was deleted on it.
          expect(recordReads).toHaveLength(walk.readsPastGuard ?? (walk.guardPages as number));
          expect(writes).toEqual([]);
        });
      }

      // A zone that ends exactly at the guard is whole (for Scaleway, 2000
      // records: twenty full pages, then an empty one). With no guard, a
      // zone past where a guard would stop is read to its end.
      const last = walk.guardPages ?? 25;
      it(`${id}: ${op} reads a zone of ${last} pages whole, to the record on its last page`, async () => {
        const { writes } = serve(walk, last);
        const mod = await import(`../../../src/lib/${file}`);
        const out = await call(mod, op, walk.zoneId);
        if (op === 'findARecordsAt') expect(out).toEqual(['deep.example.com']);
        else {
          expect(out).toMatchObject({ deleted: 1, total: 1 });
          expect(writes).toHaveLength(1);
        }
      });
    }
  }
});
