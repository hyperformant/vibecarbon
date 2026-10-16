import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDb, dbTestsEnabled } from './_helpers';

/**
 * volumes/db/metabase-init.sh reruns on every start (scripts/docker-up.js) and
 * grants metabase SELECT on every public table. Without its trailing revoke
 * that re-granted the auth tables db/migrations/0002_baseline_post.sql locks
 * down (password hashes, session and OAuth tokens, TOTP secrets) on every
 * start after the first. This runs the script's own SQL, twice, inside a
 * transaction that is rolled back.
 */
const AUTH_TABLES = ['user', 'session', 'account', 'verification', 'two_factor'];

/** The script's heredoc bodies, minus what only psql can run or what needs the metabase database. */
function initSqlBlocks(): string[] {
  const script = readFileSync(join(process.cwd(), 'volumes', 'db', 'metabase-init.sh'), 'utf8');
  const blocks = [...script.matchAll(/<<'?EOSQL'?\n([\s\S]*?)\nEOSQL/g)].map((m) => m[1]);
  return blocks.map((sql) =>
    sql
      .replaceAll('${POSTGRES_PASSWORD}', 'test-only-password')
      // `SELECT 'CREATE DATABASE ...' WHERE ... \gexec` is a psql meta-command,
      // and the database grant needs that database: neither is under test.
      .replace(/SELECT 'CREATE DATABASE[\s\S]*?\\gexec\n/, '')
      .replace(/^GRANT ALL PRIVILEGES ON DATABASE metabase TO metabase;\n/m, ''),
  );
}

describe.skipIf(!dbTestsEnabled)('metabase-init.sh grants', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = await connectTestDb();
  });

  afterAll(async () => {
    await client?.end();
  });

  const canSelect = async (table: string) =>
    (
      await client.query("select has_table_privilege('metabase', $1, 'SELECT') as ok", [
        `public.${JSON.stringify(table)}`,
      ])
    ).rows[0].ok as boolean;

  it('the script has the three blocks this test runs (role, grants, auth revoke)', () => {
    const blocks = initSqlBlocks();
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toContain('GRANT SELECT ON ALL TABLES IN SCHEMA public TO metabase');
    expect(blocks[2]).toContain('REVOKE ALL ON TABLE public.%I FROM metabase');
  });

  it('without the trailing revoke, the blanket grant reaches the auth tables (the gap)', async () => {
    const [role, grants] = initSqlBlocks();
    await client.query('BEGIN');
    try {
      await client.query(role);
      await client.query(grants);
      expect(await canSelect('user')).toBe(true);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('after every run, metabase reads the app tables but none of the auth tables', async () => {
    const blocks = initSqlBlocks();
    const { rows } = await client.query(
      "select tablename from pg_tables where schemaname = 'public' and tablename <> all($1) order by 1 limit 1",
      [AUTH_TABLES],
    );
    const appTable = rows[0]?.tablename as string;
    expect(appTable).toBeTruthy();
    await client.query('BEGIN');
    try {
      // Twice: the script reruns on every start.
      for (let run = 0; run < 2; run++) {
        for (const sql of blocks) await client.query(sql);
        for (const table of AUTH_TABLES) {
          expect(await canSelect(table), `metabase can read ${table}`).toBe(false);
        }
        expect(await canSelect(appTable)).toBe(true);
      }
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
