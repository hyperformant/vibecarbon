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

import { readFileSync } from 'node:fs';
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
}

/**
 * Loads the built shell and route metadata once, at first request. Both files
 * are read relative to the working directory, matching serveStatic's
 * `./dist/client` root. A missing manifest degrades to the plain shell for
 * every route; a missing shell degrades to the pre-existing 404 behavior.
 */
export function createSeoShell(
  shellPath = './dist/client/index.html',
  manifestPath = './dist/seo/route-meta.json'
): SeoShell {
  let loaded = false;
  let shell: string | null = null;
  let routes: Record<string, RouteSeo> = {};

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
    } catch (err) {
      logger.warn({ err, manifestPath }, 'SEO route manifest missing; serving plain SPA shell');
    }
  };

  return {
    render(path: string): string | null {
      if (!loaded) load();
      if (shell === null) return null;
      const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
      const meta = routes[normalized];
      return meta ? injectSeo(shell, meta) : shell;
    },
  };
}
