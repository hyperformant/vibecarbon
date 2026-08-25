import { readFileSync } from 'node:fs';
import type { Context, Next } from 'hono';
import { classifyCrawler } from '../lib/crawlers';
import { logger } from '../lib/logger';
import { supabaseAdmin } from '../lib/supabase';
import type { HonoVariables } from '../types';

/**
 * Hono middleware: record AI/search-crawler document fetches for the admin
 * "AI Visibility" page.
 *
 * Registered as `app.use('*', crawlerTracking)` in `src/server/index.ts`,
 * immediately after the request logger and BEFORE the `/api/*` rate limiters —
 * crawler traffic hits `/`, `/docs/*`, `/llms.txt` and the `.md` mirrors, never
 * the API.
 *
 * Design constraints:
 *  - The insert is fire-and-forget. It is never awaited, so a slow or dead
 *    database adds exactly zero latency to a page render.
 *  - The whole block is wrapped in try/catch. This middleware runs in front of
 *    the ENTIRE site, so an unexpected throw here would 500 every page rather
 *    than lose a metric. Tracking is best-effort by contract.
 *  - Errors are swallowed and logged at most once a minute. A DB blip must not
 *    turn into a log flood or a failed page load.
 *  - A per-crawler hourly cap bounds the damage from a misbehaving bot (or a
 *    spoofed UA) hammering the site. Plain counters + window timestamps,
 *    deliberately no timer — this module must not keep the event loop alive
 *    (see the rate-limiter's setInterval, which tests have to mock away).
 *
 * SECURITY: no IP address and no other request header is stored — only the
 * crawler name, a bucketed path, and a truncated User-Agent. There is
 * deliberately no personal data here, so the table needs no retention story
 * beyond the prune in migration 00008.
 */

/** User-Agent values are attacker-controlled; cap what we persist. */
const MAX_USER_AGENT_LENGTH = 256;
/**
 * Belt-and-braces cap on the stored path. After bucketing (below) a path can
 * only be a repo-controlled manifest key or OTHER_PATH, so this should never
 * bite — it stays because `path` is part of `crawler_hits_daily`'s primary key,
 * where an oversized value would fail the index-tuple limit at rollup time.
 */
const MAX_PATH_LENGTH = 1024;

/**
 * Per-crawler insert ceiling per window. Deliberately NOT a global cap: a
 * single spoofed User-Agent could otherwise burn the whole budget and blind the
 * dashboard for every other crawler. The Map is keyed by registry name, so it
 * is bounded by the registry's size (~16 entries), not by traffic.
 */
const MAX_INSERTS_PER_CRAWLER_PER_WINDOW = 1000;

/**
 * TUMBLING (not sliding) window: the counter resets the first time a hit
 * arrives at least WINDOW_MS after the window opened. Two adjacent windows can
 * therefore admit up to 2x the cap across their boundary. That is fine for a
 * blast-radius limiter and keeps the bookkeeping to two numbers per crawler.
 */
const WINDOW_MS = 60 * 60 * 1000;

/** At most one insert-failure log line per minute. */
const ERROR_LOG_INTERVAL_MS = 60 * 1000;

/**
 * Extensions that identify a *document* a crawler is meant to read. Anything
 * else with an extension (.js, .css, .png, .map, .ico…) is an asset fetch and
 * is noise on this dashboard.
 */
const TRACKED_EXTENSIONS = new Set(['md', 'txt', 'xml']);

/**
 * Generated files that are not routes in the SEO manifest but are exactly the
 * things AI crawlers fetch. Kept in sync with scripts/generate-seo.ts and
 * generate-sitemap.ts / generate-rss.ts by hand — the list is tiny and stable.
 */
const FIXED_TRACKED_FILES = [
  '/llms.txt',
  '/llms-full.txt',
  '/sitemap.xml',
  '/robots.txt',
  '/rss.xml',
];

/** Bucket for any path that is not a known public document. */
export const OTHER_PATH = '<other>';

const ROUTE_MANIFEST_PATH = './dist/seo/route-meta.json';

let knownPaths: Set<string> | null = null;

/**
 * The set of paths we are willing to store verbatim: every route in the built
 * SEO manifest, each route's `.md` mirror, and the fixed generated files.
 *
 * SECURITY (HIGH-1): without this allow-list, `path` is attacker-controlled
 * with unbounded cardinality — the SPA fallback serves *any* URL, and this
 * middleware runs before routing, so `GET /<random>` with a spoofed `GPTBot`
 * UA would mint a brand-new `crawler_hits_daily` primary key on every request.
 * That table is a permanent rollup, so unbounded key cardinality is unbounded
 * permanent growth. Bucketing at the source is what makes the rollup safe.
 *
 * Read once, lazily, from the same build artifact and relative path convention
 * `createSeoShell()` uses. An unreadable manifest (dev, or a broken build) is
 * not an error: everything simply buckets to OTHER_PATH.
 */
