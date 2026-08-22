/**
 * ENFORCEMENT check for the `-pm pnpm` path: resolve the template's real
 * dependency graph with pnpm and read the versions back out of the lockfile.
 *
 * Why this exists as its own test rather than a config-symmetry assertion:
 * pnpm 11 stopped reading the `pnpm` field in package.json. It warns ("The
 * following keys were ignored: pnpm.overrides") and then resolves as though
 * every dependency-security pin were absent — fast-uri@3.1.4, unhead@2.1.16
 * instead of the floored 4.1.1 / 3.2.3. A test comparing the two override maps
 * to each other stays green through all of that, because both maps are fine;
 * it is the *location* that stopped working. So this asserts resolved versions.
 *
 * `writePnpmWorkspaceSettings` is the fix under test: it moves the pins into
 * pnpm-workspace.yaml, which pnpm 10.5+ and pnpm 11 both read.
 *
 * Needs the registry (metadata only — `--lockfile-only` downloads no tarballs)
 * and a pnpm on PATH. Skips itself cleanly without either.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writePnpmWorkspaceSettings } from '../../../src/lib/package-manager.js';

const REPO_ROOT = resolve(__dirname, '../../..');
const CARBON = join(REPO_ROOT, 'carbon');

const pnpmVersion = (() => {
  const r = spawnSync('pnpm', ['--version'], { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : null;
})();

let projectDir: string | null = null;
let lockfile = '';
let resolveError = '';

beforeAll(() => {
  if (!pnpmVersion) return;
  projectDir = mkdtempSync(join(tmpdir(), 'vc-pnpm-overrides-'));
  copyFileSync(join(CARBON, 'package.json'), join(projectDir, 'package.json'));

  // The fix: pins out of package.json (ignored by pnpm 11) and into
  // pnpm-workspace.yaml (read by pnpm 10.5+ and 11).
  expect(writePnpmWorkspaceSettings(projectDir)).toBe(true);

  const r = spawnSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: 240_000,
  });
  if (r.status !== 0) {
    resolveError = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
    return;
  }
  lockfile = readFileSync(join(projectDir, 'pnpm-lock.yaml'), 'utf-8');
}, 300_000);

afterAll(() => {
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

/** Versions of `name` in the lockfile's resolved `packages:` section. */
function resolvedVersions(name: string): string[] {
  const packages = lockfile.split(/^packages:$/m)[1]?.split(/^snapshots:$/m)[0] ?? '';
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = packages.matchAll(new RegExp(`^ {2}'?${escaped}@([0-9][^:\\s(']*)`, 'gm'));
  return [...new Set([...matches].map((m) => m[1]))];
}

function atLeast(version: string, floor: string): boolean {
  const parse = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10));
  const [a, b] = [parse(version), parse(floor)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

describe.skipIf(!pnpmVersion)(`pnpm ${pnpmVersion} enforces the template's dependency pins`, () => {
  it('resolved the graph', () => {
    expect(resolveError, `pnpm install --lockfile-only failed:\n${resolveError}`).toBe('');
    expect(lockfile).toContain('packages:');
  });

  // Both of these sit BELOW their pinned floor when the overrides are ignored —
  // measured on pnpm 11.18.0 with the pins left in package.json: fast-uri@3.1.4
  // (floor >=3.1.2 is met, but the npm path lands 4.1.1) and unhead@2.1.16
  // (floor >=2.1.13). They are the pair that visibly moves when the override
  // location is right, which is what makes them the useful canaries here.
  it.each([
    { name: 'fast-uri', floor: '3.1.2', ignoredValue: '3.1.4' },
    { name: 'unhead', floor: '2.1.13', ignoredValue: '2.1.16' },
  ])(
    '$name is overridden, not left at the un-overridden $ignoredValue',
    ({ name, floor, ignoredValue }) => {
      const versions = resolvedVersions(name);
      expect(versions.length, `${name} absent from the pnpm lockfile`).toBeGreaterThan(0);
      for (const version of versions) {
        expect(atLeast(version, floor), `${name}@${version} is below the ${floor} floor`).toBe(
          true,
        );
      }
      // The tell-tale of a dropped override: the exact version pnpm resolves when
      // it cannot see the pins at all.
      expect(versions).not.toContain(ignoredValue);
    },
  );

  it('never resolves below what the shipped npm lockfile locked', () => {
    // Parity between the default (npm) path and the pnpm adapter — a pin that
    // lands on one manager and not the other is the bug class this whole file
    // guards. The direction is what makes it a guard: pnpm resolving BELOW
    // npm's locked version means the override did not apply on the pnpm side.
    //
    // Deliberately NOT an equality check. The two sides are not comparable that
    // way: npm's number is replayed from a lockfile frozen at commit time,
    // while pnpm's is resolved live against the registry on every run — and the
    // `overrides` floors are unbounded (`>=3.1.2`), so any upstream release
    // moves pnpm's side on its own. An equality assertion here was red within a
    // day of being written (CI, 2026-07-31: fast-uri published 4.1.2 while the
    // committed lock held 4.1.1) and would go red again on every patch release
    // of any package below — failing on someone ELSE's publish schedule while
    // saying nothing about this repo.
    //
    // The un-overridden values are pinned exactly by the canary cases above,
    // which is where a dropped pin actually gets caught.
    const npmLock = JSON.parse(readFileSync(join(CARBON, 'package-lock.json'), 'utf-8'));
    const npmVersion = (name: string): string | undefined =>
      npmLock.packages[`node_modules/${name}`]?.version;

    for (const name of ['fast-uri', 'unhead', 'postcss', 'ip-address']) {
      const locked = npmVersion(name);
      expect(locked, `${name} missing from the npm lockfile`).toBeTruthy();
      const versions = resolvedVersions(name);
      expect(versions.length, `${name} absent from the pnpm lockfile`).toBeGreaterThan(0);
      for (const version of versions) {
        expect(
          atLeast(version, locked as string),
          `${name}@${version} resolved by pnpm is BELOW the ${locked} the npm lockfile carries — ` +
            'the override did not apply on the pnpm side',
        ).toBe(true);
      }
    }
  });
});
