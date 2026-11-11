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

  // Each backend's walk stops at a page guard. A zone longer than that is not
  // read in full, and a partial listing that misses the record at the old
  // address would let the release go (a false release): past the guard
  // findARecordsAt throws, as Cloudflare's does, and the release keeps the
  // address.
  const endless: Array<{
    file: string;
    zoneId: string;
    pages: number;
    page: (url: URL, n: number) => unknown;
  }> = [
    {
      file: 'digitalocean-dns.js',
      zoneId: 'example.com',
      pages: 20,
      page: (url) => {
        const n = Number(url.searchParams.get('page'));
        return {
          domain_records: [{ id: n, type: 'A', name: `r${n}`, data: NEW }],
          links: { pages: { next: 'more' } },
        };
      },
    },
    {
      file: 'linode-dns.js',
      zoneId: '42',
      pages: 20,
      page: (url) => {
        const n = Number(url.searchParams.get('page'));
        return {
          data: [{ id: n, type: 'A', name: `r${n}`, target: NEW }],
          page: n,
          pages: 25,
        };
      },
    },
    {
      file: 'scaleway-dns.js',
      zoneId: 'example.com',
      pages: 20,
      // A full page every time: the walk reads a short page as the end.
      page: (url) => {
        const n = Number(url.searchParams.get('page'));
        return {
          records: Array.from({ length: 100 }, (_, i) => ({
            id: `${n}-${i}`,
            type: 'A',
            name: `r${n}-${i}`,
            data: NEW,
          })),
        };
      },
    },
    {
      file: 'vultr-dns.js',
      zoneId: 'example.com',
      pages: 20,
      page: (url) => {
        const n = Number(url.searchParams.get('cursor') ?? 0) + 1;
        return {
          records: [{ id: String(n), type: 'A', name: `r${n}`, data: NEW }],
          meta: { links: { next: String(n) } },
        };
      },
    },
  ];
  for (const { file, zoneId, pages, page } of endless) {
    it(`${file}: a zone longer than the page guard throws, never reads as the whole zone`, async () => {
      const recordReads: string[] = [];
      fetchMock.mockImplementation(async (url: string) => {
        const u = new URL(url);
        if (u.pathname.endsWith('/records')) {
          recordReads.push(url);
          return ok(page(u, recordReads.length));
        }
        // Linode names the zone by id first.
        if (u.pathname.endsWith('/domains/42')) return ok({ domain: 'example.com' });
        return new Response('{}', { status: 404 });
      });
      const mod = await import(`../../../src/lib/${file}`);
      await expect(mod.findARecordsAt('t', zoneId, '192.0.2.1')).rejects.toThrow(
        /more than \d+ records/,
      );
      // The guard still bounds the walk: no page past it is asked for.
      expect(recordReads).toHaveLength(pages);
    });
  }

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
