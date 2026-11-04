/**
 * One CPU class for both sides of an HA deploy (owner decision 2026-11-03).
 *
 * Evidence: on a DigitalOcean k8s-ha run the tor1 standby on the regular
 * droplet class took about twice as long for apt and the k3s install as the
 * sfo3 primary on `-amd`, and the standby was the deploy's critical path. So
 * an HA deploy picks the best CPU class sold in BOTH locations
 * (`Provider.CPU_CLASSES`, best first) and places both sides on it, at the
 * vCPU/RAM tier the defaults already pick. Only when no class is common does
 * each side fall back on its own, with a warning naming the difference.
 *
 * Runs on the dated 2026-10-22 catalogs (seedCatalog), the same reads the
 * live path makes. On that date sfo3 sold `-amd` and `-intel` (no plain
 * size), tor1 plain and `-intel` (no `-amd`).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  haRoleSets,
  haStandbyType,
} from '../../../src/lib/sizing.js';
import { seedCatalog } from '../helpers/catalog-fixtures.js';

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});
const seed = (...args: Parameters<typeof seedCatalog>) => restores.push(seedCatalog(...args));

const K8S = ['master', 'db', 'worker'];

describe('Provider CPU classes', () => {
  it('DigitalOcean reads the class from the slug suffix, premium AMD first', () => {
    expect(DigitalOceanProvider.CPU_CLASSES).toEqual(['amd', 'intel', 'regular']);
    expect(DigitalOceanProvider.cpuClassOf('s-2vcpu-4gb-amd')).toBe('amd');
    expect(DigitalOceanProvider.cpuClassOf('s-1vcpu-2gb-intel')).toBe('intel');
    expect(DigitalOceanProvider.cpuClassOf('s-2vcpu-4gb')).toBe('regular');
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
  it('sfo3 + tor1: both sides on -intel, the best class both sell, at the default tiers', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    const sets = haRoleSets(DigitalOceanProvider, 'sfo3', 'tor1', K8S);
    expect(sets.cpuClass).toBe('intel');
    expect(sets.shared).toBe(true);
    const intel = {
      master: 's-2vcpu-4gb-intel',
      db: 's-1vcpu-2gb-intel',
      worker: 's-2vcpu-4gb-intel',
    };
    expect(sets.primary).toEqual(intel);
    expect(sets.standby).toEqual(intel);
  });

  it('sfo3 + sfo3: -amd, the top class', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    const sets = haRoleSets(DigitalOceanProvider, 'sfo3', 'sfo3', K8S);
    expect(sets.cpuClass).toBe('amd');
    expect(sets.primary).toEqual({
      master: 's-2vcpu-4gb-amd',
      db: 's-1vcpu-2gb-amd',
      worker: 's-2vcpu-4gb-amd',
    });
    expect(sets.standby).toEqual(sets.primary);
  });

  it('nyc3 + tor1: regular is the only class both sell, so today default stands', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    const sets = haRoleSets(DigitalOceanProvider, 'nyc3', 'tor1', ['compose']);
    expect(sets).toMatchObject({ cpuClass: 'regular', shared: true });
    expect(sets.primary.compose).toBe('s-2vcpu-4gb');
    expect(sets.standby.compose).toBe('s-2vcpu-4gb');
  });

  it('no common class: each side takes its own best class, and the note warns', () => {
    // sfo3 keeps only -amd; tor1 never sold -amd.
    seed(DigitalOceanProvider, '2026-10-22/digitalocean', {
      drop: { sfo3: ['s-2vcpu-4gb-intel', 's-1vcpu-2gb-intel'] },
    });
    const sets = haRoleSets(DigitalOceanProvider, 'sfo3', 'tor1', ['master', 'db']);
    expect(sets.shared).toBe(false);
    expect(sets.cpuClass).toBeNull();
    expect(sets.primary).toEqual({ master: 's-2vcpu-4gb-amd', db: 's-1vcpu-2gb-amd' });
    // tor1's own best class is premium Intel, not the cheaper regular size.
    expect(sets.standby).toEqual({ master: 's-2vcpu-4gb-intel', db: 's-1vcpu-2gb-intel' });

    const note = haClassNote(DigitalOceanProvider, {
      primaryRegion: 'sfo3',
      standbyRegion: 'tor1',
      primary: sets.primary,
      standby: sets.standby,
    });
    expect(note?.level).toBe('warn');
    expect(note?.line).toContain('premium AMD');
    expect(note?.line).toContain('premium Intel');
    expect(note?.line).toContain('No CPU class is sold in both sfo3 and tor1');
    expect(note?.line).not.toContain('—');
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
    expect(haStandbyType(DigitalOceanProvider, 's-2vcpu-4gb-intel', 'tor1', 'master')).toBe(
      's-2vcpu-4gb-intel',
    );
  });

  it('an -amd primary the standby cannot match takes premium Intel there, never the regular size', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    expect(haStandbyType(DigitalOceanProvider, 's-2vcpu-4gb-amd', 'tor1', 'master')).toBe(
      's-2vcpu-4gb-intel',
    );
    expect(haStandbyType(DigitalOceanProvider, 's-1vcpu-2gb-amd', 'tor1', 'db')).toBe(
      's-1vcpu-2gb-intel',
    );
  });

  it('a regular primary keeps the regular class where it is sold', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean', { drop: { tor1: ['s-2vcpu-4gb'] } });
    // tor1 lost the plain 4 GB size; the 8 GB plain one is the same class.
    expect(haStandbyType(DigitalOceanProvider, 's-2vcpu-4gb', 'tor1', 'master')).toBe(
      's-2vcpu-4gb-intel',
    );
  });
});

describe('haClassNote', () => {
  it('names the shared class and why', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    const sets = haRoleSets(DigitalOceanProvider, 'sfo3', 'tor1', ['master', 'db']);
    const note = haClassNote(DigitalOceanProvider, {
      primaryRegion: 'sfo3',
      standbyRegion: 'tor1',
      primary: sets.primary,
      standby: sets.standby,
    });
    expect(note?.level).toBe('info');
    expect(note?.line).toContain('premium Intel');
    expect(note?.line).toContain('the best CPU class sfo3 and tor1 both sell');
  });

  it('haClassMessage leads with the adjusted standby types, then the class warning', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    const message = haClassMessage(DigitalOceanProvider, {
      primaryRegion: 'sfo3',
      standbyRegion: 'tor1',
      primary: { master: 's-2vcpu-4gb-amd', db: 's-1vcpu-2gb-amd' },
      standby: { master: 's-2vcpu-4gb-intel', db: 's-1vcpu-2gb-intel' },
    });
    expect(message).toEqual({
      level: 'warn',
      line:
        'Standby server types adjusted for tor1: master=s-2vcpu-4gb-intel, db=s-1vcpu-2gb-intel; ' +
        'the standby in tor1 runs premium Intel servers (master=s-2vcpu-4gb-intel, ' +
        'db=s-1vcpu-2gb-intel) and the primary in sfo3 runs premium AMD, so a failover may run ' +
        'slower than the primary. Both locations sell premium Intel servers: deploy ' +
        '-server-type s-2vcpu-4gb-intel puts both sides on that class',
    });
  });

  it('haClassMessage with identical sides is the class line alone', () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    const intel = { master: 's-2vcpu-4gb-intel', db: 's-1vcpu-2gb-intel' };
    expect(
      haClassMessage(DigitalOceanProvider, {
        primaryRegion: 'sfo3',
        standbyRegion: 'tor1',
        primary: intel,
        standby: intel,
      })?.line,
    ).toBe(
      'Primary (sfo3) and standby (tor1) both run premium Intel servers, the best CPU class ' +
        "sfo3 and tor1 both sell, so a failover lands on servers as fast as the primary's",
    );
  });

  it('is silent for a provider with one class', () => {
    expect(
      haClassNote(LinodeProvider, {
        primaryRegion: 'us-iad',
        standbyRegion: 'us-ord',
        primary: { compose: 'g6-standard-2' },
        standby: { compose: 'g6-standard-2' },
      }),
    ).toBeNull();
  });
});

describe('haRoleSets: other providers with classes', () => {
  it('Hetzner: cx23 only in hel1 puts both hel1 and fsn1 on cpx, not a mixed pair', () => {
    seed(HetznerProvider, 'flux-hetzner-cx23-hel1');
    // Single-region hel1 still takes the cheaper cx23.
    expect(cheapestRoleSet(HetznerProvider, 'hel1', ['compose'])?.types.compose).toBe('cx23');
    const sets = haRoleSets(HetznerProvider, 'hel1', 'fsn1', ['compose']);
    expect(sets).toMatchObject({ cpuClass: 'cpx', shared: true });
    expect(sets.primary.compose).toBe('cpx22');
    expect(sets.standby.compose).toBe('cpx22');
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

  it('Scaleway: nl-ams-1 without DEV1-M moves both sides to the next common family', () => {
    seed(ScalewayProvider, '2026-10-22/scaleway', { drop: { 'nl-ams-1': ['DEV1-M'] } });
    const sets = haRoleSets(ScalewayProvider, 'fr-par-2', 'nl-ams-1', ['compose']);
    expect(sets).toMatchObject({ cpuClass: 'PLAY2', shared: true });
    expect(sets.primary.compose).toBe('PLAY2-NANO');
    expect(sets.standby.compose).toBe('PLAY2-NANO');
  });

  it('Linode (one class): the single-region pick and its standby resolution, as before', () => {
    seed(LinodeProvider, '2026-10-22/linode');
    const sets = haRoleSets(LinodeProvider, 'us-iad', 'us-ord', ['compose']);
    expect(sets.primary.compose).toBe('g6-standard-2');
    expect(sets.standby.compose).toBe('g6-standard-2');
  });
});

/**
 * Census: every HA size decision routes through the common-class picker
 * (src/lib/sizing.js). A direct `resolveServerTypeForRegion` call in an HA
 * path would place the standby by price alone and bring back the mixed pair.
 */
