-- =============================================================================
-- AI Visibility: record the HTTP status each crawler received
--
-- crawler_hits gains `status` (the response status the crawler got; NULL for
-- rows recorded before this migration), and the daily rollup gains `errors`
-- (hits answered with a 5xx). Together they let the admin dashboard show a
-- server error served to Googlebot or GPTBot the same day, instead of weeks
-- later in a Search Console email.
--
-- The rollup function is replaced in place; CREATE OR REPLACE keeps its owner
-- and grants, and the REVOKE/GRANT below are repeated so this file is correct
-- on its own.
-- =============================================================================

ALTER TABLE public.crawler_hits ADD COLUMN IF NOT EXISTS status SMALLINT;

ALTER TABLE public.crawler_hits_daily
  ADD COLUMN IF NOT EXISTS errors INTEGER NOT NULL DEFAULT 0;

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

REVOKE EXECUTE ON FUNCTION public.rollup_crawler_hits(DATE) FROM PUBLIC, anon, authenticated, app_user;
GRANT EXECUTE ON FUNCTION public.rollup_crawler_hits(DATE) TO service_role;
