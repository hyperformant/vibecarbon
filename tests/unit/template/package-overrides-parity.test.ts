/**
 * carbon/package.json carries dependency-security pins that no single field
 * reaches every package manager with:
 *
 *   - `overrides`      — read by npm (the template default) and by bun
 *   - `pnpm.overrides` — the template's copy for `-pm pnpm` projects, which
 *                        `writePnpmWorkspaceSettings` MOVES into
 *                        pnpm-workspace.yaml at create time
 *
 * pnpm ignores npm's top-level `overrides`, and npm ignores the `pnpm` block.
 * Worse, pnpm 11 ignores the `pnpm` block too — it warns ("The following keys
 * were ignored: pnpm.overrides") and resolves as if the pins were absent. So
 * the two maps must stay identical AND the pnpm copy must end up in the
 * workspace file; either half alone is a silent loss of every floor below.
 *
 * These tests check enforcement, not just symmetry. Symmetry alone stayed green
 * for the entire period pnpm 11 was ignoring its map at runtime, which is
 * exactly the failure mode worth guarding.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writePnpmWorkspaceSettings } from '../../../src/lib/package-manager.js';

const REPO_ROOT = resolve(__dirname, '../../..');
const CARBON = join(REPO_ROOT, 'carbon');
const pkg = JSON.parse(readFileSync(join(CARBON, 'package.json'), 'utf-8'));
const lock = JSON.parse(readFileSync(join(CARBON, 'package-lock.json'), 'utf-8'));

/** `"postcss@<8.5.10"` → `postcss`; a bare `"unhead"` → `unhead`. */
function selectorName(selector: string): string {
  const at = selector.lastIndexOf('@');
  return at > 0 ? selector.slice(0, at) : selector;
}

/** Lowest version a floor like `>=8.5.10` / `^7.5.6` permits. */
function floorOf(range: string): number[] {
  const m = range.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`unparseable override floor: ${range}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Every version of `name` the committed npm lockfile actually resolves to. */
function resolvedVersions(name: string): string[] {
  const suffix = `node_modules/${name}`;
  return Object.entries(lock.packages as Record<string, { version?: string }>)
    .filter(([path]) => path === suffix || path.endsWith(`/${suffix}`))
    .map(([, entry]) => entry.version)
    .filter((v): v is string => typeof v === 'string');
}

describe('carbon/package.json package-manager config', () => {
  it('is npm-based: no packageManager pin', () => {
    // A `packageManager` field routes the project through corepack, which
    // reintroduces the "install something before your project works" problem
    // that switching the default to npm exists to remove.
    expect(pkg.packageManager).toBeUndefined();
  });

  it('declares npm/bun overrides', () => {
    expect(pkg.overrides).toBeTypeOf('object');
    expect(Object.keys(pkg.overrides).length).toBeGreaterThan(0);
  });

  it('keeps overrides and pnpm.overrides identical', () => {
    expect(pkg.pnpm?.overrides).toEqual(pkg.overrides);
  });

  it('keeps pnpm.onlyBuiltDependencies (pnpm 10 blocks build scripts without it)', () => {
    expect(pkg.pnpm?.onlyBuiltDependencies).toContain('esbuild');
  });

  it('has no script that shells out to a non-npm package manager', () => {
    for (const [name, cmd] of Object.entries(pkg.scripts as Record<string, string>)) {
      expect(cmd, `script "${name}" invokes pnpm`).not.toMatch(/\bpnpm\b/);
      expect(cmd, `script "${name}" invokes bun`).not.toMatch(/\bbun\b/);
    }
  });

  it('uses `npm run` for script chaining, never bare `npm <script>`', () => {
    // `npm build` is not a thing — only lifecycle names (test/start/…) work
    // without `run`, and every chained script here is a custom one.
    for (const [name, cmd] of Object.entries(pkg.scripts as Record<string, string>)) {
      const bad = cmd.match(/\bnpm (?!run |ci\b|install\b|test\b|start\b|exec )\S+/);
      expect(bad, `script "${name}" runs \`${bad?.[0]}\` — needs \`npm run\``).toBeNull();
    }
  });
});

/**
 * ENFORCEMENT (npm / default path). Resolved versions, read out of the
 * lockfile the template actually ships — not config text. `npm ci` installs
 * this file verbatim, so what it records is what every generated project and
 * every Docker image gets.
 */
