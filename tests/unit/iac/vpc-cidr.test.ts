/**
 * vpcCidrForCluster: the per-cluster VPC range DigitalOcean (/20) and Vultr
 * (/24) derive from the cluster name. A range that moved between two runs of
 * the same cluster would replace its VPC under a live cluster, so the values
 * are pinned.
 */
import { describe, expect, it } from 'vitest';
import { vpcCidrForCluster } from '../../../src/lib/iac/vpc-cidr.js';

/** 200 cluster names shaped like the real ones. */
const NAMES = Array.from({ length: 200 }, (_, i) => `proj${i}-e${i % 7}${i % 2 ? '-standby' : ''}`);

describe('vpcCidrForCluster', () => {
  it("maskBits 20 keeps DigitalOcean's ranges", () => {
    // Read from digitalocean-k8s.js before the helper moved here.
    expect(vpcCidrForCluster('proj-d4-primary')).toBe('10.181.32.0/20');
    expect(vpcCidrForCluster('acme-prod')).toBe('10.180.176.0/20');
    expect(vpcCidrForCluster('acme-prod', 20)).toBe('10.180.176.0/20');
  });

  it('maskBits 24 stays in 10.128.0.0/10 as a /24', () => {
    for (const name of NAMES) {
      expect(vpcCidrForCluster(name, 24), name).toMatch(
        /^10\.(12[89]|1[3-8]\d|19[01])\.\d{1,3}\.0\/24$/,
      );
      const third = Number(vpcCidrForCluster(name, 24).split('.')[2]);
      expect(third, name).toBeLessThanOrEqual(255);
    }
    // Non-vacuous: the /24 space really is used, not one block.
    expect(new Set(NAMES.map((n) => vpcCidrForCluster(n, 24))).size).toBeGreaterThan(190);
  });

  it('24 is deterministic and separates an HA pair', () => {
    expect(vpcCidrForCluster('proj-v4-primary', 24)).toBe(vpcCidrForCluster('proj-v4-primary', 24));
    expect(vpcCidrForCluster('proj-v4-primary', 24)).not.toBe(
      vpcCidrForCluster('proj-v4-standby', 24),
    );
  });
});
