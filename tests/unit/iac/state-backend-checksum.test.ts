/**
 * Pulumi S3 state-backend checksum mode — RCA pin for CI run 31663154544
 * (2026-08-13), where `E2E (scaleway)` died ~90s in at the FIRST state write:
 *
 *   error: write ".pulumi/meta.yaml": operation error S3: PutObject,
 *   StatusCode: 400, InvalidRequest: Value for x-amz-checksum-sha256
 *   header is invalid.
 *
 * Pulumi 3.256.0 injects `request_checksum_calculation=when_required` into
 * every s3:// backend URL that sets a custom `endpoint` (all of ours), and the
 * gocloud.dev it vendors implements that mode by sending the literal sentinel
 * `x-amz-checksum-sha256: UNSIGNED-PAYLOAD`. Scaleway rejects it.
 *
 * The fix is deliberately OPT-IN PER PROVIDER, and these tests exist mostly to
 * keep it that way. On that same run, on that same Pulumi, Hetzner /
 * DigitalOcean / Vultr ran full green lifecycles WITH the sentinel — so the
 * "no parameter for anyone else" assertions below are the real regression
 * guard, not an afterthought. Flipping them to `when_supported` would restore
 * the CRC32 aws-chunked upload that Pulumi's injection was itself added to
 * work around for other third-party stores (pulumi/pulumi#23764).
 */
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error — JS module without types
import { resolveBackendUrl } from '../../../src/lib/iac/index.js';
// @ts-expect-error — JS module without types
import { PROVIDERS } from '../../../src/lib/providers/index.js';

const CHECKSUM_PARAM = 'request_checksum_calculation';

// gocloud.dev's s3blob URL opener accepts exactly these two spellings; any
// other value makes the backend fail to open at all, so a typo in a provider
// static must fail here rather than at deploy time.
const VALID_MODES = ['when_supported', 'when_required'];

const s3Config = {
  bucket: 'myapp-storage',
  stateBucket: 'myapp-storage-pulumi-state',
  endpoint: 'https://s3.fr-par.scw.cloud',
  region: 'fr-par',
};

describe('resolveBackendUrl — request_checksum_calculation', () => {
  const savedBackend = process.env.PULUMI_BACKEND_URL;
  afterEach(() => {
    if (savedBackend === undefined) delete process.env.PULUMI_BACKEND_URL;
    else process.env.PULUMI_BACKEND_URL = savedBackend;
  });

  it('pins when_supported for scaleway, suppressing Pulumi 3.256.0 UNSIGNED-PAYLOAD injection', () => {
    delete process.env.PULUMI_BACKEND_URL;
    const url = resolveBackendUrl(s3Config, 'scaleway');
    expect(url).toContain(`&${CHECKSUM_PARAM}=when_supported`);
    // Pulumi only defaults the parameter when it is ABSENT — an explicit
    // value is what makes the injection a no-op.
    expect(url).not.toContain('when_required');
  });

  it('adds NO checksum parameter for the providers proven green with the default', () => {
    delete process.env.PULUMI_BACKEND_URL;
    for (const provider of ['hetzner', 'digitalocean', 'vultr', 'linode']) {
      const url = resolveBackendUrl(s3Config, provider);
      expect(url, `${provider} must keep Pulumi's default checksum behavior`).not.toContain(
        CHECKSUM_PARAM,
      );
    }
  });

  it('adds no checksum parameter when the caller does not know the provider', () => {
    delete process.env.PULUMI_BACKEND_URL;
    expect(resolveBackendUrl(s3Config)).not.toContain(CHECKSUM_PARAM);
  });

  it('keeps the rest of the query string intact alongside the parameter', () => {
    delete process.env.PULUMI_BACKEND_URL;
    const url = resolveBackendUrl(s3Config, 'scaleway');
    expect(url).toContain('s3://myapp-storage-pulumi-state?');
    expect(url).toContain('endpoint=s3.fr-par.scw.cloud');
    expect(url).toContain('region=fr-par');
    expect(url).toContain('s3ForcePathStyle=true');
    // Exactly one `?`, and the checksum parameter joined with `&` — a stray
    // second `?` would silently swallow every parameter after it.
    expect(url.match(/\?/g)).toHaveLength(1);
  });

  it('still yields to an explicit PULUMI_BACKEND_URL override', () => {
    process.env.PULUMI_BACKEND_URL = 'file:///tmp/custom-state';
    expect(resolveBackendUrl(s3Config, 'scaleway')).toBe('file:///tmp/custom-state');
  });

  it('adds no checksum parameter on the local file:// fallback', () => {
    delete process.env.PULUMI_BACKEND_URL;
    expect(resolveBackendUrl(undefined, 'scaleway')).not.toContain(CHECKSUM_PARAM);
  });
});

describe('STATE_BACKEND_CHECKSUM_CALCULATION census', () => {
  it('every registered provider declares an empty or gocloud-valid mode', () => {
    const ids = Object.keys(PROVIDERS);
    expect(ids.length).toBeGreaterThanOrEqual(5); // sanity: registry actually loaded

    for (const id of ids) {
      const mode = PROVIDERS[id].STATE_BACKEND_CHECKSUM_CALCULATION;
      expect(typeof mode, `${id} must declare the static (inherited from BaseProvider)`).toBe(
        'string',
      );
      if (mode !== '') {
        expect(VALID_MODES, `${id} declares an unopenable checksum mode: ${mode}`).toContain(mode);
      }
    }
  });

  it('scaleway is the only provider opting out of Pulumi defaults (census not vacuous)', () => {
    const opted = Object.keys(PROVIDERS).filter(
      (id) => PROVIDERS[id].STATE_BACKEND_CHECKSUM_CALCULATION !== '',
    );
    expect(opted).toEqual(['scaleway']);
  });
});
