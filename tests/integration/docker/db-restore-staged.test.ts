import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeRestoreScript } from '../../../src/lib/deploy/compose/index.js';
import { buildRecoveryConfig, renderRecoveryConf } from '../../../src/lib/walg/recovery-config.js';
import {
  createS3Client,
  listBaseBackups,
  listLineages,
  resolveRestoreBase,
} from '../../../src/lib/walg/restore-base.js';
import { REMOVE_DISCARD_SH, RETIRE_PREVIOUS_SH } from '../../../src/lib/walg/restore-layout.js';

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
 *   1. a base backup is pushed by carbon/backup/compose-backup.sh itself (its
 *      `docker compose exec -T db` routed to this container by a shim), whose
 *      one BACKUP_RESULT=pushed:<name> must name the base wal-g lists; then
 *      a row is written after it;
 *   2. a restore of a backup name that does not exist exits non-zero, and the
 *      original cluster (both rows) is still there;
 *   3. a restore of the real name completes, the cluster promotes, and the
 *      row from before the base is present.
 *
 * Every wal-g caller sources the real carbon/volumes/db/walg-env.sh, mounted
 * where the compose db mounts it, and archive_command is the real
 * wal-archive.sh: each database lineage archives under
 * <prefix>/<system identifier>/ (H1, B1). After the restores the volume is
 * wiped and a new database initialised (a destroyed and redeployed
 * environment): its pushes land in its own lineage folder, the first lineage's
 * sentinel keeps its ETag, and with WALG_PREVENT_WAL_OVERWRITE=true a segment
 * name already archived cannot be pushed again with other bytes.
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
const WALG_ENV_SH = join(ROOT, 'carbon/volumes/db/walg-env.sh');
const WAL_ARCHIVE_SH = join(ROOT, 'carbon/volumes/db/wal-archive.sh');
/** The two scripts, where the compose db service mounts them. */
const SCRIPT_MOUNTS = [
  '-v',
  `${WALG_ENV_SH}:/etc/postgresql/walg-env.sh:ro`,
  '-v',
  `${WAL_ARCHIVE_SH}:/etc/postgresql/wal-archive.sh:ro`,
];

const docker = (args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf-8', stdio: 'pipe' }).trim();

const WALG_ENV = [
  `WALG_S3_PREFIX_BASE=s3://${BUCKET}/${PREFIX}`,
  'WALG_PREVENT_WAL_OVERWRITE=true',
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
    ...SCRIPT_MOUNTS,
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
    'archive_command=bash /etc/postgresql/wal-archive.sh %p',
    '-c',
    'archive_timeout=60',
  ]);
}

function stopDb() {
  docker(['stop', '-t', '60', DB_CT]);
  docker(['rm', DB_CT]);
}

