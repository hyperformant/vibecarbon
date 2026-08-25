import { describe, expect, it } from 'vitest';
import { CRAWLERS, classifyCrawler, findCrawlerByName } from '@server/lib/crawlers';

describe('classifyCrawler', () => {
  it('matches a known crawler case-insensitively anywhere in the UA', () => {
    const ua =
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot';
    expect(classifyCrawler(ua)).toMatchObject({
      name: 'GPTBot',
      operator: 'OpenAI',
      category: 'ai-training',
    });
    // Same bot, arbitrary casing.
    expect(classifyCrawler('gptbot/1.2')?.name).toBe('GPTBot');
  });

  it('prefers the specific entry over the generic one it contains', () => {
    // `applebot-extended` CONTAINS `applebot`, so registry order is the only
    // thing keeping Apple's AI-training fetches from being logged as search.
    expect(classifyCrawler('Mozilla/5.0 (compatible; Applebot-Extended/0.1)')).toMatchObject({
      name: 'Applebot-Extended',
      category: 'ai-training',
    });
    expect(classifyCrawler('Mozilla/5.0 (compatible; Applebot/0.1)')).toMatchObject({
      name: 'Applebot',
      category: 'search',
    });
    // The same rule for Google.
    expect(classifyCrawler('Google-Extended')?.name).toBe('Google-Extended');
    expect(classifyCrawler('compatible; Googlebot/2.1')?.name).toBe('Googlebot');
  });

  it('returns null for browsers and for a missing User-Agent', () => {
    expect(
      classifyCrawler(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
      )
    ).toBeNull();
    expect(classifyCrawler(undefined)).toBeNull();
    expect(classifyCrawler('')).toBeNull();
  });

  it('returns null for every common browser User-Agent', () => {
    // If a browser UA ever classified as a crawler the dashboard would be
    // measuring humans, and the middleware would write a row per page view.
    const browsers = [
      // Chrome (desktop)
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      // Safari (macOS) — contains "AppleWebKit", which must not hit `applebot`
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      // Safari (iOS)
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      // Firefox
      'Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0',
      // Edge
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
      // Android Chrome
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
      // Non-browser, non-crawler clients
      'curl/8.7.1',
      'node',
    ];
    for (const ua of browsers) {
      expect(classifyCrawler(ua), `${ua} must not classify as a crawler`).toBeNull();
    }
  });

  it('keeps every registry entry ordered specific-before-generic', () => {
    // Structural guard: if entry B's match string contains entry A's, B must
    // come first, or B can never be reached.
    for (let i = 0; i < CRAWLERS.length; i++) {
      for (let j = i + 1; j < CRAWLERS.length; j++) {
        expect(
          CRAWLERS[j].match.includes(CRAWLERS[i].match),
          `${CRAWLERS[j].name} is shadowed by the earlier, less specific ${CRAWLERS[i].name}`
        ).toBe(false);
      }
    }
  });
});

describe('classifyCrawler — every registry entry is reachable', () => {
  // Table-driven pass over the WHOLE registry: each entry's own match string,
  // dressed up as a realistic UA, must classify back to that exact entry.
  // Reference equality (toBe) is the point — a shadowed entry returns a
  // *different* registry object, so this catches ordering regressions
  // (Googlebot swallowing Google-Extended, Applebot swallowing
  // Applebot-Extended) that a `toMatchObject` on category alone could miss.
  for (const crawler of CRAWLERS) {
    it(`classifies a ${crawler.name} User-Agent as ${crawler.name} (${crawler.category})`, () => {
      const ua = `Mozilla/5.0 (compatible; ${crawler.match}/1.0; +https://example.com/bot)`;
      expect(classifyCrawler(ua)).toBe(crawler);
      // Real bots send mixed casing; matching is case-insensitive.
      expect(classifyCrawler(ua.toUpperCase())).toBe(crawler);
      expect(classifyCrawler(crawler.match)).toBe(crawler);
    });
  }
});

describe('CRAWLERS registry invariants', () => {
  it('has unique names — the name is the stored crawler_hits.crawler value', () => {
    const names = CRAWLERS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('has unique, lowercase, non-empty match strings', () => {
    const matches = CRAWLERS.map((c) => c.match);
    expect(new Set(matches).size).toBe(matches.length);
    for (const crawler of CRAWLERS) {
      expect(crawler.match, `${crawler.name} match must be lowercase`).toBe(
        crawler.match.toLowerCase()
      );
      expect(crawler.match.length).toBeGreaterThan(0);
    }
  });

  it('gives every entry an operator and a known category', () => {
    for (const crawler of CRAWLERS) {
      expect(crawler.operator.length, `${crawler.name} needs an operator`).toBeGreaterThan(0);
      expect(['ai-training', 'ai-search', 'search']).toContain(crawler.category);
    }
  });
});

describe('findCrawlerByName', () => {
  it('round-trips every registry entry by its stored name', () => {
    // The admin route drops rows whose crawler name is not in the registry, so
    // a name that fails to round-trip silently disappears from the dashboard.
    for (const crawler of CRAWLERS) {
      expect(findCrawlerByName(crawler.name)).toBe(crawler);
    }
  });

  it('returns null for an unregistered or differently-cased name', () => {
    expect(findCrawlerByName('RetiredBot')).toBeNull();
    expect(findCrawlerByName('')).toBeNull();
    // Lookup is exact — the stored value is written from `crawler.name`.
    expect(findCrawlerByName('gptbot')).toBeNull();
  });
});
