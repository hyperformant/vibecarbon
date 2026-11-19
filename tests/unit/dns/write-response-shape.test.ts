/**
 * Every DNS backend's upsertApexAndWildcard returns, by name, the A records
 * its write's RESPONSE says the name now holds, in the one shape
 * flipAndVerifyDns judges ({id, value}[]), with ids that match the ones its
 * readARecords lists. Walks the DNS_PROVIDERS registry, so a new backend
 * fails here until it has a fixture and meets the contract.
 *
 * Why (2026-11-19, run 44463077640): Linode's record list served a record's
 * old target in the same second its event log recorded the update to the new
 * one, and the failover reported "DNS DID NOT" over a flip that had landed.
 * It also carries the refused-wildcard case: a write that throws hands scale
 * the answers of the writes before it (error.written). The flip now
 * trusts the write's answer for the records it wrote and reads the list only
 * for the others. That holds only if every backend hands the answer back, and
 * its ids line up with the list's: the "lagging list" case below runs the real
 * flip over each backend to prove both.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flipAndVerifyDns } from '../../../src/lib/deploy/failover-guard.js';
import { DNS_PROVIDERS, getDnsProvider } from '../../../src/lib/dns-provider.js';

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

const DOMAIN = 'example.com';
const WILDCARD = `*.${DOMAIN}`;
const IP = '203.0.113.9';
const OLD = '198.51.100.1';
/** An address the write's response holds that the request never sent. */
const ANSWERED = '192.0.2.77';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

type Init = { method?: string; body?: string };

interface Fixture {
  zoneId: string;
  /** The ids the backend gives the apex and the wildcard, in the write's answer and the list. */
  ids: [string, string];
  /**
   * Whether the write's response carries the record. False where the provider
   * answers with no record (Vultr's PATCH is a 204; Hetzner's set_records
   * returns the Action): the 2xx is its word that the record holds what was
   * sent, so the backend reports that.
   */
  answers: boolean;
  /** Hetzner: one rrset per (name, type), replaced whole by a write. */
  rrset?: boolean;
  /**
   * Serve the zone: the list shows apex and wildcard at `listed` (plus, when
   * `stale`, a second A record at the apex at OLD); a write answers with
   * `answer` where the provider returns the record.
   */
  serve: (o: {
    listed: string;
    answer: string;
    stale: boolean;
  }) => (url: string, init?: Init) => Response;
}

const FIXTURES: Record<string, Fixture> = {
  linode: {
    zoneId: '42',
    ids: ['11', '12'],
    answers: true,
    serve:
      ({ listed, answer, stale }) =>
      (url, init) => {
        if (init?.method === 'PUT') {
          const id = Number(url.split('/').at(-1));
          return json({ id, type: 'A', name: JSON.parse(String(init.body)).name, target: answer });
        }
        if (url.includes('/domains/42/records')) {
          return json({
            data: [
              { id: 11, type: 'A', name: '', target: listed },
              { id: 12, type: 'A', name: '*', target: listed },
              ...(stale ? [{ id: 13, type: 'A', name: '', target: OLD }] : []),
            ],
            page: 1,
            pages: 1,
          });
        }
        if (url.endsWith('/domains/42')) return json({ id: 42, domain: DOMAIN });
        return json({}, 404);
      },
  },
  digitalocean: {
    zoneId: DOMAIN,
    ids: ['21', '22'],
    answers: true,
    serve:
      ({ listed, answer, stale }) =>
      (url, init) => {
        if (init?.method === 'PUT') {
          const id = Number(url.split('/').at(-1));
          const sent = JSON.parse(String(init.body));
          return json({ domain_record: { id, type: 'A', name: sent.name, data: answer } });
        }
        if (url.includes(`/domains/${DOMAIN}/records`)) {
          return json({
            domain_records: [
              { id: 21, type: 'A', name: '@', data: listed },
              { id: 22, type: 'A', name: '*', data: listed },
              ...(stale ? [{ id: 23, type: 'A', name: '@', data: OLD }] : []),
            ],
            links: {},
          });
        }
        return json({}, 404);
      },
  },
  vultr: {
    zoneId: DOMAIN,
    ids: ['vr-1', 'vr-2'],
    answers: false,
    serve:
      ({ listed, stale }) =>
      (url, init) => {
        if (init?.method === 'PATCH') return new Response(null, { status: 204 });
        if (url.includes(`/domains/${DOMAIN}/records`)) {
          return json({
            records: [
              { id: 'vr-1', type: 'A', name: '', data: listed },
              { id: 'vr-2', type: 'A', name: '*', data: listed },
              ...(stale ? [{ id: 'vr-3', type: 'A', name: '', data: OLD }] : []),
            ],
            meta: { links: { next: '' } },
          });
        }
        return json({}, 404);
      },
  },
  scaleway: {
    zoneId: DOMAIN,
    ids: ['s1', 's2'],
    answers: true,
    serve:
      ({ listed, answer, stale }) =>
      (url, init) => {
        if (init?.method === 'PATCH') {
          const { set } = JSON.parse(String(init.body)).changes[0];
          const [rec] = set.records;
          return json({ records: [{ id: set.id, name: rec.name, type: 'A', data: answer }] });
        }
        if (url.includes(`/dns-zones/${DOMAIN}/records`)) {
          return json({
            records: [
              { id: 's1', type: 'A', name: '', data: listed },
              { id: 's2', type: 'A', name: '*', data: listed },
              ...(stale ? [{ id: 's3', type: 'A', name: '', data: OLD }] : []),
            ],
          });
        }
        return json({}, 404);
      },
  },
  cloudflare: {
    zoneId: 'zone',
    ids: ['c1', 'c2'],
    answers: true,
    serve:
      ({ listed, answer, stale }) =>
      (url, init) => {
        const rows = [
          { id: 'c1', type: 'A', name: DOMAIN, content: listed },
          { id: 'c2', type: 'A', name: WILDCARD, content: listed },
          ...(stale ? [{ id: 'c3', type: 'A', name: DOMAIN, content: OLD }] : []),
        ];
        if (init?.method === 'PATCH') {
          const id = url.split('/').at(-1);
          const row = rows.find((r) => r.id === id);
          return json({ success: true, result: { ...row, content: answer } });
        }
        if (url.includes('/zones/zone/dns_records')) {
          const name = new URL(url).searchParams.get('name');
          return json({ success: true, result: rows.filter((r) => r.name === name) });
        }
        return json({}, 404);
      },
  },
  hetzner: {
    zoneId: 'z1',
    ids: ['@/A', '*/A'],
    answers: false,
    rrset: true,
    serve:
      ({ listed, stale }) =>
      (url, init) => {
        if (init?.method === 'POST' && url.includes('/actions/set_records')) {
          return json({ action: { id: 7, command: 'set_rrset_records', status: 'success' } }, 201);
        }
        if (url.includes('/zones/z1/rrsets')) {
          return json({
            rrsets: [
              {
                name: '@',
                type: 'A',
                ttl: 60,
                records: [{ value: listed }, ...(stale ? [{ value: OLD }] : [])],
              },
              { name: '*', type: 'A', ttl: 60, records: [{ value: listed }] },
            ],
            meta: { pagination: {} },
          });
        }
        if (url.endsWith('/zones/z1')) return json({ zone: { id: 'z1', name: DOMAIN } });
        return json({}, 404);
      },
  },
};

