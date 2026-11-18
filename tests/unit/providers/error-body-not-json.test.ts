import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A refused request whose body is not JSON (an HTML error page from a proxy,
 * an empty body) still fails with the provider's own message. These error
 * paths used to call `await response.json()` bare, so such a body raised a
 * SyntaxError ("Unexpected token <") in place of "Failed to delete server"
 * and its siblings. Linode, Vultr and Scaleway already read the body with
 * `.catch(() => ({}))`; these are the Hetzner and DigitalOcean paths that
 * did not.
 */

const fetchWithRetryMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  };
});

import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

/** A 403 whose body is an HTML page: json() rejects the way Response's does. */
function htmlRefusal(status = 403) {
  return {
    ok: false,
    status,
    json: async () => JSON.parse('<html>Forbidden</html>'),
    text: async () => '<html>Forbidden</html>',
  };
}

function ok(body: unknown, status = 200) {
  return { ok: true, status, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
  fetchWithRetryMock.mockReset();
  fetchMock.mockReset();
  // The destroy-mode poll's raw fetch: never reached, since a refusal throws
  // first, but never the network either.
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Hetzner error paths read a non-JSON body as an unknown error', () => {
  it('deleteServer (scale mode) says it failed to delete the server', async () => {
    fetchWithRetryMock.mockResolvedValue(htmlRefusal());
    await expect(new HetznerProvider('tok').deleteServer(7)).rejects.toThrow(
      'Failed to delete server: Unknown error',
    );
  });

  it('deleteServer (destroy mode, waitUntilGone) says it failed to delete the server', async () => {
    fetchWithRetryMock.mockResolvedValue(htmlRefusal());
    await expect(
      new HetznerProvider('tok').deleteServer(7, { waitUntilGone: true }),
    ).rejects.toThrow('Failed to delete server: Unknown error');
  });

  it('createSSHKey says it failed to create the key', async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: { method?: string }) =>
      init?.method === 'POST' ? htmlRefusal() : ok({ ssh_keys: [], meta: {} }),
    );
    await expect(
      new HetznerProvider('tok').createSSHKey('k', 'ssh-ed25519 AAAA test'),
    ).rejects.toThrow('Failed to create SSH key: Unknown error');
  });
});

describe('DigitalOcean error paths read a non-JSON body as an unknown error', () => {
  it('deleteServer (scale mode) says it failed to delete the server', async () => {
    fetchWithRetryMock.mockResolvedValue(htmlRefusal());
    await expect(new DigitalOceanProvider('tok').deleteServer(7)).rejects.toThrow(
      'Failed to delete server: Unknown error',
    );
  });

  it('deleteServer (destroy mode, waitUntilGone) says it failed to delete the server', async () => {
    fetchWithRetryMock.mockResolvedValue(htmlRefusal());
    await expect(
      new DigitalOceanProvider('tok').deleteServer(7, { waitUntilGone: true }),
    ).rejects.toThrow('Failed to delete server: Unknown error');
  });

  it('renameServer says it failed to rename the server', async () => {
    fetchWithRetryMock.mockResolvedValue(htmlRefusal());
    await expect(new DigitalOceanProvider('tok').renameServer(7, 'web')).rejects.toThrow(
      'Failed to rename server: Unknown error',
    );
  });

  it('createSSHKey says it failed to create the key', async () => {
    fetchWithRetryMock.mockResolvedValue(htmlRefusal(400));
    await expect(
      new DigitalOceanProvider('tok').createSSHKey('k', 'ssh-ed25519 AAAA test'),
    ).rejects.toThrow('Failed to create SSH key: Unknown error');
  });
});
