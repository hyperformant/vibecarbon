import { describe, expect, it } from 'vitest';
import { resolveEnvStorage, StorageBucketMismatchError } from '../../../src/lib/deploy/prompts.js';

const project = { projectName: 'myapp', bucketSalt: 'cd9ecc' };

describe('resolveEnvStorage', () => {
  it('derives bucket, key prefix, backup bucket and wal-g prefix', () => {
    expect(resolveEnvStorage('staging', {}, project)).toEqual({
      bucket: 'myapp-cd9ecc-storage',
      keyPrefix: 'staging/',
      backupBucket: 'myapp-cd9ecc-backups',
      walgPrefix: 'backups/myapp/staging/walg',
    });
  });

  it('gives two environments one bucket and different key prefixes', () => {
    const a = resolveEnvStorage('staging', {}, project);
    const b = resolveEnvStorage('production', {}, project);
    expect(a.bucket).toBe(b.bucket);
    expect(a.keyPrefix).not.toBe(b.keyPrefix);
  });

  it('prefers a persisted backupS3.bucket', () => {
    const r = resolveEnvStorage('staging', { backupS3: { bucket: 'old-backups' } }, project);
    expect(r.backupBucket).toBe('old-backups');
  });

  it('throws StorageBucketMismatchError when a persisted s3.bucket differs', () => {
    const envConfig = {
      s3: { bucket: 'myapp-cd9ecc-storage-93872b', accessKey: 'AKIASECRET', secretKey: 'SKSECRET' },
    };
    let err: unknown;
    try {
      resolveEnvStorage('staging', envConfig, project);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StorageBucketMismatchError);
    const msg = (err as Error).message;
    expect(msg).toContain('myapp-cd9ecc-storage-93872b');
    expect(msg).toContain('myapp-cd9ecc-storage');
    expect(msg).toContain('"appBucket"');
    expect(msg).toContain('aws s3 mv');
    expect(msg).not.toContain('AKIASECRET');
    expect(msg).not.toContain('SKSECRET');
  });

  it('does not throw when the persisted s3.bucket equals the derived name', () => {
    const r = resolveEnvStorage('staging', { s3: { bucket: 'myapp-cd9ecc-storage' } }, project);
    expect(r.bucket).toBe('myapp-cd9ecc-storage');
  });

  it('lets projectConfig.appBucket win over derivation', () => {
    const r = resolveEnvStorage('staging', {}, { ...project, appBucket: 'my-pinned' });
    expect(r.bucket).toBe('my-pinned');
    expect(
      resolveEnvStorage(
        'staging',
        { s3: { bucket: 'my-pinned' } },
        { ...project, appBucket: 'my-pinned' },
      ).bucket,
    ).toBe('my-pinned');
  });
});