describe('overrides are enforced in the shipped npm lockfile', () => {
  const pinned = Object.entries(pkg.overrides as Record<string, string>).map(
    ([selector, range]) => ({ name: selectorName(selector), range }),
  );
  const present = pinned.filter(({ name }) => resolvedVersions(name).length > 0);

  it('resolves the pinned packages the graph actually pulls', () => {
    // Below this, a "parity" suite could pass against a lockfile that resolves
    // none of the pinned packages at all.
    expect(present.length).toBeGreaterThanOrEqual(2);
  });

  it.each(present)('$name is at or above its $range floor', ({ name, range }) => {
    const floor = floorOf(range);
    for (const version of resolvedVersions(name)) {
      expect(
        cmp(floorOf(version), floor),
        `${name}@${version} is below the pinned floor ${range}`,
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it('has no override that pins a package absent from the lock without saying so', () => {
    // A floor on a package nothing depends on reads as protection that isn't
    // there. These are kept deliberately: they are pre-emptive floors for
    // packages a future dependency bump could pull in transitively. Anything
    // NEW that lands here needs the same justification — or deleting, the way
    // the inert `ws` pin was. `ws` was in neither lockfile and floored nothing.
    const absent = pinned.filter(({ name }) => resolvedVersions(name).length === 0);
    expect(absent.map(({ name }) => name).sort()).toEqual([
      '@protobufjs/utf8',
      'dompurify',
      'protobufjs',
    ]);
  });
});

/**
 * ENFORCEMENT (pnpm path), as far as a unit test can reach.
 *
 * A pnpm resolve needs the network, so the versions themselves are proven in
 * the integration tier (tests/integration/template/pnpm-overrides.test.ts).
 * What this covers is the mechanism that tier depends on: the pins must leave
 * package.json — where pnpm 11 ignores them — and land in pnpm-workspace.yaml,
 * where pnpm 10.5+ and 11 both read them.
 */
/**
 * BUILD-SCRIPT ALLOW LISTS, the axis that broke the first real-infra e2e run of
 * the npm template (2026-07-31).
 *
 * pnpm 11 replaced `onlyBuiltDependencies` / `ignoredBuiltDependencies` with a
 * single `allowBuilds` map and does NOT fall back to the old names — it treats
 * them as absent. Unlike pnpm 10, which merely warned, pnpm 11 then fails the
 * install outright (ERR_PNPM_IGNORED_BUILDS). The generated Dockerfile installs
 * pnpm at the HOST's version, so a pnpm-11 host shipped an image that could not
 * build at all.
 *
 * Two guards, because the failure needs two things to go wrong: the settings
 * must reach pnpm 11 in a form it reads, AND every dependency that actually has
 * a build script must be classified. The second is the one that rots — a new
 * dependency with an install script re-breaks it silently.
 */
describe('build-script settings reach pnpm 11, and cover the real graph', () => {
  const build = pkg.pnpm as {
    onlyBuiltDependencies?: string[];
    ignoredBuiltDependencies?: string[];
  };

  it('classifies every dependency that actually runs an install script', () => {
    // npm's lockfile records `hasInstallScript` per package, so the real set is
    // readable offline — no resolve, no network. Anything in it that the
    // template neither allows nor ignores makes a `-pm pnpm` project fail its
    // first `pnpm install` on pnpm 11.
    const classified = new Set([
      ...(build.onlyBuiltDependencies ?? []),
      ...(build.ignoredBuiltDependencies ?? []),
    ]);

    const withInstallScripts = new Set<string>();
    for (const [path, entry] of Object.entries(
      lock.packages as Record<string, { hasInstallScript?: boolean }>,
    )) {
      const at = path.lastIndexOf('node_modules/');
      if (at === -1 || !entry.hasInstallScript) continue;
      withInstallScripts.add(path.slice(at + 'node_modules/'.length));
    }

    // Positive control: if the lockfile ever stops recording these, the guard
    // has silently stopped guarding.
    expect(withInstallScripts.size, 'no hasInstallScript packages found').toBeGreaterThan(0);

    const unclassified = [...withInstallScripts].filter((name) => !classified.has(name));
    expect(
      unclassified,
      'these dependencies run install scripts but are in neither `pnpm.onlyBuiltDependencies` ' +
        'nor `pnpm.ignoredBuiltDependencies` in carbon/package.json. On pnpm 11 that is a HARD ' +
        'install failure (ERR_PNPM_IGNORED_BUILDS) for every `-pm pnpm` project, hit first by ' +
        'its Docker build. Decide per package: allow it if the build is genuinely needed ' +
        '(native binaries), ignore it if not.',
    ).toEqual([]);
  });

  it('emits allowBuilds, the only form pnpm 11 reads', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'vc-pnpm-builds-'));
    try {
      writeFileSync(join(projectDir, 'package.json'), JSON.stringify(pkg, null, 2));
      writePnpmWorkspaceSettings(projectDir);
      const yaml = readFileSync(join(projectDir, 'pnpm-workspace.yaml'), 'utf-8');

      expect(yaml).toMatch(/^"allowBuilds":$/m);
      for (const name of build.onlyBuiltDependencies ?? []) {
        // Bare boolean — pnpm rejects the quoted string here.
        expect(yaml, `${name} not allowed in allowBuilds`).toContain(
          `${JSON.stringify(name)}: true`,
        );
      }
      for (const name of build.ignoredBuiltDependencies ?? []) {
        expect(yaml, `${name} not denied in allowBuilds`).toContain(
          `${JSON.stringify(name)}: false`,
        );
      }
      // The pnpm-10 spelling stays: MIN_PNPM_MAJOR is 10, pnpm 10 reads only
      // the old names, and pnpm 11 tolerates them alongside allowBuilds.
      expect(yaml).toMatch(/^"onlyBuiltDependencies":$/m);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('writePnpmWorkspaceSettings moves the pins where pnpm reads them', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'vc-pnpm-settings-'));
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify(pkg, null, 2));
  });

  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

  it('writes every override into pnpm-workspace.yaml', () => {
    expect(writePnpmWorkspaceSettings(projectDir)).toBe(true);
    const yaml = readFileSync(join(projectDir, 'pnpm-workspace.yaml'), 'utf-8');
    for (const [selector, range] of Object.entries(pkg.overrides as Record<string, string>)) {
      expect(yaml, `override ${selector} missing from pnpm-workspace.yaml`).toContain(
        `${JSON.stringify(selector)}: ${JSON.stringify(range)}`,
      );
    }
    // onlyBuiltDependencies has to come along too, or esbuild never builds.
    expect(yaml).toContain('"onlyBuiltDependencies"');
    expect(yaml).toContain('"esbuild"');
  });

  it('removes the pnpm block that pnpm 11 would ignore', () => {
    writePnpmWorkspaceSettings(projectDir);
    const migrated = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf-8'));
    expect(migrated.pnpm).toBeUndefined();
    // The npm/bun map must survive untouched — it is the one npm reads.
    expect(migrated.overrides).toEqual(pkg.overrides);
  });

  it('emits no `packages:` key (a settings-only file, not a workspace root)', () => {
    // `packages: ['.']` would work, but it turns a plain project into a
    // workspace root where `pnpm add <dep>` starts failing without `-w`.
    writePnpmWorkspaceSettings(projectDir);
    const yaml = readFileSync(join(projectDir, 'pnpm-workspace.yaml'), 'utf-8');
    expect(yaml).not.toMatch(/^packages:/m);
  });

  it('is idempotent, so upgrade can re-run it', () => {
    expect(writePnpmWorkspaceSettings(projectDir)).toBe(true);
    const first = readFileSync(join(projectDir, 'pnpm-workspace.yaml'), 'utf-8');
    expect(writePnpmWorkspaceSettings(projectDir)).toBe(false);
    expect(readFileSync(join(projectDir, 'pnpm-workspace.yaml'), 'utf-8')).toBe(first);
  });
});

