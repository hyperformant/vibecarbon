/**
 * Hetzner Object Storage (S3-compatible) Provider
 *
 * Hetzner-specific glue over the generic `S3CompatibleProvider` base
 * (s3-base.js): endpoint/region maps and the deploy-region → S3-region
 * resolver. Every actual S3 operation (client construction, retry, bucket
 * lifecycle, CORS) lives in the base class.
 * Note: S3 credentials must be created manually in Hetzner Console, the
 * optional per-environment app key included (vibecarbon configure storage).
 *
 * API Documentation: https://docs.hetzner.com/storage/object-storage/
 */

import { ListBucketsCommand } from '@aws-sdk/client-s3';
import {
  deriveStateBucketName,
  resolveStateBucketName,
  S3CompatibleProvider,
  sanitizeBucketName,
} from './s3-base.js';

export class HetznerS3Provider extends S3CompatibleProvider {
  /**
   * A new Hetzner bucket answers inconsistently for about 16 minutes. The
   * 2026-10-20 probes against a minutes-old bucket saw about 40% of CORS
   * preflights refused with a 403 and some NoSuchBucket answers, then 58/60
   * and 60/60 three times, settled about 16 minutes after create. Rounded up
   * to 20 for margin; see src/lib/deploy/bucket-settle.js.
   */
  static bucketSettleWindowMs = 20 * 60_000;

  /**
   * Keys are made only in the console (every API credential route is a 404),
   * but each key is its own principal, `arn:aws:iam:::user/<ownerId>:<accessKeyId>`,
   * so a pasted app key can be fenced out of the other buckets with a Deny
   * policy (security plan R2, measured 2026-10-20). See hetzner-app-key-fence.js.
   */
  static appKeyScoping = 'paste-fence';

  /**
   * The project user every key here belongs to (`p…`), from ListBuckets'
   * `Owner.ID`. The fence policy's principals are `<ownerId>:<accessKeyId>`.
   * @returns {Promise<string>}
   */
  async ownerId() {
    const response = await this._send(new ListBucketsCommand({}));
    const id = response?.Owner?.ID;
    if (!id) throw new Error('Hetzner object storage did not report the project owner id');
    return id;
  }

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
