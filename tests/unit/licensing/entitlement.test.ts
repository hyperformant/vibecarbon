import { describe, expect, it } from 'vitest';
import {
  daysLeft,
  evaluateDeployEntitlement,
  graceEndOf,
  requiredTierFor,
  TIER_FOR_DEPLOY_TIER,
  tierSatisfies,
} from '../../../src/lib/licensing/entitlement.js';

describe('TIER_FOR_DEPLOY_TIER', () => {
  it('maps every deploy tier to its required license tier', () => {
    expect(TIER_FOR_DEPLOY_TIER).toEqual({
      compose: 'graphite',
      k8s: 'graphene',
      'compose-ha': 'fullerene',
      'k8s-ha': 'fullerene',
    });
  });
});

describe('requiredTierFor', () => {
  it('maps each known deploy tier', () => {
    expect(requiredTierFor('compose')).toBe('graphite');
    expect(requiredTierFor('k8s')).toBe('graphene');
    expect(requiredTierFor('compose-ha')).toBe('fullerene');
    expect(requiredTierFor('k8s-ha')).toBe('fullerene');
  });

  it('fails closed to fullerene for an unknown or missing deploy tier', () => {
    expect(requiredTierFor('bogus')).toBe('fullerene');
    expect(requiredTierFor(undefined)).toBe('fullerene');
    expect(requiredTierFor(null)).toBe('fullerene');
    expect(requiredTierFor('')).toBe('fullerene');
  });
});

describe('tierSatisfies', () => {
  it('true when license tier is at or above the required tier', () => {
    expect(tierSatisfies('graphite', 'graphite')).toBe(true);
    expect(tierSatisfies('graphene', 'graphite')).toBe(true);
    expect(tierSatisfies('fullerene', 'graphite')).toBe(true);
    expect(tierSatisfies('graphene', 'graphene')).toBe(true);
    expect(tierSatisfies('fullerene', 'graphene')).toBe(true);
    expect(tierSatisfies('fullerene', 'fullerene')).toBe(true);
  });

  it('false when license tier is below the required tier', () => {
    expect(tierSatisfies('graphite', 'graphene')).toBe(false);
    expect(tierSatisfies('graphite', 'fullerene')).toBe(false);
    expect(tierSatisfies('graphene', 'fullerene')).toBe(false);
  });

  it('false for an unknown license tier', () => {
    expect(tierSatisfies('agency', 'graphite')).toBe(false);
    expect(tierSatisfies('bogus', 'graphite')).toBe(false);
    expect(tierSatisfies(undefined, 'graphite')).toBe(false);
  });
});

