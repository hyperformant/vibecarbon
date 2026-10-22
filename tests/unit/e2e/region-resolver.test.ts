import { afterEach, describe, expect, it, vi } from 'vitest';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import {
  type CapacityPreferences,
  deployedScaleTarget,
  overrideRegions,
  resolveCapacity,
  resolveCapacityPair,
} from '../../e2e/utils/region-resolver.js';
import { seedCatalog } from '../helpers/catalog-fixtures.js';

// The resolver reads the provider's own catalog (fetchServerTypes) and runs
// the customer's price picker over it. Here the class is seeded from a dated
// fixture and `loadCatalog` is injected, so nothing touches the network.
const seeded = async () => true;

const HETZNER: CapacityPreferences = {
  regions: ['nbg1', 'hel1', 'fsn1'],
  scaleTo: { cpx22: 'cpx32', cpx12: 'cpx22', cx23: 'cx33', cpx21: 'cpx31' },
};

let restore: (() => void) | null = null;
function seedHetzner(fixture = '2026-10-22/hetzner', options = {}) {
  restore = seedCatalog(HetznerProvider, fixture, options);
}
afterEach(() => {
  restore?.();
  restore = null;
  vi.restoreAllMocks();
});

describe('resolveCapacity', () => {
  it('picks the first preferred region the picker can place, and pins no server type', async () => {
    seedHetzner();
    const r = await resolveCapacity(HETZNER, 't', { mode: 'compose', loadCatalog: seeded });
    expect(r).toEqual({
      region: 'nbg1',
      serverType: undefined,
      types: { compose: 'cpx22' },
      datacenter: 'nbg1',
    });
  });

  it('resolves every k8s role, the db on its own 2 GB pick', async () => {
    seedHetzner();
    const r = await resolveCapacity(HETZNER, 't', { mode: 'k8s', loadCatalog: seeded });
    expect(r.types).toEqual({ master: 'cpx22', db: 'cpx12', worker: 'cpx22' });
    expect(r.serverType).toBeUndefined();
  });

  it('skips a region where a role has nothing orderable', async () => {
    seedHetzner('2026-10-22/hetzner', { drop: { nbg1: ['cpx22', 'cx23', 'cpx21'] } });
    const r = await resolveCapacity(HETZNER, 't', { mode: 'compose', loadCatalog: seeded });
    expect(r.region).toBe('hel1');
  });

  it("skips a region that does not sell the default's scale target", async () => {
    seedHetzner('2026-10-22/hetzner', { drop: { nbg1: ['cpx32'] } });
    const r = await resolveCapacity(HETZNER, 't', { mode: 'compose', loadCatalog: seeded });
    expect(r.region).toBe('hel1');
  });

  it('honours excludeRegions', async () => {
    seedHetzner();
    const r = await resolveCapacity(HETZNER, 't', {
      mode: 'compose',
      excludeRegions: ['nbg1'],
      loadCatalog: seeded,
    });
    expect(r.region).toBe('hel1');
  });

  it('fails naming the type when the default has no ladder entry', async () => {
    seedHetzner();
    await expect(
      resolveCapacity({ regions: ['nbg1'], scaleTo: {} }, 't', {
        mode: 'compose',
        loadCatalog: seeded,
      }),
    ).rejects.toThrow('no scale target for cpx22 in tests/config.ts scaleTo');
  });

  it('fails naming the provider when no catalog can be read, and never guesses a type', async () => {
    seedHetzner();
    await expect(
      resolveCapacity(HETZNER, '', { mode: 'compose', loadCatalog: async () => false }),
    ).rejects.toThrow(/Hetzner Cloud catalog/);
  });

  it('reads the live catalog through the provider class, as the CLI does', async () => {
    seedHetzner();
    const fetchSpy = vi.spyOn(HetznerProvider, 'fetchServerTypes').mockResolvedValue(true);
    await resolveCapacity(HETZNER, 'tok', { mode: 'compose' });
    expect(fetchSpy).toHaveBeenCalledWith('tok');
  });

  it('lists what it tried when no region fits', async () => {
    seedHetzner('2026-10-22/hetzner', {
      drop: { nbg1: ['cpx22'], hel1: ['cpx22'], fsn1: ['cpx22'] },
    });
    await expect(
      resolveCapacity(HETZNER, 't', { mode: 'compose', loadCatalog: seeded }),
    ).rejects.toThrow(/tried regions=\[nbg1,hel1,fsn1\]/);
  });
});

