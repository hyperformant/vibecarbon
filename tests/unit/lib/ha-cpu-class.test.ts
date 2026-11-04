/**
 * One CPU class for both sides of an HA deploy (owner decision 2026-11-03).
 *
 * Evidence: on a DigitalOcean k8s-ha run the tor1 standby on the regular
 * droplet class took about twice as long for apt and the k3s install as the
 * sfo3 primary on `-amd`, and the standby was the deploy's critical path. So
 * an HA deploy picks the best CPU class sold in BOTH locations
 * (`Provider.CPU_CLASSES`, best first) and places both sides on it, never
 * below the vCPU/RAM the single-region default would give. Only when no class
 * offers that in both locations does each side fall back on its own, with a
 * warning naming the difference.
 *
 * Runs on the dated 2026-10-22 catalogs (seedCatalog), the same reads the
 * live path makes. On that date sfo3 sold `-amd` and `-intel` (no plain
 * size), tor1 plain and `-intel` (no `-amd`), nyc3 plain and `-amd`.
 *
 * The census that keeps every HA path on these pickers is
 * ha-cpu-class-census.test.ts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';
import { ScalewayProvider } from '../../../src/lib/providers/scaleway.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';
import {
  cheapestRoleSet,
  haClassMessage,
  haClassNote,
  haDefaultPair,
  haRoleSets,
  haSidesMatch,
  haStandbyType,
  rankStandbyLocations,
} from '../../../src/lib/sizing.js';
import { seedCatalog } from '../helpers/catalog-fixtures.js';

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});
const seed = (...args: Parameters<typeof seedCatalog>) => restores.push(seedCatalog(...args));

/** Remove every type ending in `suffix` from `location` (after a seed). */
function dropClass(location: string, suffix: string) {
  const sold = DigitalOceanProvider._locationTypes[location] as Set<string>;
  for (const t of [...sold]) if (t.endsWith(suffix)) sold.delete(t);
}

const K8S = ['master', 'db', 'worker'];
const INTEL = { master: 's-2vcpu-4gb-intel', db: 's-1vcpu-2gb-intel', worker: 's-2vcpu-4gb-intel' };
const AMD = { master: 's-2vcpu-4gb-amd', db: 's-1vcpu-2gb-amd', worker: 's-2vcpu-4gb-amd' };

describe('Provider CPU classes', () => {
  it('DigitalOcean reads the class from the slug suffix, premium AMD first, ranked by speed', () => {
    expect(DigitalOceanProvider.CPU_CLASSES).toEqual(['amd', 'intel', 'regular']);
    expect(DigitalOceanProvider.CPU_CLASS_ORDER).toBe('speed');
    expect(DigitalOceanProvider.cpuClassOf('s-2vcpu-4gb-amd')).toBe('amd');
    expect(DigitalOceanProvider.cpuClassOf('s-1vcpu-2gb-intel')).toBe('intel');
    expect(DigitalOceanProvider.cpuClassOf('s-2vcpu-4gb')).toBe('regular');
    expect(DigitalOceanProvider.cpuClassOf('c-2')).toBeNull();
  });

  it('Hetzner splits cost-optimized cx from regular cpx (and dedicated ccx); ARM has none', () => {
    expect(HetznerProvider.cpuClassOf('cx23')).toBe('cx');
    expect(HetznerProvider.cpuClassOf('cpx22')).toBe('cpx');
    expect(HetznerProvider.cpuClassOf('cpx11')).toBe('cpx');
    expect(HetznerProvider.cpuClassOf('ccx13')).toBe('ccx');
    expect(HetznerProvider.cpuClassOf('cax11')).toBeNull();
  });

  it('Vultr splits regular vc2 from high-frequency vhf', () => {
    expect(VultrProvider.cpuClassOf('vc2-2c-4gb')).toBe('vc2');
    expect(VultrProvider.cpuClassOf('vhf-2c-4gb')).toBe('vhf');
  });

  it('Scaleway classes are the instance families', () => {
    expect(ScalewayProvider.cpuClassOf('DEV1-M')).toBe('DEV1');
    expect(ScalewayProvider.cpuClassOf('PLAY2-NANO')).toBe('PLAY2');
    expect(ScalewayProvider.cpuClassOf('BASIC3-X2C-4G')).toBe('BASIC3');
  });

  it('Hetzner, Vultr and Scaleway rank their classes by price only', () => {
    for (const P of [HetznerProvider, VultrProvider, ScalewayProvider]) {
      expect(P.CPU_CLASS_ORDER).toBe('price');
    }
  });

  it('Linode has one class: the rule does not apply', () => {
    expect(LinodeProvider.CPU_CLASSES).toEqual([]);
  });

  it.each(Object.entries(PROVIDERS))(
    '%s: every role candidate belongs to a declared class (or none are declared)',
    (_id, Provider) => {
      const candidates = Object.values(Provider.ROLE_CANDIDATES ?? {}).flat() as string[];
      if (Provider.CPU_CLASSES.length === 0) return;
      for (const type of candidates) {
        expect(Provider.CPU_CLASSES, type).toContain(Provider.cpuClassOf(type));
      }
    },
  );
});

