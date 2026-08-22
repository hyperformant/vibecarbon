#!/bin/bash
set -e

# Metabase Database Initialization
# Creates the metabase database and user for analytics
# Password is injected from POSTGRES_PASSWORD env var at runtime (never hardcoded)

# Create metabase role if it doesn't exist (quoted heredoc — no variable expansion)
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'metabase') THEN
        CREATE ROLE metabase WITH LOGIN;
    END IF;
END
$$;
EOSQL

# Set password and create database (unquoted heredoc — POSTGRES_PASSWORD is expanded)
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
