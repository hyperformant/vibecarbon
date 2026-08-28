import { describe, expect, it } from 'vitest';
import { testConfig } from '../../config.js';

describe('e2e provider registry', () => {
  const providers = testConfig.e2e.providers;

  it('lists hetzner first — registry ORDER only, not precedence', () => {
    // Order decides README block order and the sequence a multi-provider run
    // walks. It confers nothing else: no provider is a default (resolveSelection
    // throws without an explicit --provider) and none gates a release.
    expect(Object.keys(providers)[0]).toBe('hetzner');
  });

  it('carries no per-provider precedence flag at all', () => {
    // `releaseGating` was removed 2026-08-12. It named a privilege that did not
    // exist — nothing consumed it but the bare-run fallback in selection.ts,
    // and release.yml fires on the unit/integration Test Suite, never on e2e.
    // A reader checking whether vibecarbon favours a provider must find nothing.
    for (const [name, p] of Object.entries(providers)) {
      expect(Object.keys(p), `${name} must carry no precedence flag`).not.toContain(
        'releaseGating',
      );
    }
  });

  it('hetzner supports all four modes and defaults to all four', () => {
    expect(providers.hetzner.scenarios.map((s) => s.mode)).toEqual([
      'compose',
      'compose-ha',
      'k8s',
      'k8s-ha',
    ]);
    expect(providers.hetzner.defaultSelection).toEqual(['compose', 'compose-ha', 'k8s', 'k8s-ha']);
  });

  it('digitalocean supports all four modes and defaults to all four (d4 lift, 2026-08-27)', () => {
    expect(providers.digitalocean.scenarios.map((s) => s.mode)).toEqual([
      'compose',
      'compose-ha',
      'k8s',
      'k8s-ha',
    ]);
    expect(providers.digitalocean.defaultSelection).toEqual([
      'compose',
      'compose-ha',
      'k8s',
      'k8s-ha',
    ]);
    expect(providers.digitalocean.requiredEnv).toContain('DIGITALOCEAN_API_TOKEN');
  });

  it('env prefixes are unique across all providers', () => {
    const prefixes = Object.values(providers).flatMap((p) => p.scenarios.map((s) => s.envPrefix));
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('every defaultSelection entry names a supported scenario mode', () => {
    for (const p of Object.values(providers)) {
      const modes = new Set(p.scenarios.map((s) => s.mode));
      for (const m of p.defaultSelection) expect(modes.has(m)).toBe(true);
    }
  });

  it('every provider has a displayName', () => {
    expect(providers.hetzner.displayName).toBe('Hetzner Cloud');
    expect(providers.digitalocean.displayName).toBe('DigitalOcean');
  });
});
