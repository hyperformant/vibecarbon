#!/bin/bash
# n8n DB-Only Setup Script
# Inserts the owner user directly into PostgreSQL so n8n's setup wizard is skipped.
# Auth is handled by ForwardAuth + hooks.js — the password here is a placeholder.
# Added via: vibecarbon add n8n

set -e

DB_HOST="${N8N_DB_HOST:-db}"
DB_NAME="${N8N_DB_NAME:-n8n}"
DB_USER="${N8N_DB_USER:-n8n}"
DB_PASSWORD="${N8N_DB_PASSWORD}"
ADMIN_EMAIL="${N8N_ADMIN_EMAIL:-admin@localhost}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >&2; }

if [ -z "$DB_PASSWORD" ]; then
  log "ERROR: N8N_DB_PASSWORD is required"
  exit 1
fi

# Wait for n8n's user table to exist (created by n8n's own migrations)
log "Waiting for n8n user table..."
for i in $(seq 1 60); do
  if PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -tAc \
    "SELECT 1 FROM information_schema.tables WHERE table_name='user'" 2>/dev/null | grep -q 1; then
    break
  fi
  [ "$i" -eq 60 ] && { log "ERROR: user table not found after 5 minutes"; exit 1; }
  sleep 5
done

# Insert owner with random password placeholder and global:owner role.
# ON CONFLICT DO NOTHING — idempotent across restarts.
RANDOM_HASH=$(head -c 32 /dev/urandom | base64)
PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -q <<SQL
INSERT INTO "user" (email, "firstName", "lastName", password, role)
VALUES ('${ADMIN_EMAIL}', 'Admin', 'User', '${RANDOM_HASH}', 'global:owner')
ON CONFLICT (email) DO NOTHING;
SQL

log "n8n owner setup complete (email: ${ADMIN_EMAIL})"
