import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Tests for sitemap and RSS generation logic.
 * Re-implements the pure functions from:
 *   carbon/scripts/generate-sitemap.ts
 *   carbon/scripts/generate-rss.ts
 */

// ============================================================================
// SITEMAP FUNCTIONS (mirror generate-sitemap.ts)
// ============================================================================

const SITEMAP_SCRIPT = join(import.meta.dirname, '../../../carbon/scripts/generate-sitemap.ts');

/**
 * Read the route list out of the template script instead of re-declaring it.
 *
 * A local copy silently rotted: the script grew /pricing, /contact, /privacy
 * and /terms while this file kept asserting a 6-entry list, so every sitemap
 * assertion below stayed green against routes the template no longer had.
 * Parsing the declaration means the same drift now shows up as a real diff in
 * what these tests exercise — and `covers the routes the app actually serves`
 * below fails loudly if a route is dropped from the script.
 */
function readPublicRoutes(): string[] {
  const source = readFileSync(SITEMAP_SCRIPT, 'utf-8');
  const block = source.match(/const PUBLIC_ROUTES = \[([\s\S]*?)\];/);
  if (!block) {
    throw new Error(
      `Could not find the PUBLIC_ROUTES declaration in ${SITEMAP_SCRIPT}. These tests parse ` +
        'it from source so the list cannot drift; update this parser if the declaration moved.',
    );
  }
  return Array.from(block[1].matchAll(/'([^']+)'/g), (m) => m[1]);
}

const PUBLIC_ROUTES = readPublicRoutes();

function generateSitemap(
  siteUrl: string,
  blogSlugs: string[],
  changelogSlugs: string[],
  docsSlugs: string[],
): string {
  const today = new Date().toISOString().split('T')[0];
  const allRoutes = [
    ...PUBLIC_ROUTES,
    ...blogSlugs.map((s) => `/blog/${s}`),
    ...changelogSlugs.map((s) => `/changelog/${s}`),
    ...docsSlugs.map((s) => `/docs/${s}`),
  ];

  const urls = allRoutes
    .map(
      (route) => `  <url>
    <loc>${siteUrl}${route === '/' ? '' : route}</loc>
    <lastmod>${today}</lastmod>
  </url>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

function loadSiteUrlFromEnvContent(content: string): string | null {
  const match = content.match(/^SITE_URL=["']?(.+?)["']?\s*$/m);
  return match ? match[1] : null;
}

// ============================================================================
// RSS FUNCTIONS (mirror generate-rss.ts)
// ============================================================================

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) {
      fm[key.trim()] = rest
        .join(':')
        .trim()
        .replace(/^["']|["']$/g, '');
    }
  }
  return fm;
}

interface PostMeta {
  slug: string;
  title: string;
  description: string;
  date: string;
  author?: string;
}

function generateRss(posts: PostMeta[], siteUrl: string, projectName: string): string {
  const items = posts
    .map(
      (post) => `    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${siteUrl}/blog/${post.slug}</link>
      <description>${escapeXml(post.description)}</description>
      <pubDate>${new Date(post.date).toUTCString()}</pubDate>
      <guid>${siteUrl}/blog/${post.slug}</guid>
    </item>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(projectName)} Blog</title>
    <link>${siteUrl}/blog</link>
    <description>Updates, guides, and insights from ${escapeXml(projectName)}.</description>
    <language>en-us</language>
    <atom:link href="${siteUrl}/rss.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;
}

// ============================================================================
// TESTS
// ============================================================================

