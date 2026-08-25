/**
 * Build-time SEO/GEO artifact generator.
 *
 * Run: npx tsx scripts/generate-seo.ts (after `vite build`)
 *
 * AI crawlers (GPTBot, ClaudeBot, PerplexityBot) fetch raw HTML and never
 * execute JavaScript, so a bare SPA shell is invisible to them. This script
 * produces everything the Hono server needs to serve real content without
 * prerendering the React app:
 *
 *   dist/client/llms.txt          — llms.txt index (llmstxt.org convention)
 *   dist/client/llms-full.txt     — all docs + blog as one markdown file
 *   dist/client/{blog,docs,changelog}/<slug>.md — per-page markdown mirrors
 *   dist/seo/route-meta.json      — route → {title, description, html, jsonLd}
 *                                   consumed by src/server/lib/seo.ts, which
 *                                   injects it into the SPA shell per request
 *
 * Everything here is generated from repo-controlled content (content/*.mdx and
 * src/client/index.html), so the HTML it emits is trusted and injected
 * verbatim by the server. Never feed user input into these strings.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readIfPresent(relPath: string): string | null {
  try {
    return readFileSync(resolve(__dirname, '..', relPath), 'utf-8');
  } catch {
    return null;
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

// src/client/index.html is the create-time-substituted, owner-editable source
// for the site's name and description. Reading it here (rather than
// duplicating the copy) is what keeps the crawler-facing metadata and the
// browser-facing metadata from drifting apart when someone rebrands.
const indexHtml = readIfPresent('src/client/index.html');

/**
 * Human-facing brand name. Files under scripts/ are upgrade-managed, so this
 * one must not hardcode a create-time display-name placeholder of its own — a
 * `vibecarbon upgrade` replaces the file wholesale. Resolve the name from the
 * places that do record it instead: the environment, .env.local, then the
 * <title> in index.html — the last of which is what survives into the Docker
 * build, where .env.local is absent by design.
 */
function loadSiteName(): string {
  const fromEnv = process.env.VITE_PROJECT_DISPLAY_NAME || process.env.PROJECT_DISPLAY_NAME;
  if (fromEnv) return fromEnv;
  const envLocal = readIfPresent('.env.local');
  const recorded = envLocal?.match(
    /^(?:PROJECT_DISPLAY_NAME|VITE_PROJECT_DISPLAY_NAME)=["']?(.+?)["']?\s*$/m
  );
  if (recorded) return recorded[1];
  const title = indexHtml?.match(/<title>([^<]*)<\/title>/);
  if (title?.[1]?.trim()) return decodeHtmlEntities(title[1]);
  return 'My SaaS';
}

const SITE_NAME = loadSiteName();

/** Site-wide description, from the same `<meta name="description">` the browser gets. */
function loadSiteDescription(): string {
  const match = indexHtml?.match(/<meta\s+name="description"\s+content="([^"]*)"/);
  if (match?.[1]) return decodeHtmlEntities(match[1]);
  return `${SITE_NAME} — product documentation, blog, and changelog.`;
}

const SITE_DESCRIPTION = loadSiteDescription();

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

function parseFrontmatter(content: string): { fm: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { fm: {}, body: content };
  const fm: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) {
      fm[key.trim()] = rest.join(':').trim().replace(/^["']|["']$/g, '');
    }
  }
  return { fm, body: content.slice(match[0].length) };
}

interface ContentPage {
  slug: string;
  route: string;
  title: string;
  description: string;
  date?: string;
  author?: string;
  order: number;
  body: string;
}

function loadDir(dir: string, routePrefix: string): ContentPage[] {
  let files: string[] = [];
  try {
    files = readdirSync(resolve(__dirname, '..', dir)).filter((f) => f.endsWith('.mdx'));
  } catch {
    return [];
  }
  return files
    .map((file) => {
      const slug = file.replace('.mdx', '');
      const raw = readFileSync(resolve(__dirname, '..', dir, file), 'utf-8');
      const { fm, body } = parseFrontmatter(raw);
      return {
        slug,
        route: `${routePrefix}/${slug}`,
        title: fm.title || slug,
        description: fm.description || '',
        date: fm.date,
        author: fm.author,
        order: Number(fm.order ?? 999),
        body,
      };
    })
    .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
}

const markdownToHtml = (() => {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeStringify);
  return (markdown: string): string => String(processor.processSync(markdown));
})();

/** Page markdown mirror: frontmatter title as H1 unless the body already opens with one. */
function pageMarkdown(page: ContentPage): string {
  const hasH1 = /^#\s/.test(page.body.trimStart());
  const header = hasH1 ? '' : `# ${page.title}\n\n`;
  const intro = page.description ? `> ${page.description}\n\n` : '';
  return `${header}${intro}${page.body.trimStart()}`;
}

