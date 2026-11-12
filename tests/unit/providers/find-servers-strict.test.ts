import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * findServersByName's strict mode, on all five providers. The default
 * soft-fails to `[]` on a non-ok response, which is fine for best-effort
 * discovery. The seal acts on the answer: "no server by that name" lets it
 * drop the record of an unfinished create (lib/iac/state-pending.js), so a
 * refused request or a listing the walk didn't finish must reject instead of
 * reading as "none".
 */

const fetchWithRetryMock = vi.fn();

vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  };
});

import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';
import { ScalewayProvider } from '../../../src/lib/providers/scaleway.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';

const NAME = 'p-e1-worker-1';
const jsonResp = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

type Lookup = {
  findServersByName: (name: string, options?: { strict?: boolean }) => Promise<unknown[]>;
};

/** Each provider: a one-page listing holding NAME, and (paged ones) a listing that never ends. */
const CASES: Array<{
  provider: string;
  make: () => Lookup;
  listing: (url: string) => unknown;
  endless?: () => unknown;
}> = [
  {
    provider: 'Hetzner Cloud',
    make: () => new HetznerProvider('tok') as unknown as Lookup,
    listing: () => ({ servers: [{ id: 1, name: NAME }] }),
  },
  {
    provider: 'DigitalOcean',
    make: () => new DigitalOceanProvider('tok') as unknown as Lookup,
    listing: () => ({
      droplets: [
        { id: 1, name: NAME },
        { id: 2, name: 'other' },
      ],
      links: {},
    }),
    endless: () => ({ droplets: [], links: { pages: { next: 'more' } } }),
  },
  {
    provider: 'Linode',
    make: () => new LinodeProvider('tok') as unknown as Lookup,
    listing: () => ({
      data: [
        { id: 1, label: NAME },
        { id: 2, label: 'other' },
      ],
      pages: 1,
    }),
    endless: () => ({ data: [], pages: 99 }),
  },
  {
    provider: 'Vultr',
    make: () => new VultrProvider('tok') as unknown as Lookup,
    listing: () => ({
      instances: [
        { id: 'a', label: NAME },
        { id: 'b', label: 'other' },
      ],
      meta: { links: { next: '' } },
    }),
    endless: () => ({ instances: [], meta: { links: { next: 'cursor' } } }),
  },
  {
    provider: 'Scaleway',
    make: () => new ScalewayProvider('tok') as unknown as Lookup,
    listing: (url) => ({
      servers: url.includes('/zones/fr-par-1/') ? [{ id: 'a', name: NAME }] : [],
    }),
    // A full page on every page: the walk stops at its limit, unfinished.
    endless: () => ({
      servers: Array.from({ length: 100 }, (_, i) => ({ id: `x${i}`, name: 'other' })),
    }),
  },
];

beforeEach(() => {
  fetchWithRetryMock.mockReset();
});

describe.each(CASES)('$provider findServersByName', ({ provider, make, listing, endless }) => {
  it('strict: the same servers as the default when the provider lists them all', async () => {
    fetchWithRetryMock.mockImplementation(async (url: string) => jsonResp(listing(url)));
    const lenient = await make().findServersByName(NAME);
    const strict = await make().findServersByName(NAME, { strict: true });
    expect(lenient).toHaveLength(1);
    expect(strict).toEqual(lenient);
  });

  it('a refused request: [] by default, a rejection naming the provider and the status when strict', async () => {
    fetchWithRetryMock.mockResolvedValue(jsonResp({}, 403));
    expect(await make().findServersByName(NAME)).toEqual([]);
    await expect(make().findServersByName(NAME, { strict: true })).rejects.toThrow(
      `${provider} couldn't say whether the server ${NAME} exists: it answered HTTP 403`,
    );
  });

  it.runIf(endless)('a listing longer than the walk reads: strict rejects', async () => {
    fetchWithRetryMock.mockImplementation(async () => jsonResp(endless?.()));
    await expect(make().findServersByName(NAME, { strict: true })).rejects.toThrow(
      `${provider} couldn't say whether the server ${NAME} exists: the server list has more pages than vibecarbon reads`,
    );
  });
});
