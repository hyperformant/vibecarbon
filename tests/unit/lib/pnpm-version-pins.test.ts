/**
 * Drift guard for the pnpm version, the pnpm-shaped twin of
 * tests/unit/lib/node-version-pins.test.ts.
 *
 * SCOPE: the ROOT project only. `carbon/` is deliberately excluded everywhere
 * below — it is an npm project by design, and its package manager is not this
 * repo's to pin. That exclusion is a boundary, not an oversight: a pnpm pin
 * appearing under carbon/ is someone else's decision, while a pnpm pin
 * appearing anywhere in root-owned files is drift this file must catch.
 *
 * The single source of truth is the root package.json's `packageManager`
 * field. Nothing else names a pnpm version:
 *
 *   - `pnpm/action-setup` reads `packageManager` whenever its `version:` input
 *     is omitted, so every workflow derives rather than repeats. It is not
 *     merely redundant to set both — the action HARD FAILS with "Multiple
 *     versions of pnpm specified" when the two disagree, so a re-introduced
 *     `version:` is a broken job, not just a duplicated constant.
 *   - pnpm 10+ reads the same field itself and self-switches to that exact
 *     version before installing, so a laptop and a runner land on one pnpm
 *     with nothing to keep in sync.
 *
 * Written after CI was found running two pnpm majors at once with nothing
 * red: release.yml pinned `version: 9` while test.yml and e2e-us-perf.yml each
 * declared their own `PNPM_VERSION: '10'`. pnpm-lock.yaml is
 * `lockfileVersion: '9.0'`, which both majors read and write, so every run
 * stayed green — the published tarball was simply resolved and installed by a
 * pnpm that no test job had ever run. That is the failure mode this guards:
 * not a broken workflow, but a release whose dependency resolution nothing
 * upstream of it exercised.
 *
 * The inventory assertions are the load-bearing part (same idiom as
 * node-version-pins.test.ts and tests/unit/deploy/walg-dockerfile-arch.test.ts):
 * both the workflow list and the pnpm-literal list are DISCOVERED by walking
 * the tree and then compared against what is registered here, so a new
 * workflow that sets pnpm up — or any new file that writes a pnpm version into
 * a `RUN` line, a script, or a doc — has to be triaged here rather than
 * quietly escaping the sweep.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf-8');

/** THE source of truth. */
const ROOT_PKG = 'package.json';

/** Raw `packageManager` field of the root project, or undefined. */
function packageManagerField(): string | undefined {
  return JSON.parse(read(ROOT_PKG)).packageManager;
}

/** Major of the root `pnpm@x.y.z` pin, e.g. 10. */
function pinnedMajor(): number {
  const major = /^pnpm@(\d+)\./.exec(packageManagerField() ?? '')?.[1];
  if (!major) throw new Error(`${ROOT_PKG}: not a "pnpm@x.y.z" packageManager field`);
  return Number(major);
}

/**
 * Root-owned workflows that install pnpm, and the package.json each of their
 * `pnpm/action-setup` steps derives from, IN ORDER. `package.json` is the
 * action's own default for `package_json_file`, which it resolves against
 * GITHUB_WORKSPACE — a job's `working-directory` does NOT move it.
 */
const PNPM_WORKFLOWS: Record<string, string[]> = {
  // matrix (one per provider leg, but they share one job template) + publish-perf.
  [join('.github', 'workflows', 'e2e-us-perf.yml')]: [ROOT_PKG, ROOT_PKG],
  [join('.github', 'workflows', 'release.yml')]: [ROOT_PKG],
  // lint, unit, integration, engines-min. Four, and NOT the carbon Template
  // Tests job: that one runs carbon/ under npm, so it sets no pnpm up at all
  // (npm ships with the Node the action installs). `engines-min` pins Node —
  // the one sanctioned Node literal, see node-version-pins.test.ts — but NOT
  // pnpm: the two axes are independent, and that leg exists to vary Node
  // alone, so its pnpm still derives from the root pin like the rest.
  [join('.github', 'workflows', 'test.yml')]: [ROOT_PKG, ROOT_PKG, ROOT_PKG, ROOT_PKG],
};

/** Root-owned workflows that deliberately never set pnpm up. */
const NON_PNPM_WORKFLOWS = [
  join('.github', 'workflows', 'dependabot-auto-merge.yml'),
  join('.github', 'workflows', 'publish-db-image.yml'),
  join('.github', 'workflows', 'publish-images.yml'),
];

/**
 * Every root-owned file allowed to name a pnpm version at all, and what
 * governs it. Anything else matching `pnpm@<digits>` fails the inventory.
 */
