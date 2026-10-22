/**
 * Live prices and the role defaults they drive, per provider.
 *
 * `fetchServerTypes` captures each type's monthly price from the catalog
 * payload it already reads (no extra request), `priceFor(type, location)`
 * answers from that capture, and `getRegionDefaults` picks the cheapest
 * orderable candidate per role (src/lib/sizing.js). The fixtures are the
 * 2026-10-22 provider catalogs (tests/unit/fixtures/catalogs), loaded through
 * the providers' own `parseCatalog`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';
import { ScalewayProvider } from '../../../src/lib/providers/scaleway.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';
import { pickRoleType, ROLE_MIN_RAM_GB } from '../../../src/lib/sizing.js';
import { readCatalogFixture, seedCatalog } from '../helpers/catalog-fixtures.js';

// biome-ignore lint/suspicious/noExplicitAny: provider classes are untyped JS
type AnyProvider = any;
const ALL: AnyProvider[] = [
  HetznerProvider,
  DigitalOceanProvider,
  VultrProvider,
  LinodeProvider,
  ScalewayProvider,
];

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  vi.unstubAllGlobals();
});

describe('Hetzner', () => {
  it('2026-10-22: nbg1 and ash defaults, and location prices', () => {
    restore = seedCatalog(HetznerProvider, '2026-10-22/hetzner');
    expect(HetznerProvider.getRegionDefaults('nbg1')).toEqual({
      composeType: 'cpx22',
      masterType: 'cpx22',
      dbType: 'cpx12',
      workerType: 'cpx22',
    });
    expect(HetznerProvider.getRegionDefaults('ash')).toEqual({
      composeType: 'cpx21',
      masterType: 'cpx21',
      dbType: 'cpx11',
      workerType: 'cpx21',
    });
    expect(HetznerProvider.priceFor('cpx22', 'sin')).toBe(30.99);
    expect(HetznerProvider.priceFor('cpx22', 'nbg1')).toBe(22.99);
    expect(HetznerProvider.priceFor('cpx22', 'ash')).toBeNull(); // not priced there
    expect(HetznerProvider.priceFor('no-such-type', 'nbg1')).toBeNull();
  });

  it('flux fixture: cx23 in hel1 wins every role there', () => {
    restore = seedCatalog(HetznerProvider, 'flux-hetzner-cx23-hel1');
    expect(HetznerProvider.getRegionDefaults('hel1')).toEqual({
      composeType: 'cx23',
      masterType: 'cx23',
      dbType: 'cx23',
      workerType: 'cx23',
    });
  });

  it('ash cpx11 stock-out: the db falls to cpx21, the US 4 GB last resort', () => {
    restore = seedCatalog(HetznerProvider, '2026-10-22/hetzner', { drop: { ash: ['cpx11'] } });
    expect(HetznerProvider.getRegionDefaults('ash').dbType).toBe('cpx21');
  });

  it('a location with nothing orderable has no default (live knowledge, not fallback optimism)', () => {
    restore = seedCatalog(HetznerProvider, '2026-10-22/hetzner', {
      drop: { nbg1: ['cpx22', 'cpx21', 'cx23'] },
    });
    expect(HetznerProvider.getRegionDefaults('nbg1').composeType).toBeNull();
  });

  it('Review Focus 2: offline Hetzner never names a retired SKU', () => {
    // no seedCatalog: _locationTypes null
    expect(HetznerProvider._locationTypes).toBeNull();
    expect(HetznerProvider.getRegionDefaults('nbg1')).toEqual({
      composeType: 'cpx22',
      masterType: 'cpx22',
      dbType: 'cpx12',
      workerType: 'cpx22',
    });
    expect(HetznerProvider.getRegionDefaults('hil')).toEqual({
      composeType: 'cpx21',
      masterType: 'cpx21',
      dbType: 'cpx11',
      workerType: 'cpx21',
    });
  });

  it('offline: the US offer leaves out the cpx*2 line, the EU offer the retired cpx*1 line', () => {
    const us = HetznerProvider.getServerTypesForRegion('ash').map((t) => t.name);
    const eu = HetznerProvider.getServerTypesForRegion('nbg1').map((t) => t.name);
    expect(us).toContain('cpx21');
    expect(us.filter((n) => /^cpx\d2$/.test(n))).toEqual([]);
    expect(eu).toContain('cpx22');
    expect(eu.filter((n) => /^cpx\d1$|^cx\d2$/.test(n))).toEqual([]);
  });

  it('a standby type the target lacks maps to a default of the same RAM tier', () => {
    restore = seedCatalog(HetznerProvider, '2026-10-22/hetzner');
    // cx23 (4 GB) is not orderable in fsn1: the 4 GB pick, never the 2 GB db.
    expect(HetznerProvider.resolveServerTypeForRegion('cx23', 'fsn1')).toBe('cpx22');
    // cpx11 (2 GB) is retired in the EU: the 2 GB db pick.
    expect(HetznerProvider.resolveServerTypeForRegion('cpx11', 'fsn1')).toBe('cpx12');
  });
});

describe('DigitalOcean', () => {
  it('4 GB master and worker, 2 GB db; sfo3 falls to the $28 variants', () => {
    restore = seedCatalog(DigitalOceanProvider, '2026-10-22/digitalocean');
    expect(DigitalOceanProvider.getRegionDefaults('nyc3')).toEqual({
      composeType: 's-2vcpu-4gb',
      masterType: 's-2vcpu-4gb',
      dbType: 's-1vcpu-2gb',
      workerType: 's-2vcpu-4gb',
    });
    const sfo3 = DigitalOceanProvider.getRegionDefaults('sfo3');
    expect(sfo3.composeType).toMatch(/^s-2vcpu-4gb-(amd|intel)$/);
    expect(sfo3.dbType).toMatch(/^s-1vcpu-2gb-(amd|intel)$/);
    expect(DigitalOceanProvider.priceFor(sfo3.composeType, 'sfo3')).toBe(28);
  });

  it('prices are location-uniform', () => {
    restore = seedCatalog(DigitalOceanProvider, '2026-10-22/digitalocean');
    expect(DigitalOceanProvider.priceFor('s-2vcpu-4gb', 'nyc3')).toBe(24);
    expect(DigitalOceanProvider.priceFor('s-2vcpu-4gb', 'fra1')).toBe(24);
  });

  it('atl1 sells none of the candidates: no default there', () => {
    restore = seedCatalog(DigitalOceanProvider, '2026-10-22/digitalocean');
    expect(DigitalOceanProvider.getRegionDefaults('atl1').composeType).toBeNull();
  });
});

describe('Vultr', () => {
  it('ewr: vc2-2c-4gb at $20; sao carries its own location price', () => {
    restore = seedCatalog(VultrProvider, '2026-10-22/vultr');
    expect(VultrProvider.getRegionDefaults('ewr').composeType).toBe('vc2-2c-4gb');
    expect(VultrProvider.priceFor('vc2-2c-4gb', 'ewr')).toBe(20);
    expect(VultrProvider.priceFor('vc2-2c-4gb', 'sao')).toBe(30);
    expect(VultrProvider.priceFor('vhf-2c-4gb', 'ewr')).toBe(24);
  });
});

describe('Linode', () => {
  it('region prices override the base price', () => {
    restore = seedCatalog(LinodeProvider, '2026-10-22/linode');
    expect(LinodeProvider.priceFor('g6-standard-2', 'us-iad')).toBe(24);
    expect(LinodeProvider.priceFor('g6-standard-2', 'br-gru')).toBe(33.6);
    expect(LinodeProvider.getRegionDefaults('us-iad').composeType).toBe('g6-standard-2');
  });

  it('an unpriced type sorts after a priced one', () => {
    restore = seedCatalog(LinodeProvider, '2026-10-22/linode');
    // g8-dedicated-4-2 (2 vCPU, 4 GB) has price.monthly null.
    expect(LinodeProvider.priceFor('g8-dedicated-4-2', 'us-iad')).toBeNull();
    const pick = pickRoleType({
      candidates: ['g8-dedicated-4-2', 'g6-standard-2'],
      catalog: LinodeProvider.SERVER_TYPES,
      orderable: LinodeProvider._locationTypes['us-iad'],
      location: 'us-iad',
      priceFor: (t: string, l: string) => LinodeProvider.priceFor(t, l),
      isArm: () => false,
      minRamGb: ROLE_MIN_RAM_GB.compose,
    });
    expect(pick).toBe('g6-standard-2');
  });
});

describe('Scaleway', () => {
  it('fr-par-1: DEV1-M at €14.74', () => {
    restore = seedCatalog(ScalewayProvider, '2026-10-22/scaleway');
    expect(ScalewayProvider.getRegionDefaults('fr-par-1').composeType).toBe('DEV1-M');
    expect(ScalewayProvider.priceFor('DEV1-M', 'fr-par-1')).toBeCloseTo(14.74, 2);
  });

  it('offline keeps the audited default first', () => {
    expect(ScalewayProvider.getRegionDefaults('fr-par-1').composeType).toBe('BASIC3-X2C-4G');
  });
});

describe('offline: no live catalog means no price', () => {
  it.each(ALL.map((P) => [P.NAME, P]))('%s priceFor is null', (_name, P) => {
    expect(P._locationTypes).toBeNull();
    const type = P.ROLE_CANDIDATES.compose[0];
    expect(P.priceFor(type, P.DEFAULT_REGION)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchServerTypes captures the prices from the payload it already reads
// ---------------------------------------------------------------------------

function jsonResp(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Snapshot the catalog statics a live fetch replaces, and put them back. */
function snapshot(P: AnyProvider) {
  const keys = ['SERVER_TYPES', '_locationTypes', '_prices', '_typeArch'];
  const saved = keys.map((k) => [k, Object.hasOwn(P, k), P[k]] as const);
  return () => {
    for (const [k, owned, v] of saved) {
      if (owned) P[k] = v;
      else delete P[k];
    }
  };
}

