/**
 * Every env save rebuilds `s3`. The rebuilds once each kept a different
 * subset: the skeleton save dropped `bucketCreatedAt`, compose-HA's pending
 * save dropped `appKey` and `unfencedBuckets` (orphaning a minted key and
 * un-fencing a pasted Hetzner key on a failed deploy). One builder now, and a
 * census holds every save to it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { envS3Record } from '../../../src/lib/deploy/s3-record.js';

const s3Config = {
  bucket: 'myapp-cd9ecc-prod-storage',
  region: 'fsn1',
  endpoint: 'https://fsn1.your-objectstorage.com',
  stateBucket: 'myapp-cd9ecc-storage-pulumi-state',
};
const appKey = { id: 'k-1', scoping: 'mint', tier: 'env', bucket: s3Config.bucket };

describe('envS3Record', () => {
  it('keeps the recorded bucketCreatedAt', () => {
    expect(envS3Record(s3Config, { bucketCreatedAt: '2026-10-20T10:00:00.000Z' })).toEqual({
      ...s3Config,
      bucketCreatedAt: '2026-10-20T10:00:00.000Z',
    });
  });

  it('keeps an explicit null, and adds no key when none was recorded', () => {
    expect(envS3Record(s3Config, { bucketCreatedAt: null }).bucketCreatedAt).toBeNull();
    expect(envS3Record(s3Config, undefined)).not.toHaveProperty('bucketCreatedAt');
  });

  it('carries the pin and the state bucket fields', () => {
    expect(
      envS3Record(
        { ...s3Config, bucketPin: 'pinned', stateBucketRegion: 'nbg1', stateEndpoint: 'https://e' },
        {},
      ),
    ).toMatchObject({ bucketPin: 'pinned', stateBucketRegion: 'nbg1', stateEndpoint: 'https://e' });
  });

  it('carries the prior app key until this deploy resolves one, then follows s3Config', () => {
    expect(envS3Record(s3Config, { appKey }).appKey).toEqual(appKey);
    const next = { ...appKey, id: 'k-2' };
    expect(envS3Record({ ...s3Config, appKey: next }, { appKey }).appKey).toEqual(next);
    expect(envS3Record({ ...s3Config, appKey: null }, { appKey })).not.toHaveProperty('appKey');
  });

  it('carries non-empty unfencedBuckets only', () => {
    expect(envS3Record(s3Config, { unfencedBuckets: ['b'] }).unfencedBuckets).toEqual(['b']);
    expect(envS3Record(s3Config, { unfencedBuckets: [] })).not.toHaveProperty('unfencedBuckets');
    expect(envS3Record(s3Config, { unfencedBuckets: undefined })).not.toHaveProperty(
      'unfencedBuckets',
    );
  });

  it('census: no env save in src builds an s3 block by hand', () => {
    const files = execFileSync('git', ['ls-files', '--', 'src/**/*.js', 'src/*.js'], {
      encoding: 'utf-8',
    })
      .split('\n')
      .filter((f) => f && f !== 'src/lib/deploy/s3-record.js');
    const offenders = files.filter((f) =>
      /stateBucket:\s*s3Config\.stateBucket/.test(readFileSync(f, 'utf-8')),
    );
    expect(offenders).toEqual([]);
    for (const f of ['src/lib/deploy/orchestrator.js', 'src/lib/deploy/effects/compose-ha.js']) {
      expect(readFileSync(f, 'utf-8')).toMatch(/s3: envS3Record\(s3Config, /);
    }
  });
});
