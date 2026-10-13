/**
 * Build-time sitemap generator.
 *
 * Run: npx tsx scripts/generate-sitemap.ts
 *
 * Reads SITE_URL from .env.local and outputs sitemap.xml to dist/client/.
 * Includes static routes and dynamic blog post routes.
 *
 * <lastmod> is only written when the build actually knows when a page last
 * changed: a content page's frontmatter `updated` (or `date`), and for the
 * blog and changelog indexes, their newest entry. Pages without one omit the
 * tag. Stamping every URL with the build date tells search engines that
 * every page changes on every deploy, and they learn to ignore the field.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFiles } from './lib/dotenv.js';
import { isDraft, parseFrontmatter } from './lib/seo-content';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
// Shell env wins (a blank export falls through), then .env.local over .env
// (readEnvFiles layers those two).
// Production builds receive VITE_PUBLIC_URL as a build arg (no .env.local in
// the image); locally this falls back to whatever the project's .env files hold.
const fileEnv = readEnvFiles(rootDir);
const getEnvValue = (key: string): string | null => process.env[key] || fileEnv[key] || null;

// Public routes listed in the sitemap. /login and /signup stay indexable
// (see scripts/generate-seo.ts) but are left out: they never rank, and a
// sitemap should point crawlers at the pages worth crawling.
const PUBLIC_ROUTES = [
  '/',
  '/pricing',
  '/contact',
  '/blog',
  '/changelog',
  '/docs',
  '/privacy',
  '/terms',
];

function loadSiteUrl(): string {
  const value = getEnvValue('VITE_PUBLIC_URL') || getEnvValue('SITE_URL');
  return (value || 'http://localhost:5173').replace(/\/$/, '');
}

interface SitemapEntry {
  route: string;
  lastmod?: string;
}

/** A frontmatter `updated` or `date` as YYYY-MM-DD, or undefined when absent or malformed. */
function lastModified(fm: Record<string, string>): string | undefined {
  const value = fm.updated || fm.date;
  return value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;
}

/** Published (non-draft) pages in a content directory, routed under `prefix`. */
function getPublishedPages(dir: string, prefix: string): SitemapEntry[] {
  try {
    const contentDir = resolve(__dirname, '..', dir);
    return readdirSync(contentDir)
      .filter((f) => f.endsWith('.mdx'))
      .map((f) => ({ f, fm: parseFrontmatter(readFileSync(resolve(contentDir, f), 'utf-8')).fm }))
      .filter(({ fm }) => !isDraft(fm))
      .map(({ f, fm }) => ({ route: `${prefix}/${f.replace('.mdx', '')}`, lastmod: lastModified(fm) }));
  } catch {
    return [];
  }
}

/** Newest lastmod among `entries`, for the index page that lists them. */
const newest = (entries: SitemapEntry[]): string | undefined =>
  entries.map((e) => e.lastmod).filter(Boolean).sort().at(-1);

const blogPages = getPublishedPages('content/blog', '/blog');
const changelogPages = getPublishedPages('content/changelog', '/changelog');
const docsPages = getPublishedPages('content/docs', '/docs');

function generateSitemap(siteUrl: string): string {
  const indexLastmod: Record<string, string | undefined> = {
    '/blog': newest(blogPages),
    '/changelog': newest(changelogPages),
  };
  const entries: SitemapEntry[] = [
    ...PUBLIC_ROUTES.map((route) => ({ route, lastmod: indexLastmod[route] })),
    ...blogPages,
    ...changelogPages,
    ...docsPages,
  ];

  const urls = entries
    .map(({ route, lastmod }) =>
      [
        '  <url>',
        `    <loc>${siteUrl}${route === '/' ? '' : route}</loc>`,
        ...(lastmod ? [`    <lastmod>${lastmod}</lastmod>`] : []),
        '  </url>',
      ].join('\n')
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

const siteUrl = loadSiteUrl();
const sitemap = generateSitemap(siteUrl);

const outDir = resolve(__dirname, '../dist/client');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'sitemap.xml'), sitemap);

// robots.txt is a static public/ file (Vite copies it verbatim, so its
// `Sitemap:` line still carries the create-time {{SITE_URL}} → localhost).
// Rewrite it to the real base URL now that we know it.
try {
  const robotsPath = resolve(outDir, 'robots.txt');
  const robots = readFileSync(robotsPath, 'utf-8');
  const fixed = robots.replace(/^Sitemap:.*$/m, `Sitemap: ${siteUrl}/sitemap.xml`);
  if (fixed !== robots) writeFileSync(robotsPath, fixed);
} catch {
  // No robots.txt in dist — nothing to fix.
}

const totalUrls = PUBLIC_ROUTES.length + blogPages.length + changelogPages.length + docsPages.length;
console.log(
  `Sitemap generated with ${totalUrls} URLs (${blogPages.length} blog, ${changelogPages.length} changelog, ${docsPages.length} docs) → dist/client/sitemap.xml`
);
