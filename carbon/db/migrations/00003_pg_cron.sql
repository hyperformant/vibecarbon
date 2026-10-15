-- =============================================================================
-- pg_cron: Background job scheduling via PostgreSQL
-- =============================================================================

-- Enable the pg_cron extension (available in Supabase PostgreSQL)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Grant usage to postgres role (required for Supabase)
GRANT USAGE ON SCHEMA cron TO postgres;

-- =============================================================================
-- Job execution history table (readable by super admins via API)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.cron_job_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', -- running, succeeded, failed
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  result TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cron_job_history_job_name ON public.cron_job_history (job_name);
CREATE INDEX IF NOT EXISTS idx_cron_job_history_started_at ON public.cron_job_history (started_at DESC);

ALTER TABLE public.cron_job_history ENABLE ROW LEVEL SECURITY;

-- Only super admins can read job history
DROP POLICY IF EXISTS "Super admins can read job history" ON public.cron_job_history;
CREATE POLICY "Super admins can read job history"
  ON public.cron_job_history FOR SELECT
  USING (public.is_super_admin());

-- =============================================================================
-- Helper function to log job execution
-- =============================================================================

CREATE OR REPLACE FUNCTION public.log_cron_job(
  p_job_name TEXT,
  p_status TEXT DEFAULT 'succeeded',
  p_result TEXT DEFAULT NULL,
  p_error TEXT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
-- Pin search_path so this SECURITY DEFINER function can't be hijacked by a
-- malicious object in an attacker-controlled schema. All refs below are already
-- schema-qualified (public.cron_job_history), so an empty path is safe.
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.cron_job_history (job_name, status, finished_at, result, error)
  VALUES (p_job_name, p_status, now(), p_result, p_error);
END;
$$;

-- This SECURITY DEFINER function bypasses RLS on cron_job_history (super-admin
-- read-only). The pg_cron jobs run it as `postgres` and the admin Jobs route
-- calls it through adminDb, so end users must NOT reach it: without this
-- REVOKE, a user request (app_user, which gets EXECUTE on new functions by
-- default) could inject fabricated "system" rows the admin panel presents as
-- trusted job output (log spoofing) and grow the table unbounded (storage
-- DoS; pruned only weekly). Matches the failed-login lockdown pattern.
REVOKE EXECUTE ON FUNCTION public.log_cron_job(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, app_user;

-- =============================================================================
-- Scheduled job list for the admin Jobs page
-- =============================================================================

-- The admin Jobs route (server, connection role) lists the scheduled jobs
-- from here, including jobs that have not run yet. Only the name, schedule
-- and active flag: the job's SQL (`command`) and its owner stay in cron.job.
CREATE OR REPLACE FUNCTION public.get_cron_jobs()
RETURNS TABLE (jobname TEXT, schedule TEXT, active BOOLEAN)
LANGUAGE sql
STABLE
SECURITY DEFINER
-- Same hijack guard as log_cron_job: every reference is schema-qualified.
SET search_path = ''
AS $$
  SELECT j.jobname::text, j.schedule::text, j.active
  FROM cron.job j
  ORDER BY j.jobname;
$$;

-- Server-only, like log_cron_job: no end-user role may enumerate the jobs.
REVOKE EXECUTE ON FUNCTION public.get_cron_jobs() FROM PUBLIC, app_user;

-- =============================================================================
-- Schedule default jobs
-- =============================================================================

-- 1. Clean up old failed login attempts (every 6 hours)
-- Replaces the Node.js setInterval in server/index.ts
SELECT cron.schedule(
  'cleanup-login-attempts',
  '0 */6 * * *',  -- every 6 hours
  $$
  DO $body$
  DECLARE
    deleted_count INTEGER;
  BEGIN
    DELETE FROM public.failed_login_attempts
    WHERE attempted_at < now() - interval '24 hours';
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    PERFORM public.log_cron_job('cleanup-login-attempts', 'succeeded',
      'Deleted ' || deleted_count || ' old login attempts');
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.log_cron_job('cleanup-login-attempts', 'failed', NULL, SQLERRM);
  END $body$;
  $$
);

-- 2. Clean up expired notifications (daily at 3am)
SELECT cron.schedule(
  'cleanup-expired-notifications',
  '0 3 * * *',  -- daily at 3:00 AM
  $$
  DO $body$
  DECLARE
    deleted_count INTEGER;
  BEGIN
    DELETE FROM public.notifications
    WHERE ends_at IS NOT NULL AND ends_at < now();
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    PERFORM public.log_cron_job('cleanup-expired-notifications', 'succeeded',
      'Deleted ' || deleted_count || ' expired notifications');
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.log_cron_job('cleanup-expired-notifications', 'failed', NULL, SQLERRM);
  END $body$;
  $$
);

-- 3. Clean up old cron job history (weekly, keep last 30 days)
SELECT cron.schedule(
  'cleanup-job-history',
  '0 4 * * 0',  -- Sundays at 4:00 AM
  $$
  DO $body$
  DECLARE
    deleted_count INTEGER;
  BEGIN
    DELETE FROM public.cron_job_history
    WHERE created_at < now() - interval '30 days';
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    PERFORM public.log_cron_job('cleanup-job-history', 'succeeded',
      'Deleted ' || deleted_count || ' old history entries');
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.log_cron_job('cleanup-job-history', 'failed', NULL, SQLERRM);
  END $body$;
  $$
);
