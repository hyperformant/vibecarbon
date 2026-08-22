/**
 * Build-time sitemap generator.
 *
 * Run: npx tsx scripts/generate-sitemap.ts
 *
 * Reads SITE_URL from .env.local and outputs sitemap.xml to dist/client/.
 * Includes static routes and dynamic blog post routes.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Public routes that should be indexed
const PUBLIC_ROUTES = ['/', '/login', '/signup', '/blog', '/changelog', '/docs'];

function loadSiteUrl(): string {
  // Production builds receive the apex URL as VITE_PUBLIC_URL (a build arg);
  // .env.local is not present in the image. Locally, fall back to .env.local.
  if (process.env.VITE_PUBLIC_URL) return process.env.VITE_PUBLIC_URL.replace(/\/$/, '');
  try {
    const envContent = readFileSync(resolve(__dirname, '../.env.local'), 'utf-8');
    const match = envContent.match(/^(?:VITE_PUBLIC_URL|SITE_URL)=["']?(.+?)["']?\s*$/m);
    if (match) return match[1].replace(/\/$/, '');
  } catch {
    // .env.local may not exist in CI
  }
  return (process.env.SITE_URL || 'http://localhost:5173').replace(/\/$/, '');
}

function getBlogSlugs(): string[] {
  try {
    const blogDir = resolve(__dirname, '../content/blog');
    return readdirSync(blogDir)
      .filter((f) => f.endsWith('.mdx'))
      .map((f) => f.replace('.mdx', ''));
  } catch {
    return [];
  }
}

function getChangelogSlugs(): string[] {
  try {
    const changelogDir = resolve(__dirname, '../content/changelog');
    return readdirSync(changelogDir)
      .filter((f) => f.endsWith('.mdx'))
      .map((f) => f.replace('.mdx', ''));
  } catch {
    return [];
  }
}

function getDocsSlugs(): string[] {
  try {
    const docsDir = resolve(__dirname, '../content/docs');
    return readdirSync(docsDir)
      .filter((f) => f.endsWith('.mdx'))
      .map((f) => f.replace('.mdx', ''));
  } catch {
    return [];
  }
}

function generateSitemap(siteUrl: string): string {
  const today = new Date().toISOString().split('T')[0];
  const blogSlugs = getBlogSlugs();
  const changelogSlugs = getChangelogSlugs();
  const docsSlugs = getDocsSlugs();
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

const blogCount = getBlogSlugs().length;
const changelogCount = getChangelogSlugs().length;
const docsCount = getDocsSlugs().length;
const totalUrls = PUBLIC_ROUTES.length + blogCount + changelogCount + docsCount;
console.log(`Sitemap generated with ${totalUrls} URLs (${blogCount} blog, ${changelogCount} changelog, ${docsCount} docs) → dist/client/sitemap.xml`);
