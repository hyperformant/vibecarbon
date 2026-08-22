import { describe, expect, it } from 'vitest';
import {
  buildComposeTypeOptions,
  buildK8sProfileOptions,
  COMPOSE_MIN_RAM_GB,
  DEFAULT_WORKER_MAX,
  DEFAULT_WORKER_MIN,
  detectCurrentProfile,
  K8S_PROFILES,
} from '../../../src/deploy.js';

// NOTE: parseArgs-driven tests for deploy were retired in PR 4 of the CLI
// rewrite; deploy's flag matrix now lives in
// tests/integration/cli/deploy/deploy.test.ts (spawn-based, via the harness).

describe('Compose server type options', () => {
  // Mirrors an EU region catalog: Hetzner does offer the ARM (cax) line in
  // fsn1/hel1/nbg1, so the builder really is handed these. vibecarbon is
  // amd64-only, so none of them may reach the operator's picker.
  const mockRegionTypes = [
    { name: 'cpx11', vcpu: 2, ram: 2, disk: 40, cpuType: 'shared', architecture: 'x86' },
    { name: 'cx22', vcpu: 2, ram: 4, disk: 40, cpuType: 'shared', architecture: 'x86' },
    { name: 'cx23', vcpu: 2, ram: 4, disk: 40, cpuType: 'shared', architecture: 'x86' },
    { name: 'cpx21', vcpu: 3, ram: 4, disk: 80, cpuType: 'shared', architecture: 'x86' },
    { name: 'cax11', vcpu: 2, ram: 4, disk: 40, cpuType: 'shared', architecture: 'arm' },
    { name: 'cax21', vcpu: 4, ram: 8, disk: 80, cpuType: 'shared', architecture: 'arm' },
    { name: 'cax31', vcpu: 8, ram: 16, disk: 160, cpuType: 'shared', architecture: 'arm' },
    { name: 'ccx13', vcpu: 2, ram: 8, disk: 80, cpuType: 'dedicated', architecture: 'x86' },
  ];

  it('COMPOSE_MIN_RAM_GB is 4', () => {
    expect(COMPOSE_MIN_RAM_GB).toBe(4);
  });

  it('disables types with RAM below minimum', () => {
    const options = buildComposeTypeOptions(mockRegionTypes, 'cpx21');
    const cpx11 = options.find((o) => o.value === 'cpx11');

    expect(cpx11).toBeDefined();
    expect(cpx11?.disabled).toBe(true);
    expect(cpx11?.hint).toContain('4GB+ RAM');
  });

  it('marks borderline types as minimum', () => {
    const options = buildComposeTypeOptions(mockRegionTypes, 'cpx21');
    const cx22 = options.find((o) => o.value === 'cx22');

    expect(cx22?.disabled).toBeFalsy();
    expect(cx22?.hint).toContain('minimum');
  });

  it('marks the default type as recommended', () => {
    const options = buildComposeTypeOptions(mockRegionTypes, 'cpx21');
    const cpx21 = options.find((o) => o.value === 'cpx21');

    expect(cpx21?.disabled).toBeFalsy();
    expect(cpx21?.hint).toContain('recommended');
  });

  it('does not put prices in hints (Hetzner prices are not hard-coded)', () => {
    const options = buildComposeTypeOptions(mockRegionTypes, 'cpx21');
    for (const opt of options) {
      expect(opt.hint).not.toContain('€');
      expect(opt.hint).not.toContain('/mo');
    }
  });

  it('filters out dedicated CPU types', () => {
    const options = buildComposeTypeOptions(mockRegionTypes, 'cpx21');
    const dedicated = options.find((o) => o.value === 'ccx13');

    expect(dedicated).toBeUndefined();
  });

  it('never offers an ARM type, even in a region that has the whole cax line', () => {
    const options = buildComposeTypeOptions(mockRegionTypes, 'cpx21');
    expect(options.some((o) => o.value.startsWith('cax'))).toBe(false);
    expect(options.some((o) => o.label.includes('cax'))).toBe(false);
  });
});