function loadKnownPaths(): Set<string> {
  const known = new Set<string>(FIXED_TRACKED_FILES);
  try {
    const routes = JSON.parse(readFileSync(ROUTE_MANIFEST_PATH, 'utf-8')).routes ?? {};
    for (const route of Object.keys(routes)) {
      known.add(route);
      // generate-seo.ts writes `<route>.md` mirrors for content pages; adding
      // the mirror for every route is harmless and keeps this in one loop.
      if (route !== '/') known.add(`${route}.md`);
    }
  } catch (err) {
    logger.warn(
      { err, manifestPath: ROUTE_MANIFEST_PATH },
      'SEO route manifest unreadable; crawler hits will all bucket to the "other" path'
    );
  }
  return known;
}

/**
 * Map a request path onto the bounded set of values we are willing to store.
 * Anything unrecognised collapses to OTHER_PATH.
 */
export function normalizeTrackedPath(path: string): string {
  // Same trailing-slash normalization createSeoShell applies, so `/docs/` and
  // `/docs` are one bucket rather than two.
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  if (knownPaths === null) knownPaths = loadKnownPaths();
  return knownPaths.has(normalized) ? normalized.slice(0, MAX_PATH_LENGTH) : OTHER_PATH;
}

/** Per-crawler tumbling-window counters. Bounded by the registry's size. */
const burstWindows = new Map<string, { startedAt: number; count: number; warned: boolean }>();
let lastErrorLoggedAt = 0;

/** True when the path ends in a file extension we do NOT want to track. */
function hasUntrackedExtension(path: string): boolean {
  const lastSegment = path.slice(path.lastIndexOf('/') + 1);
  const dot = lastSegment.lastIndexOf('.');
  // dot <= 0 means "no extension" (or a dotfile like `.well-known`), which is
  // the normal SPA-route shape — those we DO track.
  if (dot <= 0) return false;
  return !TRACKED_EXTENSIONS.has(lastSegment.slice(dot + 1).toLowerCase());
}

/** Exported for tests: does this request qualify for crawler tracking at all? */
export function isTrackablePath(method: string, path: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (path.startsWith('/api/') || path.startsWith('/assets/')) return false;
  return !hasUntrackedExtension(path);
}

function logInsertFailure(error: unknown): void {
  const now = Date.now();
  if (now - lastErrorLoggedAt < ERROR_LOG_INTERVAL_MS) return;
  lastErrorLoggedAt = now;
  logger.warn({ error }, 'Crawler hit insert failed (tracking is best-effort)');
}

/** False once this crawler has exhausted its budget for the current window. */
function admitHit(crawler: string): boolean {
  const now = Date.now();
  let window = burstWindows.get(crawler);

  if (!window || now - window.startedAt >= WINDOW_MS) {
    window = { startedAt: now, count: 0, warned: false };
    burstWindows.set(crawler, window);
  }

  window.count++;
  if (window.count > MAX_INSERTS_PER_CRAWLER_PER_WINDOW) {
    if (!window.warned) {
      window.warned = true;
      logger.warn(
        { crawler, max: MAX_INSERTS_PER_CRAWLER_PER_WINDOW, windowMs: WINDOW_MS },
        'Crawler hit tracking burst cap reached; dropping further hits from this crawler this window'
      );
    }
    return false;
  }
  return true;
}

function recordHit(crawler: string, path: string, userAgent: string | undefined): void {
  if (!admitHit(crawler)) return;

  // NOT awaited: the response must not wait on (or fail because of) this write.
  // PostgREST reports failures in the resolved value, so both paths are handled.
  supabaseAdmin
    .from('crawler_hits')
    .insert({
      crawler,
      path: normalizeTrackedPath(path),
      user_agent: userAgent ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null,
    })
    .then((result) => {
      if (result.error) logInsertFailure(result.error);
    }, logInsertFailure);
}

export async function crawlerTracking(
  c: Context<{ Variables: HonoVariables }>,
  next: Next
): Promise<void> {
  try {
    if (isTrackablePath(c.req.method, c.req.path)) {
      const userAgent = c.req.header('user-agent');
      const crawler = classifyCrawler(userAgent);
      if (crawler) recordHit(crawler.name, c.req.path, userAgent);
    }
  } catch (err) {
    // This middleware fronts the entire site. Losing a metric is acceptable;
    // turning every page into a 500 is not.
    logInsertFailure(err);
  }
  await next();
}
