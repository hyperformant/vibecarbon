/**
 * The e2e matrix deploys the sizes a customer gets by default.
 *
 * The resolver picks only the region: it hands every scenario
 * `serverType: undefined`, so the CLI under test runs the same price picker
 * a customer's first deploy runs (src/lib/sizing.js). The scale step then
 * looks the deployed type up in a per-provider ladder
 * (`capacityPreferences.<provider>.scaleTo`). This census keeps that ladder
 * honest: every entry is amd64 and in the provider's offline catalog, every
 * target is a bigger server, and every type the picker can choose by default
 * has an entry, so a new default fails here instead of at the e2e scale step.
 *
 * Catalogs come from the dated fixtures (tests/unit/fixtures/catalogs/); no
 * test here touches the network.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getProviderClass } from '../../../src/lib/providers/index.js';
import { filterAmd64Types } from '../../../src/lib/server-types.js';
import { ROLE_MIN_RAM_GB } from '../../../src/lib/sizing.js';
import { testConfig } from '../../config.js';
import {
  type CapacityPreferences,
  type CapacityProvider,
  resolveCapacity,
  resolveCapacityPair,
} from '../../e2e/utils/region-resolver.js';
import { seedCatalog } from '../helpers/catalog-fixtures.js';

const PREFS = testConfig.e2e.capacityPreferences as unknown as Record<
  CapacityProvider,
  CapacityPreferences
>;
const PROVIDER_IDS = Object.keys(PREFS) as CapacityProvider[];
const fixtureFor = (id: string) => `2026-10-22/${id}`;
// The seeded class answers; never the network.
const seededCatalog = async () => true;

let restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.reverse()) restore();
  restores = [];
});

function seed(id: CapacityProvider) {
  restores.push(seedCatalog(getProviderClass(id), fixtureFor(id)));
  return getProviderClass(id);
}

function allScenarios() {
  return Object.entries(testConfig.e2e.providers).flatMap(([provider, entry]) =>
    entry.scenarios.map((s) => ({
      ...s,
      provider: provider as CapacityProvider,
      id: `${provider}/${s.envPrefix}`,
    })),
  );
}

describe('e2e scenarios deploy the default sizes', () => {
  it('every registered scenario resolves on the fixtures, primary and standby in known locations', async () => {
    // The resolver hands every scenario serverType undefined by construction
    // (ResolvedCapacity), so what this proves is that the picker, the scale
    // ladder and the standby default line up for every registered scenario:
    // resolution throws on any gap.
    const scenarios = allScenarios();
    expect(scenarios.length).toBeGreaterThan(0);
    for (const s of scenarios) {
      const P = seed(s.provider);
      const opts = { provider: s.provider, mode: s.mode, loadCatalog: seededCatalog };
      const resolved = s.mode.endsWith('-ha')
        ? Object.values(await resolveCapacityPair(PREFS[s.provider], 'token', opts))
        : [await resolveCapacity(PREFS[s.provider], 'token', opts)];
      for (const r of resolved) expect(Object.keys(P.REGIONS), s.id).toContain(r.region);
    }
  });
});

describe.each(PROVIDER_IDS)('capacityPreferences.%s.scaleTo (scale ladder census)', (id) => {
  const Provider = getProviderClass(id);

  it('every ladder entry is amd64 and in the fallback catalog', () => {
    const entries = Object.entries(PREFS[id].scaleTo);
    expect(entries.length).toBeGreaterThan(0);
    // The fixture as the provider's own parser reads it: parseCatalog drops
    // ARM types, so a type absent here is either ARM or not sold at all.
    const P = seed(id);
    for (const [from, to] of entries) {
      for (const type of [from, to]) {
        expect(
          Provider.FALLBACK_SERVER_TYPES,
          `${type} not in the fallback catalog`,
        ).toHaveProperty([type]);
        expect(Provider.isArmServerType(type), `${type} is ARM`).toBe(false);
        expect(P.SERVER_TYPES, `${type} not in the ${id} fixture`).toHaveProperty([type]);
        const { architecture } = P.SERVER_TYPES[type];
        expect(
          filterAmd64Types([{ name: type, architecture }]),
          `${type} is not amd64`,
        ).toHaveLength(1);
      }
    }
  });

  it('every ladder target is a bigger server than the type it scales from', () => {
    for (const [from, to] of Object.entries(PREFS[id].scaleTo)) {
      const a = Provider.FALLBACK_SERVER_TYPES[from];
      const b = Provider.FALLBACK_SERVER_TYPES[to];
      expect(b.ram, `${from} -> ${to}`).toBeGreaterThan(a.ram);
    }
  });

  it('every compose and master default has its scale target sold where it is the default', () => {
    // deployedScaleTarget keys on the compose or master type, so its target
    // must be orderable wherever that type is the picker's default: otherwise
    // the location is unusable as a primary and nothing says so.
    const P = seed(id);
    const unsellable: string[] = [];
    for (const location of Object.keys(P._locationTypes)) {
      const d = P.getRegionDefaults(location);
      for (const type of new Set([d.composeType, d.masterType])) {
        if (!type) continue;
        const target = PREFS[id].scaleTo[type];
        if (target && !P._locationTypes[location].has(target)) {
          unsellable.push(`${type} -> ${target} in ${location}`);
        }
      }
    }
    expect(unsellable, 'scale targets not sold where their type is the default').toEqual([]);
  });

  it('every type the picker defaults to, for any role in any location, has a ladder entry', () => {
    const P = seed(id);
    const roles = Object.keys(ROLE_MIN_RAM_GB) as Array<keyof typeof ROLE_MIN_RAM_GB>;
    const missing = new Set<string>();
    for (const location of Object.keys(P._locationTypes)) {
      const d = P.getRegionDefaults(location);
      const byRole = {
        compose: d.composeType,
        master: d.masterType,
        db: d.dbType,
        worker: d.workerType,
      };
      for (const role of roles) {
        const type = byRole[role];
        if (type && !(type in PREFS[id].scaleTo)) missing.add(`${type} (${role} in ${location})`);
      }
    }
    expect([...missing], 'add these to tests/config.ts scaleTo').toEqual([]);
  });
});
