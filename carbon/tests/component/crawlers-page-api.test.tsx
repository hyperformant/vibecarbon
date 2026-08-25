/**
 * Smoke coverage for the AI Visibility page's data fetcher
 * (src/client/pages/admin/Crawlers.tsx), matching the pattern in
 * admin-pages-api.test.tsx: exercise the extracted fetcher through a stubbed
 * global fetch rather than mounting the page.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: 'tok-abc' } },
      })),
    },
  },
}));

import { ApiError } from '@/lib/api';
import { type CrawlerStatsResponse, fetchCrawlerStats } from '@/pages/admin/Crawlers';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Crawlers fetchCrawlerStats', () => {
  it('requests the windowed endpoint with the bearer token and resolves the body', async () => {
    const payload: CrawlerStatsResponse = {
      windowDays: 30,
      totals: [{ crawler: 'GPTBot', operator: 'OpenAI', category: 'ai-training', hits: 12 }],
      daily: [
        { day: '2026-08-24', hits: 12, byCategory: { 'ai-training': 12, 'ai-search': 0, search: 0 } },
      ],
      topPaths: [{ path: '/docs/seo', hits: 7, crawlers: ['GPTBot'] }],
    };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));

    await expect(fetchCrawlerStats()).resolves.toEqual(payload);

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/v1/admin/crawlers?days=30');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-abc');
  });

  it('threads an explicit window through the days query parameter', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ windowDays: 7, totals: [], daily: [], topPaths: [] }), {
        status: 200,
      })
    );

    await fetchCrawlerStats(7);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/admin/crawlers?days=7');
  });

  it('throws an ApiError carrying the status when the admin check rejects', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
    );

    const err = await fetchCrawlerStats().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('Forbidden');
    expect(err.status).toBe(403);
  });

  it('falls back to the page message when the error body carries no error field', async () => {
    // Same convention as the sibling admin fetchers in admin-pages-api.test.tsx:
    // a non-JSON 500 must still surface a human-readable message, not "[object
    // Object]" or an empty toast.
    fetchMock.mockResolvedValueOnce(new Response('<html>502</html>', { status: 500 }));

    const err = await fetchCrawlerStats().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('Failed to fetch crawler activity');
    expect(err.status).toBe(500);
  });
});
