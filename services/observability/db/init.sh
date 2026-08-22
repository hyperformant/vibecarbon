#!/bin/bash
set -e

# Observability Database Initialization
# Creates a dedicated, least-privilege read-only role used by BOTH the Grafana
# PostgreSQL datasource and the postgres-exporter. Replaces the previous use of
# the superuser `supabase_admin` for metrics access (H-9 follow-up).
#
# The role is granted `pg_monitor` — Postgres' built-in monitoring role
# (pg_read_all_stats + pg_read_all_settings + pg_stat_scan_tables), which is
# exactly what postgres-exporter needs to scrape pg_stat_* — plus CONNECT. It is
# deliberately NOT granted SELECT on application tables: the shipped dashboards
# query only Prometheus/Loki, so exposing app data through the datasource would
# violate least privilege (Metabase is the tool for app-data exploration).
#
# Password is injected from OBSERVABILITY_DB_PASSWORD at runtime (never
# hardcoded). SECURITY: the ALTER ROLE below passes it as a psql variable and
# quotes it with :'pw', so psql performs the SQL-literal escaping — the value is
# never interpolated into SQL by the shell, and a password containing quotes
# cannot break out. (Generated values are already quote-free; this hardens the
# hand-set-password case.)
#
# NOTE (operational): like every other /docker-entrypoint-initdb.d/zz-*-init.sh
# script (metabase, n8n), this runs only on FIRST database init (empty PGDATA).
# Adding observability to a project whose db volume already exists requires a
# `vibecarbon reset` (or manual role creation) before Grafana/exporter can
# authenticate as observability_ro.

# Create role if it doesn't exist, then (idempotently) grant monitoring access.
# Quoted heredoc — no shell variable expansion here.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'observability_ro') THEN
        CREATE ROLE observability_ro WITH LOGIN;
    END IF;
END
$$;
GRANT pg_monitor TO observability_ro;
GRANT CONNECT ON DATABASE postgres TO observability_ro;
EOSQL

# Set/rotate the password. Pass it as a psql variable and use :'pw' quoting so
# psql does the SQL-literal escaping — safe even if an operator hand-sets a
# password containing a quote (the heredoc is quoted, so the shell never
# interpolates it into SQL). The value still reaches the db over the psql arg
# vector, but it is already present in this container's env and .env.
psql -v ON_ERROR_STOP=1 -v pw="$OBSERVABILITY_DB_PASSWORD" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
ALTER ROLE observability_ro WITH PASSWORD :'pw';
EOSQL
