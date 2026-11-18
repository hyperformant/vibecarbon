/**
 * Shared helpers for the build-time SEO generators
 * (scripts/generate-seo.ts, scripts/generate-sitemap.ts, scripts/generate-rss.ts).
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFiles } from './dotenv.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let cachedFileEnv: Record<string, string> | undefined;

/**
 * A build setting. The shell env wins (a blank export falls through), then
 * .env.local over .env (readEnvFiles layers those two). Production builds
 * receive these as build args (no .env.local in the image); locally this
 * falls back to whatever the project's .env files hold. The files are read on
 * first use, not on import.
 */
export function getEnvValue(key: string): string | null {
  const fileEnv = (cachedFileEnv ??= readEnvFiles(projectRoot));
  return process.env[key] || fileEnv[key] || null;
}

/** The site's public origin, without a trailing slash. */
export function loadSiteUrl(): string {
  const value = getEnvValue('VITE_PUBLIC_URL') || getEnvValue('SITE_URL');
  return (value || 'http://localhost:5173').replace(/\/$/, '');
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * Human-facing brand name (package.json `name` is the npm slug, never the
 * brand). Files under scripts/ are upgrade-managed, so they must not
 * hardcode a create-time display-name placeholder of their own: a
 * `vibecarbon upgrade` replaces them wholesale. Resolve the name from the
 * places that do record it instead: the environment, .env.local, then the
 * <title> in index.html (`indexHtml`, null when the file is missing), the
 * last of which is what survives into the Docker build, where .env.local is
 * absent by design.
 */
export function loadSiteName(indexHtml: string | null): string {
  const fromEnv = getEnvValue('VITE_PROJECT_DISPLAY_NAME') || getEnvValue('PROJECT_DISPLAY_NAME');
  if (fromEnv) return fromEnv;
  const title = indexHtml?.match(/<title>([^<]*)<\/title>/);
  if (title?.[1]?.trim()) return decodeHtmlEntities(title[1]);
  return 'My SaaS';
}

export function parseFrontmatter(content: string): { fm: Record<string, string>; body: string } {
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

/** Pages marked `draft: true` never reach crawler-facing artifacts. */
export function isDraft(fm: Record<string, string>): boolean {
  return fm.draft === 'true';
}

/**
 * Replace MDX prop expressions like `{props.projectName}` with concrete
 * values. The client evaluates these as JSX at render time (see
 * src/client/pages/Legal.tsx), but the generators feed raw markdown to
 * remark, which would pass the tokens through verbatim into crawler HTML.
 * Unknown props are left untouched so they stay visible in review.
 */
export function substituteMdxProps(body: string, props: Record<string, string>): string {
  // Replacement function, not string: values containing $-patterns ($&, $1,
  // $$) must survive verbatim. Object.hasOwn: `{props.constructor}` must not
  // resolve through the prototype chain.
  return body.replace(/\{props\.([A-Za-z_$][\w$]*)\}/g, (token, key: string) =>
    Object.hasOwn(props, key) ? props[key] : token
  );
}
