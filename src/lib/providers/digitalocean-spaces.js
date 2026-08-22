/**
 * DigitalOcean Spaces (S3-compatible) Provider
 *
 * DigitalOcean-specific glue over the generic `S3CompatibleProvider` base
 * (s3-base.js): endpoint/region maps and the deploy-region → S3-region
 * resolver. Every actual S3 operation (client construction, retry, bucket
 * lifecycle, CORS) lives in the base class.
 * Note: S3 credentials must be created manually in DigitalOcean Console.
 *
 * API Documentation: https://docs.digitalocean.com/products/spaces/
 */

import { deriveStateBucketName, S3CompatibleProvider, sanitizeBucketName } from './s3-base.js';

export class DigitalOceanSpacesProvider extends S3CompatibleProvider {
  static ENDPOINTS = {
    nyc3: 'https://nyc3.digitaloceanspaces.com',
    sfo3: 'https://sfo3.digitaloceanspaces.com',
    ams3: 'https://ams3.digitaloceanspaces.com',
    fra1: 'https://fra1.digitaloceanspaces.com',
    lon1: 'https://lon1.digitaloceanspaces.com',
    tor1: 'https://tor1.digitaloceanspaces.com',
    sgp1: 'https://sgp1.digitaloceanspaces.com',
    blr1: 'https://blr1.digitaloceanspaces.com',
    syd1: 'https://syd1.digitaloceanspaces.com',
    atl1: 'https://atl1.digitaloceanspaces.com',
  };

  // Same shape as HetznerS3Provider.REGIONS and the getRegions() docblock:
  // slug → human description. (Was a bare array of slugs until the 2026-08-07
  // S3 contract suite caught the divergence.)
  static REGIONS = {
    nyc3: 'New York, USA',
    sfo3: 'San Francisco, USA',
    ams3: 'Amsterdam, Netherlands',
    fra1: 'Frankfurt, Germany',
    lon1: 'London, United Kingdom',
    tor1: 'Toronto, Canada',
    sgp1: 'Singapore',
    blr1: 'Bangalore, India',
    syd1: 'Sydney, Australia',
    atl1: 'Atlanta, USA',
  };

  /**
   * Resolve the S3 region for a given deployment region.
   * Every REGIONS entry has in-region Spaces (B2 pins the region list to
   * Spaces-capable regions), so this is identity-with-fallback: returns the
   * region itself if it's in ENDPOINTS, otherwise falls back to 'nyc3'.
   */
  static resolveS3Region(deployRegion) {
    return DigitalOceanSpacesProvider.ENDPOINTS[deployRegion] ? deployRegion : 'nyc3';
  }
}

// Re-exported so existing importers of these module-level helpers from
// digitalocean-spaces.js keep working unchanged — they now live in s3-base.js
// alongside the base provider they're conceptually tied to (bucket naming
// is generic S3, not DigitalOcean-specific).
export { deriveStateBucketName, sanitizeBucketName };
