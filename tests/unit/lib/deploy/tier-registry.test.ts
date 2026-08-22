import { describe, expect, it } from 'vitest';
import {
  isComposeTier,
  isHATier,
  isK8sTier,
  pulumiStackEnvs,
  resolveTier,
  TIERS,
} from '../../../../src/lib/deploy/tier-registry.js';

describe('resolveTier', () => {
  it.each([
    [{ deployMode: 'compose' }, 'compose'],
    [{ deployMode: 'compose', ha: false }, 'compose'],
    [{ deployMode: 'compose-ha' }, 'compose-ha'],
    [{ deployMode: 'kubernetes' }, 'k8s'],
    [{ deployMode: 'kubernetes', ha: false }, 'k8s'],
    [{ deployMode: 'kubernetes', ha: true }, 'k8s-ha'],
    [{ deployMode: 'kubernetes', ha: { enabled: true } }, 'k8s-ha'],
  ])('%j -> %s', (cfg, tier) => {
    expect(resolveTier(cfg)).toBe(tier);
  });

  it('throws on unknown deployMode', () => {
    expect(() => resolveTier({ deployMode: 'swarm' })).toThrow(/swarm/);
    expect(() => resolveTier({})).toThrow();
  });
});

describe('predicates', () => {
  it('classifies every tier exactly', () => {
    expect(TIERS.filter(isHATier)).toEqual(['compose-ha', 'k8s-ha']);
    expect(TIERS.filter(isComposeTier)).toEqual(['compose', 'compose-ha']);
    expect(TIERS.filter(isK8sTier)).toEqual(['k8s', 'k8s-ha']);
  });
});

describe('pulumiStackEnvs', () => {
  // BOTH HA tiers are two-stack — compose-ha's provision fan-out writes
  // `${env}-primary` and `${env}-standby` stacks (lib/deploy/effects/
  // compose-ha.js), same shape as k8s-ha's per-cluster converge. The old
  // compose-ha -> ['e1'] pin encoded the registry's lie, not the deploy's
  // behavior (2026-08-19 vultr stale-stack RCA).
  it.each([
    ['compose', ['e1']],
    ['compose-ha', ['e1-primary', 'e1-standby']],
    ['k8s', ['e1']],
    ['k8s-ha', ['e1-primary', 'e1-standby']],
  ])('%s -> %j', (tier, envs) => {
    expect(pulumiStackEnvs(tier, 'e1')).toEqual(envs);
  });
});
