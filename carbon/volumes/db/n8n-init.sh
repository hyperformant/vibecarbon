#!/bin/bash
set -e

# n8n Database Initialization
# Creates dedicated n8n user and database for workflow automation
# Password is injected from POSTGRES_PASSWORD env var at runtime (never hardcoded)

# Create n8n role if it doesn't exist (quoted heredoc — no variable expansion)
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'n8n') THEN
        CREATE ROLE n8n WITH LOGIN;
    END IF;
END
$$;
EOSQL

# Set password and create database (unquoted heredoc — POSTGRES_PASSWORD is expanded)
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
ALTER ROLE n8n WITH PASSWORD '${POSTGRES_PASSWORD}';
SELECT 'CREATE DATABASE n8n WITH OWNER n8n ENCODING ''UTF8'' TEMPLATE template0'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'n8n')\gexec
GRANT ALL PRIVILEGES ON DATABASE n8n TO n8n;
EOSQL
