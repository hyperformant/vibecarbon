/**
 * Linode Object Storage (S3-compatible) Provider
 *
 * Linode-specific glue over the generic `S3CompatibleProvider` base
 * (s3-base.js): endpoint/region maps and the deploy-region → S3-region
 * resolver. Every actual S3 operation lives in the base class.
 *
 * REGIONS here are keyed by Linode's Object Storage ENDPOINT slugs
 * (`us-iad-1`, `de-fra-1`, ...), which are NOT the compute region slugs —
 * several compute regions map to a differently-numbered cluster (e.g.
 * compute `de-fra-2` → endpoint `de-fra-1`, `jp-tyo-3` → `jp-tyo-1`,
 * `us-iad-2` → `us-iad-18`). Verified 2026-08-07 against
 * https://techdocs.akamai.com/cloud-computing/docs/endpoint-types.
 *
 * ACCOUNT-ASSIGNED CLUSTERS (live-verified 2026-08-08 against a real
 * account's `GET /v4/object-storage/endpoints`): Linode assigns each
 * account ONE cluster per region, and it is not always the `-1` cluster —
 * the verification account got `us-iad-10` where the docs' generic table
 * says `-1`. A deploy therefore asks the account
 * (`resolveAccountS3Region`), and `LINODE_STORAGE_REGION` (S3_REGION_ENV)
 * stays as an operator override.
 *
 * E0 AND E1 ONLY: E2 and E3 answer PutBucketCors with 501, so a browser cannot
 * upload to them, and presigned uploads are how the app stores files. E0 and
 * E1 took the rule in all nine regions that have them, with 30 of 30 preflights
 * and a presigned PUT and GET each (2026-11-05). A compute region without one
 * stores in the nearest region that has one (COMPUTE_TO_S3), and the deploy
 * says so (`storageRegionNote`).
 *
 * Keys must be S3-client region strings AND embed themselves in their
 * endpoint hostname (s3-provider-contract pins both).
 *
 * Note: Object Storage keys are minted via POST /object-storage/keys
 * (linode-guided-setup.js walks the operator through it). The deploy also
 * mints each environment's app key there, limited to that env's bucket
 * (appKeyScoping 'mint', security plan R2).
 *
 * API Documentation: https://techdocs.akamai.com/cloud-computing/docs/object-storage
 */

import { fetchWithRetry } from '../fetch-retry.js';
import { appKeyLabel, appKeyMintError, readJson } from './app-key-api.js';
import { deriveStateBucketName, S3CompatibleProvider, sanitizeBucketName } from './s3-base.js';

const API_BASE = 'https://api.linode.com/v4';

/** The endpoint types that accept the CORS rule browser uploads need. */
const CORS_ENDPOINT_TYPES = new Set(['E0', 'E1']);

/**
 * A listing's endpoint as a URL. The API gives a bare host, and none at all for
 * an endpoint not yet provisioned.
 * @param {{ s3_endpoint: string|null }} entry
 * @returns {URL|null}
 */
function endpointUrl(entry) {
  return entry.s3_endpoint ? new URL(`https://${entry.s3_endpoint}`) : null;
}

/**
 * Every Object Storage endpoint the account lists, across pages.
 * @param {string} apiToken
 * @param {(status: number) => Error} refused - the error for a failed listing
 * @returns {Promise<Array<{ region: string, endpoint_type: string, s3_endpoint: string|null }>>}
 */
async function listAccountEndpoints(apiToken, refused) {
  const entries = [];
  for (let page = 1, pages = 1; page <= pages; page++) {
    const listed = await fetchWithRetry(
      `${API_BASE}/object-storage/endpoints?page_size=500&page=${page}`,
      { headers: { Authorization: `Bearer ${apiToken}` } },
    );
    if (!listed.ok) throw refused(listed.status);
    const body = await readJson(listed);
    pages = body.pages ?? 1;
    entries.push(...(body.data ?? []));
  }
  return entries;
}

export class LinodeObjectStorageProvider extends S3CompatibleProvider {
  /** No settle window has been observed on a new bucket here. */
  static bucketSettleWindowMs = 0;

  /** A new bucket answers from its first request here, so nothing waits. */
  static bucketQuietMs = 0;

  /**
   * The API mints a key limited to one bucket (`bucket_access` read_write),
   * which gets 403 on every other bucket (security plan R2, measured
   * 2026-10-20).
   */
  static appKeyScoping = 'mint';

