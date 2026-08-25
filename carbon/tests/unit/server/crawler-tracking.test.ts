/**
 * Unit coverage for the crawler-tracking middleware
 * (src/server/middleware/crawler-tracking.ts).
 *
 * The middleware sits on `app.use('*')`, so its two guards carry real weight:
 * `isTrackablePath` decides what counts as a *document* fetch, and
 * `classifyCrawler` decides whether a row is written at all. Everything below
 * the guards is fire-and-forget, which is exactly why it needs pinning: a
 * rejected — or PostgREST-style resolved-with-error — insert must be logged,
 * never thrown, and never allowed to fail the page render.
 *
 * Module state (burst-cap counter, error-log throttle) lives at module scope
 * with no reset hook, so tests that touch it re-import the module through
 * `loadMiddleware()` for a clean slate.
 */

import type { Context } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HonoVariables } from '@server/types';

const { fromMock, insertMock, warnMock, readFileSyncMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  insertMock: vi.fn(),
  warnMock: vi.fn(),
  readFileSyncMock: vi.fn(),
}));

// supabaseAdmin.from('crawler_hits').insert({...}).then(onResult, onError)
vi.mock('@server/lib/supabase', () => ({ supabaseAdmin: { from: fromMock } }));

vi.mock('@server/lib/logger', () => ({
  logger: { warn: warnMock, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// The middleware reads the built SEO route manifest to decide which paths may
// be stored verbatim. Mocked so these tests don't depend on whether `dist/`
// happens to exist in the working tree.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: readFileSyncMock,
}));

/** Stand-in for dist/seo/route-meta.json. */
const MANIFEST = JSON.stringify({
  routes: {
    '/': { title: 'Home', description: '' },
    '/pricing': { title: 'Pricing', description: '' },
    '/docs/seo': { title: 'SEO', description: '' },
    '/docs/cli': { title: 'CLI', description: '' },
  },
});

const { isTrackablePath } = await import('@server/middleware/crawler-tracking');

const GPTBOT_UA = 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)';
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

type CrawlerTracking = (
  c: Context<{ Variables: HonoVariables }>,
  next: () => Promise<void>
) => Promise<void>;

/**
 * Fresh copy of the middleware, so the in-process burst counter and the
 * error-log throttle start from zero. `vi.mock` factories are re-applied on
 * re-import, and they close over the hoisted mocks — so assertions below still
 * see the same `insertMock` / `warnMock` the fresh module writes to.
 */
async function loadMiddleware(): Promise<CrawlerTracking> {
  vi.resetModules();
  const mod = await import('@server/middleware/crawler-tracking');
  return mod.crawlerTracking as CrawlerTracking;
}

/** Minimal context double: the middleware only reads method, path and the UA. */
function ctx(method: string, path: string, userAgent?: string) {
  return {
    req: {
      method,
      path,
      header: (name: string) => (name.toLowerCase() === 'user-agent' ? userAgent : undefined),
    },
  } as unknown as Context<{ Variables: HonoVariables }>;
}

/** The inserted row, as passed to `.insert()`. */
function insertedRow(call = 0): { crawler: string; path: string; user_agent: string | null } {
  return insertMock.mock.calls[call][0];
}

beforeEach(() => {
  fromMock.mockReset();
  insertMock.mockReset();
  warnMock.mockReset();
  readFileSyncMock.mockReset();
  readFileSyncMock.mockReturnValue(MANIFEST);
  // Default: PostgREST resolves with `{ error: null }` on success.
  insertMock.mockReturnValue(Promise.resolve({ error: null }));
  fromMock.mockReturnValue({ insert: insertMock });
});

afterEach(() => {
  // The burst-cap test moves the clock; never leave it moved for the next test.
  vi.useRealTimers();
});