const PNPM_VERSION_SITES: Record<string, string> = {
  [ROOT_PKG]: 'THE source of truth',
  [join('src', 'lib', 'package-manager.js')]:
    'the version written into a GENERATED project when detection fails — a customer-facing default, not a pin on this repo',
  [join('tests', 'integration', 'cli', 'upgrade', 'upgrade.test.ts')]:
    'synthetic pnpm@9.9.9 fixture pin — asserts upgrade re-pins a user-modified field to the HOST pnpm and announces the move; pins nothing real',
};

/** Directories the walk never enters. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage']);
/**
 * Root-relative paths the walk never enters.
 *
 * `carbon/` — a separate project, npm by design (see the SCOPE note above).
 * what was true when written and are not maintained against the current pins.
 */
const SKIP_PATHS = ['carbon'];
/** This file names pnpm versions only in order to talk about them. */
const SELF = join('tests', 'unit', 'lib', 'pnpm-version-pins.test.ts');
/**
 * Files the literal scan reads: known text extensions, plus anything with NO
 * extension at all. The second half is not just for `Dockerfile` — `git-hooks/
 * pre-commit` and `git-hooks/pre-push` invoke pnpm and carry no suffix, so an
 * extension allow-list alone would let a pin in the one place that runs on
 * every commit escape the sweep.
 */
const SCANNED = /(\.(json|ya?ml|[cm]?[jt]sx?|md|sh)$|(^|[\\/])[^\\/.]+$)/;

function walk(dir: string, visit: (relPath: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(ROOT, full);
    if (SKIP_DIRS.has(entry.name) || SKIP_PATHS.includes(rel)) continue;
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') || entry.name === '.github') walk(full, visit);
    } else {
      visit(rel);
    }
  }
}

/** Every root-owned `*.yml` under a `.github/workflows/`, ROOT-relative. */
function findWorkflows(): string[] {
  const out: string[] = [];
  walk(ROOT, (rel) => {
    if (/\.ya?ml$/.test(rel) && rel.includes(join('.github', 'workflows'))) out.push(rel);
  });
  return out;
}

/** Every root-owned scanned file whose text names a concrete pnpm version. */
function findPnpmVersionSites(): string[] {
  const out: string[] = [];
  walk(ROOT, (rel) => {
    if (rel === SELF || rel.endsWith('pnpm-lock.yaml') || !SCANNED.test(rel)) return;
    if (/\bpnpm@\d/.test(readFileSync(join(ROOT, rel), 'utf-8'))) out.push(rel);
  });
  return out;
}

/**
 * The `pnpm/action-setup` steps of a workflow, as raw YAML blocks. A step
 * starts at a `- <key>:` line and runs until the next one, so each block holds
 * that step's whole `with:` map.
 */
function pnpmSetupSteps(yaml: string): string[] {
  const lines = yaml.split('\n');
  const starts = lines.flatMap((line, i) =>
    /^\s*- (uses|name|id|run|if|with):/.test(line) ? [i] : [],
  );
  return starts
    .map((from, i) => lines.slice(from, starts[i + 1] ?? lines.length).join('\n'))
    .filter((block) => /uses:\s*pnpm\/action-setup@/.test(block));
}

