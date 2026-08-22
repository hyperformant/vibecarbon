import { describe, expect, it } from 'vitest';
import { resolveGitopsBackupBucket } from '../../../src/lib/deploy/k8s/gitops-deploy.js';

/**
 * Regression: configure.js used to pass `subEnvConfig.backupBucket ||
 * envConfig.backupBucket` — keys NOTHING ever writes (persistence uses
 * `backupS3.bucket`). The argument was always undefined, so gitops rendering
 * always fell through to a raw `${projectName}-backups` interpolation that
 * bypassed sanitization and (now) the per-project bucket salt.
 */
describe('resolveGitopsBackupBucket', () => {
  const project = { projectName: 'myapp', bucketSalt: 'ab12cd' };

  it('prefers the sub-environment persisted backup bucket', () => {
    expect(
      resolveGitopsBackupBucket(
        { backupS3: { bucket: 'sub-bucket' } },
        { backupS3: { bucket: 'parent-bucket' } },
        project,
      ),
    ).toBe('sub-bucket');
  });

  it('falls back to the parent environment persisted bucket', () => {
    expect(resolveGitopsBackupBucket({}, { backupS3: { bucket: 'parent-bucket' } }, project)).toBe(
      'parent-bucket',
    );
  });

  it('derives a salt-aware name when nothing is persisted', () => {
    expect(resolveGitopsBackupBucket({}, {}, project)).toBe('myapp-ab12cd-backups');
  });

  it('derives the legacy unsalted name for pre-salt projects', () => {
    expect(resolveGitopsBackupBucket({}, {}, { projectName: 'myapp' })).toBe('myapp-backups');
  });
});
