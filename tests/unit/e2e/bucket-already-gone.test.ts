import { describe, expect, it } from 'vitest';
import { isBucketAlreadyGone } from '../../../tests/e2e/utils/bucket-already-gone.js';

describe('isBucketAlreadyGone', () => {
  it('matches the S3-compatible not-exists spellings (stale-listing goal state)', () => {
    // Live veto, run 33538738831 (DO k8s-ha): every lifecycle step green,
    // scenario branded [regression] because the sweep's stale listing named
    // a bucket final-destroy had already removed.
    expect(isBucketAlreadyGone(new Error('The specified bucket does not exist'))).toBe(true);
    expect(isBucketAlreadyGone(new Error('NoSuchBucket: not found'))).toBe(true);
    expect(isBucketAlreadyGone(new Error('bucket "x-backups" does not exist'))).toBe(true);
    expect(isBucketAlreadyGone('The specified bucket does not exist')).toBe(true);
  });

  it('keeps every other delete failure loud — auth, network, object-level', () => {
    expect(isBucketAlreadyGone(new Error('403 Forbidden'))).toBe(false);
    expect(isBucketAlreadyGone(new Error('ECONNRESET'))).toBe(false);
    expect(isBucketAlreadyGone(new Error('NoSuchKey: object missing'))).toBe(false);
    expect(isBucketAlreadyGone(new Error('AccessDenied listing objects'))).toBe(false);
    expect(isBucketAlreadyGone(new Error('SlowDown'))).toBe(false);
  });
});
