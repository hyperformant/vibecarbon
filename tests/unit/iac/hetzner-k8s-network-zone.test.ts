import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { networkZoneFor } from '../../../src/lib/iac/programs/hetzner-k8s.js';

// CD1: networkZone moved from shared deploy/utils.js into the Pulumi program
// itself — it's now derived at the single consumption site (the
// NetworkSubnet's `networkZone`, hetzner-k8s.js ~:113) from `config.location`
// instead of being computed by two producers (k3s.js deploy path,
// scale-plan.js scale path) and passed in as a config field. Deriving inside
// the program makes deploy/scale agreement structural instead of
// convention — there is exactly one place location maps to a zone.
//
// This relocates the coverage that used to live in
// tests/unit/lib/scale-plan.test.ts under
// "networkZoneFor (shared deploy/scale derivation)": both the
// location→zone mapping table and the regression guard against a
// hardcoded literal (2026-07-10: a US-region scale against an eu-central
// subnet plans an impossible replacement). The hardcode class of bug is now
// impossible by construction — the blocking grep gate for CD1 confines
// networkZoneFor to this module, so there is nowhere else for a second,
// possibly-drifted derivation to live.
describe('networkZoneFor (Pulumi-program-local derivation)', () => {
  it('maps representative Hetzner locations to their private-network zone', () => {
    expect(networkZoneFor('fsn1')).toBe('eu-central');
    expect(networkZoneFor('nbg1')).toBe('eu-central');
    expect(networkZoneFor('hel1')).toBe('eu-central');
    expect(networkZoneFor('ash')).toBe('us-east');
    expect(networkZoneFor('hil')).toBe('us-west');
    expect(networkZoneFor('sin')).toBe('ap-southeast');
  });

  it('falls back to eu-central for an unknown location', () => {
    expect(networkZoneFor('unknown-loc')).toBe('eu-central');
  });

  // Source-text guard, mirroring the tripwire that used to live in
  // tests/unit/lib/scale-plan.test.ts ("REGRESSION 2026-07-10: deploy must
  // not hardcode eu-central") before CD1 retired that file. That test read
  // src/lib/deploy/k8s/k3s.js's source text; the derivation now lives here
  // instead, so the guard follows it to its new consumption site.
  it('REGRESSION 2026-07-10 (mirrored from the retired scale-plan.test.ts tripwire): the NetworkSubnet must wire networkZone through networkZoneFor(config.location), never a hardcoded literal', () => {
    const source = readFileSync('src/lib/iac/programs/hetzner-k8s.js', 'utf-8');
    expect(source).toContain('networkZone: networkZoneFor(config.location)');
    expect(source).not.toMatch(/networkZone:\s*'eu-central'/);
  });
});
