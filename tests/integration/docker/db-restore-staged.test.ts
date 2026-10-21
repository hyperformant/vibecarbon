import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeBackupFence } from '../../../src/lib/deploy/backup-fence.js';
import { composeRestoreScript } from '../../../src/lib/deploy/compose/index.js';
import { parseWalGapRecord } from '../../../src/lib/status/backup-health.js';
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
 * Every promotion ends with a base on its new timeline (H2b): after a restore
 * (the CLI's .vc-prev retire first) and after a streaming standby's promote
 * (behind the backup-prefix fence, which still refuses the old primary), the
 * base compose-backup.sh pushes is the newest, on the new timeline, and a
 * `restore latest` from it keeps a write made after the promotion.
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
/** The streaming standby a promote test builds next to DB_CT. */
const SB_CT = `${NAME}-sb`;
const SB_VOL = `${NAME}-sb-data`;
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

function startDb(ct = DB_CT, vol = VOL) {
  docker([
    'run',
    '-d',
    '--name',
    ct,
    '--network',
    NET,
    '-v',
    `${vol}:${PGDATA}`,
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

function stopDb(ct = DB_CT) {
  docker(['stop', '-t', '60', ct]);
  docker(['rm', ct]);
}

// Over TCP, never the unix socket: WALG_ENV's PGHOST points psql at the
// socket, where the entrypoint's socket-only init server answers (and says it
// is out of recovery) before the real server starts. A readiness read there
// lands in the gap between the two and cascades into every later test.
const psql = (sql: string, ct = DB_CT) =>
  docker(['exec', ct, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-tAc', sql]).trim();

async function waitPromoted(ct = DB_CT) {
  await until(
    'the db to accept connections and leave recovery',
    () => psql('SELECT pg_is_in_recovery()', ct) === 'f',
    300_000,
  );
}

/** The running database's system identifier: the name of its archive folder. */
const sysidOf = (ct = DB_CT) => psql('SELECT system_identifier FROM pg_control_system()', ct);

/** The timeline the database writes on now (its insert position's WAL file). */
const timelineOf = (ct = DB_CT) =>
  Number.parseInt(psql('SELECT substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8)', ct), 16);

/** Close the current WAL segment and wait until the archiver has pushed it. */
async function archiveCurrentWal(ct = DB_CT) {
  const segment = psql('SELECT pg_walfile_name(pg_switch_wal())', ct);
  await until(
    `${segment} archived`,
    () => psql("SELECT coalesce(last_archived_wal, '') FROM pg_stat_archiver", ct) >= segment,
    180_000,
  );
}

/** The newest base in a lineage folder, as `restore latest` resolves it. */
async function latestBase(s3: Awaited<ReturnType<typeof createS3Client>>, folder: string) {
  return resolveRestoreBase(
    await listBaseBackups({ s3, bucket: BUCKET, prefix: folder }),
    'latest',
  );
}

/** The one BACKUP_RESULT=pushed:<name> of a compose-backup.sh run. */
function pushedName(run: { status: number | null; stdout: string; stderr: string }) {
  expect(run.status, run.stdout + run.stderr).toBe(0);
  const marker = run.stdout.split('\n').find((l) => l.startsWith('BACKUP_RESULT=pushed:'));
  expect(marker, run.stdout).toBeTruthy();
  return String(marker).slice('BACKUP_RESULT=pushed:'.length);
}

/** wal-g in the db container, through walg-env.sh like every caller. */
const walgInDb = (args: string) =>
  spawnSync(
    'docker',
    ['exec', '-u', 'postgres', DB_CT, 'sh', '-c', `. /etc/postgresql/walg-env.sh && wal-g ${args}`],
    { encoding: 'utf-8' },
  );

/** Run a restore script the way restoreCompose does: a throwaway db container. */
function runRestoreScript(dir: string, backup: string, lineage: string, vol = VOL) {
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
      `${vol}:${PGDATA}`,
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
function runComposeBackupScript(dir: string, ct = DB_CT) {
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
    `#!/bin/bash\n# docker compose exec -T db <cmd...>\nshift 4\nexec ${realDocker} exec -i -e PGPASSWORD=restore-staged-test ${ct} "$@"\n`,
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
      ['rm', '-f', SB_CT],
      ['rm', '-f', S3_CT],
      ['volume', 'rm', '-f', VOL],
      ['volume', 'rm', '-f', SB_VOL],
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
  it('a restore ends with a base on its new timeline; restore latest keeps a write made after it', {
    timeout: 600_000,
  }, async () => {
    expect(folderA).not.toBe('');
    stopDb();
    const r = runRestoreScript(dir, backupName, lineageA);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    startDb();
    await waitPromoted();
    const timeline = timelineOf();
    expect(timeline).toBeGreaterThan(1);
    // restoreCompose once the restore is proven: .vc-prev goes BEFORE the push,
    // so the base holds the restored cluster only.
    docker(['exec', DB_CT, 'sh', '-c', RETIRE_PREVIOUS_SH]);
    docker(['exec', DB_CT, 'sh', '-c', REMOVE_DISCARD_SH]);
    const name = pushedName(runComposeBackupScript(dir));
    const base = await latestBase(s3, folderA);
    expect(base.name).toBe(name);
    expect(base.timeline).toBe(timeline);

    psql("INSERT INTO t VALUES ('after-promote-restore')");
    await archiveCurrentWal();
    stopDb();
    const again = runRestoreScript(dir, base.name, lineageA);
    expect(again.status, again.stdout + again.stderr).toBe(0);
    startDb();
    await waitPromoted();
    expect(psql("SELECT count(*) FROM t WHERE v = 'after-promote-restore'")).toBe('1');
    docker(['exec', DB_CT, 'sh', '-c', RETIRE_PREVIOUS_SH]);
    docker(['exec', DB_CT, 'sh', '-c', REMOVE_DISCARD_SH]);
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
      return (
        (page.Contents ?? [])
          .map((o) => String(o.Key).slice(walFolder.length))
          // A WAL segment (`<24 hex>.lz4`), never the `<segment>.<offset>.backup`
          // label a base push archives beside it.
          .find((k) => /^[0-9A-F]{24}\.[a-z0-9]+$/.test(k))
      );
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
    const again = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: segmentKey }));
    expect(again.Contents?.length).toBe(1);
  });

  it('retention keeps the full window: the target is the newest base at or before the cutoff, and the fence is never touched', {
    timeout: 600_000,
  }, async () => {
    const lineage = sysidOf();
    const folder = `${PREFIX}/${lineage}`;
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const fence = await writeBackupFence({
      exec: async (sql) => psql(sql),
      runInDb: async (script) => docker(['exec', DB_CT, 'sh', '-c', script]),
      primaryNode: DB_CT,
    });
    expect(fence.ok, JSON.stringify(fence)).toBe(true);
    const fenceKey = `${folder}/vibecarbon-fence.json`;
    const etag = async () =>
      (await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: fenceKey }))).ETag;
    const etagBefore = await etag();
    expect(etagBefore).toBeTruthy();
    const names = async () =>
      (await listBaseBackups({ s3, bucket: BUCKET, prefix: folder })).map((b) => b.name);

    // The script's own retention (RETAIN=7 days): no base is that old, so it
    // finds no target, deletes nothing, and the fence reads back unchanged.
    const before = await names();
    const first = pushedName(runComposeBackupScript(dir));
    // The retention compares finish times to the second: two pushes finishing
    // inside one second would leave no cutoff that separates them.
    await sleep(2100);
    const second = pushedName(runComposeBackupScript(dir));
    const afterRuns = await names();
    expect(afterRuns).toEqual(expect.arrayContaining([...before, first, second]));
    expect(await etag()).toBe(etagBefore);

    // The script's own target pipeline, on the real backup-list output under
    // the real busybox, for a cutoff of our choosing.
    const pipeline = readFileSync(join(ROOT, 'carbon/backup/compose-backup.sh'), 'utf-8').match(
      /target="\$\((.*?)\)" && \{ if/s,
    )?.[1];
    expect(pipeline).toBeTruthy();
    const targetFor = (cutoff: string) => {
      const r = docker([
        'exec',
        '-u',
        'postgres',
        DB_CT,
        'sh',
        '-c',
        `. /etc/postgresql/walg-env.sh && cutoff=${cutoff} && list="$(wal-g backup-list --detail --json)" && printf %s "$(${pipeline})"`,
      ]);
      return r.trim();
    };
    const listed = JSON.parse(walgInDb('backup-list --detail --json').stdout) as Array<{
      backup_name: string;
      finish_time: string;
    }>;
    const finish = (n: string) =>
      Date.parse(String(listed.find((b) => b.backup_name === n)?.finish_time));
    const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

    // A cutoff before every base: no target, nothing to delete.
    expect(targetFor('2000-01-01T00:00:00Z')).toBe('');

    // A cutoff at the earlier push's own second (the second push finished more
    // than 2s later): the earlier push is the target, so it and everything
    // after stay, and only what precedes it goes.
    const mid = iso(Math.floor(finish(first) / 1000) * 1000);
    expect(targetFor(mid)).toBe(first);
    const del1 = walgInDb(`delete before FIND_FULL ${first} --confirm`);
    expect(del1.status, del1.stderr).toBe(0);
    const left1 = await names();
    expect(left1).toEqual(expect.arrayContaining([first, second]));
    for (const older of before) expect(left1).not.toContain(older);
    expect(await etag()).toBe(etagBefore);

    // A cutoff past every base: the newest is the target and always survives.
    await sleep(1500);
    expect(targetFor(iso(Date.now()))).toBe(second);
    const del2 = walgInDb(`delete before FIND_FULL ${second} --confirm`);
    expect(del2.status, del2.stderr).toBe(0);
    expect(await names()).toEqual([second]);
    expect(await etag()).toBe(etagBefore);
  });

  it('a promoted standby pushes the first base on its timeline; restore latest keeps a later write', {
    timeout: 900_000,
  }, async () => {
    const lineageB = sysidOf();
    const folderB = `${PREFIX}/${lineageB}`;
    // A streaming standby of DB_CT: replication from the network, then a
    // pg_basebackup -R into its own volume.
    const hba = psql('SHOW hba_file');
    docker(['exec', DB_CT, 'sh', '-c', `echo 'host replication all all scram-sha-256' >> ${hba}`]);
    psql('SELECT pg_reload_conf()');
    docker(['volume', 'create', SB_VOL]);
    docker([
      'run',
      '--rm',
      '--network',
      NET,
      '-v',
      `${SB_VOL}:${PGDATA}`,
      '--entrypoint',
      'sh',
      DB_IMAGE,
      '-c',
      `pg_basebackup -d 'host=${DB_CT} user=postgres password=restore-staged-test' ` +
        `-D ${PGDATA} -R -X stream -c fast && chown -R postgres:postgres ${PGDATA} && chmod 700 ${PGDATA}`,
    ]);
    startDb(SB_CT, SB_VOL);
    await until(
      'the standby to stream',
      () => psql('SELECT status FROM pg_stat_wal_receiver', SB_CT) === 'streaming',
      180_000,
    );
    psql("CREATE TABLE IF NOT EXISTS t (v text); INSERT INTO t VALUES ('before-promote')");
    await until(
      'the standby to replay the write',
      () => psql("SELECT count(*) FROM t WHERE v = 'before-promote'", SB_CT) === '1',
    );

    // The failover: the primary is gone, the standby promotes, the fence
    // names it (the real writer), and then the first base on its timeline.
    stopDb();
    expect(psql('SELECT pg_promote()', SB_CT)).toBe('t');
    await waitPromoted(SB_CT);
    const timeline = timelineOf(SB_CT);
    expect(timeline).toBe(2);
    const fence = await writeBackupFence({
      exec: async (sql) => psql(sql, SB_CT),
      runInDb: async (script) => docker(['exec', SB_CT, 'sh', '-c', script]),
      primaryNode: SB_CT,
    });
    expect(fence.ok, JSON.stringify(fence)).toBe(true);
    const name = pushedName(runComposeBackupScript(dir, SB_CT));
    const base = await latestBase(s3, folderB);
    expect(base.name).toBe(name);
    expect(base.timeline).toBe(timeline);

    psql("INSERT INTO t VALUES ('after-promote')", SB_CT);
    await archiveCurrentWal(SB_CT);
    stopDb(SB_CT);
    const r = runRestoreScript(dir, base.name, lineageB, SB_VOL);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    startDb(SB_CT, SB_VOL);
    await waitPromoted(SB_CT);
    expect(
      psql("SELECT count(*) FROM t WHERE v IN ('before-promote', 'after-promote')", SB_CT),
    ).toBe('2');

    // The old primary comes back on timeline 1: the fence refuses its base.
    startDb();
    await waitPromoted();
    const old = runComposeBackupScript(dir);
    expect(old.status, old.stdout + old.stderr).not.toBe(0);
    expect(old.stderr).toContain('backup prefix fenced to another primary');
    expect((await latestBase(s3, folderB)).name).toBe(name);
  });

  // Final review ruling (e): a failing bucket holds the segment (postgres
  // retries it, pg_stat_archiver shows it); only disk pressure drops one, with
  // a durable record status reads, and the next pushed base clears it. Runs
  // the real wal-archive.sh (real wal-g, busybox df) the way archive_command
  // does, on the promoted primary the previous test left running. The push
  // targets a closed port, so nothing is ever uploaded for the live segment.
  it('wal-archive.sh holds a segment a push cannot land, drops one only under disk pressure, and a base clears the record', {
    timeout: 300_000,
  }, async () => {
    const ct = SB_CT;
    const seg = psql('SELECT pg_walfile_name(pg_current_wal_lsn())', ct);
    const segPath = `${PGDATA}/pg_wal/${seg}`;
    const gapPath = `${PGDATA}/vibecarbon-wal-gap`;
    const archive = (extra: string[] = []) =>
      spawnSync(
        'docker',
        [
          'exec',
          '-u',
          'postgres',
          ...[
            'AWS_ENDPOINT=http://127.0.0.1:1',
            // wal-g retries a refused connection for minutes by default.
            'WALG_S3_MAX_RETRIES=0',
            'WAL_ARCHIVE_RETRIES=1',
            'WAL_ARCHIVE_SLEEP=0',
            ...extra,
          ].flatMap((e) => ['-e', e]),
          ct,
          'bash',
          '/etc/postgresql/wal-archive.sh',
          segPath,
        ],
        { encoding: 'utf-8', timeout: 120_000 },
      );
    const exists = (path: string) =>
      spawnSync('docker', ['exec', ct, 'test', '-e', path]).status === 0;

    const held = archive();
    expect(held.status, held.stderr).toBe(1);
    expect(held.stderr).toMatch(/WAL_ARCHIVE_FAILED: [^\n]*keeping the segment/);
    expect(exists(segPath)).toBe(true);
    expect(exists(gapPath)).toBe(false);

    const dropped = archive(['VC_WAL_GUARD_FREE_BYTES=1048576']);
    expect(dropped.status, dropped.stderr).toBe(0);
    expect(dropped.stderr).toContain('WAL_ARCHIVE_DROPPED');
    const gap = docker(['exec', ct, 'cat', gapPath]);
    expect(gap).toMatch(new RegExp(`^${seg} \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$`));
    expect(parseWalGapRecord(`${gap}\nVC_OK`)).toEqual({ count: 1, first: seg, last: seg });

    // A drop recorded in the second the push starts is kept (it may be
    // after the base's start); this one is a second older.
    await sleep(1100);
    pushedName(runComposeBackupScript(dir, ct));
    expect(exists(gapPath)).toBe(false);
    expect(exists(`${gapPath}.clearing`)).toBe(false);
  });
});