describe('haRoleSets: DigitalOcean', () => {
  it('sfo3 + tor1: both sides on -intel, the best class both sell, at the default sizes', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    const sets = haRoleSets(DigitalOceanProvider, 'sfo3', 'tor1', K8S);
    expect(sets.cpuClass).toBe('intel');
    expect(sets.shared).toBe(true);
    expect(sets.primary).toEqual(INTEL);
    expect(sets.standby).toEqual(INTEL);
  });

  it('sfo3 + sfo3: -amd, the top class', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    const sets = haRoleSets(DigitalOceanProvider, 'sfo3', 'sfo3', K8S);
    expect(sets.cpuClass).toBe('amd');
    expect(sets.primary).toEqual(AMD);
    expect(sets.standby).toEqual(AMD);
  });

  it('nyc3 + tor1: regular is the only class both sell, so the default stands', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    const sets = haRoleSets(DigitalOceanProvider, 'nyc3', 'tor1', ['compose']);
    expect(sets).toMatchObject({ cpuClass: 'regular', shared: true });
    expect(sets.primary.compose).toBe('s-2vcpu-4gb');
    expect(sets.standby.compose).toBe('s-2vcpu-4gb');
  });

  it('no common class: the primary keeps its default, the standby takes the closest class, and the note warns', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    // sfo3 keeps only -amd; tor1 never sold -amd.
    dropClass('sfo3', '-intel');
    const sets = haRoleSets(DigitalOceanProvider, 'sfo3', 'tor1', ['master', 'db']);
    expect(sets.shared).toBe(false);
    expect(sets.cpuClass).toBeNull();
    expect(sets.primary).toEqual({ master: AMD.master, db: AMD.db });
    // tor1's closest class to -amd is premium Intel, not the cheaper regular size.
    expect(sets.standby).toEqual({ master: INTEL.master, db: INTEL.db });

    const note = haClassNote(DigitalOceanProvider, {
      primaryRegion: 'sfo3',
      standbyRegion: 'tor1',
      primary: sets.primary,
      standby: sets.standby,
      environment: 'prod',
    });
    expect(note).toEqual({
      level: 'warn',
      line:
        'your standby runs a different CPU class from your primary (master: premium Intel in ' +
        'tor1, premium AMD in sfo3; db: premium Intel in tor1, premium AMD in sfo3), so a ' +
        'failover may run slower than your primary. No CPU class is sold in both sfo3 and ' +
        "tor1 at these sizes, so your standby stays on a different class from your primary's",
    });
  });

  it('no single type in both locations: the standby keeps the primary size, as the deploy resolves it', () => {
    // nyc3 lacks the plain 2 GB size; tor1 lacks the plain 4 GB size and the
    // premium 2 GB ones, so no db type is sold in both.
    seed(DigitalOceanProvider, '2026-10-22/digitalocean', {
      drop: {
        nyc3: ['s-1vcpu-2gb'],
        tor1: ['s-2vcpu-4gb', 's-1vcpu-2gb-intel', 's-1vcpu-2gb-amd'],
      },
    });
    const sets = haRoleSets(DigitalOceanProvider, 'nyc3', 'tor1', ['db']);
    expect(sets.standby.db).toBe(
      haStandbyType(DigitalOceanProvider, sets.primary.db as string, 'tor1', 'db'),
    );
    const ram = (t: string | null) => DigitalOceanProvider.SERVER_TYPES[t as string].ram;
    expect(ram(sets.standby.db)).toBeGreaterThanOrEqual(ram(sets.primary.db));
  });

  it('offline (no live catalog) keeps the single-region picks', () => {
    const sets = haRoleSets(DigitalOceanProvider, 'sfo3', 'tor1', K8S);
    expect(sets.primary).toEqual({
      master: cheapestRoleSet(DigitalOceanProvider, 'sfo3', ['master'])?.types.master,
      db: cheapestRoleSet(DigitalOceanProvider, 'sfo3', ['db'])?.types.db,
      worker: cheapestRoleSet(DigitalOceanProvider, 'sfo3', ['worker'])?.types.worker,
    });
  });
});

