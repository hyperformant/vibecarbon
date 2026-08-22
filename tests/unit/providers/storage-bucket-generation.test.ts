/**
 * Storage-bucket GENERATION: a purge-destroy → redeploy must derive a FRESH
 * storage-bucket name, never recreate the just-deleted one.
 *
 * RCA 2026-08-17 (registry-500 campaign, run 32013980356 closing evidence):
 * the k8s restore leg purge-destroys the storage bucket and the re-deploy
 * recreates it UNDER THE SAME NAME — Hetzner object storage's documented
 * worst case. Delete→same-name-recreate propagation flapped `NoSuchBucket`
 * at the registry's S3 driver for >10 minutes, exhausting even the deep
 * push ladder. The state bucket solved the same hazard in 2026-08-07 with
 * `stateBucketGeneration` (then converged on retention); the storage bucket
 * cannot be retained across `-purge` (purge means the data is deleted), so
 * it gets the generation: rotated by a verified destroy that actually
 * deleted the bucket, embedded in future derivations only. Persisted env
 * bucket names always win, so live environments never move.
 *
 * The BACKUP bucket must NEVER carry the generation: restore finds its
 * wal-g backups by that name after a destroy — rotating it would orphan
 * every backup at exactly the moment restore needs them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deriveProjectBucketName } from '../../../src/lib/providers/s3-base.js';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');

describe('deriveProjectBucketName storage generation', () => {
  const base = { projectName: 'myapp', bucketSalt: 'a1b2c3' };

  it('embeds the storage generation in the storage bucket name', () => {
    expect(deriveProjectBucketName({ ...base, storageBucketGeneration: 'f00d42' })).toBe(
      'myapp-a1b2c3-storage-f00d42',
    );
  });

  it('the backups bucket NEVER carries the generation (restore depends on the stable name)', () => {
    expect(deriveProjectBucketName({ ...base, storageBucketGeneration: 'f00d42' }, 'backups')).toBe(
      'myapp-a1b2c3-backups',
    );
  });

  it('legacy projects without a generation keep byte-stable names', () => {
    expect(deriveProjectBucketName(base)).toBe('myapp-a1b2c3-storage');
    expect(deriveProjectBucketName({ projectName: 'oldapp' })).toBe('oldapp-storage');
  });

  it('the generation survives the 63-char clip on long project names', () => {
    const long = {
      projectName: `citest-${'x'.repeat(60)}`,
      bucketSalt: 'a1b2c3',
      storageBucketGeneration: 'f00d42',
    };
    const name = deriveProjectBucketName(long);
    expect(name.length).toBeLessThanOrEqual(63);
    // The functional tail is preserved whole — a tail-clip would eat it.
    expect(name.endsWith('-storage-f00d42')).toBe(true);
  });
});

describe('generation lifecycle wiring', () => {
  it('create seeds storageBucketGeneration alongside stateBucketGeneration', () => {
    const src = read('src/create.js');
    expect(src).toMatch(/storageBucketGeneration:\s*generateBucketSalt\(\)/);
  });
});
