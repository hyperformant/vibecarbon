-- Baseline, part 3 of 3: what needs the tables from 0001.
--
-- Custom SQL (drizzle-kit cannot model it): the auth-table lockdown, the
-- server-only functions and their revokes, the updated_at triggers, the
-- pg_cron schedules and the app_settings rows the app reads.

-- ============================================================================
-- AUTH TABLES: SERVER-ONLY
-- ============================================================================
-- "user", session, account, verification and two_factor hold password
-- hashes, session tokens, OAuth tokens and TOTP secrets. RLS is enabled with
-- no policies (schema.ts); on top of that, revoke every role that is neither
-- a superuser nor RLS-bypass, including what the default privileges in 0000
-- just gave app_user. Role-agnostic on purpose: the loop also catches roles
-- an optional service creates (metabase gets default SELECT on public
-- tables), so only the owner and the connection role behind adminDb can read
-- them. Postgres' predefined pg_* roles are operator grants and are left
-- alone.
REVOKE ALL ON TABLE "user", session, account, verification, two_factor FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  r TEXT;
BEGIN
  FOR r IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE NOT rolsuper AND NOT rolbypassrls AND rolname NOT LIKE 'pg\_%'
  LOOP
    EXECUTE format(
      'REVOKE ALL ON TABLE public."user", public.session, public.account, public.verification, public.two_factor FROM %I',
      r
    );
  END LOOP;
END
$$;
--> statement-breakpoint

-- ============================================================================
-- UPDATED_AT TRIGGER FUNCTION (used by multiple tables)
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- ============================================================================
-- ACCOUNT LOCKOUT FUNCTIONS (server-only)
-- ============================================================================

