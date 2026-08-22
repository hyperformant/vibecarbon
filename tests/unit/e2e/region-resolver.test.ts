import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CapacityPreferences,
  clearResolverCache,
  overrideRegions,
  resolveCapacity,
  resolveCapacityPair,
} from '../../e2e/utils/region-resolver.js';

interface DC {
  name: string;
  loc: string;
  available: number[];
  supported?: number[];
}

/**
 * Minimal stub of the two Hetzner endpoints the resolver hits. Returns
 * a `fetch`-shaped function whose `ok`/`json` matches what the real API
 * returns. Server-type IDs match production: cx23=114, cx33=115, cpx21=23,
 * cpx31=24, cpx22=45, cpx32=46. All x86 — vibecarbon is amd64-only, so an ARM
 * pair is never a legal capacityPreferences entry.
 */
function makeFetch(dcs: DC[], typeNameToId: Record<string, number>): typeof fetch {
  const datacenters = dcs.map((d) => ({
    name: d.name,
    location: { name: d.loc },
    server_types: { available: d.available, supported: d.supported ?? d.available },
  }));
  const server_types = Object.entries(typeNameToId).map(([name, id]) => ({ id, name }));
  return (async (url: string) => {
    const body = url.includes('/datacenters') ? { datacenters } : { server_types };
    return {
      ok: true,
      status: 200,
      json: async () => body,
    };
  }) as unknown as typeof fetch;
}

const STD_TYPE_IDS = { cx23: 114, cx33: 115, cpx21: 23, cpx31: 24, cpx22: 45, cpx32: 46 };

/**
 * Minimal stub of the single DigitalOcean endpoint the resolver hits
 * (`/v2/sizes`) — unlike Hetzner, region availability is inline on each
 * size, so there's no separate "datacenters" call to stub.
 */
function makeDigitalOceanFetch(sizes: Array<{ slug: string; regions: string[] }>): typeof fetch {
  return (async (url: string) => {
    if (!url.includes('/sizes')) throw new Error(`unexpected DO URL: ${url}`);
    return {
      ok: true,
      status: 200,
      json: async () => ({ sizes }),
    };
  }) as unknown as typeof fetch;
}

afterEach(() => {
  clearResolverCache();
});

