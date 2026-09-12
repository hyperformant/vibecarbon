import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateGitignore } from '../../../src/lib/project.js';

/**
 * Runs `vibecarbon create` from a freshly PACKED tarball — the artifact
 * customers install — not from the checkout.
 *
 * Every other create test (unit, integration, e2e, CI) spawns
 * src/cli.js from the repo, whose template dir is the git checkout of
 * carbon/. That is not what `npm install -g vibecarbon` delivers: npm
 * pack applies package.json `files`, both .npmignore files, and its own
 * hard-coded basename strips. Through 0.43.0 that gap shipped a package
 * whose first command failed ("Generated .gitignore is missing required
 * patterns: .gitignore is missing") while the whole matrix stayed green.
 *
 * tarball-ships-template.test.ts catches the mechanism (a tracked file
 * missing from the pack list). This test catches the outcome: whatever
 * the cause, a package that cannot scaffold a project does not pass CI.
 *
 * The tarball's runtime dependencies are satisfied by symlinking the
 * repo's node_modules into the extracted package — the CLI's own deps are
 * the same set, and the point is the tarball's FILE CONTENTS, not a
 * network install. -skip-lockfile keeps the generated project offline.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let scratch: string;
let packageDir: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'vc-create-from-tarball-'));
  const packDest = join(scratch, 'pack');
  mkdirSync(packDest);

  execFileSync('npm', ['pack', '--pack-destination', packDest], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  const tgz = readdirSync(packDest).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error(`npm pack produced no .tgz in ${packDest}`);

  const extractDir = join(scratch, 'extract');
  mkdirSync(extractDir);
  execFileSync('tar', ['-xzf', join(packDest, tgz), '-C', extractDir]);
  packageDir = join(extractDir, 'package');
  if (!existsSync(join(packageDir, 'src', 'cli.js'))) {
    throw new Error(`extracted tarball has no src/cli.js under ${packageDir}`);
  }
  symlinkSync(join(repoRoot, 'node_modules'), join(packageDir, 'node_modules'), 'dir');
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe('vibecarbon create from the packed tarball', () => {
  it('scaffolds a project with a complete .gitignore', () => {
    const work = join(scratch, 'work');
    mkdirSync(work);
    const fakeHome = join(scratch, 'home');
    mkdirSync(fakeHome);

    const r = spawnSync(
      process.execPath,
      [
        join(packageDir, 'src', 'cli.js'),
        'create',
        'smoke',
        '-y',
        '-admin-email',
        'smoke@example.com',
        '-admin-password',
        'smokepass123',
        '-skip-lockfile',
      ],
      {
        cwd: work,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: fakeHome,
          DO_NOT_TRACK: '1',
          NO_COLOR: '1',
          FORCE_COLOR: '0',
        },
        timeout: 180_000,
        maxBuffer: 32 * 1024 * 1024,
      },
    );

    expect(
      r.status,
      `create from the tarball exited ${r.status}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
    ).toBe(0);

    const project = join(work, 'smoke');
    expect(existsSync(join(project, 'package.json'))).toBe(true);
    expect(existsSync(join(project, '.git'))).toBe(true);
    expect(validateGitignore(join(project, '.gitignore'))).toEqual([]);
  });
});
