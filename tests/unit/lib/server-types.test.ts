/**
 * Unit tests for lib/server-types.js — the pure decision logic behind the
 * deploy/scale server-type prompts. This is the exact code path that broke
 * when Hetzner retired the cx11/cx21/cx22 line (stale defaults offered types
 * that no longer exist), so the selection/filtering rules get pinned here.
 */

import { describe, expect, it } from 'vitest';
import {
  buildComposeTypeOptions,
  buildK8sProfileOptions,
  buildSimpleTypeOptions,
  COMPOSE_MIN_RAM_GB,
  detectCurrentProfile,
  filterAmd64Types,
  K8S_PROFILES,
} from '../../../src/lib/server-types.js';

// Shapes mirror HetznerProvider.getServerTypesForRegion() output — including
// the `architecture` field it stamps on every entry.
const REGION_TYPES = [
  { name: 'cx23', vcpu: 2, ram: 4, disk: 40, cpuType: 'shared', architecture: 'x86' },
  { name: 'cpx11', vcpu: 2, ram: 2, disk: 40, cpuType: 'shared', architecture: 'x86' },
  { name: 'cpx21', vcpu: 3, ram: 4, disk: 80, cpuType: 'shared', architecture: 'x86' },
  { name: 'cpx31', vcpu: 4, ram: 8, disk: 160, cpuType: 'shared', architecture: 'x86' },
  { name: 'ccx13', vcpu: 2, ram: 8, disk: 80, cpuType: 'dedicated', architecture: 'x86' },
];

// An EU region catalog: Hetzner really does offer the ARM line in
// fsn1/hel1/nbg1, so this is what the builders receive there. Nothing the CLI
// presents may contain these — vibecarbon is amd64-only.
const ARM_TYPES = [
  { name: 'cax11', vcpu: 2, ram: 4, disk: 40, cpuType: 'shared', architecture: 'arm' },
  { name: 'cax21', vcpu: 4, ram: 8, disk: 80, cpuType: 'shared', architecture: 'arm' },
  { name: 'cax31', vcpu: 8, ram: 16, disk: 160, cpuType: 'shared', architecture: 'arm' },
  { name: 'cax41', vcpu: 16, ram: 32, disk: 320, cpuType: 'shared', architecture: 'arm' },
];
const MIXED_REGION_TYPES = [...REGION_TYPES, ...ARM_TYPES];

describe('buildComposeTypeOptions', () => {
  it('filters out dedicated-CPU types', () => {
    const options = buildComposeTypeOptions(REGION_TYPES, 'cpx21');
    expect(options.map((o) => o.value)).not.toContain('ccx13');
  });

  it('disables types below the Compose RAM floor with an explanatory hint', () => {
    const options = buildComposeTypeOptions(REGION_TYPES, 'cpx21');
    const small = options.find((o) => o.value === 'cpx11');
    expect(small.disabled).toBe(true);
    expect(small.hint).toContain(`${COMPOSE_MIN_RAM_GB}GB+`);
  });

  it('marks the smallest viable type as minimum and the default as recommended', () => {
    const options = buildComposeTypeOptions(REGION_TYPES, 'cpx21');
    // cx23: exactly 4GB RAM and <=40GB disk → minimum
    expect(options.find((o) => o.value === 'cx23').hint).toBe('minimum');
    expect(options.find((o) => o.value === 'cpx21').hint).toBe('recommended');
    expect(options.find((o) => o.value === 'cpx31').hint).toBe('');
  });

  it('renders aligned labels carrying vCPU / RAM / disk specs', () => {
    const options = buildComposeTypeOptions(REGION_TYPES, 'cpx21');
    const label = options.find((o) => o.value === 'cpx31').label;
    expect(label).toContain('cpx31');
    expect(label).toContain('4 vCPU');
    expect(label).toContain('8GB RAM');
    expect(label).toContain('160GB');
  });
});

describe('buildSimpleTypeOptions', () => {
  it('filters to shared-CPU types by default', () => {
    const options = buildSimpleTypeOptions(REGION_TYPES);
    expect(options.map((o) => o.value)).toEqual(['cx23', 'cpx11', 'cpx21', 'cpx31']);
  });

  it('keeps dedicated types when filterSharedCpu is false', () => {
    const options = buildSimpleTypeOptions(REGION_TYPES, { filterSharedCpu: false });
    expect(options.map((o) => o.value)).toContain('ccx13');
  });
});

