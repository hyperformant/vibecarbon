import { describe, expect, it } from 'vitest';
import {
  coversRelease,
  evaluateEntitlement,
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
