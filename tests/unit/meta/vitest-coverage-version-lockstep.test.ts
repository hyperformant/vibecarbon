import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { readRepoFile } from '../../_shared/source-files.js';

/**
 * `vitest` and `@vitest/coverage-v8` must be declared AND resolved at the same
 * version, in both manifests.
 *
 * THE DEFECT THIS EXISTS FOR. Dependabot PR #71 bumped the root `vitest` to
 * 5.0.0 and left `@vitest/coverage-v8` at 4.1.11. CI was fully green. Two
 * things had to line up for that:
 *
 *   1. `@vitest/coverage-v8` peer-depends on vitest at EXACTLY its own version,
 *      and pnpm only warns on an unmet peer rather than failing the install.
 *      (`npm ci` is strict and would have failed — but the root package is the
 *      pnpm one, so nothing strict ever ran against the pair.)
 *   2. Coverage is informational here, not a CI gate: nothing in
 *      .github/workflows runs `--coverage`, so a coverage provider that cannot
 *      load is a no-op rather than a failure. See the note on `coverage` in
 *      vitest.config.ts.
 *
 * So the mismatch was invisible from both ends at once. #71 was closed and
 * replaced by hand with #73, which bumped the pair together.
 *
 * WHY CONFIG ALONE DOES NOT COVER THIS. .github/dependabot.yml grew a group in
 * #70 so the pair travels in one PR. That group is the fix; this test is the
 * check on the fix. Dependabot split the pair in every PR it opened for that
 * group (eleven, #71 to #565) WITH the grouping rule in place; the describe below
 * says why and pins the config that stops it. A group that silently stops
 * matching (a rename, a new `@vitest/*` package, an ecosystem the group does
 * not cover) fails exactly the way #71 did: quietly, green.
 *
 * THE FIX when this fails: bump both names to the same version in the manifest
 * that drifted, then regenerate that lockfile. Never raise just one — and never
 * "fix" it by loosening a range so the two merely overlap, because the peer is
 * an exact pin and the resolved versions are what matter.
 */

/** The vitest monorepo publishes every `@vitest/*` package at one version. */
const PAIR = ['vitest', '@vitest/coverage-v8'] as const;