  /**
   * Mint the env's app key: `read_write` on `bucket` only, never an
   * account-wide key. The key's region is the one Linode lists for this
   * endpoint's cluster (`GET /object-storage/endpoints`). One POST, never
   * retried (a retried create can mint twice): a failure throws one line that
   * names the token scope it needs.
   * @param {string} bucket
   * @param {{ endpoint: string, apiToken: string }} opts
   * @returns {Promise<{ id: string, accessKey: string, secretKey: string }>}
   */
  static async mintAppKey(bucket, { endpoint, apiToken }) {
    const headers = { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' };
    const host = new URL(endpoint).host;
    const endpoints = await listAccountEndpoints(apiToken, (status) =>
      appKeyMintError('Linode', status, LINODE_SCOPE),
    );
    const entry = endpoints.find((e) => endpointUrl(e)?.host === host);
    if (!entry?.region) {
      throw new Error(
        `Linode lists no object storage region for ${host}, so no app storage key can be minted for ${bucket}`,
      );
    }
    const { region } = entry;
    const res = await fetch(`${API_BASE}/object-storage/keys`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        label: appKeyLabel(bucket, 50),
        regions: [region],
        bucket_access: [{ region, bucket_name: bucket, permissions: 'read_write' }],
      }),
    });
    if (!res.ok) throw appKeyMintError('Linode', res.status, LINODE_SCOPE);
    const key = await readJson(res);
    return { id: String(key.id), accessKey: key.access_key, secretKey: key.secret_key };
  }

  /**
   * Revoke an app key. One that is already gone counts as revoked.
   * @param {string} id - the Linode key id
   * @param {{ apiToken: string }} opts
   * @returns {Promise<void>}
   */
  static async revokeAppKey(id, { apiToken }) {
    const res = await fetchWithRetry(`${API_BASE}/object-storage/keys/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Linode refused to revoke app storage key ${id} (HTTP ${res.status})`);
    }
  }

  /**
   * Does Linode still list this key?
   * @param {string} id
   * @param {{ apiToken: string }} opts
   * @returns {Promise<boolean>}
   */
  static async appKeyExists(id, { apiToken }) {
    const res = await fetchWithRetry(`${API_BASE}/object-storage/keys/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (res.status === 404) return false;
    if (!res.ok) {
      throw new Error(`Linode could not look up app storage key ${id} (HTTP ${res.status})`);
    }
    return true;
  }

  /**
   * SIGNING region for every S3 client this class builds (s3-base's
   * getClient/findBucketRegion) — the endpoint, and therefore the actual
   * cluster, still comes from ENDPOINTS[region]. Pinned to `us-east-1`
   * because the AWS SDK v3 auto-injects CreateBucketConfiguration.
   * LocationConstraint from any OTHER client region, and Linode's RGW
   * rejects every constraint spelling (live probe 2026-08-08 against the
   * assigned us-iad-10 cluster: 'us-iad-10' and 'us-iad' both →
   * InvalidLocationConstraint; omitted → success). us-east-1 both
   * suppresses the injection and matches Linode's own aws-cli guidance.
   * Pinned by s3-signing-region.test.ts.
   * @type {string}
   */
  static S3_SIGNING_REGION = 'us-east-1';

  static ENDPOINTS = {
    'us-iad-1': 'https://us-iad-1.linodeobjects.com',
    'us-iad-10': 'https://us-iad-10.linodeobjects.com',
    'us-iad-18': 'https://us-iad-18.linodeobjects.com',
    'us-ord-1': 'https://us-ord-1.linodeobjects.com',
    'us-ord-10': 'https://us-ord-10.linodeobjects.com',
    'us-sea-1': 'https://us-sea-1.linodeobjects.com',
    'us-lax-1': 'https://us-lax-1.linodeobjects.com',
    'us-lax-4': 'https://us-lax-4.linodeobjects.com',
    'us-mia-1': 'https://us-mia-1.linodeobjects.com',
    'us-east-1': 'https://us-east-1.linodeobjects.com',
    'us-southeast-1': 'https://us-southeast-1.linodeobjects.com',
    'fr-par-1': 'https://fr-par-1.linodeobjects.com',
    'gb-lon-1': 'https://gb-lon-1.linodeobjects.com',
    'de-fra-1': 'https://de-fra-1.linodeobjects.com',
    'in-maa-1': 'https://in-maa-1.linodeobjects.com',
    'sg-sin-1': 'https://sg-sin-1.linodeobjects.com',
    'jp-tyo-1': 'https://jp-tyo-1.linodeobjects.com',
    'id-cgk-1': 'https://id-cgk-1.linodeobjects.com',
    'br-gru-1': 'https://br-gru-1.linodeobjects.com',
  };

  // Slug → human description (same shape as the Hetzner/DO S3 REGIONS maps).
  static REGIONS = {
    'us-iad-1': 'Washington, DC, USA',
    'us-iad-10': 'Washington, DC, USA (cluster 10)',
    'us-iad-18': 'Washington 2, DC, USA',
    'us-ord-1': 'Chicago, USA',
    'us-ord-10': 'Chicago, USA (cluster 10)',
    'us-sea-1': 'Seattle, USA',
    'us-lax-1': 'Los Angeles, USA',
    'us-lax-4': 'Los Angeles, USA (cluster 4)',
    'us-mia-1': 'Miami, USA',
    'us-east-1': 'Newark, USA',
    'us-southeast-1': 'Atlanta, USA',
    'fr-par-1': 'Paris, France',
    'gb-lon-1': 'London, United Kingdom',
    'de-fra-1': 'Frankfurt, Germany',
    'in-maa-1': 'Chennai, India',
    'sg-sin-1': 'Singapore',
    'jp-tyo-1': 'Tokyo, Japan',
    'id-cgk-1': 'Jakarta, Indonesia',
    'br-gru-1': 'Sao Paulo, Brazil',
  };

  // Compute region slug → the documented cluster of its Object Storage region:
  // its own where that region has E0 or E1, else the nearest that does. Every
  // LinodeProvider.REGIONS key appears here.
  static COMPUTE_TO_S3 = {
    'us-iad': 'us-iad-1',
    'us-iad-2': 'us-iad-1',
    'us-ord': 'us-iad-1',
    'us-sea': 'us-sea-1',
    'us-lax': 'us-sea-1',
    'us-mia': 'us-mia-1',
    'us-east': 'us-east-1',
    'us-southeast': 'us-southeast-1',
    'fr-par': 'fr-par-1',
    'gb-lon': 'fr-par-1',
    'de-fra-2': 'fr-par-1',
    'in-maa': 'in-maa-1',
    'sg-sin-2': 'id-cgk-1',
    'jp-tyo-3': 'id-cgk-1',
    'id-cgk': 'id-cgk-1',
    'br-gru': 'br-gru-1',
  };

  /**
   * Resolve the S3 region for a given deployment region: the compute →
   * endpoint-slug map first, identity for already-endpoint-slug inputs,
   * and the default-region cluster for anything unknown (total on
   * unknown/'' /undefined — s3-provider-contract pins this).
   * @param {string} deployRegion
   * @returns {string}
   */
  static resolveS3Region(deployRegion) {
    const mapped = LinodeObjectStorageProvider.COMPUTE_TO_S3[deployRegion];
    if (mapped) return mapped;
    if (LinodeObjectStorageProvider.ENDPOINTS[deployRegion]) return deployRegion;
    return 'us-iad-1';
  }

  /**
   * The cluster this account holds for a deployment region's storage, from
   * the account's own endpoint list. An E2 or E3 listing never counts: a
   * bucket there could not take the rule browser uploads need.
   * @param {string} deployRegion
   * @param {{ apiToken: string }} opts
   * @returns {Promise<string>} the cluster slug, e.g. `us-iad-10`
   */
  static async resolveAccountS3Region(deployRegion, { apiToken }) {
    const storage = regionOfCluster(LinodeObjectStorageProvider.resolveS3Region(deployRegion));
    const endpoints = await listAccountEndpoints(
      apiToken,
      (status) =>
        new Error(
          `Linode refused to list Object Storage endpoints (HTTP ${status}). The API token needs ${LINODE_SCOPE}.`,
        ),
    );
    const entry = endpoints.find(
      (e) => e.region === storage && e.s3_endpoint && CORS_ENDPOINT_TYPES.has(e.endpoint_type),
    );
    if (!entry) {
      throw new Error(
        `This Linode account has no E0 or E1 Object Storage in ${storage}, and browser uploads need one. Set LINODE_STORAGE_REGION to a cluster that has it.`,
      );
    }
    const url = endpointUrl(entry);
    const cluster = url.hostname.split('.')[0];
    // Clusters are assigned per account, so this may be one no map here holds.
    LinodeObjectStorageProvider.ENDPOINTS[cluster] ??= url.origin;
    return cluster;
  }

  /**
   * One line for a deploy whose storage is not in its compute region.
   * @param {string} deployRegion
   * @returns {string|null} null when storage is in the compute region
   */
  static storageRegionNote(deployRegion) {
    const cluster = LinodeObjectStorageProvider.resolveS3Region(deployRegion);
    if (regionOfCluster(cluster) === deployRegion) return null;
    const where = LinodeObjectStorageProvider.REGIONS[cluster];
    return `files and backups live in ${where}, the nearest Linode storage that takes browser uploads`;
  }
}

/** A cluster slug's Linode region: `us-iad-10` is in `us-iad`. */
function regionOfCluster(cluster) {
  return cluster.replace(/-\d+$/, '');
}

/** The scope a Linode token needs to mint and revoke app keys. */
const LINODE_SCOPE = 'the Object Storage read/write scope (object_storage:read_write)';

export { deriveStateBucketName, sanitizeBucketName };
