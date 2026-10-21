import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatDotenvLine } from '../../../src/lib/dotenv.js';
import { listDockerNetworks, pickFreeSubnetPrefix } from '../../../src/lib/subnet.js';

/**
 * First boot of the db image with the backup bucket UNREACHABLE.
 *
 * The bug this pins: the official docker-entrypoint.sh starts an init-time
 * temporary server with the same arguments as the real one, so the deploy's
 * `-c archive_mode=on -c archive_command=...` applied to it too. Stopping a
 * server with archiving on means archiving every finished WAL segment first;
 * with S3 unreachable that outlasted `pg_ctl -w stop`, the entrypoint exited
 * non-zero and the container crashed once (RestartCount 1) before its second
 * start skipped init. docker/postgres-walg/db-entrypoint.sh keeps archiving
 * off the temporary server only.
 *
 * Runs the REAL carbon/docker-compose.yml db service (base file only: the dev
 * override blanks the S3 settings, which would hide the bug) against an image
 * built from this checkout's docker/postgres-walg, under a unique compose
 * project. 192.0.2.1 is TEST-NET-1 (RFC 5737): never routed, so every wal-g
 * connect hangs until its own timeout, the worst case for the temp server.
 */
const shouldRunDocker = process.env.DOCKER_INTEGRATION === 'true';
const describeDocker = shouldRunDocker ? describe : describe.skip;

const ROOT = process.cwd();
const PROJECT = `vcfirstboot${process.pid}`;
const IMAGE = 'vibecarbon-db-first-boot';
const TAG = String(process.pid);

const run = (cmd: string, args: string[], cwd?: string) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf-8', stdio: 'pipe' });

describeDocker('db image first boot with an unreachable backup bucket', () => {
  let dir: string;
  const compose = (args: string[]) =>
    run('docker', ['compose', '-p', PROJECT, '-f', 'docker-compose.yml', ...args], dir);
  const psql = (sql: string) =>
    compose(['exec', '-T', 'db', 'psql', '-U', 'postgres', '-tAc', sql]).trim();

  beforeAll(() => {
    run('docker', ['build', '-q', '-t', `${IMAGE}:${TAG}`, join(ROOT, 'docker', 'postgres-walg')]);
    dir = mkdtempSync(join(tmpdir(), 'vc-db-first-boot-'));
    copyFileSync(join(ROOT, 'carbon', 'docker-compose.yml'), join(dir, 'docker-compose.yml'));
    mkdirSync(join(dir, 'volumes', 'db'), { recursive: true });
    mkdirSync(join(dir, 'db', 'migrations'), { recursive: true });
    for (const script of ['wal-archive.sh', 'db-guard.sh']) {
      copyFileSync(
        join(ROOT, 'carbon', 'volumes', 'db', script),
        join(dir, 'volumes', 'db', script),
      );
    }
    const prefix = pickFreeSubnetPrefix(listDockerNetworks() ?? [], PROJECT);
    if (!prefix) throw new Error('no free 172.30.x.0/24 for the test network');
    const env = {
      PROJECT_NAME: PROJECT,
      DB_IMAGE: IMAGE,
      DB_IMAGE_TAG: TAG,
      POSTGRES_PASSWORD: 'first-boot-test',
      // docker-compose.yml requires it (`:?`) for the app and app-migrate.
      APP_DB_PASSWORD: 'first-boot-test-app',
      DEV_SUBNET_PREFIX: prefix,
      S3_BUCKET: 'first-boot-test',
      S3_ENDPOINT: 'http://192.0.2.1:9000',
      S3_ACCESS_KEY: 'first-boot-test',
      S3_SECRET_KEY: 'first-boot-test',
    };
    writeFileSync(
      join(dir, '.env'),
      `${Object.entries(env)
        .map(([k, v]) => formatDotenvLine(k, v))
        .join('\n')}\n`,
    );
  }, 600_000);

  afterAll(() => {
    try {
      if (dir) compose(['down', '-v']);
    } catch {
      /* best effort */
    }
    try {
      run('docker', ['image', 'rm', `${IMAGE}:${TAG}`]);
    } catch {
      /* best effort */
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reaches healthy without a single restart', { timeout: 300_000 }, () => {
    compose(['up', '-d', '--wait', 'db']);
    const id = compose(['ps', '-q', 'db']).trim();
    expect(run('docker', ['inspect', '-f', '{{.RestartCount}}', id]).trim()).toBe('0');
  });

  it('the init-time temporary server never ran archive_command', () => {
    const logs = compose(['logs', '--no-color', 'db']);
    const initDone = logs.indexOf('PostgreSQL init process complete');
    expect(initDone, 'first boot did not run init').toBeGreaterThan(-1);
    // wal-g announces every wal-push with this line.
    const firstPush = logs.indexOf('Files will be uploaded to storage');
    expect(firstPush === -1 || firstPush > initDone, 'wal-g ran before init finished').toBe(true);
  });

  it('the real server archives with the settings compose passes', () => {
    expect(psql('SHOW archive_mode')).toBe('on');
    expect(psql('SHOW archive_command')).toBe('bash /etc/postgresql/wal-archive.sh %p');
    expect(psql('SHOW wal_level')).toBe('replica');
    expect(psql('SHOW config_file')).toBe('/etc/postgresql/postgresql.conf');
    expect(psql('SHOW shared_preload_libraries')).toBe('pg_cron,pg_stat_statements');
  });

  it('a second boot (initialized volume, no temporary server) still archives', {
    timeout: 300_000,
  }, () => {
    compose(['restart', 'db']);
    // `up --wait` on a running service only waits for it to report healthy.
    compose(['up', '-d', '--wait', 'db']);
    const logs = compose(['logs', '--no-color', 'db']);
    expect(logs).toContain(
      'Database directory appears to contain a database; Skipping initialization',
    );
    expect(psql('SHOW archive_mode')).toBe('on');
    expect(psql('SHOW archive_command')).toBe('bash /etc/postgresql/wal-archive.sh %p');
  });
});
