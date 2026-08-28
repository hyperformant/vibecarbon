/**
 * M3 Task 9c — provider surface for the S3-egress VPC CIDR allowance:
 * `ProviderClass.getS3EgressExtraCidrs(vpcCidr)` and `DEFAULT_VPC_CIDR`.
 *
 * RCA: on DigitalOcean, same-region Spaces endpoints resolve INSIDE pods to
 * a VPC-internal gateway address that the standard `0.0.0.0/0 except
 * RFC1918` S3-egress rule cuts off (Hetzner's Object Storage endpoints
 * resolve to public IPs, so it never needs this). See base.js's
 * "S3-egress VPC allowance" section doc and applyK3sManifests's step 5a
 * (deploy/k8s/k3s.js) for the render + conditional-apply wiring this
 * static drives.
 */
import { describe, expect, it } from 'vitest';
import { BaseProvider } from '../../../src/lib/providers/base.js';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

describe('BaseProvider — S3-egress VPC allowance defaults', () => {
  it('DEFAULT_VPC_CIDR is empty (no provider needs it unless it overrides)', () => {
    expect(BaseProvider.DEFAULT_VPC_CIDR).toBe('');
  });

  it('getS3EgressExtraCidrs returns [] unconditionally, ignoring its argument', () => {
    expect(BaseProvider.getS3EgressExtraCidrs()).toEqual([]);
    expect(BaseProvider.getS3EgressExtraCidrs('10.10.0.0/20')).toEqual([]);
    expect(BaseProvider.getS3EgressExtraCidrs('anything')).toEqual([]);
  });
});

describe('HetznerProvider — inherits the no-op default (byte-identical render path)', () => {
  it('does NOT override getS3EgressExtraCidrs — same function reference as BaseProvider', () => {
    // Hetzner's Object Storage endpoints resolve to public IPs; it never
    // needs the allowance. Asserting IDENTITY (not just return-value
    // equality) pins that this is inherited, not a redundant override that
    // could silently drift from the base no-op.
    expect(HetznerProvider.getS3EgressExtraCidrs).toBe(BaseProvider.getS3EgressExtraCidrs);
  });

  it('returns [] regardless of the CIDR argument (ignores it entirely, like Hetzner never needing one)', () => {
    expect(HetznerProvider.getS3EgressExtraCidrs('10.0.0.0/8')).toEqual([]);
    expect(HetznerProvider.getS3EgressExtraCidrs(undefined)).toEqual([]);
  });

  it('does NOT override DEFAULT_VPC_CIDR — inherits BaseProvider’s empty default', () => {
    expect(HetznerProvider.DEFAULT_VPC_CIDR).toBe('');
  });
});

describe('DigitalOceanProvider — S3-egress VPC allowance override', () => {
  it('DEFAULT_VPC_CIDR is the FIXED-ERA literal; the program default is now derived OUTSIDE it', async () => {
    // Since the d4 lift the program derives a per-cluster range
    // (vpcCidrForCluster — DO enforces account-wide CIDR uniqueness), so the
    // static is no longer "the program default": it is the resume-compat
    // value for stacks provisioned in the fixed-literal era, and every
    // derived range must live in a DIFFERENT space so the two populations
    // can never collide.
    const { vpcCidrForCluster } = await import('../../../src/lib/iac/programs/digitalocean-k8s.js');
    expect(DigitalOceanProvider.DEFAULT_VPC_CIDR).toBe('10.10.0.0/20');
    for (const name of ['proj-e3', 'proj-d4-primary', 'proj-d4-standby', 'x-y-z']) {
      expect(vpcCidrForCluster(name)).toMatch(/^10\.(12[89]|1[3-8][0-9]|19[01])\.\d+\.0\/20$/);
      expect(vpcCidrForCluster(name)).not.toBe(DigitalOceanProvider.DEFAULT_VPC_CIDR);
    }
  });

  it('vpcCidrForCluster is deterministic and separates the HA stack pair', async () => {
    const { vpcCidrForCluster } = await import('../../../src/lib/iac/programs/digitalocean-k8s.js');
    // Convergence contract: same cluster name → same range on every re-run
    // (a moving range would REPLACE the VPC under a live cluster).
    expect(vpcCidrForCluster('proj-d4-primary')).toBe(vpcCidrForCluster('proj-d4-primary'));
    // The account-wide-uniqueness fix: the two HA stacks (and any two
    // environments) get distinct ranges.
    expect(vpcCidrForCluster('proj-d4-primary')).not.toBe(vpcCidrForCluster('proj-d4-standby'));
    // Third-octet blocks stay /20-aligned.
    for (const name of ['proj-d4-primary', 'proj-d4-standby']) {
      const third = Number(vpcCidrForCluster(name).split('.')[2]);
      expect(third % 16).toBe(0);
    }
  });

  it('getS3EgressExtraCidrs(vpcCidr) returns exactly [vpcCidr] for a real CIDR', () => {
    expect(DigitalOceanProvider.getS3EgressExtraCidrs('10.10.0.0/20')).toEqual(['10.10.0.0/20']);
    // Any CIDR the deploy actually threads through — not hardcoded to the
    // default — the method is a pure passthrough.
    expect(DigitalOceanProvider.getS3EgressExtraCidrs('10.20.0.0/16')).toEqual(['10.20.0.0/16']);
  });

  it('getS3EgressExtraCidrs returns [] when vpcCidr is falsy (defense-in-depth, not a broken rule)', () => {
    expect(DigitalOceanProvider.getS3EgressExtraCidrs(undefined)).toEqual([]);
    expect(DigitalOceanProvider.getS3EgressExtraCidrs('')).toEqual([]);
  });

  it('is a genuine override — different function reference than BaseProvider’s no-op', () => {
    expect(DigitalOceanProvider.getS3EgressExtraCidrs).not.toBe(BaseProvider.getS3EgressExtraCidrs);
  });
});