describe('Sitemap generation', () => {
  describe('PUBLIC_ROUTES', () => {
    it('parses a non-empty list of absolute paths out of the template script', () => {
      expect(PUBLIC_ROUTES.length).toBeGreaterThan(0);
      for (const route of PUBLIC_ROUTES) {
        expect(route.startsWith('/')).toBe(true);
      }
    });

    it('covers the routes the app actually serves', () => {
      // Two-way pin: adding a route to generate-sitemap.ts flows into every
      // assertion below automatically, while REMOVING one of these — which
      // would de-index a live page — fails here instead of passing silently.
      expect(PUBLIC_ROUTES).toEqual([
        '/',
        '/pricing',
        '/contact',
        '/login',
        '/signup',
        '/blog',
        '/changelog',
        '/docs',
        '/privacy',
        '/terms',
      ]);
    });
  });

  describe('generateSitemap', () => {
    it('generates valid XML', () => {
      const sitemap = generateSitemap('https://example.com', [], [], []);
      expect(sitemap).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(sitemap).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
      expect(sitemap).toContain('</urlset>');
    });

    it('includes all public routes', () => {
      const sitemap = generateSitemap('https://example.com', [], [], []);
      for (const route of PUBLIC_ROUTES) {
        if (route === '/') {
          expect(sitemap).toContain('<loc>https://example.com</loc>');
        } else {
          expect(sitemap).toContain(`<loc>https://example.com${route}</loc>`);
        }
      }
    });

    it('includes blog slugs', () => {
      const sitemap = generateSitemap(
        'https://example.com',
        ['hello-world', 'second-post'],
        [],
        [],
      );
      expect(sitemap).toContain('<loc>https://example.com/blog/hello-world</loc>');
      expect(sitemap).toContain('<loc>https://example.com/blog/second-post</loc>');
    });

    it('includes changelog slugs', () => {
      const sitemap = generateSitemap('https://example.com', [], ['v0-1-0', 'v0-2-0'], []);
      expect(sitemap).toContain('<loc>https://example.com/changelog/v0-1-0</loc>');
      expect(sitemap).toContain('<loc>https://example.com/changelog/v0-2-0</loc>');
    });

    it('includes docs slugs', () => {
      const sitemap = generateSitemap(
        'https://example.com',
        [],
        [],
        ['getting-started', 'authentication'],
      );
      expect(sitemap).toContain('<loc>https://example.com/docs/getting-started</loc>');
      expect(sitemap).toContain('<loc>https://example.com/docs/authentication</loc>');
    });

    it('includes lastmod with today date', () => {
      const today = new Date().toISOString().split('T')[0];
      const sitemap = generateSitemap('https://example.com', [], [], []);
      expect(sitemap).toContain(`<lastmod>${today}</lastmod>`);
    });

    it('homepage has no trailing path', () => {
      const sitemap = generateSitemap('https://example.com', [], [], []);
      // Homepage should be https://example.com, not https://example.com/
      expect(sitemap).toContain('<loc>https://example.com</loc>');
      expect(sitemap).not.toContain('<loc>https://example.com/</loc>');
    });

    it('handles all content types together', () => {
      const sitemap = generateSitemap('https://example.com', ['post-1'], ['v1'], ['intro']);
      const urlCount = (sitemap.match(/<url>/g) || []).length;
      expect(urlCount).toBe(PUBLIC_ROUTES.length + 3); // public + 1 blog + 1 changelog + 1 doc
    });
  });

  describe('loadSiteUrlFromEnvContent', () => {
    it('extracts unquoted URL', () => {
      expect(loadSiteUrlFromEnvContent('SITE_URL=https://myapp.com')).toBe('https://myapp.com');
    });

    it('extracts single-quoted URL', () => {
      expect(loadSiteUrlFromEnvContent("SITE_URL='https://myapp.com'")).toBe('https://myapp.com');
    });

    it('extracts double-quoted URL', () => {
      expect(loadSiteUrlFromEnvContent('SITE_URL="https://myapp.com"')).toBe('https://myapp.com');
    });

    it('handles URL among other env vars', () => {
      const content = `DB_HOST=localhost
SITE_URL=https://myapp.com
PORT=3000`;
      expect(loadSiteUrlFromEnvContent(content)).toBe('https://myapp.com');
    });

    it('returns null when SITE_URL not found', () => {
      expect(loadSiteUrlFromEnvContent('PORT=3000\nDB_HOST=localhost')).toBeNull();
    });

    it('returns null for empty content', () => {
      expect(loadSiteUrlFromEnvContent('')).toBeNull();
    });
  });
});

