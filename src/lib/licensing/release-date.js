/**
 * The CLI's own release date, as a `'YYYY-MM-DD'` UTC string.
 *
 * A later task compares this against a license's paid-through date, so it
 * has to be trustworthy in every shape the CLI ships in — the published npm
 * tarball, a contributor's source checkout, and a worktree. Resolution
 * order:
 *
 *   a. `pkg.releaseDate`, when it matches `/^\d{4}-\d{2}-\d{2}$/`. This is
 *      the real stamp: `scripts/stamp-release-date.js` writes it into the
 *      working tree's package.json immediately before
 *      `.github/workflows/release.yml` runs `semantic-release`, so it is
 *      the published tarball's actual release date.
 *   b. Else, if `<repoRoot>/.git` exists (a file OR a directory — a
 *      worktree's `.git` is a file pointing at the real gitdir, so this
 *      still resolves there): the UTC date of HEAD's commit, via
 *      `git log -1 --format=%cs`. A source checkout — a contributor's
 *      clone, or CI before the stamping step runs — is "released" as of
 *      its last commit.
 *   c. Else, today's UTC date. This is the fail-CLOSED direction: an
 *      unstamped, non-git build (a broken or tampered install) is treated
 *      as the newest possible release, so a later paid-through comparison
 *      never grants it extra runway it hasn't earned.
 *
 * No environment variable may influence any of this — see
 * tests/unit/licensing/no-dev-bypass.test.ts, whose source census covers
 * every file in this directory.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitSafeEnv } from '../command.js';

const require = createRequire(import.meta.url);

const RELEASE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULT_PKG = require('../../../package.json');
// This module lives at src/lib/licensing/release-date.js, three directories
// below the repo root — walk back up that same distance.
const DEFAULT_REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_NOW = () => new Date();

/** HEAD's commit date (`%cs`, already UTC `YYYY-MM-DD`), or null on any error. */
function gitHeadDate(repoRoot) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'log', '-1', '--format=%cs'], {
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
      // A hook wrapper (husky, pre-commit) exports GIT_DIR into this process,
      // which OVERRIDES -C and points the read at the host repo. See
      // tests/unit/lib/git-spawn-env-sweep.test.ts.
      env: gitSafeEnv(),
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/** Shared resolution walk. `date` is null when `source` is 'clock' — the caller supplies it. */
function resolve(pkg, repoRoot) {
  if (typeof pkg.releaseDate === 'string' && RELEASE_DATE_RE.test(pkg.releaseDate)) {
    return { source: 'package', date: pkg.releaseDate };
  }
  if (existsSync(join(repoRoot, '.git'))) {
    const date = gitHeadDate(repoRoot);
    if (date) return { source: 'git', date };
  }
  return { source: 'clock', date: null };
}

/**
 * @param {{ pkg?: object, repoRoot?: string, now?: () => Date }} [options]
 * @returns {string} `'YYYY-MM-DD'` in UTC
 */
export function getReleaseDate({
  pkg = DEFAULT_PKG,
  repoRoot = DEFAULT_REPO_ROOT,
  now = DEFAULT_NOW,
} = {}) {
  const { source, date } = resolve(pkg, repoRoot);
  return source === 'clock' ? now().toISOString().slice(0, 10) : date;
}

/**
 * Same resolution as {@link getReleaseDate}, for diagnostics: which branch
 * produced the date.
 * @param {{ pkg?: object, repoRoot?: string, now?: () => Date }} [options]
 * @returns {'package' | 'git' | 'clock'}
 */
// `now` is deliberately not a parameter here: the SOURCE of the date never
// depends on the clock (only getReleaseDate's 'clock' branch reads it), and
// callers passing the same options object used for getReleaseDate() work
// fine regardless — an extra `now` key is simply ignored.
export function getReleaseDateSource({ pkg = DEFAULT_PKG, repoRoot = DEFAULT_REPO_ROOT } = {}) {
  return resolve(pkg, repoRoot).source;
}
