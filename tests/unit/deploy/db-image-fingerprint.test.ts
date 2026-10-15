/**
 * The db image tag must move whenever the image's OWN inputs change.
 *
 * Compose pulls the db image with policy `missing` and k8s with IfNotPresent,
 * so a republish under an unchanged tag never reaches a server that already
 * has that tag: it keeps running the old bits while the repo says otherwise.
 * DB_IMAGE_TAG's `-r<N>` revision is the slot for our changes (Dockerfile,
 * db-entrypoint.sh, postgresql.conf, the pg_cron pin), and this test makes
 * forgetting it impossible: it fingerprints docker/postgres-walg and compares
 * with DB_IMAGE_INPUTS_SHA256, committed next to the tag in src/lib/images.js.
 *
 * Hashing: every file in docker/postgres-walg except README.md (docs, not a
 * build input), sorted by name, each as `name \0 contents \0`. A new file in
 * the directory counts automatically, since anything there can be COPY'd.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DB_IMAGE_INPUTS_SHA256, DB_IMAGE_TAG } from '../../../src/lib/images.js';

const DIR = join(process.cwd(), 'docker', 'postgres-walg');
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

describe('db image inputs are fingerprinted against the tag', () => {
  it('hashes the files the image is built from', () => {
    // Sanity: an empty or misplaced directory would hash to a constant.
    expect(inputFiles()).toEqual(
      expect.arrayContaining(['Dockerfile', 'db-entrypoint.sh', 'postgresql.conf']),
    );
  });

  it('DB_IMAGE_INPUTS_SHA256 matches docker/postgres-walg', () => {
    const actual = fingerprint();
    expect(
      actual,
      `image inputs changed: bump the -r revision in DB_IMAGE_TAG (now ${DB_IMAGE_TAG}) ` +
        `and update the hash. In src/lib/images.js set DB_IMAGE_INPUTS_SHA256 = '${actual}'. ` +
        'Servers pull with policy missing / IfNotPresent, so the same tag with new bits never ' +
        'reaches a server that already has it.',
    ).toBe(DB_IMAGE_INPUTS_SHA256);
  });
});
