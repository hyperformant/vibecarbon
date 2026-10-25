/**
 * DigitalOcean Spaces (S3-compatible) Provider
 *
 * DigitalOcean-specific glue over the generic `S3CompatibleProvider` base
 * (s3-base.js): endpoint/region maps and the deploy-region → S3-region
 * resolver. Every actual S3 operation (client construction, retry, bucket
 * lifecycle, CORS) lives in the base class.
 * Note: the infra S3 credentials are created manually in DigitalOcean Console.
 * Each environment's app key is minted over the API (`/v2/spaces/keys`),
 * limited to that env's bucket (appKeyScoping 'mint', security plan R2).
 *
 * API Documentation: https://docs.digitalocean.com/products/spaces/
 */

import { fetchWithRetry } from '../fetch-retry.js';
import { appKeyLabel, appKeyMintError, readJson } from './app-key-api.js';
import { deriveStateBucketName, S3CompatibleProvider, sanitizeBucketName } from './s3-base.js';

const API_BASE = 'https://api.digitalocean.com/v2';

/** The scopes a custom-scoped DigitalOcean token needs for app keys. */
const DO_SCOPE = 'the spaces_key create and delete scopes';

export class DigitalOceanSpacesProvider extends S3CompatibleProvider {
  /** No settle window has been observed on a new bucket here. */
  static bucketSettleWindowMs = 0;

  /**
   * The API mints a key with a `readwrite` grant on one bucket, which gets
   * 403 on every other bucket and on ListBuckets (security plan R2, measured
   * 2026-10-20).
   */
  static appKeyScoping = 'mint';

  /**
   * Mint the env's app key: a `readwrite` grant on `bucket` only. Never
   * `fullaccess`, the grant that reaches every bucket. One POST, never
   * retried (a retried create can mint twice): a failure throws one line that
   * names the token scopes it needs.
   * @param {string} bucket
   * @param {{ endpoint?: string, apiToken: string }} opts
   * @returns {Promise<{ id: string, accessKey: string, secretKey: string }>}
   */
  static async mintAppKey(bucket, { apiToken }) {
    const res = await fetch(`${API_BASE}/spaces/keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: appKeyLabel(bucket, 63),
        grants: [{ bucket, permission: 'readwrite' }],
      }),
    });
    if (!res.ok) throw appKeyMintError('DigitalOcean', res.status, DO_SCOPE);
    const { key } = await readJson(res);
    return { id: key.access_key, accessKey: key.access_key, secretKey: key.secret_key };
  }

  /**
   * Revoke an app key. One that is already gone counts as revoked.
   * @param {string} id - the key's access key id
   * @param {{ apiToken: string }} opts
   * @returns {Promise<void>}
   */
  static async revokeAppKey(id, { apiToken }) {
    const res = await fetchWithRetry(`${API_BASE}/spaces/keys/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`DigitalOcean refused to revoke app storage key ${id} (HTTP ${res.status})`);
    }
  }

  /**
   * Does DigitalOcean still list this key?
   * @param {string} id
   * @param {{ apiToken: string }} opts
   * @returns {Promise<boolean>}
   */
  static async appKeyExists(id, { apiToken }) {
    const res = await fetchWithRetry(`${API_BASE}/spaces/keys/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (res.status === 404) return false;
    if (!res.ok) {
      throw new Error(`DigitalOcean could not look up app storage key ${id} (HTTP ${res.status})`);
    }
    return true;
  }

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