/**
 * PARITY OF PRESERVATION, not just of content.
 *
 * An npm user's own `overrides` additions survive `vibecarbon upgrade`: the
 * upgrade deep-merges the template's package.json into theirs, so template
 * keys refresh and user keys stay (src/lib/merge-package-json.js).
 *
 * A pnpm user's settings live in pnpm-workspace.yaml instead — a file that
 * upgrade does not merge, and that pnpm itself writes to: `pnpm approve-builds`
 * records the user's build approvals into `onlyBuiltDependencies` there, and
 * the file's own header invites hand-added pins. Upgrade re-merges the
 * template's `pnpm` block back into package.json and then calls
 * writePnpmWorkspaceSettings, so anything that function does not read first, it
 * destroys.
 *
 * These cases pin the preservation half. The scenario is upgrade's exactly:
 * an already-migrated project (no `pnpm` block, settings in the yaml, plus the
 * user's own entries) that upgrade has just re-stamped with the template block.
 */
describe('writePnpmWorkspaceSettings preserves what the user put in the file', () => {
  let projectDir: string;

  /** Re-stamp the template block, as upgrade's package.json merge does. */
  function asUpgradeWould(existingYaml: string): void {
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify(pkg, null, 2));
    writeFileSync(join(projectDir, 'pnpm-workspace.yaml'), existingYaml);
  }

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'vc-pnpm-preserve-'));
  });

  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

  it('keeps user-approved build scripts that `pnpm approve-builds` wrote', () => {
    // approve-builds writes plain unquoted scalars, not the JSON-quoted form
    // the serializer emits — so the reader has to accept both.
    asUpgradeWould(
      ['onlyBuiltDependencies:', '  - esbuild', '  - sharp', '  - "@scoped/native-thing"', ''].join(
        '\n',
      ),
    );

    expect(writePnpmWorkspaceSettings(projectDir)).toBe(true);
    const yaml = readFileSync(join(projectDir, 'pnpm-workspace.yaml'), 'utf-8');
    // The user's approvals survive...
    expect(yaml).toContain('"sharp"');
    expect(yaml).toContain('"@scoped/native-thing"');
    // ...and the template's own entries are still all there.
    for (const dep of pkg.pnpm.onlyBuiltDependencies as string[]) {
      expect(yaml, `template onlyBuiltDependencies entry ${dep} was dropped`).toContain(
        JSON.stringify(dep),
      );
    }
  });

  it('keeps user-added overrides while the template floors still win', () => {
    const [templateSelector] = Object.keys(pkg.pnpm.overrides as Record<string, string>);
    asUpgradeWould(
      [
        'overrides:',
        '  "left-pad": "^1.3.0"',
        // Same selector the template pins, held at a STALE floor. The template
        // is the security source of truth, so this must be overwritten.
        `  ${JSON.stringify(templateSelector)}: "0.0.1"`,
        '',
      ].join('\n'),
    );

    expect(writePnpmWorkspaceSettings(projectDir)).toBe(true);
    const yaml = readFileSync(join(projectDir, 'pnpm-workspace.yaml'), 'utf-8');
    // User's own pin survives.
    expect(yaml).toContain('"left-pad": "^1.3.0"');
    // Template floor wins over the user's stale one — this is a CVE floor.
    expect(yaml).not.toContain('"0.0.1"');
    expect(yaml).toContain(
      `${JSON.stringify(templateSelector)}: ${JSON.stringify(pkg.pnpm.overrides[templateSelector])}`,
    );
  });

  it('preserves a whole settings key the template says nothing about', () => {
    asUpgradeWould(['nodeLinker: "hoisted"', ''].join('\n'));

    expect(writePnpmWorkspaceSettings(projectDir)).toBe(true);
    const yaml = readFileSync(join(projectDir, 'pnpm-workspace.yaml'), 'utf-8');
    expect(yaml).toContain('"nodeLinker": "hoisted"');
  });

  it('round-trips its own output, so re-running upgrade never erodes it', () => {
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify(pkg, null, 2));
    expect(writePnpmWorkspaceSettings(projectDir)).toBe(true);
    const first = readFileSync(join(projectDir, 'pnpm-workspace.yaml'), 'utf-8');

    // Second upgrade: template block comes back, existing file gets re-read.
    asUpgradeWould(first);
    expect(writePnpmWorkspaceSettings(projectDir)).toBe(true);
    expect(readFileSync(join(projectDir, 'pnpm-workspace.yaml'), 'utf-8')).toBe(first);
  });

  it('replaces the placeholder pnpm 11 writes into allowBuilds on a failed install', () => {
    // When an install trips ERR_PNPM_IGNORED_BUILDS, pnpm 11 appends the
    // offending packages to pnpm-workspace.yaml with the literal value
    // `set this to true or false`. Round-tripping that back would re-emit a
    // STRING where pnpm demands a boolean, turning a recoverable state into a
    // wedged one — so a derived value must win over it.
    asUpgradeWould(
      ['allowBuilds:', '  esbuild: set this to true or false', '  some-user-pkg: true', ''].join(
        '\n',
      ),
    );

    expect(writePnpmWorkspaceSettings(projectDir)).toBe(true);
    const yaml = readFileSync(join(projectDir, 'pnpm-workspace.yaml'), 'utf-8');
    expect(yaml).not.toContain('set this to true or false');
    expect(yaml).toContain('"esbuild": true');
    // A real user entry the template says nothing about still survives.
    expect(yaml).toContain('"some-user-pkg": true');
  });

  it('refuses to clobber a file it cannot parse', () => {
    // Losing a user's hand-edited pins is worse than not refreshing the
    // template's. Bail out and leave the file byte-identical; the caller
    // reports it so the merge can be done by hand.
    const handEdited = 'overrides:\n  ? [complex, key]\n  : value\n';
    asUpgradeWould(handEdited);

    expect(writePnpmWorkspaceSettings(projectDir)).toBe(false);
    expect(readFileSync(join(projectDir, 'pnpm-workspace.yaml'), 'utf-8')).toBe(handEdited);
    // package.json keeps its `pnpm` block too — dropping it here would strand
    // the pins in neither location.
    const after = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf-8'));
    expect(after.pnpm).toBeDefined();
  });
});