describe('evaluateDeployEntitlement', () => {
  const PID = '11111111-2222-3333-4444-555555555555';
  const NOW = '2026-09-14';
  const v2 = {
    active: true,
    key: 'vc-0123456789abcdef-sig',
    licenseId: '0123456789abcdef',
  };
  const live = (verdict: object) => ({
    source: 'live',
    verdict: { projectId: PID, issued: NOW, ...verdict },
  });
  const cached = (verdict: object) => ({
    source: 'cache',
    verdict: { projectId: PID, issued: '2026-08-01', ...verdict },
  });
  const ev = (args: Partial<Parameters<typeof evaluateDeployEntitlement>[0]>) =>
    evaluateDeployEntitlement({
      license: v2,
      deployTier: 'k8s',
      projectId: PID,
      check: { source: 'none', verdict: null },
      now: NOW,
      ...args,
    });

  it('compose never checks, even with check.source rejected', () => {
    const result = ev({
      deployTier: 'compose',
      license: null,
      check: { source: 'rejected', verdict: null },
    });
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('warning');
  });

  it('no license, k8s -> no-license', () => {
    const result = ev({ license: null });
    expect(result).toMatchObject({ ok: false, reason: 'no-license', requiredTier: 'graphene' });
  });

  it('unbound verdict blocks with reason unbound, no grace', () => {
    const r = evaluateDeployEntitlement({
      license: v2,
      deployTier: 'k8s',
      projectId: PID,
      now: '2026-09-15',
      check: {
        source: 'live',
        verdict: {
          projectId: PID,
          status: 'unbound',
          tier: 'none',
          periodEnd: '2026-09-15',
          issued: '2026-09-15',
        },
      },
    });
    expect(r).toMatchObject({ ok: false, reason: 'unbound', requiredTier: 'graphene' });
    expect(r).not.toHaveProperty('warning');
  });

  it('wrong_project verdict blocks with reason wrong-project, no grace', () => {
    const r = evaluateDeployEntitlement({
      license: v2,
      deployTier: 'k8s-ha',
      projectId: PID,
      now: '2026-09-15',
      check: {
        source: 'cache',
        verdict: {
          projectId: PID,
          status: 'wrong_project',
          tier: 'none',
          periodEnd: '2026-09-15',
          issued: '2026-09-15',
        },
      },
    });
    expect(r).toMatchObject({ ok: false, reason: 'wrong-project', requiredTier: 'fullerene' });
    expect(r).not.toHaveProperty('warning');
  });

  it('active graphene, periodEnd within grace, k8s -> ok, no warning', () => {
    const result = ev({
      check: live({ status: 'active', tier: 'graphene', periodEnd: '2026-09-30' }),
    });
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('warning');
  });

  it('active graphene with cancelAtPeriodEnd -> ok, warning ending', () => {
    const result = ev({
      check: {
        ...live({ status: 'active', tier: 'graphene', periodEnd: '2026-09-30' }),
        cancelAtPeriodEnd: true,
      },
    });
    expect(result).toMatchObject({
      ok: true,
      warning: { kind: 'ending', periodEnd: '2026-09-30' },
    });
  });

  it('active graphene, k8s-ha -> tier-too-low', () => {
    const result = ev({
      deployTier: 'k8s-ha',
      check: live({ status: 'active', tier: 'graphene', periodEnd: '2026-09-30' }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'tier-too-low', requiredTier: 'fullerene' });
  });

  it('past_due graphene inside grace -> ok, warning past-due with days left', () => {
    const result = ev({
      check: live({ status: 'past_due', tier: 'graphene', periodEnd: '2026-09-01' }),
    });
    expect(result).toMatchObject({
      ok: true,
      warning: { kind: 'past-due', daysLeft: 17, periodEnd: '2026-09-01' },
    });
  });

  it('past_due graphene past grace -> block past-due', () => {
    const result = ev({
      check: live({ status: 'past_due', tier: 'graphene', periodEnd: '2026-08-01' }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'past-due' });
  });

  it('canceled graphene inside grace -> ok, warning canceled with days left', () => {
    const result = ev({
      check: live({ status: 'canceled', tier: 'graphene', periodEnd: '2026-09-01' }),
    });
    expect(result).toMatchObject({ ok: true, warning: { kind: 'canceled', daysLeft: 17 } });
  });

  it('canceled graphene past grace -> block canceled', () => {
    const result = ev({
      check: live({ status: 'canceled', tier: 'graphene', periodEnd: '2026-08-01' }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'canceled' });
  });

  it('canceled fullerene at k8s (tier above required) inside grace still warns canceled', () => {
    const result = ev({
      check: live({ status: 'canceled', tier: 'fullerene', periodEnd: '2026-09-01' }),
    });
    expect(result).toMatchObject({ ok: true, warning: { kind: 'canceled' } });
  });

  it('canceled graphene at k8s-ha (tier below required) inside grace -> tier-too-low, grace never widens entitlement', () => {
    const result = ev({
      deployTier: 'k8s-ha',
      check: live({ status: 'canceled', tier: 'graphene', periodEnd: '2026-09-01' }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'tier-too-low', requiredTier: 'fullerene' });
    expect(result).not.toHaveProperty('warning');
  });

  it('verdict status none -> no-license', () => {
    const result = ev({
      check: live({ status: 'none', tier: 'none', periodEnd: NOW }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'no-license' });
  });

  it('verdict for another projectId -> no-license', () => {
    const result = ev({
      check: live({
        projectId: 'some-other-project',
        status: 'active',
        tier: 'graphene',
        periodEnd: '2026-09-30',
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'no-license' });
  });

  it('check.source rejected -> no-license', () => {
    const result = ev({ check: { source: 'rejected', verdict: null } });
    expect(result).toMatchObject({ ok: false, reason: 'no-license' });
  });

  it('check.source none with unreachable -> ok, warning unverified', () => {
    const result = ev({ check: { source: 'none', verdict: null, unreachable: 'ECONNREFUSED' } });
    expect(result).toMatchObject({
      ok: true,
      warning: { kind: 'unverified', detail: 'ECONNREFUSED' },
    });
  });

  it('cached active past grace -> ok, warning stale', () => {
    const result = ev({
      check: cached({ status: 'active', tier: 'graphene', periodEnd: '2026-07-01' }),
    });
    expect(result).toMatchObject({
      ok: true,
      warning: { kind: 'stale', periodEnd: '2026-07-01' },
    });
  });

  it('boundary: past_due exactly at grace end -> ok, daysLeft 0', () => {
    const result = ev({
      check: live({ status: 'past_due', tier: 'graphene', periodEnd: '2026-08-15' }),
    });
    expect(result).toMatchObject({
      ok: true,
      warning: { kind: 'past-due', daysLeft: 0 },
    });
  });

  it('graceEndOf and daysLeft', () => {
    expect(graceEndOf('2026-01-31')).toBe('2026-03-02');
    expect(daysLeft('2026-09-14', '2026-09-14')).toBe(0);
    expect(daysLeft('2026-09-10', '2026-09-14')).toBe(0);
  });
});
