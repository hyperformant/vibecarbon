import { afterEach, describe, expect, it, vi } from 'vitest';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
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
  it("puts the Hetzner standby where the customer's deploy puts it, pinning no type", async () => {
    seedHetzner();
    const { primary, standby } = await resolveCapacityPair(HETZNER, 't', {
      mode: 'compose-ha',
      loadCatalog: seeded,
    });
    expect(primary).toMatchObject({ region: 'nbg1', serverType: undefined });
    expect(standby.serverType).toBeUndefined();
    expect(standby.region).toBe(
      HetznerProvider.getDefaultStandbyRegion('nbg1', ['compose'], { compose: 'cpx22' }),
    );
    expect(standby.region).not.toBe('nbg1');
    expect(standby.types).toEqual({
      compose: HetznerProvider.resolveServerTypeForRegion('cpx22', standby.region, 'compose'),
    });
  });

  it('pairs DigitalOcean nyc3 with tor1, the customer default, though tor1 is not in the e2e list', async () => {
    restore = seedCatalog(DigitalOceanProvider, '2026-10-22/digitalocean');
    const DO: CapacityPreferences = {
      regions: ['nyc3', 'sfo3', 'ams3', 'fra1'],
      scaleTo: { 's-2vcpu-4gb': 's-4vcpu-8gb', 's-1vcpu-2gb': 's-2vcpu-4gb' },
    };
    for (const mode of ['compose-ha', 'k8s-ha'] as const) {
      const { primary, standby } = await resolveCapacityPair(DO, 't', {
        provider: 'digitalocean',
        mode,
        loadCatalog: seeded,
      });
      expect(primary.region, mode).toBe('nyc3');
      expect(standby.region, mode).toBe('tor1');
    }
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

  it('fails preflight naming provider, location and type when the standby cannot sell the scale target', async () => {
    seedHetzner();
    const standbyRegion = HetznerProvider.getDefaultStandbyRegion('nbg1', ['compose'], {
      compose: 'cpx22',
    });
    restore?.();
    seedHetzner('2026-10-22/hetzner', { drop: { [standbyRegion]: ['cpx32'] } });
    await expect(
      resolveCapacityPair(HETZNER, 't', { mode: 'compose-ha', loadCatalog: seeded }),
    ).rejects.toThrow(
      `region-resolver: Hetzner Cloud default standby location ${standbyRegion} does not sell the scale target cpx32`,
    );
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