function serve(
  f: Fixture,
  o: { listed: string; answer: string; stale?: boolean; refuseWildcard?: boolean },
) {
  const handler = f.serve({ stale: false, ...o });
  fetchMock.mockImplementation(async (url: string | URL, init?: Init) => {
    const u = String(url);
    // refuseWildcard: every write that names the wildcard record is refused.
    const write = init?.method && init.method !== 'GET';
    const names = u.includes(f.ids[1]) || String(init?.body ?? '').includes(f.ids[1]);
    if (o.refuseWildcard && write && names) {
      return json({ success: false, errors: [{ reason: 'refused', message: 'refused' }] }, 400);
    }
    return handler(u, init);
  });
}

describe('every DNS backend answers a write with the records it wrote', () => {
  it('every registered backend has a fixture here (a new one is drafted in)', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(Object.keys(DNS_PROVIDERS).sort());
  });

  for (const id of Object.keys(DNS_PROVIDERS)) {
    const f = FIXTURES[id];
    const auth = () => ({ token: 't', zoneId: f.zoneId });

    describe(id, () => {
      it('upsertApexAndWildcard returns {id, value}[] by name, from the write response', async () => {
        serve(f, { listed: OLD, answer: ANSWERED });
        const dns = (await getDnsProvider(id)) as {
          upsertApexAndWildcard: (a: object, d: string, ip: string) => Promise<unknown>;
        };
        const value = f.answers ? ANSWERED : IP;
        await expect(dns.upsertApexAndWildcard(auth(), DOMAIN, IP)).resolves.toEqual({
          [DOMAIN]: [{ id: f.ids[0], value }],
          [WILDCARD]: [{ id: f.ids[1], value }],
        });
      });

      it('the flip passes while the list still shows the old address on the written records', async () => {
        serve(f, { listed: OLD, answer: IP });
        const dns = (await getDnsProvider(id)) as Record<
          string,
          (...a: unknown[]) => Promise<never>
        >;
        const r = await flipAndVerifyDns({
          update: () => dns.upsertApexAndWildcard(auth(), DOMAIN, IP),
          read: (name: string) => dns.readARecords('t', f.zoneId, name),
          domain: DOMAIN,
          ip: IP,
        });
        expect(r).toEqual({ ok: true });
      });

      it(
        f.rrset
          ? 'a second value in the listed rrset is the set the write replaced: no other record'
          : 'a second A record at the apex, at the old address, fails the flip',
        async () => {
          serve(f, { listed: IP, answer: IP, stale: true });
          const dns = (await getDnsProvider(id)) as Record<
            string,
            (...a: unknown[]) => Promise<never>
          >;
          const r = await flipAndVerifyDns({
            update: () => dns.upsertApexAndWildcard(auth(), DOMAIN, IP),
            read: (name: string) => dns.readARecords('t', f.zoneId, name),
            domain: DOMAIN,
            ip: IP,
          });
          if (f.rrset) expect(r).toEqual({ ok: true });
          else {
            expect(r).toMatchObject({
              ok: false,
              reason: expect.stringContaining(`${DOMAIN} still has another A record, ${OLD}`),
            });
          }
        },
      );

      it('a refused wildcard write throws carrying the apex write answer (scale reads it)', async () => {
        serve(f, { listed: OLD, answer: IP, refuseWildcard: true });
        const dns = (await getDnsProvider(id)) as {
          upsertApexAndWildcard: (a: object, d: string, ip: string) => Promise<unknown>;
        };
        const err = await dns.upsertApexAndWildcard(auth(), DOMAIN, IP).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as { written?: unknown }).written).toEqual({
          [DOMAIN]: [{ id: f.ids[0], value: IP }],
        });
      });
    });
  }
});
