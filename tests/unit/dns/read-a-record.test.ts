/**
 * readARecord, per backend (HA-correctness Task 4, R5): the read-back that
 * failover compares with the promoted IP. Each backend answers with the wire
 * shape its API uses, for the apex and the wildcard, and null for a missing
 * name.
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
const IP = '203.0.113.9';

/** Route by URL substring: first matching key wins. */
function route(table: Record<string, unknown>) {
  fetchMock.mockImplementation(async (url: string) => {
    for (const [needle, body] of Object.entries(table)) {
      if (String(url).includes(needle)) return ok(body);
    }
    return new Response('{}', { status: 404 });
  });
}

const cases: Array<{
  file: string;
  zoneId: string;
  routes: Record<string, unknown>;
}> = [
  {
    file: 'vultr-dns.js',
    zoneId: 'example.com',
    routes: {
      '/records': {
        records: [
          { id: '1', type: 'A', name: '', data: IP },
          { id: '2', type: 'A', name: '*', data: IP },
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
          { id: 1, type: 'A', name: '@', data: IP },
          { id: 2, type: 'A', name: '*', data: IP },
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
          { id: 1, type: 'A', name: '', target: IP },
          { id: 2, type: 'A', name: '*', target: IP },
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
          { id: '1', type: 'A', name: '', data: IP },
          { id: '2', type: 'A', name: '*', data: IP },
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
          { name: '@', type: 'A', records: [{ value: IP }] },
          { name: '*', type: 'A', records: [{ value: IP }] },
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
          { name: 'example.com', type: 'A', content: IP },
          { name: '*.example.com', type: 'A', content: IP },
        ],
      },
    },
  },
];

describe('readARecord', () => {
  for (const { file, zoneId, routes } of cases) {
    it(`${file}: reads the apex and the wildcard`, async () => {
      route(routes);
      const mod = await import(`../../../src/lib/${file}`);
      await expect(mod.readARecord('t', zoneId, 'example.com')).resolves.toBe(IP);
      await expect(mod.readARecord('t', zoneId, '*.example.com')).resolves.toBe(IP);
    });
  }

  it('vultr-dns.js: a name with no A record reads as null', async () => {
    route({ '/records': { records: [], meta: { links: { next: '' } } } });
    const mod = await import('../../../src/lib/vultr-dns.js');
    await expect(mod.readARecord('t', 'example.com', 'example.com')).resolves.toBeNull();
  });
});
