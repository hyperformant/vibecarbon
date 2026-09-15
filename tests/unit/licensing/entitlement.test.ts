import { describe, expect, it } from 'vitest';
import {
  coversRelease,
  daysLeft,
  evaluateDeployEntitlement,
  evaluateEntitlement,
  graceEndOf,
  requiredTierFor,
  TIER_FOR_DEPLOY_TIER,
  tierSatisfies,
} from '../../../src/lib/licensing/entitlement.js';

const RELEASE = '2026-09-12';
const PROJECT = 'proj-1';

/** Base fixture for an active v2 license, tweak per test. */
function license(overrides = {}) {
  return {
    active: true,
    tier: 'fullerene',
    format: 'v2',
    isLifetime: false,
    projectId: PROJECT,
    paidThrough: '2026-12-31',
    ...overrides,
  };
}

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

describe('coversRelease', () => {
  it('true for a lifetime license regardless of dates', () => {
    expect(coversRelease({ isLifetime: true, paidThrough: null }, RELEASE)).toBe(true);
    expect(coversRelease({ isLifetime: true, paidThrough: '2000-01-01' }, RELEASE)).toBe(true);
  });

  it('true when releaseDate is before paidThrough', () => {
    expect(coversRelease({ isLifetime: false, paidThrough: '2026-12-31' }, RELEASE)).toBe(true);
  });

  it('true on the same-day boundary (inclusive)', () => {
    expect(coversRelease({ isLifetime: false, paidThrough: RELEASE }, RELEASE)).toBe(true);
  });

  it('false when releaseDate is after paidThrough (lapsed)', () => {
    expect(coversRelease({ isLifetime: false, paidThrough: '2026-01-01' }, RELEASE)).toBe(false);
  });
});

