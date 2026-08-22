#!/bin/bash
set -e

# Set passwords for Supabase service roles from POSTGRES_PASSWORD env var.
# Mounted at /docker-entrypoint-initdb.d/zz-set-passwords.sh (top level)
# so the standard postgres entrypoint runs it AFTER migrate.sh creates the roles.

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
ALTER ROLE authenticator WITH PASSWORD '${POSTGRES_PASSWORD}';
ALTER ROLE supabase_auth_admin WITH PASSWORD '${POSTGRES_PASSWORD}';
ALTER ROLE supabase_storage_admin WITH PASSWORD '${POSTGRES_PASSWORD}';
ALTER ROLE pgbouncer WITH PASSWORD '${POSTGRES_PASSWORD}';
EOSQL
