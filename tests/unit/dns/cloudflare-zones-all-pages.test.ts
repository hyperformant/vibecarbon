/**
 * Cloudflare getZones reads every page of zones.
 *
 * It used to send one request with no paging. Cloudflare answers that with
 * the first 20 zones, so on an account with more, the zone of a domain past
 * the first page was never found and deploy reported no zone for the domain.
 * Every other DNS backend already walked its pages.
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

const { getZones } = await import('../../../src/lib/cloudflare-dns.js');

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const zones = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `z${from + i}`, name: `zone${from + i}.com` }));
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

describe('Cloudflare getZones', () => {
  it('follows total_pages and returns the zones of every page', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(200, { success: true, result: zones(0, 50), result_info: { total_pages: 3 } }),
      )
      .mockResolvedValueOnce(
        json(200, { success: true, result: zones(50, 50), result_info: { total_pages: 3 } }),
      )
      .mockResolvedValueOnce(
        json(200, { success: true, result: zones(100, 7), result_info: { total_pages: 3 } }),
      );

    const result = await getZones('tok');

    expect(result).toHaveLength(107);
    expect(result.at(-1)).toEqual({ id: 'z106', name: 'zone106.com' });
    expect(urls()).toEqual([
      'https://api.cloudflare.com/client/v4/zones?per_page=50&page=1',
      'https://api.cloudflare.com/client/v4/zones?per_page=50&page=2',
      'https://api.cloudflare.com/client/v4/zones?per_page=50&page=3',
    ]);
  });

  it('makes one request when the account fits on one page', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, { success: true, result: zones(0, 3), result_info: { total_pages: 1 } }),
    );
    expect(await getZones('tok')).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('without result_info, a full page means another page follows', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { success: true, result: zones(0, 50) }))
      .mockResolvedValueOnce(json(200, { success: true, result: zones(50, 2) }));
    expect(await getZones('tok')).toHaveLength(52);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps its error for a failed page, and never names the token', async () => {
    fetchMock.mockResolvedValueOnce(
      json(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] }),
    );
    const error = await getZones('secret-token').catch((e) => e);
    expect(error.message).toBe(
      'Cloudflare API error: [{"code":10000,"message":"Authentication error"}]',
    );
    expect(error.message).not.toContain('secret-token');
  });

  it('stops with an error instead of reading pages without end', async () => {
    fetchMock.mockImplementation(async () =>
      json(200, { success: true, result: zones(0, 50), result_info: { total_pages: 999 } }),
    );
    await expect(getZones('tok')).rejects.toThrow(/more than 1000 zones/);
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });
});
