/**
 * Which client routes search engines may index.
 *
 * The production server answers every page request with the SPA shell, so
 * it has to decide the HTTP status and indexing signal per path:
 *
 *   - Pages in the build-time SEO manifest (scripts/generate-seo.ts) are
 *     indexable: 200 with per-route title, canonical and content.
 *   - Paths matching PRIVATE_ROUTES are real pages that don't belong in
 *     search results (auth flows, the signed-in app, admin, previews):
 *     200 with `X-Robots-Tag: noindex`.
 *   - Everything else is a 404. The SPA still renders its NotFound page.
 *
 * Adding a page in src/client/App.tsx? Either give it a manifest entry in
 * scripts/generate-seo.ts (public, indexable) or list it here. The structural
 * test tests/structural/route-indexing.test.ts fails until you do, because an
 * unclassified route would 404 on a hard load.
 *
 * Patterns are exact paths, or a prefix ending in `/*` that matches the
 * prefix itself and everything below it.
 */
export const PRIVATE_ROUTES: readonly string[] = [
  // Auth flows (login and signup themselves are indexable landing pages)
  '/forgot-password',
  '/reset-password',
  '/mfa-verify',
  '/auth/callback',
  // Signed-in app
  '/onboarding',
  '/checkout',
  '/dashboard',
  '/ui-components',
  '/charts',
  '/settings/*',
  '/organizations/*',
  '/admin/*',
  // API reference viewer (robots.txt already disallows /api/)
  '/api/docs',
  // Work-in-progress homepage preview
  '/home-preview',
];

/** True when `path` matches any pattern in `patterns`. */
export function matchesRoute(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (!pattern.endsWith('/*')) return path === pattern;
    const base = pattern.slice(0, -2);
    return path === base || path.startsWith(`${base}/`);
  });
}
