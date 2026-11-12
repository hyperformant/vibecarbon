/**
 * Compose and compose-ha carry the env's name (VC_ENV) in the rendered bundle
 * .env, because compose's WALG_S3_PREFIX reads it. k8s does not: its WAL-G
 * prefix is rendered from s3Config.walgPrefix, nothing in carbon/k8s reads
 * VC_ENV, and in k8s-ha the stack env (prod-primary / prod-standby) is not
 * even the environment's name. Each env has its own app bucket, so no writer
 * carries an object key prefix (S3_KEY_PREFIX was removed by design).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAppSecretData, buildInfraSecretData } from '../../../src/lib/deploy/k8s/k3s.js';

const src = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf-8');

describe('k8s app and infra Secrets', () => {
  it('carry the bucket, and neither VC_ENV nor S3_KEY_PREFIX', () => {
    const args = {
      envLocal: {},
      s3Config: {
        accessKey: 'ak',
        secretKey: 'sk',
        bucket: 'myapp-abc123-storage',
        endpoint: 'https://fsn1.your-objectstorage.com',
        region: 'fsn1',
      },
      backupTarget: null,
    };
    const app = buildAppSecretData(args);
    const infra = buildInfraSecretData(args);
    for (const stringData of [app, infra]) {
      expect(stringData).not.toHaveProperty('S3_KEY_PREFIX');
      expect(stringData).not.toHaveProperty('VC_ENV');
    }
    expect(app.S3_BUCKET).toBe('myapp-abc123-storage');
  });

  it("the infra Secret's S3_BACKUP_BUCKET is the backups target's bucket, never the uploads bucket", () => {
    // The backup CronJob and the db pod's wal-g read S3_BACKUP_BUCKET from the
    // infra Secret; an environment an older CLI put in another region's
    // backups bucket keeps it.
    const s3Config = {
      accessKey: 'ak',
      secretKey: 'sk',
      bucket: 'myapp-abc123-staging-storage',
      endpoint: 'https://fsn1.your-objectstorage.com',
      region: 'fsn1',
    };
    const backupTarget = {
      bucket: 'myapp-abc123-backups',
      region: 'nbg1',
      endpoint: 'https://nbg1.your-objectstorage.com',
    };
    const infra = buildInfraSecretData({ envLocal: {}, s3Config, backupTarget });
    expect(infra.S3_BACKUP_BUCKET).toBe('myapp-abc123-backups');
    expect(Object.values(infra)).not.toContain(s3Config.bucket);
    // No target, no backups bucket: nothing names one.
    expect(buildInfraSecretData({ envLocal: {}, s3Config, backupTarget: null })).not.toHaveProperty(
      'S3_BACKUP_BUCKET',
    );
  });

  it('applyK3sManifests hands the Secret no environment', () => {
    const k3s = src('src/lib/deploy/k8s/k3s.js');
    expect(k3s).toMatch(
      // `restore` is the deploy -restore marker (a backup name and recovery
      // settings), not an environment; nor is `walgRole` (the db's wal-g role
      // intent, primary or standby).
      /applyVibecarbonSecrets\(\{\s*kubeconfig,\s*envLocal,\s*s3Config,\s*backupTarget,\s*restore,\s*walgRole,?\s*\}\)/,
    );
    expect(k3s).not.toMatch(/VC_ENV\s*=/);
  });
});

describe('no writer knows S3_KEY_PREFIX', () => {
  it.each([
    'src/lib/deploy/bundle.js',
    'src/lib/deploy/k8s/k3s.js',
    'src/lib/deploy/app-runtime-env.js',
  ])('%s', (rel) => {
    expect(src(rel).match(/S3_KEY_PREFIX|keyPrefix/g) ?? []).toEqual([]);
  });
});

describe('compose and compose-ha server .env', () => {
  it('the orchestrator renders the bundle with the environment and its s3Config', () => {
    const orch = src('src/lib/deploy/orchestrator.js');
    const options = orch.slice(orch.indexOf('const bundleOptions = {'));
    const body = options.slice(0, options.indexOf('\n  };'));
    expect(body).toMatch(/\benvironment,/);
    expect(body).toMatch(/s3: s3Config,/);
    expect(orch).toMatch(/renderBundle\(projectConfig\.projectName, bundleOptions\)/);
  });

  it('compose-ha ships that same rendered bundle, not a second .env writer', () => {
    const ha = src('src/lib/deploy/effects/compose-ha.js');
    expect(ha).toContain('bundlePath: ctx.bundlePath,');
    expect(ha).not.toMatch(/renderBundle\(/);
    expect(src('src/lib/deploy/compose/ha.js')).not.toMatch(/renderBundle\(|S3_BUCKET/);
  });
});
