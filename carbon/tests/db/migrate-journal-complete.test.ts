import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_SERVICE_FUNCTIONS } from '@server/db/app-service-role';
import { verifyMigrationsOnOwnConnection } from '@server/db/migrate';
import { migrateMain, runMigrateStep } from '@server/db/migrate-cli';
import { connectTestDb, dbTestsEnabled } from './_helpers';

/**
 * Every journal migration must be proven applied, not just the newest one.
 * drizzle's migrator applies only entries newer than the newest ledger row,
 * so an entry added later with an older `when` is silently skipped. The
 * migrate step and the ledger check compare by hash and fail loudly.
 */

interface Entry {
  tag: string;
  when: number;
  sql: string;
}

/**
 * The role setup grants EXECUTE on the baseline's server-only functions, so a
 * throwaway first migration defines a stub for each (the real ones need the
 * full baseline, which is migrations.test.ts's subject).
 */
const STUBS = APP_SERVICE_FUNCTIONS.map((f) => {
  const [name, args] = f.split(/\((.*)\)/);
  return `create function ${name}(${args}) returns void language sql as 'select 1'`;
}).join(';\n--> statement-breakpoint\n');

/** Write a drizzle-format folder with explicit `when` values. */
function writeFolder(root: string, entries: Entry[]): string {
  const dir = join(root, randomUUID());
  mkdirSync(join(dir, 'meta'), { recursive: true });
  writeFileSync(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: entries.map((e, idx) => ({
        idx,
        version: '7',
        when: e.when,
        tag: e.tag,
        breakpoints: true,
      })),
    })
  );
  for (const e of entries) writeFileSync(join(dir, `${e.tag}.sql`), e.sql);
  return dir;
}

describe.skipIf(!dbTestsEnabled)('a skipped journal migration', () => {
  let admin: pg.Client;
  const dbName = `migrate_journal_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const root = mkdtempSync(join(tmpdir(), 'migrate-journal-'));
  const APP_PW = 'journal-test-app-password';
  const conn = () => ({
    host: process.env.TEST_DB_HOST,
    port: Number(process.env.TEST_DB_PORT ?? 5432),
    user: process.env.TEST_DB_USER ?? 'postgres',
    password: process.env.TEST_DB_PASSWORD,
    database: dbName,
  });

  beforeAll(async () => {
    admin = await connectTestDb();
    // The step's role setup grants app_user; the real baseline creates it, these
    // throwaway folders do not. Roles are cluster-wide, so only add it if missing.
    await admin.query(
      `do $$ begin if not exists (select 1 from pg_roles where rolname = 'app_user') then create role app_user nologin; end if; end $$`
    );
    await admin.query(`create database ${dbName}`);
  });

  afterAll(async () => {
    await admin?.query(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
    rmSync(root, { recursive: true, force: true });
  });

  it('a journal entry older than the newest applied one fails the migrate step', async () => {
    const t = Date.now();
    const a = { tag: '0000_first', when: t, sql: `${STUBS};\n--> statement-breakpoint\ncreate table jc_a (id int)` };
    const c = { tag: '0002_third', when: t + 20, sql: 'create table jc_c (id int)' };
    const b = { tag: '0001_second', when: t + 10, sql: 'create table jc_b (id int)' };

    await runMigrateStep(conn(), APP_PW, writeFolder(root, [a, c]));
    const folder = writeFolder(root, [a, b, c]);

    await expect(runMigrateStep(conn(), APP_PW, folder)).rejects.toThrow(
      /migration 0001_second is not in the ledger \(skipped, or edited after it was applied\); regenerate it/
    );
    expect(await verifyMigrationsOnOwnConnection(conn(), folder)).toEqual({ upToDate: false });

    // The migrate step's main loop turns it into exit code 1 with a one-line cause.
    const errors: string[] = [];
    const code = await migrateMain({
      run: () => runMigrateStep(conn(), APP_PW, folder),
      log: { info: () => {}, warn: () => {}, error: (fields: unknown) => {
          const err = (fields as { err: unknown }).err;
          errors.push(err instanceof Error ? err.message : String(err));
        },
      },
      pause: async () => {},
    });
    expect(code).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('migration 0001_second is not in the ledger (skipped, or edited after it was applied)');
    expect(errors[0]).not.toContain(APP_PW);
    expect(errors[0]).not.toContain(String(process.env.TEST_DB_PASSWORD));
  });

  it('a complete journal is up to date, and an in-order add is applied', async () => {
    const t = Date.now() + 1_000_000;
    const a = { tag: '0000_x', when: t, sql: `${STUBS};\n--> statement-breakpoint\ncreate table jd_a (id int)` };
    const b = { tag: '0001_y', when: t + 10, sql: 'create table jd_b (id int)' };
    const first = writeFolder(root, [a]);
    const second = writeFolder(root, [a, b]);
    // The previous test left a newer ledger row, so this one needs its own database.
    const own = { ...conn(), database: `${dbName}_ok` };
    await admin.query(`create database ${own.database}`);
    try {
      expect(await runMigrateStep(own, APP_PW, first)).toEqual({ kind: 'applied', newlyApplied: 1 });
      expect(await verifyMigrationsOnOwnConnection(own, first)).toEqual({ upToDate: true });
      expect(await verifyMigrationsOnOwnConnection(own, second)).toEqual({ upToDate: false });
      expect(await runMigrateStep(own, APP_PW, second)).toEqual({ kind: 'applied', newlyApplied: 1 });
      expect(await verifyMigrationsOnOwnConnection(own, second)).toEqual({ upToDate: true });
    } finally {
      await admin.query(`drop database if exists ${own.database} with (force)`);
    }
  });
});
