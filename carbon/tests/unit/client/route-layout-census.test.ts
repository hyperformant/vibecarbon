import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasExplicitLayout } from '@/lib/route-layout';

// Family-sweep guard: every route that renders inside the sidebar shell shares
// the ContentSkeleton Suspense fallback, so each must have an explicit width in
// route-layout.ts — otherwise its loading skeleton falls back to `default` and
// mismatches the page. This test reads App.tsx so a newly added sidebar page
// fails here until it's mapped.

const appSource = readFileSync(resolve(process.cwd(), 'src/client/App.tsx'), 'utf8');

const SIDEBAR_ROOTS = [
  '/dashboard',
  '/ui-components',
  '/charts',
  '/settings',
  '/organizations',
  '/admin',
];

function isSidebarPath(path: string): boolean {
  return SIDEBAR_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

// `<Route path="X" element={<Component ...` — skip redirect routes (Navigate),
// which render no ContentPanel.
function sidebarPageRoutes(): string[] {
  const out: string[] = [];
  for (const m of appSource.matchAll(/<Route\s+path="([^"]+)"\s+element=\{<(\w+)/g)) {
    const [, path, component] = m;
    if (component === 'Navigate') continue;
    if (isSidebarPath(path)) out.push(path);
  }
  return out;
}

describe('route-layout census', () => {
  it('locates the sidebar page routes in App.tsx', () => {
    // Guards against a regex that silently matches nothing (which would make the
    // coverage assertion below vacuously pass).
    expect(sidebarPageRoutes().length).toBeGreaterThanOrEqual(10);
  });

  it('gives every sidebar page route an explicit width mapping', () => {
    const missing = sidebarPageRoutes().filter((p) => !hasExplicitLayout(p));
    expect(missing).toEqual([]);
  });
});
