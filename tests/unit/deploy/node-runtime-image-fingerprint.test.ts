/**
 * The node runtime base's tag must move whenever the image's OWN inputs change.
 *
 * carbon/Dockerfile builds the app FROM NODE_RUNTIME_IMAGE by tag, and every
 * server and build machine that already holds that tag keeps using it: a
 * republish under an unchanged tag never reaches them, and the app's layers
 * would sit on a base other machines see differently. NODE_RUNTIME_IMAGE's
 * `-r<N>` revision is the slot for our changes, and this test makes forgetting
 * it impossible, exactly as db-image-fingerprint.test.ts does for the db
 * image: it fingerprints docker/node-runtime and compares with
 * NODE_RUNTIME_INPUTS_SHA256, committed next to the ref in src/lib/images.js.
 *
 * Hashing: every file in docker/node-runtime except README.md (docs, not a
 * build input), sorted by name, each as `name \0 contents \0`.
 *
 * The tag and the hash are a committed PAIR. Matching the hash alone would
 * let an input change ship by pasting the new hash under the old revision,
 * which is exactly the republish-under-one-tag this exists to stop. So the
 * pair is also compared with the one in each committed baseline git can show
 * (HEAD, and origin/main when fetched): the same tag with a different hash
 * fails. Locally HEAD is the last commit, so the pre-commit run bites; a
 * shallow CI checkout without origin/main checks against itself only.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NODE_RUNTIME_IMAGE, NODE_RUNTIME_INPUTS_SHA256 } from '../../../src/lib/images.js';

const DIR = join(process.cwd(), 'docker', 'node-runtime');
const NOT_INPUTS = new Set(['README.md']);

function inputFiles(): string[] {
  return readdirSync(DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && !NOT_INPUTS.has(e.name))
    .map((e) => e.name)
    .sort();
}

function fingerprint(): string {
  const hash = createHash('sha256');
  for (const name of inputFiles()) {
    hash.update(`${name}\0`);
    hash.update(readFileSync(join(DIR, name)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

const tagOf = (ref: string) => ref.split('@')[0];

/** The committed {tag, hash} pair in images.js at `rev`, or null if git has none. */
function committedPair(rev: string): { tag: string; sha: string } | null {
  let text: string;
  try {
    text = execFileSync('git', ['show', `${rev}:src/lib/images.js`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  const ref = text.match(/^export const NODE_RUNTIME_IMAGE = '([^']+)';/m)?.[1];
  const sha = text.match(/^export const NODE_RUNTIME_INPUTS_SHA256 =\s*'([0-9a-f]{64})';/m)?.[1];
  return ref && sha ? { tag: tagOf(ref), sha } : null;
}

describe('node runtime image inputs are fingerprinted against the tag', () => {
  it('hashes the files the image is built from', () => {
    expect(inputFiles()).toEqual(expect.arrayContaining(['Dockerfile']));
  });

  it('NODE_RUNTIME_INPUTS_SHA256 matches docker/node-runtime', () => {
    const actual = fingerprint();
    expect(
      actual,
      `image inputs changed: bump the -r revision in NODE_RUNTIME_IMAGE (now ${NODE_RUNTIME_IMAGE}), ` +
        'copy the new ref into carbon/Dockerfile `ARG RUNTIME_IMAGE=`, and update the hash. ' +
        `In src/lib/images.js set NODE_RUNTIME_INPUTS_SHA256 = '${actual}'. A machine that ` +
        'already holds a tag never sees new bits published under it.',
    ).toBe(NODE_RUNTIME_INPUTS_SHA256);
  });

  it.each(['HEAD', 'origin/main'])('a new hash comes with a new -r revision (vs %s)', (rev) => {
    const committed = committedPair(rev);
    if (!committed || committed.sha === NODE_RUNTIME_INPUTS_SHA256) return;
    expect(
      tagOf(NODE_RUNTIME_IMAGE),
      `NODE_RUNTIME_INPUTS_SHA256 moved since ${rev} but the tag did not: bump the -r revision ` +
        `in NODE_RUNTIME_IMAGE (and carbon/Dockerfile's ARG RUNTIME_IMAGE=), dropping any @sha256.`,
    ).not.toBe(committed.tag);
  });

  it('the committed-pair reader parses this checkout (it would catch a stale pair)', () => {
    // Self-check: the reader must find the pair in HEAD's images.js, or the
    // revision check above silently passes for ever.
    const head = committedPair('HEAD');
    if (head === null) return; // no git (an exported tarball): nothing to compare
    expect(head.tag).toMatch(/^ghcr\.io\/hyperformant\/node-runtime:/);
    expect(head.sha).toMatch(/^[0-9a-f]{64}$/);
  });
});
