import { afterEach, describe, expect, it, vi } from 'vitest';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { buildK8sProfileOptions, K8S_PROFILES } from '../../../src/lib/server-types.js';

/**
 * Availability invariants for the Hetzner catalog.
 *
 * Deliberately NOT a snapshot of which SKUs are orderable today. Hetzner flips
 * `available` without notice and in both directions (the whole `cx*3` line went
 * true -> false in the EU inside a single review cycle), so any test that pinned
 * 2026-07-30's catalog would be wrong within weeks and would then be "fixed" by
 * editing the expectation rather than the code.
 *
 * What is asserted instead is structural, and stays true whatever Hetzner does:
 *   1. The filter reads BOTH flags that can make a SKU unplaceable.
 *   2. Whatever the live catalog says, no offer path emits a SKU outside it.
 *   3. The offline constants are internally coherent and never name a SKU from
 *      a line that has been permanently retired in the region it is offered for.
 */

const seed = (locationTypes: Record<string, Set<string>>) => {
  (HetznerProvider as unknown as { _locationTypes: unknown })._locationTypes = locationTypes;
};

afterEach(() => {
  (HetznerProvider as unknown as { _locationTypes: unknown })._locationTypes = null;
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. The filter itself
// ---------------------------------------------------------------------------

describe('isLocationOrderable', () => {
  it('excludes an explicitly unavailable location', () => {
    expect(HetznerProvider.isLocationOrderable({ name: 'fsn1', available: false })).toBe(false);
  });

  it('excludes a deprecated location', () => {
    expect(
      HetznerProvider.isLocationOrderable({ name: 'fsn1', deprecation: { announced: 'x' } }),
    ).toBe(false);
  });

  it('accepts an available, non-deprecated location', () => {
    expect(HetznerProvider.isLocationOrderable({ name: 'fsn1', available: true })).toBe(true);
  });

  it('treats a MISSING available flag as orderable, not as unavailable', () => {
    // Absence must never empty the catalog — only an explicit false excludes.
    expect(HetznerProvider.isLocationOrderable({ name: 'fsn1' })).toBe(true);
    expect(HetznerProvider.isLocationOrderable('fsn1')).toBe(true);
  });
});

describe('fetchServerTypes honours per-location availability', () => {
  const apiResponse = {
    server_types: [
      {
        name: 'sku-live',
        cores: 2,
        memory: 4,
        disk: 80,
        cpu_type: 'shared',
        architecture: 'x86',
        locations: [
          { name: 'regionA', available: true },
          { name: 'regionB', available: false },
        ],
      },
      {
        name: 'sku-dead',
        cores: 2,
        memory: 4,
        disk: 40,
        cpu_type: 'shared',
        architecture: 'x86',
        locations: [
          { name: 'regionA', available: false },
          { name: 'regionB', deprecation: { announced: 'x' } },
        ],
      },
    ],
  };

  it('drops locations where the SKU is available:false, keeping the ones where it is not', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => apiResponse })),
    );
    (HetznerProvider as unknown as { _locationTypes: unknown })._locationTypes = null;

    expect(await HetznerProvider.fetchServerTypes('tok')).toBe(true);

    const byLocation = (
      HetznerProvider as unknown as { _locationTypes: Record<string, Set<string>> }
    )._locationTypes;

    // sku-live is placeable only in regionA.
    expect([...byLocation.regionA]).toEqual(['sku-live']);
    // sku-dead is placeable nowhere, so regionB has no entry at all.
    expect(byLocation.regionB).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. No offer path escapes the live catalog
// ---------------------------------------------------------------------------

describe('offered SKUs never escape the live catalog', () => {
  // An arbitrary, deliberately odd catalog. The point is that the assertions
  // below hold for ANY set — they never name a real Hetzner SKU expectation.
  const catalogs: Record<string, string[]> = {
    onlyCurrent: ['cpx22', 'cpx32', 'cpx42', 'cpx62'],
    onlyLegacy: ['cpx11', 'cpx21', 'cpx31', 'cpx41'],
    mixed: ['cpx11', 'cpx22', 'cpx32', 'cx23'],
  };

  for (const [label, names] of Object.entries(catalogs)) {
    it(`getRegionDefaults returns only catalog members (${label})`, () => {
      seed({ testregion: new Set(names) });
      const d = HetznerProvider.getRegionDefaults('testregion');
      for (const t of [d.masterType, d.supabaseType, d.workerType]) {
        expect(names).toContain(t);
      }
    });

    it(`buildK8sProfileOptions offers only catalog members (${label})`, () => {
      const regionTypes = names.map((name) => ({
        name,
        vcpu: 2,
        ram: 4,
        disk: 40,
        cpuType: 'shared',
        architecture: 'x86',
      }));
      const offered = buildK8sProfileOptions(regionTypes).filter((o) => o._variant);

      // Non-vacuity gate FIRST. "Never emits a SKU outside the seeded set" is
      // trivially true of an empty emit set, so an implementation that offered
      // nothing at all would sail through the containment loop below. Each of
      // these catalogs fully stocks at least one profile, so it must offer one.
      expect(offered.length).toBeGreaterThan(0);

      for (const opt of offered) {
        for (const t of Object.values(opt._variant)) expect(names).toContain(t);
      }
    });
  }

  it('a profile is dropped entirely rather than offered with an unstocked SKU', () => {
    // Only part of each triple present -> no named profile is satisfiable.
    const regionTypes = [
      { name: 'cpx22', vcpu: 2, ram: 4, disk: 40, cpuType: 'shared', architecture: 'x86' },
    ];
    expect(buildK8sProfileOptions(regionTypes).map((o) => o.value)).toEqual(['advanced']);
  });
});

// ---------------------------------------------------------------------------
// 3. Offline-constant coherence
// ---------------------------------------------------------------------------

describe('offline constants are coherent', () => {
  // Permanently retired lines. Deprecation, unlike `available`, does not
  // reverse — Hetzner has never un-deprecated a server plan — so pinning these
  // is durable in a way that pinning availability is not.
  const RETIRED_IN_EU = ['cpx11', 'cpx21', 'cpx31', 'cpx41', 'cpx51'];
  const RETIRED_EVERYWHERE = ['cx22', 'cx32', 'cx42', 'cx52'];

  it('every offline EU default avoids permanently retired SKUs', () => {
    for (const region of HetznerProvider.EU_REGIONS) {
      const d = HetznerProvider.getRegionDefaults(region);
      for (const t of [d.masterType, d.supabaseType, d.workerType]) {
        expect(RETIRED_IN_EU).not.toContain(t);
        expect(RETIRED_EVERYWHERE).not.toContain(t);
      }
    }
  });

  it('no default anywhere names a globally retired SKU', () => {
    for (const region of [...HetznerProvider.EU_REGIONS, ...HetznerProvider.US_REGIONS]) {
      const d = HetznerProvider.getRegionDefaults(region);
      for (const t of [d.masterType, d.supabaseType, d.workerType]) {
        expect(RETIRED_EVERYWHERE).not.toContain(t);
      }
    }
  });

  it('the three generic defaults agree', () => {
    expect(HetznerProvider.DEFAULT_COMPOSE_TYPE).toBe(HetznerProvider.DEFAULT_TYPE);
    expect(HetznerProvider.DEFAULT_K8S_NODE_TYPE).toBe(HetznerProvider.DEFAULT_TYPE);
  });

  it('every constant SKU we might offer is a known catalog entry', () => {
    const named = [
      HetznerProvider.DEFAULT_TYPE,
      HetznerProvider.DEFAULT_COMPOSE_TYPE,
      HetznerProvider.DEFAULT_K8S_NODE_TYPE,
      ...Object.values(HetznerProvider.ARM_TO_AMD64),
      ...K8S_PROFILES.flatMap((p) => [
        ...Object.values(p.types),
        ...Object.values(p.fallbackTypes),
      ]),
    ];
    for (const t of named) {
      expect(HetznerProvider.FALLBACK_SERVER_TYPES).toHaveProperty(t);
    }
  });

  it('ARM rescue targets are current-generation and never shrink the node', () => {
    // cax specs are Hetzner's; the rescue must meet or exceed vCPU and RAM.
    const CAX = {
      cax11: { vcpu: 2, ram: 4 },
      cax21: { vcpu: 4, ram: 8 },
      cax31: { vcpu: 8, ram: 16 },
      cax41: { vcpu: 16, ram: 32 },
    };
    for (const [arm, x86] of Object.entries(HetznerProvider.ARM_TO_AMD64)) {
      const target = HetznerProvider.FALLBACK_SERVER_TYPES[x86];
      expect(target.vcpu).toBeGreaterThanOrEqual(CAX[arm].vcpu);
      expect(target.ram).toBeGreaterThanOrEqual(CAX[arm].ram);
      // cax only ever existed in the EU, so the rescue must not land on a line
      // that is permanently retired there.
      expect(RETIRED_IN_EU).not.toContain(x86);
    }
  });

  it('K8S_PROFILES current-generation triples avoid EU-retired SKUs', () => {
    // `types` is the triple offered to EU operators; `fallbackTypes` is the
    // US-only legacy line, which is legitimately still cpx*1.
    for (const p of K8S_PROFILES) {
      for (const t of Object.values(p.types)) expect(RETIRED_IN_EU).not.toContain(t);
    }
  });
});
