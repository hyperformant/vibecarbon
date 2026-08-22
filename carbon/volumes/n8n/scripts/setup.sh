#!/bin/bash
# n8n DB-Only Setup Script
# Updates the skeleton owner user that n8n creates during migration,
# setting email/name so n8n's setup wizard is skipped.
# In dev, uses a default password (changeme). In production, ForwardAuth + hooks.js
# handles SSO so the password is just a placeholder.
# Added via: vibecarbon add n8n

set -e

DB_HOST="${N8N_DB_HOST:-db}"
DB_NAME="${N8N_DB_NAME:-n8n}"
DB_USER="${N8N_DB_USER:-n8n}"
DB_PASSWORD="${N8N_DB_PASSWORD}"
ADMIN_EMAIL="${N8N_ADMIN_EMAIL:-admin@localhost}"

# Pre-computed bcrypt hash of "changeme" — used as default dev password.
# In production, ForwardAuth SSO bypasses the login page entirely.
DEFAULT_PW_HASH='$2a$10$K7L1OJ45/4Y2nIvhRVpCe.FSmhDdWoXehVzJtl/Q0T1FWYvv1nWi2'

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

# n8n v2.x creates a skeleton owner row (no email) during migration.
# Update it with the admin email so the setup wizard is skipped.
PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -q <<SQL
-- Update the skeleton owner (n8n v2.x creates one with no email during migration).
-- Set email, name, bcrypt password, and lastActiveAt.
-- n8n's hasInstanceOwner() requires password IS NOT NULL or lastActiveAt IS NOT NULL.
UPDATE "user"
SET email = '${ADMIN_EMAIL}',
    "firstName" = 'Admin',
    "lastName" = 'User',
    password = '${DEFAULT_PW_HASH}',
    "lastActiveAt" = CURRENT_DATE
WHERE "roleSlug" = 'global:owner' AND (email IS NULL OR email = '')
  AND NOT EXISTS (SELECT 1 FROM "user" WHERE email = '${ADMIN_EMAIL}');

-- If no skeleton owner existed (or email was already set), ensure one exists.
INSERT INTO "user" (email, "firstName", "lastName", password, "roleSlug", "lastActiveAt")
SELECT '${ADMIN_EMAIL}', 'Admin', 'User', '${DEFAULT_PW_HASH}', 'global:owner', CURRENT_DATE
WHERE NOT EXISTS (SELECT 1 FROM "user" WHERE email = '${ADMIN_EMAIL}')
ON CONFLICT (email) DO NOTHING;

-- Mark instance owner as set up so n8n skips the setup wizard.
-- n8n checks both this setting and hasInstanceOwner() on every request.
UPDATE settings SET value = 'true'
WHERE key = 'userManagement.isInstanceOwnerSetUp' AND value != 'true';
SQL

log "n8n owner setup complete (email: ${ADMIN_EMAIL})"
