/**
 * Compose refuses to swap the stack on a database the retired stack made.
 *
 * Final review I3: after `vibecarbon upgrade`, `docker compose up
 * --remove-orphans` dropped the old services, our image booted on the old
 * PGDATA (every table present, no drizzle ledger), the baseline failed on its
 * first CREATE and the app reported MIGRATIONS_FAILED: production down past
 * the point of no return. k8s already refused the same case
 * (assertNoRetiredChartDb). These pin the compose counterpart: one read per
 * server, before any swap, with the way forward in the refusal.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  assertDbMadeByThisStack,
  dbLedgerProbeCommand,
  PRE_LEDGER_SQL,
  parseDbLedgerProbe,
} from '../../../src/lib/deploy/compose/db-ledger-preflight.js';

const PROJECT = 'acme';
const running = (answer: string) =>
  `STATE=true\nIMAGE=ghcr.io/hyperformant/postgres:17.11-walg3.0.9-r1\nPRE_LEDGER=${answer}\n`;

describe('dbLedgerProbeCommand', () => {
  const cmd = dbLedgerProbeCommand(PROJECT);

  it('reads the compose container_name, and only asks psql when the container runs', () => {
    expect(cmd).toContain('c=acme-db');
    // Proven against a missing container: `$(inspect || echo absent)` printed
    // "STATE=\nabsent" and a first deploy read as unreadable.
    expect(cmd).toContain(
      `running=$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null) || running=absent`,
    );
    expect(cmd).toContain('[ "$running" = absent ] && {');
    expect(cmd).toContain('[ "$running" = true ] || exit 0');
    expect(cmd).toContain('docker exec "$c" psql -U postgres -d postgres -tAc');
  });

  it('when the container is absent, looks for the compose db volume by its label', () => {
    expect(cmd).toContain('docker volume ls -q --filter label=com.docker.compose.volume=db_data');
    expect(cmd).toContain('VOLUME=');
  });

  it('ships the ledger query base64-encoded, so no quoting can bend it', () => {
    const b64 = /echo (\S+) \| base64 -d/.exec(cmd)?.[1] ?? '';
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(PRE_LEDGER_SQL);
    expect(PRE_LEDGER_SQL).toContain("to_regclass('drizzle.__drizzle_migrations') is null");
    expect(PRE_LEDGER_SQL).toContain("pg_tables where schemaname='public'");
  });
});

describe('parseDbLedgerProbe', () => {
  it('no container: a first deploy', () => {
    expect(parseDbLedgerProbe('STATE=absent\n', PROJECT).verdict).toBe('absent');
  });

  it('no container and no db volume (empty VOLUME): still a first deploy', () => {
    expect(parseDbLedgerProbe('STATE=absent\nVOLUME=\n', PROJECT).verdict).toBe('absent');
  });

  it('no container but a db volume left behind: unreadable, origin cannot be checked', () => {
    const r = parseDbLedgerProbe('STATE=absent\nVOLUME=acme_db_data\n', PROJECT);
    expect(r.verdict).toBe('unreadable');
    expect(r.detail).toContain('db volume exists but no db container is running');
  });

  it('running with tables and no ledger: the retired stack made it', () => {
    expect(parseDbLedgerProbe(running('t'), PROJECT).verdict).toBe('pre-ledger');
  });

  it('running with a ledger or an empty public schema: fine', () => {
    expect(parseDbLedgerProbe(running('f'), PROJECT).verdict).toBe('ok');
  });

  it('a psql error is unreadable, never ok', () => {
    const out = running('psql:error:connectiontoserverfailed');
    const r = parseDbLedgerProbe(out, PROJECT);
    expect(r.verdict).toBe('unreadable');
    expect(r.detail).toContain('connectiontoserverfailed');
  });

  it('stopped container of the retired on-server build: refuse', () => {
    for (const image of ['acme-db:latest', 'acme-db']) {
      expect(parseDbLedgerProbe(`STATE=false\nIMAGE=${image}\n`, PROJECT).verdict).toBe(
        'pre-ledger',
      );
    }
  });

  it('stopped container of a pulled image: left to the migrator', () => {
    const out = 'STATE=false\nIMAGE=ghcr.io/hyperformant/postgres-dev:17.11-walg3.0.9-r1-abc\n';
    expect(parseDbLedgerProbe(out, PROJECT).verdict).toBe('ok');
  });

  it('garbage output is unreadable', () => {
    expect(parseDbLedgerProbe('', PROJECT).verdict).toBe('unreadable');
    expect(parseDbLedgerProbe('bash: docker: command not found', PROJECT).verdict).toBe(
      'unreadable',
    );
  });
});

describe('assertDbMadeByThisStack', () => {
  const key = '/p/.vibecarbon/deploy_key_prod';

  it('passes a first deploy and a ledgered database, one read per server', async () => {
    const sshRun = vi
      .fn()
      .mockResolvedValueOnce('STATE=absent\n')
      .mockResolvedValueOnce(running('f'));
    await expect(
      assertDbMadeByThisStack(['1.1.1.1', '2.2.2.2'], key, PROJECT, { sshRun }),
    ).resolves.toBeUndefined();
    expect(sshRun).toHaveBeenCalledTimes(2);
    expect(sshRun.mock.calls.map((c) => c[0])).toEqual(['1.1.1.1', '2.2.2.2']);
    expect(sshRun.mock.calls[0][2]).toBe(dbLedgerProbeCommand(PROJECT));
  });

  it('refuses a pre-ledger database with backup, destroy + deploy, and hand-carried rows', async () => {
    const sshRun = vi.fn().mockResolvedValue(running('t'));
    const err = await assertDbMadeByThisStack(['1.1.1.1'], key, PROJECT, { sshRun }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const msg = String(err.message);
    expect(msg).toContain('created by an older vibecarbon stack');
    expect(msg).toContain('Nothing has been changed on the server');
    expect(msg).toContain('`vibecarbon backup <env>`');
    expect(msg).toContain('`vibecarbon destroy <env>`, then `vibecarbon deploy <env>`');
    expect(msg).toContain('by hand');
    expect(msg).toContain(`ssh -i ${key} root@1.1.1.1`);
    expect(msg).toContain('docker exec acme-db pg_dump -U postgres --data-only');
    expect(msg).not.toMatch(/—/);
  });

  it('refuses when the STANDBY holds the retired data even though the primary is fine', async () => {
    const sshRun = vi.fn().mockResolvedValueOnce(running('f')).mockResolvedValueOnce(running('t'));
    await expect(
      assertDbMadeByThisStack(['1.1.1.1', '2.2.2.2'], key, PROJECT, { sshRun }),
    ).rejects.toThrow(/database on 2\.2\.2\.2 was created by an older vibecarbon stack/);
  });

  it('a read that fails is a refusal, not a pass', async () => {
    const sshRun = vi.fn().mockRejectedValue(new Error('ssh: connect timed out'));
    await expect(assertDbMadeByThisStack(['1.1.1.1'], key, PROJECT, { sshRun })).rejects.toThrow(
      /Could not check the database on 1\.1\.1\.1.*ssh: connect timed out/,
    );
    expect(sshRun).toHaveBeenCalledTimes(1);
  });

  it('an unreadable answer is a refusal that names where to look', async () => {
    const sshRun = vi.fn().mockResolvedValue(running('psql:FATAL'));
    await expect(assertDbMadeByThisStack(['1.1.1.1'], key, PROJECT, { sshRun })).rejects.toThrow(
      /docker logs acme-db/,
    );
  });

  it('an absent container with a db volume tells the operator to start the db and deploy again', async () => {
    const sshRun = vi.fn().mockResolvedValue('STATE=absent\nVOLUME=acme_db_data\n');
    const err = await assertDbMadeByThisStack(['1.1.1.1'], key, PROJECT, { sshRun }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const msg = String(err.message);
    expect(msg).toContain('docker compose up -d db');
    expect(msg).toContain('deploy again');
    expect(msg).not.toMatch(/—/);
  });

  it('a running db that does not answer hints that stopping a crash-looping db falls back to its image', async () => {
    const sshRun = vi.fn().mockResolvedValue(running('psql:FATAL'));
    await expect(assertDbMadeByThisStack(['1.1.1.1'], key, PROJECT, { sshRun })).rejects.toThrow(
      /crash-looping.*docker stop acme-db.*image/s,
    );
  });
});
