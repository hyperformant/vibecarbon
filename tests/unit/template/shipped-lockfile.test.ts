/**
 * The template's committed lockfile is now PROJECT PAYLOAD, not just a
 * convenience for building the template in CI.
 *
 * `vibecarbon create` copies carbon/package-lock.json into every new npm
 * project instead of running a full `npm install` there (~1 min saved per
 * scaffold, and every project starts on the tree CI actually tested). That
 * turns two previously-harmless states into shipped breakage:
 *
 *   1. The lockfile drifting out of sync with carbon/package.json — a
 *      dependency added without regenerating the lock. `npm ci` re-resolves
 *      nothing, so the project's Docker build and its scaffolded CI workflow
 *      both fail on a project the user has not touched yet.
 *   2. The lockfile being excluded from the published package. npm strips a
 *      lockfile from the ROOT of a tarball but not one nested under carbon/,
 *      so this comes down to .npmignore — and it silently degrades to the slow
 *      path rather than erroring, which is exactly the kind of regression that
 *      survives review.
 *
 * Both are cheap to pin structurally, so they are pinned here.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeTemplateLockfile } from '../../../src/lib/package-manager.js';

const REPO_ROOT = resolve(__dirname, '../../..');
const TEMPLATE_DIR = join(REPO_ROOT, 'carbon');
const LOCK_PATH = join(TEMPLATE_DIR, 'package-lock.json');

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf-8'));

describe('template lockfile ships with the package', () => {
  it('exists', () => {
    expect(existsSync(LOCK_PATH)).toBe(true);
  });

  it('is not excluded by ANY .npmignore in the repo', () => {
    // Census walk, not a hardcoded path. npm honors a .npmignore in every
    // directory it packs, and this repo has two — the root one and
    // carbon/.npmignore. The first cut of this test only checked the root and
    // passed while the nested file silently kept the lockfile out of the
    // tarball. Enumerate them instead so a third one can't reintroduce that.
    const ignoreFiles = execFileSync('git', ['ls-files', '--', '*.npmignore', '.npmignore'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    })
      .split('\n')
      .filter(Boolean);

    // If this ever finds zero files the assertions below are vacuous.
    expect(ignoreFiles.length).toBeGreaterThanOrEqual(2);

    for (const relPath of ignoreFiles) {
      const patterns = readFileSync(join(REPO_ROOT, relPath), 'utf-8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));

      // A bare `package-lock.json` matches at any depth (gitignore semantics),
      // so both spellings have to stay out of every one of these files.
      expect(patterns, `${relPath} excludes the template lockfile`).not.toContain(
        'package-lock.json',
      );
      expect(patterns, `${relPath} excludes the template lockfile`).not.toContain(
        'carbon/package-lock.json',
      );
    }
  });

  it('is covered by the package.json files whitelist', () => {
    expect(readJson(join(REPO_ROOT, 'package.json')).files).toContain('carbon');
  });
});

describe('template lockfile is in sync with template package.json', () => {
  it('records the same direct dependency ranges as carbon/package.json', () => {
    const pkg = readJson(join(TEMPLATE_DIR, 'package.json'));
    const root = readJson(LOCK_PATH).packages[''];

    // `npm ci` fails outright when these disagree, so drift here is a shipped
    // build break — not a warning. Regenerate with `npm install` in carbon/.
    expect(root.dependencies ?? {}).toEqual(pkg.dependencies ?? {});
    expect(root.devDependencies ?? {}).toEqual(pkg.devDependencies ?? {});
  });

  it('records native binaries for every platform, not just the one that generated it', () => {
    // The committed lock is generated on Linux but installed by users on macOS
    // and Windows. npm records ALL optional platform variants with os/cpu
    // constraints and picks the matching one at install time — so this works,
    // but only as long as nobody regenerates the lock in a way that prunes
    // them (`--omit=optional`, or a platform-restricted install). If that
    // happens, `npm ci` on a Mac silently installs no esbuild binary and the
    // very first `vibecarbon up` fails on a project the user never touched.
    const { packages } = readJson(LOCK_PATH);
    const esbuildVariants = Object.keys(packages).filter((p) => p.includes('@esbuild/'));

    const platformsFor = (pattern: RegExp) => esbuildVariants.filter((p) => pattern.test(p)).length;

    expect(platformsFor(/linux/)).toBeGreaterThan(0);
    expect(platformsFor(/darwin/)).toBeGreaterThan(0);
    expect(platformsFor(/win32/)).toBeGreaterThan(0);

    // Every variant must carry the os/cpu constraints npm filters on. A bare
    // entry would be installed everywhere, on every platform.
    for (const variant of esbuildVariants) {
      const entry = packages[variant];
      expect(entry.os, `${variant} has no os constraint`).toBeDefined();
      expect(entry.cpu, `${variant} has no cpu constraint`).toBeDefined();
    }
  });

  it('resolves every recorded package to a concrete version', () => {
    const { packages } = readJson(LOCK_PATH);
    const unresolved = Object.entries(
      packages as Record<string, { version?: string; link?: boolean }>,
    )
      .filter(([path]) => path !== '')
      .filter(([, entry]) => !entry.link && !entry.version)
      .map(([path]) => path);

    expect(unresolved).toEqual([]);
  });
});

describe('writeTemplateLockfile', () => {
  it('rewrites both name fields and leaves the resolved tree untouched', () => {
    const source = readJson(LOCK_PATH);
    const projectDir = join(REPO_ROOT, 'node_modules', '.tmp-lockfile-test');
    const { mkdirSync, rmSync } = require('node:fs');

    mkdirSync(projectDir, { recursive: true });
    try {
      expect(writeTemplateLockfile(TEMPLATE_DIR, projectDir, 'my-app')).toBe(true);
      const written = readJson(join(projectDir, 'package-lock.json'));

      expect(written.name).toBe('my-app');
      expect(written.packages[''].name).toBe('my-app');

      // Everything else must be byte-for-byte the template's tree — this is
      // the whole premise of shipping it instead of re-resolving.
      expect(Object.keys(written.packages)).toEqual(Object.keys(source.packages));
      expect(written.packages['node_modules/vite']).toEqual(source.packages['node_modules/vite']);
      expect(written.lockfileVersion).toBe(source.lockfileVersion);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('reports false when the template ships no lockfile, so create can fall back', () => {
    expect(writeTemplateLockfile(join(REPO_ROOT, 'src'), REPO_ROOT, 'x')).toBe(false);
  });
});