-- Check if an account is locked due to too many failed attempts
CREATE OR REPLACE FUNCTION check_account_lockout(
  p_email TEXT,
  p_ip_address INET,
  p_max_attempts INTEGER DEFAULT 5,
  p_lockout_minutes INTEGER DEFAULT 15
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
  attempt_count INTEGER;
  oldest_relevant TIMESTAMPTZ;
  minutes_remaining INTEGER;
BEGIN
  SELECT COUNT(*), MIN(attempted_at)
  INTO attempt_count, oldest_relevant
  FROM public.failed_login_attempts
  WHERE email = LOWER(p_email)
    AND ip_address = p_ip_address
    AND attempted_at > NOW() - (p_lockout_minutes || ' minutes')::INTERVAL;

  IF attempt_count >= p_max_attempts THEN
    minutes_remaining := GREATEST(
      0,
      p_lockout_minutes - EXTRACT(EPOCH FROM (NOW() - oldest_relevant))::INTEGER / 60
    );
    RETURN jsonb_build_object('locked', true, 'remaining_minutes', minutes_remaining);
  END IF;

  RETURN jsonb_build_object('locked', false, 'remaining_minutes', 0);
END;
$$;
--> statement-breakpoint

-- Record a failed login attempt
CREATE OR REPLACE FUNCTION record_failed_login(
  p_email TEXT,
  p_ip_address INET
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO public.failed_login_attempts (email, ip_address)
  VALUES (LOWER(p_email), p_ip_address);
$$;
--> statement-breakpoint

-- Clear failed login attempts on successful login
CREATE OR REPLACE FUNCTION clear_failed_logins(
  p_email TEXT,
  p_ip_address INET
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  DELETE FROM public.failed_login_attempts
  WHERE email = LOWER(p_email) AND ip_address = p_ip_address;
$$;
--> statement-breakpoint

-- Admin function to unlock an account
CREATE OR REPLACE FUNCTION admin_unlock_account(p_email TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  DELETE FROM public.failed_login_attempts WHERE email = LOWER(p_email);
$$;
--> statement-breakpoint

-- Cleanup old failed login attempts
CREATE OR REPLACE FUNCTION cleanup_old_login_attempts(
  p_retention_hours INTEGER DEFAULT 24
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.failed_login_attempts
  WHERE attempted_at < NOW() - (p_retention_hours || ' hours')::INTERVAL;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
--> statement-breakpoint

-- Get lockout status for admin view
CREATE OR REPLACE FUNCTION get_locked_accounts(
  p_max_attempts INTEGER DEFAULT 5,
  p_lockout_minutes INTEGER DEFAULT 15
)
RETURNS TABLE (
  email TEXT,
  attempt_count BIGINT,
  first_attempt TIMESTAMPTZ,
  last_attempt TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT
    email,
    COUNT(*) as attempt_count,
    MIN(attempted_at) as first_attempt,
    MAX(attempted_at) as last_attempt
  FROM public.failed_login_attempts
  WHERE attempted_at > NOW() - (p_lockout_minutes || ' minutes')::INTERVAL
  GROUP BY email
  HAVING COUNT(*) >= p_max_attempts
  ORDER BY last_attempt DESC;
$$;
--> statement-breakpoint

-- These functions are called server-side only (adminDb, which bypasses RLS).
-- Revoke execution from the request role (app_user) and PUBLIC, so only the
-- owner and the connection role behind adminDb can run them.
REVOKE EXECUTE ON FUNCTION check_account_lockout(TEXT, INET, INTEGER, INTEGER) FROM PUBLIC, app_user;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION record_failed_login(TEXT, INET) FROM PUBLIC, app_user;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION clear_failed_logins(TEXT, INET) FROM PUBLIC, app_user;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION admin_unlock_account(TEXT) FROM PUBLIC, app_user;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION cleanup_old_login_attempts(INTEGER) FROM PUBLIC, app_user;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION get_locked_accounts(INTEGER, INTEGER) FROM PUBLIC, app_user;
--> statement-breakpoint

-- ============================================================================
-- UPDATED_AT TRIGGERS
-- ============================================================================

CREATE TRIGGER organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
--> statement-breakpoint
CREATE TRIGGER memberships_updated_at
  BEFORE UPDATE ON memberships
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
--> statement-breakpoint
CREATE TRIGGER update_customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
--> statement-breakpoint
CREATE TRIGGER update_subscriptions_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
--> statement-breakpoint
CREATE TRIGGER notifications_updated_at
  BEFORE UPDATE ON notifications
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
--> statement-breakpoint
CREATE TRIGGER app_settings_updated_at
  BEFORE UPDATE ON app_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
--> statement-breakpoint
CREATE TRIGGER update_contact_submissions_updated_at
  BEFORE UPDATE ON public.contact_submissions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
--> statement-breakpoint
CREATE TRIGGER update_newsletter_subscribers_updated_at
  BEFORE UPDATE ON public.newsletter_subscribers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
--> statement-breakpoint
CREATE TRIGGER update_crawler_hits_daily_updated_at
  BEFORE UPDATE ON public.crawler_hits_daily
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
--> statement-breakpoint

-- ============================================================================
-- BACKGROUND JOBS (pg_cron)
-- ============================================================================

-- Log one job run into public.cron_job_history (super-admin read-only).
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
--> statement-breakpoint

-- This SECURITY DEFINER function bypasses RLS on cron_job_history (super-admin
-- read-only). The pg_cron jobs run it as `postgres` and the admin Jobs route
-- calls it through adminDb, so end users must NOT reach it: without this
-- REVOKE, a user request (app_user, which gets EXECUTE on new functions by
-- default) could inject fabricated "system" rows the admin panel presents as
-- trusted job output (log spoofing) and grow the table unbounded (storage
-- DoS; pruned only weekly). Matches the failed-login lockdown pattern.
REVOKE EXECUTE ON FUNCTION public.log_cron_job(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, app_user;
--> statement-breakpoint

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
--> statement-breakpoint

-- Server-only, like log_cron_job: no end-user role may enumerate the jobs.
REVOKE EXECUTE ON FUNCTION public.get_cron_jobs() FROM PUBLIC, app_user;
--> statement-breakpoint

-- Roll one UTC day of raw crawler hits into crawler_hits_daily. Both the
-- nightly cron job and the admin panel's manual "run now" button call it.
-- Recomputing a whole day and upserting makes it idempotent: running it twice
-- (or re-running an old day) produces the same counts, never doubled ones.
CREATE OR REPLACE FUNCTION public.rollup_crawler_hits(p_day DATE DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_day DATE := COALESCE(p_day, ((now() AT TIME ZONE 'UTC')::date - 1));
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
  v_rows INTEGER;
BEGIN
  v_start := (v_day::timestamp) AT TIME ZONE 'UTC';
  v_end := ((v_day + 1)::timestamp) AT TIME ZONE 'UTC';

  INSERT INTO public.crawler_hits_daily (day, crawler, path, hits, errors)
  SELECT v_day, h.crawler, h.path, count(*)::int,
         (count(*) FILTER (WHERE h.status >= 500))::int
  FROM public.crawler_hits h
  WHERE h.hit_at >= v_start AND h.hit_at < v_end
  GROUP BY h.crawler, h.path
  ON CONFLICT (day, crawler, path) DO UPDATE
    SET hits = EXCLUDED.hits,
        errors = EXCLUDED.errors;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;
--> statement-breakpoint

-- This SECURITY DEFINER function reads and writes tables that are super-admin
-- read-only under RLS. app_user gets EXECUTE on new functions by default, so
-- without this REVOKE any user request could rewrite the rollup table at will.
-- Only the server (adminDb) and pg_cron (postgres, the owner) may run it.
REVOKE EXECUTE ON FUNCTION public.rollup_crawler_hits(DATE) FROM PUBLIC, app_user;
--> statement-breakpoint

-- Clean up old failed login attempts (every 6 hours)
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
--> statement-breakpoint

-- Clean up expired notifications (daily at 3am)
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
--> statement-breakpoint

-- Clean up old cron job history (weekly, keep last 30 days)
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
--> statement-breakpoint

-- Roll yesterday's raw crawler hits into the daily table (nightly at 2:15 AM)
SELECT cron.schedule(
  'rollup-crawler-hits',
  '15 2 * * *',
  $$
  DO $body$
  DECLARE
    rolled_count INTEGER;
  BEGIN
    rolled_count := public.rollup_crawler_hits();
    PERFORM public.log_cron_job('rollup-crawler-hits', 'succeeded',
      'Rolled up ' || rolled_count || ' crawler/path rows');
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.log_cron_job('rollup-crawler-hits', 'failed', NULL, SQLERRM);
  END $body$;
  $$
);
--> statement-breakpoint

-- Prune both crawler tables (daily at 3:45 AM):
--   - raw hits older than 90 days: per-hit detail ages out, but the day's
--     counts survive in the rollup, so trend history is not lost;
--   - rollup rows older than 400 days. The dashboard's widest window is 365
--     days, so anything past ~13 months is unreachable data that only grows.
SELECT cron.schedule(
  'cleanup-crawler-hits',
  '45 3 * * *',
  $$
  DO $body$
  DECLARE
    deleted_count INTEGER;
    deleted_daily INTEGER;
  BEGIN
    DELETE FROM public.crawler_hits
    WHERE hit_at < now() - interval '90 days';
    GET DIAGNOSTICS deleted_count = ROW_COUNT;

    DELETE FROM public.crawler_hits_daily
    WHERE day < ((now() AT TIME ZONE 'UTC')::date - 400);
    GET DIAGNOSTICS deleted_daily = ROW_COUNT;

    PERFORM public.log_cron_job('cleanup-crawler-hits', 'succeeded',
      'Deleted ' || deleted_count || ' crawler hits older than 90 days and '
      || deleted_daily || ' rollup rows older than 400 days');
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.log_cron_job('cleanup-crawler-hits', 'failed', NULL, SQLERRM);
  END $body$;
  $$
);
--> statement-breakpoint

-- ============================================================================
-- SEED SETTINGS
-- ============================================================================
-- The keys the app reads. The public ones are whitelisted by the
-- "Public can read whitelisted settings" policy in schema.ts:
--   mfa_enabled        whether sign-in enforces a second factor
--   app_theme          the admin's theme overrides ({} = CSS defaults)
--   user_docs_enabled  the MDX docs site (/docs) and every link to it
--   api_docs_enabled   /api/docs, /api/openapi.json and /api/swagger together
--                      (the spec is what the viewers render, so hiding the
--                      viewers alone would not take the docs down)
INSERT INTO app_settings (key, value)
VALUES
  ('mfa_enabled', '{"enabled": false}'::jsonb),
  ('app_theme', '{}'::jsonb),
  ('user_docs_enabled', '{"enabled": true}'::jsonb),
  ('api_docs_enabled', '{"enabled": true}'::jsonb)
ON CONFLICT (key) DO NOTHING;
