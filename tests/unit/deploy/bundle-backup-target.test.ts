/**
 * The compose bundle reaches the backups bucket at its own endpoint.
 *
 * On a server only the db service reads the `.env` S3_ENDPOINT / S3_REGION
 * (wal-g's AWS_ENDPOINT / AWS_REGION, carbon/docker-compose.yml), and every
 * wal-g caller and backup/tls-snapshot.sh run there. The app reads `app.env`,
 * built from the uploads config (buildAppRuntimeEnv). So `.env` names the
 * backups bucket's region and endpoint, and `app.env` the uploads bucket's.
 *
 * An environment whose backups and uploads share a region (every environment
 * deployed under one-bucket-per-region) renders exactly what the CLI rendered
 * before, line for line: the db container's config does not change, so
 * nothing restarts. The pins below are the lines main rendered.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every temp dir made through node:fs, so a case can tell whether renderBundle
// staged anything (os.tmpdir() ignores a TMPDIR set in a test: the global
// setup replaces process.env with a plain object).
const made = vi.hoisted(() => [] as string[]);
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  return {
    ...real,
    mkdtempSync: (...args: Parameters<typeof real.mkdtempSync>) => {
      const dir = real.mkdtempSync(...args);
      made.push(String(dir));
      return dir;
    },
  };
});

const { renderBundle } = await import('../../../src/lib/deploy/bundle.js');

import { parseDotenv } from '../../../src/lib/dotenv.js';

const EP = (region: string) => `https://${region}.your-objectstorage.com`;
const INFRA = { accessKey: 'ABCDEFGHIJ0123456789', secretKey: 'x'.repeat(40) };
const APP_KEY = { accessKey: 'APPKEY0123456789ABCD', secretKey: 'y'.repeat(40) };

const uploads = (region: string) => ({
  ...INFRA,
  bucket: 'myapp-abc123-staging-storage',
  region,
  endpoint: EP(region),
  appCredential: APP_KEY,
});
const backups = (bucket: string, region: string) => ({ bucket, region, endpoint: EP(region) });

describe('renderBundle: the backups target', () => {
  let cwd: string;
  let projectDir: string;
  const stages: string[] = [];

  beforeEach(() => {
    cwd = process.cwd();
    projectDir = mkdtempSync(join(tmpdir(), 'vc-bundle-backup-target-'));
    process.chdir(projectDir);
  });
  afterEach(() => {
    process.chdir(cwd);
    for (const dir of [projectDir, ...stages.splice(0)]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const render = (localEnv: string, options: Record<string, unknown>) => {
    writeFileSync(join(projectDir, '.env'), localEnv);
    const stage = renderBundle('myapp', { environment: 'staging', ...options });
    stages.push(stage);
    const text = (file: string) => readFileSync(join(stage, file), 'utf-8');
    return {
      env: parseDotenv(text('.env')),
      app: parseDotenv(text('app.env')),
      envLines: text('.env')
        .split('\n')
        .filter((l) => /^(S3_|VC_ENV=)/.test(l)),
      appLines: text('app.env')
        .split('\n')
        .filter((l) => l.startsWith('S3_')),
    };
  };

  it("uploads in fsn1, backups in nbg1: .env names nbg1 for wal-g, app.env keeps fsn1's", () => {
    const { env, app } = render('FOO=bar\n', {
      s3: uploads('fsn1'),
      backupTarget: backups('myapp-abc123-backups', 'nbg1'),
    });

    expect(env.S3_BACKUP_BUCKET).toBe('myapp-abc123-backups');
    expect(env.S3_ENDPOINT).toBe(EP('nbg1'));
    expect(env.S3_REGION).toBe('nbg1');
    // The uploads bucket and the infra pair are unchanged in .env.
    expect(env.S3_BUCKET).toBe('myapp-abc123-staging-storage');
    expect(env.S3_ACCESS_KEY).toBe(INFRA.accessKey);

    expect(app.S3_BUCKET).toBe('myapp-abc123-staging-storage');
    expect(app.S3_ENDPOINT).toBe(EP('fsn1'));
    expect(app.S3_REGION).toBe('fsn1');
    expect(app.S3_ACCESS_KEY).toBe(APP_KEY.accessKey);
    // The app never learns where the backups are.
    expect(Object.values(app)).not.toContain('myapp-abc123-backups');
    expect(Object.values(app)).not.toContain(EP('nbg1'));
  });

  it('one region: the S3 lines are the ones main rendered, in place over a local .env', () => {
    const { envLines, appLines } = render(
      'FOO=bar\nS3_BUCKET=myapp-local\nS3_ENDPOINT=http://localhost:3900\n',
      { s3: uploads('fsn1'), backupTarget: backups('myapp-abc123-backups', 'fsn1') },
    );

    expect(envLines).toEqual([
      'S3_BUCKET=myapp-abc123-staging-storage',
      'S3_ENDPOINT=https://fsn1.your-objectstorage.com',
      'S3_ACCESS_KEY=ABCDEFGHIJ0123456789',
      'S3_SECRET_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      'S3_REGION=fsn1',
      'VC_ENV=staging',
      'S3_BACKUP_BUCKET=myapp-abc123-backups',
    ]);
    expect(appLines).toEqual([
      'S3_ACCESS_KEY=APPKEY0123456789ABCD',
      'S3_SECRET_KEY=yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy',
      'S3_BUCKET=myapp-abc123-staging-storage',
      'S3_ENDPOINT=https://fsn1.your-objectstorage.com',
      'S3_REGION=fsn1',
    ]);
  });

  it('one region: the S3 lines are the ones main rendered, appended in the same order', () => {
    const { envLines } = render('FOO=bar\n', {
      s3: uploads('fsn1'),
      backupTarget: backups('myapp-abc123-backups', 'fsn1'),
    });

    expect(envLines).toEqual([
      'S3_ACCESS_KEY=ABCDEFGHIJ0123456789',
      'S3_SECRET_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      'S3_REGION=fsn1',
      'S3_ENDPOINT=https://fsn1.your-objectstorage.com',
      'S3_BUCKET=myapp-abc123-staging-storage',
      'VC_ENV=staging',
      'S3_BACKUP_BUCKET=myapp-abc123-backups',
    ]);
  });

  it('no target: .env keeps the uploads endpoint and names no backups bucket', () => {
    const { env } = render('FOO=bar\n', { s3: uploads('fsn1') });
    expect(env.S3_ENDPOINT).toBe(EP('fsn1'));
    expect(env.S3_REGION).toBe('fsn1');
    expect(env).not.toHaveProperty('S3_BACKUP_BUCKET');
  });

  it('a backups target with no uploads config and no replay is refused before anything is staged', () => {
    // app.env would be built from the server .env, whose S3_ENDPOINT and
    // S3_REGION are the backups bucket's: the app would be handed them.
    writeFileSync(join(projectDir, '.env'), 'FOO=bar\n');
    made.length = 0;
    let thrown: unknown;
    try {
      stages.push(
        renderBundle('myapp', {
          environment: 'staging',
          backupTarget: backups('myapp-abc123-backups', 'nbg1'),
        }),
      );
    } catch (err) {
      thrown = err;
    }
    // A stage dir made before the refusal is removed with the case.
    stages.push(...made);
    expect(String(thrown)).toContain(
      'renderBundle: a backupTarget needs options.s3 or options.appEnvReplay, so app.env keeps the uploads bucket instead of the backups one',
    );
    expect(made).toEqual([]);
  });

  it("a backups target with a replayed app.env keeps the app's own storage", () => {
    const { env, app } = render('FOO=bar\n', {
      backupTarget: backups('myapp-abc123-backups', 'nbg1'),
      appEnvReplay: {
        S3_ACCESS_KEY: APP_KEY.accessKey,
        S3_SECRET_KEY: APP_KEY.secretKey,
        S3_BUCKET: 'myapp-abc123-staging-storage',
        S3_ENDPOINT: EP('fsn1'),
        S3_REGION: 'fsn1',
      },
    });
    expect(env.S3_ENDPOINT).toBe(EP('nbg1'));
    expect(app.S3_ENDPOINT).toBe(EP('fsn1'));
    expect(app.S3_REGION).toBe('fsn1');
  });
});