describe('haStandbyType: a fixed primary type', () => {
  it('keeps the primary type where the standby sells it', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    expect(haStandbyType(DigitalOceanProvider, INTEL.master, 'tor1', 'master')).toBe(INTEL.master);
  });

  it('an -amd primary the standby cannot match takes premium Intel there, never the regular size', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    expect(haStandbyType(DigitalOceanProvider, AMD.master, 'tor1', 'master')).toBe(INTEL.master);
    expect(haStandbyType(DigitalOceanProvider, AMD.db, 'tor1', 'db')).toBe(INTEL.db);
  });

  it('a regular primary the standby cannot match takes the next class there', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean', { drop: { tor1: ['s-2vcpu-4gb'] } });
    expect(haStandbyType(DigitalOceanProvider, 's-2vcpu-4gb', 'tor1', 'master')).toBe(INTEL.master);
  });
});

describe('standby location ranking: a matching pair first', () => {
  it('sfo3 primary, nyc3 without -amd: tor1 (-intel on both sides) wins over nyc3 (-amd beside regular)', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    dropClass('nyc3', '-amd');
    // nyc3 is the static pair and its regular standby is the cheapest, but
    // it would pair a regular standby with an -amd or -intel primary.
    expect(DigitalOceanProvider.getDefaultStandbyRegion('sfo3', ['master', 'db'], {})).toBe('tor1');
    const ranked = rankStandbyLocations(
      DigitalOceanProvider,
      ['nyc3', 'tor1'],
      ['master', 'db'],
      {},
      'sfo3',
    );
    expect(ranked.map((r) => [r.location, r.shared])).toEqual([
      ['tor1', true],
      ['nyc3', false],
    ]);
    expect(ranked[0].types).toEqual({ master: INTEL.master, db: INTEL.db });
  });

  it('a fixed primary type ranks a location selling its class first', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    const ranked = rankStandbyLocations(DigitalOceanProvider, ['tor1', 'nyc3'], ['compose'], {
      compose: AMD.master,
    });
    expect(ranked[0]).toMatchObject({ location: 'nyc3', shared: true });
  });

  it('k8s-ha weighs the worker too: a location that cannot match it ranks below one that can', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    // A tor1 primary recorded on -amd, its worker scaled to 8 GB. nyc3 and
    // sfo3 both sell the -amd master and db at the same price; nyc3 no
    // longer sells the 8 GB -amd worker, so failover would bring the worker
    // up on another class (or not at all) there.
    (DigitalOceanProvider._locationTypes.nyc3 as Set<string>).delete('s-4vcpu-8gb-amd');
    const fixed = { master: AMD.master, db: AMD.db, worker: 's-4vcpu-8gb-amd' };
    const withWorker = rankStandbyLocations(DigitalOceanProvider, ['nyc3', 'sfo3'], K8S, fixed);
    expect(withWorker.map((r) => [r.location, r.shared, r.monthly])).toEqual([
      ['sfo3', true, 42],
      ['nyc3', false, 42],
    ]);
    // The worker is weighed, never placed or priced.
    expect(withWorker[0].types).toEqual({ master: AMD.master, db: AMD.db });
    // Without it the two tie as matching pairs and nyc3 keeps its place.
    const without = rankStandbyLocations(
      DigitalOceanProvider,
      ['nyc3', 'sfo3'],
      ['master', 'db'],
      fixed,
    );
    expect(without.map((r) => r.location)).toEqual(['nyc3', 'sfo3']);
    expect(DigitalOceanProvider.getDefaultStandbyRegion('tor1', K8S, fixed)).toBe('sfo3');
  });

  it('haDefaultPair prices the pair the deploy creates', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    dropClass('nyc3', '');
    expect(haDefaultPair(DigitalOceanProvider, 'sfo3', K8S)).toEqual({
      standbyRegion: 'tor1',
      primary: INTEL,
      standby: { master: INTEL.master, db: INTEL.db },
      // 28 + 14 + 28 on the primary, 28 + 14 on the standby.
      monthly: 112,
    });
  });
});

describe('haSidesMatch', () => {
  it('same type, or same class, matches; a classless type matches only itself', () => {
    expect(haSidesMatch(DigitalOceanProvider, { a: AMD.master }, { a: AMD.db })).toBe(true);
    expect(haSidesMatch(DigitalOceanProvider, { a: AMD.master }, { a: INTEL.master })).toBe(false);
    expect(haSidesMatch(DigitalOceanProvider, { a: 'c-2' }, { a: 'c-2' })).toBe(true);
    expect(haSidesMatch(DigitalOceanProvider, { a: 'c-2' }, { a: 'c-4' })).toBe(false);
  });
});

