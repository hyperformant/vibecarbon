import { describe, expect, it, vi } from 'vitest';

/**
 * Linode createSSHKey material-dedupe (2026-08-08, first full l1 lifecycle
 * RCA — the teardown sweep's REGRESSION banner caught a leaked profile SSH
 * key). DigitalOcean dedupes SSH keys by MATERIAL account-wide, so the
 * scale path's key registration silently resolves to the deploy's existing
 * key there; Linode imposes no such uniqueness and happily creates a
 * second key with identical material under the scale path's name — which
 * destroy then never derives, leaving an orphan every scaled deploy.
 * Linode's createSSHKey therefore dedupes PROACTIVELY: same material (type
 * + base64 body, comment/whitespace ignored) → return the existing key's
 * id without POSTing.
 */

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  };
});

import { LinodeProvider } from '../../../src/lib/providers/linode.js';

const MATERIAL = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyBody';

describe('LinodeProvider.createSSHKey material dedupe', () => {
  it('returns the existing key id (no POST) when the material is already registered under any label', async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        throw new Error('should not POST — material already registered');
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: 41, label: 'deploy-key', ssh_key: `${MATERIAL} root@deploy` }],
          page: 1,
          pages: 1,
        }),
      };
    });

    const provider = new LinodeProvider('tok');
    const id = await provider.createSSHKey('scale-key', `${MATERIAL}\n`);
    expect(id).toBe(41);
  });

  it('POSTs a new key when no existing key carries the material', async () => {
    const calls: string[] = [];
    fetchWithRetryMock.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (init?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ id: 99, label: 'scale-key' }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: 41, label: 'deploy-key', ssh_key: 'ssh-ed25519 SomethingElse' }],
          page: 1,
          pages: 1,
        }),
      };
    });

    const provider = new LinodeProvider('tok');
    const id = await provider.createSSHKey('scale-key', MATERIAL);
    expect(id).toBe(99);
    expect(calls.some((c) => c.startsWith('POST'))).toBe(true);
  });
});
