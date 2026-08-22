/**
 * BUG B — destroy left `_acme-challenge.<env>` TXT records behind, on every
 * DNS backend, forever.
 *
 * Live receipt (2026-08-10 all-provider orphan audit): Hetzner DNS
 * (carbonstack.dev) held `_acme-challenge.e1` with TWELVE accumulated
 * validation tokens plus `_acme-challenge.ci1`, both surviving several GREEN
 * destroys the same day; Cloudflare (appcarbon.dev) held 11 stray
 * `_acme-challenge.{e2,d2}` TXTs. The teardown deletes `<env>` and `*.<env>`
 * — the A records IT created — and nothing at all under `_acme-challenge`,
 * because those are written by the ACME client (Traefik's lego on compose,
 * cert-manager on k8s), not by us.
 *
 * They are not cosmetic. A stale challenge record shadows the NEXT deploy's
 * DNS-01 wildcard validation (reference_dns01_wildcard_cert_gotchas), so the
 * residue from a destroyed environment breaks the environment that reuses its
 * name.
 *
 * This is a CENSUS, not five hand-written cases: it walks DNS_PROVIDERS, so a
 * sixth backend added without challenge cleanup fails here rather than
 * shipping the same hole a sixth time. Each row's wire fixture proves the
 * module really issues the DELETE against its own API shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { challengeRecordNames } from '../../../src/lib/acme-challenge.js';
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

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

const DOMAIN = 'e1.example.com';
const CHALLENGE = `_acme-challenge.${DOMAIN}`;
/** Two accumulated tokens, the shape the audit actually found. */
const TOKENS = ['token-one', 'token-two'];

/**
 * Per-backend wire fixture: the zone listing each module reads, keyed by its
 * own API shape. `zoneId` is whatever that backend's zone identity is
 * (Hetzner: an id; DO/Vultr/Scaleway: the zone name; Linode: a numeric id).
 *
 * `isDelete` recognises the call that REMOVES a record on that backend.
 * Five of the six issue an HTTP DELETE (the default); Scaleway has no
 * per-record endpoint at all — every mutation is a PATCH of the zone carrying
 * a `changes` array — so the census asks each fixture what removal looks like
 * on its own wire rather than assuming one verb. The property under test is
 * "the module really issues the removal", which is verb-independent.
 */
type Fixture = {
  zoneId: string;
  listing: (url: string) => Response | null;
  isDelete?: (url: string, init?: RequestInit) => boolean;
};

const isHttpDelete = (_url: string, init?: RequestInit) => init?.method === 'DELETE';

const FIXTURES: Record<string, Fixture> = {
  hetzner: {
    zoneId: 'zone-1',
    listing: (url) => {
      if (url.includes('/rrsets')) {
        return ok({
          rrsets: [
            { name: '@', type: 'A', records: [{ value: '1.2.3.4' }] },
            {
              name: '_acme-challenge.e1',
              type: 'TXT',
              records: TOKENS.map((value) => ({ value })),
            },
          ],
          meta: { pagination: {} },
        });
      }
      if (url.includes('/zones/zone-1')) return ok({ zone: { id: 'zone-1', name: 'example.com' } });
      return null;
    },
  },
  cloudflare: {
    zoneId: 'zone-cf',
    listing: (url) =>
      url.includes('/dns_records?')
        ? ok({
            result: TOKENS.map((content, i) => ({
              id: `cf-${i}`,
              name: CHALLENGE,
              type: 'TXT',
              content,
            })),
          })
        : null,
  },
  digitalocean: {
    zoneId: 'example.com',
    listing: (url) =>
      url.includes('/records?')
        ? ok({
            domain_records: TOKENS.map((data, i) => ({
              id: 100 + i,
              name: '_acme-challenge.e1',
              type: 'TXT',
              data,
            })),
            links: {},
            meta: { total: TOKENS.length },
          })
        : null,
  },
  linode: {
    zoneId: '4321',
    listing: (url) => {
      if (url.includes('/records?')) {
        return ok({
          data: TOKENS.map((target, i) => ({
            id: 200 + i,
            name: '_acme-challenge.e1',
            type: 'TXT',
            target,
          })),
          page: 1,
          pages: 1,
        });
      }
      if (url.includes('/domains/4321')) return ok({ id: 4321, domain: 'example.com' });
      return null;
    },
  },
  vultr: {
    zoneId: 'example.com',
    listing: (url) =>
      url.includes('/records')
        ? ok({
            records: TOKENS.map((data, i) => ({
              id: `v-${i}`,
              name: '_acme-challenge.e1',
              type: 'TXT',
              data,
            })),
            meta: { links: {} },
          })
        : null,
  },
  scaleway: {
    zoneId: 'example.com',
    listing: (url) =>
      url.includes('/dns-zones/example.com/records')
        ? ok({
            // TXT payloads come back QUOTED on this API — the reap matches on
            // NAME, so the quoting must not matter, and this fixture proves it.
            records: TOKENS.map((data, i) => ({
              id: `scw-${i}`,
              name: '_acme-challenge.e1',
              type: 'TXT',
              data: `"${data}"`,
            })),
            total_count: TOKENS.length,
          })
        : null,
    isDelete: (_url, init) => init?.method === 'PATCH' && /"delete"/.test(String(init?.body ?? '')),
  },
};