describe('resolveCapacityPair', () => {
  it('pairs two distinct same-continent regions, neither pinning a type', async () => {
    seedHetzner();
    const { primary, standby } = await resolveCapacityPair(HETZNER, 't', {
      mode: 'compose-ha',
      loadCatalog: seeded,
    });
    expect(primary).toMatchObject({ region: 'nbg1', serverType: undefined });
    expect(standby).toMatchObject({ region: 'hel1', serverType: undefined });
  });

  it('allows the two sides different types, each the cheapest where it sits', async () => {
    // The flux catalog stocks cx23 in hel1 only, where it undercuts cpx22.
    seedHetzner('flux-hetzner-cx23-hel1');
    const { primary, standby } = await resolveCapacityPair(HETZNER, 't', {
      mode: 'compose-ha',
      loadCatalog: seeded,
    });
    expect(primary.types).toEqual({ compose: 'cpx22' });
    expect(standby).toMatchObject({ region: 'hel1', types: { compose: 'cx23' } });
  });

  it('places a k8s-ha standby as a pilot light: master and db, no worker', async () => {
    seedHetzner();
    const { primary, standby } = await resolveCapacityPair(HETZNER, 't', {
      mode: 'k8s-ha',
      loadCatalog: seeded,
    });
    expect(Object.keys(primary.types)).toEqual(['master', 'db', 'worker']);
    expect(Object.keys(standby.types)).toEqual(['master', 'db']);
  });

  it('never pairs across continents', async () => {
    seedHetzner();
    await expect(
      resolveCapacityPair({ ...HETZNER, regions: ['nbg1', 'ash'] }, 't', {
        mode: 'compose-ha',
        loadCatalog: seeded,
      }),
    ).rejects.toThrow(/two distinct same-continent/);
  });
});

describe('deployedScaleTarget', () => {
  const ladder = { cpx22: 'cpx32', cpx12: 'cpx22' };

  it('scales compose from the serverType the deploy recorded', () => {
    expect(deployedScaleTarget({ serverType: 'cpx22' }, 'compose-ha', ladder)).toBe('cpx32');
  });

  it('scales k8s from the recorded master type (scale -type resizes every role)', () => {
    const env = { masterServerType: 'cpx22', dbServerType: 'cpx12', workerServerType: 'cpx22' };
    expect(deployedScaleTarget(env, 'k8s-ha', ladder)).toBe('cpx32');
  });

  it('fails the step when the recorded type has no ladder entry', () => {
    expect(() => deployedScaleTarget({ serverType: 'cx43' }, 'compose', ladder)).toThrow(
      'no scale target for cx43 in tests/config.ts scaleTo',
    );
  });

  it('fails the step when the deploy recorded no type', () => {
    expect(() => deployedScaleTarget({}, 'k8s', ladder)).toThrow(/masterServerType/);
  });
});

describe('overrideRegions (E2E_REGIONS knob)', () => {
  const base: CapacityPreferences = {
    regions: ['nbg1', 'hel1', 'fsn1'],
    scaleTo: { cpx22: 'cpx32' },
  };

  it('returns prefs unchanged when csv is undefined or empty', () => {
    expect(overrideRegions(base, undefined)).toBe(base);
    expect(overrideRegions(base, '')).toBe(base);
    expect(overrideRegions(base, ' , ,')).toBe(base);
  });

  it('replaces the region list, trimming whitespace and dropping empties', () => {
    const out = overrideRegions(base, ' ash , hil ,');
    expect(out.regions).toEqual(['ash', 'hil']);
    expect(out.scaleTo).toBe(base.scaleTo); // untouched
    expect(base.regions).toEqual(['nbg1', 'hel1', 'fsn1']); // no mutation
  });
});
