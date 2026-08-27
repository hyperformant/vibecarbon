/**
 * Guards for the template's AI-search/SEO pipeline.
 *
 *   carbon/scripts/generate-seo.ts  writes dist/client/llms{,-full}.txt, per-page
 *                                   markdown mirrors, and dist/seo/route-meta.json
 *   carbon/src/server/lib/seo.ts    reads the shell + that manifest at runtime and
 *                                   splices per-route metadata into the SPA shell
 *
 * Every seam between those two sides degrades *silently*: a manifest the server
 * cannot find is caught, logged once, and answered with the plain shell — a
 * working site that is invisible to crawlers. So the seams are pinned here
 * rather than left to a runtime warning nobody reads:
 *
 *   1. the generator is actually wired into `build:client` (else no manifest);
 *   2. the paths it writes are the paths seo.ts defaults to (else no manifest);
 *   3. every route the sitemap advertises has route metadata (else a
 *      sitemap-listed page serves the generic shell to the crawler that
 *      followed the sitemap to it).
 *
 * These are source-level assertions on purpose: the behavior after a real build
 * is covered by tests/integration/template/lint-build.test.ts, which is far too
 * slow to be the only place a dropped script gets noticed.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CARBON = join(import.meta.dirname, '../../../carbon');
const read = (relPath: string) => readFileSync(join(CARBON, relPath), 'utf-8');

const seoScript = read('scripts/generate-seo.ts');
const sitemapScript = read('scripts/generate-sitemap.ts');
const rssScript = read('scripts/generate-rss.ts');
const seoLib = read('src/server/lib/seo.ts');
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

/** Same parse as sitemap-rss.test.ts — the script is the single source of truth. */
function publicRoutes(): string[] {
  const block = sitemapScript.match(/const PUBLIC_ROUTES = \[([\s\S]*?)\];/);
  if (!block) throw new Error('PUBLIC_ROUTES declaration not found in generate-sitemap.ts');
  return Array.from(block[1].matchAll(/'([^']+)'/g), (m) => m[1]);
}

/**
 * Routes generate-seo.ts emits metadata for without reading content/: the
 * `routes['/x'] = {...}` literals plus the legal path aliases (/privacy,
 * /terms), which are keyed off MDX slugs rather than written as literals.
 */
function staticSeoRoutes(): string[] {
  const literals = Array.from(seoScript.matchAll(/routes\['([^']+)'\]\s*=/g), (m) => m[1]);
  const aliasBlock = seoScript.match(/legalAliases: Record<string, string> = \{([\s\S]*?)\}/);
  const aliases = aliasBlock
    ? Array.from(aliasBlock[1].matchAll(/:\s*'([^']+)'/g), (m) => m[1])
    : [];
  return [...literals, ...aliases];
}

describe('SEO generator wiring', () => {
  it('runs generate-seo.ts as part of build:client', () => {
    expect(pkg.scripts['build:client']).toContain('scripts/generate-seo.ts');
  });

  it('runs generate-seo.ts after vite build, which creates the dist it writes into', () => {
    const build = pkg.scripts['build:client'];
    expect(build.indexOf('vite build')).toBeLessThan(build.indexOf('scripts/generate-seo.ts'));
  });

  it('writes the manifest to the path the server reads by default', () => {
    // A mismatch here is invisible at build time and degrades to the plain
    // shell at runtime — createSeoShell swallows a missing manifest by design.
    expect(seoScript).toContain(`resolve(__dirname, '../dist/seo')`);
    expect(seoScript).toContain(`'route-meta.json'`);
    expect(seoLib).toContain(`manifestPath = './dist/seo/route-meta.json'`);
  });

  it('writes the llms.txt artifacts alongside the shell the server reads', () => {
    expect(seoScript).toContain(`resolve(__dirname, '../dist/client')`);
    expect(seoScript).toContain(`'llms.txt'`);
    expect(seoScript).toContain(`'llms-full.txt'`);
    expect(seoLib).toContain(`shellPath = './dist/client/index.html'`);
  });
});

describe('production build-arg parity across generators', () => {
  // Docker builds have no .env.local; the apex URL arrives ONLY as the
  // VITE_PUBLIC_URL build arg. A generator that skips it silently ships
  // http://localhost:5173 links in its artifact — exactly how rss.xml went
  // out with localhost URLs and the package.json name as the channel title
  // while sitemap.xml and llms.txt were fine.
  it('every generator honors the VITE_PUBLIC_URL build arg', () => {
    for (const [name, src] of [
      ['generate-seo.ts', seoScript],
      ['generate-sitemap.ts', sitemapScript],
      ['generate-rss.ts', rssScript],
    ] as const) {
      expect(src, `${name} must read process.env.VITE_PUBLIC_URL`).toContain(
        'process.env.VITE_PUBLIC_URL',
      );
    }
  });

  it('the RSS channel title uses the display-name resolution, not the package name', () => {
    // package.json `name` is the npm slug (kebab-case project id), never the
    // human-facing brand. The display name lives in PROJECT_DISPLAY_NAME /
    // the index.html <title>, same chain generate-seo.ts resolves.
    expect(rssScript).toContain('PROJECT_DISPLAY_NAME');
  });
});

describe('SEO route metadata parity', () => {
  it('emits metadata for every route the sitemap advertises', () => {
    const covered = new Set(staticSeoRoutes());
    const missing = publicRoutes().filter((route) => !covered.has(route));
    expect(
      missing,
      `generate-sitemap.ts advertises ${missing.join(', ')} but generate-seo.ts emits no route ` +
        'metadata for them, so a crawler following the sitemap gets the generic SPA shell. Add ' +
        "the matching routes['<path>'] entries to buildRouteMeta().",
    ).toEqual([]);
  });

  it('parses a plausible static route set (guards the parser itself)', () => {
    // If buildRouteMeta is refactored away from `routes['/x'] =` literals the
    // parity test above would pass vacuously; this is the tripwire for that.
    expect(staticSeoRoutes().length).toBeGreaterThanOrEqual(publicRoutes().length);
  });
});
