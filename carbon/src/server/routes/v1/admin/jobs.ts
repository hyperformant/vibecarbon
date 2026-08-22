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
    ];

    if (!allowedJobs.includes(body.jobName)) {
      return c.json({ error: 'Unknown job name' }, 400);
    }

    // Execute the job's SQL directly
    if (body.jobName === 'cleanup-login-attempts') {
      await adminDb.rpc('cleanup_old_login_attempts', { p_retention_hours: 24 });
    } else if (body.jobName === 'cleanup-expired-notifications') {
      await adminDb
        .from('notifications')
        .delete()
        .not('expires_at', 'is', null)
        .lt('expires_at', new Date().toISOString());
    } else if (body.jobName === 'cleanup-job-history') {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      await adminDb.from('cron_job_history').delete().lt('created_at', thirtyDaysAgo);
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