describe('haClassNote / haClassMessage', () => {
  it('names the shared class and why, in the second person', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    const sets = haRoleSets(DigitalOceanProvider, 'sfo3', 'tor1', ['master', 'db']);
    expect(
      haClassMessage(DigitalOceanProvider, {
        primaryRegion: 'sfo3',
        standbyRegion: 'tor1',
        primary: sets.primary,
        standby: sets.standby,
        environment: 'prod',
      }),
    ).toEqual({
      level: 'info',
      line:
        'Your primary (sfo3) and standby (tor1) both run premium Intel servers, the best CPU ' +
        "class sfo3 and tor1 both sell, so a failover lands on servers as fast as your primary's",
    });
  });

  it('an -amd primary beside an -intel standby: adjusted types, then a warning with what works', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    const message = haClassMessage(DigitalOceanProvider, {
      primaryRegion: 'sfo3',
      standbyRegion: 'tor1',
      primary: { master: AMD.master, db: AMD.db },
      standby: { master: INTEL.master, db: INTEL.db },
      environment: 'prod',
    });
    expect(message).toEqual({
      level: 'warn',
      line:
        'Standby server types adjusted for tor1: master=s-2vcpu-4gb-intel, db=s-1vcpu-2gb-intel; ' +
        'your standby runs a different CPU class from your primary (master: premium Intel in ' +
        'tor1, premium AMD in sfo3; db: premium Intel in tor1, premium AMD in sfo3), so a ' +
        'failover may run slower than your primary. Both locations sell premium Intel servers ' +
        'this size or larger: once this deploy finishes, run vibecarbon scale prod and pick ' +
        'premium Intel sizes for each role to put both sides on one class',
    });
    // Never a blanket -server-type: it would not move recorded k8s types,
    // and it would size the db like the master.
    expect(message?.line).not.toContain('-server-type');
    expect(message?.line).not.toContain('—');
  });

  it('a standby on a faster class than its primary is not called slower', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    const note = haClassNote(DigitalOceanProvider, {
      primaryRegion: 'tor1',
      standbyRegion: 'sfo3',
      primary: { compose: 's-2vcpu-4gb' },
      standby: { compose: INTEL.master },
      environment: 'prod',
    });
    expect(note?.level).toBe('warn');
    expect(note?.line).not.toContain('slower');
  });

  it('a type with no class on both sides is a matching pair: nothing to say', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    const sides = {
      primaryRegion: 'sfo3',
      standbyRegion: 'tor1',
      primary: { compose: 'c-2' },
      standby: { compose: 'c-2' },
      environment: 'prod',
    };
    expect(haClassNote(DigitalOceanProvider, sides)).toBeNull();
    expect(haClassMessage(DigitalOceanProvider, sides)).toBeNull();
  });

  it('a type with no class beside a classed one names the types, never an empty class', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    const note = haClassNote(DigitalOceanProvider, {
      primaryRegion: 'sfo3',
      standbyRegion: 'tor1',
      primary: { compose: 'c-2' },
      standby: { compose: INTEL.master },
      environment: 'prod',
    });
    expect(note?.line).toContain('compose: premium Intel in tor1, c-2 in sfo3');
    expect(note?.line).not.toMatch(/runs ,|runs {2}/);
  });

  it('a price-ranked provider says only that the classes differ', () => {
    seed(HetznerProvider, 'flux-hetzner-cx23-hel1');
    const note = haClassNote(HetznerProvider, {
      primaryRegion: 'hel1',
      standbyRegion: 'fsn1',
      primary: { compose: 'cx23' },
      standby: { compose: 'cpx22' },
      environment: 'prod',
    });
    expect(note?.level).toBe('warn');
    expect(note?.line).toContain(
      'your standby runs a different CPU class from your primary (compose: regular AMD (cpx) ' +
        'in fsn1, cost-optimized (cx) in hel1).',
    );
    expect(note?.line).not.toContain('slower');
  });

  it('is silent for a provider with one class', () => {
    expect(
      haClassNote(LinodeProvider, {
        primaryRegion: 'us-iad',
        standbyRegion: 'us-ord',
        primary: { compose: 'g6-standard-2' },
        standby: { compose: 'g6-standard-2' },
        environment: 'prod',
      }),
    ).toBeNull();
  });
});

