/**
 * Integration coverage for GET /api/v1/admin/crawlers (AI Visibility).
 *
 * Follows the admin-newsletter.test.ts pattern: mount the real route behind a
 * middleware that injects the session user, mock Supabase at the module
 * boundary, and drive it through `app.request()`.
 *
 * What matters here is the response *contract* the admin page renders from —
 * the raw + rollup union, the zero-filled daily series, the sort orders and the
 * `?days` clamp — plus the two guards (401 / 403).
 */

import type { User } from '@supabase/supabase-js';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HonoVariables } from '@server/types';

const { rawMock, dailyMock } = vi.hoisted(() => ({
  rawMock: vi.fn(),
  dailyMock: vi.fn(),
}));

// crawler_hits:       .select().gte().order().limit()
// crawler_hits_daily: .select().gte().lt().order().limit()
// Both branches are row-capped (MAX_RAW_ROWS / MAX_ROLLUP_ROWS) so a wide
// window can never pull an unbounded result set into the API process.
vi.mock('@server/lib/supabase', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'crawler_hits') {
        return { select: () => ({ gte: () => ({ order: () => ({ limit: rawMock }) }) }) };
      }
      if (table === 'crawler_hits_daily') {
        return {
          select: () => ({ gte: () => ({ lt: () => ({ order: () => ({ limit: dailyMock }) }) }) }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  },
}));

vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { crawlerRoutes } = await import('@server/routes/v1/admin/crawlers');

const BASE = '/api/v1/admin/crawlers';

/** Frozen clock, so the day keys the route derives are assertable constants. */
const NOW = Date.parse('2026-08-24T12:34:56.000Z');
const TODAY = '2026-08-24';
/** Oldest day of the default 30-day window (today minus 29). */
const OLDEST_DEFAULT_DAY = '2026-07-26';
/** Inside the window but older than RAW_WINDOW_DAYS — served by the rollup. */
const ROLLUP_DAY = '2026-08-01';

interface CrawlerStatsBody {
  windowDays: number;
  totals: Array<{ crawler: string; operator: string; category: string; hits: number }>;
  daily: Array<{ day: string; hits: number; byCategory: Record<string, number> }>;
  topPaths: Array<{ path: string; hits: number; crawlers: string[] }>;
}

const SUPER_ADMIN: Partial<User> = { id: 'admin-1', app_metadata: { role: 'super_admin' } };

function appWithUser(user: Partial<User> | null) {
  const app = new Hono<{ Variables: HonoVariables }>();
  app.use('*', async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal injected user
    c.set('user', (user as any) ?? null);
    await next();
  });
  app.route(BASE, crawlerRoutes);
  return app;
}

async function getStats(query = '', user: Partial<User> | null = SUPER_ADMIN) {
  const res = await appWithUser(user).request(`${BASE}${query}`);
  return { res, body: (await res.json()) as CrawlerStatsBody };
}

/** A raw hit row as PostgREST returns it. */
function rawHit(crawler: string, path: string, day = TODAY) {
  return { crawler, path, hit_at: `${day}T09:00:00.000Z` };
}

