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
 * volumes/db/<addon>-init.sh reruns on every start (scripts/docker-up.js) and
 * makes its role NOSUPERUSER BYPASSRLS (so it sees every business row), grants
 * it the business tables, and takes the auth tables back. This runs each
 * script's own SQL, twice, inside a transaction that is rolled back.
 */
const AUTH_TABLES = ['user', 'session', 'account', 'verification', 'two_factor'];

const ADDONS = [
  { role: 'metabase', writes: false },
  { role: 'n8n', writes: true },
] as const;

/** A script's heredoc bodies, minus what only psql can run or what needs the add-on's own database. */
function initSqlBlocks(role: string): string[] {
  const script = readFileSync(join(process.cwd(), 'volumes', 'db', `${role}-init.sh`), 'utf8');
  const blocks = [...script.matchAll(/<<'?EOSQL'?\n([\s\S]*?)\nEOSQL/g)].map((m) => m[1]);
  return blocks.map((sql) =>
    sql
      .replaceAll('${POSTGRES_PASSWORD}', 'test-only-password')
      // `SELECT 'CREATE DATABASE ...' WHERE ... \gexec` is a psql meta-command,
      // and the database grant needs that database: neither is under test.
      .replace(/SELECT 'CREATE DATABASE[\s\S]*?\\gexec\n/, '')
      .replace(new RegExp(`^GRANT ALL PRIVILEGES ON DATABASE ${role} TO ${role};\\n`, 'm'), ''),
  );
}

/** 0002_baseline_post.sql's per-role auth-table revoke loop (the DO block after the PUBLIC revoke). */
function baselineRevokeLoop(): string {
  const sql = readFileSync(
    join(process.cwd(), 'db', 'migrations', '0002_baseline_post.sql'),
    'utf8',
  );
  const loop = sql.match(/DO \$\$\nDECLARE\n {2}r TEXT;[\s\S]*?\nEND\n\$\$;/)?.[0];
  if (!loop) throw new Error('auth-table revoke loop not found in 0002_baseline_post.sql');
  return loop;
}

describe.skipIf(!dbTestsEnabled)('add-on init scripts: own role, business tables only', () => {
  let client: pg.Client;
  let appTable: string;

  beforeAll(async () => {
    client = await connectTestDb();
    const { rows } = await client.query(
      "select tablename from pg_tables where schemaname = 'public' and tablename <> all($1) order by 1 limit 1",
      [AUTH_TABLES],
    );
    appTable = rows[0]?.tablename as string;
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
      it('has the three blocks this test runs (role, grants, auth revoke)', () => {
        const blocks = initSqlBlocks(role);
        expect(blocks).toHaveLength(3);
        expect(blocks[0]).toMatch(new RegExp(`ALTER ROLE ${role} NOSUPERUSER BYPASSRLS`));
        expect(blocks[1]).toContain(`ON ALL TABLES IN SCHEMA public TO ${role}`);
        expect(blocks[1]).toContain('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT');
        expect(blocks[2]).toContain(`REVOKE ALL ON TABLE public.%I FROM ${role}`);
      });

      it('without the trailing revoke, the blanket grant reaches the auth tables (the gap)', async () => {
        const [roleSql, grants] = initSqlBlocks(role);
        await client.query('BEGIN');
        try {
          await client.query(roleSql);
          await client.query(grants);
          expect(await can(role, 'user', 'SELECT')).toBe(true);
        } finally {
          await client.query('ROLLBACK');
        }
      });

      it('after every run: not superuser, bypasses RLS, reads business tables, never the auth tables', async () => {
        expect(appTable).toBeTruthy();
        await client.query('BEGIN');
        try {
          // A role left over as superuser (or created by hand) is demoted.
          await client.query(`CREATE ROLE ${role} LOGIN SUPERUSER`);
          // Twice: the script reruns on every start.
          for (let run = 0; run < 2; run++) {
            for (const sql of initSqlBlocks(role)) await client.query(sql);
            const { rows } = await client.query(
              'select rolsuper, rolbypassrls from pg_roles where rolname = $1',
              [role],
            );
            expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: true });
            for (const table of AUTH_TABLES) {
              expect(await can(role, table, 'SELECT'), `${role} can read ${table}`).toBe(false);
              expect(await readsAs(role, table), `${role} reads ${table}`).toBe(false);
            }
            expect(await readsAs(role, appTable), `${role} reads ${appTable}`).toBe(true);
            for (const priv of ['INSERT', 'UPDATE', 'DELETE']) {
              expect(await can(role, appTable, priv), `${role} ${priv} ${appTable}`).toBe(writes);
            }
          }
        } finally {
          await client.query('ROLLBACK');
        }
      });

      it('first boot (init before the app migrates): the baseline takes the auth tables back', async () => {
        await client.query('BEGIN');
        try {
          for (const sql of initSqlBlocks(role)) await client.query(sql);
          // What the default privileges hand the role when the migration then
          // creates the auth tables.
          await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
          expect(await can(role, 'session', 'SELECT')).toBe(true);
          await client.query(baselineRevokeLoop());
          for (const table of AUTH_TABLES) {
            expect(await can(role, table, 'SELECT'), `${role} can read ${table}`).toBe(false);
          }
          expect(await can(role, appTable, 'SELECT')).toBe(true);
        } finally {
          await client.query('ROLLBACK');
        }
      });
    });
  }
});
