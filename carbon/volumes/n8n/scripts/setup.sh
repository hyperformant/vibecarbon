#!/bin/bash
# n8n DB-Only Setup Script
# Updates the skeleton owner user that n8n creates during migration,
# setting email/name so n8n's setup wizard is skipped.
#
# The owner's password hash comes from N8N_ADMIN_PASSWORD_HASH. Only the dev
# compose override sets it (a bcrypt hash of "changeme", the documented dev
# login). With no hash set, which is every production deploy, the owner gets a
# random value nobody knows: production signs in through ForwardAuth + hooks.js
# and never needs a password, so no shared password exists.
# Added via: vibecarbon add n8n
#
# This file ships from two places (services/n8n/scripts and
# carbon/volumes/n8n/scripts) and the two must stay byte for byte the same.

set -e

DB_HOST="${N8N_DB_HOST:-db}"
DB_NAME="${N8N_DB_NAME:-n8n}"
DB_USER="${N8N_DB_USER:-n8n}"
DB_PASSWORD="${N8N_DB_PASSWORD}"
ADMIN_EMAIL="${N8N_ADMIN_EMAIL:-admin@localhost}"
PASSWORD_HASH="${N8N_ADMIN_PASSWORD_HASH:-}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >&2; }

if [ -z "$DB_PASSWORD" ]; then
  log "ERROR: N8N_DB_PASSWORD is required"
  exit 1
fi

if [ -z "$PASSWORD_HASH" ]; then
  # Not a bcrypt hash, so no password can ever match it.
  PASSWORD_HASH=$(head -c 32 /dev/urandom | base64)
  if [ -z "$PASSWORD_HASH" ]; then
    log "ERROR: could not generate a random owner password"
    exit 1
  fi
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
# Update it with the admin email so the setup wizard is skipped. Any SQL error
# stops the script with a non-zero exit, so success is never logged after one.
# The email and hash go in as psql variables (:'email'), never pasted into SQL.
PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -q \
  -v ON_ERROR_STOP=1 --single-transaction \
  -v "email=${ADMIN_EMAIL}" -v "hash=${PASSWORD_HASH}" <<'SQL'
-- Update the skeleton owner (n8n v2.x creates one with no email during migration).
-- Set email, name, bcrypt password, and lastActiveAt.
-- n8n's hasInstanceOwner() requires password IS NOT NULL or lastActiveAt IS NOT NULL.
UPDATE "user"
SET email = :'email',
    "firstName" = 'Admin',
    "lastName" = 'User',
    password = :'hash',
    "lastActiveAt" = CURRENT_DATE
WHERE "roleSlug" = 'global:owner' AND (email IS NULL OR email = '')
  AND NOT EXISTS (SELECT 1 FROM "user" WHERE email = :'email');

-- If no skeleton owner existed (or email was already set), ensure one exists.
INSERT INTO "user" (email, "firstName", "lastName", password, "roleSlug", "lastActiveAt")
SELECT :'email', 'Admin', 'User', :'hash', 'global:owner', CURRENT_DATE
WHERE NOT EXISTS (SELECT 1 FROM "user" WHERE email = :'email')
ON CONFLICT (email) DO NOTHING;

-- Mark instance owner as set up so n8n skips the setup wizard.
-- n8n checks both this setting and hasInstanceOwner() on every request.
UPDATE settings SET value = 'true'
WHERE key = 'userManagement.isInstanceOwnerSetUp' AND value != 'true';
SQL

log "n8n owner setup complete (email: ${ADMIN_EMAIL})"