beforeEach(() => {
  vi.setSystemTime(NOW);
  rawMock.mockReset();
  dailyMock.mockReset();
  rawMock.mockResolvedValue({ data: [], error: null });
  dailyMock.mockResolvedValue({ data: [], error: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/v1/admin/crawlers — access control', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await appWithUser(null).request(BASE);
    expect(res.status).toBe(401);
    expect(rawMock).not.toHaveBeenCalled();
  });

  it('returns 403 for a signed-in non-super-admin', async () => {
    const res = await appWithUser({ id: 'u1', app_metadata: { role: 'authenticated' } }).request(
      BASE
    );
    expect(res.status).toBe(403);
    // The guard runs before any query — no data leaks to a plain user.
    expect(rawMock).not.toHaveBeenCalled();
  });

  it('returns 403 for a plain admin (super_admin only)', async () => {
    const res = await appWithUser({ id: 'u2', app_metadata: { role: 'admin' } }).request(BASE);
    expect(res.status).toBe(403);
  });

  it('returns 200 for a super_admin', async () => {
    const res = await appWithUser(SUPER_ADMIN).request(BASE);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/v1/admin/crawlers — response contract', () => {
  beforeEach(() => {
    rawMock.mockResolvedValue({
      data: [
        rawHit('GPTBot', '/docs/seo'),
        rawHit('GPTBot', '/docs/seo'),
        rawHit('GPTBot', '/docs/seo'),
        rawHit('ClaudeBot', '/'),
        rawHit('Googlebot', '/docs/cli'),
        // Written by an older deploy whose registry entry has since been
        // renamed/removed — the response has no shape for it, so it is dropped.
        rawHit('RetiredBot', '/ghost'),
      ],
      error: null,
    });
    dailyMock.mockResolvedValue({
      data: [
        { day: ROLLUP_DAY, crawler: 'GPTBot', path: '/docs/seo', hits: 10 },
        { day: ROLLUP_DAY, crawler: 'Bingbot', path: '/', hits: 2 },
        // Zero-hit and unregistered rollup rows are both skipped.
        { day: ROLLUP_DAY, crawler: 'CCBot', path: '/quiet', hits: 0 },
        { day: ROLLUP_DAY, crawler: 'RetiredBot', path: '/ghost', hits: 99 },
      ],
      error: null,
    });
  });

  it('unions raw hits with the daily rollup into per-crawler totals, sorted desc', async () => {
    const { res, body } = await getStats();
    expect(res.status).toBe(200);
    expect(body.windowDays).toBe(30);

    expect(body.totals).toEqual([
      { crawler: 'GPTBot', operator: 'OpenAI', category: 'ai-training', hits: 13 },
      { crawler: 'Bingbot', operator: 'Microsoft', category: 'search', hits: 2 },
      // Equal hits fall back to name order.
      { crawler: 'ClaudeBot', operator: 'Anthropic', category: 'ai-training', hits: 1 },
      { crawler: 'Googlebot', operator: 'Google', category: 'search', hits: 1 },
    ]);
  });

  it('skips rows whose crawler is not in the registry', async () => {
    const { body } = await getStats();
    expect(body.totals.map((t) => t.crawler)).not.toContain('RetiredBot');
    expect(body.topPaths.map((p) => p.path)).not.toContain('/ghost');
    // ...and the dropped hits are not silently folded into the daily totals.
    const dailySum = body.daily.reduce((sum, d) => sum + d.hits, 0);
    expect(dailySum).toBe(17);
  });

  it('returns a zero-filled daily series of exactly windowDays entries, oldest first', async () => {
    const { body } = await getStats();

    expect(body.daily).toHaveLength(30);
    expect(body.daily[0].day).toBe(OLDEST_DEFAULT_DAY);
    expect(body.daily[29].day).toBe(TODAY);
    // Strictly ascending, one calendar day apart, no gaps.
    const days = body.daily.map((d) => d.day);
    expect([...days].sort()).toEqual(days);

    // A day with no traffic is present with explicit zeros (the chart must not
    // have to guess at holes).
    expect(body.daily[0]).toEqual({
      day: OLDEST_DEFAULT_DAY,
      hits: 0,
      byCategory: { 'ai-training': 0, 'ai-search': 0, search: 0 },
    });
  });

  it('buckets hits into the right day and category', async () => {
    const { body } = await getStats();

    const rollupDay = body.daily.find((d) => d.day === ROLLUP_DAY);
    expect(rollupDay).toEqual({
      day: ROLLUP_DAY,
      hits: 12,
      byCategory: { 'ai-training': 10, 'ai-search': 0, search: 2 },
    });

    const today = body.daily.find((d) => d.day === TODAY);
    expect(today).toEqual({
      day: TODAY,
      hits: 5,
      byCategory: { 'ai-training': 4, 'ai-search': 0, search: 1 },
    });
  });

  it('ranks topPaths by hits with the contributing crawlers sorted', async () => {
    const { body } = await getStats();

    expect(body.topPaths).toEqual([
      { path: '/docs/seo', hits: 13, crawlers: ['GPTBot'] },
      { path: '/', hits: 3, crawlers: ['Bingbot', 'ClaudeBot'] },
      { path: '/docs/cli', hits: 1, crawlers: ['Googlebot'] },
    ]);
  });
});

describe('GET /api/v1/admin/crawlers — topPaths cap', () => {
  it('returns at most 10 paths, keeping the busiest', async () => {
    // 12 distinct paths, descending popularity: /p-00 (12 hits) … /p-11 (1 hit).
    const data = [];
    for (let i = 0; i < 12; i++) {
      const path = `/p-${String(i).padStart(2, '0')}`;
      for (let n = 0; n < 12 - i; n++) data.push(rawHit('GPTBot', path));
    }
    rawMock.mockResolvedValue({ data, error: null });

    const { body } = await getStats();

    expect(body.topPaths).toHaveLength(10);
    expect(body.topPaths[0]).toEqual({ path: '/p-00', hits: 12, crawlers: ['GPTBot'] });
    expect(body.topPaths[9].path).toBe('/p-09');
    // The two least-visited paths are cut, not merged in.
    expect(body.topPaths.map((p) => p.path)).not.toContain('/p-10');
    // Totals still count every hit, cap or no cap.
    expect(body.totals[0].hits).toBe(78);
  });
});

describe('GET /api/v1/admin/crawlers — ?days clamping', () => {
  const cases: Array<[string, number, string]> = [
    ['', 30, 'no parameter falls back to the default window'],
    ['?days=30', 30, 'the default, stated explicitly'],
    ['?days=1', 1, 'the minimum'],
    ['?days=0', 1, 'below the minimum clamps up to 1'],
    ['?days=-5', 1, 'a negative clamps up to 1'],
    ['?days=365', 365, 'the maximum'],
    ['?days=9999', 365, 'above the maximum clamps down to 365'],
    ['?days=abc', 30, 'an unparseable value falls back to the default'],
    ['?days=', 30, 'an empty value falls back to the default'],
    ['?days=7.9', 7, 'a float is parsed as an integer'],
  ];

  for (const [query, expected, why] of cases) {
    it(`${query || '(no query)'} → windowDays ${expected} (${why})`, async () => {
      const { res, body } = await getStats(query);
      expect(res.status).toBe(200);
      expect(body.windowDays).toBe(expected);
      // windowDays and the series length are the same number, always.
      expect(body.daily).toHaveLength(expected);
    });
  }

  it('skips the rollup query entirely for a window inside the raw window', async () => {
    await getStats('?days=7');
    expect(rawMock).toHaveBeenCalledTimes(1);
    expect(dailyMock).not.toHaveBeenCalled();
  });

  it('queries the rollup once the window reaches past the raw window', async () => {
    await getStats('?days=8');
    expect(dailyMock).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/v1/admin/crawlers — query failures', () => {
  it('returns 500 when the raw-hits query errors', async () => {
    rawMock.mockResolvedValue({ data: null, error: { message: 'permission denied' } });

    const res = await appWithUser(SUPER_ADMIN).request(BASE);
    expect(res.status).toBe(500);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });

  it('returns 500 when the rollup query errors', async () => {
    dailyMock.mockResolvedValue({ data: null, error: { message: 'relation does not exist' } });

    const res = await appWithUser(SUPER_ADMIN).request(BASE);
    expect(res.status).toBe(500);
  });

  it('returns 500 (not an unhandled rejection) when the client throws', async () => {
    rawMock.mockRejectedValue(new Error('connection refused'));

    const res = await appWithUser(SUPER_ADMIN).request(BASE);
    expect(res.status).toBe(500);
  });

  it('returns an empty-but-well-formed body when there is no traffic', async () => {
    const { res, body } = await getStats();
    expect(res.status).toBe(200);
    expect(body.totals).toEqual([]);
    expect(body.topPaths).toEqual([]);
    expect(body.daily).toHaveLength(30);
    expect(body.daily.every((d) => d.hits === 0)).toBe(true);
  });
});
