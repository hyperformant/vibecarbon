import { describe, expect, it, vi } from 'vitest';
import { detectOperatorIp } from '../../../src/lib/operator-ip.js';

function makeFetcher(responses: Array<Response | Error>) {
  const fn = vi.fn();
  for (const r of responses) {
    if (r instanceof Error) fn.mockImplementationOnce(() => Promise.reject(r));
    else fn.mockImplementationOnce(() => Promise.resolve(r));
  }
  return fn;
}

describe('detectOperatorIp', () => {
  it('returns IPv4 from the primary detector when it responds 200', async () => {
    const fetcher = makeFetcher([new Response('1.2.3.4')]);
    const result = await detectOperatorIp({ fetcher });
    expect(result).toEqual({ ip: '1.2.3.4', version: 4 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://api.ipify.org');
  });

  it('returns IPv6 when the response contains a colon', async () => {
    const fetcher = makeFetcher([new Response('2001:db8::1')]);
    const result = await detectOperatorIp({ fetcher });
    expect(result).toEqual({ ip: '2001:db8::1', version: 6 });
  });

  it('trims whitespace/newlines from the response body', async () => {
    const fetcher = makeFetcher([new Response('  1.2.3.4\n')]);
    const result = await detectOperatorIp({ fetcher });
    expect(result.ip).toBe('1.2.3.4');
  });

  it('falls back to the secondary detector when primary returns non-200', async () => {
    const fetcher = makeFetcher([
      new Response('upstream broken', { status: 503 }),
      new Response('5.6.7.8'),
    ]);
    const result = await detectOperatorIp({ fetcher });
    expect(result.ip).toBe('5.6.7.8');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0]).toBe('https://icanhazip.com');
  });

  it('falls back to the secondary detector when primary throws', async () => {
    const fetcher = makeFetcher([new Error('fetch failed'), new Response('9.10.11.12')]);
    const result = await detectOperatorIp({ fetcher });
    expect(result.ip).toBe('9.10.11.12');
  });

  it('falls back when primary returns an invalid IP body', async () => {
    const fetcher = makeFetcher([
      new Response('<html>Bad Gateway</html>'),
      new Response('1.2.3.4'),
    ]);
    const result = await detectOperatorIp({ fetcher });
    expect(result.ip).toBe('1.2.3.4');
  });

  it('throws a clear error when both detectors fail', async () => {
    const fetcher = makeFetcher([new Error('fetch failed'), new Error('fetch failed')]);
    await expect(detectOperatorIp({ fetcher })).rejects.toThrow(/Unable to detect operator IP/);
  });

  it('rejects an out-of-range IPv4 octet from a malicious detector', async () => {
    const fetcher = makeFetcher([new Response('1.2.3.999'), new Response('1.2.3.4')]);
    const result = await detectOperatorIp({ fetcher });
    expect(result.ip).toBe('1.2.3.4');
  });
});
