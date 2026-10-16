import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDb, dbTestsEnabled } from './_helpers';

/**
 * The add-ons that read the app database (Metabase, n8n) connect as their own
 * role, never as the `postgres` superuser. A superuser connection would let
 * anyone with Metabase's SQL editor or an n8n Postgres node run
 * `COPY ... TO PROGRAM` (a shell in the db container, which holds the backup
 * bucket's keys) and read the auth tables (password hashes, plain-text
 * session tokens, TOTP secrets).
 *
 * volumes/db/<addon>-init.sh runs at first boot and on every dev start
 * (scripts/docker-up.js). It makes its role NOSUPERUSER BYPASSRLS (so it sees
 * every business row), grants it the business tables, and in the same
 * transaction takes back every server-only table (RLS on, no policies)
 * through app.revoke_server_only_tables(), which the migration runner also
 * calls after every run. This runs each script's own SQL inside a transaction
 * that is rolled back.
 */
// Server-only today: the Better Auth tables and failed_login_attempts.
const SERVER_ONLY = ['user', 'session', 'account', 'verification', 'two_factor', 'failed_login_attempts'];
// A business table with policies, which the add-ons must read.
const APP_TABLE = 'organizations';

const ADDONS = [
  { role: 'metabase', writes: false },
  { role: 'n8n', writes: true },
] as const;

/**
 * A script's heredoc bodies (role, password and database, grants), minus what
 * only psql can run or what needs the add-on's own database.
 */