describe('evaluateEntitlement', () => {
  it('graphite/compose is always ok, even with no license present', () => {
    const result = evaluateEntitlement({
      license: null,
      deployTier: 'compose',
      projectId: PROJECT,
      releaseDate: RELEASE,
    });
    expect(result).toEqual({ ok: true, requiredTier: 'graphite' });
  });

  it('no active license -> no-license, for a paid deploy tier', () => {
    const result = evaluateEntitlement({
      license: null,
      deployTier: 'k8s',
      projectId: PROJECT,
      releaseDate: RELEASE,
    });
    expect(result.ok).toBe(false);
    expect(result.requiredTier).toBe('graphene');
    expect(result.reason).toBe('no-license');
    expect(result.license).toBeNull();
  });

  it('an inactive license counts as no license', () => {
    const result = evaluateEntitlement({
      license: license({ active: false }),
      deployTier: 'k8s',
      projectId: PROJECT,
      releaseDate: RELEASE,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-license');
  });

  it('a v1 lifetime license covers every deploy tier, any project, forever', () => {
    const legacy = license({
      format: 'v1',
      isLifetime: true,
      tier: 'fullerene',
      projectId: null,
      paidThrough: null,
    });
    for (const deployTier of ['compose', 'k8s', 'compose-ha', 'k8s-ha']) {
      const result = evaluateEntitlement({
        license: legacy,
        deployTier,
        projectId: 'any-project-at-all',
        releaseDate: RELEASE,
      });
      expect(result).toEqual({ ok: true, requiredTier: requiredTierFor(deployTier) });
    }
  });

  it('wrong-project takes precedence over tier-too-low and lapsed', () => {
    const mismatched = license({
      tier: 'graphite',
      projectId: 'other-project',
      paidThrough: '2000-01-01',
    });
    const result = evaluateEntitlement({
      license: mismatched,
      deployTier: 'k8s-ha',
      projectId: PROJECT,
      releaseDate: RELEASE,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('wrong-project');
    expect(result.requiredTier).toBe('fullerene');
    expect(result.license).toBe(mismatched);
  });

  it('tier-too-low when project matches but tier does not satisfy, even if lapsed', () => {
    const underTiered = license({
      tier: 'graphene',
      projectId: PROJECT,
      paidThrough: '2000-01-01',
    });
    const result = evaluateEntitlement({
      license: underTiered,
      deployTier: 'k8s-ha',
      projectId: PROJECT,
      releaseDate: RELEASE,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('tier-too-low');
  });

  it('lapsed when project matches and tier satisfies but paidThrough is before releaseDate', () => {
    const lapsed = license({
      tier: 'fullerene',
      projectId: PROJECT,
      paidThrough: '2026-01-01',
    });
    const result = evaluateEntitlement({
      license: lapsed,
      deployTier: 'k8s-ha',
      projectId: PROJECT,
      releaseDate: RELEASE,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('lapsed');
  });

  it('ok when project matches, tier satisfies, and paidThrough covers the release date', () => {
    const result = evaluateEntitlement({
      license: license({ tier: 'fullerene', projectId: PROJECT, paidThrough: '2026-12-31' }),
      deployTier: 'k8s-ha',
      projectId: PROJECT,
      releaseDate: RELEASE,
    });
    expect(result).toEqual({ ok: true, requiredTier: 'fullerene' });
  });

  it('unknown deploy tier requires fullerene', () => {
    const result = evaluateEntitlement({
      license: license({ tier: 'graphene', projectId: PROJECT }),
      deployTier: 'not-a-real-tier',
      projectId: PROJECT,
      releaseDate: RELEASE,
    });
    expect(result.requiredTier).toBe('fullerene');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('tier-too-low');
  });

  // Full matrix: 4 deploy tiers x license scenarios.
  const deployTiers = ['compose', 'k8s', 'compose-ha', 'k8s-ha'];

  describe('full matrix', () => {
    for (const deployTier of deployTiers) {
      const required = requiredTierFor(deployTier);

      it(`${deployTier} (requires ${required}): no license -> ${
        required === 'graphite' ? 'ok' : 'no-license'
      }`, () => {
        const result = evaluateEntitlement({
          license: null,
          deployTier,
          projectId: PROJECT,
          releaseDate: RELEASE,
        });
        if (required === 'graphite') {
          expect(result).toEqual({ ok: true, requiredTier: 'graphite' });
        } else {
          expect(result.ok).toBe(false);
          expect(result.reason).toBe('no-license');
        }
      });

      it(`${deployTier} (requires ${required}): v1 lifetime -> ok`, () => {
        const result = evaluateEntitlement({
          license: license({ format: 'v1', isLifetime: true, projectId: null, paidThrough: null }),
          deployTier,
          projectId: PROJECT,
          releaseDate: RELEASE,
        });
        expect(result).toEqual({ ok: true, requiredTier: required });
      });

      it(`${deployTier} (requires ${required}): v2 graphene, covered/lapsed/wrong-project`, () => {
        const grapheneSatisfies = required === 'graphite' || required === 'graphene';

        const covered = evaluateEntitlement({
          license: license({ tier: 'graphene', projectId: PROJECT, paidThrough: '2026-12-31' }),
          deployTier,
          projectId: PROJECT,
          releaseDate: RELEASE,
        });
        if (grapheneSatisfies) {
          expect(covered).toEqual({ ok: true, requiredTier: required });
        } else {
          expect(covered.ok).toBe(false);
          expect(covered.reason).toBe('tier-too-low');
        }

        const lapsed = evaluateEntitlement({
          license: license({ tier: 'graphene', projectId: PROJECT, paidThrough: '2000-01-01' }),
          deployTier,
          projectId: PROJECT,
          releaseDate: RELEASE,
        });
        if (required === 'graphite') {
          expect(lapsed).toEqual({ ok: true, requiredTier: 'graphite' });
        } else if (grapheneSatisfies) {
          expect(lapsed.ok).toBe(false);
          expect(lapsed.reason).toBe('lapsed');
        } else {
          expect(lapsed.ok).toBe(false);
          expect(lapsed.reason).toBe('tier-too-low');
        }

        const wrongProject = evaluateEntitlement({
          license: license({
            tier: 'graphene',
            projectId: 'someone-elses-project',
            paidThrough: '2026-12-31',
          }),
          deployTier,
          projectId: PROJECT,
          releaseDate: RELEASE,
        });
        if (required === 'graphite') {
          expect(wrongProject).toEqual({ ok: true, requiredTier: 'graphite' });
        } else {
          expect(wrongProject.ok).toBe(false);
          expect(wrongProject.reason).toBe('wrong-project');
        }
      });

      it(`${deployTier} (requires ${required}): v2 fullerene, covered/lapsed/wrong-project`, () => {
        const covered = evaluateEntitlement({
          license: license({ tier: 'fullerene', projectId: PROJECT, paidThrough: '2026-12-31' }),
          deployTier,
          projectId: PROJECT,
          releaseDate: RELEASE,
        });
        expect(covered).toEqual({ ok: true, requiredTier: required });

        const lapsed = evaluateEntitlement({
          license: license({ tier: 'fullerene', projectId: PROJECT, paidThrough: '2000-01-01' }),
          deployTier,
          projectId: PROJECT,
          releaseDate: RELEASE,
        });
        if (required === 'graphite') {
          expect(lapsed).toEqual({ ok: true, requiredTier: 'graphite' });
        } else {
          expect(lapsed.ok).toBe(false);
          expect(lapsed.reason).toBe('lapsed');
        }

        const wrongProject = evaluateEntitlement({
          license: license({
            tier: 'fullerene',
            projectId: 'someone-elses-project',
            paidThrough: '2026-12-31',
          }),
          deployTier,
          projectId: PROJECT,
          releaseDate: RELEASE,
        });
        if (required === 'graphite') {
          expect(wrongProject).toEqual({ ok: true, requiredTier: 'graphite' });
        } else {
          expect(wrongProject.ok).toBe(false);
          expect(wrongProject.reason).toBe('wrong-project');
        }
      });
    }
  });
});

describe('evaluateDeployEntitlement', () => {
  const PID = '11111111-2222-3333-4444-555555555555';
  const NOW = '2026-09-14';
  const v2 = {
    active: true,
    format: 'v2',
    isLifetime: false,
    projectId: PID,
    tier: null,
    storedProjectId: null,
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

  it('legacy lifetime key proceeds for k8s-ha with check.source none, no warning', () => {
    const legacy = {
      active: true,
      format: 'v1',
      isLifetime: true,
      projectId: null,
      storedProjectId: null,
    };
    const result = ev({ deployTier: 'k8s-ha', license: legacy });
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('warning');
  });

  it('no license, k8s -> no-license', () => {
    const result = ev({ license: null });
    expect(result).toMatchObject({ ok: false, reason: 'no-license', requiredTier: 'graphene' });
  });

  it('stored key for another project -> wrong-project', () => {
    const result = ev({ license: { active: false, storedProjectId: 'some-other-project' } });
    expect(result).toMatchObject({ ok: false, reason: 'wrong-project', requiredTier: 'graphene' });
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
