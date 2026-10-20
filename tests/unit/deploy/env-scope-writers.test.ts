/**
 * Every writer of a deployed server's environment carries the env's name
 * (VC_ENV, which WAL-G's prefix uses): compose and compose-ha through the
 * rendered bundle .env, k8s through the vibecarbon-secrets Secret. Each env
 * has its own app bucket, so no writer carries an object key prefix
 * (S3_KEY_PREFIX was removed by design).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildVibecarbonSecretData } from '../../../src/lib/deploy/k8s/k3s.js';

const src = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf-8');

describe('k8s vibecarbon-secrets', () => {
  it('carries VC_ENV beside the bucket and no S3_KEY_PREFIX', () => {
    const stringData = buildVibecarbonSecretData({
      envLocal: {},
      environment: 'prod',
      s3Config: {
        accessKey: 'ak',
        secretKey: 'sk',
        bucket: 'myapp-abc123-storage',
        endpoint: 'https://fsn1.your-objectstorage.com',
        region: 'fsn1',
      },
      backupBucketName: null,
    });
    expect(stringData).not.toHaveProperty('S3_KEY_PREFIX');
    expect(stringData.VC_ENV).toBe('prod');
    expect(stringData.S3_BUCKET).toBe('myapp-abc123-storage');
  });

  it('applyK3sManifests hands the environment to the Secret', () => {
    const k3s = src('src/lib/deploy/k8s/k3s.js');
    expect(k3s).toMatch(
      /applyVibecarbonSecrets\(\{\s*kubeconfig,\s*envLocal,\s*s3Config,\s*backupBucketName,\s*environment,?\s*\}\)/,
    );
  });
});

describe('no writer knows S3_KEY_PREFIX', () => {
  it.each(['src/lib/deploy/bundle.js', 'src/lib/deploy/k8s/k3s.js'])('%s', (rel) => {
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
