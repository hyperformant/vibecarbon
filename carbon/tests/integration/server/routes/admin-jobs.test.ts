import type { User } from '@supabase/supabase-js';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HonoVariables } from '@server/types';
import { queryChain } from '../../../_helpers/drizzle-mock';

const db = vi.hoisted(() => ({
  execute: vi.fn(),
  inserted: [] as unknown[],
  selectRows: [] as unknown[],
}));

vi.mock('@server/db/client', () => ({
  adminDb: {
    execute: (...a: unknown[]) => db.execute(...a),
    insert: () => ({
      values: (v: unknown) => {
        db.inserted.push(v);
        return Promise.resolve();
      },
    }),
    select: () => queryChain(() => db.selectRows),
    delete: () => queryChain(() => undefined),
  },
}));
const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@server/lib/logger', () => ({ logger }));

const { jobsRoutes } = await import('@server/routes/v1/admin/jobs');

const SECRET = 'job-param-secret@example.test';

function adminApp() {
  const app = new Hono<{ Variables: HonoVariables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'u1', app_metadata: { role: 'super_admin' } } as unknown as User);
    await next();
  });
  app.route('/api/v1/admin/jobs', jobsRoutes);
  return app;
}

beforeEach(() => {
  db.execute.mockReset();
  logger.error.mockReset();
  db.inserted = [];
  db.selectRows = [];
});

describe('POST /api/v1/admin/jobs/trigger: a failed job', () => {
  it('stores the Postgres message in cron_job_history, never the SQL or params', async () => {
    const cause = Object.assign(new Error('permission denied for function cleanup'), {
      severity: 'ERROR',
      code: '42501',
      detail: undefined,
    });
    db.execute.mockRejectedValue(
      new DrizzleQueryError('select public.cleanup_old_login_attempts($1)', [SECRET], cause)
    );
    const res = await adminApp().request('/api/v1/admin/jobs/trigger', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobName: 'cleanup-login-attempts' }),
    });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(SECRET);
    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0]).toMatchObject({
      status: 'failed',
      error: 'permission denied for function cleanup',
    });
    expect(JSON.stringify(db.inserted)).not.toContain(SECRET);
  });
});

const historyRow = {
  id: 'h1',
  jobName: 'cleanup-login-attempts',
  status: 'succeeded',
  startedAt: '2026-10-13 03:00:00+00',
  finishedAt: '2026-10-13 03:00:01+00',
  durationMs: 1000,
  result: 'Deleted 0 old login attempts',
  error: null,
  createdAt: '2026-10-13 03:00:01+00',
};

describe('GET /api/v1/admin/jobs', () => {
  it('lists every scheduled job, with run state from history', async () => {
    db.selectRows = [historyRow];
    db.execute.mockResolvedValue({
      rows: [
        { jobname: 'cleanup-job-history', schedule: '0 4 * * 0', active: true },
        { jobname: 'cleanup-login-attempts', schedule: '0 */6 * * *', active: true },
      ],
    });
    const res = await adminApp().request('/api/v1/admin/jobs');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: Record<string, unknown>[]; history: unknown[] };
    expect(body.jobs).toEqual([
      {
        name: 'cleanup-job-history',
        schedule: '0 4 * * 0',
        active: true,
        lastRun: null,
        lastStatus: 'unknown',
        lastResult: null,
        lastError: null,
        runCount: 0,
      },
      expect.objectContaining({
        name: 'cleanup-login-attempts',
        schedule: '0 */6 * * *',
        lastStatus: 'succeeded',
        runCount: 1,
      }),
    ]);
    expect(body.history).toHaveLength(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs a failed schedule read (params stripped) and falls back to history', async () => {
    db.selectRows = [historyRow];
    const cause = Object.assign(new Error('function public.get_cron_jobs() does not exist'), {
      severity: 'ERROR',
      code: '42883',
      detail: undefined,
    });
    db.execute.mockRejectedValue(
      new DrizzleQueryError('select jobname from public.get_cron_jobs()', [SECRET], cause)
    );
    const res = await adminApp().request('/api/v1/admin/jobs');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: { name: string; schedule: unknown }[] };
    expect(body.jobs).toEqual([
      expect.objectContaining({ name: 'cleanup-login-attempts', schedule: null }),
    ]);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toMatchObject({ err: { code: '42883' } });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(SECRET);
  });
});