describe('fetchServerTypes captures prices', () => {
  it('Hetzner: per location, from prices[].price_monthly.net', async () => {
    restore = snapshot(HetznerProvider);
    const fixture = readCatalogFixture('2026-10-22/hetzner');
    const fetchMock = vi.fn(async () =>
      jsonResp({ server_types: fixture.server_types, meta: { pagination: {} } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await HetznerProvider.fetchServerTypes('tok')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no extra request for prices
    expect(HetznerProvider._prices.cpx22).toMatchObject({ nbg1: 22.99, sin: 30.99 });
    expect(HetznerProvider.priceFor('cpx12', 'fsn1')).toBe(13.49);
  });

  it('DigitalOcean: flat, from price_monthly', async () => {
    restore = snapshot(DigitalOceanProvider);
    const fixture = readCatalogFixture('2026-10-22/digitalocean');
    const fetchMock = vi.fn(async () => jsonResp({ sizes: fixture.sizes, links: {} }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await DigitalOceanProvider.fetchServerTypes('tok')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(DigitalOceanProvider._prices['s-2vcpu-4gb']).toBe(24);
    expect(DigitalOceanProvider.priceFor('s-1vcpu-2gb-amd', 'sfo3')).toBe(14);
  });

  it('Vultr: monthly_cost, overridden per location by location_cost', async () => {
    restore = snapshot(VultrProvider);
    const fixture = readCatalogFixture('2026-10-22/vultr');
    const fetchMock = vi.fn(async () => jsonResp({ plans: fixture.plans, meta: { links: {} } }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await VultrProvider.fetchServerTypes('tok')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(VultrProvider.priceFor('vc2-2c-4gb', 'ord')).toBe(20);
    expect(VultrProvider.priceFor('vc2-2c-4gb', 'sao')).toBe(30);
    // A plan is priced only where it is sold.
    expect(VultrProvider.priceFor('vc2-1c-0.5gb', 'sao')).toBeNull();
  });

  it('Linode: base price per region, overridden by region_prices', async () => {
    restore = snapshot(LinodeProvider);
    const fixture = readCatalogFixture('2026-10-22/linode');
    const fetchMock = vi.fn(async () => jsonResp({ data: fixture.data, page: 1, pages: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await LinodeProvider.fetchServerTypes('tok')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(LinodeProvider.priceFor('g6-standard-2', 'us-ord')).toBe(24);
    expect(LinodeProvider.priceFor('g6-standard-2', 'br-gru')).toBe(33.6);
  });

  describe('Scaleway', () => {
    const fixture = readCatalogFixture('2026-10-22/scaleway');
    const zones = Object.keys(ScalewayProvider.REGIONS);

    /** The API's shape for one URL: products/servers, or its availability. */
    function bodyFor(url: string) {
      const zone = /zones\/([^/]+)\//.exec(url)?.[1] as string;
      const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? 1);
      if (page > 1) return { servers: {} };
      const z = fixture.zones[zone];
      if (url.includes('/availability')) {
        return {
          servers: Object.fromEntries(
            Object.entries<string>(z.availability).map(([n, a]) => [n, { availability: a }]),
          ),
        };
      }
      return { servers: z.servers };
    }

    it('per zone, from monthly_price; a shortage type is not orderable', async () => {
      restore = snapshot(ScalewayProvider);
      ScalewayProvider._locationTypes = null;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => jsonResp(bodyFor(url))),
      );
      expect(await ScalewayProvider.fetchServerTypes('tok')).toBe(true);
      expect(ScalewayProvider.priceFor('DEV1-M', 'fr-par-1')).toBeCloseTo(14.74, 2);
      expect(ScalewayProvider.priceFor('BASIC3-X2C-4G', 'nl-ams-1')).toBeCloseTo(28.8, 2);
      expect(ScalewayProvider._locationTypes['fr-par-1'].has('BASIC3-X2C-4G')).toBe(true); // scarce
      expect(fixture.zones['fr-par-1'].availability['COMPUTE3-X32C-64G']).toBe('shortage');
      expect(ScalewayProvider._locationTypes['fr-par-1'].has('COMPUTE3-X32C-64G')).toBe(false);
    });

    it('issues every zone request before awaiting any', async () => {
      restore = snapshot(ScalewayProvider);
      ScalewayProvider._locationTypes = null;
      const pending: Array<() => void> = [];
      const urls: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (url: string) =>
            new Promise((resolve) => {
              urls.push(url);
              pending.push(() => resolve(jsonResp(bodyFor(url))));
            }),
        ),
      );
      const done = ScalewayProvider.fetchServerTypes('tok');
      await new Promise((r) => setImmediate(r));
      // Nothing has answered yet, and every zone's servers and availability
      // walk has already started.
      const firstPages = urls.filter((u) => /[?&]page=1(&|$)/.test(u));
      for (const zone of zones) {
        expect(firstPages).toContain(
          `https://api.scaleway.com/instance/v1/zones/${zone}/products/servers?per_page=100&page=1`,
        );
        expect(firstPages).toContain(
          `https://api.scaleway.com/instance/v1/zones/${zone}/products/servers/availability?per_page=100&page=1`,
        );
      }
      // Drain: answer every request, including later pages as they arrive.
      while (pending.length > 0) {
        pending.shift()?.();
        await new Promise((r) => setImmediate(r));
      }
      expect(await done).toBe(true);
    });

    it('a failed availability walk fails the fetch, like a failed servers walk', async () => {
      restore = snapshot(ScalewayProvider);
      ScalewayProvider._locationTypes = null;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
          url.includes('/availability') ? jsonResp({}, 403) : jsonResp(bodyFor(url)),
        ),
      );
      expect(await ScalewayProvider.fetchServerTypes('tok')).toBe(false);
      expect(ScalewayProvider._locationTypes).toBeNull();
    });
  });
});
