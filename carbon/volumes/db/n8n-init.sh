#!/bin/bash
set -e

# n8n Database Initialization
# Creates dedicated n8n user and database for workflow automation
# Password is injected from POSTGRES_PASSWORD env var at runtime (never hardcoded)

# The n8n role is also the APP_DB_* credential workflows use to reach the
# app's data (docker-compose.n8n.yml), which anyone who can edit a workflow
# can drive. So it is never a superuser: a superuser can run
# `COPY ... TO PROGRAM`, a shell in the db container. BYPASSRLS lets it see
# every business row (row-level security would otherwise show it none), and
# the grants below decide which tables it may touch at all. Set on every
# start, so a role created by hand or by an older version is brought back to
# this. Quoted heredoc: no variable expansion.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'n8n') THEN
        CREATE ROLE n8n WITH LOGIN;
    END IF;
END
$$;
ALTER ROLE n8n NOSUPERUSER BYPASSRLS;
EOSQL

# Set password, create n8n's own database, and grant read and write on the
# app's tables, including the ones a later migration creates (the default
# privileges cover tables the app's role, postgres, creates). Unquoted
# heredoc — POSTGRES_PASSWORD is expanded.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
ALTER ROLE n8n WITH PASSWORD '${POSTGRES_PASSWORD}';
SELECT 'CREATE DATABASE n8n WITH OWNER n8n ENCODING ''UTF8'' TEMPLATE template0'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'n8n')\gexec
GRANT ALL PRIVILEGES ON DATABASE n8n TO n8n;
GRANT CONNECT ON DATABASE postgres TO n8n;
GRANT USAGE ON SCHEMA public TO n8n;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO n8n;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO n8n;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO n8n;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO n8n;
EOSQL

# The blanket grant above reruns on every start (scripts/docker-up.js), and
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
            EXECUTE format('REVOKE ALL ON TABLE public.%I FROM n8n', t);
        END IF;
    END LOOP;
END
$$;
EOSQL
