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
      backupBucketName: null,
    };
    const app = buildAppSecretData(args);
    const infra = buildInfraSecretData(args);
    for (const stringData of [app, infra]) {
      expect(stringData).not.toHaveProperty('S3_KEY_PREFIX');
      expect(stringData).not.toHaveProperty('VC_ENV');
    }
    expect(app.S3_BUCKET).toBe('myapp-abc123-storage');
  });

  it('applyK3sManifests hands the Secret no environment', () => {
    const k3s = src('src/lib/deploy/k8s/k3s.js');
    expect(k3s).toMatch(
      /applyVibecarbonSecrets\(\{\s*kubeconfig,\s*envLocal,\s*s3Config,\s*backupBucketName\s*\}\)/,
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
    const call = orch.slice(orch.indexOf('renderBundle(projectConfig.projectName, {'));
    const body = call.slice(0, call.indexOf('});'));
    expect(body).toMatch(/\benvironment,/);
    expect(body).toMatch(/s3: s3Config,/);
  });

  it('compose-ha ships that same rendered bundle, not a second .env writer', () => {
    const ha = src('src/lib/deploy/effects/compose-ha.js');
    expect(ha).toContain('bundlePath: ctx.bundlePath,');
    expect(ha).not.toMatch(/renderBundle\(/);
    expect(src('src/lib/deploy/compose/ha.js')).not.toMatch(/renderBundle\(|S3_BUCKET/);
  });
});
