/**
 * Unit tests for lib/sizing.js, the shared default-size picker: per role,
 * the cheapest orderable amd64 server that meets the role's RAM floor, priced
 * at the target location.
 *
 * The provider-level tests run against a stub shaped like HetznerProvider
 * (ROLE_CANDIDATES, IPV4_MONTHLY, priceFor), seeded from the dated catalog
 * fixtures. Task 2 of the price-optimized defaults plan gives the real
 * provider classes those statics and switches these tests to them.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';
import { ScalewayProvider } from '../../../src/lib/providers/scaleway.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';
import {
  cheapestRoleSet,
  pickRoleType,
  ROLE_MIN_RAM_GB,
  rankLocationsByPrice,
} from '../../../src/lib/sizing.js';
import { seedCatalog } from '../helpers/catalog-fixtures.js';

const catalog = {
  cx23: { ram: 4, architecture: 'x86' },
  cpx22: { ram: 4, architecture: 'x86' },
  cpx32: { ram: 8, architecture: 'x86' },
  cpx12: { ram: 2, architecture: 'x86' },
  cax11: { ram: 4, architecture: 'arm' },
};
const flat = { cx23: 6.49, cpx22: 22.99, cpx32: 41.99, cpx12: 13.49, cax11: 6.99 };
const base = {
  catalog,
  location: 'nbg1',
  priceFor: (t: string) => flat[t] ?? null,
  isArm: (t: string) => t.startsWith('cax'),
};

describe('ROLE_MIN_RAM_GB', () => {
  it('is the P1 table: 2x measured peak, compose never under 4 GB', () => {
    expect(ROLE_MIN_RAM_GB).toEqual({ compose: 4, master: 4, db: 2, worker: 4 });
    expect(Object.isFrozen(ROLE_MIN_RAM_GB)).toBe(true);
  });
});

describe('pickRoleType', () => {
  it('sorts by price, not declared order', () => {
    expect(
      pickRoleType({
        ...base,
        candidates: ['cpx32', 'cpx22', 'cx23'],
        orderable: new Set(['cpx22', 'cpx32']),
        minRamGb: 4,
      }),
    ).toBe('cpx22');
    expect(
      pickRoleType({
        ...base,
        candidates: ['cpx32', 'cpx22', 'cx23'],
        orderable: new Set(['cx23', 'cpx22']),
        minRamGb: 4,
      }),
    ).toBe('cx23');
  });

  it('takes more RAM than the floor when it is cheaper', () => {
    expect(
      pickRoleType({
        ...base,
        candidates: ['cpx12', 'cx23'],
        orderable: new Set(['cpx12', 'cx23']),
        minRamGb: ROLE_MIN_RAM_GB.db,
      }),
    ).toBe('cx23');
  });

  it('drops a candidate below the floor, even when it is cheapest', () => {
    expect(
      pickRoleType({
        ...base,
        candidates: ['cpx12', 'cpx22'],
        orderable: new Set(['cpx12', 'cpx22']),
        minRamGb: 4,
      }),
    ).toBe('cpx22');
  });

  it('never returns ARM, even when it is cheapest', () => {
    expect(
      pickRoleType({
        ...base,
        candidates: ['cax11', 'cpx22'],
        orderable: new Set(['cax11', 'cpx22']),
        minRamGb: 4,
      }),
    ).toBe('cpx22');
  });

  it('drops a type whose catalog entry is not amd64, even when isArm misses it', () => {
    expect(
      pickRoleType({
        ...base,
        isArm: () => false,
        candidates: ['cax11', 'cpx22'],
        orderable: new Set(['cax11', 'cpx22']),
        minRamGb: 4,
      }),
    ).toBe('cpx22');
  });

  it('drops a candidate missing from the catalog', () => {
    expect(
      pickRoleType({
        ...base,
        candidates: ['cx53', 'cpx22'],
        orderable: new Set(['cx53', 'cpx22']),
        minRamGb: 4,
      }),
    ).toBe('cpx22');
  });

  it('offline (no prices) keeps declared order', () => {
    expect(
      pickRoleType({
        ...base,
        priceFor: () => null,
        candidates: ['cpx22', 'cx23'],
        orderable: new Set(['cpx22', 'cx23']),
        minRamGb: 4,
      }),
    ).toBe('cpx22');
  });

  it('unknown prices sort after known ones', () => {
    const priceFor = (t: string) => (t === 'cpx32' ? 41.99 : null);
    expect(
      pickRoleType({
        ...base,
        priceFor,
        candidates: ['cpx22', 'cpx32'],
        orderable: new Set(['cpx22', 'cpx32']),
        minRamGb: 4,
      }),
    ).toBe('cpx32');
  });

  it('equal prices keep declared order', () => {
    const priceFor = () => 10;
    expect(
      pickRoleType({
        ...base,
        priceFor,
        candidates: ['cx23', 'cpx22'],
        orderable: new Set(['cpx22', 'cx23']),
        minRamGb: 4,
      }),
    ).toBe('cx23');
  });

  it('returns null when nothing fits', () => {
    expect(
      pickRoleType({ ...base, candidates: ['cpx22'], orderable: new Set(), minRamGb: 4 }),
    ).toBeNull();
  });

  it('Review Focus 5: prices by the target location', () => {
    const seen: string[] = [];
    const priceFor = (_t: string, loc: string) => {
      seen.push(loc);
      return loc === 'ash' ? 20.49 : 5.99;
    };
    pickRoleType({
      ...base,
      priceFor,
      location: 'ash',
      candidates: ['cpx22', 'cx23'],
      orderable: new Set(['cpx22', 'cx23']),
      minRamGb: 4,
    });
    expect(new Set(seen)).toEqual(new Set(['ash']));
  });
});

// A HetznerProvider-shaped stub until Task 2 gives the real class these
// statics. The catalog state (SERVER_TYPES, _locationTypes, _prices) comes
// from seedCatalog, exactly as it would land on the real class.
function hetznerStub(
  roleCandidates: Record<string, string[]> = { compose: ['cpx22', 'cx23', 'cpx21'] },
) {
  return {
    ROLE_CANDIDATES: roleCandidates,
    IPV4_MONTHLY: 0.6 as number | undefined,
    SERVER_TYPES: {},
    _locationTypes: null,
    _prices: null,
    isArmServerType: (t: string) => HetznerProvider.isArmServerType(t),
    getServerTypesForRegion: (_region: string) => [] as Array<{ name: string; ram: number }>,
    priceFor(type: string, location: string) {
      return this._prices?.[type]?.[location] ?? null;
    },
  };
}

const K8S_CANDIDATES = {
  master: ['cpx22', 'cx23', 'cpx21'],
  db: ['cpx12', 'cx23', 'cpx22', 'cpx11'],
  worker: ['cpx22', 'cx23', 'cpx21'],
};

describe('rankLocationsByPrice', () => {
  let HetznerStub: ReturnType<typeof hetznerStub>;
  let restore: () => void;
  afterEach(() => restore?.());

  describe('flux fixture', () => {
    beforeEach(() => {
      HetznerStub = hetznerStub();
      restore = seedCatalog(HetznerStub, 'flux-hetzner-cx23-hel1');
    });

    it('cx23 stocked in hel1 only puts hel1 first at $7.09', () => {
      const ranked = rankLocationsByPrice(HetznerStub, ['nbg1', 'fsn1', 'hel1'], ['compose']);
      expect(ranked[0]).toMatchObject({
        location: 'hel1',
        monthly: 7.09,
        types: { compose: 'cx23' },
      });
      expect(ranked.map((r) => r.location)).toEqual(['hel1', 'nbg1', 'fsn1']);
    });
  });

  describe('2026-10-22 fixture', () => {
    beforeEach(() => {
      HetznerStub = hetznerStub();
      restore = seedCatalog(HetznerStub, '2026-10-22/hetzner');
    });

    it('the EU ties at $23.59 and keeps the given order', () => {
      const ranked = rankLocationsByPrice(HetznerStub, ['nbg1', 'fsn1', 'hel1'], ['compose']);
      expect(ranked.map((r) => [r.location, r.monthly])).toEqual([
        ['nbg1', 23.59],
        ['fsn1', 23.59],
        ['hel1', 23.59],
      ]);
    });

    it('omits a location where a role is unorderable', () => {
      restore();
      restore = seedCatalog(HetznerStub, '2026-10-22/hetzner', { drop: { fsn1: ['cpx22'] } });
      const ranked = rankLocationsByPrice(HetznerStub, ['nbg1', 'fsn1', 'hel1'], ['compose']);
      expect(ranked.map((r) => r.location)).toEqual(['nbg1', 'hel1']);
    });

    it('sorts by price across geographies (sin and ash cost more)', () => {
      const ranked = rankLocationsByPrice(HetznerStub, ['ash', 'sin', 'nbg1'], ['compose']);
      expect(ranked).toEqual([
        { location: 'nbg1', monthly: 23.59, types: { compose: 'cpx22' } },
        { location: 'sin', monthly: 31.59, types: { compose: 'cpx22' } },
        { location: 'ash', monthly: 38.09, types: { compose: 'cpx21' } },
      ]);
    });
  });
});

describe('cheapestRoleSet', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('k8s in nbg1: 4 GB master and worker, 2 GB db, one IPv4 per server', () => {
    const P = hetznerStub(K8S_CANDIDATES);
    restore = seedCatalog(P, '2026-10-22/hetzner');
    // 22.99 + 13.49 + 22.99 + 3 x 0.60
    expect(cheapestRoleSet(P, 'nbg1', ['master', 'db', 'worker'])).toEqual({
      types: { master: 'cpx22', db: 'cpx12', worker: 'cpx22' },
      monthly: 61.27,
    });
  });

  it('flux fixture: cx23 in hel1 wins every k8s role there', () => {
    const P = hetznerStub(K8S_CANDIDATES);
    restore = seedCatalog(P, 'flux-hetzner-cx23-hel1');
    expect(cheapestRoleSet(P, 'hel1', ['master', 'db', 'worker'])).toEqual({
      types: { master: 'cx23', db: 'cx23', worker: 'cx23' },
      monthly: 21.27,
    });
  });

  it('ash: the US line and its price', () => {
    const P = hetznerStub(K8S_CANDIDATES);
    restore = seedCatalog(P, '2026-10-22/hetzner');
    // 37.49 + 20.49 + 2 x 0.60
    expect(cheapestRoleSet(P, 'ash', ['master', 'db'])).toEqual({
      types: { master: 'cpx21', db: 'cpx11' },
      monthly: 59.18,
    });
  });

  it('returns null when any role is unorderable', () => {
    const P = hetznerStub(K8S_CANDIDATES);
    restore = seedCatalog(P, '2026-10-22/hetzner', { drop: { nbg1: ['cpx12', 'cpx22'] } });
    expect(cheapestRoleSet(P, 'nbg1', ['master', 'db'])).toBeNull();
  });

  it('returns null for a role the provider declares no candidates for', () => {
    const P = hetznerStub();
    restore = seedCatalog(P, '2026-10-22/hetzner');
    expect(cheapestRoleSet(P, 'nbg1', ['compose', 'db'])).toBeNull();
  });

  it('monthly is null when a price is unknown, or the IPv4 price is', () => {
    const P = hetznerStub();
    restore = seedCatalog(P, '2026-10-22/hetzner');
    P._prices.cpx22 = { nbg1: null };
    expect(cheapestRoleSet(P, 'nbg1', ['compose'])).toEqual({
      types: { compose: 'cpx22' },
      monthly: null,
    });

    const Q = hetznerStub();
    Q.IPV4_MONTHLY = undefined;
    const restoreQ = seedCatalog(Q, '2026-10-22/hetzner');
    try {
      expect(cheapestRoleSet(Q, 'nbg1', ['compose'])?.monthly).toBeNull();
    } finally {
      restoreQ();
    }
  });

  it('offline (no live catalog): the provider offer list, declared order, no price', () => {
    const P = hetznerStub();
    P.getServerTypesForRegion = (region: string) =>
      region === 'ash'
        ? [
            { name: 'cpx21', ram: 4 },
            { name: 'cpx11', ram: 2 },
          ]
        : [
            { name: 'cx23', ram: 4 },
            { name: 'cpx22', ram: 4 },
          ];
    expect(cheapestRoleSet(P, 'nbg1', ['compose'])).toEqual({
      types: { compose: 'cpx22' },
      monthly: null,
    });
    expect(cheapestRoleSet(P, 'ash', ['compose'])).toEqual({
      types: { compose: 'cpx21' },
      monthly: null,
    });
  });
});

describe('seedCatalog', () => {
  it('seeds a real provider class and restores it exactly', () => {
    const before = {
      types: HetznerProvider.SERVER_TYPES,
      locations: HetznerProvider._locationTypes,
      ownsPrices: Object.hasOwn(HetznerProvider, '_prices'),
    };
    const restore = seedCatalog(HetznerProvider, '2026-10-22/hetzner');
    // biome-ignore lint/suspicious/noExplicitAny: _prices is not on the class until Task 2
    const P = HetznerProvider as any;
    expect(P._locationTypes.nbg1.has('cpx22')).toBe(true);
    expect(P._locationTypes.nbg1.has('cx23')).toBe(false); // available: false on 2026-10-22
    expect(P._locationTypes.nbg1.has('cpx21')).toBe(false); // deprecated in the EU
    expect(P._locationTypes.ash.has('cpx21')).toBe(true);
    expect(P.SERVER_TYPES).not.toHaveProperty('cax11'); // ARM dropped, as fetchServerTypes does
    expect(P._prices.cpx22.sin).toBe(30.99);
    expect(P._prices.cpx22.nbg1).toBe(22.99);
    restore();
    expect(HetznerProvider.SERVER_TYPES).toBe(before.types);
    expect(HetznerProvider._locationTypes).toBe(before.locations);
    expect(Object.hasOwn(HetznerProvider, '_prices')).toBe(before.ownsPrices);
  });

  it('flux fixture differs from 2026-10-22 only in cx23 being orderable in hel1', () => {
    const restore = seedCatalog(HetznerProvider, 'flux-hetzner-cx23-hel1');
    try {
      expect(HetznerProvider._locationTypes?.hel1.has('cx23')).toBe(true);
      expect(HetznerProvider._locationTypes?.nbg1.has('cx23')).toBe(false);
      expect(HetznerProvider._locationTypes?.fsn1.has('cx23')).toBe(false);
    } finally {
      restore();
    }
  });

  it('DigitalOcean: the 4 GB basic size is not sold in sfo3, its -amd variant is', () => {
    const restore = seedCatalog(DigitalOceanProvider, '2026-10-22/digitalocean');
    // biome-ignore lint/suspicious/noExplicitAny: _prices is not on the class until Task 2
    const P = DigitalOceanProvider as any;
    try {
      expect(P._locationTypes.sfo3.has('s-2vcpu-4gb')).toBe(false);
      expect(P._locationTypes.sfo3.has('s-2vcpu-4gb-amd')).toBe(true);
      expect(P._locationTypes.nyc3.has('s-1vcpu-2gb')).toBe(true);
      expect(P.SERVER_TYPES['s-2vcpu-4gb'].ram).toBe(4);
      expect(P._prices['s-2vcpu-4gb']).toBe(24);
      expect(P._prices['s-2vcpu-4gb-intel']).toBe(28);
    } finally {
      restore();
    }
  });

  it('Scaleway: DEV1-M at 14.74 per zone, a shortage type is not orderable', () => {
    const restore = seedCatalog(ScalewayProvider, '2026-10-22/scaleway');
    // biome-ignore lint/suspicious/noExplicitAny: _prices is not on the class until Task 2
    const P = ScalewayProvider as any;
    try {
      expect(P._prices['DEV1-M']['fr-par-1']).toBeCloseTo(14.74, 2);
      expect(P.SERVER_TYPES['DEV1-M']).toMatchObject({ vcpu: 3, ram: 4 });
      expect(P._locationTypes['fr-par-1'].has('DEV1-M')).toBe(true);
      expect(P._locationTypes['fr-par-1'].has('BASIC3-X2C-4G')).toBe(true); // scarce stays
      expect(P._locationTypes['fr-par-1'].has('COMPUTE3-X32C-64G')).toBe(false); // shortage
      expect(P.isArmServerType('BASIC2-A12C-24G')).toBe(true); // _typeArch seeded
    } finally {
      restore();
    }
  });

  it('Linode: region prices override the base, dedicated plans carry no price', () => {
    const restore = seedCatalog(LinodeProvider, '2026-10-22/linode');
    // biome-ignore lint/suspicious/noExplicitAny: _prices is not on the class until Task 2
    const P = LinodeProvider as any;
    try {
      expect(P._prices['g6-standard-2']['us-iad']).toBe(24);
      expect(P._locationTypes['us-iad'].has('g6-standard-2')).toBe(true);
      expect(P._prices['g8-dedicated-4-2']['us-iad']).toBeNull();
    } finally {
      restore();
    }
  });

  it('Vultr: flat plan prices and per-plan locations', () => {
    const restore = seedCatalog(VultrProvider, '2026-10-22/vultr');
    // biome-ignore lint/suspicious/noExplicitAny: _prices is not on the class until Task 2
    const P = VultrProvider as any;
    try {
      expect(P._prices['vc2-2c-4gb']).toBe(20);
      expect(P._prices['vhf-2c-4gb']).toBe(24);
      expect(P._locationTypes.ewr.has('vc2-2c-4gb')).toBe(true);
    } finally {
      restore();
    }
  });
});
