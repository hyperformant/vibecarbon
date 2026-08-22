/**
 * Hetzner Object Storage (S3-compatible) Provider
 *
 * Hetzner-specific glue over the generic `S3CompatibleProvider` base
 * (s3-base.js): endpoint/region maps and the deploy-region → S3-region
 * resolver. Every actual S3 operation (client construction, retry, bucket
 * lifecycle, CORS) lives in the base class.
 * Note: S3 credentials must be created manually in Hetzner Console.
 *
 * API Documentation: https://docs.hetzner.com/storage/object-storage/
 */

import {
  deriveStateBucketName,
  resolveStateBucketName,
  S3CompatibleProvider,
  sanitizeBucketName,
} from './s3-base.js';

export class HetznerS3Provider extends S3CompatibleProvider {
  static ENDPOINTS = {
    fsn1: 'https://fsn1.your-objectstorage.com',
    nbg1: 'https://nbg1.your-objectstorage.com',
    hel1: 'https://hel1.your-objectstorage.com',
  };

  static REGIONS = {
    fsn1: 'Falkenstein, Germany',
    nbg1: 'Nuremberg, Germany',
    hel1: 'Helsinki, Finland',
  };

  /**
   * Resolve the nearest S3 region for a given deployment region.
   * Returns the region itself if S3 is available there, otherwise maps to the closest one.
   */
  static resolveS3Region(deployRegion) {
    if (HetznerS3Provider.ENDPOINTS[deployRegion]) return deployRegion;

    // Map non-S3 regions to nearest S3 region
    // hel1 is the only non-German EU S3 region, so EU regions map to fsn1 (central Germany)
    // US regions also map to nearest EU S3 (no US S3 available)
    const regionMap = {
      ash: 'fsn1', // Ashburn, VA → Falkenstein (lowest latency EU)
      hil: 'fsn1', // Hillsboro, OR → Falkenstein
      sin: 'hel1', // Singapore → Helsinki (if ever added)
    };
    return regionMap[deployRegion] || 'fsn1';
  }
}

// Re-exported so existing importers of these module-level helpers from
// hetzner-s3.js keep working unchanged — they now live in s3-base.js
// alongside the base provider they're conceptually tied to (bucket naming
// is generic S3, not Hetzner-specific).
export { deriveStateBucketName, resolveStateBucketName, sanitizeBucketName };
