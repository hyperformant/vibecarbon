/**
 * fetchServerTypes pagination — both providers (truncated-listing failure
 * class, 2026-07-30).
 *
 * `fetchServerTypes` populates SERVER_TYPES + the per-location availability
 * cache that feed EVERY interactive type picker, region default, and
 * capacity check downstream. Both implementations used a single collection
 * GET: Hetzner `?per_page=50` (fits today's ~35 SKUs — the exact "fits
 * today" assumption that let `listVolumes`' 25-row default leak six orphaned
 * CSI volumes), DO `?per_page=200` while its own `getServerType` sibling a
 * few hundred lines down already walked `links.pages.next` for the same
 * endpoint — sibling drift inside one file.
 *
 * These tests pin the two properties that close the class here:
 *   (a) an entry on page 2 lands in SERVER_TYPES/availability (the walk
 *       actually happens and merges);
 *   (b) an incomplete walk returns false and leaves SERVER_TYPES untouched —
 *       a truncated catalog must never pose as live truth (the offline
 *       fallback catalog is at least honest about being a fallback).
 *
 * The repo-wide sweep in list-endpoint-pagination-sweep.test.ts is the
 * class-level tripwire that keeps NEW un-paginated collection GETs out; this
 * file is the behavioral proof for the two catalog loaders specifically.
 *
 * Each provider's statics are snapshotted and restored — SERVER_TYPES is
 * replaced wholesale on a successful live fetch and `_locationTypes` is the
 * "already fetched" short-circuit, so leakage would poison sibling tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

type ProviderStatics = {
  SERVER_TYPES: unknown;
  _locationTypes: unknown;
};

const hetznerOriginal: ProviderStatics = {
  SERVER_TYPES: HetznerProvider.SERVER_TYPES,
  _locationTypes: (HetznerProvider as unknown as ProviderStatics)._locationTypes,
};
const doOriginal: ProviderStatics = {
  SERVER_TYPES: DigitalOceanProvider.SERVER_TYPES,
  _locationTypes: (DigitalOceanProvider as unknown as ProviderStatics)._locationTypes,
};

afterEach(() => {
  HetznerProvider.SERVER_TYPES = hetznerOriginal.SERVER_TYPES as never;
  (HetznerProvider as unknown as ProviderStatics)._locationTypes = hetznerOriginal._locationTypes;
  DigitalOceanProvider.SERVER_TYPES = doOriginal.SERVER_TYPES as never;
  (DigitalOceanProvider as unknown as ProviderStatics)._locationTypes = doOriginal._locationTypes;
  vi.unstubAllGlobals();
});

function jsonResp(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('HetznerProvider.fetchServerTypes', () => {
  it('walks meta.pagination.next_page — a type on page 2 lands in the catalog', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResp({
          server_types: [
            {
              name: 'cx23',
              cores: 2,
              memory: 4,
              disk: 40,
              cpu_type: 'shared',
              architecture: 'x86',
              locations: [{ name: 'nbg1' }],
            },
          ],
          meta: { pagination: { next_page: 2 } },
        }),
      )
      .mockResolvedValueOnce(
        jsonResp({
          server_types: [
            {
              name: 'cx99',
              cores: 16,
              memory: 64,
              disk: 360,
              cpu_type: 'shared',
              architecture: 'x86',
              locations: [{ name: 'hel1' }],
            },
          ],
          meta: { pagination: {} },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    expect(await HetznerProvider.fetchServerTypes('tok')).toBe(true);
    // The page-2 SKU is present — the exact entry a single-page GET drops.
    expect(HetznerProvider.SERVER_TYPES).toHaveProperty('cx99');
    expect(HetznerProvider.SERVER_TYPES).toHaveProperty('cx23');
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://api.hetzner.cloud/v1/server_types?per_page=50&page=1',
      'https://api.hetzner.cloud/v1/server_types?per_page=50&page=2',
    ]);
  });

  it('a 200 with a missing collection key must NOT wipe the catalog (empty ≠ success)', async () => {
    // The walker tolerates a missing collection key (correct for destroy
    // sweeps, where empty is a real answer), but a 200 `{}` body must not be
    // treated as a successful-but-empty catalog. This pins the loud outcome:
    // false, catalog untouched, and the next call still fetches (the
    // short-circuit was not poisoned).
    const before = HetznerProvider.SERVER_TYPES;
    const keysBefore = Object.keys(before as Record<string, unknown>).length;
    expect(keysBefore).toBeGreaterThan(0); // positive control: something to lose
    const fetchMock = vi.fn().mockResolvedValue(jsonResp({}));
    vi.stubGlobal('fetch', fetchMock);

    expect(await HetznerProvider.fetchServerTypes('tok')).toBe(false);
    expect(HetznerProvider.SERVER_TYPES).toBe(before);
    expect(Object.keys(HetznerProvider.SERVER_TYPES as Record<string, unknown>)).toHaveLength(
      keysBefore,
    );

    // The failed attempt must not arm the "already fetched" short-circuit:
    // a subsequent call with a healthy body loads live data.
    fetchMock.mockResolvedValue(
      jsonResp({
        server_types: [
          {
            name: 'cx23',
            cores: 2,
            memory: 4,
            disk: 40,
            cpu_type: 'shared',
            architecture: 'x86',
            locations: [{ name: 'nbg1' }],
          },
        ],
        meta: { pagination: {} },
      }),
    );
    expect(await HetznerProvider.fetchServerTypes('tok')).toBe(true);
    expect(HetznerProvider.SERVER_TYPES).toHaveProperty('cx23');
  });

  it('a catalog filtered down to NOTHING must not wipe SERVER_TYPES either (post-filter guard)', async () => {
    // A 200 whose entries are all filtered out (all-ARM here; all deprecated
    // would behave the same) must not wipe the catalog after filtering — the
    // guard must check post-filter count, not raw item count. Unreachable
    // today (the global catalog always carries x86 SKUs), but the guard
    // still has to hold structurally.
    const before = HetznerProvider.SERVER_TYPES;
    expect(Object.keys(before as Record<string, unknown>).length).toBeGreaterThan(0);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResp({
        server_types: [
          {
            name: 'cax11',
            cores: 2,
            memory: 4,
            disk: 40,
            cpu_type: 'shared',
            architecture: 'arm',
            locations: [{ name: 'nbg1' }],
          },
          {
            name: 'cax21',
            cores: 4,
            memory: 8,
            disk: 80,
            cpu_type: 'shared',
            architecture: 'arm',
            locations: [{ name: 'nbg1' }],
          },
        ],
        meta: { pagination: {} },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await HetznerProvider.fetchServerTypes('tok')).toBe(false);
    expect(HetznerProvider.SERVER_TYPES).toBe(before);
    // Short-circuit not armed: a later healthy call still loads live data.
    fetchMock.mockResolvedValue(
      jsonResp({
        server_types: [
          {
            name: 'cx23',
            cores: 2,
            memory: 4,
            disk: 40,
            cpu_type: 'shared',
            architecture: 'x86',
            locations: [{ name: 'nbg1' }],
          },
        ],
        meta: { pagination: {} },
      }),
    );
    expect(await HetznerProvider.fetchServerTypes('tok')).toBe(true);
    expect(HetznerProvider.SERVER_TYPES).toHaveProperty('cx23');
  });

  it('an availability blackout is NOT an empty catalog: live specs kept, offers degrade per-region (composition with #215)', async () => {
    // #215's isLocationOrderable prunes the PER-LOCATION offer sets
    // (locationTypes); the empty-catalog guard counts the SKU/spec axis
    // (types), which that filter deliberately cannot shrink — a SKU
    // orderable in zero locations is still a spec entry. So a catalog
    // where every location of every SKU reads available:false must load
    // (true), keep the live spec table, offer NO types in the blacked-out
    // region, and let getRegionDefaults degrade to its offline branch.
    // Falling back wholesale here would be WRONG: it would trade live
    // "nothing orderable" knowledge for the fallback catalog's optimism.
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResp({
        server_types: [
          {
            name: 'cpx22',
            cores: 2,
            memory: 4,
            disk: 80,
            cpu_type: 'shared',
            architecture: 'x86',
            locations: [
              { name: 'fsn1', available: false },
              { name: 'nbg1', available: false },
            ],
          },
          {
            name: 'cpx32',
            cores: 4,
            memory: 8,
            disk: 160,
            cpu_type: 'shared',
            architecture: 'x86',
            locations: [{ name: 'fsn1', available: false }],
          },
        ],
        meta: { pagination: {} },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await HetznerProvider.fetchServerTypes('tok')).toBe(true);
    // Live spec table replaces the fallback — both SKUs present as specs.
    expect(HetznerProvider.SERVER_TYPES).toHaveProperty('cpx22');
    expect(HetznerProvider.SERVER_TYPES).toHaveProperty('cpx32');
    // The blacked-out region has NO live offer set (its _locationTypes key
    // was never created), so the downstream consumers degrade to their
    // pre-existing no-data postures rather than an empty picker:
    // getServerTypesForRegion prefix-filters the (live) spec table…
    expect(
      HetznerProvider.getServerTypesForRegion('fsn1')
        .map((t) => t.name)
        .sort(),
    ).toEqual(['cpx22', 'cpx32']);
    // …and getRegionDefaults returns its offline EU branch, not a pick
    // from a live per-region set that doesn't exist.
    expect(HetznerProvider.getRegionDefaults('fsn1')).toEqual({
      masterType: 'cpx22',
      supabaseType: 'cpx32',
      workerType: 'cpx22',
    });
  });

  it('returns false and leaves SERVER_TYPES untouched when the walk is incomplete', async () => {
    const before = HetznerProvider.SERVER_TYPES;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResp({
          server_types: [
            {
              name: 'cx23',
              cores: 2,
              memory: 4,
              disk: 40,
              cpu_type: 'shared',
              architecture: 'x86',
              locations: [{ name: 'nbg1' }],
            },
          ],
          meta: { pagination: { next_page: 2 } },
        }),
      )
      // 404 is non-transient — fetchWithRetry returns it without retrying.
      .mockResolvedValueOnce(jsonResp({}, 404));
    vi.stubGlobal('fetch', fetchMock);

    expect(await HetznerProvider.fetchServerTypes('tok')).toBe(false);
    expect(HetznerProvider.SERVER_TYPES).toBe(before);
  });
});

describe('DigitalOceanProvider.fetchServerTypes', () => {
  it('walks links.pages.next — a size on page 2 lands in the catalog', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResp({
          sizes: [{ slug: 's-2vcpu-4gb', vcpus: 2, memory: 4096, disk: 80, regions: ['nyc3'] }],
          links: { pages: { next: 'https://api.digitalocean.com/v2/sizes?per_page=200&page=2' } },
        }),
      )
      .mockResolvedValueOnce(
        jsonResp({
          sizes: [{ slug: 's-8vcpu-16gb', vcpus: 8, memory: 16384, disk: 320, regions: ['sfo3'] }],
          links: {},
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    expect(await DigitalOceanProvider.fetchServerTypes('tok')).toBe(true);
    expect(DigitalOceanProvider.SERVER_TYPES).toHaveProperty('s-8vcpu-16gb');
    expect(DigitalOceanProvider.SERVER_TYPES).toHaveProperty('s-2vcpu-4gb');
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://api.digitalocean.com/v2/sizes?per_page=200&page=1',
      'https://api.digitalocean.com/v2/sizes?per_page=200&page=2',
    ]);
  });

  it('a 200 with a missing collection key must NOT wipe the catalog (empty ≠ success)', async () => {
    // Mirror of the Hetzner empty-catalog guard above — this side of the
    // hole was pre-existing (a `{}` body made `data.sizes || []` an empty
    // walk that overwrote SERVER_TYPES and returned true), fixed in the
    // same pass per the parity rule.
    const before = DigitalOceanProvider.SERVER_TYPES;
    const keysBefore = Object.keys(before as Record<string, unknown>).length;
    expect(keysBefore).toBeGreaterThan(0); // positive control: something to lose
    const fetchMock = vi.fn().mockResolvedValue(jsonResp({}));
    vi.stubGlobal('fetch', fetchMock);

    expect(await DigitalOceanProvider.fetchServerTypes('tok')).toBe(false);
    expect(DigitalOceanProvider.SERVER_TYPES).toBe(before);

    // Short-circuit not poisoned: a later healthy call loads live data.
    fetchMock.mockResolvedValue(
      jsonResp({
        sizes: [{ slug: 's-2vcpu-4gb', vcpus: 2, memory: 4096, disk: 80, regions: ['nyc3'] }],
        links: {},
      }),
    );
    expect(await DigitalOceanProvider.fetchServerTypes('tok')).toBe(true);
    expect(DigitalOceanProvider.SERVER_TYPES).toHaveProperty('s-2vcpu-4gb');
  });

  it('a catalog filtered down to NOTHING must not wipe SERVER_TYPES either (post-filter guard)', async () => {
    // Mirror of the Hetzner post-filter guard: every size `available:
    // false` passes the raw-items check and used to wipe the catalog after
    // the filter.
    const before = DigitalOceanProvider.SERVER_TYPES;
    expect(Object.keys(before as Record<string, unknown>).length).toBeGreaterThan(0);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResp({
        sizes: [
          {
            slug: 's-2vcpu-4gb',
            vcpus: 2,
            memory: 4096,
            disk: 80,
            regions: ['nyc3'],
            available: false,
          },
          {
            slug: 's-4vcpu-8gb',
            vcpus: 4,
            memory: 8192,
            disk: 160,
            regions: ['sfo3'],
            available: false,
          },
        ],
        links: {},
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await DigitalOceanProvider.fetchServerTypes('tok')).toBe(false);
    expect(DigitalOceanProvider.SERVER_TYPES).toBe(before);
    // Short-circuit not armed: a later healthy call still loads live data.
    fetchMock.mockResolvedValue(
      jsonResp({
        sizes: [{ slug: 's-2vcpu-4gb', vcpus: 2, memory: 4096, disk: 80, regions: ['nyc3'] }],
        links: {},
      }),
    );
    expect(await DigitalOceanProvider.fetchServerTypes('tok')).toBe(true);
    expect(DigitalOceanProvider.SERVER_TYPES).toHaveProperty('s-2vcpu-4gb');
  });

  it('returns false and leaves SERVER_TYPES untouched when a later page fails', async () => {
    const before = DigitalOceanProvider.SERVER_TYPES;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResp({
          sizes: [{ slug: 's-2vcpu-4gb', vcpus: 2, memory: 4096, disk: 80, regions: ['nyc3'] }],
          links: { pages: { next: 'https://api.digitalocean.com/v2/sizes?per_page=200&page=2' } },
        }),
      )
      .mockResolvedValueOnce(jsonResp({}, 404));
    vi.stubGlobal('fetch', fetchMock);

    expect(await DigitalOceanProvider.fetchServerTypes('tok')).toBe(false);
    expect(DigitalOceanProvider.SERVER_TYPES).toBe(before);
  });
});