describe('buildK8sProfileOptions', () => {
  const namesToTypes = (names: string[]) =>
    names.map((name) => ({
      name,
      vcpu: 2,
      ram: 4,
      disk: 40,
      cpuType: 'shared',
      architecture: name.startsWith('cax') ? 'arm' : 'x86',
    }));

  it('offers the x86 trio for every profile', () => {
    const names = K8S_PROFILES.flatMap((p) => [p.types.master, p.types.supabase, p.types.worker]);
    const options = buildK8sProfileOptions(namesToTypes([...new Set(names)]));
    const starter = options.find((o) => o.value === 'starter');
    expect(starter._variant).toEqual(K8S_PROFILES[0].types);
  });

  it('offers no ARM profile when the region carries the ARM line (amd64-only)', () => {
    // Regression pin: buildK8sProfileOptions used to switch the whole cluster
    // to `profile.arm` the moment cax11 appeared in the region catalog, which
    // silently made every EU k8s deploy ARM.
    const armOnly = namesToTypes(['cax11', 'cax21', 'cax31', 'cax41']);
    const options = buildK8sProfileOptions(armOnly);
    // No profile is satisfiable from an ARM-only catalog — only Advanced.
    expect(options.map((o) => o.value)).toEqual(['advanced']);

    // And with BOTH lines present, the offered trios stay x86.
    const mixed = namesToTypes(['cpx11', 'cpx21', 'cpx31', 'cpx41', 'cax11', 'cax21', 'cax31']);
    const mixedOptions = buildK8sProfileOptions(mixed);
    for (const opt of mixedOptions) {
      if (!opt._variant) continue;
      for (const t of Object.values(opt._variant)) expect(t).not.toMatch(/^cax/);
      expect(opt.hint).not.toContain('cax');
    }
  });

  it('offers every profile from an EU-only current-generation catalog', () => {
    // Regression pin for the 2026-01-01 Hetzner deprecation: every profile used
    // to name cpx*1 exclusively, so once that line went unorderable in the EU
    // all three were filtered out and the k8s size prompt collapsed to
    // "Advanced" in the default region.
    const eu = namesToTypes(['cpx22', 'cpx32', 'cpx42', 'cpx62']);
    const options = buildK8sProfileOptions(eu);
    expect(options.map((o) => o.value)).toEqual([
      'starter',
      'production',
      'enterprise',
      'advanced',
    ]);
    for (const opt of options) {
      if (!opt._variant) continue;
      for (const t of Object.values(opt._variant)) expect(t).toMatch(/^cpx\d2$/);
    }
  });

  it('falls back to the legacy cpx line for a US-only catalog', () => {
    // ash/hil never had a cx line and have not received the cpx*2 generation,
    // so the legacy cpx*1 trio is still the correct answer there.
    const us = namesToTypes(['cpx11', 'cpx21', 'cpx31', 'cpx41', 'cpx51']);
    const options = buildK8sProfileOptions(us);
    expect(options.map((o) => o.value)).toEqual([
      'starter',
      'production',
      'enterprise',
      'advanced',
    ]);
    expect(options.find((o) => o.value === 'starter')._variant).toEqual(
      K8S_PROFILES[0].fallbackTypes,
    );
  });

  it('drops profiles whose node types are not all available', () => {
    // Only starter's x86 trio available — production/enterprise need cpx31/cpx41.
    const options = buildK8sProfileOptions(namesToTypes(['cpx11', 'cpx21']));
    expect(options.map((o) => o.value)).toEqual(['starter', 'advanced']);
  });

  it('always appends the advanced option last', () => {
    const options = buildK8sProfileOptions(namesToTypes([]));
    expect(options.at(-1)).toMatchObject({ value: 'advanced', _variant: null });
  });
});

describe('detectCurrentProfile', () => {
  it('matches an x86 profile trio', () => {
    expect(detectCurrentProfile('cpx21', 'cpx31', 'cpx21')).toBe('production');
  });

  it('classifies a pre-existing ARM trio as advanced (no ARM profile exists)', () => {
    // Doesn't throw, doesn't render blank — an environment provisioned before
    // the x86-64 standardization is simply "advanced" (custom).
    expect(detectCurrentProfile('cax11', 'cax21', 'cax11')).toBe('advanced');
  });

  it('returns advanced for a mixed/unknown trio', () => {
    expect(detectCurrentProfile('cax11', 'cpx31', 'cx23')).toBe('advanced');
  });
});

describe('amd64-only presentation guarantee', () => {
  // The CLI must never PRESENT an architecture choice: an ARM type may not
  // appear in any list a user can pick from, in any command. Every option
  // builder in this module funnels through filterAmd64Types, so these pins
  // cover the surface as a whole rather than one prompt at a time.

  it('filterAmd64Types drops ARM and keeps x86', () => {
    expect(filterAmd64Types(MIXED_REGION_TYPES).map((t) => t.name)).toEqual(
      REGION_TYPES.map((t) => t.name),
    );
  });

  it('keeps entries with no architecture field (all-x86 provider catalogs)', () => {
    const noArch = [{ name: 's-2vcpu-4gb', vcpu: 2, ram: 4, disk: 80 }];
    expect(filterAmd64Types(noArch).map((t) => t.name)).toEqual(['s-2vcpu-4gb']);
  });

  it('buildComposeTypeOptions offers no cax type even when the region has them', () => {
    const values = buildComposeTypeOptions(MIXED_REGION_TYPES, 'cx23').map((o) => o.value);
    expect(values.some((v) => v.startsWith('cax'))).toBe(false);
    expect(values).toContain('cx23');
  });

  it('buildSimpleTypeOptions offers no cax type — including with filterSharedCpu:false', () => {
    // scale.js:1042 calls it exactly this way for the master/supabase/worker
    // pickers; that call is how ARM reached the scale picker.
    for (const opts of [
      buildSimpleTypeOptions(MIXED_REGION_TYPES),
      buildSimpleTypeOptions(MIXED_REGION_TYPES, { filterSharedCpu: false }),
    ]) {
      expect(opts.some((o) => o.value.startsWith('cax'))).toBe(false);
      expect(opts.some((o) => o.label.includes('cax'))).toBe(false);
    }
  });

  it('K8S_PROFILES carries no ARM variant at all', () => {
    for (const profile of K8S_PROFILES) {
      expect(profile).not.toHaveProperty('arm');
      for (const v of [profile.types, profile.fallbackTypes]) {
        for (const t of Object.values(v)) expect(t).not.toMatch(/^cax/);
      }
    }
  });

  it('detectCurrentProfile matches both generations of a profile', () => {
    expect(detectCurrentProfile('cpx32', 'cpx42', 'cpx32')).toBe('production');
    expect(detectCurrentProfile('cpx21', 'cpx31', 'cpx21')).toBe('production');
  });
});
