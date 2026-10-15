import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HonoVariables } from '@server/types';
import { asUser, connectTestDb, dbTestsEnabled } from './_helpers';

/**
 * public.get_cron_jobs() (migration 00003): the admin Jobs page's schedule.
 * Server-only, so no end-user role may call it.
 */
describe.skipIf(!dbTestsEnabled)('get_cron_jobs()', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = await connectTestDb();
  });

  afterAll(async () => {
    await client?.end();
  });

  it('returns the scheduled jobs: name, schedule and active flag only', async () => {
    const { rows, fields } = await client.query('select * from public.get_cron_jobs()');
    expect(fields.map((f) => f.name)).toEqual(['jobname', 'schedule', 'active']);
    const names = rows.map((r) => r.jobname);
    for (const job of [
      'cleanup-login-attempts',
      'cleanup-expired-notifications',
      'cleanup-job-history',
      'rollup-crawler-hits',
      'cleanup-crawler-hits',
    ]) {
      expect(names).toContain(job);
    }
    expect(rows.find((r) => r.jobname === 'cleanup-login-attempts')).toEqual({
      jobname: 'cleanup-login-attempts',
      schedule: '0 */6 * * *',
      active: true,
    });
  });

  it('the migrations schedule exactly the five template jobs, and get_cron_jobs() lists each one', async () => {
    const { rows: count } = await client.query('select count(*)::int as n from cron.job');
    expect(count[0].n).toBe(5);
    const { rows: scheduled } = await client.query('select jobname from cron.job order by jobname');
    const { rows: listed } = await client.query('select jobname from public.get_cron_jobs()');
    expect(listed.map((r) => r.jobname)).toEqual(scheduled.map((r) => r.jobname));
  });

  it('is pinned to an empty search_path', async () => {
    const { rows } = await client.query(
      `select p.prosecdef, p.proconfig from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'get_cron_jobs'`
    );
    expect(rows).toEqual([{ prosecdef: true, proconfig: ['search_path=""'] }]);
  });

  it('app_user cannot execute it', async () => {
    const { rows } = await client.query(
      "select has_function_privilege('app_user', 'public.get_cron_jobs()', 'execute') as can"
    );
    expect(rows[0].can).toBe(false);
  });

  it('a user request (app_user) is refused', async () => {
    await expect(
      asUser(client, randomUUID(), (c) => c.query('select * from public.get_cron_jobs()'))
    ).rejects.toThrow(/permission denied/);
  });

  it('the admin Jobs route lists scheduled jobs with their schedule', async () => {
    const { jobsRoutes } = await import('@server/routes/v1/admin/jobs');
    const app = new Hono<{ Variables: HonoVariables }>();
    app.use('*', async (c, next) => {
      // biome-ignore lint/suspicious/noExplicitAny: minimal injected user
      c.set('user', { id: randomUUID(), role: 'super_admin' } as any);
      await next();
    });
    app.route('/api/v1/admin/jobs', jobsRoutes);
    const res = await app.request('/api/v1/admin/jobs');
    expect(res.status).toBe(200);
    const { jobs } = (await res.json()) as { jobs: { name: string; schedule: string | null }[] };
    expect(jobs.find((j) => j.name === 'rollup-crawler-hits')?.schedule).toBe('15 2 * * *');
  });
});