// Over TCP, never the unix socket: WALG_ENV's PGHOST points psql at the
// socket, where the entrypoint's socket-only init server answers (and says it
// is out of recovery) before the real server starts. A readiness read there
// lands in the gap between the two and cascades into every later test.
const psql = (sql: string) =>
  docker(['exec', DB_CT, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-tAc', sql]).trim();

async function waitPromoted() {
  await until(
    'the db to accept connections and leave recovery',
    () => psql('SELECT pg_is_in_recovery()') === 'f',
    300_000,
  );
}

/** The running database's system identifier: the name of its archive folder. */
const sysidOf = () => psql('SELECT system_identifier FROM pg_control_system()');

/** wal-g in the db container, through walg-env.sh like every caller. */
const walgInDb = (args: string) =>
  spawnSync(
    'docker',
    ['exec', '-u', 'postgres', DB_CT, 'sh', '-c', `. /etc/postgresql/walg-env.sh && wal-g ${args}`],
    { encoding: 'utf-8' },
  );

/** Run a restore script the way restoreCompose does: a throwaway db container. */
function runRestoreScript(dir: string, backup: string, lineage: string) {
  const scriptPath = join(dir, `restore-${backup}.sh`);
  writeFileSync(
    scriptPath,
    composeRestoreScript({
      backup,
      lineage,
      recoveryConf: renderRecoveryConf(buildRecoveryConfig({ target: 'latest', lineage: lineage })),
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
      ...SCRIPT_MOUNTS,
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

/**
 * Run carbon/backup/compose-backup.sh the way the cron and `vibecarbon backup`
 * do (`cd <project> && RETAIN=n bash backup/compose-backup.sh`), with a
 * `docker` shim that routes its `docker compose exec -T db …` into this
 * test's db container. PGPASSWORD mirrors the compose db service env.
 */
function runComposeBackupScript(dir: string) {
  const project = join(dir, 'project');
  const bin = join(dir, 'bin');
  mkdirSync(join(project, 'backup'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(project, 'backup/compose-backup.sh'),
    readFileSync(join(ROOT, 'carbon/backup/compose-backup.sh')),
  );
  const realDocker = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf-8' }).trim();
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/bash\n# docker compose exec -T db <cmd...>\nshift 4\nexec ${realDocker} exec -i -e PGPASSWORD=restore-staged-test ${DB_CT} "$@"\n`,
  );
  chmodSync(join(bin, 'docker'), 0o755);
  return spawnSync('bash', ['backup/compose-backup.sh'], {
    cwd: project,
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RETAIN: '7' },
    timeout: 300_000,
  });
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
  // The first database's lineage (system identifier) and its archive folder.
  let lineageA = '';
  let folderA = '';

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
    const pushed = runComposeBackupScript(dir);
    expect(pushed.status, pushed.stdout + pushed.stderr).toBe(0);
    const markers = pushed.stdout.split('\n').filter((l) => l.startsWith('BACKUP_RESULT='));
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatch(/^BACKUP_RESULT=pushed:base_[0-9A-F]{24}$/);
    const markerName = markers[0].slice('BACKUP_RESULT=pushed:'.length);
    // wal-g logs Started AND Wrote lines with the name; only Wrote is a push.
    expect(pushed.stderr).toContain(`Wrote backup with name ${markerName}`);
    const listed = walgInDb('backup-list');
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout.split('\n').filter((l) => l.startsWith(`${markerName} `))).toHaveLength(1);
    psql("INSERT INTO t VALUES ('after-base')");

    // The base landed in this database's own lineage folder, nowhere else.
    lineageA = sysidOf();
    expect(lineageA).toMatch(/^\d+$/);
    folderA = `${PREFIX}/${lineageA}`;
    expect(await listBaseBackups({ s3, bucket: BUCKET, prefix: PREFIX })).toEqual([]);
    const backups = await listBaseBackups({ s3, bucket: BUCKET, prefix: folderA });
    expect(backups).toHaveLength(1);
    const base = resolveRestoreBase(backups, 'latest');
    expect(base.name).toBe(markerName);
    expect(base.name).toMatch(/^base_000000010000000000000[0-9A-F]{3}$/);
    expect(base.timeline).toBe(1);
    expect(base.sizeBytes).toBeGreaterThan(0);
    backupName = base.name;

    if (process.env.UPDATE_WALG_FIXTURE === '1') {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const res = await s3.send(
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: `${folderA}/basebackups_005/${base.name}_backup_stop_sentinel.json`,
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
    const r = runRestoreScript(dir, 'base_0000000100000000000000FF', lineageA);
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
    const r = runRestoreScript(dir, backupName, lineageA);
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
    docker(['exec', DB_CT, 'sh', '-c', RETIRE_PREVIOUS_SH]);
    docker(['exec', DB_CT, 'sh', '-c', REMOVE_DISCARD_SH]);
    const after = docker(['exec', DB_CT, 'ls', '-A', PGDATA]);
    expect(after).not.toContain('.vc-prev');
    expect(after).not.toContain('.vc-discard');
  });

  it('a stale .vc-prev from a proven restore plus a failed fetch: the live rows survive (C1)', {
    timeout: 300_000,
  }, async () => {
    // The state the first version mishandled: a proven restore whose cleanup
    // never ran left .vc-prev, and the live cluster then took writes.
    psql("INSERT INTO t VALUES ('after-restore')");
    docker([
      'exec',
      DB_CT,
      'sh',
      '-c',
      `mkdir -p ${PGDATA}/.vc-prev/base && echo 17 > ${PGDATA}/.vc-prev/PG_VERSION`,
    ]);
    stopDb();
    const r = runRestoreScript(dir, 'base_0000000100000000000000FF', lineageA);
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
    expect(r.stderr + r.stdout).toContain('nothing was moved');
    expect(lsPgdata()).not.toContain('.vc-restore-in-progress');

    startDb();
    await waitPromoted();
    expect(psql("SELECT count(*) FROM t WHERE v IN ('before-base', 'after-restore')")).toBe('2');
  });
  it('a recreated database archives under its own lineage; the old archive is untouched', {
    timeout: 600_000,
  }, async () => {
    expect(folderA).not.toBe('');
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const sentinelA = `${folderA}/basebackups_005/${backupName}_backup_stop_sentinel.json`;
    const etagBefore = (await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: sentinelA })))
      .ETag;
    expect(etagBefore).toBeTruthy();
    const basesA = (await listBaseBackups({ s3, bucket: BUCKET, prefix: folderA })).map(
      (b) => b.name,
    );

    // Destroy and redeploy: wipe the volume (this test's own), initdb anew.
    stopDb();
    docker(['volume', 'rm', VOL]);
    docker(['volume', 'create', VOL]);
    startDb();
    await waitPromoted();
    const lineageB = sysidOf();
    expect(lineageB).toMatch(/^\d+$/);
    expect(lineageB).not.toBe(lineageA);

    const pushed = runComposeBackupScript(dir);
    expect(pushed.status, pushed.stdout + pushed.stderr).toBe(0);
    const marker = pushed.stdout.split('\n').find((l) => l.startsWith('BACKUP_RESULT=pushed:'));
    expect(marker).toBeTruthy();
    const nameB = String(marker).slice('BACKUP_RESULT=pushed:'.length);

    const folderB = `${PREFIX}/${lineageB}`;
    expect(
      (await listBaseBackups({ s3, bucket: BUCKET, prefix: folderB })).map((b) => b.name),
    ).toEqual([nameB]);
    // The first lineage: the same bases, its sentinel byte for byte (ETag).
    expect(
      (await listBaseBackups({ s3, bucket: BUCKET, prefix: folderA })).map((b) => b.name),
    ).toEqual(basesA);
    expect((await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: sentinelA }))).ETag).toBe(
      etagBefore,
    );
    // Nothing at the env prefix itself; two lineages under it.
    expect(await listBaseBackups({ s3, bucket: BUCKET, prefix: PREFIX })).toEqual([]);
    const lineages = await listLineages({ s3, bucket: BUCKET, base: PREFIX });
    expect(lineages.map((l) => l.lineage).sort()).toEqual([lineageA, lineageB].sort());
    expect(lineages.every((l) => l.newestFinish)).toBe(true);
  });

  it('WALG_PREVENT_WAL_OVERWRITE refuses a segment name already archived with other bytes', {
    timeout: 300_000,
  }, async () => {
    const { HeadObjectCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const lineageB = sysidOf();
    const walFolder = `${PREFIX}/${lineageB}/wal_005/`;
    // A segment the new lineage archived (the base push switched WAL).
    const segment = await until('an archived WAL segment in the new lineage', async () => {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: walFolder }));
      return (page.Contents ?? [])
        .map((o) => String(o.Key).slice(walFolder.length))
        .find((k) => /^[0-9A-F]{24}\./.test(k));
    });
    const segmentKey = `${walFolder}${segment}`;
    const etag = async () =>
      (await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: segmentKey }))).ETag;
    const etagBefore = await etag();
    expect(etagBefore).toBeTruthy();
    const forged = `/tmp/${segment.slice(0, 24)}`;
    docker([
      'exec',
      '-u',
      'postgres',
      DB_CT,
      'sh',
      '-c',
      `head -c 16777216 /dev/urandom > ${forged}`,
    ]);
    const r = walgInDb(`wal-push ${forged}`);
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('already archived, contents differ');
    // The archived segment is still the one postgres wrote, byte for byte.
    expect(await etag()).toBe(etagBefore);
    const again = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${walFolder}${segment.slice(0, 24)}` }),
    );
    expect(again.Contents?.length).toBe(1);
  });
});
