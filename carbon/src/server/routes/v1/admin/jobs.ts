import type { SupabaseClient } from '@supabase/supabase-js';
import { Hono } from 'hono';
import { z } from 'zod';
import { sanitizeError } from '../../../lib/errors';
import { supabaseAdmin } from '../../../lib/supabase';
import { requireSuperAdmin } from '../../../middleware/requireSuperAdmin';
import type { HonoVariables } from '../../../types';

// biome-ignore lint/suspicious/noExplicitAny: Tables not yet in generated Database types
const adminDb = supabaseAdmin as SupabaseClient<any>;

const jobsRoutes = new Hono<{ Variables: HonoVariables }>();

// Require super admin for all job management endpoints. Uses the JWT-based
// role check (app_metadata.role) — the previous `adminDb.from('auth.users')`
// query errored because the auth schema isn't exposed to PostgREST, which made
// this guard fail closed (403 for everyone) and broke the admin panels.
jobsRoutes.use('*', requireSuperAdmin);

/**
 * List all scheduled cron jobs
 */
jobsRoutes.get('/', async (c) => {
  try {
    // Query pg_cron's job table directly
    const { data: jobs, error } = await adminDb.rpc('get_cron_jobs');

    if (error) {
      // Fallback: query cron.job directly via raw SQL isn't available via RPC,
      // so we return the job history as a summary instead
      const { data: history, error: historyError } = await adminDb
        .from('cron_job_history')
        .select('job_name, status, started_at, finished_at, duration_ms, result, error')
        .order('started_at', { ascending: false })
        .limit(100);

      if (historyError) {
        return c.json({ error: sanitizeError(historyError, 'Failed to fetch jobs') }, 500);
      }

      // Derive job list from history
      const jobNames = [...new Set((history || []).map((h: { job_name: string }) => h.job_name))];
      const jobSummaries = jobNames.map((name) => {
        const jobHistory = (history || []).filter((h: { job_name: string }) => h.job_name === name);
        const latest = jobHistory[0] as
          | { status: string; started_at: string; result: string | null; error: string | null }
          | undefined;
        return {
          name,
          lastRun: latest?.started_at ?? null,
          lastStatus: latest?.status ?? 'unknown',
          lastResult: latest?.result ?? null,
          lastError: latest?.error ?? null,
          runCount: jobHistory.length,
        };
      });

      return c.json({ jobs: jobSummaries, history: history || [] });
    }

    return c.json({ jobs: jobs || [], history: [] });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to fetch jobs') }, 500);
  }
});

/**
 * Get job execution history
 */
jobsRoutes.get('/history', async (c) => {
  const jobName = c.req.query('jobName');
  const limit = Math.min(Number(c.req.query('limit') || '50'), 200);

  try {
    let query = adminDb
      .from('cron_job_history')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(limit);

    if (jobName) {
      query = query.eq('job_name', jobName);
    }

    const { data, error } = await query;

    if (error) {
      return c.json({ error: sanitizeError(error, 'Failed to fetch job history') }, 500);
    }

    return c.json({ history: data || [] });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to fetch job history') }, 500);
  }
});

/**
 * Manually trigger a job (run the cleanup function immediately)
 */
const triggerSchema = z.object({
  jobName: z.string().min(1),
});

jobsRoutes.post('/trigger', async (c) => {
  let body: z.infer<typeof triggerSchema>;
  try {
    const rawBody = await c.req.json();
    const result = triggerSchema.safeParse(rawBody);
    if (!result.success) {
      return c.json({ error: result.error.issues.map((e) => e.message).join(', ') }, 400);
    }
    body = result.data;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  try {
    // Only allow triggering known safe jobs
    const allowedJobs = [
      'cleanup-login-attempts',
      'cleanup-expired-notifications',
      'cleanup-job-history',
      'rollup-crawler-hits',
      'cleanup-crawler-hits',
    ];

    if (!allowedJobs.includes(body.jobName)) {
      return c.json({ error: 'Unknown job name' }, 400);
    }

    // Execute the job's SQL directly.
    //
    // supabase-js RESOLVES with `{ error }` instead of throwing, so every branch
    // must capture it. Without this the `await` swallows the failure, the catch
    // below never fires, and a permission-denied RPC or a blocked DELETE gets
    // written to cron_job_history as 'succeeded' and reported to the admin as a
    // successful run — the job silently never happens.
    let jobError: unknown = null;

    if (body.jobName === 'cleanup-login-attempts') {
      jobError = (await adminDb.rpc('cleanup_old_login_attempts', { p_retention_hours: 24 })).error;
    } else if (body.jobName === 'cleanup-expired-notifications') {
      jobError = (
        await adminDb
          .from('notifications')
          .delete()
          .not('expires_at', 'is', null)
          .lt('expires_at', new Date().toISOString())
      ).error;
    } else if (body.jobName === 'cleanup-job-history') {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      jobError = (await adminDb.from('cron_job_history').delete().lt('created_at', thirtyDaysAgo))
        .error;
    } else if (body.jobName === 'rollup-crawler-hits') {
      // Aggregation can't be expressed through PostgREST — the same idempotent
      // SECURITY DEFINER function the nightly cron job runs (migration 00008).
      // Null p_day = yesterday (UTC).
      jobError = (await adminDb.rpc('rollup_crawler_hits', { p_day: null })).error;
    } else if (body.jobName === 'cleanup-crawler-hits') {
      // Mirrors the scheduled job in 00008: prune raw hits at 90 days AND the
      // rollup at 400, so a manual run does the same work as the nightly one.
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const fourHundredDaysAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const rawResult = await adminDb.from('crawler_hits').delete().lt('hit_at', ninetyDaysAgo);
      const dailyResult = await adminDb
        .from('crawler_hits_daily')
        .delete()
        .lt('day', fourHundredDaysAgo);
      jobError = rawResult.error ?? dailyResult.error;
    }

    if (jobError) {
      // Record the real outcome, then surface it. An admin who clicks "run now"
      // must not be told it worked when it did not.
      await adminDb.from('cron_job_history').insert({
        job_name: body.jobName,
        status: 'failed',
        finished_at: new Date().toISOString(),
        result: 'Manually triggered by admin',
        error:
          typeof jobError === 'object' && jobError !== null && 'message' in jobError
            ? String((jobError as { message: unknown }).message)
            : 'Unknown error',
      });
      return c.json({ error: sanitizeError(jobError, 'Failed to trigger job') }, 500);
    }

    // Log the manual trigger
    await adminDb.from('cron_job_history').insert({
      job_name: body.jobName,
      status: 'succeeded',
      finished_at: new Date().toISOString(),
      result: 'Manually triggered by admin',
    });

    return c.json({ success: true });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to trigger job') }, 500);
  }
});

export { jobsRoutes };
