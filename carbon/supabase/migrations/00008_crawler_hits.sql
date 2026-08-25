-- =============================================================================
-- AI Visibility: crawler hit tracking
--
-- Records which AI / search crawlers fetch which pages, so the admin dashboard
-- can answer the only actionable question here: "are the AI engines actually
-- reading the pages the SEO pipeline generates?"
--
-- Two tables:
--   crawler_hits        raw per-hit rows, pruned after 90 days
--   crawler_hits_daily  (day, crawler, path) counts, pruned after 400 days
--
-- Neither table is unbounded. `path` reaches this schema only after the
-- middleware has bucketed it against the built SEO route manifest (unknown
-- URLs collapse to the literal '<other>'), so primary-key cardinality is
-- days x crawlers x known-routes, and both tables age out on a schedule.
--
-- Writes come exclusively from the server's service_role client
-- (src/server/middleware/crawler-tracking.ts) and from the pg_cron rollup.
-- Nothing here stores an IP address or any other personal data.
-- =============================================================================

-- ========== RAW HITS ==========

CREATE TABLE IF NOT EXISTS public.crawler_hits (
  -- bigint identity rather than a uuid: this is the highest-write table in the
  -- schema and the rows are never referenced by anything else.
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  crawler TEXT NOT NULL,
  path TEXT NOT NULL,
  user_agent TEXT,
  hit_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- (hit_at DESC): the 90-day prune and every windowed dashboard read.
CREATE INDEX IF NOT EXISTS idx_crawler_hits_hit_at ON public.crawler_hits (hit_at DESC);
-- (crawler, hit_at DESC): per-crawler trend queries.
CREATE INDEX IF NOT EXISTS idx_crawler_hits_crawler_hit_at
  ON public.crawler_hits (crawler, hit_at DESC);

ALTER TABLE public.crawler_hits ENABLE ROW LEVEL SECURITY;

-- Only super admins can read crawler hits.
DROP POLICY IF EXISTS "Super admins can read crawler hits" ON public.crawler_hits;
CREATE POLICY "Super admins can read crawler hits"
  ON public.crawler_hits FOR SELECT
  USING (public.is_super_admin());

-- SECURITY: there is deliberately NO INSERT/UPDATE/DELETE policy on this table.
-- The `authenticated` role holds a blanket table-level INSERT/UPDATE/DELETE
-- grant (volumes/db/roles.sql), so RLS is the only gate — any permissive write
-- policy would let any logged-in user POST /rest/v1/crawler_hits directly and
-- forge dashboard data or grow the table without bound (storage DoS). Real
-- writes go through the server's service_role client, which bypasses RLS.

-- ========== DAILY ROLLUP ==========

CREATE TABLE IF NOT EXISTS public.crawler_hits_daily (
  day DATE NOT NULL,
  crawler TEXT NOT NULL,
  path TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, crawler, path)
);

-- The PK's leading `day` column already serves day-range scans (including the
-- 400-day prune); this covers the per-crawler-over-time direction.
CREATE INDEX IF NOT EXISTS idx_crawler_hits_daily_crawler_day
  ON public.crawler_hits_daily (crawler, day DESC);

ALTER TABLE public.crawler_hits_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Super admins can read crawler hit rollups" ON public.crawler_hits_daily;
CREATE POLICY "Super admins can read crawler hit rollups"
  ON public.crawler_hits_daily FOR SELECT
  USING (public.is_super_admin());

-- SECURITY: no client write policy here either — same reasoning as above. The
-- rollup runs as `postgres` via pg_cron / as service_role via the admin Jobs
-- route, both of which bypass RLS.

DROP TRIGGER IF EXISTS update_crawler_hits_daily_updated_at ON public.crawler_hits_daily;
CREATE TRIGGER update_crawler_hits_daily_updated_at
  BEFORE UPDATE ON public.crawler_hits_daily
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================================================
-- Rollup function
--
-- Aggregation can't be expressed through PostgREST, so both the nightly cron
-- job and the admin panel's manual "run now" button call this one function.
-- Recomputing a whole day and upserting makes it idempotent: running it twice
-- (or re-running an old day) produces the same counts, never doubled ones.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rollup_crawler_hits(p_day DATE DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
-- Pin search_path so this SECURITY DEFINER function can't be hijacked by an
-- object in an attacker-controlled schema. Every reference below is already
-- schema-qualified, so an empty path is safe (pg_catalog is always implicit).
SET search_path = ''
AS $$
DECLARE
  -- Default to yesterday (UTC) — the most recent fully-elapsed day.
  v_day DATE := COALESCE(p_day, ((now() AT TIME ZONE 'UTC')::date - 1));
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
  v_rows INTEGER;
BEGIN
  -- Convert the UTC calendar day back to an absolute range. Comparing hit_at
  -- (timestamptz) against a bare timestamp would silently reinterpret it in the
  -- session's timezone and slice the day at the wrong boundary.
  v_start := (v_day::timestamp) AT TIME ZONE 'UTC';
  v_end := ((v_day + 1)::timestamp) AT TIME ZONE 'UTC';

  INSERT INTO public.crawler_hits_daily (day, crawler, path, hits)
  SELECT v_day, h.crawler, h.path, count(*)::int
  FROM public.crawler_hits h
  WHERE h.hit_at >= v_start AND h.hit_at < v_end
  GROUP BY h.crawler, h.path
  ON CONFLICT (day, crawler, path) DO UPDATE
    SET hits = EXCLUDED.hits;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

-- This SECURITY DEFINER function reads and writes tables that are super-admin
-- read-only under RLS. PostgREST exposes every `public` function at
-- /rest/v1/rpc/<name>, so without this REVOKE any anon/authenticated caller
-- could rewrite the rollup table at will. Only the server (service_role) and
-- pg_cron (postgres, the owner) may run it.
REVOKE EXECUTE ON FUNCTION public.rollup_crawler_hits(DATE) FROM PUBLIC, anon, authenticated;
-- roles.sql's `GRANT ALL ON ALL ROUTINES` ran at DB init, before this function
-- existed, and its ALTER DEFAULT PRIVILEGES covers tables/sequences only — so
-- service_role needs an explicit grant here for the admin Jobs trigger to work.
GRANT EXECUTE ON FUNCTION public.rollup_crawler_hits(DATE) TO service_role;

-- =============================================================================
-- Scheduled jobs (pattern: 00003_pg_cron.sql)
-- =============================================================================

-- 1. Roll yesterday's raw hits into the daily table (nightly at 2:15 AM)
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

-- 2. Prune both tables (daily at 3:45 AM):
--      - raw hits older than 90 days — per-hit detail ages out, but the day's
--        counts survive in the rollup, so trend history is not lost;
--      - rollup rows older than 400 days. The rollup is the long-term record,
--        but "forever" is not a retention policy: the dashboard's widest window
--        is 365 days, so anything past ~13 months is unreachable data that only
--        grows. 400 leaves a comfortable margin above the 365-day window.
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
