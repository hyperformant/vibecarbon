import { and, desc, gte, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { adminDb } from '../../../db/client';
import { crawlerHits, crawlerHitsDaily } from '../../../db/schema';
import { isSuperAdmin } from '../../../lib/auth';
import { type CrawlerCategory, findCrawlerByName } from '../../../lib/crawlers';
import { sanitizeError } from '../../../lib/errors';
import { logger } from '../../../lib/logger';
import type { HonoVariables } from '../../../types';

/**
 * AI Visibility — per-crawler analytics for the admin dashboard.
 *
 * Reads the recent part of the window from the raw `crawler_hits` table and
 * anything older from the `crawler_hits_daily` rollup, then unions them. The
 * split point is RAW_WINDOW_DAYS: comfortably inside the raw table's 90-day
 * retention, and wide enough that a missed nightly rollup shows up as fresh
 * raw data rather than as a hole in the chart.
 */

const crawlerRoutes = new Hono<{ Variables: HonoVariables }>();

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 365;

/** Days served from the raw table; everything older comes from the rollup. */
const RAW_WINDOW_DAYS = 7;

/**
 * Ceiling on raw rows pulled into memory for aggregation. At the middleware's
 * 5k-inserts/hour cap a pathological week could exceed this; we take the most
 * recent rows and log, rather than pulling an unbounded result set into the
 * API process.
 */
const MAX_RAW_ROWS = 50_000;

/**
 * Same ceiling for the rollup branch. `crawler_hits_daily` is keyed by
 * (day, crawler, path), so a wide window is bounded by
 * days x registry-size x distinct-paths — small in practice, but the path
 * dimension is fed by traffic, so this query needs a limit exactly like the raw
 * one. Rows are ordered by `hits` descending so a truncated read keeps the
 * meaningful traffic rather than an arbitrary slice.
 */
const MAX_ROLLUP_ROWS = 50_000;

const TOP_PATHS_LIMIT = 10;

function emptyByCategory(): Record<CrawlerCategory, number> {
  return { 'ai-training': 0, 'ai-search': 0, search: 0 };
}

/** UTC calendar day of a timestamp, as `YYYY-MM-DD`. */
function toDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function parseWindowDays(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_WINDOW_DAYS;
  return Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, parsed));
}