describe('RSS generation', () => {
  describe('escapeXml', () => {
    it('escapes ampersands', () => {
      expect(escapeXml('Tom & Jerry')).toBe('Tom &amp; Jerry');
    });

    it('escapes less-than', () => {
      expect(escapeXml('a < b')).toBe('a &lt; b');
    });

    it('escapes greater-than', () => {
      expect(escapeXml('a > b')).toBe('a &gt; b');
    });

    it('handles multiple special chars', () => {
      expect(escapeXml('<script>alert("x&y")</script>')).toBe(
        '&lt;script&gt;alert("x&amp;y")&lt;/script&gt;',
      );
    });

    it('returns empty string unchanged', () => {
      expect(escapeXml('')).toBe('');
    });

    it('returns plain text unchanged', () => {
      expect(escapeXml('Hello World')).toBe('Hello World');
    });
  });

  describe('parseFrontmatter', () => {
    it('parses simple frontmatter', () => {
      const content = `---
title: Hello World
date: 2024-01-01
---
Content here`;
      const fm = parseFrontmatter(content);
      expect(fm.title).toBe('Hello World');
      expect(fm.date).toBe('2024-01-01');
    });

    it('strips quotes from values', () => {
      const content = `---
title: "Quoted Title"
author: 'Single Quoted'
---`;
      const fm = parseFrontmatter(content);
      expect(fm.title).toBe('Quoted Title');
      expect(fm.author).toBe('Single Quoted');
    });

    it('handles colons in values', () => {
      const content = `---
title: My Post: A Subtitle
date: 2024-01-01T10:00:00Z
---`;
      const fm = parseFrontmatter(content);
      expect(fm.title).toBe('My Post: A Subtitle');
      expect(fm.date).toBe('2024-01-01T10:00:00Z');
    });

    it('returns empty object for no frontmatter', () => {
      expect(parseFrontmatter('Just content, no frontmatter')).toEqual({});
    });

    it('returns empty object for empty content', () => {
      expect(parseFrontmatter('')).toEqual({});
    });

    it('ignores lines without values', () => {
      const content = `---
title: Hello
badline
date: 2024-01-01
---`;
      const fm = parseFrontmatter(content);
      expect(fm.title).toBe('Hello');
      expect(fm.date).toBe('2024-01-01');
      expect(Object.keys(fm)).toHaveLength(2);
    });
  });

  describe('generateRss', () => {
    const posts: PostMeta[] = [
      {
        slug: 'hello-world',
        title: 'Hello World',
        description: 'First post',
        date: '2024-01-15',
      },
      {
        slug: 'second-post',
        title: 'Second Post',
        description: 'Another update',
        date: '2024-02-01',
      },
    ];

    it('generates valid RSS XML', () => {
      const rss = generateRss(posts, 'https://example.com', 'MyApp');
      expect(rss).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(rss).toContain('<rss version="2.0"');
      expect(rss).toContain('</rss>');
    });

    it('includes channel metadata', () => {
      const rss = generateRss(posts, 'https://example.com', 'MyApp');
      expect(rss).toContain('<title>MyApp Blog</title>');
      expect(rss).toContain('<link>https://example.com/blog</link>');
      expect(rss).toContain('Updates, guides, and insights from MyApp.');
      expect(rss).toContain('<language>en-us</language>');
    });

    it('includes atom self link', () => {
      const rss = generateRss(posts, 'https://example.com', 'MyApp');
      expect(rss).toContain('href="https://example.com/rss.xml"');
    });

    it('includes items for each post', () => {
      const rss = generateRss(posts, 'https://example.com', 'MyApp');
      expect(rss).toContain('<title>Hello World</title>');
      expect(rss).toContain('<link>https://example.com/blog/hello-world</link>');
      expect(rss).toContain('<title>Second Post</title>');
      expect(rss).toContain('<link>https://example.com/blog/second-post</link>');
    });

    it('includes pubDate in RFC 822 format', () => {
      const rss = generateRss(posts, 'https://example.com', 'MyApp');
      expect(rss).toContain('<pubDate>');
      // Verify the date is a valid UTC string format (e.g., "Mon, 15 Jan 2024 00:00:00 GMT")
      const pubDateMatch = rss.match(/<pubDate>(.+?)<\/pubDate>/);
      expect(pubDateMatch).not.toBeNull();
      expect(pubDateMatch?.[1]).toContain('GMT');
      expect(pubDateMatch?.[1]).toContain('2024');
    });

    it('uses blog slug as guid', () => {
      const rss = generateRss(posts, 'https://example.com', 'MyApp');
      expect(rss).toContain('<guid>https://example.com/blog/hello-world</guid>');
    });

    it('escapes special characters in titles', () => {
      const specialPosts: PostMeta[] = [
        {
          slug: 'special',
          title: 'React & Vue: A Comparison',
          description: 'Comparing <frameworks>',
          date: '2024-01-01',
        },
      ];
      const rss = generateRss(specialPosts, 'https://example.com', 'MyApp');
      expect(rss).toContain('React &amp; Vue: A Comparison');
      expect(rss).toContain('Comparing &lt;frameworks&gt;');
    });

    it('handles empty posts array', () => {
      const rss = generateRss([], 'https://example.com', 'MyApp');
      expect(rss).toContain('<channel>');
      expect(rss).not.toContain('<item>');
    });

    it('escapes project name in channel', () => {
      const rss = generateRss([], 'https://example.com', 'A & B App');
      expect(rss).toContain('A &amp; B App Blog');
    });
  });
});