/** `5.0.0(vitest@5.0.0)` → `5.0.0`. pnpm suffixes resolutions with peers. */
function baseVersion(version: string): string {
  return version.replace(/\(.*$/, '');
}

function readJson(...segments: string[]): Record<string, never> {
  return JSON.parse(readRepoFile(...segments));
}

/**
 * SYMMETRY — what the manifests declare. This is the half a human edits, and
 * the half dependabot opens PRs against.
 */
describe('vitest and @vitest/coverage-v8 declare one version', () => {
  const manifests = [
    { label: 'root package.json', pkg: readJson('package.json') },
    { label: 'carbon/package.json', pkg: readJson('carbon', 'package.json') },
  ];

  it.each(manifests)('$label declares both halves of the pair', ({ pkg }) => {
    // Positive control. If a rename ever moves these out of devDependencies,
    // the range assertion below would pass vacuously on two undefineds.
    const dev = pkg.devDependencies as unknown as Record<string, string>;
    for (const name of PAIR) {
      expect(dev?.[name], `${name} is not a devDependency`).toBeTypeOf('string');
    }
  });

  it.each(manifests)('$label pins the pair to the same range', ({ pkg }) => {
    const dev = pkg.devDependencies as unknown as Record<string, string>;
    const [vitest, coverage] = PAIR.map((name) => dev[name]);
    expect(
      coverage,
      `@vitest/coverage-v8@${coverage} does not match vitest@${vitest}. The coverage ` +
        'provider peer-depends on vitest at its exact version — bump both together.',
    ).toBe(vitest);
  });
});

/**
 * ENFORCEMENT — what the committed lockfiles actually resolve to. The ranges
 * above can agree while the locks disagree: a stale lock, or a hand-edit that
 * touched the manifest only. Installs read these files, not the ranges.
 */
describe('the shipped lockfiles resolve the pair to one version', () => {
  it('root pnpm-lock.yaml', () => {
    const lock = load(readRepoFile('pnpm-lock.yaml')) as {
      importers?: Record<string, { devDependencies?: Record<string, { version?: string }> }>;
    };
    const dev = lock.importers?.['.']?.devDependencies;
    expect(dev, 'no root importer in pnpm-lock.yaml').toBeTypeOf('object');

    const resolved = PAIR.map((name) => {
      const version = dev?.[name]?.version;
      expect(version, `${name} is not resolved in pnpm-lock.yaml`).toBeTypeOf('string');
      return baseVersion(version as string);
    });
    expect(
      resolved[1],
      `pnpm-lock.yaml resolves @vitest/coverage-v8@${resolved[1]} against vitest@${resolved[0]}`,
    ).toBe(resolved[0]);
  });

  it('carbon/package-lock.json', () => {
    const lock = readJson('carbon', 'package-lock.json') as unknown as {
      packages: Record<string, { version?: string }>;
    };

    // The template is npm-based, so every copy in the tree matters: `npm ci`
    // installs this file verbatim into every generated project.
    const versionsOf = (name: string): string[] => {
      const suffix = `node_modules/${name}`;
      return Object.entries(lock.packages)
        .filter(([path]) => path === suffix || path.endsWith(`/${suffix}`))
        .map(([, entry]) => entry.version)
        .filter((v): v is string => typeof v === 'string');
    };

    const [vitest, coverage] = PAIR.map(versionsOf);
    expect(vitest.length, 'vitest is absent from carbon/package-lock.json').toBeGreaterThan(0);
    expect(
      coverage.length,
      '@vitest/coverage-v8 is absent from carbon/package-lock.json',
    ).toBeGreaterThan(0);

    for (const version of coverage) {
      expect(
        vitest,
        `carbon resolves @vitest/coverage-v8@${version}, which is not among vitest@${vitest.join(', ')}`,
      ).toContain(version);
    }
  });
});

/**
 * GROUPING: which Dependabot groups can claim each half.
 *
 * GitHub's docs say a dependency joins the first group it matches. The updater
 * does not work that way: a group whose patterns match a name less specifically
 * than another matching group loses it (dependabot-core
 * updater/lib/dependabot/updater/pattern_specificity_calculator.rb). An exact
 * name scores 1000, a group with NO patterns scores 500, and `@vitest/*` scores
 * 94. So `vitest` stayed in the vitest group while `@vitest/coverage-v8` always
 * went to the broad group with no patterns, wherever the groups were listed.
 *
 * Excluding the pair from every other group holds under both rules.
 */
describe('only the vitest group can claim either half of the pair', () => {
  interface Group {
    'applies-to'?: string;
    'dependency-type'?: string;
    patterns?: string[];
    'exclude-patterns'?: string[];
  }
  const config = load(readRepoFile('.github', 'dependabot.yml')) as {
    updates: { 'package-ecosystem': string; directory: string; groups?: Record<string, Group> }[];
  };
  const npmBlocks = config.updates.filter((u) => u['package-ecosystem'] === 'npm');

  /** Dependabot's wildcard: `*` is any run of characters, all else is literal. */
  const matches = (pattern: string, name: string): boolean =>
    new RegExp(
      `^${pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
    ).test(name);

  /** DependencyGroup#contains? in dependabot-core, for a devDependency. */
  const canClaim = (group: Group, name: string): boolean => {
    if ((group['applies-to'] ?? 'version-updates') !== 'version-updates') return false;
    if (group['exclude-patterns']?.some((p) => matches(p, name))) return false;
    if (group['dependency-type'] === 'production') return false;
    return group.patterns?.some((p) => matches(p, name)) ?? true;
  };

  it('covers both npm manifests', () => {
    expect(npmBlocks.map((b) => b.directory).sort()).toEqual(['/', '/carbon']);
  });

  it.each(
    npmBlocks.flatMap((block) => PAIR.map((name) => ({ dir: block.directory, block, name }))),
  )('$dir: $name', ({ block, name }) => {
    const claiming = Object.entries(block.groups ?? {})
      .filter(([, group]) => canClaim(group, name))
      .map(([id]) => id);
    expect(
      claiming,
      `${name} can land in ${claiming.join(', ')}. Add exclude-patterns ["vitest", "@vitest/*"] ` +
        'to every version-update group except vitest.',
    ).toEqual(['vitest']);
  });
});
