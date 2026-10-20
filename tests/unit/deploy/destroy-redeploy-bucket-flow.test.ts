/**
 * Value flow of the APP storage bucket name across destroy -> redeploy ->
 * restore (e2e e1, Hetzner compose, 2026-10-20: verify-restore's
 * file_upload_roundtrip failed its CORS preflight with a 403).
 *
 * The suspicion was that the restored app presigns against the bucket the
 * destroy had just deleted. This pins the chain end to end with the real
 * functions, so the name the app is configured with, the bucket deploy
 * creates and the bucket the CORS rule is applied to are one value:
 *
 *   destroy's updateProjectConfig effect (drops environments.<env>, records
 *   the identity, leaves the stable bucket name alone)
 *   -> resolveEnvSeed (deploy's seed for a destroyed name)
 *   -> resolveEnvBucketNames (gatheredConfig.s3Config.bucket)
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

const saveProjectConfigMock = vi.fn();

vi.mock('../../../src/lib/config.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    saveProjectConfig: (...a: unknown[]) => saveProjectConfigMock(...a),
  };
});

const { DESTROY_EFFECTS } = await import('../../../src/destroy.js');
const { createLeakLedger } = await import('../../../src/lib/destroy/leak-ledger.js');
const { resolveEnvSeed, ENV_IDENTITY_FIELDS } = await import('../../../src/lib/env-identity.js');
const { resolveEnvBucketNames } = await import('../../../src/lib/deploy/prompts.js');
const { renderBundle } = await import('../../../src/lib/deploy/bundle.js');
const { applyAppBucketCors } = await import('../../../src/lib/deploy/orchestrator.js');
const { parseDotenv } = await import('../../../src/lib/dotenv.js');

const BUCKET = 'myapp-cd9ecc-storage';
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

/** Run destroy's config effect the way a destroy that deleted the app bucket does. */
async function destroyE1(projectConfig: ReturnType<typeof deployedProject>) {
  await DESTROY_EFFECTS.updateProjectConfig({
    projectConfig,
    environment: 'e1',
    spinner: { start: vi.fn(), stop: vi.fn() },
    results: { leaks: createLeakLedger(), pulumiDestroyFailed: false, s3Bucket: BUCKET },
  });
  expect(saveProjectConfigMock).toHaveBeenCalledTimes(1);
  return saveProjectConfigMock.mock.calls[0][0];
}

describe('app bucket name across destroy -> redeploy -> restore', () => {
  let cwdBackup: string;
  let projectDir: string;
  const stages: string[] = [];

  beforeEach(() => {
    saveProjectConfigMock.mockReset();
    cwdBackup = process.cwd();
    projectDir = mkdtempSync(join(tmpdir(), 'vc-bucket-flow-'));
  });

  afterEach(() => {
    process.chdir(cwdBackup);
    for (const dir of [projectDir, ...stages.splice(0)]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the redeploy creates, configures CORS on, and points the app at ONE stable bucket', async () => {
    const afterDestroy = await destroyE1(deployedProject());

    const { envConfig } = resolveEnvSeed(afterDestroy, 'e1');
    const { bucketName, backupBucketName } = resolveEnvBucketNames(envConfig, afterDestroy);
    expect(bucketName).toBe(BUCKET);
    // Restore depends on the backups bucket keeping its name.
    expect(backupBucketName).toBe(BACKUPS);

    // The project-local .env still names some other bucket (dev's `-local`,
    // or a stale copy of the deleted one); the deploy override must win.
    writeFileSync(join(projectDir, '.env'), `S3_BUCKET=${BUCKET}\nFOO=bar\n`);
    process.chdir(projectDir);
    const stage = renderBundle('myapp', {
      domain: 'e1.example.com',
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
      createProvider: async () => ({ setBucketCors }),
      bucket: bucketName,
      domain: 'e1.example.com',
      spin: { start: vi.fn(), stop: vi.fn() },
      log: { warn: vi.fn() },
    });
    expect(setBucketCors).toHaveBeenCalledWith(serverEnv.S3_BUCKET, ['https://e1.example.com']);
  });

  it('the destroyed-environment identity never carries the app bucket', async () => {
    // The seam that would leak the deleted name into the redeploy: if `s3`
    // were an identity field, resolveEnvBucketNames would prefer it over the
    // fresh derivation and the app would presign against a deleted bucket.
    expect(ENV_IDENTITY_FIELDS).not.toContain('s3');
    const afterDestroy = await destroyE1(deployedProject());
    expect(afterDestroy.destroyedEnvironments.e1.s3).toBeUndefined();
    expect(afterDestroy.destroyedEnvironments.e1.backupS3.bucket).toBe(BACKUPS);
  });

  it('a live environment keeps its persisted bucket (no derivation, no move)', () => {
    const project = deployedProject();
    project.environments.e1.s3.bucket = 'myapp-cd9ecc-storage-persisted';
    expect(resolveEnvBucketNames(project.environments.e1, project).bucketName).toBe(
      'myapp-cd9ecc-storage-persisted',
    );
  });
});
