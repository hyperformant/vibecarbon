import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MIGRATIONS_LOCK_KEY,
  migrationsFolder,
  runMigrations,
  runMigrationsOnOwnConnection,
  verifyMigrations,
} from '@server/db/migrate';
import { getMigrationStatus, setMigrationStatus } from '@server/db/migration-status';
import { verifyMigrationsAtStartup } from '@server/db/startup';
import { migrationsGate } from '@server/middleware/migrations-gate';
import { healthRoutes } from '@server/routes/health';
import { catalogSnapshot } from './_catalog';
import { connectTestDb, dbTestsEnabled } from './_helpers';

/**
 * The migration runner (src/server/db/migrate.ts) against real Postgres.
 *
 * - The test database was migrated by it (npm run db:migrate), and its
 *   catalog matches tests/db/fixtures/baseline-catalog.json, captured from a
 *   database built by the hand-written SQL files the baseline replaced. Every
 *   table, column, constraint, index, policy, function, trigger, grant and
 *   pg_cron job is therefore the same. To accept an intended schema change,
 *   rewrite the fixture: UPDATE_CATALOG_FIXTURE=1 npm run test:db.
 * - Runner behavior (idempotence, the advisory lock, a failing migration)
 *   uses throwaway migration folders in a scratch database of its own,
 *   created and dropped here.
 */

const FIXTURE = join(__dirname, 'fixtures', 'baseline-catalog.json');

/** Write a drizzle-format migrations folder: meta/_journal.json + one .sql per entry. */
function writeFolder(root: string, migrations: { tag: string; sql: string }[]): string {
  const dir = join(root, randomUUID());
  mkdirSync(join(dir, 'meta'), { recursive: true });
  const base = Date.now();
  writeFileSync(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: migrations.map((m, idx) => ({
        idx,
        version: '7',
        when: base + idx,
        tag: m.tag,
        breakpoints: true,
      })),
    })
  );
  for (const m of migrations) writeFileSync(join(dir, `${m.tag}.sql`), m.sql);
  return dir;
}

describe.skipIf(!dbTestsEnabled)('the baseline migration', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = await connectTestDb();
  });

  afterAll(async () => {
    await client?.end();
  });

  it('builds the same catalog as the hand-written SQL it replaced', async () => {
    const snapshot = await catalogSnapshot(client);
    if (process.env.UPDATE_CATALOG_FIXTURE === '1') {
      writeFileSync(FIXTURE, `${JSON.stringify(snapshot, null, 2)}\n`);
    }
    expect(snapshot).toEqual(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  });

  it('is recorded in the ledger, and running again applies nothing', async () => {
    const { rows } = await client.query('select count(*)::int as n from drizzle.__drizzle_migrations');
    expect(rows[0].n).toBeGreaterThanOrEqual(3);
    expect(await runMigrations(client, migrationsFolder())).toEqual({
      kind: 'applied',
      newlyApplied: 0,
    });
  });
});

