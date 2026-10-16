import { and, desc, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { adminDb } from '../../../db/client';
import { dbErrorForLog, dbErrorMessage } from '../../../db/errors';
import { crawlerHits, crawlerHitsDaily, cronJobHistory, notifications } from '../../../db/schema';
import { isoTimestamp } from '../../../db/values';
import { sanitizeError } from '../../../lib/errors';
import { logger } from '../../../lib/logger';
import { requireSuperAdmin } from '../../../middleware/requireSuperAdmin';
import type { HonoVariables } from '../../../types';

type HistoryRow = typeof cronJobHistory.$inferSelect;

/** A row of public.get_cron_jobs(). */
type CronJobRow = { jobname: string; schedule: string; active: boolean };

/** A history row as the API has always sent it (snake_case, ISO timestamps). */
function historyJson(r: HistoryRow) {
  return {
    id: r.id,
    job_name: r.jobName,
    status: r.status,
    started_at: isoTimestamp(r.startedAt),
    finished_at: r.finishedAt === null ? null : isoTimestamp(r.finishedAt),
    duration_ms: r.durationMs,
    result: r.result,
    error: r.error,
    created_at: isoTimestamp(r.createdAt),
  };
}

const jobsRoutes = new Hono<{ Variables: HonoVariables }>();

// Require super admin (plus a verified second factor while MFA is on) for all
// job management endpoints; see requireSuperAdmin.
jobsRoutes.use('*', requireSuperAdmin);

/**
 * List the scheduled jobs with their latest outcome.
 *
 * The schedule comes from pg_cron through public.get_cron_jobs() (the
 * baseline migration), so a job shows up before its first run. Run state
 * comes from the latest 100 history rows. If the schedule cannot be read, the error is
 * logged and the list falls back to the jobs seen in history.
 */
jobsRoutes.get('/', async (c) => {
  try {
    const history = (
      await adminDb.select().from(cronJobHistory).orderBy(desc(cronJobHistory.startedAt)).limit(100)
    ).map(historyJson);

    let scheduled: CronJobRow[] = [];
    try {
      scheduled = (
        await adminDb.execute<CronJobRow>(
          sql`select jobname, schedule, active from public.get_cron_jobs()`
        )
      ).rows;
    } catch (err) {
      logger.error(
        { err: dbErrorForLog(err) },
        'Could not read the pg_cron schedule; listing jobs from history only'
      );
    }

    const names = [
      ...new Set([...scheduled.map((j) => j.jobname), ...history.map((h) => h.job_name)]),
    ];
    const jobs = names.map((name) => {
      const runs = history.filter((h) => h.job_name === name);
      const latest = runs[0];
      const cron = scheduled.find((j) => j.jobname === name);
      return {
        name,
        schedule: cron?.schedule ?? null,
        active: cron?.active ?? null,
        lastRun: latest?.started_at ?? null,
        lastStatus: latest?.status ?? 'unknown',
        lastResult: latest?.result ?? null,
        lastError: latest?.error ?? null,
        runCount: runs.length,
      };
    });

    return c.json({ jobs, history });
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
    const rows = await adminDb
      .select()
      .from(cronJobHistory)
      .where(jobName ? eq(cronJobHistory.jobName, jobName) : undefined)
      .orderBy(desc(cronJobHistory.startedAt))
      .limit(Number.isFinite(limit) && limit > 0 ? limit : 50);

    return c.json({ history: rows.map(historyJson) });
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

    // Run the job and capture its failure, so a permission-denied function or
    // a blocked DELETE is written to cron_job_history as 'failed' and reported
    // to the admin, rather than recorded as a success.
    let jobError: unknown = null;

    try {
      if (body.jobName === 'cleanup-login-attempts') {
        await adminDb.execute(sql`select public.cleanup_old_login_attempts(${24}::integer)`);
      } else if (body.jobName === 'cleanup-expired-notifications') {
        await adminDb
          .delete(notifications)
          .where(
            and(isNotNull(notifications.endsAt), lt(notifications.endsAt, new Date().toISOString()))
          );
      } else if (body.jobName === 'cleanup-job-history') {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        await adminDb.delete(cronJobHistory).where(lt(cronJobHistory.createdAt, thirtyDaysAgo));
      } else if (body.jobName === 'rollup-crawler-hits') {
        // The same idempotent SECURITY DEFINER function the nightly cron job
        // runs (db/migrations/0002_baseline_post.sql). Null p_day = yesterday (UTC).
        await adminDb.execute(sql`select public.rollup_crawler_hits(${null}::date)`);
      } else if (body.jobName === 'cleanup-crawler-hits') {
        // Mirrors the scheduled cleanup-crawler-hits job: prune raw hits at 90 days AND the
        // rollup at 400, so a manual run does the same work as the nightly one.
        const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
        const fourHundredDaysAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
        await adminDb.delete(crawlerHits).where(lt(crawlerHits.hitAt, ninetyDaysAgo));
        await adminDb.delete(crawlerHitsDaily).where(lt(crawlerHitsDaily.day, fourHundredDaysAgo));
      }
    } catch (err) {
      jobError = err;
    }

    if (jobError) {
      // Record the real outcome, then surface it. An admin who clicks "run now"
      // must not be told it worked when it did not.
      await adminDb.insert(cronJobHistory).values({
        jobName: body.jobName,
        status: 'failed',
        finishedAt: new Date().toISOString(),
        result: 'Manually triggered by admin',
        // The Postgres message, never Drizzle's (it carries the SQL and params).
        error:
          dbErrorMessage(jobError) ??
          (jobError instanceof Error ? jobError.message : 'Unknown error'),
      });
      return c.json({ error: sanitizeError(jobError, 'Failed to trigger job') }, 500);
    }

    // Log the manual trigger
    await adminDb.insert(cronJobHistory).values({
      jobName: body.jobName,
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
      result: 'Manually triggered by admin',
    });

    return c.json({ success: true });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to trigger job') }, 500);
  }
});

export { jobsRoutes };
