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
 * the verification account got `us-iad-10`, `us-ord-10`, and `us-lax-4`
 * where the docs' generic table says `-1`. The maps below therefore carry
 * every OBSERVED cluster slug alongside the docs defaults; `resolveS3Region`
 * still maps compute regions to the docs-default cluster, and an operator
 * whose account is assigned a variant pins it via the
 * `LINODE_STORAGE_REGION` env override (S3_REGION_ENV — honored by
 * the deploy-time resolution in deploy/prompts.js). Durable follow-up
 * (recorded in the expansion plan): resolve the assigned cluster
 * dynamically from the endpoints listing at deploy time instead of asking
 * the operator to know it.
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

export class LinodeObjectStorageProvider extends S3CompatibleProvider {
  /** No settle window has been observed on a new bucket here. */
  static bucketSettleWindowMs = 0;

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
    let entry;
    for (let page = 1, pages = 1; page <= pages && !entry; page++) {
      const listed = await fetchWithRetry(
        `${API_BASE}/object-storage/endpoints?page_size=500&page=${page}`,
        { headers },
      );
      if (!listed.ok) throw appKeyMintError('Linode', listed.status, LINODE_SCOPE);
      const body = await readJson(listed);
      pages = body.pages ?? 1;
      entry = (body.data ?? []).find(
        (e) => e.s3_endpoint && new URL(`https://${e.s3_endpoint}`).host === host,
      );
    }
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

  // Compute region slug → Object Storage endpoint slug. Every
  // LinodeProvider.REGIONS key appears here (the compute region list is
  // pinned to Object-Storage-carrying regions, same doctrine as DO's B2).
  static COMPUTE_TO_S3 = {
    'us-iad': 'us-iad-1',
    'us-iad-2': 'us-iad-18',
    'us-ord': 'us-ord-1',
    'us-sea': 'us-sea-1',
    'us-lax': 'us-lax-1',
    'us-mia': 'us-mia-1',
    'us-east': 'us-east-1',
    'us-southeast': 'us-southeast-1',
    'fr-par': 'fr-par-1',
    'gb-lon': 'gb-lon-1',
    'de-fra-2': 'de-fra-1',
    'in-maa': 'in-maa-1',
    'sg-sin-2': 'sg-sin-1',
    'jp-tyo-3': 'jp-tyo-1',
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
}

/** The scope a Linode token needs to mint and revoke app keys. */
const LINODE_SCOPE = 'the Object Storage read/write scope (object_storage:read_write)';

export { deriveStateBucketName, sanitizeBucketName };