// ============================================================================
// Route metadata (consumed by src/server/lib/seo.ts)
// ============================================================================

interface RouteSeo {
  title: string;
  description: string;
  canonical: string;
  html?: string;
  jsonLd?: Record<string, unknown>;
}

// Matches src/client/components/SEO.tsx: `<title>` is "<page> | <site>", and
// the homepage (which renders <SEO> without a title) is the bare site name.
const fullTitle = (title: string) => `${title} | ${SITE_NAME}`;

// HTML-escape for values interpolated into the raw `html` blocks built here.
// The title/description FIELDS of route-meta.json are escaped at serve time by
// src/server/lib/seo.ts, but the `html` field is injected verbatim — so
// frontmatter values and the runtime-resolved site name/description must be
// escaped at this sink.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function linkListHtml(siteUrl: string, pages: ContentPage[]): string {
  const items = pages
    .map(
      (p) =>
        `<li><a href="${escapeHtml(`${siteUrl}${p.route}`)}">${escapeHtml(p.title)}</a>${p.description ? ` — ${escapeHtml(p.description)}` : ''}</li>`
    )
    .join('\n');
  return `<ul>\n${items}\n</ul>`;
}

// Crawler-visible homepage summary, injected into the SPA shell's #root and
// replaced the moment React hydrates — so browser users never see it.
//
// EDIT THIS. It is a neutral placeholder. Crawlers that don't run JavaScript
// (GPTBot, ClaudeBot, PerplexityBot, Bingbot) see *only* what is in this
// block for `/`, so it should say, in plain prose, what your product is, who
// it is for, and what someone can do with it. Keep it in sync with the hero
// copy in src/client/pages/Home.tsx.
const HOME_HTML = `
<main>
  <h1>${escapeHtml(SITE_NAME)}</h1>
  <p>${escapeHtml(SITE_DESCRIPTION)}</p>
  <p>Replace this paragraph with a short, factual description of ${escapeHtml(SITE_NAME)}: what it does, who it is for, and what a visitor can do here. This block is what AI crawlers read instead of the JavaScript-rendered homepage.</p>
  <p><a href="/docs">Documentation</a> · <a href="/pricing">Pricing</a> · <a href="/blog">Blog</a> · <a href="/contact">Contact</a></p>
</main>
`.trim();

function buildRouteMeta(
  siteUrl: string,
  docs: ContentPage[],
  blog: ContentPage[],
  changelog: ContentPage[],
  legal: ContentPage[]
): Record<string, RouteSeo> {
  const canonical = (route: string) => `${siteUrl}${route === '/' ? '' : route}`;
  const routes: Record<string, RouteSeo> = {};

  routes['/'] = {
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    canonical: canonical('/'),
    html: HOME_HTML,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: SITE_NAME,
      description: SITE_DESCRIPTION,
      url: siteUrl,
    },
  };

  // Static marketing/auth routes. Keep these descriptions in sync with the
  // <SEO> props on the matching page in src/client/pages/.
  routes['/pricing'] = {
    title: fullTitle('Pricing'),
    description:
      'Every price is on this page. Start free, upgrade when you outgrow it, and change or cancel your plan yourself.',
    canonical: canonical('/pricing'),
  };
  routes['/contact'] = {
    title: fullTitle('Contact'),
    description: 'Get in touch with us.',
    canonical: canonical('/contact'),
  };
  routes['/login'] = {
    title: fullTitle('Log in'),
    description: `Log in to your ${SITE_NAME} account.`,
    canonical: canonical('/login'),
  };
  routes['/signup'] = {
    title: fullTitle('Sign up'),
    description: `Create a ${SITE_NAME} account.`,
    canonical: canonical('/signup'),
  };

  routes['/blog'] = {
    title: fullTitle('Blog'),
    description: `Latest updates and guides from ${SITE_NAME}.`,
    canonical: canonical('/blog'),
    html: `<main><h1>${escapeHtml(SITE_NAME)} Blog</h1>${linkListHtml(siteUrl, blog)}</main>`,
  };
  routes['/docs'] = {
    title: fullTitle('Documentation'),
    description: `${SITE_NAME} documentation — setup, guides, and reference.`,
    canonical: canonical('/docs'),
    html: `<main><h1>${escapeHtml(SITE_NAME)} Documentation</h1>${linkListHtml(siteUrl, docs)}</main>`,
  };
  routes['/changelog'] = {
    title: fullTitle('Changelog'),
    description: `What's new in ${SITE_NAME}.`,
    canonical: canonical('/changelog'),
    html: `<main><h1>${escapeHtml(SITE_NAME)} Changelog</h1>${linkListHtml(siteUrl, changelog)}</main>`,
  };

  for (const post of blog) {
    routes[post.route] = {
      title: fullTitle(post.title),
      description: post.description,
      canonical: canonical(post.route),
      html: `<main><article>${markdownToHtml(pageMarkdown(post))}</article></main>`,
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: post.title,
        description: post.description,
        url: canonical(post.route),
        ...(post.date ? { datePublished: post.date } : {}),
        author: { '@type': 'Organization', name: SITE_NAME },
      },
    };
  }
  for (const page of docs) {
    routes[page.route] = {
      title: fullTitle(page.title),
      description: page.description,
      canonical: canonical(page.route),
      html: `<main><article>${markdownToHtml(pageMarkdown(page))}</article></main>`,
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'TechArticle',
        headline: page.title,
        description: page.description,
        url: canonical(page.route),
      },
    };
  }
  for (const entry of changelog) {
    routes[entry.route] = {
      title: fullTitle(entry.title),
      description: entry.description,
      canonical: canonical(entry.route),
      html: `<main><article>${markdownToHtml(pageMarkdown(entry))}</article></main>`,
    };
  }
  // Legal pages live at path aliases (/privacy, /terms) and /legal/:slug —
  // mirroring `pathToSlug` in src/client/pages/Legal.tsx.
  const legalAliases: Record<string, string> = {
    'privacy-policy': '/privacy',
    'terms-of-service': '/terms',
  };
  for (const page of legal) {
    // Object.hasOwn: a slug like "constructor" must not resolve through the
    // prototype chain to a function.
    const alias = Object.hasOwn(legalAliases, page.slug) ? legalAliases[page.slug] : undefined;
    const targets = [`/legal/${page.slug}`, alias].filter(Boolean) as string[];
    for (const route of targets) {
      routes[route] = {
        title: fullTitle(page.title),
        description: page.description,
        canonical: canonical(alias ?? route),
        html: `<main><article>${markdownToHtml(pageMarkdown(page))}</article></main>`,
      };
    }
  }
  return routes;
}