describe('resolveCapacity', () => {
  it('picks the first preferred region whose DC has both pair types available', async () => {
    const prefs: CapacityPreferences = {
      regions: ['nbg1', 'hel1', 'fsn1'],
      typePairs: [['cx23', 'cx33']],
    };
    const fetchFn = makeFetch(
      [
        // hel1 has cx23 only — skip
        { name: 'hel1-dc2', loc: 'hel1', available: [114] },
        // nbg1 has both — but it's listed first so should win regardless of hel1
        { name: 'nbg1-dc3', loc: 'nbg1', available: [114, 115] },
        { name: 'fsn1-dc14', loc: 'fsn1', available: [114, 115] },
      ],
      STD_TYPE_IDS,
    );

    const r = await resolveCapacity(prefs, 't', { fetchFn });
    expect(r).toEqual({
      region: 'nbg1',
      serverType: 'cx23',
      scaleToType: 'cx33',
      datacenter: 'nbg1-dc3',
    });
  });

  it('falls back to a later region when earlier ones lack capacity', async () => {
    const prefs: CapacityPreferences = {
      regions: ['hel1', 'nbg1', 'fsn1'],
      typePairs: [['cx23', 'cx33']],
    };
    const fetchFn = makeFetch(
      [
        { name: 'hel1-dc2', loc: 'hel1', available: [114] }, // missing cx33
        { name: 'nbg1-dc3', loc: 'nbg1', available: [114, 115] },
      ],
      STD_TYPE_IDS,
    );
    const r = await resolveCapacity(prefs, 't', { fetchFn });
    expect(r.region).toBe('nbg1');
  });

  it('falls back to a later type-pair when no region has the first pair', async () => {
    const prefs: CapacityPreferences = {
      regions: ['ash', 'hil'],
      typePairs: [
        ['cx23', 'cx33'], // not supported in US DCs at all
        ['cpx21', 'cpx31'],
      ],
    };
    const fetchFn = makeFetch([{ name: 'ash-dc1', loc: 'ash', available: [23, 24] }], STD_TYPE_IDS);
    const r = await resolveCapacity(prefs, 't', { fetchFn });
    expect(r).toEqual({
      region: 'ash',
      serverType: 'cpx21',
      scaleToType: 'cpx31',
      datacenter: 'ash-dc1',
    });
  });

  it('honors excludeRegions (used by the HA pair resolver to push standby elsewhere)', async () => {
    const prefs: CapacityPreferences = {
      regions: ['nbg1', 'fsn1'],
      typePairs: [['cx23', 'cx33']],
    };
    const fetchFn = makeFetch(
      [
        { name: 'nbg1-dc3', loc: 'nbg1', available: [114, 115] },
        { name: 'fsn1-dc14', loc: 'fsn1', available: [114, 115] },
      ],
      STD_TYPE_IDS,
    );
    const r = await resolveCapacity(prefs, 't', {
      fetchFn,
      excludeRegions: ['nbg1'],
    });
    expect(r.region).toBe('fsn1');
  });

  it('throws a helpful error when no region/type-pair combo fits', async () => {
    const prefs: CapacityPreferences = {
      regions: ['hel1'],
      typePairs: [['cx23', 'cx33']],
    };
    const fetchFn = makeFetch([{ name: 'hel1-dc2', loc: 'hel1', available: [114] }], STD_TYPE_IDS);
    await expect(resolveCapacity(prefs, 't', { fetchFn })).rejects.toThrow(
      /no Hetzner region has a viable type-pair/,
    );
  });

  it('caches API responses across calls (fetch invoked once per endpoint)', async () => {
    const prefs: CapacityPreferences = {
      regions: ['nbg1'],
      typePairs: [['cx23', 'cx33']],
    };
    const fn = vi.fn(
      makeFetch([{ name: 'nbg1-dc3', loc: 'nbg1', available: [114, 115] }], STD_TYPE_IDS),
    );
    await resolveCapacity(prefs, 't', { fetchFn: fn as unknown as typeof fetch });
    await resolveCapacity(prefs, 't', { fetchFn: fn as unknown as typeof fetch });
    // Two endpoints (datacenters, server_types) hit once total.
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('returns a clear error if the API returns non-2xx', async () => {
    const fetchFn = (async () => ({ ok: false, status: 502 })) as unknown as typeof fetch;
    await expect(
      resolveCapacity({ regions: ['nbg1'], typePairs: [['cx23', 'cx33']] }, 't', { fetchFn }),
    ).rejects.toThrow(/GET \/datacenters → 502/);
  });

  describe('provider: digitalocean', () => {
    it('picks the first preferred region where both type-pair slugs are available', async () => {
      const prefs: CapacityPreferences = {
        regions: ['nyc3', 'sfo3', 'ams3', 'fra1'],
        typePairs: [['s-2vcpu-4gb', 's-4vcpu-8gb']],
      };
      const fetchFn = makeDigitalOceanFetch([
        // sfo3 only has the small type — skip
        { slug: 's-2vcpu-4gb', regions: ['nyc3', 'sfo3', 'ams3', 'fra1'] },
        // nyc3 is listed first and has both — should win over ams3/fra1
        { slug: 's-4vcpu-8gb', regions: ['nyc3', 'ams3', 'fra1'] },
      ]);

      const r = await resolveCapacity(prefs, 't', { fetchFn, provider: 'digitalocean' });
      expect(r).toEqual({
        region: 'nyc3',
        serverType: 's-2vcpu-4gb',
        scaleToType: 's-4vcpu-8gb',
        datacenter: 'nyc3',
      });
    });

    it('falls back to a later region when an earlier one lacks the scale type', async () => {
      const prefs: CapacityPreferences = {
        regions: ['sfo3', 'nyc3'],
        typePairs: [['s-2vcpu-4gb', 's-4vcpu-8gb']],
      };
      const fetchFn = makeDigitalOceanFetch([
        { slug: 's-2vcpu-4gb', regions: ['sfo3', 'nyc3'] },
        { slug: 's-4vcpu-8gb', regions: ['nyc3'] }, // missing in sfo3
      ]);
      const r = await resolveCapacity(prefs, 't', { fetchFn, provider: 'digitalocean' });
      expect(r.region).toBe('nyc3');
    });

    it('throws a helpful error when no region has both slugs', async () => {
      const prefs: CapacityPreferences = {
        regions: ['nyc3'],
        typePairs: [['s-2vcpu-4gb', 's-4vcpu-8gb']],
      };
      const fetchFn = makeDigitalOceanFetch([{ slug: 's-2vcpu-4gb', regions: ['nyc3'] }]);
      await expect(
        resolveCapacity(prefs, 't', { fetchFn, provider: 'digitalocean' }),
      ).rejects.toThrow(/no DigitalOcean region has a viable type-pair/);
    });
  });
});

describe('resolveCapacityPair', () => {
  it('picks two distinct regions sharing the first viable type-pair', async () => {
    const prefs: CapacityPreferences = {
      regions: ['nbg1', 'hel1', 'fsn1'],
      typePairs: [['cx23', 'cx33']],
    };
    const fetchFn = makeFetch(
      [
        { name: 'nbg1-dc3', loc: 'nbg1', available: [114, 115] },
        { name: 'hel1-dc2', loc: 'hel1', available: [114, 115] },
      ],
      STD_TYPE_IDS,
    );
    const { primary, standby } = await resolveCapacityPair(prefs, 't', { fetchFn });
    expect(primary.region).toBe('nbg1');
    expect(standby.region).toBe('hel1');
    // Same arch family on both sides — non-negotiable.
    expect(primary.serverType).toBe(standby.serverType);
    expect(primary.scaleToType).toBe(standby.scaleToType);
  });

  it('skips a type-pair if only one region has it (HA needs two)', async () => {
    const prefs: CapacityPreferences = {
      regions: ['nbg1', 'fsn1'],
      typePairs: [
        ['cx23', 'cx33'], // only nbg1 has it → can't HA on cx
        ['cpx22', 'cpx32'], // both nbg1 and fsn1 have it → use this
      ],
    };
    const fetchFn = makeFetch(
      [
        { name: 'nbg1-dc3', loc: 'nbg1', available: [114, 115, 45, 46] },
        { name: 'fsn1-dc14', loc: 'fsn1', available: [45, 46] },
      ],
      STD_TYPE_IDS,
    );
    const { primary, standby } = await resolveCapacityPair(prefs, 't', { fetchFn });
    expect(primary.serverType).toBe('cpx22');
    expect(standby.serverType).toBe('cpx22');
    expect(new Set([primary.region, standby.region])).toEqual(new Set(['nbg1', 'fsn1']));
  });

  it('throws when no type-pair has two viable regions', async () => {
    const prefs: CapacityPreferences = {
      regions: ['nbg1', 'fsn1'],
      typePairs: [['cx23', 'cx33']],
    };
    const fetchFn = makeFetch(
      [{ name: 'nbg1-dc3', loc: 'nbg1', available: [114, 115] }],
      STD_TYPE_IDS,
    );
    await expect(resolveCapacityPair(prefs, 't', { fetchFn })).rejects.toThrow(
      /HA needs two distinct regions/,
    );
  });

  describe('provider: digitalocean', () => {
    it('picks two distinct regions sharing the first viable type-pair', async () => {
      const prefs: CapacityPreferences = {
        regions: ['nyc3', 'sfo3', 'ams3'],
        typePairs: [['s-2vcpu-4gb', 's-4vcpu-8gb']],
      };
      const fetchFn = makeDigitalOceanFetch([
        { slug: 's-2vcpu-4gb', regions: ['nyc3', 'sfo3', 'ams3'] },
        { slug: 's-4vcpu-8gb', regions: ['nyc3', 'sfo3'] }, // ams3 missing scale type
      ]);
      const { primary, standby } = await resolveCapacityPair(prefs, 't', {
        fetchFn,
        provider: 'digitalocean',
      });
      expect(primary.region).toBe('nyc3');
      expect(standby.region).toBe('sfo3');
      expect(primary.serverType).toBe(standby.serverType);
      expect(primary.scaleToType).toBe(standby.scaleToType);
    });

    it('throws when no type-pair has two viable regions', async () => {
      const prefs: CapacityPreferences = {
        regions: ['nyc3', 'sfo3'],
        typePairs: [['s-2vcpu-4gb', 's-4vcpu-8gb']],
      };
      const fetchFn = makeDigitalOceanFetch([
        { slug: 's-2vcpu-4gb', regions: ['nyc3'] },
        { slug: 's-4vcpu-8gb', regions: ['nyc3'] },
      ]);
      await expect(
        resolveCapacityPair(prefs, 't', { fetchFn, provider: 'digitalocean' }),
      ).rejects.toThrow(/HA needs two distinct DigitalOcean regions/);
    });
  });
});

describe('overrideRegions (E2E_REGIONS knob)', () => {
  const base: CapacityPreferences = {
    regions: ['nbg1', 'hel1', 'fsn1'],
    typePairs: [['cx23', 'cx33']],
  };

  it('returns prefs unchanged when csv is undefined or empty', () => {
    expect(overrideRegions(base, undefined)).toBe(base);
    expect(overrideRegions(base, '')).toBe(base);
    expect(overrideRegions(base, ' , ,')).toBe(base);
  });

  it('replaces the region list, trimming whitespace and dropping empties', () => {
    const out = overrideRegions(base, ' ash , hil ,');
    expect(out.regions).toEqual(['ash', 'hil']);
    expect(out.typePairs).toBe(base.typePairs); // untouched
    expect(base.regions).toEqual(['nbg1', 'hel1', 'fsn1']); // no mutation
  });
});
