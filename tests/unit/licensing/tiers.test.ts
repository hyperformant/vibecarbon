import { describe, expect, it } from 'vitest';
import { compareTiers, getTier, hasFeature, TIERS } from '../../../src/lib/licensing/tiers.js';

describe('License Tiers', () => {
  describe('TIERS constant', () => {
    it('defines graphite, fullerene, and agency tiers (diamond retired)', () => {
      expect(TIERS.graphite).toBeDefined();
      expect(TIERS.fullerene).toBeDefined();
      expect(TIERS.agency).toBeDefined();
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

    it('graphite tier has correct properties, incl. single-server production deploy', () => {
      expect(TIERS.graphite.name).toBe('Graphite');
      expect(TIERS.graphite.license).toBe('FSL-1.1-MIT');
      expect(TIERS.graphite.features).toContain('local-dev');
      expect(TIERS.graphite.features).toContain('docker-compose');
      expect(TIERS.graphite.features).toContain('all-addons');
      expect(TIERS.graphite.price).toBe(0);
    });

    it('fullerene tier has correct properties (149/299, no client-deploys)', () => {
      expect(TIERS.fullerene.name).toBe('Fullerene');
      expect(TIERS.fullerene.license).toBe('FSL-1.1-MIT');
      expect(TIERS.fullerene.features).toContain('docker-compose');
      expect(TIERS.fullerene.features).toContain('kubernetes');
      expect(TIERS.fullerene.features).toContain('ha');
      expect(TIERS.fullerene.features).toContain('multi-region');
      expect(TIERS.fullerene.features).toContain('failover');
      expect(TIERS.fullerene.features).not.toContain('client-deploys');
      expect(TIERS.fullerene.maxServers).toBe(Infinity);
      expect(TIERS.fullerene.price).toBe(149);
      expect(TIERS.fullerene.originalPrice).toBe(299);
    });

    it('agency tier is a contact-us channel with no numeric checkout price', () => {
      expect(TIERS.agency.name).toBe('Agency');
      expect(TIERS.agency.contact).toBe(true);
      expect(TIERS.agency.price).toBeFalsy();
      expect(TIERS.agency.features).toContain('client-deploys');
      expect(TIERS.agency.license).toContain('Commercial Agreement');
    });
  });

  describe('getTier', () => {
    it('returns tier configuration by name', () => {
      expect(getTier('graphite')).toBe(TIERS.graphite);
      expect(getTier('fullerene')).toBe(TIERS.fullerene);
      expect(getTier('agency')).toBe(TIERS.agency);
    });

    it('returns null for unknown tier', () => {
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

    it('fullerene tier has all advanced deployment features but not client-deploys', () => {
      expect(hasFeature('fullerene', 'docker-compose')).toBe(true);
      expect(hasFeature('fullerene', 'kubernetes')).toBe(true);
      expect(hasFeature('fullerene', 'autoscaling')).toBe(true);
      expect(hasFeature('fullerene', 'ha')).toBe(true);
      expect(hasFeature('fullerene', 'multi-region')).toBe(true);
      expect(hasFeature('fullerene', 'failover')).toBe(true);
      expect(hasFeature('fullerene', 'client-deploys')).toBe(false);
    });

    it('agency tier has client-deploys', () => {
      expect(hasFeature('agency', 'client-deploys')).toBe(true);
    });

    it('returns false for unknown tier', () => {
      expect(hasFeature('diamond', 'docker-compose')).toBe(false);
      expect(hasFeature('invalid', 'docker-compose')).toBe(false);
    });
  });

  describe('compareTiers', () => {
    it('graphite < fullerene < agency', () => {
      expect(compareTiers('graphite', 'fullerene')).toBe(-1);
      expect(compareTiers('fullerene', 'agency')).toBe(-1);
      expect(compareTiers('graphite', 'agency')).toBe(-1);
    });

    it('agency > fullerene > graphite', () => {
      expect(compareTiers('agency', 'fullerene')).toBe(1);
      expect(compareTiers('fullerene', 'graphite')).toBe(1);
      expect(compareTiers('agency', 'graphite')).toBe(1);
    });

    it('same tier returns 0', () => {
      expect(compareTiers('graphite', 'graphite')).toBe(0);
      expect(compareTiers('fullerene', 'fullerene')).toBe(0);
      expect(compareTiers('agency', 'agency')).toBe(0);
    });

    it('handles unknown tiers (diamond no longer recognized)', () => {
      expect(compareTiers('diamond', 'graphite')).toBe(-1);
      expect(compareTiers('invalid', 'graphite')).toBe(-1);
      expect(compareTiers('graphite', 'invalid')).toBe(1);
    });
  });
});
