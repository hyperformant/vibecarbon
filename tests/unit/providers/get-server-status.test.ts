import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every provider's getServer carries the HTTP status on its refusal.
 *
 * assertTokenSeesCluster (src/lib/deploy/k8s/token-sees-cluster.js) reads
 * `err.status` to tell a token that cannot see the cluster (401, 403, 404)
 * from a read that failed for another reason, and words its advice from
 * that. Hetzner, DigitalOcean and Linode attached it; Vultr and Scaleway
 * threw a plain Error, so a refusal there read as "could not check".
 *
 * Keyed by the PROVIDERS registry, so a new provider is covered the day it
 * registers.
 */

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  };
});

import { PROVIDERS } from '../../../src/lib/providers/index.js';

/** Per-provider setup so getServer's only request is the read itself. */
const PRIME: Record<string, (provider: Record<string, unknown>) => void> = {
  // getServer resolves the server's zone first; a warm cache skips the probe.
  scaleway: (provider) => {
    provider._zoneCache = new Map([['srv-1', 'fr-par-1']]);
  },
};

beforeEach(() => {
  fetchWithRetryMock.mockReset();
});

describe('getServer keeps the HTTP status of a refusal', () => {
  it.each(Object.entries(PROVIDERS))('%s', async (id, Provider) => {
    const provider = new (Provider as new (token: string) => Record<string, unknown>)('tok');
    PRIME[id]?.(provider);
    fetchWithRetryMock.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({}),
      text: async () => '',
    });

    const read = (provider.getServer as (id: string) => Promise<unknown>).call(provider, 'srv-1');
    await expect(read).rejects.toThrow(/Failed to get server/);
    await expect(read).rejects.toMatchObject({ status: 403 });
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
  });
});
