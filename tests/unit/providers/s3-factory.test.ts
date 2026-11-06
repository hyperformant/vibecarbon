/**
 * S3 factory (getObjectStorageProvider / resolveS3RegionFor) — the one
 * dispatch point through which every callsite reaches a provider's
 * object-storage client, keyed by provider id (see lib/providers/index.js).
 * At n=1 registered provider (Hetzner) this proves the mapping table and
 * region-resolution delegation are wired correctly; when a second provider
 * (e.g. DigitalOcean Spaces) registers, it slots into the same table.
 */
import { describe, expect, it, vi } from 'vitest';
import { HetznerS3Provider } from '../../../src/lib/providers/hetzner-s3.js';
import { getObjectStorageProvider, resolveS3RegionFor } from '../../../src/lib/providers/index.js';

describe('getObjectStorageProvider', () => {
  it('resolves "hetzner" to an instance of HetznerS3Provider', async () => {
    const s3 = await getObjectStorageProvider('hetzner', 'ak', 'sk', 'fsn1');
    expect(s3).toBeInstanceOf(HetznerS3Provider);
  });

  it('constructs the instance with the given credentials and region', async () => {
    const s3 = await getObjectStorageProvider('hetzner', 'my-key', 'my-secret', 'nbg1');
    expect(s3.accessKeyId).toBe('my-key');
    expect(s3.secretAccessKey).toBe('my-secret');
    expect(s3.region).toBe('nbg1');
  });

  it('is case-insensitive on provider id, mirroring getProviderClass', async () => {
    const s3 = await getObjectStorageProvider('HETZNER', 'ak', 'sk', 'fsn1');
    expect(s3).toBeInstanceOf(HetznerS3Provider);
  });

  it('throws for an unknown provider id', async () => {
    await expect(getObjectStorageProvider('not-a-cloud', 'ak', 'sk', 'fsn1')).rejects.toThrow(
      'Unknown provider',
    );
  });
});

describe('resolveS3RegionFor', () => {
  it('asks the account when the provider assigns storage per account and a token is at hand', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { region: 'us-iad', endpoint_type: 'E1', s3_endpoint: 'us-iad-10.linodeobjects.com' },
            ],
            page: 1,
            pages: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(resolveS3RegionFor('linode', 'us-iad', { apiToken: 'token' })).resolves.toBe(
        'us-iad-10',
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the static map without a token, and for providers with one storage per region', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(resolveS3RegionFor('linode', 'us-iad')).resolves.toBe('us-iad-1');
      await expect(resolveS3RegionFor('hetzner', 'nbg1', { apiToken: 'token' })).resolves.toBe(
        'nbg1',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('delegates to HetznerS3Provider.resolveS3Region for an S3-native region', async () => {
    await expect(resolveS3RegionFor('hetzner', 'nbg1')).resolves.toBe(
      HetznerS3Provider.resolveS3Region('nbg1'),
    );
    await expect(resolveS3RegionFor('hetzner', 'nbg1')).resolves.toBe('nbg1');
  });

  it('delegates to HetznerS3Provider.resolveS3Region for a mapped non-S3 region', async () => {
    await expect(resolveS3RegionFor('hetzner', 'ash')).resolves.toBe(
      HetznerS3Provider.resolveS3Region('ash'),
    );
    await expect(resolveS3RegionFor('hetzner', 'ash')).resolves.toBe('fsn1');
  });

  it('throws for an unknown provider id', async () => {
    await expect(resolveS3RegionFor('not-a-cloud', 'fsn1')).rejects.toThrow('Unknown provider');
  });
});
