/**
 * A lost replication slot is dropped and recreated before the standby is
 * reseeded (HA-correctness Task 7, H5).
 *
 * Once the slot's WAL passes max_slot_wal_keep_size, Postgres removes that WAL
 * and marks the slot `lost` (verified on postgres:17.11-walg3.0.9-r2:
 * wal_status=lost, invalidation_reason=wal_removed). A lost slot can never
 * stream again, and it survives the old "create if missing" SQL, so a reseeded
 * standby that streams through it fails straight away. The standby is not
 * streaming, so the deploy already takes the reseed path; every slot ensure on
 * that path now drops a lost slot first, so the reseed gets a fresh one.
 *
 * Census: every slot creation in src/ and carbon/ha/ comes from the one
 * builder (ensureReplicationSlotSql), so no site can create a slot without
 * the lost-slot drop.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sshCalls: Array<{ command: string; input?: string }> = [];

vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const rec = async (_ip: string, _k: string, command: unknown, options?: { input?: string }) => {
    const c = String(command);
    sshCalls.push({ command: c, input: options?.input });
    if (c.includes('pg_is_in_recovery')) return 't';
    if (c.includes('pg_stat_replication')) return 'streaming';
    if (c.includes('SHOW hba_file')) return '/var/lib/postgresql/data/pg_hba.conf';
    if (c.includes('pg_isready')) return 'accepting connections';
    if (options?.input?.includes('pg_basebackup')) return 'COMPOSE_RESEED_STAGED';
    if (c.includes('IPAM')) return '172.19.0.0/16 ';
    if (c.includes('.Mounts')) return '/var/lib/docker/volumes/myapp_db_data/_data';
    if (options?.input?.includes('RESEED_SWAPPED')) return 'RESEED_SWAPPED';
    return '';
  };
  return { ...actual, sshRun: vi.fn(rec), sshRunAsync: vi.fn(rec), sshRunChecked: vi.fn(rec) };
});

vi.mock('../../../src/lib/deploy/wireguard.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  exchangeAndBringUpTunnel: vi.fn().mockResolvedValue({}),
}));

const { ensureReplicationSlotSql, REPLICATION_SLOT } = await import(
  '../../../src/lib/deploy/replication-slot.js'
);
const { configurePrimaryReplication, configureStandbyReplication } = await import(
  '../../../src/lib/deploy/compose/ha.js'
);
const { WG_PRIMARY_IP } = await import('../../../src/lib/deploy/wireguard.js');

const ROOT = join(__dirname, '../../..');

/** Every SQL a call carried: stdin, and any `echo <b64> | base64 -d` in the command. */
const sqlOf = (c: { command: string; input?: string }) => [
  c.input ?? '',
  ...[...c.command.matchAll(/echo (\S+) \| base64 -d/g)].map((m) =>
    Buffer.from(m[1], 'base64').toString('utf-8'),
  ),
];

beforeEach(() => {
  process.env.REPL_PASSWORD = 'testreplpass';
  sshCalls.length = 0;
});

describe('ensureReplicationSlotSql', () => {
  const sql = ensureReplicationSlotSql();

  it('drops the slot only when it is lost, then creates it if missing', () => {
    const drop = sql.indexOf(`pg_drop_replication_slot('${REPLICATION_SLOT}')`);
    const create = sql.indexOf(`pg_create_physical_replication_slot('${REPLICATION_SLOT}')`);
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
    expect(sql).toMatch(/wal_status = 'lost'/);
  });

  it('never drops a healthy slot: the drop sits behind the lost test', () => {
    const guard = sql.slice(0, sql.indexOf('pg_drop_replication_slot'));
    expect(guard).toMatch(/IF EXISTS \([^)]*wal_status = 'lost'/s);
  });
});

describe('the reseed path recreates a lost slot', () => {
  it('compose: the primary configure step runs the lost-slot ensure', async () => {
    await configurePrimaryReplication('1.1.1.1', '2.2.2.2', '/tmp/key', 'myapp');
    expect(sshCalls.flatMap(sqlOf).some((s) => s.includes(ensureReplicationSlotSql()))).toBe(true);
  });

  it('compose: the standby reseed re-ensures the slot on the primary first', async () => {
    await configureStandbyReplication('2.2.2.2', '1.1.1.1', '/tmp/key', 'myapp', {
      primaryHost: WG_PRIMARY_IP,
    });
    const ensure = sshCalls.findIndex((c) =>
      sqlOf(c).some((s) => s.includes(ensureReplicationSlotSql())),
    );
    const basebackup = sshCalls.findIndex((c) => c.input?.includes('pg_basebackup'));
    expect(ensure).toBeGreaterThan(-1);
    expect(basebackup).toBeGreaterThan(ensure);
  });

  it('k8s: primary-init.sql (run on every HA deploy) carries the same ensure', () => {
    const sql = readFileSync(join(ROOT, 'carbon/ha/primary-init.sql'), 'utf-8');
    expect(sql).toContain(ensureReplicationSlotSql());
  });
});

describe('census: every slot creation goes through ensureReplicationSlotSql', () => {
  const BUILDER = 'src/lib/deploy/replication-slot.js';
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });

  /** Files that spell a slot creation outside the builder. */
  function offenders(files: Array<{ path: string; text: string }>): string[] {
    const builderOutput = ensureReplicationSlotSql();
    return files
      .filter(({ path }) => path !== BUILDER)
      .filter(({ text }) =>
        text.replaceAll(builderOutput, '').includes('pg_create_physical_replication_slot('),
      )
      .map(({ path }) => path);
  }

  const sources = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'carbon/ha'))]
    .filter((p) => /\.(js|sql)$/.test(p))
    .map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf-8') }));

  it('no site creates a slot by hand', () => {
    expect(offenders(sources)).toEqual([]);
  });

  it('bites: a hand-written create is reported', () => {
    const stray = {
      path: 'src/lib/deploy/stray.js',
      text: "PERFORM pg_create_physical_replication_slot('vibecarbon_standby_slot');",
    };
    expect(offenders([...sources, stray])).toEqual(['src/lib/deploy/stray.js']);
  });
});
