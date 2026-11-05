import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';
import { LinodeObjectStorageProvider } from '../../../src/lib/providers/linode-objectstorage.js';

// Browser uploads need a CORS rule, and Linode's E2 and E3 endpoints answer
// PutBucketCors with 501. E0 and E1 take it: each of these nine passed 30 of 30
// preflights and a presigned PUT and GET on 2026-11-05.
const VERIFIED_E0_E1 = [
  'us-iad',
  'us-sea',
  'us-mia',
  'us-east',
  'us-southeast',
  'fr-par',
  'in-maa',
  'id-cgk',
  'br-gru',
];

// One account's real listing, 2026-11-05: Washington is assigned cluster 10,
// Chennai has E3 listed with no endpoint yet, and Frankfurt is E3 only.
const LISTING = [
  { region: 'us-iad', endpoint_type: 'E1', s3_endpoint: 'us-iad-10.linodeobjects.com' },
  { region: 'us-iad-2', endpoint_type: 'E3', s3_endpoint: 'us-iad-18.linodeobjects.com' },
  { region: 'us-east', endpoint_type: 'E0', s3_endpoint: 'us-east-1.linodeobjects.com' },
  { region: 'in-maa', endpoint_type: 'E3', s3_endpoint: null },
  { region: 'in-maa', endpoint_type: 'E1', s3_endpoint: 'in-maa-1.linodeobjects.com' },
  { region: 'fr-par', endpoint_type: 'E1', s3_endpoint: 'fr-par-1.linodeobjects.com' },
  { region: 'de-fra-2', endpoint_type: 'E3', s3_endpoint: 'de-fra-1.linodeobjects.com' },
];

function stubEndpoints(data: unknown[], status = 200) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ data, page: 1, pages: 1 }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const resolve = (region: string) =>
  LinodeObjectStorageProvider.resolveAccountS3Region(region, { apiToken: 'token' });

afterEach(() => {
  vi.unstubAllGlobals();
  delete LinodeObjectStorageProvider.ENDPOINTS['us-sea-9'];
});

describe('Linode object storage always lands on an upload-capable endpoint', () => {
  it('maps every compute region to a region verified to take the CORS rule', () => {
    for (const region of Object.keys(LinodeProvider.REGIONS)) {
      const home = LinodeObjectStorageProvider.resolveS3Region(region).replace(/-\d+$/, '');
      expect(VERIFIED_E0_E1, `${region} stores in ${home}`).toContain(home);
    }
  });

  it('uses the cluster this account was given, not the documented default', async () => {
    stubEndpoints(LISTING);
    expect(await resolve('us-iad')).toBe('us-iad-10');
  });

  it('skips an E3 listing in the same region', async () => {
    stubEndpoints(LISTING);
    expect(await resolve('in-maa')).toBe('in-maa-1');
  });

  it('takes E0 as readily as E1', async () => {
    stubEndpoints(LISTING);
    expect(await resolve('us-east')).toBe('us-east-1');
  });

  it('sends a compute region with E3 storage to its nearest E1 region', async () => {
    stubEndpoints(LISTING);
    expect(await resolve('de-fra-2')).toBe('fr-par-1');
    expect(await resolve('us-iad-2')).toBe('us-iad-10');
  });

  it('accepts a cluster number it has never seen, so the S3 client can reach it', async () => {
    stubEndpoints([
      { region: 'us-sea', endpoint_type: 'E1', s3_endpoint: 'us-sea-9.linodeobjects.com' },
    ]);
    const slug = await resolve('us-sea');
    expect(slug).toBe('us-sea-9');
    expect(new LinodeObjectStorageProvider('a', 'b', slug).endpoint).toBe(
      'https://us-sea-9.linodeobjects.com',
    );
  });

  it('says what to do when the account has no such endpoint there', async () => {
    stubEndpoints([
      { region: 'fr-par', endpoint_type: 'E3', s3_endpoint: 'fr-par-2.linodeobjects.com' },
    ]);
    await expect(resolve('fr-par')).rejects.toThrow(/LINODE_STORAGE_REGION/);
  });

  it('does not take an E1 listing that has no endpoint yet', async () => {
    stubEndpoints([{ region: 'fr-par', endpoint_type: 'E1', s3_endpoint: null }]);
    await expect(resolve('fr-par')).rejects.toThrow(/LINODE_STORAGE_REGION/);
  });

  it('names the token scope when Linode refuses the listing', async () => {
    stubEndpoints([], 401);
    await expect(resolve('us-iad')).rejects.toThrow(/object_storage/);
  });
});

describe('the note for storage in another region', () => {
  it('names where files go when the compute region has no upload-capable storage', () => {
    expect(LinodeObjectStorageProvider.storageRegionNote('de-fra-2')).toContain('Paris');
  });

  it('names a real place for every compute region that borrows storage', () => {
    const notes = Object.keys(LinodeProvider.REGIONS)
      .map((region) => LinodeObjectStorageProvider.storageRegionNote(region))
      .filter(Boolean);
    expect(notes).toHaveLength(7);
    for (const note of notes) {
      expect(note).not.toContain('undefined');
      expect(note).not.toMatch(/—/);
    }
  });

  it('stays quiet when storage is in the compute region', () => {
    expect(LinodeObjectStorageProvider.storageRegionNote('us-iad')).toBeNull();
    expect(LinodeObjectStorageProvider.storageRegionNote('fr-par')).toBeNull();
  });
});
