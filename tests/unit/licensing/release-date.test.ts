import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { gitSafeEnv } from '../../../src/lib/command.js';
import { getReleaseDate, getReleaseDateSource } from '../../../src/lib/licensing/release-date.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const STAMP_SCRIPT = join(repoRoot, 'scripts', 'stamp-release-date.js');

/** True when `git` is on PATH — the temp-repo test skips itself without it. */
function gitAvailable() {
  try {
    // env: gitSafeEnv() here too — not because `--version` reads repo state,
    // but so this helper can never become an unscrubbed git spawn by later
    // edit (e.g. someone changing it to `git status` to probe more).
    execFileSync('git', ['--version'], { stdio: 'ignore', env: gitSafeEnv() });
    return true;
  } catch {
    return false;
  }
}

/** A fresh temp directory this test owns; always cleaned up. */
function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'vc-release-date-'));
}

describe('getReleaseDate / getReleaseDateSource', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('package.json releaseDate wins over git and clock', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    // Not a git repo at all, and the clock is stubbed to a different date —
    // if either of those won, this would fail.
    const now = () => new Date('2099-01-01T00:00:00Z');

    expect(getReleaseDate({ pkg: { releaseDate: '2026-01-15' }, repoRoot: dir, now })).toBe(
      '2026-01-15',
    );
    expect(getReleaseDateSource({ pkg: { releaseDate: '2026-01-15' }, repoRoot: dir, now })).toBe(
      'package',
    );
  });

  it('ignores a malformed package.json releaseDate value', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const now = () => new Date('2026-09-12T12:00:00Z');

    // No .git in `dir`, so a malformed stamp must fall through to the clock.
    expect(getReleaseDate({ pkg: { releaseDate: '2026/09/12' }, repoRoot: dir, now })).toBe(
      '2026-09-12',
    );
    expect(getReleaseDateSource({ pkg: { releaseDate: '2026/09/12' }, repoRoot: dir, now })).toBe(
      'clock',
    );
  });

  it.skipIf(!gitAvailable())('falls back to HEAD commit date in a git checkout', () => {
    const dir = makeTempDir();
    dirs.push(dir);

    // A hook wrapper (this repo's own husky pre-commit, or a contributor's)
    // exports GIT_DIR/GIT_INDEX_FILE into this process, which OVERRIDES both
    // `cwd` and `-C` below and would otherwise point every one of these
    // commands at the HOST repo instead of `dir` — silently committing into
    // it. `env: gitSafeEnv()` is required on every one, not just the module
    // under test. See tests/unit/lib/git-spawn-env-sweep.test.ts.
    const env = gitSafeEnv();
    execFileSync('git', ['init', '-q'], { cwd: dir, env });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, env });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, env });
    writeFileSync(join(dir, 'file.txt'), 'hello');
    execFileSync('git', ['add', 'file.txt'], { cwd: dir, env });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir, env });

    const expected = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%cs'], { env })
      .toString()
      .trim();

    expect(getReleaseDate({ pkg: {}, repoRoot: dir })).toBe(expected);
    expect(getReleaseDateSource({ pkg: {}, repoRoot: dir })).toBe('git');
  });

  it('falls back to the clock when there is no package stamp and no .git', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const now = () => new Date('2026-09-12T23:59:59Z');

    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(getReleaseDate({ pkg: {}, repoRoot: dir, now })).toBe('2026-09-12');
    expect(getReleaseDateSource({ pkg: {}, repoRoot: dir, now })).toBe('clock');
  });

  it('the committed package.json never carries a releaseDate stamp', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
    expect(pkg).not.toHaveProperty('releaseDate');
  });

  it.skipIf(!gitAvailable())(
    'with no options, resolves DEFAULT_PKG and DEFAULT_REPO_ROOT against the real checkout',
    () => {
      // Every other test injects `pkg`/`repoRoot` explicitly, so none of them
      // exercise the module's own defaults: the createRequire(...) package
      // load, or the 3-level walk from src/lib/licensing/ back up to the
      // repo root. Calling with NO options is the only way to cover that
      // path. This checkout is a git worktree (`.git` is a file, not a
      // directory) with no `releaseDate` in package.json (see the test
      // above), so the 'git' branch is what should fire.
      const realPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
      expect(realPkg.name).toBe('vibecarbon');
      expect(existsSync(join(repoRoot, '.git'))).toBe(true);

      const expected = execFileSync('git', ['-C', repoRoot, 'log', '-1', '--format=%cs'], {
        env: gitSafeEnv(),
      })
        .toString()
        .trim();

      expect(getReleaseDateSource()).toBe('git');
      expect(getReleaseDate()).toBe(expected);
    },
  );
});

describe('scripts/stamp-release-date.js', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempPackageJson(contents: object) {
    const dir = makeTempDir();
    dirs.push(dir);
    const raw = `${JSON.stringify(contents, null, 2)}\n`;
    writeFileSync(join(dir, 'package.json'), raw);
    return dir;
  }

  it('writes releaseDate and prints it', () => {
    const dir = tempPackageJson({ name: 'x', version: '1.0.0' });

    const output = execFileSync('node', [STAMP_SCRIPT, '-date', '2026-09-12'], {
      cwd: dir,
    })
      .toString()
      .trim();

    expect(output).toBe('2026-09-12');
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    expect(pkg.releaseDate).toBe('2026-09-12');
  });

  it('preserves 2-space formatting and the trailing newline', () => {
    const dir = tempPackageJson({ name: 'x', version: '1.0.0' });

    execFileSync('node', [STAMP_SCRIPT, '-date', '2026-09-12'], { cwd: dir });

    const raw = readFileSync(join(dir, 'package.json'), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('\n  "releaseDate": "2026-09-12"');
  });

  it('refuses a conflicting existing releaseDate value', () => {
    const dir = tempPackageJson({ name: 'x', version: '1.0.0', releaseDate: '2020-01-01' });

    expect(() =>
      execFileSync('node', [STAMP_SCRIPT, '-date', '2026-09-12'], { cwd: dir, stdio: 'pipe' }),
    ).toThrow();

    // Refused: the file on disk must be untouched.
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    expect(pkg.releaseDate).toBe('2020-01-01');
  });

  it('is a no-op (not a conflict) when the existing value already matches today', () => {
    const dir = tempPackageJson({ name: 'x', version: '1.0.0', releaseDate: '2026-09-12' });

    const output = execFileSync('node', [STAMP_SCRIPT, '-date', '2026-09-12'], {
      cwd: dir,
    })
      .toString()
      .trim();

    expect(output).toBe('2026-09-12');
  });
});
