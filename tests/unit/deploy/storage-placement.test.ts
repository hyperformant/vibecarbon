/**
 * Where a deployment's storage goes. A pinned region wins and stays silent:
 * the note names the default's city, so printing it beside a pin would tell
 * the operator their files are somewhere they are not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveStoragePlacement } from '../../../src/lib/deploy/prompts.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';

const parisListing = [
  { region: 'fr-par', endpoint_type: 'E1', s3_endpoint: 'fr-par-1.linodeobjects.com' },
];

const fetchMock = vi.fn(
  async () =>
    new Response(JSON.stringify({ data: parisListing, page: 1, pages: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
);

const place = (over: Record<string, unknown> = {}) =>
  resolveStoragePlacement({
    args: {},
    envConfig: { provider: 'linode' },
    Provider: LinodeProvider,
    region: 'de-fra-2',
    apiToken: 'token',
    ...over,
  });

let savedOverride: string | undefined;

beforeEach(() => {
  savedOverride = process.env.LINODE_STORAGE_REGION;
  delete process.env.LINODE_STORAGE_REGION;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedOverride === undefined) delete process.env.LINODE_STORAGE_REGION;
  else process.env.LINODE_STORAGE_REGION = savedOverride;
});

describe('resolveStoragePlacement', () => {
  it('borrows upload-capable storage from the account and says where', async () => {
    const { s3Region, note } = await place();
    expect(s3Region).toBe('fr-par-1');
    expect(note).toContain('Paris');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('says nothing when storage is in the compute region', async () => {
    const { s3Region, note } = await place({ region: 'fr-par' });
    expect(s3Region).toBe('fr-par-1');
    expect(note).toBeNull();
  });

  it.each([
    ['a flag', { args: { s3Region: 'de-fra-1' } }],
    [
      'a region already on record',
      { envConfig: { provider: 'linode', s3: { region: 'de-fra-1' } } },
    ],
  ])('%s wins, with no note and no API call', async (_name, over) => {
    await expect(place(over)).resolves.toEqual({ s3Region: 'de-fra-1', note: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the environment override wins, with no note and no API call', async () => {
    process.env.LINODE_STORAGE_REGION = 'de-fra-1';
    await expect(place()).resolves.toEqual({ s3Region: 'de-fra-1', note: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a provider with storage in every region needs no note', async () => {
    const { s3Region, note } = await place({
      envConfig: { provider: 'hetzner' },
      Provider: HetznerProvider,
      region: 'nbg1',
    });
    expect(s3Region).toBe('nbg1');
    expect(note).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
