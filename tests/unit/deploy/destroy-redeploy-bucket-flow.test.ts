/**
 * Value flow of the APP storage bucket name across destroy -> redeploy ->
 * restore (e2e e1, Hetzner compose,
 * 2026-10-20: verify-restore's file_upload_roundtrip failed its CORS
 * preflight with a 403).
 *
 * Each environment has its own long-lived app bucket, derived from the
 * project and env names, so the redeploy must land on the SAME bucket.
 *
 * The suspicion was that the restored app presigns against the bucket the
 * destroy had just deleted. This pins the chain end to end with the real
 * functions, so the name the app is configured with, the bucket deploy
 * creates and the bucket the CORS rule is applied to are one value:
 *
 *   destroy's updateProjectConfig effect (drops environments.<env>, records
 *   the identity, which names the bucket a plain destroy keeps)
 *   -> resolveEnvSeed (deploy's seed for a destroyed name)
 *   -> resolveEnvStorage (gatheredConfig.s3Config.bucket)
 *   -> renderBundle (the server .env's S3_BUCKET)
 *   -> applyAppBucketCors (the bucket the browser-upload rule lands on)
 *
 * `restore` itself never writes the server .env or the k8s Secret's S3 keys
 * (compose: wal-g only, then `docker compose start`; k8s: a merge patch of
 * RESTORE_TARGET alone), so nothing after this chain can move the name.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectConfigStore } from '../helpers/project-config-store.js';

const store = projectConfigStore();

vi.mock('../../../src/lib/config.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    updateProjectConfig: (fn: (c: Record<string, unknown>) => unknown) =>
      store.updateProjectConfig(fn),
  };
});

const { DESTROY_EFFECTS } = await import('../../../src/destroy.js');
const { createLeakLedger } = await import('../../../src/lib/destroy/leak-ledger.js');
const { resolveEnvSeed, ENV_IDENTITY_FIELDS } = await import('../../../src/lib/env-identity.js');
const { resolveEnvStorage } = await import('../../../src/lib/deploy/prompts.js');
const { renderBundle } = await import('../../../src/lib/deploy/bundle.js');
const { applyAppBucketCors } = await import('../../../src/lib/deploy/orchestrator.js');
const { parseDotenv } = await import('../../../src/lib/dotenv.js');

const BUCKET = 'myapp-cd9ecc-e1-storage';
const BACKUPS = 'myapp-cd9ecc-backups';

function deployedProject() {
  return {
    projectName: 'myapp',
    bucketSalt: 'cd9ecc',
    environments: {
      e1: {
        provider: 'hetzner',
        envName: 'e1',
        deployMode: 'compose',
        domain: 'e1.example.com',
        region: 'nbg1',
        status: 'deployed',
        s3: {
          bucket: BUCKET,
          region: 'nbg1',
          endpoint: 'https://nbg1.your-objectstorage.com',
          stateBucket: 'vc-state',
        },
        backupS3: {
          bucket: BACKUPS,
          region: 'nbg1',
          endpoint: 'https://nbg1.your-objectstorage.com',
        },
        servers: [{ name: 'master', ip: '203.0.113.7' }],
      },
    },
  };
}

/** Run destroy's config effect the way a plain destroy (bucket kept) does. */
async function destroyE1(projectConfig: ReturnType<typeof deployedProject>) {
  store.reset(structuredClone(projectConfig));
  await DESTROY_EFFECTS.updateProjectConfig({
    projectConfig,
    environment: 'e1',
    spinner: { start: vi.fn(), stop: vi.fn() },
    results: {
      leaks: createLeakLedger(),
      pulumiDestroyFailed: false,
      s3Bucket: null,
    },
  });
  expect(store.state.writes).toHaveLength(1);
  return store.state.writes[0];
}

