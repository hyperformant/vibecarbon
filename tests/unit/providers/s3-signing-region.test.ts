import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import { LinodeObjectStorageProvider } from '../../../src/lib/providers/linode-objectstorage.js';

/**
 * S3 signing-region seam (2026-08-08, first live l1 run RCA).
 *
 * The AWS SDK v3 auto-injects `CreateBucketConfiguration.LocationConstraint`
 * from the client's `region` whenever it isn't `us-east-1`. Linode's RGW
 * rejects ANY non-empty constraint (live probe against the assigned
 * us-iad-10 cluster: `us-iad-10` → InvalidLocationConstraint, `us-iad` →
 * InvalidLocationConstraint, omitted → success), so its S3 class pins the
 * SIGNING region to `us-east-1` — which both suppresses the injection and
 * matches Linode's own aws-cli guidance. The endpoint (and therefore the
 * actual cluster) still comes from ENDPOINTS[this.region].
 *
 * Census: every registered provider's S3 client must resolve its signing
 * region to `S3_SIGNING_REGION ?? <constructor region>` — so a future
 * provider with the same RGW dialect declares the static instead of
 * rediscovering this via a failed live deploy.
 */
describe('S3 signing-region seam', () => {
  it('every registered provider S3 client honors S3_SIGNING_REGION ?? region', async () => {
    for (const [id, Provider] of Object.entries(PROVIDERS)) {
      const S3Class = await Provider.getObjectStorageProviderClass();
      const region = Object.keys(S3Class.ENDPOINTS)[0];
      const instance = new S3Class('test-access-key', 'test-secret-key', region);
      const resolved = await instance.getClient().config.region();
      const expected = S3Class.S3_SIGNING_REGION ?? region;
      expect(resolved, `provider ${id}: signing region`).toBe(expected);
    }
  });

  it('Linode pins the signing region to us-east-1 (RGW rejects injected LocationConstraints)', () => {
    expect(LinodeObjectStorageProvider.S3_SIGNING_REGION).toBe('us-east-1');
  });

  it('Hetzner/DigitalOcean/Scaleway declare no override — their backends accept the region constraint', async () => {
    // Scaleway's absence is a deliberate pin, not an omission: it signs
    // AWS4 with its OWN region (its docs' example scopes credentials as
    // `…/nl-ams/s3/aws4_request`) and ACCEPTS the SDK-injected CreateBucket
    // LocationConstraint — it is NOT the Linode/Vultr Ceph class, and
    // cargo-culting us-east-1 onto it would sign every request wrongly.
    for (const id of ['hetzner', 'digitalocean', 'scaleway']) {
      const S3Class = await PROVIDERS[id].getObjectStorageProviderClass();
      expect(S3Class.S3_SIGNING_REGION, `provider ${id}`).toBeUndefined();
    }
  });
});