describe('haRoleSets: other providers with classes', () => {
  it('Hetzner: cx23 only in hel1 puts both hel1 and fsn1 on cpx, never below the cx23 size', () => {
    seed(HetznerProvider, 'flux-hetzner-cx23-hel1');
    // Single-region hel1 still takes the cheaper cx23 (2 vCPU, 4 GB) for every role.
    expect(cheapestRoleSet(HetznerProvider, 'hel1', ['db'])?.types.db).toBe('cx23');
    const sets = haRoleSets(HetznerProvider, 'hel1', 'fsn1', K8S);
    expect(sets).toMatchObject({ cpuClass: 'cpx', shared: true });
    // The db stays at 2 vCPU / 4 GB: cpx22, not the 1 vCPU / 2 GB cpx12.
    const cpx = { master: 'cpx22', db: 'cpx22', worker: 'cpx22' };
    expect(sets.primary).toEqual(cpx);
    expect(sets.standby).toEqual(cpx);
  });

  it('Hetzner: cx23 in both locations keeps both on cx23 (price order, no surcharge)', () => {
    seed(HetznerProvider, '2026-10-22/hetzner');
    for (const loc of ['nbg1', 'fsn1']) {
      HetznerProvider._locationTypes[loc] = new Set([
        ...HetznerProvider._locationTypes[loc],
        'cx23',
      ]);
    }
    const sets = haRoleSets(HetznerProvider, 'nbg1', 'fsn1', ['compose']);
    expect(sets).toMatchObject({ cpuClass: 'cx', shared: true });
    expect(sets.primary.compose).toBe('cx23');
    expect(sets.standby.compose).toBe('cx23');
  });

  it('Vultr: ord without vc2 moves both sides to vhf', () => {
    seed(VultrProvider, '2026-10-22/vultr', { drop: { ord: ['vc2-2c-4gb'] } });
    const sets = haRoleSets(VultrProvider, 'ewr', 'ord', ['compose']);
    expect(sets).toMatchObject({ cpuClass: 'vhf', shared: true });
    expect(sets.primary.compose).toBe('vhf-2c-4gb');
    expect(sets.standby.compose).toBe('vhf-2c-4gb');
  });

  it('Scaleway: a zone without DEV1-M never moves both sides to a 2 vCPU family', () => {
    seed(ScalewayProvider, '2026-10-22/scaleway', { drop: { 'nl-ams-1': ['DEV1-M'] } });
    const sets = haRoleSets(ScalewayProvider, 'fr-par-2', 'nl-ams-1', ['compose']);
    // DEV1-M has 3 vCPU; PLAY2-NANO and BASIC3-X2C-4G have 2. No family offers
    // 3 vCPU in both zones, so each side falls back on its own.
    expect(sets).toMatchObject({ cpuClass: null, shared: false });
    expect(sets.primary.compose).toBe('DEV1-M');
    expect(sets.standby.compose).toBe(
      haStandbyType(ScalewayProvider, 'DEV1-M', 'nl-ams-1', 'compose'),
    );
    const note = haClassNote(ScalewayProvider, {
      primaryRegion: 'fr-par-2',
      standbyRegion: 'nl-ams-1',
      primary: sets.primary,
      standby: sets.standby,
      environment: 'prod',
    });
    expect(note?.level).toBe('warn');
    expect(note?.line).toContain("with 2 vCPU to your primary's 3");
    expect(note?.line).not.toContain('slower');
  });

  it('Scaleway: a common family at the default size is shared', () => {
    // fr-par-2 without DEV1-M defaults to PLAY2-NANO (2 vCPU); nl-ams-1 has
    // neither DEV1-M nor PLAY2-NANO, so both sides take BASIC3 (2 vCPU).
    seed(ScalewayProvider, '2026-10-22/scaleway', {
      drop: { 'fr-par-2': ['DEV1-M'], 'nl-ams-1': ['DEV1-M', 'PLAY2-NANO'] },
    });
    const sets = haRoleSets(ScalewayProvider, 'fr-par-2', 'nl-ams-1', ['compose']);
    expect(sets).toMatchObject({ cpuClass: 'BASIC3', shared: true });
    expect(sets.primary.compose).toBe('BASIC3-X2C-4G');
    expect(sets.standby.compose).toBe('BASIC3-X2C-4G');
  });

  it('Linode (one class): the single-region pick and its standby resolution, as before', () => {
    seed(LinodeProvider, '2026-10-22/linode');
    const sets = haRoleSets(LinodeProvider, 'us-iad', 'us-ord', ['compose']);
    expect(sets.primary.compose).toBe('g6-standard-2');
    expect(sets.standby.compose).toBe('g6-standard-2');
  });
});