describe.skipIf(!dbTestsEnabled)('runMigrations', () => {
  let admin: pg.Client;
  const dbName = `migrate_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const root = mkdtempSync(join(tmpdir(), 'migrate-test-'));
  const scratch = () =>
    new pg.Client({
      host: process.env.TEST_DB_HOST,
      port: Number(process.env.TEST_DB_PORT ?? 5432),
      user: process.env.TEST_DB_USER ?? 'postgres',
      password: process.env.TEST_DB_PASSWORD,
      database: dbName,
    });
  const opened: pg.Client[] = [];
  const connect = async () => {
    const c = scratch();
    await c.connect();
    opened.push(c);
    return c;
  };

  beforeAll(async () => {
    admin = await connectTestDb();
    await admin.query(`create database ${dbName}`);
  });

  afterAll(async () => {
    for (const c of opened) await c.end().catch(() => undefined);
    await admin?.query(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
    rmSync(root, { recursive: true, force: true });
    setMigrationStatus('pending');
  });

  it('applies pending migrations once; a second run applies nothing', async () => {
    const folder = writeFolder(root, [
      { tag: '0000_a', sql: 'create table idem_a (id int)' },
      { tag: '0001_b', sql: 'create table idem_b (id int);\n--> statement-breakpoint\ninsert into idem_b values (1)' },
    ]);
    const c = await connect();
    expect(await runMigrations(c, folder)).toEqual({ kind: 'applied', newlyApplied: 2 });
    expect(await runMigrations(c, folder)).toEqual({ kind: 'applied', newlyApplied: 0 });
    const { rows } = await c.query('select count(*)::int as n from idem_b');
    expect(rows[0].n).toBe(1);
  });

  it('serializes two concurrent runs with the advisory lock; both succeed, one applies', async () => {
    // Without the lock both would see an empty ledger and the second
    // `create table` would fail on the first one's table.
    const folder = writeFolder(root, [
      { tag: '0000_slow', sql: 'select pg_sleep(0.5);\n--> statement-breakpoint\ncreate table locked_once (id int)' },
    ]);
    const [a, b] = await Promise.all([connect(), connect()]);
    const results = await Promise.all([runMigrations(a, folder), runMigrations(b, folder)]);
    expect(results.map((r) => (r.kind === 'applied' ? r.newlyApplied : -1)).sort()).toEqual([0, 1]);
    const { rows } = await a.query("select count(*)::int as n from pg_tables where tablename = 'locked_once'");
    expect(rows[0].n).toBe(1);
  });

  // Startup migrations must not inherit the request pool's 30 s timeouts: a
  // replica waiting on the lock while another replica migrates is waiting
  // for a dependency. Here the database itself defaults every session to a
  // 200 ms statement_timeout, the connection settings carry pool-style
  // timeouts too, and the lock is held for well over both: the run still
  // waits and succeeds.
  it('waits on the lock past any statement_timeout and still applies', async () => {
    await admin.query(`alter database ${dbName} set statement_timeout = '200ms'`);
    try {
      const folder = writeFolder(root, [{ tag: '0000_waited', sql: 'create table waited (id int)' }]);
      const holder = await connect();
      await holder.query('set statement_timeout = 0');
      await holder.query('select pg_advisory_lock($1::bigint)', [MIGRATIONS_LOCK_KEY]);

      // Control: a session with the inherited timeout is cancelled waiting.
      const timed = await connect();
      await expect(
        timed.query('select pg_advisory_lock($1::bigint)', [MIGRATIONS_LOCK_KEY])
      ).rejects.toMatchObject({ code: '57014' });

      const connection = {
        host: process.env.TEST_DB_HOST,
        port: Number(process.env.TEST_DB_PORT ?? 5432),
        user: process.env.TEST_DB_USER ?? 'postgres',
        password: process.env.TEST_DB_PASSWORD,
        database: dbName,
        // What the request pool carries; must be ignored.
        statement_timeout: 200,
        query_timeout: 300,
        idle_in_transaction_session_timeout: 200,
      };
      const started = Date.now();
      const run = runMigrationsOnOwnConnection(connection, folder);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await holder.query('select pg_advisory_unlock($1::bigint)', [MIGRATIONS_LOCK_KEY]);
      expect(await run).toEqual({ kind: 'applied', newlyApplied: 1 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_200);
    } finally {
      await admin.query(`alter database ${dbName} reset statement_timeout`);
    }
  });

  it('a failing migration applies nothing and releases the lock', async () => {
    const folder = writeFolder(root, [
      { tag: '0000_ok', sql: 'create table partial_ok (id int)' },
      { tag: '0001_bad', sql: 'create table partial_bad (id int);\n--> statement-breakpoint\nselect * from no_such_table' },
    ]);
    const c = await connect();
    await expect(runMigrations(c, folder)).rejects.toMatchObject({});
    const { rows } = await c.query(
      "select count(*)::int as n from pg_tables where tablename in ('partial_ok', 'partial_bad')"
    );
    expect(rows[0].n).toBe(0);
    const { rows: locks } = await c.query(
      "select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()"
    );
    expect(locks[0].n).toBe(0);
  });

  it('a ledger behind db/migrations leaves health `pending` and the app serving only /api/health', async () => {
    // The migrate step applies the first migration; the folder already has a
    // second one, which it has not run yet. The app only reads the ledger.
    const applied = writeFolder(root, [{ tag: '0000_first', sql: 'create table verify_first (id int)' }]);
    const c = await connect();
    await runMigrations(c, applied);
    const ahead = writeFolder(root, [
      { tag: '0000_first', sql: 'create table verify_first (id int)' },
      { tag: '0001_second', sql: 'create table verify_second (id int)' },
    ]);
    expect(await verifyMigrations(c, ahead)).toEqual({ upToDate: false });

    setMigrationStatus('pending');
    let looks = 0;
    let release: () => void = () => {};
    const sawPending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const infos: unknown[] = [];
    const status = verifyMigrationsAtStartup({
      verify: async () => {
        looks += 1;
        if (looks === 2) release();
        // Behind until the test has checked the gate, then current.
        return looks >= 3 ? { upToDate: true } : verifyMigrations(c, ahead);
      },
      log: { info: (...args: unknown[]) => infos.push(args), warn: () => {}, error: () => {} },
      retryMs: 10,
    });
    await sawPending;
    expect(getMigrationStatus()).toBe('pending');

    const app = new Hono();
    app.use('*', migrationsGate());
    app.route('/api/health', healthRoutes);
    app.get('/api/v1/anything', (ctx) => ctx.text('served'));
    const health = await app.request('/api/health');
    expect(await health.json()).toMatchObject({ migrationStatus: 'pending' });
    expect((await app.request('/api/v1/anything')).status).toBe(503);
    expect((await app.request('/api/health/ready')).status).toBe(503);
    expect(await status).toBe('applied');
    // Nothing was applied from `ahead`: the app never migrates.
    const { rows } = await c.query("select to_regclass('public.verify_second') is null as absent");
    expect(rows[0].absent).toBe(true);
  });
});