describe('the root packageManager field is the single source of truth', () => {
  it('declares an exact pnpm version', () => {
    // `pnpm/action-setup` and pnpm's own self-switching both want a full
    // semver; the packageManager spec rejects a range or a bare major.
    expect(packageManagerField()).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it('is on a pnpm major that honours packageManager', () => {
    // Everything here rests on pnpm reading the field itself. That landed in
    // pnpm 10 (`manage-package-manager-versions`, default on); on pnpm 9 the
    // field is inert and "the single source" quietly degrades to whatever
    // binary happens to be on PATH.
    expect(pinnedMajor()).toBeGreaterThanOrEqual(10);
  });
});

describe('workflows derive pnpm instead of pinning it', () => {
  const registered = [...Object.keys(PNPM_WORKFLOWS), ...NON_PNPM_WORKFLOWS].sort();

  it('knows about every root-owned workflow', () => {
    // A new workflow must be triaged into one of the two lists rather than
    // silently escaping the assertions below.
    expect(findWorkflows().sort()).toEqual(registered);
  });

  it.each(NON_PNPM_WORKFLOWS)('%s sets no pnpm up', (relPath) => {
    expect(read(relPath)).not.toMatch(/pnpm\/action-setup/);
  });

  it.each(registered)('%s pins no pnpm version of its own', (relPath) => {
    const yaml = read(relPath);
    for (const step of pnpmSetupSteps(yaml)) {
      expect(
        step,
        `${relPath}: drop \`version:\` — the packageManager field owns this`,
      ).not.toMatch(/^\s*version:/m);
    }
    // The env-var indirection that two workflows used to declare separately.
    expect(yaml, `${relPath}: PNPM_VERSION re-pins pnpm`).not.toMatch(/PNPM_VERSION/);
  });

  it.each(Object.entries(PNPM_WORKFLOWS))(
    '%s derives from the registered package.json',
    (relPath, expected) => {
      const sources = pnpmSetupSteps(read(relPath)).map(
        (step) => /^\s*package_json_file:\s*(\S+)/m.exec(step)?.[1] ?? ROOT_PKG,
      );
      expect(sources, `${relPath}: pnpm setup steps changed — re-register them`).toEqual(expected);
    },
  );

  it('the derived source really carries a packageManager field', () => {
    // With neither the field nor a `version:`, the action fails the job with
    // "No pnpm version is specified" — so removing one requires the other.
    expect(packageManagerField(), `${ROOT_PKG}: missing packageManager`).toBeDefined();
  });

  it('every workflow is on the same pnpm/action-setup major', () => {
    const majors = new Set(
      registered.flatMap((relPath) =>
        [...read(relPath).matchAll(/pnpm\/action-setup@v(\d+)/g)].map((m) => m[1]),
      ),
    );
    expect([...majors]).toHaveLength(1);
  });
});

describe('no root-owned file outside the source names a pnpm version', () => {
  it('knows about every pnpm version literal', () => {
    // Discovered by walking, not by reading a list — a pnpm version written
    // into a shell script, a Dockerfile RUN line or a doc is caught the same
    // way a workflow pin is.
    expect(findPnpmVersionSites().sort()).toEqual(Object.keys(PNPM_VERSION_SITES).sort());
  });

  it('the scan reads extension-less files, not just suffixed ones', () => {
    // The git hooks run `pnpm lint` / `pnpm test:unit` on every commit and
    // push and carry no file extension, so an extension-only allow-list would
    // exempt exactly the scripts that invoke pnpm most often. Dockerfiles are
    // the same shape.
    expect(SCANNED.test(join('git-hooks', 'pre-commit'))).toBe(true);
    expect(SCANNED.test(join('git-hooks', 'pre-push'))).toBe(true);
    expect(SCANNED.test(join('docker', 'postgres-walg', 'Dockerfile'))).toBe(true);
    // Still not reading build output or binaries by accident.
    expect(SCANNED.test(join('tests', 'results', 'e2e.db'))).toBe(false);
  });

  it('the walk actually reaches root-owned files (and stops at carbon/)', () => {
    // Guards the walker: a skip rule that accidentally matched everything
    // would make the inventory above vacuously pass.
    const seen: string[] = [];
    walk(ROOT, (rel) => seen.push(rel));
    expect(seen).toContain(join('.github', 'workflows', 'test.yml'));
    expect(seen).toContain(ROOT_PKG);
    expect(seen.filter((rel) => rel.split(sep)[0] === 'carbon')).toEqual([]);
  });
});

describe('the SKIP_PATHS rationales still hold (2026-08-07 audit)', () => {
  // Unlike PNPM_VERSION_SITES (whose exact-match assertion prunes stale
  // rows), SKIP_PATHS carried no staleness check at all. These skips are
  // preventive scope boundaries, not shields for known mentions (neither
  // tree names a pnpm version today) — so what must stay true is each
  // row's DOCUMENTED RATIONALE, mechanically where possible:
  //   carbon/           — "a separate project, npm by design". If carbon
  //                       ever adopts pnpm (packageManager field or a
  //                       pnpm-lock.yaml), the blanket skip would start
  //                       hiding a live pnpm surface from the sweep.
  // A deleted tree fails too: a skip for a path that no longer exists is
  // pure cruft.
  it.each(SKIP_PATHS)('%s still exists (a skip for a deleted tree is stale)', (skip) => {
    expect(statSync(join(ROOT, skip)).isDirectory()).toBe(true);
  });

  it('carbon/ is still npm-by-design — otherwise the blanket skip hides real pnpm pins', () => {
    const carbonPkg = JSON.parse(readFileSync(join(ROOT, 'carbon', 'package.json'), 'utf-8')) as {
      packageManager?: string;
    };
    expect(
      carbonPkg.packageManager ?? '',
      'carbon/package.json now declares a pnpm packageManager — remove the carbon SKIP_PATHS row and give its pins a proper inventory.',
    ).not.toMatch(/^pnpm@/);
    expect(
      existsSync(join(ROOT, 'carbon', 'pnpm-lock.yaml')),
      'carbon/ now carries a pnpm lockfile — remove the carbon SKIP_PATHS row and give its pins a proper inventory.',
    ).toBe(false);
  });
});
