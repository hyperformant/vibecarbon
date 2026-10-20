/**
 * The deploy's skeleton save (status 'deploying', written before any S3 work)
 * rebuilt `s3` from s3Config and dropped `bucketCreatedAt`, so a deploy that
 * died after it lost status' "storage settling" row and the e2e upload gate's
 * clock. It now carries the recorded value, like compose-ha's pending save.
 */
import { describe, expect, it } from 'vitest';
import { skeletonS3Block } from '../../../src/lib/deploy/orchestrator.js';

const s3Config = {
  bucket: 'myapp-cd9ecc-prod-storage',
  region: 'fsn1',
  endpoint: 'https://fsn1.your-objectstorage.com',
  stateBucket: 'myapp-cd9ecc-storage-pulumi-state',
};

describe('skeletonS3Block', () => {
  it('keeps the recorded bucketCreatedAt', () => {
    expect(skeletonS3Block(s3Config, { bucketCreatedAt: '2026-10-20T10:00:00.000Z' })).toEqual({
      ...s3Config,
      bucketCreatedAt: '2026-10-20T10:00:00.000Z',
    });
  });

  it('keeps an explicit null, and adds no key when none was recorded', () => {
    expect(skeletonS3Block(s3Config, { bucketCreatedAt: null }).bucketCreatedAt).toBeNull();
    expect(skeletonS3Block(s3Config, undefined)).not.toHaveProperty('bucketCreatedAt');
  });

  it('carries the pin and the state bucket fields', () => {
    expect(
      skeletonS3Block(
        { ...s3Config, bucketPin: 'pinned', stateBucketRegion: 'nbg1', stateEndpoint: 'https://e' },
        {},
      ),
    ).toMatchObject({ bucketPin: 'pinned', stateBucketRegion: 'nbg1', stateEndpoint: 'https://e' });
  });

  it('the skeleton save uses it with the existing env s3', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/lib/deploy/orchestrator.js', 'utf-8');
    const body = src.slice(src.indexOf('const saveSkeletonEnv = () => {'));
    expect(body.slice(0, body.indexOf('saveProjectConfig('))).toContain(
      's3: skeletonS3Block(s3Config, existingEnv.s3),',
    );
  });
});
