#!/bin/bash
set -e

# Metabase Database Initialization
# Creates the metabase database and user for analytics
# Password is injected from POSTGRES_PASSWORD env var at runtime (never hardcoded)

# The metabase role is also Metabase's "Application Data" connection
# (scripts/setup.sh), which anyone with Metabase's SQL editor can drive. So it
# is never a superuser: a superuser can run `COPY ... TO PROGRAM`, a shell in
# the db container. BYPASSRLS lets it see every business row (row-level
# security would otherwise show it none), and the grants below decide which
# tables it may read at all. Set on every start, so a role created by hand or
# by an older version is brought back to this. Quoted heredoc: no variable
# expansion.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'metabase') THEN
        CREATE ROLE metabase WITH LOGIN;
    END IF;
END
$$;
ALTER ROLE metabase NOSUPERUSER BYPASSRLS;
EOSQL

# Set password and create database (unquoted heredoc — POSTGRES_PASSWORD is expanded).
# Read-only on the app's tables, including the ones a later migration creates
# (the default privileges cover tables the app's role, postgres, creates).
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
ALTER ROLE metabase WITH PASSWORD '${POSTGRES_PASSWORD}';
SELECT 'CREATE DATABASE metabase WITH OWNER metabase ENCODING ''UTF8'' TEMPLATE template0'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'metabase')\gexec
GRANT ALL PRIVILEGES ON DATABASE metabase TO metabase;
GRANT CONNECT ON DATABASE postgres TO metabase;
GRANT USAGE ON SCHEMA public TO metabase;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO metabase;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO metabase;
EOSQL

# The blanket SELECT above reruns on every start (scripts/docker-up.js), and
# it covers the auth tables the baseline migration locks down
# (db/migrations/0002_baseline_post.sql: password hashes, session and OAuth
# tokens, TOTP secrets). Take them back every time, and only where they exist:
# on a first boot this runs before the app has migrated, and the migration's
# own revoke loop takes back what the default privileges hand out then.
# Quoted heredoc, so the shell leaves the $$ quoting alone.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['user', 'session', 'account', 'verification', 'two_factor'] LOOP
        IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
            EXECUTE format('REVOKE ALL ON TABLE public.%I FROM metabase', t);
        END IF;
    END LOOP;
END
$$;
EOSQL
