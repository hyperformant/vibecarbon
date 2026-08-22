import { describe, expect, it } from 'vitest';
import { testConfig } from '../../config.js';

/**
 * Config-shape pins for `testConfig.e2e.providers.digitalocean` (the DO
 * opt-in reference scenarios) and the `capacityPreferences` block it draws
 * from. No test previously pinned these — this file exists because Task 8
 * (M3 DO k8s tier) added d3 and needed a place to pin its shape; it pins
 * d1/d2 alongside it so a future edit to any DO scenario trips a test, not
 * just a live e2e run. Retargeted onto the `providers` registry (the
 * now-deleted `doReferenceScenarios` array this used to read from was
 * removed once the selection grammar made it the single source of truth —
 * see tests/e2e/selection.ts).
 */
describe('providers.digitalocean (DO opt-in reference scenarios)', () => {
  const scenarios = testConfig.e2e.providers.digitalocean.scenarios;

  it('has exactly three entries — k8s-ha deliberately absent, DO has no standby/failover story yet', () => {
    expect(scenarios).toHaveLength(3);
    expect(scenarios.map((s) => s.envPrefix)).toEqual(['d1', 'd2', 'd3']);
  });

  it('d1 is the compose reference scenario', () => {
    expect(scenarios[0]).toEqual({
      mode: 'compose',
      dnsProvider: 'digitalocean',
      envPrefix: 'd1',
    });
  });

  it('d2 is the compose-ha reference scenario', () => {
    expect(scenarios[1]).toEqual({
      mode: 'compose-ha',
      dnsProvider: 'digitalocean',
      envPrefix: 'd2',
    });
  });

  it('d3 is the k8s reference scenario (Task 8) — same dnsProvider shape as d1/d2', () => {
    expect(scenarios[2]).toEqual({
      mode: 'k8s',
      dnsProvider: 'digitalocean',
      envPrefix: 'd3',
    });
  });

  it('every DO scenario is on native DigitalOcean DNS — no extra credential beyond DIGITALOCEAN_API_TOKEN', () => {
    // The DO DNS backend authenticates with the SAME token as DO compute,
    // so a DO-only run needs no Cloudflare credential at all. A scenario
    // silently flipped back to 'cloudflare' would reintroduce that
    // dependency without failing anything until preflight on a machine
    // that happens to have CLOUDFLARE_API_TOKEN set.
    expect(scenarios.every((s) => s.dnsProvider === 'digitalocean')).toBe(true);
  });

  it('names its required credentials', () => {
    expect(testConfig.e2e.providers.digitalocean.requiredEnv).toEqual([
      'DIGITALOCEAN_API_TOKEN',
      'DIGITALOCEAN_ACCESS_KEY',
      'DIGITALOCEAN_SECRET_KEY',
    ]);
  });
});

describe('capacityPreferences.digitalocean', () => {
  it('has one blanket typePair backing every DO reference scenario (d1/d2/d3 all share it)', () => {
    expect(testConfig.e2e.capacityPreferences.digitalocean.typePairs).toEqual([
      ['s-2vcpu-4gb', 's-4vcpu-8gb'],
    ]);
  });

  it('carries the Spaces-supporting regions subset', () => {
    expect(testConfig.e2e.capacityPreferences.digitalocean.regions).toEqual([
      'nyc3',
      'sfo3',
      'ams3',
      'fra1',
    ]);
  });
});

describe('capacityPreferences.hetzner (regression guard)', () => {
  // The release matrix (e1-e4) only ever reads this block. Task 8 touches
  // nothing here — this pins it byte-identical so a future DO-scoped edit
  // can't accidentally bleed into the Hetzner path.
  it('is untouched by the DO k8s reference-scenario addition', () => {
    expect(testConfig.e2e.capacityPreferences.hetzner.regions).toEqual([
      'nbg1',
      'hel1',
      'fsn1',
      'ash',
      'hil',
      'sin',
    ]);
    expect(testConfig.e2e.capacityPreferences.hetzner.typePairs).toEqual([
      ['cx23', 'cx33'],
      ['cpx22', 'cpx32'],
      ['cpx21', 'cpx31'],
      ['ccx13', 'ccx23'],
    ]);
  });
});
