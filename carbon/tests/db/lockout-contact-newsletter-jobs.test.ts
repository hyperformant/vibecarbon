import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HonoVariables } from '@server/types';
import { connectTestDb, dbTestsEnabled } from './_helpers';

/**
 * The login lockout, contact, newsletter and jobs routes against a real
 * database. The lockout flow goes through the SQL functions exactly as the
 * login route calls them (bound text email, `::inet` address).
 */

const auth = vi.hoisted(() => ({ succeed: false }));

vi.mock('@server/lib/supabase', () => ({
  // The credential check is Supabase Auth's job; this suite is about what the
  // route does with the lockout functions around it.
  createAuthClient: () => ({
    auth: {
      signInWithPassword: async () =>
        auth.succeed
          ? {
              data: {
                session: {
                  access_token: 'a',
                  refresh_token: 'r',
                  expires_in: 1,
                  expires_at: 1,
                  token_type: 'bearer',
                },
                user: { id: 'u', email: 'x', app_metadata: {}, user_metadata: {} },
              },
              error: null,
            }
          : { data: { session: null, user: null }, error: { message: 'bad' } },
    },
  }),
}));
vi.mock('@server/lib/rate-limiter', () => ({
  createRateLimiter: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));
vi.mock('@server/lib/email', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));

describe.skipIf(!dbTestsEnabled)('lockout, contact, newsletter, jobs on Postgres', () => {
  let seed: pg.Client;
  const emails: string[] = [];

  function appFor(role: string | null) {
    const app = new Hono<{ Variables: HonoVariables }>();
    app.use('*', async (c, next) => {
      // biome-ignore lint/suspicious/noExplicitAny: minimal injected user
      if (role) c.set('user', { id: randomUUID(), role } as any);
      await next();
    });
    return app;
  }

  beforeAll(async () => {
    seed = await connectTestDb();
  });

  afterAll(async () => {
    if (!seed) return;
    for (const table of ['failed_login_attempts', 'newsletter_subscribers', 'contact_submissions']) {
      await seed.query(`delete from public.${table} where email = any($1::text[])`, [emails]);
    }
    await seed.end();
  });

  function newEmail() {
    const email = `db-test-${randomUUID()}@example.test`;
    emails.push(email);
    return email;
  }

  function login(app: Hono<{ Variables: HonoVariables }>, email: string) {
    return app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'pw' }),
    });
  }

  it('locks after 5 failures, and an admin unlock lets a good login through', async () => {
    const { authRoutes } = await import('@server/routes/v1/auth');
    const app = appFor(null);
    app.route('/api/v1/auth', authRoutes);
    const email = newEmail();

    // No trusted client IP in the test request: the route must still reach
    // the database with a valid inet (the bare sentinel used to fail the cast).
    auth.succeed = false;
    for (let i = 0; i < 5; i++) {
      expect((await login(app, email)).status).toBe(401);
    }
    const { rows: stored } = await seed.query(
      'select count(*)::int as n, host(min(ip_address)) as ip from public.failed_login_attempts where email = $1',
      [email]
    );
    expect(stored[0].n).toBe(5);
    expect(stored[0].ip).toBe('0.0.0.0');

    // Sixth attempt: locked, even with the right password.
    auth.succeed = true;
    const locked = await login(app, email);
    expect(locked.status).toBe(429);
    expect(await locked.json()).toMatchObject({ locked: true });

    // Locked accounts are listed for admins.
    const admin = appFor('super_admin');
    admin.route('/api/v1/auth', authRoutes);
    const listed = await admin.request('/api/v1/auth/admin/locked-accounts');
    expect(listed.status).toBe(200);
    const { lockedAccounts } = (await listed.json()) as {
      lockedAccounts: { email: string; attemptCount: number; lastAttempt: string }[];
    };
    const mine = lockedAccounts.find((a) => a.email === email);
    expect(mine?.attemptCount).toBe(5);
    expect(Number.isNaN(new Date(mine?.lastAttempt ?? '').getTime())).toBe(false);

    const unlock = await admin.request('/api/v1/auth/admin/unlock-account', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    expect(unlock.status).toBe(200);
    expect((await login(app, email)).status).toBe(200);
  });

  it('a successful login clears earlier failures below the threshold', async () => {
    const { authRoutes } = await import('@server/routes/v1/auth');
    const app = appFor(null);
    app.route('/api/v1/auth', authRoutes);
    const email = newEmail();

    auth.succeed = false;
    for (let i = 0; i < 3; i++) await login(app, email);
    auth.succeed = true;
    expect((await login(app, email)).status).toBe(200);

    const { rows } = await seed.query(
      'select count(*)::int as n from public.failed_login_attempts where email = $1',
      [email]
    );
    expect(rows[0].n).toBe(0);
  });

  it('contact: stored by the public form; listed, updated and deleted by an admin', async () => {
    const { contactRoutes } = await import('@server/routes/v1/contact');
    const { adminContactRoutes } = await import('@server/routes/v1/admin/contact');
    const email = newEmail();
    const pub = appFor(null);
    pub.route('/api/v1/contact', contactRoutes);
    const res = await pub.request('/api/v1/contact/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Ada',
        email,
        subject: 'Hello there',
        message: 'A message that is long enough.',
      }),
    });
    expect(res.status).toBe(200);

    const admin = appFor('super_admin');
    admin.route('/api/v1/admin/contact', adminContactRoutes);
    const list = await admin.request('/api/v1/admin/contact?status=unread&limit=50');
    const body = (await list.json()) as {
      submissions: { id: string; email: string; status: string; created_at: string }[];
      total: number;
    };
    const mine = body.submissions.find((s) => s.email === email);
    expect(mine?.status).toBe('unread');
    expect(mine?.created_at).toMatch(/^\d{4}-\d\d-\d\dT.*[+-]\d\d:\d\d$/);
    expect(body.total).toBeGreaterThanOrEqual(1);

    const patch = await admin.request(`/api/v1/admin/contact/${mine?.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'read' }),
    });
    expect(patch.status).toBe(200);
    const { rows } = await seed.query(
      'select status from public.contact_submissions where id = $1',
      [mine?.id]
    );
    expect(rows[0].status).toBe('read');

    const del = await admin.request(`/api/v1/admin/contact/${mine?.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const gone = await seed.query('select 1 from public.contact_submissions where id = $1', [
      mine?.id,
    ]);
    expect(gone.rowCount).toBe(0);
    const bad = await admin.request('/api/v1/admin/contact/not-a-uuid', { method: 'DELETE' });
    expect(bad.status).toBe(404);
  });

  it('newsletter: double opt-in, unsubscribe token, admin search, stats and export', async () => {
    const { newsletterRoutes } = await import('@server/routes/v1/newsletter');
    const { adminNewsletterRoutes } = await import('@server/routes/v1/admin/newsletter');
    const email = newEmail();
    const pub = appFor(null);
    pub.route('/api/v1/newsletter', newsletterRoutes);
    const subscribe = () =>
      pub.request('/api/v1/newsletter/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, name: 'Grace' }),
      });
    expect((await subscribe()).status).toBe(200);
    // A second subscribe while pending is a no-op with the same answer.
    expect((await subscribe()).status).toBe(200);

    const { rows } = await seed.query(
      'select confirmation_token, status from public.newsletter_subscribers where email = $1',
      [email]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    const token = rows[0].confirmation_token as string;

    const wrongConfirm = await pub.request(`/api/v1/newsletter/confirm?token=${randomUUID()}`);
    expect(wrongConfirm.status).toBe(400);
    const confirmed = await pub.request(`/api/v1/newsletter/confirm?token=${token}`);
    expect(confirmed.status).toBe(302);

    const admin = appFor('super_admin');
    admin.route('/api/v1/admin/newsletter', adminNewsletterRoutes);
    const found = await admin.request(
      `/api/v1/admin/newsletter?search=${encodeURIComponent(email.slice(0, 18))}&status=active`
    );
    const list = (await found.json()) as { subscribers: { email: string }[] };
    expect(list.subscribers.map((s) => s.email)).toContain(email);
    // A LIKE wildcard in the search is literal, not match-all.
    const wild = await admin.request('/api/v1/admin/newsletter?search=%25');
    expect(((await wild.json()) as { subscribers: unknown[] }).subscribers).toHaveLength(0);

    const stats = (await (await admin.request('/api/v1/admin/newsletter/stats')).json()) as {
      total: number;
      active: number;
    };
    expect(stats.active).toBeGreaterThanOrEqual(1);
    expect(stats.total).toBeGreaterThanOrEqual(stats.active);

    const csv = await (await admin.request('/api/v1/admin/newsletter/export')).text();
    expect(csv).toContain(`"${email}"`);

    // Unsubscribing needs the matching token.
    const wrong = await pub.request(
      `/api/v1/newsletter/unsubscribe?email=${encodeURIComponent(email)}&token=${randomUUID()}`
    );
    expect(wrong.status).toBe(400);
    const unsub = await pub.request(
      `/api/v1/newsletter/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`
    );
    expect(unsub.status).toBe(302);
    const after = await seed.query(
      'select status, unsubscribed_at from public.newsletter_subscribers where email = $1',
      [email]
    );
    expect(after.rows[0].status).toBe('unsubscribed');
    expect(after.rows[0].unsubscribed_at).not.toBeNull();

    // Subscribing again after unsubscribing goes back to pending.
    expect((await subscribe()).status).toBe(200);
    const again = await seed.query(
      'select status, unsubscribed_at from public.newsletter_subscribers where email = $1',
      [email]
    );
    expect(again.rows[0].status).toBe('pending');
    expect(again.rows[0].unsubscribed_at).toBeNull();
  });

  it('jobs: every triggerable job runs and is recorded; history is listed', async () => {
    const { jobsRoutes } = await import('@server/routes/v1/admin/jobs');
    const admin = appFor('super_admin');
    admin.route('/api/v1/admin/jobs', jobsRoutes);
    const names = [
      'cleanup-login-attempts',
      'cleanup-expired-notifications',
      'rollup-crawler-hits',
      'cleanup-crawler-hits',
      'cleanup-job-history',
    ];
    for (const jobName of names) {
      const res = await admin.request('/api/v1/admin/jobs/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobName }),
      });
      expect(await res.json(), jobName).toEqual({ success: true });
    }
    const hist = await admin.request(
      '/api/v1/admin/jobs/history?jobName=cleanup-login-attempts&limit=5'
    );
    const { history } = (await hist.json()) as {
      history: { job_name: string; status: string; started_at: string }[];
    };
    expect(history[0]).toMatchObject({ job_name: 'cleanup-login-attempts', status: 'succeeded' });
    expect(history[0].started_at).toMatch(/T/);

    // The listing answers from get_cron_jobs() (cron-jobs.test.ts pins its rows).
    const listed = await admin.request('/api/v1/admin/jobs');
    expect(listed.status).toBe(200);
    expect(Array.isArray(((await listed.json()) as { jobs: unknown[] }).jobs)).toBe(true);

    await seed.query(
      `delete from public.cron_job_history where result = 'Manually triggered by admin' and job_name = any($1::text[])`,
      [names]
    );
  });
});
