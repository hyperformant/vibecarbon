/**
 * A sweep never throws: "failures warn and flip enumFailed, they never
 * propagate (teardown must complete)". The DigitalOcean and Linode sweeps
 * built their object-storage store outside any try, so a store module that
 * failed to load escaped the sweep and took the teardown with it. Vultr and
 * Scaleway already wrapped theirs.
 *
 * The two store modules are mocked to fail on import, which is the one way
 * the construction can throw.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/providers/digitalocean-spaces.js', () => {
  throw new Error('spaces module failed to load');
});
vi.mock('../../../src/lib/providers/linode-objectstorage.js', () => {
  throw new Error('object storage module failed to load');
});

import { sweepOrphanedDigitalOceanResources } from '../../e2e/utils/sweep-digitalocean.js';
import { sweepOrphanedLinodeResources } from '../../e2e/utils/sweep-linode.js';

const TAG = '[test]';
const PROJECT = 'testapp-store';

const provider = {
  listServersDetailed: vi.fn().mockResolvedValue({ items: [], complete: true }),
  deleteServer: vi.fn().mockResolvedValue(undefined),
  listVolumesDetailed: vi.fn().mockResolvedValue({ items: [], complete: true }),
  volumeAttachedServerIds: () => [],
  volumeLabels: () => ({}),
  labelValue: (_key: string, value: string) => value,
  deleteVolume: vi.fn().mockResolvedValue(true),
  deleteFirewallByName: vi.fn().mockResolvedValue({ deleted: true }),
  deleteSSHKeyById: vi.fn().mockResolvedValue('deleted' as const),
  deleteSSHKeyByName: vi.fn().mockResolvedValue(true),
  deleteLoadBalancer: vi.fn().mockResolvedValue(true),
};

const emptyApi = (body: Record<string, unknown>) =>
  vi.fn(async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a store that cannot be built does not escape the sweep', () => {
  it('DigitalOcean: the sweep returns, incomplete, and says why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { enumFailed } = await sweepOrphanedDigitalOceanResources(TAG, PROJECT, {
      provider,
      fetchImpl: emptyApi({}),
      spacesKey: 'fake-key',
      spacesSecret: 'fake-secret',
    });
    expect(enumFailed).toBe(true);
    const warned = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('Spaces (store unusable');
    expect(warned).toContain('could not enumerate');
  });

  it('Linode: the sweep returns, incomplete, and says why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { enumFailed } = await sweepOrphanedLinodeResources(TAG, PROJECT, {
      provider,
      fetchImpl: emptyApi({ data: [], page: 1, pages: 1 }),
      token: 'fake-token',
      storageKey: 'fake-key',
      storageSecret: 'fake-secret',
    });
    expect(enumFailed).toBe(true);
    const warned = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('Object Storage (store unusable');
  });
});
