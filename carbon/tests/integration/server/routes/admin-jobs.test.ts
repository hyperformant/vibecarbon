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
vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

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
