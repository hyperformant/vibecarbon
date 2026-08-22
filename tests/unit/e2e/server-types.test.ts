import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchServerTypes } from '../../e2e/utils/server-types.js';

/**
 * Regression coverage for the verify-scale type-snapshot capture (M3 Task
 * 9e): it used to be a `_run-lifecycle.ts`-local closure that queried the
 * Hetzner API unconditionally, so a DigitalOcean scenario's droplets (never
 * in the Hetzner account) always snapshotted `{}` — silently disabling
 * verify-scale's strong type-change assertion. Extracted here so both
 * providers' capture + retry/pagination logic are independently testable
 * with a mocked `fetch` (same rationale as `ssh-registry-mirror.test.ts`'s
 * `extractRegistryMirrorAddress` extraction).
 */

type StubResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

function jsonResponse(status: number, body: unknown): StubResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('fetchServerTypes', () => {
  it('returns {} without calling fetch when ips is empty', async () => {
    const fetchFn = vi.fn();
    const result = await fetchServerTypes([], 'tok', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toEqual({});
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns {} without calling fetch when the token is empty', async () => {
    const fetchFn = vi.fn();
    const result = await fetchServerTypes(['1.2.3.4'], '', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toEqual({});
    expect(fetchFn).not.toHaveBeenCalled();
  });

  describe('hetzner (default provider)', () => {
    it('queries the Hetzner servers endpoint with Bearer auth and indexes by ip', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse(200, {
          servers: [
            { public_net: { ipv4: { ip: '1.2.3.4' } }, server_type: { name: 'cx23' } },
            { public_net: { ipv4: { ip: '5.6.7.8' } }, server_type: { name: 'cx33' } },
            // Not in the requested ips list — must be excluded from the result.
            { public_net: { ipv4: { ip: '9.9.9.9' } }, server_type: { name: 'cx11' } },
          ],
        }),
      );

      const result = await fetchServerTypes(['1.2.3.4', '5.6.7.8'], 'my-token', {
        fetchFn: fetchFn as unknown as typeof fetch,
      });

      expect(result).toEqual({ '1.2.3.4': 'cx23', '5.6.7.8': 'cx33' });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      // per_page=50 is the Cloud API's documented max (OpenAPI spec: "The
      // default value is 25, the maximum value is 50 except otherwise
      // specified"; the pre-2026-07-30 per_page=100 was out of contract);
      // the explicit page param is the pagination walk's first step.
      expect(url).toBe('https://api.hetzner.cloud/v1/servers?per_page=50&page=1');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer my-token');
    });

    it('walks pagination via meta.pagination.next_page and merges results across pages', async () => {
      // Truncated-listing guard (2026-07-30 failure class): a server that
      // lives on page 2 must still be snapshotted — the old single-GET path
      // made it unmatchable and silently degraded verify-scale to its weaker
      // stdout-grep fallback.
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(200, {
            servers: [{ public_net: { ipv4: { ip: '1.2.3.4' } }, server_type: { name: 'cx23' } }],
            meta: { pagination: { next_page: 2 } },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, {
            servers: [{ public_net: { ipv4: { ip: '5.6.7.8' } }, server_type: { name: 'cx33' } }],
            meta: { pagination: { next_page: null } },
          }),
        );

      const result = await fetchServerTypes(['1.2.3.4', '5.6.7.8'], 'tok', {
        fetchFn: fetchFn as unknown as typeof fetch,
      });

      expect(result).toEqual({ '1.2.3.4': 'cx23', '5.6.7.8': 'cx33' });
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(fetchFn.mock.calls[0][0]).toBe(
        'https://api.hetzner.cloud/v1/servers?per_page=50&page=1',
      );
      expect(fetchFn.mock.calls[1][0]).toBe(
        'https://api.hetzner.cloud/v1/servers?per_page=50&page=2',
      );
    });

    it('degrades to {} when a later page returns a non-ok response, without retrying', async () => {
      // A partial snapshot must never feed verify-scale a misleadingly-partial
      // "types changed" assertion — same contract as the DigitalOcean sibling.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(200, {
            servers: [{ public_net: { ipv4: { ip: '1.2.3.4' } }, server_type: { name: 'cx23' } }],
            meta: { pagination: { next_page: 2 } },
          }),
        )
        .mockResolvedValueOnce(jsonResponse(500, {}));

      const result = await fetchServerTypes(['1.2.3.4'], 'tok', {
        fetchFn: fetchFn as unknown as typeof fetch,
      });

      expect(result).toEqual({});
      expect(fetchFn).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });

    it('degrades to {} on a non-ok response, without retrying', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse(503, {}));

      const result = await fetchServerTypes(['1.2.3.4'], 'tok', {
        fetchFn: fetchFn as unknown as typeof fetch,
      });

      expect(result).toEqual({});
      expect(fetchFn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });
  });

  describe('digitalocean', () => {
    it('queries the DO droplets endpoint with Bearer auth and indexes public ipv4 by size_slug', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse(200, {
          droplets: [
            {
              networks: {
                v4: [
                  { type: 'private', ip_address: '10.0.0.5' },
                  { type: 'public', ip_address: '203.0.113.10' },
                ],
              },
              size_slug: 's-2vcpu-4gb',
            },
            {
              // Not in the requested ips list — must be excluded from the result.
              networks: { v4: [{ type: 'public', ip_address: '203.0.113.99' }] },
              size_slug: 's-1vcpu-2gb',
            },
          ],
          links: {},
        }),
      );

      const result = await fetchServerTypes(['203.0.113.10'], 'do-token', {
        provider: 'digitalocean',
        fetchFn: fetchFn as unknown as typeof fetch,
      });

      expect(result).toEqual({ '203.0.113.10': 's-2vcpu-4gb' });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.digitalocean.com/v2/droplets?per_page=50&page=1');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer do-token');
    });

    it('walks pagination via links.pages.next and merges results across pages', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(200, {
            droplets: [
              { networks: { v4: [{ type: 'public', ip_address: '203.0.113.1' }] }, size_slug: 'a' },
            ],
            links: {
              pages: { next: 'https://api.digitalocean.com/v2/droplets?per_page=50&page=2' },
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, {
            droplets: [
              { networks: { v4: [{ type: 'public', ip_address: '203.0.113.2' }] }, size_slug: 'b' },
            ],
            links: {},
          }),
        );

      const result = await fetchServerTypes(['203.0.113.1', '203.0.113.2'], 'do-token', {
        provider: 'digitalocean',
        fetchFn: fetchFn as unknown as typeof fetch,
      });

      expect(result).toEqual({ '203.0.113.1': 'a', '203.0.113.2': 'b' });
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(fetchFn.mock.calls[0][0]).toBe(
        'https://api.digitalocean.com/v2/droplets?per_page=50&page=1',
      );
      expect(fetchFn.mock.calls[1][0]).toBe(
        'https://api.digitalocean.com/v2/droplets?per_page=50&page=2',
      );
    });

    it('degrades to {} when a later page returns a non-ok response, without retrying', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(200, {
            droplets: [
              { networks: { v4: [{ type: 'public', ip_address: '203.0.113.1' }] }, size_slug: 'a' },
            ],
            links: {
              pages: { next: 'https://api.digitalocean.com/v2/droplets?per_page=50&page=2' },
            },
          }),
        )
        .mockResolvedValueOnce(jsonResponse(500, {}));

      const result = await fetchServerTypes(['203.0.113.1'], 'do-token', {
        provider: 'digitalocean',
        fetchFn: fetchFn as unknown as typeof fetch,
      });

      expect(result).toEqual({});
      expect(fetchFn).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });
  });

  describe('transient-error retry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries on a thrown network error and succeeds on a later attempt', async () => {
      const fetchFn = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(
          jsonResponse(200, {
            servers: [{ public_net: { ipv4: { ip: '1.2.3.4' } }, server_type: { name: 'cx23' } }],
          }),
        );

      const resultPromise = fetchServerTypes(['1.2.3.4'], 'tok', {
        fetchFn: fetchFn as unknown as typeof fetch,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;

      expect(result).toEqual({ '1.2.3.4': 'cx23' });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('degrades to {} after exhausting all 6 attempts on persistent network errors', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchFn = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

      const resultPromise = fetchServerTypes(['1.2.3.4'], 'tok', {
        fetchFn: fetchFn as unknown as typeof fetch,
      });
      // Worst-case backoff sum is 1+2+4+8+16=31s; advance well past it.
      await vi.advanceTimersByTimeAsync(40_000);
      const result = await resultPromise;

      expect(result).toEqual({});
      expect(fetchFn).toHaveBeenCalledTimes(6);
      warn.mockRestore();
    });
  });
});
