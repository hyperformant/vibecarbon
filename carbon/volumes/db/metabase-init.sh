#!/bin/bash
set -e

# Metabase Database Initialization
# Creates the metabase role and its own metabase database (dashboards, questions and users).
# Runs at first boot of a database volume (/docker-entrypoint-initdb.d) and,
# in local development, again on every `vibecarbon up` (scripts/docker-up.js).
# A server never reruns it: what must hold for tables created later is
# enforced by the app's migration runner, not here (see block 3).
# Password is injected from POSTGRES_PASSWORD env var at runtime (never hardcoded)

# The metabase role is also Metabase's "Application Data"
# connection (scripts/setup.sh), which anyone with Metabase's SQL editor can
# drive. So it is never a superuser: a superuser
# can run `COPY ... TO PROGRAM`, a shell in the db container. BYPASSRLS lets it
# see every business row (row-level security would otherwise show it none),
# and the grants below decide which tables it may touch at all. A role
# created by hand or by an older version is brought back to this. Quoted
# heredoc: no variable expansion.
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

# Set password and create the role's own database (unquoted heredoc,
# POSTGRES_PASSWORD is expanded). CREATE DATABASE cannot run inside a
# transaction, so this is its own call.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
ALTER ROLE metabase WITH PASSWORD '${POSTGRES_PASSWORD}';
SELECT 'CREATE DATABASE metabase WITH OWNER metabase ENCODING ''UTF8'' TEMPLATE template0'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'metabase')\gexec
GRANT ALL PRIVILEGES ON DATABASE metabase TO metabase;
EOSQL

# The app's tables: read-only, including the ones a later migration creates
# (the default privileges cover tables the app's role, postgres, creates).
# The blanket grant also reaches the server-only tables (RLS on and no
# policies: the Better Auth tables with password hashes, session and OAuth
# tokens and TOTP secrets, and failed_login_attempts), so the same
# transaction (-1) takes those back, through the baseline's
# app.revoke_server_only_tables(), which reads the set from the catalog. If
# the revoke fails, the grant is rolled back with it. On a first boot this
# runs before the app has migrated: there are no tables yet and no function,
# and the migration runner calls the function itself after every run, which
# also covers every table a later migration adds. Quoted heredoc, so the
# shell leaves the $$ quoting alone.
psql -1 -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
GRANT CONNECT ON DATABASE postgres TO metabase;
GRANT USAGE ON SCHEMA public TO metabase;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO metabase;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO metabase;
DO $$
BEGIN
    IF to_regprocedure('app.revoke_server_only_tables()') IS NOT NULL THEN
        PERFORM app.revoke_server_only_tables();
    END IF;
END
$$;
EOSQL