describe('ACME challenge record names', () => {
  it('is the flat `_acme-challenge.<domain>` — the apex and wildcard certs share it', () => {
    // RFC 8555 §8.4: the validation record for identifier X is
    // `_acme-challenge.X`, and a wildcard order's identifier is the BASE
    // domain (`*.e1.example.com` validates at `_acme-challenge.e1.example.com`).
    // One name, which is exactly why tokens pile up in it.
    expect(challengeRecordNames(DOMAIN)).toEqual([CHALLENGE]);
  });

  it('tolerates a trailing dot and rejects a missing domain', () => {
    expect(challengeRecordNames('e1.example.com.')).toEqual([CHALLENGE]);
    expect(challengeRecordNames('')).toEqual([]);
    expect(challengeRecordNames(undefined)).toEqual([]);
  });
});

describe('DNS backend challenge-record cleanup census', () => {
  it('every registered backend has a wire fixture here', () => {
    // The census property: a new backend cannot slip past this file.
    expect(Object.keys(FIXTURES).sort()).toEqual(Object.keys(DNS_PROVIDERS).sort());
  });

  it.each(Object.keys(DNS_PROVIDERS))(
    '%s deletes the accumulated `_acme-challenge` TXT records',
    async (id) => {
      const { zoneId, listing, isDelete = isHttpDelete } = FIXTURES[id];
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (isDelete(String(url), init)) return Promise.resolve(ok({}));
        const body = listing(String(url));
        if (body) return Promise.resolve(body);
        return Promise.resolve(ok({}));
      });

      const mod = (await getDnsProvider(id)) as {
        deleteChallengeRecords: (
          t: string,
          z: string,
          d: string,
        ) => Promise<{
          deleted: number;
          names: string[];
        }>;
      };
      const result = await mod.deleteChallengeRecords('token', zoneId, DOMAIN);

      const deletes = fetchMock.mock.calls.filter(([url, init]) => isDelete(String(url), init));
      expect(deletes.length, `${id} issued no record removal`).toBeGreaterThan(0);
      expect(result.deleted).toBeGreaterThan(0);
      expect(result.names).toEqual([CHALLENGE]);
    },
  );

  it.each(Object.keys(DNS_PROVIDERS))(
    '%s deletes nothing when the zone holds no challenge record',
    async (id) => {
      const { zoneId, isDelete = isHttpDelete } = FIXTURES[id];
      fetchMock.mockImplementation((url: string) => {
        // Empty listing in every backend's own envelope.
        if (String(url).includes('/zones/zone-1') && !String(url).includes('/rrsets')) {
          return Promise.resolve(ok({ zone: { id: 'zone-1', name: 'example.com' } }));
        }
        if (String(url).includes('/domains/4321') && !String(url).includes('/records')) {
          return Promise.resolve(ok({ id: 4321, domain: 'example.com' }));
        }
        return Promise.resolve(
          ok({
            rrsets: [],
            result: [],
            domain_records: [],
            records: [],
            data: [],
            links: {},
            meta: { total: 0, pagination: {}, links: {} },
            page: 1,
            pages: 1,
          }),
        );
      });

      const mod = (await getDnsProvider(id)) as {
        deleteChallengeRecords: (
          t: string,
          z: string,
          d: string,
        ) => Promise<{
          deleted: number;
          names: string[];
        }>;
      };
      const result = await mod.deleteChallengeRecords('token', zoneId, DOMAIN);

      expect(
        fetchMock.mock.calls.filter(([url, init]) => isDelete(String(url), init)),
      ).toHaveLength(0);
      expect(result).toEqual({ deleted: 0, names: [] });
    },
  );

  it('hetzner sends the rrset name UNENCODED in the DELETE path', async () => {
    // Live confirmation 2026-08-10: a percent-encoded name segment 404s on the
    // Hetzner rrsets endpoint while the literal one succeeds (`%2A.ci3` → 404,
    // `*.ci3` → 201). Encoding here would make the delete a silent no-op — the
    // exact failure mode this whole fix is about.
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Promise.resolve(ok({}));
      return Promise.resolve(FIXTURES.hetzner.listing(String(url)) ?? ok({}));
    });

    const { deleteChallengeRecords } = await import('../../../src/lib/hetzner-dns.js');
    await deleteChallengeRecords('token', 'zone-1', DOMAIN);

    const [url] = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE') as [string];
    expect(url).toContain('/rrsets/_acme-challenge.e1/TXT');
    expect(url).not.toContain('%');
  });
});
