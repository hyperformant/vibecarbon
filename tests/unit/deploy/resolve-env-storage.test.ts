import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveEnvStorage, StorageBucketMismatchError } from '../../../src/lib/deploy/prompts.js';

const project = { projectName: 'myapp', bucketSalt: 'cd9ecc' };

function mismatchOf(envConfig: object): Error {
  let err: unknown;
  try {
    resolveEnvStorage('prod', envConfig, project);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(StorageBucketMismatchError);
  return err as Error;
}

describe('resolveEnvStorage', () => {
  it('derives the env bucket, backup bucket and wal-g prefix, with no key prefix', () => {
    const r = resolveEnvStorage('prod', {}, project);
    expect(r).toEqual({
      bucket: 'myapp-cd9ecc-prod-storage',
      backupBucket: 'myapp-cd9ecc-backups',
      walgPrefix: 'backups/myapp/prod/walg',
    });
    expect(Object.hasOwn(r, 'keyPrefix')).toBe(false);
  });

  it('gives two environments two buckets and one backup bucket', () => {
    const a = resolveEnvStorage('staging', {}, project);
    const b = resolveEnvStorage('prod', {}, project);
    expect(a.bucket).not.toBe(b.bucket);
    expect(a.backupBucket).toBe(b.backupBucket);
  });

  it('prefers a persisted backupS3.bucket', () => {
    const r = resolveEnvStorage('prod', { backupS3: { bucket: 'old-backups' } }, project);
    expect(r.backupBucket).toBe('old-backups');
  });

  it('fails closed on a persisted per-project bucket, naming the pin and the copy step', () => {
    const msg = mismatchOf({
      s3: { bucket: 'myapp-cd9ecc-storage', accessKey: 'AKIASECRET', secretKey: 'SKSECRET' },
    }).message;
    expect(msg).toContain('myapp-cd9ecc-storage');
    expect(msg).toContain('myapp-cd9ecc-prod-storage');
    expect(msg).toContain('bucketPin');
    expect(msg).toContain('aws s3 sync');
    expect(msg).not.toContain('AKIASECRET');
    expect(msg).not.toContain('SKSECRET');
  });

  it('fails closed on an old generation-suffixed name', () => {
    expect(mismatchOf({ s3: { bucket: 'myapp-cd9ecc-storage-93872b' } }).message).toContain(
      'myapp-cd9ecc-storage-93872b',
    );
  });

  it('does not throw when the persisted s3.bucket equals the derived env name', () => {
    const r = resolveEnvStorage('prod', { s3: { bucket: 'myapp-cd9ecc-prod-storage' } }, project);
    expect(r.bucket).toBe('myapp-cd9ecc-prod-storage');
  });

  it('lets envConfig.s3.bucketPin win over derivation', () => {
    expect(resolveEnvStorage('prod', { s3: { bucketPin: 'legacy-b' } }, project).bucket).toBe(
      'legacy-b',
    );
    expect(
      resolveEnvStorage('prod', { s3: { bucketPin: 'legacy-b', bucket: 'legacy-b' } }, project)
        .bucket,
    ).toBe('legacy-b');
  });

  it.each(['', 'Has_Caps', 'a', '-lead', `${'x'.repeat(64)}`])(
    'rejects a malformed bucketPin %j with the pin error shape',
    (pin) => {
      expect(() => resolveEnvStorage('prod', { s3: { bucketPin: pin } }, project)).toThrow(
        /Invalid bucketPin for environment "prod" .*3-63 chars.*"environments\.prod\.s3\.bucketPin" entry/,
      );
    },
  );

  it('tells a prefixed legacy bucket and an un-prefixed one how to copy across', () => {
    const msg = mismatchOf({ s3: { bucket: 'myapp-cd9ecc-storage' } }).message;
    expect(msg).toContain(
      'aws s3 sync s3://myapp-cd9ecc-storage/prod/ s3://myapp-cd9ecc-prod-storage/',
    );
    expect(msg).toContain('aws s3 sync s3://myapp-cd9ecc-storage s3://myapp-cd9ecc-prod-storage;');
  });

  it('ignores the removed project-wide appBucket pin', () => {
    expect(resolveEnvStorage('prod', {}, { ...project, appBucket: 'my-pinned' }).bucket).toBe(
      'myapp-cd9ecc-prod-storage',
    );
  });
});

describe('envConfig.s3.bucketPin survives every save that rebuilds s3', () => {
  // A pin dropped by the post-deploy save would make the next deploy derive
  // the env name again and fail closed on its own persisted bucket.
  const read = (f: string) => readFileSync(new URL(`../../../${f}`, import.meta.url), 'utf8');

  it('deploy hands the pin from envConfig to s3Config', () => {
    expect(read('src/lib/deploy/prompts.js')).toContain(
      '...(envConfig.s3?.bucketPin && { bucketPin: envConfig.s3.bucketPin }),',
    );
  });

  // The orchestrator's skeleton save builds its s3 through skeletonS3Block,
  // whose pin is pinned by skeleton-s3-block.test.ts; the post-deploy save is
  // the one inline rebuild left there.
  it.each([
    ['src/lib/deploy/orchestrator.js', 1],
    ['src/lib/deploy/effects/compose-ha.js', 1],
  ])('%s persists the pin next to every rebuilt s3.bucket', (file, count) => {
    const persist =
      /s3: \{\s*bucket: s3Config\.bucket,\s*\.\.\.\(s3Config\.bucketPin && \{ bucketPin: s3Config\.bucketPin \}\),/g;
    const rebuilt = /s3: \{\s*bucket: s3Config\.bucket,/g;
    const src = read(file);
    expect(src.match(rebuilt)).toHaveLength(count);
    expect(src.match(persist)).toHaveLength(count);
  });
});
