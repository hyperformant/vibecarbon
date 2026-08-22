/**
 * Vultr Object Storage (S3-compatible) Provider
 *
 * Vultr-specific glue over the generic `S3CompatibleProvider` base
 * (s3-base.js): endpoint/region maps and the deploy-region → S3-region
 * resolver. Every actual S3 operation lives in the base class.
 *
 * REGIONS are keyed by Vultr's Object Storage CLUSTER slugs (the hostname
 * prefix of `<cluster>.vultrobjects.com`), which are NOT compute region
 * ids — e.g. the `ord` compute region's cluster is `chi3` (live cluster
 * listing 2026-08-08, `GET /v2/object-storage/clusters` — public). Only
 * clusters relevant to our compute REGIONS subset are mapped; the full
 * catalog is re-pulled per expansion.
 *
 * KEY MODEL (differs from every other provider): Vultr object-storage keys
 * are minted PER SUBSCRIPTION — one subscription = one cluster — so the
 * operator's key pair only works against its own subscription's cluster.
 * `VULTR_STORAGE_REGION` (S3_REGION_ENV) is therefore effectively
 * REQUIRED config; resolveS3Region's compute→cluster mapping below is only
 * the default suggestion for where to create the subscription
 * (vultr-guided-setup.js captures the real cluster alongside the keys).
 *
 * API Documentation: https://www.vultr.com/api/ (object-storage section)
 */

import { deriveStateBucketName, S3CompatibleProvider, sanitizeBucketName } from './s3-base.js';

export class VultrObjectStorageProvider extends S3CompatibleProvider {
  /**
   * SIGNING region for every S3 client this class builds — same seam as
   * LinodeObjectStorageProvider.S3_SIGNING_REGION (s3-base getClient /
   * findBucketRegion honor it; pinned by s3-signing-region.test.ts).
   * Live-probed 2026-08-08 against a real ewr1 subscription: Vultr's RGW
   * rejects the SDK-injected CreateBucket LocationConstraint
   * (`ewr1` → InvalidLocationConstraint) and accepts the omitted form
   * (us-east-1 signing). Same Ceph class as Linode.
   * @type {string}
   */
  static S3_SIGNING_REGION = 'us-east-1';

  static ENDPOINTS = {
    ewr1: 'https://ewr1.vultrobjects.com',
    chi3: 'https://chi3.vultrobjects.com',
    lax1: 'https://lax1.vultrobjects.com',
    ams1: 'https://ams1.vultrobjects.com',
    sjc1: 'https://sjc1.vultrobjects.com',
    sgp1: 'https://sgp1.vultrobjects.com',
    lhr1: 'https://lhr1.vultrobjects.com',
    syd1: 'https://syd1.vultrobjects.com',
  };

  // Cluster slug → human description (city of the hosting compute region).
  static REGIONS = {
    ewr1: 'New Jersey, USA',
    chi3: 'Chicago, USA',
    lax1: 'Los Angeles, USA',
    ams1: 'Amsterdam, Netherlands',
    sjc1: 'Silicon Valley, USA',
    sgp1: 'Singapore',
    lhr1: 'London, United Kingdom',
    syd1: 'Sydney, Australia',
  };

  // Compute region id → default cluster suggestion (live cluster listing
  // 2026-08-08). NOTE `ord` → `chi3`: hostname prefixes are not region ids.
  static COMPUTE_TO_S3 = {
    ewr: 'ewr1',
    ord: 'chi3',
    lax: 'lax1',
    ams: 'ams1',
    sjc: 'sjc1',
    sgp: 'sgp1',
    lhr: 'lhr1',
    syd: 'syd1',
  };

  /**
   * Resolve the S3 region for a given deployment region — the compute →
   * cluster map first, identity for already-cluster-slug inputs, and the
   * default cluster for anything unknown (total on unknown/''/undefined —
   * s3-provider-contract pins this). Operators pin their subscription's
   * actual cluster via VULTR_STORAGE_REGION (see the class doc).
   * @param {string} deployRegion
   * @returns {string}
   */
  static resolveS3Region(deployRegion) {
    const mapped = VultrObjectStorageProvider.COMPUTE_TO_S3[deployRegion];
    if (mapped) return mapped;
    if (VultrObjectStorageProvider.ENDPOINTS[deployRegion]) return deployRegion;
    return 'ewr1';
  }
}

export { deriveStateBucketName, sanitizeBucketName };
