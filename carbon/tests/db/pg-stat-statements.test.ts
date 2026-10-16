import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDb, dbTestsEnabled } from './_helpers';

/**
 * The db image preloads pg_cron and pg_stat_statements
 * (docker/postgres-walg/postgresql.conf), and the baseline creates both
 * extensions (db/migrations/0000_baseline_pre.sql). pg_stat_statements is the
 * data behind "which query is slow": without the preload its view errors, and
 * without the extension it does not exist.
 */
describe.skipIf(!dbTestsEnabled)('query statistics and slow-query logging', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = await connectTestDb();
  });

  afterAll(async () => {
    await client?.end();
  });

  const show = async (setting: string) =>
    (await client.query(`SHOW ${setting}`)).rows[0][setting] as string;

  it('the server preloads pg_cron and pg_stat_statements', async () => {
    const libs = (await show('shared_preload_libraries')).split(',').map((l) => l.trim());
    expect(libs).toEqual(expect.arrayContaining(['pg_cron', 'pg_stat_statements']));
  });

  it('the baseline installs pg_stat_statements, and its view answers', async () => {
    const { rows } = await client.query(
      "select extname from pg_extension where extname in ('pg_cron', 'pg_stat_statements') order by 1",
    );
    expect(rows.map((r) => r.extname)).toEqual(['pg_cron', 'pg_stat_statements']);
    const { rows: stats } = await client.query(
      'select count(*)::int as n from pg_stat_statements where calls > 0',
    );
    expect(stats[0].n).toBeGreaterThan(0);
  });

  it('is for the operator only: no end-user role can read it', async () => {
    const { rows } = await client.query(
      `select has_table_privilege('app_user', 'public.pg_stat_statements', 'SELECT') as stats,
              has_table_privilege('app_user', 'public.pg_stat_statements_info', 'SELECT') as info`,
    );
    expect(rows[0]).toEqual({ stats: false, info: false });
  });

  it('keeps utility statements out of it, and logs slow statements and lock waits', async () => {
    expect(await show('pg_stat_statements.max')).toBe('1000');
    expect(await show('pg_stat_statements.track_utility')).toBe('off');
    expect(await show('log_min_duration_statement')).toBe('1s');
    expect(await show('log_lock_waits')).toBe('on');
  });
});