describe('census: HA sizes route through the common-class picker', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  const read = (rel: string) =>
    readFileSync(join(root, rel), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');

  it.each([
    'src/lib/deploy/effects/k8s-ha.js',
    'src/lib/deploy/effects/compose-ha.js',
    'src/lib/deploy/standby-types.js',
    'src/lib/deploy/prompts.js',
    'scripts/cost-grid.js',
    'tests/e2e/utils/region-resolver.ts',
  ])('%s never resolves a standby type by price alone', (rel) => {
    expect(read(rel)).not.toMatch(/\.resolveServerTypeForRegion\(/);
  });

  it('the compose-ha effect places its standby through haStandbyType', () => {
    expect(read('src/lib/deploy/effects/compose-ha.js')).toMatch(/haStandbyType\(/);
  });

  it('the k8s-ha effect resolves the standby through k8sStandbyTypes, which uses haStandbyType', () => {
    expect(read('src/lib/deploy/effects/k8s-ha.js')).toMatch(/k8sStandbyTypes\(/);
    expect(read('src/lib/deploy/standby-types.js')).toMatch(/haStandbyType\(/);
  });

  it('both HA effects report the class through haClassMessage', () => {
    expect(read('src/lib/deploy/effects/k8s-ha.js')).toMatch(/haClassMessage\(/);
    expect(read('src/lib/deploy/effects/compose-ha.js')).toMatch(/haClassMessage\(/);
  });

  it('the deploy wizard, cost grid and e2e resolver pick HA defaults with haRoleSets', () => {
    expect(read('src/lib/deploy/prompts.js')).toMatch(/haRoleSets\(/);
    expect(read('scripts/cost-grid.js')).toMatch(/haRoleSets\(/);
    expect(read('tests/e2e/utils/region-resolver.ts')).toMatch(/haRoleSets\(/);
  });
});
