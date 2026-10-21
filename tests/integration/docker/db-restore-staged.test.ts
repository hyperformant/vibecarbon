import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeRestoreScript } from '../../../src/lib/deploy/compose/index.js';
import { buildRecoveryConfig, renderRecoveryConf } from '../../../src/lib/walg/recovery-config.js';
import {
  createS3Client,
  listBaseBackups,
  resolveRestoreBase,
} from '../../../src/lib/walg/restore-base.js';

/**
 * The staged compose restore against a real db image and a real S3 (H2a, H3).
 *
 * The db image is the published one every compose server pulls; the object
 * store is Garage, the digest-pinned S3 the template already runs locally
 * (carbon/docker-compose.override.yml). wal-g pushes a base backup, the CLI's
 * listBaseBackups reads its stop sentinel, and composeRestoreScript runs the
 * way restoreCompose runs it (a throwaway db container through db-guard.sh,
 * with RESTORE_BACKUP set):
 *
 *   1. a base backup is pushed, then a row is written after it;
 *   2. a restore of a backup name that does not exist exits non-zero, and the
 *      original cluster (both rows) is still there;
 *   3. a restore of the real name completes, the cluster promotes, and the
 *      row from before the base is present.
 *
 * Everything this creates is named vcrestore<pid>* and removed in afterAll;
 * nothing else on the daemon is touched. Set UPDATE_WALG_FIXTURE=1 to rewrite
 * tests/fixtures/walg/sentinel-3.0.9.json from this run's sentinel.
 */
const shouldRunDocker = process.env.DOCKER_INTEGRATION === 'true';
const describeDocker = shouldRunDocker ? describe : describe.skip;

const ROOT = process.cwd();
const NAME = `vcrestore${process.pid}`;
const NET = NAME;
const S3_CT = `${NAME}-s3`;
const DB_CT = `${NAME}-db`;
const VOL = `${NAME}-data`;
const DB_IMAGE = 'ghcr.io/hyperformant/postgres:17.11-walg3.0.9-r2';
const GARAGE_IMAGE =
  'dxflrs/garage:v2.4.1@sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020';
// Garage's fixed dev key (carbon/docker-compose.override.yml), never a real credential.
const ACCESS_KEY = 'GK6c6f63616c2d6465762d7333';
const SECRET_KEY = '6c6f63616c2d6465762d73332d7365637265742d6e6f742d666f722d70726f64';
const BUCKET = NAME;
const PREFIX = 'backups/proj/prod/walg';
const PGDATA = '/var/lib/postgresql/data';
const GUARD = join(ROOT, 'carbon/volumes/db/db-guard.sh');

