/**
 * readARecords, per backend (HA-correctness Task 4, R5; ids since 2026-11-19):
 * the record list failover's flip reads for A records its write did not name.
 * Each backend parses the wire shape its API uses into {id, value}, for the
 * apex and the wildcard, and nothing for a missing name. Hetzner's id is the
 * rrset's key, `<name>/<type>`, the same one its write returns.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPO_ROOT } from '../../_shared/source-files.js';

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
  ids: [string, string];
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
    ids: ['1', '2'],
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
    ids: ['1', '2'],
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
    ids: ['1', '2'],
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
    ids: ['1', '2'],
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
    ids: ['@/A', '*/A'],
  },
  {
    file: 'cloudflare-dns.js',
    zoneId: 'zone',
    routes: {
      '/dns_records': {
        success: true,
        result: [
          { id: 'c1', name: 'example.com', type: 'A', content: IP },
          { id: 'c2', name: '*.example.com', type: 'A', content: IP },
        ],
      },
    },
    ids: ['c1', 'c2'],
  },
];

describe('readARecords', () => {
  it('covers every backend file', () => {
    expect(cases.map((c) => c.file).sort()).toEqual(
      readdirSync(join(REPO_ROOT, 'src/lib'))
        .filter((f) => f.endsWith('-dns.js'))
        .sort(),
    );
  });

  for (const { file, zoneId, routes, ids } of cases) {
    it(`${file}: reads the apex and the wildcard, each with its id`, async () => {
      route(routes);
      const mod = await import(`../../../src/lib/${file}`);
      await expect(mod.readARecords('t', zoneId, 'example.com')).resolves.toEqual([
        { id: ids[0], value: IP },
      ]);
      await expect(mod.readARecords('t', zoneId, '*.example.com')).resolves.toEqual([
        { id: ids[1], value: IP },
      ]);
    });
  }

  it('vultr-dns.js: a name with no A record reads as nothing', async () => {
    route({ '/records': { records: [], meta: { links: { next: '' } } } });
    const mod = await import('../../../src/lib/vultr-dns.js');
    await expect(mod.readARecords('t', 'example.com', 'example.com')).resolves.toEqual([]);
  });
});