describe('K8s profile options', () => {
  it('K8S_PROFILES has starter, production, and enterprise', () => {
    expect(K8S_PROFILES).toHaveLength(3);
    expect(K8S_PROFILES.map((p) => p.name)).toEqual(['starter', 'production', 'enterprise']);
  });

  it('all profile types exist in HetznerProvider fallback catalog', () => {
    const { HetznerProvider } = require('../../../src/lib/providers/hetzner.js');
    for (const profile of K8S_PROFILES) {
      const variant = profile.types;
      expect(HetznerProvider.FALLBACK_SERVER_TYPES[variant.master]).toBeDefined();
      expect(HetznerProvider.FALLBACK_SERVER_TYPES[variant.supabase]).toBeDefined();
      expect(HetznerProvider.FALLBACK_SERVER_TYPES[variant.worker]).toBeDefined();
    }
  });

  it('builds profile options with an Advanced option and no hard-coded prices', () => {
    const regionTypes = [
      { name: 'cpx11', vcpu: 2, ram: 2, disk: 40, cpuType: 'shared', architecture: 'x86' },
      { name: 'cpx21', vcpu: 3, ram: 4, disk: 80, cpuType: 'shared', architecture: 'x86' },
      { name: 'cpx31', vcpu: 4, ram: 8, disk: 160, cpuType: 'shared', architecture: 'x86' },
      { name: 'cpx41', vcpu: 8, ram: 16, disk: 240, cpuType: 'shared', architecture: 'x86' },
    ];
    const options = buildK8sProfileOptions(regionTypes);

    // 3 profiles + Advanced
    expect(options).toHaveLength(4);
    expect(options[options.length - 1].value).toBe('advanced');

    // Labels carry no price (Hetzner prices are not hard-coded)
    for (const opt of options.slice(0, 3)) {
      expect(opt.label).not.toContain('€');
      expect(opt.label).not.toContain('/mo');
    }
  });

  it('filters out profiles unavailable in the region', () => {
    // Only small types available — enterprise profile should be dropped
    const regionTypes = [
      { name: 'cpx11', vcpu: 2, ram: 2, disk: 40, cpuType: 'shared', architecture: 'x86' },
      { name: 'cpx21', vcpu: 3, ram: 4, disk: 80, cpuType: 'shared', architecture: 'x86' },
    ];
    const options = buildK8sProfileOptions(regionTypes);

    // Only starter should be available (needs cpx11 + cpx21 + cpx11), plus Advanced
    const profileNames = options.map((o) => o.value);
    expect(profileNames).toContain('starter');
    expect(profileNames).toContain('advanced');
    expect(profileNames).not.toContain('production');
    expect(profileNames).not.toContain('enterprise');
  });

  it('offers no ARM node type even when the region carries the whole cax line', () => {
    const regionTypes = [
      { name: 'cpx11', vcpu: 2, ram: 2, disk: 40, cpuType: 'shared', architecture: 'x86' },
      { name: 'cpx21', vcpu: 3, ram: 4, disk: 80, cpuType: 'shared', architecture: 'x86' },
      { name: 'cax11', vcpu: 2, ram: 4, disk: 40, cpuType: 'shared', architecture: 'arm' },
      { name: 'cax21', vcpu: 4, ram: 8, disk: 80, cpuType: 'shared', architecture: 'arm' },
    ];
    const options = buildK8sProfileOptions(regionTypes);
    for (const opt of options) {
      expect(opt.hint ?? '').not.toContain('cax');
      for (const t of Object.values(opt._variant ?? {})) expect(t).not.toMatch(/^cax/);
    }
  });
});

describe('detectCurrentProfile', () => {
  it('detects x86 production profile', () => {
    expect(detectCurrentProfile('cpx21', 'cpx31', 'cpx21')).toBe('production');
  });

  it('classifies a pre-existing ARM trio as advanced (no ARM profile is offered)', () => {
    expect(detectCurrentProfile('cax11', 'cax21', 'cax11')).toBe('advanced');
  });

  it('returns advanced for custom combinations', () => {
    expect(detectCurrentProfile('cax11', 'cax31', 'cax21')).toBe('advanced');
  });
});

describe('Default worker configuration', () => {
  it('DEFAULT_WORKER_MIN is 1 (avoids cold starts on the static floor)', () => {
    expect(DEFAULT_WORKER_MIN).toBe(1);
  });

  it('DEFAULT_WORKER_MAX is 3 (bounded autoscaler ceiling)', () => {
    expect(DEFAULT_WORKER_MAX).toBe(3);
  });
});
