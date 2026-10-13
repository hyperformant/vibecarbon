import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchesRoute, PRIVATE_ROUTES } from '../../src/shared/routes';

// Structural invariant: every route in App.tsx is classified for search.
//
// The production server decides each page's HTTP status from two sources:
// the SEO manifest built by scripts/generate-seo.ts (200, indexable) and
// PRIVATE_ROUTES in src/shared/routes.ts (200, noindex). Any other path is a
// 404. A page added to App.tsx without either would still render in the
// browser, but a hard load or a crawler would get a 404, which nobody
// notices in review. This test makes that a build failure instead.
//
// Like the docs-link gating test, it reads source rather than running the
// build: coarse by design, but it fails the moment an unclassified route
// appears.

const ROOT = join(import.meta.dirname, '../..');
const appSource = readFileSync(join(ROOT, 'src/client/App.tsx'), 'utf8');
const seoSource = readFileSync(join(ROOT, 'scripts/generate-seo.ts'), 'utf8');

/** Every `<Route path="...">` in App.tsx, minus the catch-all. */
const appRoutes = [...appSource.matchAll(/<Route\s[^>]*?path="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((path) => path !== '*');

/** Static manifest routes: `routes['/x'] = ...` in generate-seo.ts. */
const manifestRoutes = [...seoSource.matchAll(/routes\['(\/[^']*)'\]\s*=/g)].map((m) => m[1]);

/** Content collections: `loadDir('content/x', '/x')` puts every page at `/x/:slug`. */
const contentPrefixes = [...seoSource.matchAll(/loadDir\('[^']+',\s*'(\/[^']+)'\)/g)].map(
  (m) => m[1]
);

/** Legal aliases: `'privacy-policy': '/privacy'`. */
const legalAliases = [...seoSource.matchAll(/'[\w-]+':\s*'(\/[\w-]+)',/g)].map((m) => m[1]);

function isIndexed(path: string): boolean {
  if (manifestRoutes.includes(path) || legalAliases.includes(path)) return true;
  const slug = path.match(/^(\/.+)\/:[\w]+$/);
  return slug !== null && contentPrefixes.includes(slug[1]);
}

describe('route indexing classification', () => {
  it('finds the routes it is checking (guards the regexes themselves)', () => {
    expect(appRoutes).toContain('/');
    expect(appRoutes).toContain('/dashboard');
    expect(manifestRoutes).toContain('/pricing');
    expect(contentPrefixes).toEqual(expect.arrayContaining(['/docs', '/blog']));
  });

  it('classifies every App.tsx route as indexed (SEO manifest) or private (PRIVATE_ROUTES)', () => {
    const unclassified = appRoutes.filter(
      (path) => !isIndexed(path) && !matchesRoute(path.replace(/\/:[\w]+.*$/, '/x'), PRIVATE_ROUTES)
    );
    expect(
      unclassified,
      'These routes would 404 on a hard load. Add a manifest entry in scripts/generate-seo.ts ' +
        'for a public page, or add the path to PRIVATE_ROUTES in src/shared/routes.ts.'
    ).toEqual([]);
  });

  it('never marks an indexed route private', () => {
    const both = appRoutes.filter((path) => isIndexed(path) && matchesRoute(path, PRIVATE_ROUTES));
    expect(both).toEqual([]);
  });
});
