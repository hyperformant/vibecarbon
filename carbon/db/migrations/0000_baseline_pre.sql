-- Baseline, part 1 of 3: what the tables and policies in 0001 depend on.
--
-- Custom SQL (drizzle-kit cannot model it): the pg_cron and
-- pg_stat_statements extensions, the
-- `app_user` request role, the `app` schema with app.user_id(), default
-- privileges, and the RLS helper functions the policies call. Part 2
-- (0001_baseline_schema.sql) is generated from src/server/db/schema.ts;
-- part 3 (0002_baseline_post.sql) has the remaining functions, triggers,
-- revokes, pg_cron schedules and seed rows.
--
-- The app applies every migration in one transaction at startup
-- (src/server/db/migrate.ts), as its connection role (`postgres`).

-- The helper functions below are LANGUAGE sql and read public.memberships,
-- public.customers and public."user", which 0001 creates later in this same
-- transaction. Postgres checks a SQL function's body when it is created, so
-- body checks are off until the end of this file (transaction-local).
SET LOCAL check_function_bodies = off;
--> statement-breakpoint

-- ============================================================================
-- pg_cron: background jobs inside the database (schedules in 0002)
-- pg_stat_statements: per-query call counts and timings (the db image preloads
-- both; docker/postgres-walg/postgresql.conf)
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
--> statement-breakpoint
-- pg_stat_statements lives in its own schema, `monitoring`, which no role but
-- the owner (`postgres`) may use. The extension grants its views and
-- functions to PUBLIC, and in `public` they would also fall under every
-- "ON ALL TABLES IN SCHEMA public" grant (the add-on roles). Without USAGE
-- on the schema, nobody else can reach them: app_user would otherwise read
-- the text of every query that ran as app_user. The operator reads it as
-- `postgres`: SELECT ... FROM monitoring.pg_stat_statements. A monitoring
-- role that needs it later gets USAGE on this schema, nothing in public.
CREATE SCHEMA IF NOT EXISTS monitoring;
--> statement-breakpoint
REVOKE ALL ON SCHEMA monitoring FROM PUBLIC;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_stat_statements SCHEMA monitoring;
--> statement-breakpoint
-- The jobs and the admin Jobs page run as `postgres`.
GRANT USAGE ON SCHEMA cron TO postgres;
--> statement-breakpoint

-- ============================================================================
-- REQUEST ROLE AND IDENTITY (app_user + app.user_id())
-- ============================================================================
-- The server connects as `postgres`, the superuser in the db image, so it
-- bypasses RLS (adminDb runs as it; see docs/security.md) and
-- runs every user request in a transaction that starts with ONE parameterized
-- statement:
--
--   select set_config('role', 'app_user', true),
--          set_config('app.user_id', $1, true)
--
-- so the rest of the transaction runs as `app_user` and every policy reads
-- the caller from app.user_id(). Both settings are transaction-local
-- (is_local = true) and reset at COMMIT/ROLLBACK, so nothing leaks to the next
-- pooled request. An anonymous request sets app.user_id to '' and
-- app.user_id() returns NULL, which matches no owner/org check.
--
-- Roles are cluster-wide, so the role may already exist (another database in
-- the same cluster); create it only when it does not.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

-- set_config('role', ...) requires membership. `postgres` is the app's
-- connection role: the superuser in the db image (adminDb runs as it; see
-- docs/security.md). A superuser passes the check anyway; the grant keeps a
-- non-superuser BYPASSRLS connection role (DB_USER) working.
GRANT app_user TO postgres;
--> statement-breakpoint

CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint

-- The caller's user id for this transaction, or NULL when anonymous. STABLE
-- and read through `(SELECT app.user_id())` in policies so the planner
-- evaluates it once per statement, not once per row.
CREATE OR REPLACE FUNCTION app.user_id()
RETURNS UUID
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid;
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public, app TO app_user;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.user_id() TO app_user;
--> statement-breakpoint

-- Table access is broad on purpose: RLS (enabled on every table) is the
-- boundary. Default privileges, so every table created from here on,
-- including the ones a later migration adds, gets the grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
--> statement-breakpoint

-- Functions get EXECUTE through default privileges at creation time (the RLS
-- helpers below need it, since policies run as app_user). Every server-only
-- function (SECURITY DEFINER lockout, cron log, crawler rollup) MUST
-- `REVOKE EXECUTE ... FROM PUBLIC, app_user` in the migration that creates it.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO app_user;
--> statement-breakpoint

-- ============================================================================
-- RLS HELPER FUNCTIONS (SECURITY DEFINER to bypass RLS for policy checks)
-- ============================================================================

-- Get organization IDs for current user
CREATE OR REPLACE FUNCTION get_user_org_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT organization_id FROM public.memberships WHERE user_id = app.user_id();
$$;
--> statement-breakpoint

-- Get organization IDs where user is owner/admin
CREATE OR REPLACE FUNCTION get_user_admin_org_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT organization_id FROM public.memberships
  WHERE user_id = app.user_id() AND role IN ('OWNER', 'ADMIN');
$$;
--> statement-breakpoint

-- Get organization IDs where user is owner
CREATE OR REPLACE FUNCTION get_user_owner_org_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT organization_id FROM public.memberships
  WHERE user_id = app.user_id() AND role = 'OWNER';
$$;
--> statement-breakpoint

-- Get customer IDs for the current user
CREATE OR REPLACE FUNCTION get_user_customer_ids()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.id FROM public.customers c
  WHERE c.user_id = (SELECT app.user_id())
  UNION
  SELECT c.id FROM public.customers c
  WHERE c.organization_id IN (SELECT public.get_user_org_ids());
$$;
--> statement-breakpoint

-- Check if the current user is a super admin. The role is "user".role, which
-- only the server sets (Better Auth's admin plugin; the column is not
-- user-writable through any auth endpoint). SECURITY DEFINER because app_user
-- has no privileges on "user" (see 0002).
CREATE OR REPLACE FUNCTION is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    (
      SELECT u.role = 'super_admin'
      FROM public."user" u
      WHERE u.id = (SELECT app.user_id())
    ),
    false
  );
$$;
--> statement-breakpoint

-- Policies run as app_user, so it must be able to call the helpers. Explicit,
-- not only through the default privileges above, because every policy
-- depends on it.
GRANT EXECUTE ON FUNCTION
  get_user_org_ids(),
  get_user_admin_org_ids(),
  get_user_owner_org_ids(),
  get_user_customer_ids(),
  is_super_admin()
TO app_user;
--> statement-breakpoint

RESET check_function_bodies;
