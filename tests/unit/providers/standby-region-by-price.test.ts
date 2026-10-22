/**
 * The default HA standby location is the cheapest same-continent partner
 * (never the primary) where every role the standby places is orderable right
 * now, priced as servers plus billed IPv4 (src/lib/sizing.js
 * rankLocationsByPrice). Ties keep the conventional pair. With no catalog
 * loaded, or no partner that qualifies, the conventional pair stands and the
 * deploy wizard's refusal names the cause at type resolution.
 *
 * The standby's own server type, when the primary's type is not stocked in
 * the standby location, is the picker's choice for the role there, never an
 * unstocked default (the DigitalOcean sfo3 bug), and null when the role has
 * nothing orderable there.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';
import { ScalewayProvider } from '../../../src/lib/providers/scaleway.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';
import { seedCatalog } from '../helpers/catalog-fixtures.js';

const restores: Array<() => void> = [];
function seed(...args: Parameters<typeof seedCatalog>) {
  restores.push(seedCatalog(...args));
}
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

const DO_SFO3_4GB = ['s-2vcpu-4gb-amd', 's-2vcpu-4gb-intel'];
const DO_SFO3_2GB = ['s-1vcpu-2gb-amd', 's-1vcpu-2gb-intel'];

describe('getDefaultStandbyRegion by price', () => {
  it('Hetzner 2026-10-22: EU ties keep the conventional partner', () => {
    seed(HetznerProvider, '2026-10-22/hetzner');
    expect(HetznerProvider.getDefaultStandbyRegion('nbg1')).toBe('fsn1');
    expect(HetznerProvider.getDefaultStandbyRegion('hel1')).toBe('fsn1'); // deterministic: REGION_CONTINENT order
    expect(HetznerProvider.getDefaultStandbyRegion('ash')).toBe('hil');
  });

  it('DigitalOcean 2026-10-22: nyc3 pairs with tor1, not the unstocked sfo3', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    expect(DigitalOceanProvider.getDefaultStandbyRegion('nyc3')).toBe('tor1');
    expect(DigitalOceanProvider.getDefaultStandbyRegion('nyc3', ['master', 'db'])).toBe('tor1');
  });

  it('offline keeps the static pairs', () => {
    expect(DigitalOceanProvider._locationTypes).toBeFalsy();
    expect(DigitalOceanProvider.getDefaultStandbyRegion('nyc3')).toBe('sfo3');
    expect(HetznerProvider.getDefaultStandbyRegion('nbg1')).toBe('fsn1');
  });

  it('never the primary, and only a partner where every role is orderable', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean', {
      drop: { tor1: ['s-1vcpu-2gb', 's-1vcpu-2gb-intel'] },
    });
    // tor1 still sells a 4 GB compose box, so compose may pair there...
    expect(DigitalOceanProvider.getDefaultStandbyRegion('nyc3')).toBe('tor1');
    // ...but its db role now only has the 4 GB last resort, so the master +
    // db standby is cheaper in sfo3 ($28 + $14 vs $24 + $24).
    expect(DigitalOceanProvider.getDefaultStandbyRegion('nyc3', ['master', 'db'])).toBe('sfo3');
  });

  it('no partner qualifies: the static pair stands (the refusal fires at type resolution)', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean', {
      drop: {
        sfo3: [...DO_SFO3_4GB, ...DO_SFO3_2GB],
        tor1: ['s-2vcpu-4gb', 's-2vcpu-4gb-intel'],
      },
    });
    expect(DigitalOceanProvider.getDefaultStandbyRegion('nyc3')).toBe('sfo3');
  });

  it('a bigger primary type pairs with a partner that stocks it, not the tie-break pair', () => {
    // cpx32 (8 GB) is bigger than every compose candidate, so a standby where
    // it is not stocked has no fit (never shrunk). fsn1 is the conventional
    // pair for nbg1; with cpx32 gone there, hel1 is the one that fits.
    seed(HetznerProvider, '2026-10-22/hetzner', { drop: { fsn1: ['cpx32'] } });
    expect(HetznerProvider.getDefaultStandbyRegion('nbg1', ['compose'], { compose: 'cpx32' })).toBe(
      'hel1',
    );
    // Without the primary type, the 4 GB pick fits fsn1 and the pair stands.
    expect(HetznerProvider.getDefaultStandbyRegion('nbg1', ['compose'])).toBe('fsn1');
  });

  it('a stocked primary type keeps the conventional pair on a price tie', () => {
    seed(HetznerProvider, '2026-10-22/hetzner');
    expect(HetznerProvider.getDefaultStandbyRegion('nbg1', ['compose'], { compose: 'cpx32' })).toBe(
      'fsn1',
    );
  });

  it('compose-only providers keep a same-continent partner for k8s roles they have no candidates for', () => {
    for (const [P, name, primary] of [
      [VultrProvider, 'vultr', 'ewr'],
      [LinodeProvider, 'linode', 'us-iad'],
      [ScalewayProvider, 'scaleway', 'fr-par-1'],
    ] as const) {
      const offline = P.getDefaultStandbyRegion(primary);
      seed(P, `2026-10-22/${name}`);
      const live = P.getDefaultStandbyRegion(primary);
      expect(live).not.toBe(primary);
      expect(P.REGION_CONTINENT[live]).toBe(P.REGION_CONTINENT[primary]);
      expect(P.getDefaultStandbyRegion(primary, ['master', 'db'])).toBe(offline);
    }
  });
});

describe('resolveServerTypeForRegion with a role', () => {
  it('a stocked type is kept as is', () => {
    seed(HetznerProvider, 'flux-hetzner-cx23-hel1');
    expect(HetznerProvider.resolveServerTypeForRegion('cpx12', 'fsn1', 'db')).toBe('cpx12');
    expect(HetznerProvider.resolveServerTypeForRegion('cpx32', 'fsn1', 'compose')).toBe('cpx32');
  });

  it('an unstocked type is re-picked for its role in the target location', () => {
    seed(HetznerProvider, 'flux-hetzner-cx23-hel1');
    expect(HetznerProvider.resolveServerTypeForRegion('cx23', 'fsn1', 'master')).toBe('cpx22');
    expect(HetznerProvider.resolveServerTypeForRegion('cx23', 'fsn1', 'compose')).toBe('cpx22');
    // Never smaller than the type it stands in for: a 4 GB db stays 4 GB.
    expect(HetznerProvider.resolveServerTypeForRegion('cx23', 'fsn1', 'db')).toBe('cpx22');
    // A 2 GB db is re-picked at the db floor.
    expect(HetznerProvider.resolveServerTypeForRegion('cpx11', 'fsn1', 'db')).toBe('cpx12');
  });

  it('DigitalOcean sfo3 gets the stocked twin, never the unstocked default', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    expect(DigitalOceanProvider.resolveServerTypeForRegion('s-2vcpu-4gb', 'sfo3', 'compose')).toBe(
      's-2vcpu-4gb-amd',
    );
    expect(DigitalOceanProvider.resolveServerTypeForRegion('s-1vcpu-2gb', 'sfo3', 'db')).toBe(
      's-1vcpu-2gb-amd',
    );
  });

  it('nothing orderable for the role there: null, never an unstocked type', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean', { drop: { sfo3: DO_SFO3_4GB } });
    expect(
      DigitalOceanProvider.resolveServerTypeForRegion('s-2vcpu-4gb', 'sfo3', 'compose'),
    ).toBeNull();
    expect(DigitalOceanProvider.resolveServerTypeForRegion('s-2vcpu-4gb', 'sfo3')).toBeNull();
  });

  it('a type bigger than every candidate is not shrunk: null, so the deploy refuses', () => {
    seed(HetznerProvider, '2026-10-22/hetzner', { drop: { fsn1: ['cpx32'] } });
    expect(HetznerProvider.resolveServerTypeForRegion('cpx32', 'fsn1', 'compose')).toBeNull();
  });

  it('offline the requested type is assumed placeable', () => {
    expect(DigitalOceanProvider.resolveServerTypeForRegion('s-2vcpu-4gb', 'sfo3', 'compose')).toBe(
      's-2vcpu-4gb',
    );
  });
});
