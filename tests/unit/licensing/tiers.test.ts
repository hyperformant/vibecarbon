import { describe, expect, it } from 'vitest';
import { compareTiers, getTier, hasFeature, TIERS } from '../../../src/lib/licensing/tiers.js';

describe('License Tiers', () => {
  describe('TIERS constant', () => {
    it('defines graphite, graphene, and fullerene tiers (agency retired)', () => {
      expect(TIERS.graphite).toBeDefined();
      expect(TIERS.graphene).toBeDefined();
      expect(TIERS.fullerene).toBeDefined();
      expect(TIERS.agency).toBeUndefined();
      expect(TIERS.diamond).toBeUndefined();
    });

    it('has exactly 3 tiers', () => {
      expect(Object.keys(TIERS)).toHaveLength(3);
    });

    it('never gates by cloud provider — no tier carries a providers key', () => {
      for (const tier of Object.values(TIERS)) {
        expect(tier).not.toHaveProperty('providers');
      }
    });

    it('no tier carries maxServers', () => {
      for (const tier of Object.values(TIERS)) {
        expect(tier).not.toHaveProperty('maxServers');
      }
    });

    it('no tier carries one-time-purchase copy (originalPrice, discountPercent, badge)', () => {
      for (const tier of Object.values(TIERS)) {
        expect(tier).not.toHaveProperty('originalPrice');
        expect(tier).not.toHaveProperty('discountPercent');
        expect(tier).not.toHaveProperty('badge');
      }
    });

    it('graphite tier is free (compose), tagline "Go live."', () => {
      expect(TIERS.graphite.id).toBe('graphite');
      expect(TIERS.graphite.name).toBe('Graphite');
      expect(TIERS.graphite.tagline).toBe('Go live.');
      expect(TIERS.graphite.price).toBe(0);
      expect(TIERS.graphite.billing).toBe('free');
      expect(TIERS.graphite.annualPrice).toBeNull();
      expect(TIERS.graphite.deployTiers).toEqual(['compose']);
      expect(TIERS.graphite.features).toContain('local-dev');
      expect(TIERS.graphite.features).toContain('docker-compose');
      expect(TIERS.graphite.features).toContain('all-addons');
    });

    it('graphene tier covers k8s at $19/mo, $190/yr, tagline "Scale on demand."', () => {
      expect(TIERS.graphene.id).toBe('graphene');
      expect(TIERS.graphene.name).toBe('Graphene');
      expect(TIERS.graphene.tagline).toBe('Scale on demand.');
      expect(TIERS.graphene.price).toBe(19);
      expect(TIERS.graphene.billing).toBe('per-project-monthly');
      expect(TIERS.graphene.annualPrice).toBe(190);
      expect(TIERS.graphene.deployTiers).toEqual(['k8s']);
    });

    it('fullerene tier covers k8s-ha and compose-ha at $39/mo, $390/yr, tagline "Enterprise resiliency."', () => {
      expect(TIERS.fullerene.id).toBe('fullerene');
      expect(TIERS.fullerene.name).toBe('Fullerene');
      expect(TIERS.fullerene.tagline).toBe('Enterprise resiliency.');
      expect(TIERS.fullerene.price).toBe(39);
      expect(TIERS.fullerene.billing).toBe('per-project-monthly');
      expect(TIERS.fullerene.annualPrice).toBe(390);
      expect(TIERS.fullerene.deployTiers).toEqual(['k8s-ha', 'compose-ha']);
      expect(TIERS.fullerene.features).toContain('docker-compose');
      expect(TIERS.fullerene.features).toContain('kubernetes');
      expect(TIERS.fullerene.features).toContain('ha');
      expect(TIERS.fullerene.features).toContain('multi-region');
      expect(TIERS.fullerene.features).toContain('failover');
    });
  });

  describe('getTier', () => {
    it('returns tier configuration by name', () => {
      expect(getTier('graphite')).toBe(TIERS.graphite);
      expect(getTier('graphene')).toBe(TIERS.graphene);
      expect(getTier('fullerene')).toBe(TIERS.fullerene);
    });

    it('returns null for unknown tier', () => {
      expect(getTier('agency')).toBeNull();
      expect(getTier('diamond')).toBeNull();
      expect(getTier('enterprise')).toBeNull();
      expect(getTier('')).toBeNull();
      expect(getTier('invalid')).toBeNull();
    });
  });

  describe('hasFeature', () => {
    it('graphite tier has local-dev, docker-compose, and all-addons', () => {
      expect(hasFeature('graphite', 'local-dev')).toBe(true);
      expect(hasFeature('graphite', 'docker-compose')).toBe(true);
      expect(hasFeature('graphite', 'all-addons')).toBe(true);
    });

    it('graphite tier does not have advanced deploy modes', () => {
      expect(hasFeature('graphite', 'kubernetes')).toBe(false);
      expect(hasFeature('graphite', 'ha')).toBe(false);
    });

    it('fullerene tier has all advanced deployment features', () => {
      expect(hasFeature('fullerene', 'docker-compose')).toBe(true);
      expect(hasFeature('fullerene', 'kubernetes')).toBe(true);
      expect(hasFeature('fullerene', 'autoscaling')).toBe(true);
      expect(hasFeature('fullerene', 'ha')).toBe(true);
      expect(hasFeature('fullerene', 'multi-region')).toBe(true);
      expect(hasFeature('fullerene', 'failover')).toBe(true);
    });

    it('returns false for unknown tier', () => {
      expect(hasFeature('agency', 'docker-compose')).toBe(false);
      expect(hasFeature('diamond', 'docker-compose')).toBe(false);
      expect(hasFeature('invalid', 'docker-compose')).toBe(false);
    });
  });

  describe('compareTiers', () => {
    it('graphite < graphene < fullerene', () => {
      expect(compareTiers('graphite', 'graphene')).toBe(-1);
      expect(compareTiers('graphene', 'fullerene')).toBe(-1);
      expect(compareTiers('graphite', 'fullerene')).toBe(-1);
    });

    it('fullerene > graphene > graphite', () => {
      expect(compareTiers('fullerene', 'graphene')).toBe(1);
      expect(compareTiers('graphene', 'graphite')).toBe(1);
      expect(compareTiers('fullerene', 'graphite')).toBe(1);
    });

    it('same tier returns 0', () => {
      expect(compareTiers('graphite', 'graphite')).toBe(0);
      expect(compareTiers('graphene', 'graphene')).toBe(0);
      expect(compareTiers('fullerene', 'fullerene')).toBe(0);
    });

    it('handles unknown tiers (agency and diamond no longer recognized)', () => {
      expect(compareTiers('agency', 'graphite')).toBe(-1);
      expect(compareTiers('diamond', 'graphite')).toBe(-1);
      expect(compareTiers('invalid', 'graphite')).toBe(-1);
      expect(compareTiers('graphite', 'invalid')).toBe(1);
    });
  });
});
