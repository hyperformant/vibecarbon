/**
 * Scaleway Object Storage (S3-compatible) Provider
 *
 * Scaleway-specific glue over the generic `S3CompatibleProvider` base
 * (s3-base.js): endpoint/region maps and the deploy-region → S3-region
 * resolver. Every actual S3 operation lives in the base class.
 *
 * REGIONS are keyed by Scaleway's Object Storage REGIONS (`fr-par`,
 * `nl-ams`) — the 2-part form, NOT the 3-part compute zones. The mapping
 * from a compute zone is total and deterministic: strip the trailing AZ
 * ordinal (`fr-par-1` → `fr-par`; see zoneToS3Region) — no lookup table,
 * unlike Vultr's compute→cluster map or Linode's endpoint-slug table.
 * Only the regions backing ScalewayProvider.REGIONS' zones are mapped
 * (both carry all three storage classes); pl-waw/it-mil come with a
 * compute-zone expansion, not before.
 *
 * NO `S3_SIGNING_REGION` override — DO NOT cargo-cult the Linode/Vultr
 * `us-east-1` seam onto this class. Scaleway is NOT the Ceph
 * reject-the-LocationConstraint class: it signs AWS4 with its OWN region
 * (`Credential=…/nl-ams/s3/aws4_request` in Scaleway's own signing
 * example), `GetBucketLocation` returns the Scaleway region verbatim, and
 * the SDK-injected CreateBucket LocationConstraint is ACCEPTED
 * (audit-verified against Scaleway's docs; one-line live CreateBucket
 * probe re-confirms at first e2e run — the s3-signing-region census pins
 * whichever answer comes back).
 *
 * CREDENTIALS: the SAME IAM key pair as compute (SCALEWAY_ACCESS_KEY +
 * SCALEWAY_SECRET_KEY) — no separate storage keys exist. The pair's "preferred
 * Project for Object Storage" (chosen at key creation) decides which
 * Project's buckets it sees — guided setup requires it to be the SAME
 * dedicated Project the servers deploy into (see scaleway-guided-setup).
 *
 * API Documentation: https://www.scaleway.com/en/docs/object-storage/
 */

import { deriveStateBucketName, S3CompatibleProvider, sanitizeBucketName } from './s3-base.js';

/**
 * Derive a Scaleway Object Storage REGION from a compute ZONE by stripping
 * the trailing AZ ordinal (`fr-par-1` → `fr-par`, `nl-ams-2` → `nl-ams`).
 * Total and pure: a non-zone input comes back unchanged. The single home
 * of the zone→region derivation (resolveS3Region below and the e2e sweep
 * both use it) — deliberately NOT a lookup table, the derivation is
 * structural (SDK zone regex `^[a-z]{2}-[a-z]{3,7}-[0-9]{1,2}$`).
 * @param {string} zone
 * @returns {string}
 */
export function zoneToS3Region(zone) {
  return String(zone ?? '').replace(/-\d+$/, '');
}

export class ScalewayObjectStorageProvider extends S3CompatibleProvider {
  static ENDPOINTS = {
    'fr-par': 'https://s3.fr-par.scw.cloud',
    'nl-ams': 'https://s3.nl-ams.scw.cloud',
  };

  // Region slug → human description (same shape as the sibling S3 REGIONS
  // maps). Keys are S3-client region strings AND embed themselves in their
  // endpoint hostname (s3-provider-contract pins both).
  static REGIONS = {
    'fr-par': 'Paris, France',
    'nl-ams': 'Amsterdam, Netherlands',
  };

  /**
   * Resolve the S3 region for a given deployment region: the zone-strip
   * derivation first, identity for already-region inputs, and the default
   * region for anything unknown (total on unknown/''/undefined —
   * s3-provider-contract pins this).
   * @param {string} deployRegion - compute zone (fr-par-1) or S3 region
   * @returns {string}
   */
  static resolveS3Region(deployRegion) {
    const stripped = zoneToS3Region(deployRegion);
    if (ScalewayObjectStorageProvider.ENDPOINTS[stripped]) return stripped;
    return 'fr-par';
  }
}

export { deriveStateBucketName, sanitizeBucketName };
