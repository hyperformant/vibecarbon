/**
 * Coverage for `verifyToken(apiToken)` in src/lib/cloudflare-dns.js — GET
 * client/v4/user/tokens/verify via fetchWithRetry (the same client the rest
 * of this module's zone/DNS/health-check calls use — see dns-apex-wildcard
 * test's fetch-stub pattern, mirrored here).
 *
 * Semantics MUST mirror hetzner-guided-setup.js's validateHetznerToken
 * (:25-36): 200+success → valid; 401/403 → invalid with the API's message;
 * network failure → valid:true + unreachable:true (proceed+warn, never a
 * hard block on a flaky connection).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('cloudflare verifyToken', () => {
  it('returns valid:true on a 200 + success:true response', async () => {
    fetchMock.mockResolvedValueOnce(ok({ success: true, result: { status: 'active' } }));

    const { verifyToken } = await import('../../../src/lib/cloudflare-dns.js');
    const result = await verifyToken('tok');

    expect(result).toEqual({ valid: true });
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toBe('https://api.cloudflare.com/client/v4/user/tokens/verify');
    expect(call[1].headers.Authorization).toBe('Bearer tok');
  });

  it('returns valid:false with the API error message on 401', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] }, 401),
    );

    const { verifyToken } = await import('../../../src/lib/cloudflare-dns.js');
    const result = await verifyToken('bad-tok');

    expect(result).toEqual({ valid: false, error: 'Invalid API Token' });
  });

  it('returns valid:false with the API error message on 403', async () => {
    fetchMock.mockResolvedValueOnce(
      ok(
        {
          success: false,
          errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }],
        },
        403,
      ),
    );

    const { verifyToken } = await import('../../../src/lib/cloudflare-dns.js');
    const result = await verifyToken('scoped-tok');

    expect(result).toEqual({
      valid: false,
      error: 'Unauthorized to access requested resource',
    });
  });

  it('falls back to a generic message when the error body has no message', async () => {
    fetchMock.mockResolvedValueOnce(ok({ success: false, errors: [] }, 401));

    const { verifyToken } = await import('../../../src/lib/cloudflare-dns.js');
    const result = await verifyToken('bad-tok');

    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns valid:true + unreachable:true when the network call throws', async () => {
    // A non-transient error message (fetchWithRetry treats "fetch
    // failed"/ECONNRESET/etc. as transient and retries with real backoff
    // delays up to ~15s — irrelevant to what this test pins, so a plain
    // "boom" short-circuits fetchWithRetry to a single immediate throw).
    fetchMock.mockRejectedValue(new Error('boom'));

    const { verifyToken } = await import('../../../src/lib/cloudflare-dns.js');
    const result = await verifyToken('tok');

    expect(result).toEqual({ valid: true, unreachable: true });
  });
});