crawlerRoutes.get('/', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!isSuperAdmin(user)) {
    return c.json({ error: 'Super admin access required' }, 403);
  }

  const windowDays = parseWindowDays(c.req.query('days'));

  const now = new Date();
  const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  // One key per day in the window, oldest first, ending with today.
  const dayKeys: string[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    dayKeys.push(toDayKey(todayStartMs - i * DAY_MS));
  }

  const rawDays = Math.min(windowDays, RAW_WINDOW_DAYS);
  const rawFromMs = todayStartMs - (rawDays - 1) * DAY_MS;
  const rawFromKey = toDayKey(rawFromMs);

  // --- Accumulators -------------------------------------------------------
  const perCrawler = new Map<string, { hits: number; errors: number }>();
  const perDay = new Map<string, { hits: number; byCategory: Record<CrawlerCategory, number> }>();
  const perPath = new Map<string, { hits: number; errors: number; crawlers: Set<string> }>();

  /** `errors`: how many of these hits were answered with a 5xx. */
  function addRecord(
    day: string,
    crawlerName: string,
    path: string,
    hits: number,
    errors: number
  ): void {
    const crawler = findCrawlerByName(crawlerName);
    // Rows whose crawler is no longer in the registry (renamed/removed entry)
    // are skipped rather than reported without an operator/category — the
    // response contract has no shape for an unclassified crawler.
    if (!crawler || hits <= 0) return;

    const crawlerBucket = perCrawler.get(crawlerName) ?? { hits: 0, errors: 0 };
    crawlerBucket.hits += hits;
    crawlerBucket.errors += errors;
    perCrawler.set(crawlerName, crawlerBucket);

    let dayBucket = perDay.get(day);
    if (!dayBucket) {
      dayBucket = { hits: 0, byCategory: emptyByCategory() };
      perDay.set(day, dayBucket);
    }
    dayBucket.hits += hits;
    dayBucket.byCategory[crawler.category] += hits;

    let pathBucket = perPath.get(path);
    if (!pathBucket) {
      pathBucket = { hits: 0, errors: 0, crawlers: new Set<string>() };
      perPath.set(path, pathBucket);
    }
    pathBucket.hits += hits;
    pathBucket.errors += errors;
    pathBucket.crawlers.add(crawlerName);
  }

  try {
    // --- Recent window: raw per-hit rows ----------------------------------
    const rawHits = await adminDb
      .select({
        crawler: crawlerHits.crawler,
        path: crawlerHits.path,
        status: crawlerHits.status,
        hitAt: crawlerHits.hitAt,
      })
      .from(crawlerHits)
      .where(gte(crawlerHits.hitAt, new Date(rawFromMs).toISOString()))
      .orderBy(desc(crawlerHits.hitAt))
      .limit(MAX_RAW_ROWS);

    if (rawHits.length >= MAX_RAW_ROWS) {
      logger.warn(
        { limit: MAX_RAW_ROWS, windowDays },
        'Crawler hit window truncated at the raw-row cap; recent totals are a lower bound'
      );
    }

    for (const hit of rawHits) {
      // status is null for rows recorded before the column existed.
      const isError = (hit.status ?? 0) >= 500 ? 1 : 0;
      addRecord(toDayKey(Date.parse(hit.hitAt)), hit.crawler, hit.path, 1, isError);
    }

    // --- Older days: daily rollup ----------------------------------------
    if (windowDays > RAW_WINDOW_DAYS) {
      const dailyRows = await adminDb
        .select({
          day: crawlerHitsDaily.day,
          crawler: crawlerHitsDaily.crawler,
          path: crawlerHitsDaily.path,
          hits: crawlerHitsDaily.hits,
          errors: crawlerHitsDaily.errors,
        })
        .from(crawlerHitsDaily)
        .where(and(gte(crawlerHitsDaily.day, dayKeys[0]), lt(crawlerHitsDaily.day, rawFromKey)))
        .orderBy(desc(crawlerHitsDaily.hits))
        .limit(MAX_ROLLUP_ROWS);

      if (dailyRows.length >= MAX_ROLLUP_ROWS) {
        logger.warn(
          { limit: MAX_ROLLUP_ROWS, windowDays },
          'Crawler rollup window truncated at the row cap; older totals are a lower bound'
        );
      }

      for (const row of dailyRows) {
        // `day` is a DATE; the driver hands it back as YYYY-MM-DD.
        addRecord(row.day, row.crawler, row.path, row.hits, row.errors ?? 0);
      }
    }
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to fetch crawler hits') }, 500);
  }

  // --- Response -----------------------------------------------------------
  const totals = [...perCrawler.entries()]
    .flatMap(([name, { hits, errors }]) => {
      const crawler = findCrawlerByName(name);
      if (!crawler || hits <= 0) return [];
      return [
        { crawler: name, operator: crawler.operator, category: crawler.category, hits, errors },
      ];
    })
    .sort((a, b) => b.hits - a.hits || a.crawler.localeCompare(b.crawler));

  const daily = dayKeys.map((day) => {
    const bucket = perDay.get(day);
    return {
      day,
      hits: bucket?.hits ?? 0,
      byCategory: bucket?.byCategory ?? emptyByCategory(),
    };
  });

  const topPaths = [...perPath.entries()]
    .sort((a, b) => b[1].hits - a[1].hits || a[0].localeCompare(b[0]))
    .slice(0, TOP_PATHS_LIMIT)
    .map(([path, bucket]) => ({
      path,
      hits: bucket.hits,
      errors: bucket.errors,
      crawlers: [...bucket.crawlers].sort(),
    }));

  logger.debug({ userId: user.id, windowDays }, 'Admin crawler analytics fetched');

  return c.json({ windowDays, totals, daily, topPaths });
});

export { crawlerRoutes };
