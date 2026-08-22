/**
 * Declared-support ↔ e2e-scenario coverage (declared-but-never-exercised
 * failure class, 2026-07-30).
 *
 * A support claim that no test leg ever executes is how `engines.node >=20`
 * shipped broken against an EOL runtime and how both ghcr images published
 * linux/arm64 for months without the arm64 image being executed once. The
 * deploy-tier matrix is the same shape of claim: `Provider.SUPPORTED_TIERS`
 * is enforced at deploy time (src/lib/providers/index.js), so declaring a
 * tier IS declaring "this deploys" — and the only place that claim is ever
 * proven is a real-infra e2e scenario.
 *
 * This test ties the two structurally, in both directions, for every
 * registered provider:
 *   - every declared tier has a runnable e2e scenario definition (release
 *     matrix for the default provider, opt-in d* reference scenarios for
 *     DigitalOcean — opt-in still means runnable-on-demand; a tier with NO
 *     scenario is a claim nothing can ever exercise);
 *   - every scenario's mode is a declared tier (no zombie scenarios for
 *     support we removed);
 *   - the capacity resolver has a preference block for every provider a
 *     scenario uses (a scenario without capacity preferences fails at
 *     preflight, i.e. is not actually runnable).
 *
 * What this deliberately does NOT prove: cadence. An opt-in DO scenario
 * existing is necessary, not sufficient — docs/tests.md's guard-decision
 * table owns the "run `--provider digitalocean` before a release that
 * touched DO-relevant code" process rule.
 */
import { describe, expect, it } from 'vitest';
import { PROVIDERS as PROVIDERS_RAW } from '../../../src/lib/providers/index.js';
import { testConfig } from '../../config.js';

interface ProviderLike {
  SUPPORTED_TIERS: string[];
}

const PROVIDERS = PROVIDERS_RAW as unknown as Record<string, ProviderLike>;

interface ScenarioLike {
  mode: string;
  envPrefix: string;
}

// Derived directly from the registry (tests/config.ts `providers`) — the
// single source of truth for provider × scenario. A NEW provider's
// scenarios are picked up automatically; no separate mapping to keep in
// sync (that used to be a hand-maintained list against the now-deleted
// `e2e.scenarios`/`doReferenceScenarios` arrays).
const SCENARIOS_BY_PROVIDER: Record<string, readonly ScenarioLike[]> = Object.fromEntries(
  Object.entries(testConfig.e2e.providers).map(([id, p]) => [id, p.scenarios]),
);

describe('provider registry ↔ scenario map', () => {
  it('every registered provider has a scenario list mapped (and no stale mappings)', () => {
    expect(Object.keys(SCENARIOS_BY_PROVIDER).sort()).toEqual(Object.keys(PROVIDERS).sort());
  });

  it('every provider a scenario names has a capacityPreferences block', () => {
    const prefs = testConfig.e2e.capacityPreferences as Record<
      string,
      { regions: readonly string[]; typePairs: readonly (readonly [string, string])[] }
    >;
    for (const [id, scenarios] of Object.entries(SCENARIOS_BY_PROVIDER)) {
      if (scenarios.length === 0) continue;
      expect(prefs[id], `capacityPreferences missing block for provider "${id}"`).toBeDefined();
      expect(prefs[id].regions.length).toBeGreaterThan(0);
      expect(prefs[id].typePairs.length).toBeGreaterThan(0);
    }
  });
});

describe.each(Object.keys(PROVIDERS))('provider %s: SUPPORTED_TIERS ↔ scenarios', (id) => {
  const Provider = PROVIDERS[id];
  const scenarios = SCENARIOS_BY_PROVIDER[id] ?? [];

  it('declares at least one tier (an empty claim set means the mapping rotted)', () => {
    expect(Provider.SUPPORTED_TIERS.length).toBeGreaterThan(0);
  });

  it.each(Provider.SUPPORTED_TIERS ?? [])(
    'declared tier "%s" has an e2e scenario definition',
    (tier) => {
      const covering = scenarios.filter((s) => s.mode === tier);
      expect(
        covering,
        `${id} declares tier "${tier}" in SUPPORTED_TIERS but no scenario in tests/config.ts ` +
          'exercises it. Deploy-mode gating will happily sell this tier to customers while no ' +
          'test can ever run it. Add a scenario (opt-in is fine) or remove the claim.',
      ).not.toHaveLength(0);
    },
  );

  it('every scenario mode is a declared tier (no zombie scenarios)', () => {
    for (const s of scenarios) {
      expect(
        Provider.SUPPORTED_TIERS,
        `scenario ${s.envPrefix} runs mode "${s.mode}" which ${id} no longer declares`,
      ).toContain(s.mode);
    }
  });
});