describe('isTrackablePath', () => {
  const trackable: Array<[string, string, string]> = [
    ['GET', '/', 'the SPA landing page'],
    ['GET', '/docs/cli', 'an extensionless SPA route'],
    ['GET', '/llms.txt', 'the llms.txt manifest'],
    ['GET', '/docs/cli.md', 'a markdown mirror'],
    ['GET', '/sitemap.xml', 'the sitemap'],
    ['GET', '/robots.txt', 'robots.txt'],
    ['GET', '/.well-known/security.txt', 'a dotfile-looking directory'],
    ['HEAD', '/docs/cli', 'a HEAD probe of a document'],
  ];

  for (const [method, path, why] of trackable) {
    it(`counts ${method} ${path} (${why})`, () => {
      expect(isTrackablePath(method, path)).toBe(true);
    });
  }

  const untrackable: Array<[string, string, string]> = [
    ['GET', '/api/v1/me', 'API traffic is never a crawler document fetch'],
    ['GET', '/assets/x.js', 'built assets are noise'],
    ['GET', '/favicon.svg', 'an icon asset'],
    ['GET', '/og-image.png', 'an image asset'],
    ['GET', '/app.css', 'a stylesheet'],
    ['GET', '/index.js.map', 'a source map'],
    ['POST', '/', 'writes are not document fetches'],
    ['POST', '/llms.txt', 'a POST to a tracked document type'],
    ['PUT', '/docs/cli', 'any non-GET/HEAD method'],
    ['DELETE', '/docs/cli', 'any non-GET/HEAD method'],
    ['OPTIONS', '/', 'preflight'],
  ];

  for (const [method, path, why] of untrackable) {
    it(`does not count ${method} ${path} (${why})`, () => {
      expect(isTrackablePath(method, path)).toBe(false);
    });
  }

  it('treats a dot inside a path segment before the last as irrelevant', () => {
    // Only the final segment's extension decides.
    expect(isTrackablePath('GET', '/v1.2/guide')).toBe(true);
    expect(isTrackablePath('GET', '/v1.2/guide.png')).toBe(false);
  });
});

