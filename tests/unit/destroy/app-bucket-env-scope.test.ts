/**
 * Environments share one app bucket per project, each under its `<env>/` key
 * prefix. Destroying one environment used to empty and delete that whole
 * bucket, taking every other environment's uploads with it. Destroy now
 * removes only this environment's prefix and CORS origins, and deletes the
 * bucket itself only on -purge once no other environment uses it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';

const BUCKET = 'myapp-cd9ecc-storage';

const s3 = {
  deletePrefix: vi.fn(async (_b: string, _p: string) => ({ objectsRemoved: 3 })),
  emptyAndDeleteBucket: vi.fn(async (_b: string) => ({
    deleted: true,
    objectsRemoved: 0,
    warnings: [],
  })),
  getBucketCorsOrigins: vi.fn(async (_b: string) => [] as string[]),
  setBucketCors: vi.fn(async (_b: string, _o: string[]) => {}),
  deleteBucketCors: vi.fn(async (_b: string) => {}),
};

vi.mock('../../../src/lib/providers/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    providerFor: () => ({
      NAME: 'Hetzner Cloud',
      promptObjectStorageCredentials: async () => ({ accessKey: 'ak', secretKey: 'sk' }),
    }),
    getObjectStorageProvider: async () => s3,
  };
});

const { DESTROY_EFFECTS } = await import('../../../src/destroy.js');

function env(name: string, domain: string | null, extra: Record<string, unknown> = {}) {
  return {
    provider: 'hetzner',
    envName: name,
    deployMode: 'compose',
    status: 'deployed',
    ...(domain ? { domain } : {}),
    s3: { bucket: BUCKET, region: 'fsn1', keyPrefix: `${name}/`, ...extra },
  };
}

function twoEnvProject() {
  return {
    projectName: 'myapp',
    bucketSalt: 'cd9ecc',
    environments: {
      prod: env('prod', 'prod.dev'),
      staging: env('staging', 'staging.dev'),
    },
  };
}

const spinnerStub = () => {
  const messages: string[] = [];
  return {
    messages,
    start: (m?: string) => messages.push(`start:${m ?? ''}`),
    stop: (m?: string) => messages.push(`stop:${m ?? ''}`),
    message: (m?: string) => messages.push(`message:${m ?? ''}`),
  };
};

async function destroy(
  projectConfig: { environments: Record<string, ReturnType<typeof env>> },
  environment: string,
  args: Record<string, unknown> = {},
) {
  const spinner = spinnerStub();
  const results: Record<string, unknown> = { leaks: createLeakLedger(), s3Bucket: null };
  await DESTROY_EFFECTS.deleteAppBucket({
    envConfig: projectConfig.environments[environment],
    projectConfig,
    environment,
    args,
    results,
    spinner,
    isK8s: false,
  });
  return { spinner, results, text: spinner.messages.join('\n') };
}

describe('deleteAppBucket is scoped to one environment', () => {
  beforeEach(() => {
    for (const fn of Object.values(s3)) fn.mockClear();
    s3.getBucketCorsOrigins.mockImplementation(async () => [
      'https://prod.dev',
      'https://staging.dev',
    ]);
  });

  it('destroying staging with -purge deletes only staging/ and keeps the bucket for prod', async () => {
    const { results, text } = await destroy(twoEnvProject(), 'staging', { purgeBackups: true });
    expect(s3.deletePrefix).toHaveBeenCalledWith(BUCKET, 'staging/');
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
    expect(s3.setBucketCors).toHaveBeenCalledWith(BUCKET, ['https://prod.dev']);
    expect(s3.deleteBucketCors).not.toHaveBeenCalled();
    expect(text).toContain(
      'S3 objects deleted under staging/ (3 objects); bucket kept for 1 other environment(s)',
    );
    expect(results.s3Bucket).toBeNull();
    expect(results.s3Prefix).toBe('staging/');
    expect((results.leaks as ReturnType<typeof createLeakLedger>).counts()).toMatchObject({
      leak: 0,
      unverified: 0,
    });
  });

  it('the last environment with -purge deletes its prefix, then the bucket', async () => {
    const project = twoEnvProject();
    delete (project.environments as Record<string, unknown>).staging;
    s3.getBucketCorsOrigins.mockImplementation(async () => ['https://prod.dev']);
    const { results } = await destroy(project, 'prod', { purgeBackups: true });
    expect(s3.deletePrefix).toHaveBeenCalledWith(BUCKET, 'prod/');
    expect(s3.emptyAndDeleteBucket).toHaveBeenCalledWith(BUCKET);
    expect(results.s3Bucket).toBe(BUCKET);
    expect(results.s3Prefix).toBe('prod/');
  });

  it('the last environment without -purge deletes its prefix only and keeps the bucket for reuse', async () => {
    const project = twoEnvProject();
    delete (project.environments as Record<string, unknown>).staging;
    s3.getBucketCorsOrigins.mockImplementation(async () => ['https://prod.dev']);
    const { results, text } = await destroy(project, 'prod');
    expect(s3.deletePrefix).toHaveBeenCalledWith(BUCKET, 'prod/');
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
    // Its origin was the only one, so the rule goes.
    expect(s3.deleteBucketCors).toHaveBeenCalledWith(BUCKET);
    expect(text).toContain(
      'S3 objects deleted under prod/ (3 objects); bucket kept for reuse (delete with -purge)',
    );
    expect(results.s3Bucket).toBeNull();
  });

  it('a domainless environment removes its localhost pair, leaving the other origins', async () => {
    const project = twoEnvProject();
    project.environments.staging = env('staging', null);
    s3.getBucketCorsOrigins.mockImplementation(async () => [
      'http://localhost:3000',
      'http://localhost:5173',
      'https://prod.dev',
    ]);
    await destroy(project, 'staging');
    expect(s3.setBucketCors).toHaveBeenCalledWith(BUCKET, ['https://prod.dev']);
  });

  it('removes the origins the environment recorded, not the ones its domain computes to', async () => {
    const project = twoEnvProject();
    project.environments.staging = env('staging', 'staging.dev', {
      corsOrigins: ['https://old-staging.dev'],
    });
    s3.getBucketCorsOrigins.mockImplementation(async () => [
      'https://old-staging.dev',
      'https://prod.dev',
      'https://staging.dev',
    ]);
    await destroy(project, 'staging');
    expect(s3.setBucketCors).toHaveBeenCalledWith(BUCKET, [
      'https://prod.dev',
      'https://staging.dev',
    ]);
  });

  it('never removes an origin another environment still records', async () => {
    const project = twoEnvProject();
    project.environments.prod = env('prod', null);
    project.environments.staging = env('staging', null);
    s3.getBucketCorsOrigins.mockImplementation(async () => [
      'http://localhost:3000',
      'http://localhost:5173',
    ]);
    await destroy(project, 'staging');
    expect(s3.setBucketCors).not.toHaveBeenCalled();
    expect(s3.deleteBucketCors).not.toHaveBeenCalled();
  });

  it('an environment with no recorded key prefix deletes no objects and is not a leak', async () => {
    const project = twoEnvProject();
    const staging = env('staging', 'staging.dev') as ReturnType<typeof env>;
    delete (staging.s3 as Record<string, unknown>).keyPrefix;
    project.environments.staging = staging;
    const { results, text } = await destroy(project, 'staging', { purgeBackups: true });
    expect(s3.deletePrefix).not.toHaveBeenCalled();
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
    expect(text).toMatch(/before per-environment prefixes/);
    expect(results.s3Bucket).toBeNull();
    expect(results.s3Prefix).toBeUndefined();
    expect((results.leaks as ReturnType<typeof createLeakLedger>).counts()).toMatchObject({
      leak: 0,
      unverified: 0,
    });
  });
});
