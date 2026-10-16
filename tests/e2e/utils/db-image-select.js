/**
 * Which db image a real-infra e2e run deploys, decided once before the run.
 *
 * The CLI itself only ever runs the pinned release (src/lib/images.js
 * DB_IMAGE:DB_IMAGE_TAG) unless VIBECARBON_DB_IMAGE names another ref. A
 * branch that moves DB_IMAGE_TAG has no release image until it merges, so
 * without help every scenario on it would fail at the first db pull. The
 * harness (never src/) closes that gap:
 *
 *   1. VIBECARBON_DB_IMAGE already set: the operator chose; use it as is.
 *   2. The working tree's image inputs differ from HEAD: fail. No published
 *      image contains uncommitted inputs, so the run would test the wrong bits.
 *   3. The release tag exists on ghcr: use it (no override).
 *   4. Otherwise the dev channel build of this branch
 *      (publish-db-image-dev.yml): DEV_DB_IMAGE:<DB_IMAGE_TAG>-<sha12>, sha12
 *      from the last commit that touched the image inputs. Present: set
 *      VIBECARBON_DB_IMAGE for the run (every CLI child inherits it). Absent:
 *      fail now, with what to do.
 *
 * One registry lookup per candidate, manifest HEAD only (nothing is pulled),
 * and no waiting for a publish to finish (Mitigation Policy: fail fast).
 *
 * PLAIN JS so scripts/iter-step.js (bare node) can share it with runner.ts.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DB_IMAGE,
  DB_IMAGE_OVERRIDE_ENV,
  DB_IMAGE_TAG,
  DEV_DB_IMAGE,
  DEV_DB_IMAGE_SHA_LENGTH,
} from '../../../src/lib/images.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The db image's inputs, as a git pathspec. publish-db-image-dev.yml's plan
 * job uses this exact list (pinned by tests/unit/deploy/workflow-platforms
 * .test.ts), so the sha the workflow tags and the sha the harness looks up
 * are the same commit. READMEs are docs, not inputs. src/lib/images.js holds
 * DB_IMAGE_TAG, the dev tag's prefix, so editing it moves the dev tag too.
 */
export const DB_IMAGE_INPUT_PATHSPEC = [
  'docker/postgres-walg',
  'docker/wal-g',
  'src/lib/images.js',
  ':(exclude)docker/postgres-walg/README.md',
  ':(exclude)docker/wal-g/README.md',
];

export class E2EDbImageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'E2EDbImageError';
  }
}

/** @param {string[]} args */
function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();
}

/** @type {{ dirtyInputs: () => string[], lastInputCommit: () => string }} */
export const defaultGit = {
  // Modified, staged, deleted or untracked input files, relative to HEAD.
  dirtyInputs: () =>
    git(['status', '--porcelain', '--untracked-files=all', '--', ...DB_IMAGE_INPUT_PATHSPEC])
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3)),
  lastInputCommit: () => git(['log', '-1', '--format=%H', 'HEAD', '--', ...DB_IMAGE_INPUT_PATHSPEC]),
};

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/**
 * Can this run pull `ghcr.io/<repo>:<tag>`? Anonymous token, then a manifest
 * HEAD: 200 yes, 404 no. A token DENIED (no such package, or a private one)
 * is no. Anything else throws: "not published" is never guessed from an
 * outage.
 *
 * @param {string} ref
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<boolean>}
 */
export async function ghcrManifestExists(ref, fetchImpl = fetch) {
  const m = /^ghcr\.io\/([^:@]+):([^:@/]+)$/.exec(ref);
  if (!m) throw new E2EDbImageError(`not a ghcr.io repo:tag ref: ${ref}`);
  const [, repo, tag] = m;
  const tokenRes = await fetchImpl(`https://ghcr.io/token?scope=repository:${repo}:pull`);
  // ghcr answers DENIED alike for a package that does not exist yet and for a
  // private one: both mean "nothing this run can pull", so both are false.
  if (tokenRes.status === 403) return false;
  if (!tokenRes.ok) {
    throw new E2EDbImageError(`ghcr refused an anonymous pull token for ${repo} (HTTP ${tokenRes.status})`);
  }
  const { token } = /** @type {{ token: string }} */ (await tokenRes.json());
  const res = await fetchImpl(`https://ghcr.io/v2/${repo}/manifests/${tag}`, {
    method: 'HEAD',
    headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT },
  });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new E2EDbImageError(
    `ghcr answered HTTP ${res.status} for ${ref}` +
      (res.status === 401 || res.status === 403
        ? ': the package is private. Flip it public in the org package settings (AGENTS.md).'
        : ''),
  );
}

/**
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   manifestExists?: (ref: string) => Promise<boolean>,
 *   git?: { dirtyInputs: () => string[], lastInputCommit: () => string },
 *   log?: (msg: string) => void,
 * }} [deps]
 * @returns {Promise<{ ref: string, source: 'override' | 'release' | 'dev' }>}
 *   source 'dev' means env[VIBECARBON_DB_IMAGE] was set to ref.
 */
export async function selectE2EDbImage({
  env = process.env,
  manifestExists = ghcrManifestExists,
  git: g = defaultGit,
  log = (msg) => console.log(msg),
} = {}) {
  const chosen = (env[DB_IMAGE_OVERRIDE_ENV] ?? '').trim();
  if (chosen) {
    log(`  DB image (${DB_IMAGE_OVERRIDE_ENV}): ${chosen}`);
    return { ref: chosen, source: 'override' };
  }

  const dirty = g.dirtyInputs();
  if (dirty.length > 0) {
    throw new E2EDbImageError(
      `db image inputs differ from HEAD (${dirty.join(', ')}), so no published image matches ` +
        `this tree: commit and push them and wait for publish-db-image-dev, or set ${DB_IMAGE_OVERRIDE_ENV}`,
    );
  }

  const release = `${DB_IMAGE}:${DB_IMAGE_TAG}`;
  if (await manifestExists(release)) {
    log(`  DB image (release): ${release}`);
    return { ref: release, source: 'release' };
  }

  const sha = g.lastInputCommit().slice(0, DEV_DB_IMAGE_SHA_LENGTH);
  const dev = `${DEV_DB_IMAGE}:${DB_IMAGE_TAG}-${sha}`;
  if (!(await manifestExists(dev))) {
    throw new E2EDbImageError(
      `${release} is not published and the dev image for ${sha} not published yet (${dev}): ` +
        `push the branch and wait for publish-db-image-dev, or set ${DB_IMAGE_OVERRIDE_ENV}. ` +
        'If the push did not trigger it (rewritten history with the same inputs), run it by hand: ' +
        '`gh workflow run publish-db-image-dev.yml --ref <branch>`. ' +
        `(If the workflow did publish it, the ${DEV_DB_IMAGE} package is still private: flip it public once.)`,
    );
  }
  env[DB_IMAGE_OVERRIDE_ENV] = dev;
  log(`  DB image (dev channel, ${release} is not published): ${dev}`);
  return { ref: dev, source: 'dev' };
}
