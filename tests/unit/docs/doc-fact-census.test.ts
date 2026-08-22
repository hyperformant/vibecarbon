import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Census: countable and versioned FACTS in the docs must equal the facts on
 * disk.
 *
 * These are the claims that rot silently. Nobody rewrites "UI Components (48)"
 * when they add a component, and nobody revisits "React 18" when the template
 * moves to 19 — the sentence still reads fine, it is just false. Every
 * assertion here re-derives the number from the artifact that owns it (the
 * component directory, carbon/package.json, the db image tag) and compares the
 * doc against it.
 *
 * Node version claims are deliberately NOT here: they are owned end-to-end by
 * tests/unit/lib/node-version-pins.test.ts, which knows about the engines
 * fields, Dockerfiles and CI matrices this file has no opinion on.
 */

const ROOT = process.cwd();

// Mirrors the SURFACES list in the sibling terminology-census.test.ts (that
// file does not export it — it is a test file, and importing one test module
// from another re-registers its suites). The parity test below fails if the
// two lists ever diverge, so this copy cannot silently go stale.
const SURFACES = [
  'README.md',
  'FEATURES.md',
  'TERMS.md',
  'AGENTS.md',
  'carbon/AGENTS.md',
  'docs/technical.md',
  'docs/design.md',
  'docs/tests.md',
  'docs/security.md',
  'docs/rto-rpo.md',
  'docs/deploy-hetzner.md',
  'docs/deploy-digitalocean.md',
  'docs/integrations/observability.md',
  'docs/integrations/n8n.md',
  'carbon/PRODUCTION.md',
  'carbon/README.md',
];

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

/** Major version of a carbon/package.json dependency, `^`/`~`/`>=` stripped. */
const carbonPkg = JSON.parse(read(join('carbon', 'package.json'))) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
function carbonMajor(pkgName: string): number {
  const range = { ...carbonPkg.dependencies, ...carbonPkg.devDependencies }[pkgName];
  if (!range) {
    throw new Error(
      `carbon/package.json no longer depends on "${pkgName}". ` +
        'If it was replaced, update this guard with the docs that name it.',
    );
  }
  const major = range.match(/(\d+)/);
  if (!major)
    throw new Error(`carbon/package.json: cannot read a major out of "${pkgName}@${range}"`);
  return Number(major[1]);
}

/**
 * PostgreSQL major, from the image the database is actually built on.
 * carbon/db/Dockerfile is the real binding — docker-compose.yml only builds
 * `./db` and tags the result, so the version lives one level down.
 */
function postgresMajor(): number {
  const dockerfile = read(join('carbon', 'db', 'Dockerfile'));
  const match = dockerfile.match(/^FROM\s+supabase\/postgres:(\d+)\./m);
  if (!match) {
    throw new Error(
      'carbon/db/Dockerfile: no `FROM supabase/postgres:<major>.…` line. ' +
        'If the base image changed, update this guard with it.',
    );
  }
  return Number(match[1]);
}

describe('doc fact census: counted things', () => {
  it('FEATURES.md UI component count equals the number of components on disk', () => {
    const uiDir = join(ROOT, 'carbon', 'src', 'client', 'components', 'ui');
    const actual = readdirSync(uiDir).filter((f) => f.endsWith('.tsx')).length;
    // Sanity: a walk that found nothing would make any claim "match" a
    // rewritten doc, so fail loudly on an empty directory instead.
    expect(actual, `${uiDir} contains no .tsx files — has the directory moved?`).toBeGreaterThan(
      10,
    );

    const claimed = read('FEATURES.md').match(/^## UI Components \((\d+)\)/m);
    expect(
      claimed,
      'FEATURES.md: no "## UI Components (N)" heading found. ' +
        'This guard counts carbon/src/client/components/ui/*.tsx against that N.',
    ).not.toBeNull();
    expect(
      Number((claimed as RegExpMatchArray)[1]),
      `FEATURES.md claims ${(claimed as RegExpMatchArray)[1]} UI components but ` +
        `carbon/src/client/components/ui/ holds ${actual} .tsx files. ` +
        'Update the heading (and the list under it) to match the directory.',
    ).toBe(actual);
  });
});

describe('doc fact census: framework version claims', () => {
  it('the SURFACES list is identical to the terminology census sibling', () => {
    // Both files sweep "the user-facing docs". If one list grows a doc the
    // other does not, the newer doc is swept by half the guards it should be.
    const sibling = readFileSync(join(ROOT, 'tests/unit/docs/terminology-census.test.ts'), 'utf-8');
    const block = sibling.match(/const SURFACES = \[([\s\S]*?)\];/);
    expect(
      block,
      'terminology-census.test.ts: no `const SURFACES = [...]` block found',
    ).not.toBeNull();
    const siblingSurfaces = [...(block as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map(
      (m) => m[1],
    );
    expect(
      siblingSurfaces.slice().sort(),
      'SURFACES in doc-fact-census.test.ts has drifted from terminology-census.test.ts. ' +
        'Add the new doc to both lists.',
    ).toEqual(SURFACES.slice().sort());
  });

  it('every claimed framework major on a SURFACE matches the real dependency', () => {
    // Package-name per docs spelling. Node is excluded on purpose — see the
    // file header.
    const PKG_BY_SPELLING: Record<string, string> = {
      react: 'react',
      vite: 'vite',
      typescript: 'typescript',
      hono: 'hono',
      tailwind: 'tailwindcss',
    };
    const CLAIM_PATTERNS = [
      /\b(React|Vite|TypeScript|Hono)\s+v?(\d+)\b/g,
      /\b(Tailwind)(?: CSS)? v(\d+)\b/g,
    ];

    // Read once: the Dockerfile does not change between claims.
    const realPostgresMajor = postgresMajor();
    const offenders: string[] = [];
    for (const rel of SURFACES) {
      const text = read(rel);
      for (const pattern of CLAIM_PATTERNS) {
        for (const m of text.matchAll(pattern)) {
          const pkg = PKG_BY_SPELLING[m[1].toLowerCase()];
          const claimed = Number(m[2]);
          const real = carbonMajor(pkg);
          if (claimed !== real) {
            offenders.push(`${rel}: claims "${m[0]}" but carbon/package.json has ${pkg}@${real}.x`);
          }
        }
      }
      for (const m of text.matchAll(/\bPostgreSQL (\d+)\b/g)) {
        if (Number(m[1]) !== realPostgresMajor) {
          offenders.push(
            `${rel}: claims "${m[0]}" but carbon/db/Dockerfile builds on supabase/postgres:${realPostgresMajor}.x`,
          );
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('the version scan actually matched claims (guards against a regex that stopped matching)', () => {
    // The assertion above is a filter over matches: zero matches passes it
    // vacuously. The docs do state framework versions, so pin that they are
    // still being found.
    let hits = 0;
    for (const rel of SURFACES) {
      const text = read(rel);
      hits += [...text.matchAll(/\b(React|Vite|TypeScript|Hono)\s+v?(\d+)\b/g)].length;
      hits += [...text.matchAll(/\b(Tailwind)(?: CSS)? v(\d+)\b/g)].length;
      hits += [...text.matchAll(/\bPostgreSQL (\d+)\b/g)].length;
    }
    expect(hits).toBeGreaterThan(5);
  });
});
