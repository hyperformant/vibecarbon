import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Retry lines must route through progressLog (spinner-safe) rather than raw
// console.error, so they update an active spinner instead of shredding it.
const progressLog = vi.fn();
vi.mock('../../../src/lib/cli/progress.js', () => ({
  progressLog: (msg: string) => progressLog(msg),
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}));

import { fetchWithRetry } from '../../../src/lib/fetch-retry.js';

describe('fetchWithRetry', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    progressLog.mockClear();
  });

  function mockFetch(responses: Array<Response | Error>): ReturnType<typeof vi.fn> {
    const fn = vi.fn();
    for (const r of responses) {
      if (r instanceof Error) fn.mockImplementationOnce(() => Promise.reject(r));
      else fn.mockImplementationOnce(() => Promise.resolve(r));
    }
    globalThis.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  it('returns immediately on a 2xx response', async () => {
    const fn = mockFetch([new Response('ok', { status: 200 })]);
    const result = await fetchWithRetry('https://example.com');
    expect(result.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient network error (fetch failed), then succeeds', async () => {
    const fn = mockFetch([
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }),
      new Response('ok', { status: 200 }),
    ]);
    const p = fetchWithRetry('https://example.com');
    await vi.advanceTimersByTimeAsync(1500);
    const result = await p;
    expect(result.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on HTTP 504', async () => {
    const fn = mockFetch([
      new Response('bad gateway', { status: 504 }),
      new Response('ok', { status: 200 }),
    ]);
    const p = fetchWithRetry('https://example.com');
    await vi.advanceTimersByTimeAsync(1500);
    const result = await p;
    expect(result.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 400', async () => {
    const fn = mockFetch([new Response('bad request', { status: 400 })]);
    const result = await fetchWithRetry('https://example.com');
    expect(result.status).toBe(400);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after max attempts on persistent fetch failed', async () => {
    const err = new TypeError('fetch failed');
    const fn = mockFetch([err, err, err, err, err]);
    const p = fetchWithRetry('https://example.com', { maxAttempts: 5 }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await p;
    expect(result).toBeInstanceOf(TypeError);
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('throws immediately on non-transient error', async () => {
    const fn = mockFetch([new TypeError('user aborted')]);
    await expect(fetchWithRetry('https://example.com')).rejects.toThrow('user aborted');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('routes the retry line through progressLog (spinner-safe), not console.error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch([
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }),
      new Response('ok', { status: 200 }),
    ]);
    const p = fetchWithRetry('https://example.com', { label: 'hetzner-dns' });
    await vi.advanceTimersByTimeAsync(1500);
    await p;
    expect(progressLog).toHaveBeenCalledTimes(1);
    expect(progressLog).toHaveBeenCalledWith(
      expect.stringContaining('[retry] hetzner-dns: attempt 1/5 failed'),
    );
    expect(err).not.toHaveBeenCalled();
  });
});
