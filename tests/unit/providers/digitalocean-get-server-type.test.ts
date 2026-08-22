import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DigitalOceanProvider.getServerType — the `specs` source for
 * carbon-autoscaler's `buildTemplateNode` (src/autoscaler/node-template.js),
 * once the DO k8s tier lands (M3 Task 6). Mirrors
 * hetzner-get-server-type.test.ts's harness style: a mocked `fetchWithRetry`
 * with FULL request-URL pinning (not `stringContaining`), since a
 * query-string regression here would silently make scale-from-zero request
 * the wrong specs.
 *
 * Unlike Hetzner's `GET /server_types?name=<name>` (server-side exact-name
 * filter), DO's `GET /v2/sizes` has no name-filter query param — this walks
 * the paginated list and matches by `slug` client-side (see
 * digitalocean.js's getServerType doc).
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

const TOKEN = 'tok-do-server-type';
const BASE = 'https://api.digitalocean.com/v2';

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

describe('DigitalOceanProvider.getServerType', () => {
  let provider: DigitalOceanProvider;

  beforeEach(() => {
    fetchWithRetryMock.mockReset();
    provider = new DigitalOceanProvider(TOKEN);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GET /sizes?per_page=200&page=1 with a Bearer auth header', async () => {
    fetchWithRetryMock.mockResolvedValue(
      resp({
        sizes: [{ slug: 's-2vcpu-4gb', vcpus: 2, memory: 4096, disk: 80, available: true }],
      }),
    );

    await provider.getServerType('s-2vcpu-4gb');

    expect(calls()).toEqual([['GET', `${BASE}/sizes?per_page=200&page=1`, `Bearer ${TOKEN}`]]);
  });

  it('maps the matching slug to {cores, memoryGb, architecture, disk}', async () => {
    fetchWithRetryMock.mockResolvedValue(
      resp({
        sizes: [
          { slug: 's-4vcpu-8gb', vcpus: 4, memory: 8192, disk: 160, available: true },
          { slug: 's-2vcpu-4gb', vcpus: 2, memory: 4096, disk: 80, available: true },
        ],
      }),
    );

    const result = await provider.getServerType('s-2vcpu-4gb');

    expect(result).toEqual({ cores: 2, memoryGb: 4, architecture: 'x86', disk: 80 });
  });

  it('throws a descriptive error when no size matches the slug', async () => {
    fetchWithRetryMock.mockResolvedValue(resp({ sizes: [] }));

    await expect(provider.getServerType('does-not-exist')).rejects.toThrow(
      'Server type "does-not-exist" not found',
    );
  });

  it('treats a slug flagged available:false as not found (never sizes a CA worker off a retired slug)', async () => {
    fetchWithRetryMock.mockResolvedValue(
      resp({
        sizes: [{ slug: 's-2vcpu-4gb', vcpus: 2, memory: 4096, disk: 80, available: false }],
      }),
    );

    await expect(provider.getServerType('s-2vcpu-4gb')).rejects.toThrow(
      'Server type "s-2vcpu-4gb" not found',
    );
  });

  it('throws a descriptive error on a non-ok response', async () => {
    fetchWithRetryMock.mockResolvedValue(resp({ id: 'server_error', message: 'boom' }, 500));

    await expect(provider.getServerType('s-2vcpu-4gb')).rejects.toThrow(
      'Failed to fetch server type "s-2vcpu-4gb": 500',
    );
  });

  it('walks pagination (links.pages.next) when the match is on a later page', async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(
        resp({
          sizes: [{ slug: 's-4vcpu-8gb', vcpus: 4, memory: 8192, disk: 160, available: true }],
          links: { pages: { next: 'x' } },
        }),
      )
      .mockResolvedValueOnce(
        resp({
          sizes: [{ slug: 's-2vcpu-4gb', vcpus: 2, memory: 4096, disk: 80, available: true }],
        }),
      );

    const result = await provider.getServerType('s-2vcpu-4gb');

    expect(calls()).toEqual([
      ['GET', `${BASE}/sizes?per_page=200&page=1`, `Bearer ${TOKEN}`],
      ['GET', `${BASE}/sizes?per_page=200&page=2`, `Bearer ${TOKEN}`],
    ]);
    expect(result).toEqual({ cores: 2, memoryGb: 4, architecture: 'x86', disk: 80 });
  });

  it('retries via fetchWithRetry (same policy as listServers) rather than a bare fetch', async () => {
    fetchWithRetryMock.mockResolvedValue(
      resp({
        sizes: [{ slug: 's-2vcpu-4gb', vcpus: 2, memory: 4096, disk: 80, available: true }],
      }),
    );

    await provider.getServerType('s-2vcpu-4gb');

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
  });
});
