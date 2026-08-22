#!/bin/bash
set -e

# ============================================================================
# Vibecarbon Compose Backup Script — single source of truth for compose backups
#
# Runs via cron on the VPS (and on-demand from the CLI). Triggers a wal-g base
# backup from inside the db container (which already has WALG_S3_PREFIX + AWS_*
# configured from .env) and prunes old base backups via `wal-g delete retain`.
#
# Invoked as `cd <project-dir> && RETAIN=<n> bash backup/compose-backup.sh`, so
# it operates relative to the current working directory — no PROJECT_NAME
# needed. Both the cron path and the on-demand path use the SAME invocation
# (src/lib/deploy/compose/index.js composeBackupCmd), so the quoting/behavior
# can never drift.
#
# Environment Variables:
#   RETAIN  - Number of full base backups to keep (default: 7)
# ============================================================================

# Prevent concurrent backups (cron + a manual run racing each other).
LOCKFILE="/tmp/vibecarbon-backup.lock"
exec 200>"${LOCKFILE}"
flock -n 200 || { echo "Backup already running — skipping"; exit 0; }

RETAIN="${RETAIN:-7}"

echo "=== Vibecarbon Compose Backup (wal-g) ==="
echo "Started at $(date)"
echo "Retain: ${RETAIN} full base backups"

# wal-g connects to PG via libpq; PGUSER=supabase_admin is REQUIRED (only the
# superuser may call pg_backup_start; unset, libpq defaults to OS user root →
# "role root does not exist"). The pg_is_in_recovery()='f' guard makes the
# backup a no-op on a standby (exit 0), so only the primary pushes to S3.
#
# The S3-configured guard exits 0 BEFORE wal-g runs when no S3 backup target is
# configured. docker-compose.yml renders WALG_S3_PREFIX as
#   s3://${S3_BACKUP_BUCKET:-${S3_BUCKET:-}}/backups/${PROJECT_NAME}/walg
# so an unconfigured deploy yields the empty-bucket form `s3:///backups/...`
# (and empty AWS_ACCESS_KEY_ID). Without this guard an always-installed cron
# would `set -e`-fail nightly into backup.log on no-S3 deploys. Checking inside
# the container is robust: it tests the actual env wal-g sees (source of truth),
# covers both the cron and on-demand paths, and needs no deploy-time S3 plumbing.
docker compose exec -T db bash -c '
  export PGUSER=supabase_admin PGHOST=localhost PGPORT=5432 PGDATABASE=postgres
  case "${WALG_S3_PREFIX:-}" in
    ""|s3:///*)
      echo "scheduled backup skipped: no S3 backup target configured (empty WALG_S3_PREFIX)."
      exit 0
      ;;
  esac
  if [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
    echo "scheduled backup skipped: no S3 credentials configured (empty AWS_ACCESS_KEY_ID/SECRET)."
    exit 0
  fi
  # WRITE-GUARD (finding #3): a standby must never base-backup into the single
  # canonical prefix. WALG_ROLE=standby is set on the standby db env. This closes
  # the bring-up window the pg_is_in_recovery() check below cannot (an
  # independent primary not yet in recovery).
  if [ "${WALG_ROLE:-primary}" = "standby" ]; then
    echo "WALG_ROLE=standby — skipping base backup (only the primary writes to the canonical prefix)."
    exit 0
  fi
  if [ "$(psql -U supabase_admin -d postgres -tAc "SELECT pg_is_in_recovery()")" != "f" ]; then
    echo "supabase-db is in recovery (standby) — skipping base backup."
    exit 0
  fi
  wal-g backup-push "$PGDATA" && wal-g delete retain FULL "'"${RETAIN}"'" --confirm
'

echo "=== Backup completed at $(date) ==="
