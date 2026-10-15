/**
 * Shape guards for the db image's first boot (the docker smoke that proves it
 * end to end is tests/integration/docker/db-first-boot.test.ts).
 *
 * The bug: WAL archiving was active on the official entrypoint's init-time
 * temporary server, because that server is started with the same `-c` flags
 * compose passes the real one. With the backup bucket unreachable its stop
 * outlasted `pg_ctl -w stop` and the db crashed once on every fresh volume.
 * The fix lives in docker/postgres-walg/db-entrypoint.sh; these pin the
 * pieces it depends on so a "simplification" can't quietly undo it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const DOCKERFILE = read('docker/postgres-walg/Dockerfile');
const ENTRYPOINT = read('docker/postgres-walg/db-entrypoint.sh');
const CONF = read('docker/postgres-walg/postgresql.conf');
const COMPOSE = loadYaml(read('carbon/docker-compose.yml')) as {
  services: Record<string, { command?: string[]; environment?: Record<string, unknown> }>;
};
const DB = COMPOSE.services.db;
const code = (text: string) =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

describe('the db image runs the wrapper, not the bare official entrypoint', () => {
  it('ENTRYPOINT is db-entrypoint.sh, CMD is postgres', () => {
    expect(DOCKERFILE).toMatch(/^ENTRYPOINT \["db-entrypoint\.sh"\]$/m);
    expect(DOCKERFILE).toMatch(/^CMD \["postgres"\]$/m);
    expect(DOCKERFILE).toMatch(/^COPY --chmod=0755 db-entrypoint\.sh \/usr\/local\/bin\//m);
  });
});

describe('db-entrypoint.sh keeps archiving off the temporary server only', () => {
  const body = code(ENTRYPOINT);

  it('sources the official script instead of copying it', () => {
    expect(body).toMatch(/^source \/usr\/local\/bin\/docker-entrypoint\.sh$/m);
    expect(body).toMatch(/^_main "\$@"$/m);
  });

  it('wraps docker_temp_server_start, appending archive_mode=off after the deploy flags', () => {
    expect(body).toContain('eval "upstream_$(declare -f docker_temp_server_start)"');
    expect(body).toMatch(
      /docker_temp_server_start\(\) \{\s*upstream_docker_temp_server_start "\$@" -c archive_mode=off\s*\}/,
    );
  });

  it('drops root by re-executing ITSELF, so the override survives the user switch', () => {
    // Upstream's _main re-execs "$BASH_SOURCE" (docker-entrypoint.sh) as
    // postgres, which would discard the wrapper. Measured: with that path the
    // temporary server ran with archive_mode=on and the db restarted once.
    expect(body).toMatch(/exec gosu postgres "\$0" "\$@"/);
    expect(body).not.toMatch(/BASH_SOURCE/);
  });

  it('has no sleeps, retries or timeouts (Mitigation Policy)', () => {
    expect(body).not.toMatch(/\bsleep\b|\btimeout\b|retry|until /);
  });
});

describe('compose passes archiving to the real server', () => {
  it('db command keeps the baked config and the WAL flags', () => {
    const command = DB.command ?? [];
    expect(command[0]).toBe('postgres');
    const flags = command.slice(1).filter((a) => a !== '-c');
    expect(flags).toEqual(
      expect.arrayContaining([
        'config_file=/etc/postgresql/postgresql.conf',
        'wal_level=replica',
        'archive_mode=on',
        'archive_command=bash /etc/postgresql/wal-archive.sh %p',
        'archive_timeout=900',
        'hot_standby=on',
        'max_connections=200',
      ]),
    );
    // Every value must be preceded by its own -c.
    for (let i = 1; i < command.length; i += 2) expect(command[i]).toBe('-c');
  });

  it('db env names the superuser for `docker compose exec db` scripts', () => {
    expect(DB.environment?.POSTGRES_USER).toBe('postgres');
  });
});

describe('the baked postgresql.conf', () => {
  const settings = Object.fromEntries(
    code(CONF)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [k, ...v] = l.split('=');
        return [k.trim(), v.join('=').trim()];
      }),
  );

  it('preloads pg_cron for the postgres database and listens on all interfaces', () => {
    expect(settings.shared_preload_libraries).toBe("'pg_cron'");
    expect(settings['cron.database_name']).toBe("'postgres'");
    expect(settings.listen_addresses).toBe("'*'");
  });

  it('carries the small-box defaults', () => {
    expect(settings.shared_buffers).toBe('128MB');
    expect(settings.max_connections).toBe('100');
  });

  it('leaves archiving, hba_file and data_directory to the deploy and the defaults', () => {
    for (const key of [
      'archive_mode',
      'archive_command',
      'wal_level',
      'hba_file',
      'data_directory',
    ]) {
      expect(settings[key], `${key} must not be baked`).toBeUndefined();
    }
  });
});