// ============================================================================
// llms.txt / llms-full.txt
// ============================================================================

function llmsSection(siteUrl: string, heading: string, pages: ContentPage[]): string {
  if (!pages.length) return '';
  const lines = pages.map(
    (p) => `- [${p.title}](${siteUrl}${p.route}.md)${p.description ? `: ${p.description}` : ''}`
  );
  return `## ${heading}\n\n${lines.join('\n')}\n\n`;
}

function buildLlmsTxt(
  siteUrl: string,
  docs: ContentPage[],
  blog: ContentPage[],
  changelog: ContentPage[]
): string {
  return `# ${SITE_NAME}

> ${SITE_DESCRIPTION}

${llmsSection(siteUrl, 'Docs', docs)}${llmsSection(siteUrl, 'Blog', blog)}${llmsSection(siteUrl, 'Changelog', changelog)}## Optional

- [Full documentation as a single file](${siteUrl}/llms-full.txt)
`;
}

function buildLlmsFullTxt(
  siteUrl: string,
  docs: ContentPage[],
  blog: ContentPage[],
  changelog: ContentPage[]
): string {
  const sections = [...docs, ...blog, ...changelog].map(
    (p) => `<!-- Source: ${siteUrl}${p.route} -->\n\n${pageMarkdown(p)}`
  );
  return `# ${SITE_NAME} — full documentation\n\n> ${SITE_DESCRIPTION}\n\n${sections.join('\n\n---\n\n')}\n`;
}

// ============================================================================
// Main
// ============================================================================

const siteUrl = loadSiteUrl();
const docs = loadDir('content/docs', '/docs');
const blog = loadDir('content/blog', '/blog');
const changelog = loadDir('content/changelog', '/changelog');
const legal = loadDir('content/docs/legal', '/legal');

const clientDir = resolve(__dirname, '../dist/client');
const seoDir = resolve(__dirname, '../dist/seo');
mkdirSync(clientDir, { recursive: true });
mkdirSync(seoDir, { recursive: true });

writeFileSync(resolve(clientDir, 'llms.txt'), buildLlmsTxt(siteUrl, docs, blog, changelog));
writeFileSync(
  resolve(clientDir, 'llms-full.txt'),
  buildLlmsFullTxt(siteUrl, docs, blog, changelog)
);

// Per-page markdown mirrors so llms.txt links resolve to clean markdown.
for (const page of [...docs, ...blog, ...changelog]) {
  const outPath = resolve(clientDir, `${page.route.slice(1)}.md`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, pageMarkdown(page));
}

const routes = buildRouteMeta(siteUrl, docs, blog, changelog, legal);
writeFileSync(
  resolve(seoDir, 'route-meta.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), siteUrl, routes }, null, 2)
);

console.log(
  `SEO artifacts generated: llms.txt (${docs.length} docs, ${blog.length} blog, ${changelog.length} changelog), llms-full.txt, ${docs.length + blog.length + changelog.length} markdown mirrors, ${Object.keys(routes).length} route metas → dist/`
);
