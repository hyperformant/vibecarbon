import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// C8 — getServerSummary is a verbatim move of status.js's old getServerInfo:
// the `status` command's hot read-only probe. It MUST stay a single raw
// `fetch` with a hard 5000ms abort and null-on-any-failure semantics — no
// retry (retrying a probe that fires on every `status` invocation would
// multiply its worst-case latency for zero benefit). Mock fetch-retry.js so
// we can assert it's never touched, independent of the real global `fetch`
// spy used to pin the actual request shape.
const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', () => ({
  fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
}));

import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

describe('HetznerProvider.getServerSummary', () => {
  let provider: HetznerProvider;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let timeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    provider = new HetznerProvider('test-api-token');
    fetchSpy = vi.spyOn(global, 'fetch');
    timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    fetchWithRetryMock.mockClear();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    timeoutSpy.mockRestore();
  });

  it('makes exactly one raw fetch with a 5000ms AbortSignal, never touching fetchWithRetry', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ server: { status: 'running', server_type: { name: 'cpx11' } } }),
    } as Response);

    const result = await provider.getServerSummary(12345);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.hetzner.cloud/v1/servers/12345',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-api-token' },
      }),
    );
    expect(timeoutSpy).toHaveBeenCalledWith(5000);
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'running', serverType: 'cpx11' });
  });

  it('returns null when the response is not ok (no retry)', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 404 } as Response);

    const result = await provider.getServerSummary(999);

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
  });

  it('returns null when fetch throws (network error)', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('fetch failed'));

    const result = await provider.getServerSummary(999);

    expect(result).toBeNull();
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
  });

  it('returns null when the fetch is aborted (timeout)', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    fetchSpy.mockRejectedValueOnce(abortError);

    const result = await provider.getServerSummary(999);

    expect(result).toBeNull();
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
  });

  it('resolves serverType to null when server_type is absent from the response', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ server: { status: 'off' } }),
    } as Response);

    const result = await provider.getServerSummary(1);

    expect(result).toEqual({ status: 'off', serverType: null });
  });
});
