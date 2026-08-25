import type { LayoutVariant } from '@/components/ContentPanel';

/**
 * Route → content width mapping for the sidebar app.
 *
 * The lazy-route Suspense fallback (ContentSkeleton) renders *before* the page
 * chunk loads, so it can't read the page's own `<ContentPanel variant>`. It can,
 * however, derive the width from the URL — this map is that lookup, keeping the
 * loading skeleton the same width as the page it stands in for.
 *
 * KEEP IN SYNC with each page's `<ContentPanel variant>`. The census test
 * (tests/unit/client/route-layout-census.test.ts) fails if a sidebar route in
 * App.tsx has no explicit entry here.
 *
 * Matching is longest-prefix by list order: an entry matches when the pathname
 * equals it or begins with `${entry}/`. List more specific prefixes anywhere —
 * `/admin/settings` and `/settings` never collide because neither is a prefix
 * of the other.
 */
const ROUTE_VARIANTS: Array<readonly [string, LayoutVariant]> = [
  ['/dashboard', 'full'],
  ['/ui-components', 'full'],
  ['/charts', 'full'],
  ['/settings', 'narrow'],
  ['/organizations', 'default'],
  ['/admin/dashboard', 'full'],
  ['/admin/organizations', 'full'],
  ['/admin/users', 'full'],
  ['/admin/notifications', 'full'],
  ['/admin/logs', 'default'],
  ['/admin/infrastructure', 'default'],
  ['/admin/theme', 'wide'],
  ['/admin/jobs', 'default'],
  ['/admin/crawlers', 'full'],
  ['/admin/contact', 'default'],
  ['/admin/newsletter', 'default'],
  ['/admin/settings', 'default'],
];

function matchEntry(pathname: string): LayoutVariant | undefined {
  const hit = ROUTE_VARIANTS.find(
    ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
  return hit?.[1];
}

/** Content width variant for a route, defaulting to `default` when unmapped. */
export function layoutVariantForPath(pathname: string): LayoutVariant {
  return matchEntry(pathname) ?? 'default';
}

/** Whether a route has an explicit width mapping (vs. the fallback). */
export function hasExplicitLayout(pathname: string): boolean {
  return matchEntry(pathname) !== undefined;
}