describe('crawlerTracking — when a row is written', () => {
  it('inserts a hit for a crawler UA on a trackable path', async () => {
    const crawlerTracking = await loadMiddleware();
    const next = vi.fn(async () => {});

    await crawlerTracking(ctx('GET', '/docs/seo', GPTBOT_UA), next);

    expect(fromMock).toHaveBeenCalledWith('crawler_hits');
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertedRow()).toEqual({
      crawler: 'GPTBot',
      path: '/docs/seo',
      user_agent: GPTBOT_UA,
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does NOT insert for a browser UA', async () => {
    const crawlerTracking = await loadMiddleware();
    const next = vi.fn(async () => {});

    await crawlerTracking(ctx('GET', '/docs/seo', CHROME_UA), next);

    expect(insertMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does NOT insert when the User-Agent header is absent', async () => {
    const crawlerTracking = await loadMiddleware();
    await crawlerTracking(ctx('GET', '/docs/seo', undefined), vi.fn(async () => {}));
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('does NOT insert for a crawler UA on an untrackable path', async () => {
    const crawlerTracking = await loadMiddleware();
    const next = vi.fn(async () => {});

    await crawlerTracking(ctx('GET', '/api/v1/me', GPTBOT_UA), next);
    await crawlerTracking(ctx('GET', '/assets/main.js', GPTBOT_UA), next);
    await crawlerTracking(ctx('POST', '/', GPTBOT_UA), next);

    expect(insertMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('records the registry name, not the raw UA token', async () => {
    const crawlerTracking = await loadMiddleware();
    await crawlerTracking(
      ctx('GET', '/', 'Mozilla/5.0 (compatible; applebot-extended/0.1)'),
      vi.fn(async () => {})
    );
    // Stored value must be the registry `name` so findCrawlerByName can resolve
    // it back on the admin route.
    expect(insertedRow().crawler).toBe('Applebot-Extended');
  });

  it('SECURITY: truncates the attacker-controlled User-Agent', async () => {
    const crawlerTracking = await loadMiddleware();
    const longUa = `GPTBot ${'A'.repeat(1000)}`;

    await crawlerTracking(ctx('GET', '/', longUa), vi.fn(async () => {}));

    expect(insertedRow().user_agent).toHaveLength(256);
  });

  it('never throws out of the middleware, even if tracking blows up', async () => {
    // MEDIUM-4: this middleware fronts the whole site. A throw anywhere in the
    // tracking block must not turn a page render into a 500.
    const crawlerTracking = await loadMiddleware();
    fromMock.mockImplementation(() => {
      throw new Error('supabase client exploded');
    });
    const next = vi.fn(async () => {});

    await expect(crawlerTracking(ctx('GET', '/', GPTBOT_UA), next)).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(warnMock).toHaveBeenCalled());
  });
});

describe('crawlerTracking — path bucketing (SECURITY: bounded cardinality)', () => {
  /**
   * HIGH-1: `path` is part of `crawler_hits_daily`'s primary key, and the SPA
   * fallback serves any URL, so an unbucketed path would let a spoofed UA mint
   * an unbounded number of permanent rollup rows. Only paths in the built SEO
   * manifest (plus their .md mirrors and the fixed generated files) are stored
   * verbatim; everything else collapses to one constant.
   */
  const OTHER = '<other>';

  const verbatim: Array<[string, string]> = [
    ['/', 'a manifest route'],
    ['/pricing', 'another manifest route'],
    ['/docs/seo', 'a nested manifest route'],
    ['/docs/seo.md', 'the markdown mirror of a manifest route'],
    ['/llms.txt', 'a fixed generated file'],
    ['/llms-full.txt', 'a fixed generated file'],
    ['/sitemap.xml', 'a fixed generated file'],
    ['/robots.txt', 'a fixed generated file'],
    ['/rss.xml', 'a fixed generated file'],
  ];

  for (const [path, why] of verbatim) {
    it(`stores ${path} verbatim (${why})`, async () => {
      const crawlerTracking = await loadMiddleware();
      await crawlerTracking(ctx('GET', path, GPTBOT_UA), vi.fn(async () => {}));
      expect(insertedRow().path).toBe(path);
    });
  }

  const bucketed: Array<[string, string]> = [
    ['/not-a-real-page', 'an unknown route (the SPA fallback still serves it)'],
    [`/${'b'.repeat(2000)}`, 'an absurdly long attacker-chosen path'],
    ['/docs/seo/../../etc/passwd', 'a traversal-shaped path'],
    ['/Pricing', 'a case variant of a manifest key is not the same route'],
    ['/.md', 'the mirror of "/" is not a real file'],
    ['/random.txt', 'an unknown file with a tracked extension'],
  ];

  for (const [path, why] of bucketed) {
    it(`buckets ${path.slice(0, 30)} to <other> (${why})`, async () => {
      const crawlerTracking = await loadMiddleware();
      await crawlerTracking(ctx('GET', path, GPTBOT_UA), vi.fn(async () => {}));
      expect(insertedRow().path).toBe(OTHER);
    });
  }

  it('normalizes a trailing slash so /docs/seo/ is not a second bucket', async () => {
    const crawlerTracking = await loadMiddleware();
    await crawlerTracking(ctx('GET', '/docs/seo/', GPTBOT_UA), vi.fn(async () => {}));
    expect(insertedRow().path).toBe('/docs/seo');
  });

  it('buckets everything when the manifest is unreadable (dev, or a broken build)', async () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const crawlerTracking = await loadMiddleware();

    await crawlerTracking(ctx('GET', '/docs/seo', GPTBOT_UA), vi.fn(async () => {}));

    // A missing manifest degrades to "no path detail", never to unbounded keys.
    expect(insertedRow().path).toBe(OTHER);
    // ...but the fixed generated files are compiled in, so they still resolve.
    await crawlerTracking(ctx('GET', '/llms.txt', GPTBOT_UA), vi.fn(async () => {}));
    expect(insertedRow(1).path).toBe('/llms.txt');
  });

  it('reads the manifest once, not per request', async () => {
    const crawlerTracking = await loadMiddleware();
    for (let i = 0; i < 5; i++) {
      await crawlerTracking(ctx('GET', '/pricing', GPTBOT_UA), vi.fn(async () => {}));
    }
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
    expect(insertMock).toHaveBeenCalledTimes(5);
  });
});

describe('crawlerTracking — insert failures are swallowed', () => {
  it('logs (does not throw) a PostgREST-style resolved error', async () => {
    const crawlerTracking = await loadMiddleware();
    insertMock.mockReturnValue(Promise.resolve({ error: { message: 'permission denied' } }));
    const next = vi.fn(async () => {});

    // The middleware must resolve normally — the page render does not wait on,
    // and must not fail because of, the tracking write.
    await expect(crawlerTracking(ctx('GET', '/', GPTBOT_UA), next)).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(warnMock).toHaveBeenCalledTimes(1));
    expect(warnMock.mock.calls[0][0]).toEqual({ error: { message: 'permission denied' } });
  });

  it('logs (does not throw) a rejected insert promise', async () => {
    const crawlerTracking = await loadMiddleware();
    insertMock.mockReturnValue(Promise.reject(new Error('connection refused')));

    await expect(
      crawlerTracking(ctx('GET', '/', GPTBOT_UA), vi.fn(async () => {}))
    ).resolves.toBeUndefined();

    await vi.waitFor(() => expect(warnMock).toHaveBeenCalledTimes(1));
  });

  it('throttles the failure log to one line per minute', async () => {
    const crawlerTracking = await loadMiddleware();
    insertMock.mockReturnValue(Promise.resolve({ error: { message: 'db down' } }));
    const next = vi.fn(async () => {});

    for (let i = 0; i < 5; i++) {
      await crawlerTracking(ctx('GET', `/page-${i}`, GPTBOT_UA), next);
    }

    await vi.waitFor(() => expect(warnMock).toHaveBeenCalled());
    // Let every remaining fire-and-forget callback settle before counting.
    await new Promise((resolve) => setImmediate(resolve));

    expect(insertMock).toHaveBeenCalledTimes(5);
    // A DB blip must not turn into a log flood.
    expect(warnMock).toHaveBeenCalledTimes(1);
  });
});

describe('crawlerTracking — per-crawler burst cap', () => {
  /** Budget is per crawler, not global (MEDIUM-1). */
  const MAX_PER_CRAWLER = 1000;
  const WINDOW_MS = 3_600_000;
  const CLAUDEBOT_UA = 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)';

  it('stops inserting past the cap and resumes in the next window', async () => {
    const crawlerTracking = await loadMiddleware();
    const next = vi.fn(async () => {});

    for (let i = 0; i < MAX_PER_CRAWLER + 25; i++) {
      await crawlerTracking(ctx('GET', '/', GPTBOT_UA), next);
    }

    // Hits past the cap are dropped, not written...
    expect(insertMock).toHaveBeenCalledTimes(MAX_PER_CRAWLER);
    // ...and the cap warns exactly once, not once per dropped hit.
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0][0]).toEqual({
      crawler: 'GPTBot',
      max: MAX_PER_CRAWLER,
      windowMs: WINDOW_MS,
    });
    // The request itself is unaffected either way.
    expect(next).toHaveBeenCalledTimes(MAX_PER_CRAWLER + 25);

    // The window TUMBLES: the counter resets on the first hit that arrives a
    // full window after this one opened, and tracking resumes.
    vi.setSystemTime(Date.now() + WINDOW_MS + 1);
    await crawlerTracking(ctx('GET', '/', GPTBOT_UA), next);
    vi.useRealTimers();

    expect(insertMock).toHaveBeenCalledTimes(MAX_PER_CRAWLER + 1);
  });

  it('SECURITY: one crawler exhausting its budget does not blind the others', async () => {
    // MEDIUM-1: with a single global counter, anyone could spoof one UA, burn
    // the whole budget, and hide every other crawler from the dashboard.
    const crawlerTracking = await loadMiddleware();
    const next = vi.fn(async () => {});

    for (let i = 0; i < MAX_PER_CRAWLER + 10; i++) {
      await crawlerTracking(ctx('GET', '/', GPTBOT_UA), next);
    }
    expect(insertMock).toHaveBeenCalledTimes(MAX_PER_CRAWLER);

    // ClaudeBot has its own untouched budget.
    await crawlerTracking(ctx('GET', '/', CLAUDEBOT_UA), next);

    expect(insertMock).toHaveBeenCalledTimes(MAX_PER_CRAWLER + 1);
    expect(insertedRow(MAX_PER_CRAWLER).crawler).toBe('ClaudeBot');
  });
});
