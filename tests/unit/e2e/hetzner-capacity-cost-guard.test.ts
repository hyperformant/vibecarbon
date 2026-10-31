/**
 * Cost guard for the Hetzner e2e capacity ladder.
 *
 * Hetzner repriced its cloud lines on 2026-06-15: CPX rose ~3x in the US
 * locations and the legacy `cpx*1` generation now costs MORE than its
 * `cpx*2` successor (Aug 2026 invoice: cpx21 $0.0601/h vs cpx22 $0.0368/h;
 * cpx31 $0.1178/h vs cpx32 $0.0673/h). The cx line (Intel shared, ~$0.01/h)
 * is EU-only. Every VM the matrix spawns is billed at least one full hour,
 * so ~1,500 short-lived VMs a month on `ash`/`hil` + `cpx*1` was 64% of the
 * e2e project's bill.
 *
 * These pins keep the matrix on EU locations and current-generation shared
 * types, and keep CI from re-pinning itself to the US via the `regions`
 * dispatch default. Cheapest-first is the price picker's job now
 * (src/lib/sizing.js): the matrix deploys the size a customer gets by default,
 * so what is pinned here is the EU region list, the resolver's EU result and
 * the scale ladder's targets. Anyone who needs a US perf record run
 * passes `regions: ash,hil` explicitly at dispatch time — that path still
 * works, it just is not the default.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { testConfig } from '../../config.js';
import { resolveCapacity, resolveCapacityPair } from '../../e2e/utils/region-resolver.js';
import { seedCatalog } from '../helpers/catalog-fixtures.js';

const EU_LOCATIONS = ['nbg1', 'hel1', 'fsn1'] as const;
const WORKFLOW_PATH = join(process.cwd(), '.github', 'workflows', 'e2e-us-perf.yml');

describe('capacityPreferences.hetzner (cost guard)', () => {
  it('lists only EU locations — no ash/hil (US) and no sin (CPX/CCX-only, price uplift)', () => {
    expect(testConfig.e2e.capacityPreferences.hetzner.regions).toEqual(EU_LOCATIONS);
  });

  it('never scales an EU default onto the legacy cpx*1 generation', () => {
    // The picker chooses the deploy size (cheapest orderable first), so the
    // cost guard's remaining hand-written surface is the scale ladder: the
    // target of every type the picker defaults to in the EU must stay on the
    // current generation.
    const restore = seedCatalog(HetznerProvider, '2026-10-22/hetzner');
    try {
      const { scaleTo } = testConfig.e2e.capacityPreferences.hetzner;
      for (const location of EU_LOCATIONS) {
        const d = HetznerProvider.getRegionDefaults(location);
        for (const type of [d.composeType, d.masterType, d.dbType, d.workerType]) {
          expect(type, `${location} default`).not.toMatch(/^cpx\d1$/);
          const target = (scaleTo as Record<string, string>)[type as string];
          expect(target, `${type} -> ${target} in ${location}`).not.toMatch(/^cpx\d1$/);
        }
      }
    } finally {
      restore();
    }
  });

  it('never resolves a US location by default', async () => {
    const restore = seedCatalog(HetznerProvider, '2026-10-22/hetzner');
    try {
      const prefs = testConfig.e2e.capacityPreferences.hetzner;
      const opts = { loadCatalog: async () => true };
      for (const mode of ['compose', 'k8s'] as const) {
        const r = await resolveCapacity(prefs, 't', { ...opts, mode });
        expect(EU_LOCATIONS).toContain(r.region);
      }
      for (const mode of ['compose-ha', 'k8s-ha'] as const) {
        const { primary, standby } = await resolveCapacityPair(prefs, 't', { ...opts, mode });
        expect(EU_LOCATIONS).toContain(primary.region);
        expect(EU_LOCATIONS).toContain(standby.region);
      }
    } finally {
      restore();
    }
  });
});

describe('e2e-us-perf.yml `regions` dispatch input (cost guard)', () => {
  it('defaults to empty so tests/config.ts is the single source of the region list', () => {
    const doc = loadYaml(readFileSync(WORKFLOW_PATH, 'utf8')) as {
      on?: { workflow_dispatch?: { inputs?: { regions?: { default?: string } } } };
    };
    const regionsInput = doc.on?.workflow_dispatch?.inputs?.regions;
    expect(regionsInput, 'e2e-us-perf.yml: `regions` input is missing').toBeDefined();
    expect(regionsInput?.default ?? '').toBe('');
  });
});
