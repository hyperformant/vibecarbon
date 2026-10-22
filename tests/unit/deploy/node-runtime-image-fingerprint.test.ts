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
 */
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
});
