/**
 * Classifies hrefs that point at one of the two documentation surfaces.
 *
 * Components that render link lists (nav, footer, hero CTAs, setup guides)
 * filter through these rather than hard-coding path checks, so a link added
 * later is gated by construction instead of by remembering to gate it. The
 * structural test in tests/structural/docs-link-gating.test.ts enforces that
 * every `/docs` or `/api/docs` href in client source sits behind one of
 * these checks or an explicit visibility flag.
 */

/** The API reference route. Kept distinct from `/docs` — it is a separate toggle. */
const API_DOCS_PATH = '/api/docs';

/** True for the API reference route and anything nested under it. */
export function isApiDocsHref(href: string): boolean {
  return href === API_DOCS_PATH || href.startsWith(`${API_DOCS_PATH}/`);
}

/**
 * True for the user documentation site and any page within it.
 *
 * `/api/docs` is deliberately excluded: it starts with neither `/docs` nor
 * `/docs/`, but the check is written to be explicit about that so a future
 * reader does not "fix" it into swallowing the API route.
 */
export function isUserDocsHref(href: string): boolean {
  if (isApiDocsHref(href)) return false;
  return href === '/docs' || href.startsWith('/docs/');
}

/**
 * Whether a link should render, given the current visibility settings.
 * Non-docs hrefs (external URLs, other routes) always pass through.
 */
export function isDocsHrefVisible(
  href: string,
  { userDocsEnabled, apiDocsEnabled }: { userDocsEnabled: boolean; apiDocsEnabled: boolean }
): boolean {
  if (isUserDocsHref(href)) return userDocsEnabled;
  if (isApiDocsHref(href)) return apiDocsEnabled;
  return true;
}
