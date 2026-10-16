import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, connectTestDb, dbTestsEnabled } from './_helpers';

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
      'select count(*)::int as n from monitoring.pg_stat_statements where calls > 0',
    );
    expect(stats[0].n).toBeGreaterThan(0);
  });

  it('lives in the monitoring schema, which no role but the owner may use', async () => {
    const { rows } = await client.query(
      `select n.nspname as schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace
        where e.extname = 'pg_stat_statements'`,
    );
    expect(rows[0].schema).toBe('monitoring');
    const { rows: users } = await client.query(
      `select r.rolname from pg_roles r
        where not r.rolsuper and r.rolname not like 'pg\\_%'
          and has_schema_privilege(r.rolname, 'monitoring', 'USAGE')`,
    );
    expect(users).toEqual([]);
  });

  it('a user request (app_user) can read neither the view nor the function behind it', async () => {
    for (const sql of [
      'select count(*) from monitoring.pg_stat_statements',
      'select count(*) from monitoring.pg_stat_statements(true)',
      'select * from monitoring.pg_stat_statements_info()',
    ]) {
      await expect(
        asUser(client, null, (c) => c.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied for schema monitoring/);
    }
  });

  it('keeps utility statements out of it, and logs slow statements and lock waits', async () => {
    expect(await show('pg_stat_statements.max')).toBe('1000');
    expect(await show('pg_stat_statements.track_utility')).toBe('off');
    expect(await show('log_min_duration_statement')).toBe('1s');
    expect(await show('log_lock_waits')).toBe('on');
  });

  it('never logs bind parameters, with a slow statement or a failing one', async () => {
    // The app's values (session and verification tokens, TOTP secrets) travel
    // as bind parameters; a slow or failing statement must log none of them.
    expect(await show('log_parameter_max_length')).toBe('0');
    expect(await show('log_parameter_max_length_on_error')).toBe('0');
  });
});
