/**
 * Per-route SEO injection for the production SPA fallback.
 *
 * AI and search crawlers fetch raw HTML without executing JavaScript, so
 * serving the bare SPA shell makes every page look empty to them. The crawlers
 * this app recognises (GPTBot, ClaudeBot, PerplexityBot, OAI-SearchBot,
 * Bingbot, Googlebot and the rest) are enumerated in `lib/crawlers.ts` — that
 * registry is the source of truth, and the middleware that records their hits
 * for the admin "AI Visibility" page reads the same list.
 *
 * Instead of prerendering the React app, the server
 * splices per-route metadata and content — generated at build time by
 * scripts/generate-seo.ts from the same MDX the client renders — into the
 * shell. Hydration replaces #root, so browser users see the SPA unchanged.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Context } from 'hono';
import { matchesRoute, PRIVATE_ROUTES } from '../../shared/routes';
import { logger } from './logger';

export interface RouteSeo {
  title: string;
  description: string;
  canonical?: string;
  /** Build-time rendered HTML from repo-controlled MDX — trusted, injected verbatim. */
  html?: string;
  jsonLd?: Record<string, unknown>;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Serialize JSON-LD so `</script>` (or any tag) in data can't break out of the script element. */
function serializeJsonLd(jsonLd: Record<string, unknown>): string {
  return JSON.stringify(jsonLd).replace(/</g, '\\u003c');
}

function replaceMetaContent(html: string, attr: string, key: string, value: string): string {
  const pattern = new RegExp(
    `(<meta ${attr}="${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" content=")[^"]*(")`
  );
  // Replacement FUNCTIONS everywhere in this file: a replacement string would
  // expand $-patterns ($1, $&, $`, $', $$) in the spliced value AFTER
  // escapeHtml/serializeJsonLd ran, silently bypassing both (e.g. "$1" in a
  // description, or "$$" in SQL docs, corrupts or injects markup).
  return html.replace(
    pattern,
    (_match, open: string, close: string) => `${open}${escapeHtml(value)}${close}`
  );
}

/** Pure shell transform — exported for unit tests. */
export function injectSeo(shell: string, meta: RouteSeo): string {
  let out = shell;
  out = out.replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(meta.title)}</title>`);
  out = replaceMetaContent(out, 'name', 'description', meta.description);
  out = replaceMetaContent(out, 'property', 'og:title', meta.title);
  out = replaceMetaContent(out, 'property', 'og:description', meta.description);
  out = replaceMetaContent(out, 'name', 'twitter:title', meta.title);
  out = replaceMetaContent(out, 'name', 'twitter:description', meta.description);

  const headExtras: string[] = [];
  if (meta.canonical) {
    out = replaceMetaContent(out, 'property', 'og:url', meta.canonical);
    headExtras.push(`<link rel="canonical" href="${escapeHtml(meta.canonical)}" />`);
  }
  if (meta.jsonLd) {
    headExtras.push(`<script type="application/ld+json">${serializeJsonLd(meta.jsonLd)}</script>`);
  }
  if (headExtras.length) {
    out = out.replace('</head>', () => `  ${headExtras.join('\n    ')}\n  </head>`);
  }
  if (meta.html) {
    // <noscript>: browsers never paint the crawler content (no flash of
    // unstyled text before hydration); non-JS crawlers read the text as-is.
    // A literal </noscript> inside the content would end the element early and
    // let the rest parse as live HTML — neutralize it (trusted MDX today, but
    // a docs page quoting a <noscript> example must not break the page).
    const safeHtml = meta.html.replace(/<\/noscript/gi, () => '&lt;/noscript');
    out = out.replace(
      '<div id="root"></div>',
      () => `<div id="root"><noscript>${safeHtml}</noscript></div>`
    );
  }
  return out;
}

interface SeoShell {
  /** Injected (or plain, for unknown routes) shell HTML; null if the shell itself is unreadable. */
  render(path: string): string | null;
  /**
   * Hono handler: serves the rendered shell with a content-hash ETag and
   * answers If-None-Match revalidations with 304. Rendered HTML and its ETag
   * are memoized per route (bounded: known routes + the plain shell).
   *
   * Status follows src/shared/routes.ts: manifest routes are 200 and
   * indexable, private routes are 200 with `X-Robots-Tag: noindex`, and any
   * other path is a 404 (the SPA still renders its NotFound page). Without a
   * readable manifest every route is served 200, as before, so a broken build
   * never 404s the whole site.
   */
  handler(c: Context): Response | Promise<Response>;
}

/**
 * Loads the built shell and route metadata once, at first request. Both files
 * are read relative to the working directory, matching serveStatic's
 * `./dist/client` root. A missing manifest degrades to the plain shell for
 * every route; a missing shell degrades to the pre-existing 404 behavior.
 */
export function createSeoShell(
  shellPath = './dist/client/index.html',
  manifestPath = './dist/seo/route-meta.json',
  privateRoutes: readonly string[] = PRIVATE_ROUTES
): SeoShell {
  let loaded = false;
  let shell: string | null = null;
  let routes: Record<string, RouteSeo> = {};
  let manifestLoaded = false;

  const load = () => {
    loaded = true;
    try {
      shell = readFileSync(shellPath, 'utf-8');
    } catch (err) {
      logger.error({ err, shellPath }, 'SPA shell not readable; fallback route will 404');
      return;
    }
    try {
      // Null-prototype object: keeps a future refactor of the lookup key from
      // ever colliding with Object.prototype members.
      routes = Object.assign(
        Object.create(null),
        JSON.parse(readFileSync(manifestPath, 'utf-8')).routes ?? {}
      );
      manifestLoaded = true;
    } catch (err) {
      logger.warn({ err, manifestPath }, 'SEO route manifest missing; serving plain SPA shell');
    }
  };

  const rendered = new Map<string, { html: string; etag: string }>();

  type Visibility = 'indexed' | 'private' | 'missing';

  const renderResult = (
    path: string
  ): { html: string; etag: string; visibility: Visibility } | null => {
    if (!loaded) load();
    if (shell === null) return null;
    const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
    const meta = routes[normalized];
    const visibility: Visibility =
      meta || !manifestLoaded
        ? 'indexed'
        : matchesRoute(normalized, privateRoutes)
          ? 'private'
          : 'missing';
    // Unknown routes all share the plain-shell entry, so the cache stays
    // bounded by the manifest size + 1.
    const key = meta ? normalized : '';
    let entry = rendered.get(key);
    if (!entry) {
      const html = meta ? injectSeo(shell, meta) : shell;
      entry = { html, etag: `"${createHash('sha256').update(html).digest('hex').slice(0, 32)}"` };
      rendered.set(key, entry);
    }
    return { ...entry, visibility };
  };

  return {
    render(path: string): string | null {
      return renderResult(path)?.html ?? null;
    },
    handler(c: Context): Response | Promise<Response> {
      const result = renderResult(c.req.path);
      if (result === null) return c.notFound();
      c.header('Cache-Control', 'no-cache');
      // A real 404 (not a 200 "soft 404"): search engines drop the URL
      // instead of indexing a blank, canonical-less copy of the shell.
      if (result.visibility === 'missing') return c.html(result.html, 404);
      if (result.visibility === 'private') c.header('X-Robots-Tag', 'noindex');
      c.header('ETag', result.etag);
      const ifNoneMatch = c.req.header('If-None-Match');
      if (
        ifNoneMatch &&
        (ifNoneMatch.trim() === '*' ||
          ifNoneMatch.split(',').some((tag) => tag.trim() === result.etag))
      ) {
        return c.body(null, 304);
      }
      return c.html(result.html);
    },
  };
}