function initSqlBlocks(role: string): string[] {
  const script = readFileSync(join(process.cwd(), 'volumes', 'db', `${role}-init.sh`), 'utf8');
  const blocks = [...script.matchAll(/<<'?EOSQL'?\n([\s\S]*?)\nEOSQL/g)].map((m) => m[1]);
  return blocks.map((sql) =>
    sql
      .replaceAll('${POSTGRES_PASSWORD}', 'test-only-password')
      // psql-only: the password is read from the env inside the SQL.
      .replace(/^\\getenv pw \w+\n/m, '')
      .replaceAll(":'pw'", "'test-only-password'")
      // `SELECT 'CREATE DATABASE ...' WHERE ... \gexec` is a psql meta-command,
      // and the database grant needs that database: neither is under test.
      .replace(/SELECT 'CREATE DATABASE[\s\S]*?\\gexec\n/, '')
      .replace(new RegExp(`^GRANT ALL PRIVILEGES ON DATABASE ${role} TO ${role};\\n?`, 'm'), ''),
  );
}

/** The grants block up to (not including) its server-only revoke: what a first boot runs, with no function yet. */
function grantsOnly(block: string): string {
  return block.slice(0, block.indexOf('DO $$'));
}

describe.skipIf(!dbTestsEnabled)('add-on init scripts: own role, business tables only', () => {
  let client: pg.Client;
  const appTable = APP_TABLE;

  beforeAll(async () => {
    client = await connectTestDb();
  });

  afterAll(async () => {
    await client?.end();
  });

  const can = async (role: string, table: string, priv: string) =>
    (
      await client.query('select has_table_privilege($1, $2, $3) as ok', [
        role,
        `public.${JSON.stringify(table)}`,
        priv,
      ])
    ).rows[0].ok as boolean;

  /** Read `table` as `role` for real, inside a savepoint so a refusal does not end the transaction. */
  const readsAs = async (role: string, table: string) => {
    await client.query('SAVEPOINT read_as');
    try {
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(`select 1 from public.${JSON.stringify(table)} limit 1`);
      return true;
    } catch (err) {
      if (!/permission denied/.test((err as Error).message)) throw err;
      return false;
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT read_as');
    }
  };

  for (const { role, writes } of ADDONS) {
    describe(`${role}-init.sh`, () => {
      it('has the three blocks this test runs (role, password and database, grants with the revoke)', () => {
        const blocks = initSqlBlocks(role);
        expect(blocks).toHaveLength(3);
        expect(blocks[0]).toMatch(new RegExp(`ALTER ROLE ${role} NOSUPERUSER BYPASSRLS`));
        expect(blocks[2]).toContain(`ON ALL TABLES IN SCHEMA public TO ${role}`);
        expect(blocks[2]).toContain('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT');
        expect(blocks[2]).toContain('PERFORM app.revoke_server_only_tables();');
      });

      it('without the trailing revoke, the blanket grant reaches the server-only tables (the gap)', async () => {
        const [roleSql, , grants] = initSqlBlocks(role);
        await client.query('BEGIN');
        try {
          await client.query(roleSql);
          await client.query(grantsOnly(grants));
          expect(await can(role, 'user', 'SELECT')).toBe(true);
          expect(await can(role, 'failed_login_attempts', 'SELECT')).toBe(true);
        } finally {
          await client.query('ROLLBACK');
        }
      });

      it('after every run: not superuser, bypasses RLS, reads business tables, never a server-only one', async () => {
        await client.query('BEGIN');
        try {
          // A role left over as superuser (or created by hand) is demoted.
          await client.query(`CREATE ROLE ${role} LOGIN SUPERUSER`);
          // Twice: the script reruns on every dev start.
          for (let run = 0; run < 2; run++) {
            for (const sql of initSqlBlocks(role)) await client.query(sql);
            const { rows } = await client.query(
              'select rolsuper, rolbypassrls from pg_roles where rolname = $1',
              [role],
            );
            expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: true });
            for (const table of SERVER_ONLY) {
              expect(await can(role, table, 'SELECT'), `${role} can read ${table}`).toBe(false);
              expect(await readsAs(role, table), `${role} reads ${table}`).toBe(false);
            }
            expect(await readsAs(role, appTable), `${role} reads ${appTable}`).toBe(true);
            for (const priv of ['INSERT', 'UPDATE', 'DELETE']) {
              expect(await can(role, appTable, priv), `${role} ${priv} ${appTable}`).toBe(writes);
            }
            // pg_stat_statements' views are outside public, so the blanket
            // public grant cannot reach them.
            const { rows: mon } = await client.query(
              "select has_schema_privilege($1, 'monitoring', 'USAGE') as ok",
              [role],
            );
            expect(mon[0].ok, `${role} uses schema monitoring`).toBe(false);
          }
        } finally {
          await client.query('ROLLBACK');
        }
      });

      it('first boot (init before the app migrates): the migration runner takes the server-only tables back', async () => {
        await client.query('BEGIN');
        try {
          const [roleSql, , grants] = initSqlBlocks(role);
          await client.query(roleSql);
          // First boot: no tables and no function yet, so only the grants run.
          await client.query(grantsOnly(grants));
          // What the default privileges hand the role as the migration then
          // creates the tables.
          await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
          expect(await can(role, 'session', 'SELECT')).toBe(true);
          // What 0002 and src/server/db/migrate.ts run after the migrations.
          await client.query('select app.revoke_server_only_tables()');
          for (const table of SERVER_ONLY) {
            expect(await can(role, table, 'SELECT'), `${role} can read ${table}`).toBe(false);
          }
          expect(await can(role, appTable, 'SELECT')).toBe(true);
        } finally {
          await client.query('ROLLBACK');
        }
      });

      it('a table a later migration adds with RLS and no policy is server-only for the role too', async () => {
        await client.query('BEGIN');
        try {
          for (const sql of initSqlBlocks(role)) await client.query(sql);
          // The default privileges grant both new tables to the role.
          await client.query('create table public.addon_test_secret (id int)');
          await client.query('alter table public.addon_test_secret enable row level security');
          await client.query('create table public.addon_test_open (id int)');
          await client.query('alter table public.addon_test_open enable row level security');
          await client.query('create policy addon_test_open_read on public.addon_test_open for select using (true)');
          expect(await can(role, 'addon_test_secret', 'SELECT')).toBe(true);
          await client.query('select app.revoke_server_only_tables()');
          expect(await can(role, 'addon_test_secret', 'SELECT')).toBe(false);
          expect(await readsAs(role, 'addon_test_secret')).toBe(false);
          expect(await can(role, 'addon_test_open', 'SELECT')).toBe(true);
          // And a dev-start rerun of the init script (grant, then revoke) keeps it so.
          for (const sql of initSqlBlocks(role)) await client.query(sql);
          expect(await can(role, 'addon_test_secret', 'SELECT')).toBe(false);
        } finally {
          await client.query('ROLLBACK');
        }
      });
    });
  }
});
