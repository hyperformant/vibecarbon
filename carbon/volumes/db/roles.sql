-- Database roles setup
-- Creates the roles and grants the migrations reference. No role here logs in
-- with a password; the app connects as the database owner (DB_USER).

-- Create roles if they don't exist (fallback for non-Supabase postgres images)
DO $$
BEGIN
    -- anon role (for anonymous access)
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN NOINHERIT;
    END IF;

    -- authenticated role (for logged-in users)
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN NOINHERIT;
    END IF;

    -- service_role (for server-side operations)
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
    END IF;

    -- supabase_admin role
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'supabase_admin') THEN
        CREATE ROLE supabase_admin LOGIN;
    END IF;
END
$$;

-- Grant schema permissions (principle of least privilege)
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- anon role: must be granted access explicitly per table via RLS
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO anon;

-- authenticated role: SELECT, INSERT, UPDATE, DELETE (controlled by RLS)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- service_role: ALL (bypasses RLS - use carefully)
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO service_role;

-- Default privileges for future objects
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;

-- Create extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgjwt WITH SCHEMA extensions;

-- Ensure service_role has BYPASSRLS
ALTER ROLE service_role WITH BYPASSRLS;