const docker = (args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf-8', stdio: 'pipe' }).trim();

const WALG_ENV = [
  `WALG_S3_PREFIX=s3://${BUCKET}/${PREFIX}`,
  `AWS_ACCESS_KEY_ID=${ACCESS_KEY}`,
  `AWS_SECRET_ACCESS_KEY=${SECRET_KEY}`,
  `AWS_ENDPOINT=http://${S3_CT}:3900`,
  'AWS_REGION=us-east-1',
  'AWS_S3_FORCE_PATH_STYLE=true',
  'WALG_COMPRESSION_METHOD=lz4',
  'POSTGRES_PASSWORD=restore-staged-test',
  'PGHOST=/var/run/postgresql',
  'PGUSER=postgres',
].flatMap((e) => ['-e', e]);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function until<T>(what: string, fn: () => T | Promise<T>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${String(last)}`);
    await sleep(1000);
  }
}

function startDb() {
  docker([
    'run',
    '-d',
    '--name',
    DB_CT,
    '--network',
    NET,
    '-v',
    `${VOL}:${PGDATA}`,
    '-v',
    `${GUARD}:/usr/local/bin/db-guard.sh:ro`,
    ...WALG_ENV,
    '--entrypoint',
    'sh',
    DB_IMAGE,
    '/usr/local/bin/db-guard.sh',
    'postgres',
    '-c',
    'config_file=/etc/postgresql/postgresql.conf',
    '-c',
    'wal_level=replica',
    '-c',
    'archive_mode=on',
    '-c',
    'archive_command=wal-g wal-push %p',
    '-c',
    'archive_timeout=60',
  ]);
}

function stopDb() {
  docker(['stop', '-t', '60', DB_CT]);
  docker(['rm', DB_CT]);
}

const psql = (sql: string) => docker(['exec', DB_CT, 'psql', '-U', 'postgres', '-tAc', sql]).trim();

async function waitPromoted() {
  await until(
    'the db to accept connections and leave recovery',
    () => psql('SELECT pg_is_in_recovery()') === 'f',
    300_000,
  );
}

/** Run a restore script the way restoreCompose does: a throwaway db container. */
function runRestoreScript(dir: string, backup: string) {
  const scriptPath = join(dir, `restore-${backup}.sh`);
  writeFileSync(
    scriptPath,
    composeRestoreScript({
      backup,
      recoveryConf: renderRecoveryConf(buildRecoveryConfig({ target: 'latest' })),
    }),
  );
  return spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      NET,
      '-v',
      `${VOL}:${PGDATA}`,
      '-v',
      `${GUARD}:/usr/local/bin/db-guard.sh:ro`,
      '-v',
      `${scriptPath}:/restore.sh:ro`,
      ...WALG_ENV,
      '-e',
      `RESTORE_BACKUP=${backup}`,
      '--entrypoint',
      'sh',
      DB_IMAGE,
      '/usr/local/bin/db-guard.sh',
      'bash',
      '/restore.sh',
    ],
    { encoding: 'utf-8' },
  );
}

/** ls of PGDATA, read through a throwaway container (the db is stopped). */
function lsPgdata() {
  return docker([
    'run',
    '--rm',
    '-v',
    `${VOL}:${PGDATA}`,
    '--entrypoint',
    'ls',
    DB_IMAGE,
    '-A',
    PGDATA,
  ])
    .split('\n')
    .filter(Boolean);
}

describeDocker('staged restore: the live cluster survives until the backup is proven', () => {
  let dir: string;
  let s3: Awaited<ReturnType<typeof createS3Client>>;
  let backupName = '';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vc-restore-staged-'));
    docker(['network', 'create', NET]);
    docker(['volume', 'create', VOL]);
    docker([
      'run',
      '-d',
      '--name',
      S3_CT,
      '--network',
      NET,
      '-p',
      '127.0.0.1::3900',
      '-e',
      `GARAGE_DEFAULT_ACCESS_KEY=${ACCESS_KEY}`,
      '-e',
      `GARAGE_DEFAULT_SECRET_KEY=${SECRET_KEY}`,
      '-e',
      `GARAGE_DEFAULT_BUCKET=${BUCKET}`,
      '-v',
      `${join(ROOT, 'carbon/volumes/s3/garage.toml')}:/etc/garage.toml:ro`,
      GARAGE_IMAGE,
      '/garage',
      'server',
      '--single-node',
      '--default-bucket',
    ]);
    const port = docker(['port', S3_CT, '3900/tcp']).split('\n')[0].split(':').at(-1);
    s3 = await createS3Client({
      endpoint: `http://127.0.0.1:${port}`,
      region: 'us-east-1',
      accessKey: ACCESS_KEY,
      secretKey: SECRET_KEY,
    });
    await until('the bucket', async () => {
      await listBaseBackups({ s3, bucket: BUCKET, prefix: PREFIX });
      return true;
    });
    startDb();
    await waitPromoted();
  }, 600_000);

  afterAll(() => {
    for (const args of [
      ['rm', '-f', DB_CT],
      ['rm', '-f', S3_CT],
      ['volume', 'rm', '-f', VOL],
      ['network', 'rm', NET],
    ]) {
      try {
        docker(args);
      } catch {
        /* best effort: only this test's own resources */
      }
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('pushes a base backup the CLI lists from its stop sentinel', {
    timeout: 300_000,
  }, async () => {
    psql("CREATE TABLE t (v text); INSERT INTO t VALUES ('before-base')");
    docker(['exec', '-u', 'postgres', DB_CT, 'wal-g', 'backup-push', PGDATA]);
    psql("INSERT INTO t VALUES ('after-base')");

    const backups = await listBaseBackups({ s3, bucket: BUCKET, prefix: PREFIX });
    expect(backups).toHaveLength(1);
    const base = resolveRestoreBase(backups, 'latest');
    expect(base.name).toMatch(/^base_000000010000000000000[0-9A-F]{3}$/);
    expect(base.timeline).toBe(1);
    expect(base.sizeBytes).toBeGreaterThan(0);
    backupName = base.name;

    if (process.env.UPDATE_WALG_FIXTURE === '1') {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const res = await s3.send(
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: `${PREFIX}/basebackups_005/${base.name}_backup_stop_sentinel.json`,
        }),
      );
      const body = await res.Body?.transformToString();
      if (!body) throw new Error(`no stop sentinel for ${base.name}`);
      const sentinel = JSON.parse(body);
      writeFileSync(
        join(ROOT, 'tests/fixtures/walg/sentinel-3.0.9.json'),
        `${JSON.stringify({ name: base.name, sentinel }, null, 2)}\n`,
      );
    }
  });

  it('a restore of a backup that does not exist exits non-zero and keeps the live cluster', {
    timeout: 300_000,
  }, async () => {
    expect(backupName).not.toBe('');
    stopDb();
    const r = runRestoreScript(dir, 'base_0000000100000000000000FF');
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
    expect(r.stderr + r.stdout).toContain('nothing was moved');
    const entries = lsPgdata();
    expect(entries).toContain('PG_VERSION');
    expect(entries).not.toContain('.vc-restore');
    expect(entries).not.toContain('.vc-restore-in-progress');
    expect(entries).not.toContain('.vc-prev');

    startDb();
    await waitPromoted();
    expect(psql('SELECT v FROM t ORDER BY v').split('\n')).toEqual(['after-base', 'before-base']);
  });

  it('a restore of the real name swaps in the backup, which promotes with its rows', {
    timeout: 400_000,
  }, async () => {
    stopDb();
    const r = runRestoreScript(dir, backupName);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`restore: ${backupName} staged and swapped in`);
    const entries = lsPgdata();
    expect(entries).toContain('PG_VERSION');
    expect(entries).toContain('recovery.signal');
    // The previous cluster is kept until the CLI has proven the restore.
    expect(entries).toContain('.vc-prev');
    expect(entries).not.toContain('.vc-restore');
    expect(entries).not.toContain('.vc-restore-in-progress');

    startDb();
    await waitPromoted();
    expect(psql("SELECT count(*) FROM t WHERE v = 'before-base'")).toBe('1');
    expect(psql('SHOW default_transaction_read_only')).toBe('off');
    // What restoreCompose does once the database is proven writable.
    docker(['exec', DB_CT, 'rm', '-rf', `${PGDATA}/.vc-prev`]);
    expect(docker(['exec', DB_CT, 'ls', '-A', PGDATA])).not.toContain('.vc-prev');
  });
});