describe('app bucket name across destroy -> redeploy -> restore', () => {
  let cwdBackup: string;
  let projectDir: string;
  const stages: string[] = [];

  beforeEach(() => {
    store.reset();
    cwdBackup = process.cwd();
    projectDir = mkdtempSync(join(tmpdir(), 'vc-bucket-flow-'));
  });

  afterEach(() => {
    process.chdir(cwdBackup);
    for (const dir of [projectDir, ...stages.splice(0)]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the redeploy resolves the SAME bucket the destroyed environment had', async () => {
    const before = deployedProject();
    const live = resolveEnvStorage('e1', before.environments.e1, before);
    const afterDestroy = await destroyE1(deployedProject());

    const { envConfig } = resolveEnvSeed(afterDestroy, 'e1');
    const redeploy = resolveEnvStorage('e1', envConfig, afterDestroy);
    expect(redeploy.bucket).toBe(live.bucket);
    expect(redeploy.bucket).toBe(BUCKET);
  });

  it('the redeploy creates, configures CORS on, and points the app at ONE stable bucket', async () => {
    const afterDestroy = await destroyE1(deployedProject());

    const { envConfig } = resolveEnvSeed(afterDestroy, 'e1');
    const { bucket: bucketName, backupBucket: backupBucketName } = resolveEnvStorage(
      'e1',
      envConfig,
      afterDestroy,
    );
    expect(bucketName).toBe(BUCKET);
    // Restore depends on the backups bucket keeping its name.
    expect(backupBucketName).toBe(BACKUPS);

    // The project-local .env still names some other bucket (dev's `-local`,
    // or a stale copy of the deleted one); the deploy override must win.
    writeFileSync(join(projectDir, '.env'), `S3_BUCKET=${BUCKET}\nFOO=bar\n`);
    process.chdir(projectDir);
    const stage = renderBundle('myapp', {
      domain: 'e1.example.com',
      environment: 'e1',
      s3: {
        accessKey: 'ak',
        secretKey: 'sk',
        bucket: bucketName,
        region: 'nbg1',
        endpoint: 'https://nbg1.your-objectstorage.com',
      },
      backupS3: { bucket: backupBucketName },
    });
    stages.push(stage);
    const serverEnv = parseDotenv(readFileSync(join(stage, '.env'), 'utf-8'));
    expect(serverEnv.S3_BUCKET).toBe(bucketName);
    expect(serverEnv.S3_BACKUP_BUCKET).toBe(BACKUPS);

    const setBucketCors = vi.fn(async () => {});
    await applyAppBucketCors({
      createProvider: async () => ({ setBucketCors, getBucketCorsOrigins: async () => [] }),
      bucket: bucketName,
      domain: 'e1.example.com',
      log: { warn: vi.fn() },
    });
    expect(setBucketCors).toHaveBeenCalledWith(serverEnv.S3_BUCKET, ['https://e1.example.com']);
  });

  it('the destroyed-environment identity carries the app bucket it keeps', async () => {
    // Plain destroy keeps the env's bucket and its uploads, so the seed names
    // it: the redeploy lands on the same bucket, and a pin survives.
    expect(ENV_IDENTITY_FIELDS).toContain('s3');
    const afterDestroy = await destroyE1(deployedProject());
    expect(afterDestroy.destroyedEnvironments.e1.s3).toEqual({ bucket: BUCKET, region: 'nbg1' });
    expect(afterDestroy.destroyedEnvironments.e1.backupS3.bucket).toBe(BACKUPS);
  });

  it('the seed never carries runtime storage state (state bucket, endpoint, creation time)', async () => {
    const project = deployedProject();
    Object.assign(project.environments.e1.s3, { bucketCreatedAt: '2026-10-20T00:00:00Z' });
    const afterDestroy = await destroyE1(project);
    const seeded = afterDestroy.destroyedEnvironments.e1.s3;
    expect(seeded).not.toHaveProperty('stateBucket');
    expect(seeded).not.toHaveProperty('endpoint');
    expect(seeded).not.toHaveProperty('bucketCreatedAt');
  });

  it('a pinned environment survives destroy -> redeploy on the same pinned bucket', async () => {
    const PINNED = 'legacy-myapp-uploads';
    const project = deployedProject();
    Object.assign(project.environments.e1.s3, { bucket: PINNED, bucketPin: PINNED });
    expect(resolveEnvStorage('e1', project.environments.e1, project).bucket).toBe(PINNED);

    const afterDestroy = await destroyE1(project);
    expect(afterDestroy.destroyedEnvironments.e1.s3).toMatchObject({
      bucket: PINNED,
      bucketPin: PINNED,
    });
    const { envConfig } = resolveEnvSeed(afterDestroy, 'e1');
    expect(resolveEnvStorage('e1', envConfig, afterDestroy).bucket).toBe(PINNED);
  });

  it('a live environment whose persisted bucket differs is refused, not re-pointed', () => {
    const project = deployedProject();
    project.environments.e1.s3.bucket = 'myapp-cd9ecc-storage';
    expect(() => resolveEnvStorage('e1', project.environments.e1, project)).toThrow(
      'myapp-cd9ecc-storage',
    );
  });
});
