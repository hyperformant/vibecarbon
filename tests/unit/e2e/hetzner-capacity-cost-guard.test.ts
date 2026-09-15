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
 * types, cheapest first, and keep CI from re-pinning itself to the US via
 * the `regions` dispatch default. Anyone who needs a US perf record run
 * passes `regions: ash,hil` explicitly at dispatch time — that path still
 * works, it just is not the default.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../../config.js';

const EU_LOCATIONS = ['nbg1', 'hel1', 'fsn1'] as const;
const WORKFLOW_PATH = join(process.cwd(), '.github', 'workflows', 'e2e-us-perf.yml');

describe('capacityPreferences.hetzner (cost guard)', () => {
  it('lists only EU locations — no ash/hil (US) and no sin (CPX/CCX-only, price uplift)', () => {
    expect(testConfig.e2e.capacityPreferences.hetzner.regions).toEqual(EU_LOCATIONS);
  });

  it('walks type-pairs cheapest-first and never offers the legacy cpx*1 generation', () => {
    const pairs = testConfig.e2e.capacityPreferences.hetzner.typePairs;
    expect(pairs).toEqual([
      ['cx23', 'cx33'],
      ['cpx22', 'cpx32'],
      ['ccx13', 'ccx23'],
    ]);
    for (const [deploy, scale] of pairs) {
      expect(deploy).not.toMatch(/^cpx\d1$/);
      expect(scale).not.toMatch(/^cpx\d1$/);
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
