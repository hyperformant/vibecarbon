import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * HetznerProvider.getServerType — the `specs` source for carbon-autoscaler's
 * `buildTemplateNode` (src/autoscaler/node-template.js). Mirrors
 * hetzner-destroy-primitives.test.ts's harness style: a mocked
 * `fetchWithRetry` with FULL request-URL pinning (not `stringContaining`),
 * since a query-string regression here (a dropped `?name=`, wrong param
 * name) would silently make scale-from-zero request the wrong specs.
 */

const fetchWithRetryMock = vi.fn();

vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  };
});

import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

const TOKEN = 'tok-server-type';
const BASE = 'https://api.hetzner.cloud/v1';

type Resp = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

function resp(body: unknown, status = 200): Resp {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/** Records of `fetchWithRetry(url, init)` calls as `[method, url, authHeader]` tuples. */
function calls(): Array<[string, string, string | undefined]> {
  return fetchWithRetryMock.mock.calls.map((c) => [
    ((c[1] as { method?: string })?.method ?? 'GET') as string,
    c[0] as string,
    (c[1] as { headers?: Record<string, string> })?.headers?.Authorization,
  ]);
}

describe('HetznerProvider.getServerType', () => {
  let provider: HetznerProvider;

  beforeEach(() => {
    fetchWithRetryMock.mockReset();
    provider = new HetznerProvider(TOKEN);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GET /server_types?name=<encoded name> with a Bearer auth header', async () => {
    fetchWithRetryMock.mockResolvedValue(
      resp({
        server_types: [{ name: 'cx23', cores: 2, memory: 4, disk: 40, architecture: 'x86' }],
      }),
    );

    await provider.getServerType('cx23');

    expect(calls()).toEqual([['GET', `${BASE}/server_types?name=cx23`, `Bearer ${TOKEN}`]]);
  });

  it('url-encodes the server type name', async () => {
    fetchWithRetryMock.mockResolvedValue(
      resp({ server_types: [{ name: 'a b', cores: 1, memory: 1, disk: 20, architecture: 'x86' }] }),
    );

    await provider.getServerType('a b');

    expect(calls()).toEqual([['GET', `${BASE}/server_types?name=a%20b`, `Bearer ${TOKEN}`]]);
  });

  it('maps the first result to {cores, memoryGb, architecture, disk}', async () => {
    fetchWithRetryMock.mockResolvedValue(
      resp({
        server_types: [
          {
            name: 'cx23',
            cores: 2,
            memory: 4,
            disk: 40,
            architecture: 'x86',
            cpu_type: 'shared',
          },
        ],
      }),
    );

    const result = await provider.getServerType('cx23');

    expect(result).toEqual({ cores: 2, memoryGb: 4, architecture: 'x86', disk: 40 });
  });

  it('throws a descriptive error when no server type matches the name', async () => {
    fetchWithRetryMock.mockResolvedValue(resp({ server_types: [] }));

    await expect(provider.getServerType('does-not-exist')).rejects.toThrow(
      'Server type "does-not-exist" not found',
    );
  });

  it('throws a descriptive error on a non-ok response', async () => {
    fetchWithRetryMock.mockResolvedValue(resp({ error: {} }, 500));

    await expect(provider.getServerType('cx23')).rejects.toThrow(
      'Failed to fetch server type "cx23": 500',
    );
  });

  it('retries via fetchWithRetry (same policy as listServers) rather than a bare fetch', async () => {
    fetchWithRetryMock.mockResolvedValue(
      resp({
        server_types: [{ name: 'cx23', cores: 2, memory: 4, disk: 40, architecture: 'x86' }],
      }),
    );

    await provider.getServerType('cx23');

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
  });
});
