#!/bin/bash
set -e

# ============================================================================
# Vibecarbon Compose Backup Script — single source of truth for compose backups
#
# Runs via cron on the VPS (and on-demand from the CLI). Triggers a wal-g base
# backup from inside the db container (which already has WALG_S3_PREFIX_BASE +
# AWS_* configured from .env) and prunes base backups older than RETAIN days via
# `wal-g delete before FIND_FULL <cutoff>`. The in-container script sources /etc/postgresql/walg-env.sh first,
# so the push, the fence read and the retention all act on this database's own
# lineage folder (its system identifier) and never on another lineage's.
#
# RESULT MARKER (src/lib/walg/backup-result.js parses it): every run that exits
# 0 prints exactly one stdout line, `BACKUP_RESULT=pushed:<name>` (the base
# name the push logged) or `BACKUP_RESULT=skipped:<reason>`. The lock
# skip prints skipped:already-running and exits 75 (EX_TEMPFAIL). The pushed
# line is printed BEFORE retention, so a retention failure still names the base
# that landed; it exits 3, the one code meaning "base pushed, retention
# failed" (the CronJob fails its Job on 3 instead of re-pushing). Refusals (retired node, backup-prefix fence) and a
# failed push exit 1 with no marker.
#
# Invoked as `cd <project-dir> && RETAIN=<n> bash backup/compose-backup.sh`, so
# it operates relative to the current working directory — no PROJECT_NAME
# needed. Both the cron path and the on-demand path use the SAME invocation
# (src/lib/deploy/compose/index.js composeBackupCmd), so the quoting/behavior
# can never drift.
#
# Environment Variables:
#   RETAIN     - Days of base backups to keep (default: 7). The newest base
#                that finished at or before the cutoff is kept with everything
#                after it, so the full window is restorable; the newest base
#                always survives.
#   LOCK_WAIT  - Seconds to wait for another run's lock before skipping (default: 0)
# ============================================================================

# RETIRED-NODE FENCE: a failover retired this node (the old primary), and the
# CLI placed this marker when it next reached it. Its database is a timeline
# the promoted node has left, and a base backup plus `delete before` from here
# would land in, and prune, the promoted node's backups. Refuse loudly (exit 1,
# never a skip) before anything touches the db container. `vibecarbon deploy`
# rebuilds this node as the standby and removes the marker once it streams.
if [ -f .vibecarbon-retired ]; then
  echo "retired node: backups refused (run vibecarbon deploy to rebuild it as the standby)" >&2
  exit 1
fi

# Prevent concurrent backups (cron + a manual run racing each other).
# LOCK_WAIT (seconds, default 0) is an opt-in bounded wait for the lock: 0 is
# today's behaviour (a held lock is an immediate skip, which cron wants). The
# first base after a promotion (src/lib/walg/post-promote-backup.js) waits: the
# run holding the lock is a fast standby-role skip or the very push it wants,
# never a reason to call its own push done. VC_BACKUP_LOCKFILE exists for the
# script tests only.
LOCKFILE="${VC_BACKUP_LOCKFILE:-/tmp/vibecarbon-backup.lock}"
LOCK_WAIT="${LOCK_WAIT:-0}"
[[ "$LOCK_WAIT" =~ ^[0-9]+$ ]] || LOCK_WAIT=0
exec 200>"${LOCKFILE}"
if [ "$LOCK_WAIT" -gt 0 ]; then
  flock -w "$LOCK_WAIT" 200
else
  flock -n 200
fi || {
  echo "Backup already running, skipping" >&2
  echo "BACKUP_RESULT=skipped:already-running"
  exit 75
}

RETAIN="${RETAIN:-7}"
# The value is spliced into the db-container script below and into date
# arithmetic there: only a positive whole number of days is accepted.
[[ "$RETAIN" =~ ^[1-9][0-9]*$ ]] || {
  echo "RETAIN must be a positive whole number of days (got: ${RETAIN})" >&2
  exit 1
}

echo "=== Vibecarbon Compose Backup (wal-g) ==="
echo "Started at $(date)"
echo "Retain: ${RETAIN} days of base backups"

# wal-g connects to PG via libpq; PGUSER=postgres is REQUIRED (only the
# superuser may call pg_backup_start; unset, libpq defaults to OS user root →
# "role root does not exist"). The pg_is_in_recovery()='f' guard makes the
# backup a skip on a standby (exit 0), so only the primary pushes to S3.
#
# The S3-configured guard exits 0 BEFORE wal-g runs when no S3 backup target is
# configured. docker-compose.yml renders WALG_S3_PREFIX_BASE as
#   s3://${S3_BACKUP_BUCKET:-${S3_BUCKET:-}}/backups/${PROJECT_NAME}/${VC_ENV:-local}/walg
# and walg-env.sh appends the lineage folder, so an unconfigured deploy yields
# the empty-bucket form `s3:///backups/...`
# (and empty AWS_ACCESS_KEY_ID). Without this guard an always-installed cron
# would `set -e`-fail nightly into backup.log on no-S3 deploys. Checking inside
# the container is robust: it tests the actual env wal-g sees (source of truth),
# covers both the cron and on-demand paths, and needs no deploy-time S3 plumbing.
docker compose exec -T db bash -c '
  export PGUSER=postgres PGHOST=localhost PGPORT=5432 PGDATABASE=postgres
  # This database lineage folder (walg-env.sh). A system identifier it cannot
  # read exits 1 with no marker: a refusal, never a push into a guessed folder.
  # WALG_ENV_SH exists for the script tests only.
  . "${WALG_ENV_SH:-/etc/postgresql/walg-env.sh}" || exit 1
  case "${WALG_S3_PREFIX:-}" in
    ""|s3:///*)
      echo "scheduled backup skipped: no S3 backup target configured (empty WALG_S3_PREFIX)."
      echo "BACKUP_RESULT=skipped:no-s3-target"
      exit 0
      ;;
  esac
  if [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
    echo "scheduled backup skipped: no S3 credentials configured (empty AWS_ACCESS_KEY_ID/SECRET)."
    echo "BACKUP_RESULT=skipped:no-s3-credentials"
    exit 0
  fi
  # WRITE-GUARD (finding #3): a standby must never base-backup into the single
  # canonical prefix. WALG_ROLE=standby is set on the standby db env. This closes
  # the bring-up window the pg_is_in_recovery() check below cannot (an
  # independent primary not yet in recovery).
  if [ "${WALG_ROLE:-primary}" = "standby" ]; then
    echo "WALG_ROLE=standby, skipping base backup (only the primary writes to the canonical prefix)."
    echo "BACKUP_RESULT=skipped:standby-role"
    exit 0
  fi
  if [ "$(psql -U postgres -d postgres -tAc "SELECT pg_is_in_recovery()")" != "f" ]; then
    echo "db is in recovery (standby), skipping base backup."
    echo "BACKUP_RESULT=skipped:in-recovery"
    exit 0
  fi
  # BACKUP-PREFIX FENCE (src/lib/deploy/backup-fence.js): a failover wrote
  # vibecarbon-fence.json into this prefix, naming the promoted primary database
  # and the timeline it promoted onto. An old primary that rebooted unreached is
  # the same database on an OLDER timeline: its base backup would become LATEST
  # and its retention would prune the promoted node backups. Refuse loudly.
  # No fence object (an env that never failed over) is allowed; one that cannot
  # be read refuses, since nothing then proves this node is the primary.
  fence="$(wal-g st cat vibecarbon-fence.json 2>&1)" || {
    case "$fence" in
      *"not found in storage"*) fence="" ;;
      *)
        echo "backup refused: could not read the backup-prefix fence (vibecarbon-fence.json): $fence" >&2
        exit 1
        ;;
    esac
  }
  if [ -n "$fence" ]; then
    fence_tl="$(printf %s "$fence" | grep -o "\"timeline\":[0-9]*" | grep -o "[0-9]*$")" || true
    fence_sysid="$(printf %s "$fence" | grep -o "\"systemIdentifier\":\"[0-9]*\"" | grep -o "[0-9][0-9]*")" || true
    local_sysid="$(psql -U postgres -d postgres -tAc "SELECT system_identifier FROM pg_control_system()")" || true
    local_tl="$(psql -U postgres -d postgres -tAc "SELECT substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8)")" || true
    if ! [[ "$fence_tl" =~ ^[0-9]+$ && "$local_sysid" =~ ^[0-9]+$ && "$local_tl" =~ ^[0-9A-Fa-f]{8}$ ]]; then
      echo "backup refused: could not compare this node with the backup-prefix fence (timeline $fence_tl, local $local_tl)" >&2
      exit 1
    fi
    if [ "$local_sysid" = "$fence_sysid" ] && [ "$((16#$local_tl))" -lt "$fence_tl" ]; then
      echo "backup prefix fenced to another primary (timeline $fence_tl): this node is on timeline $((16#$local_tl)), a primary a failover retired; backups refused (run vibecarbon status, then vibecarbon deploy to rebuild it as the standby)" >&2
      exit 1
    fi
  fi
  # The push. wal-g logs to stderr only, and names the base twice: "Started
  # backup with name base_..." when it begins and "Wrote backup with name
  # base_... to storage default" once the sentinel is written (verified on
  # postgres:17.11-walg3.0.9-r2). Only the Wrote line proves a pushed base, so
  # the marker takes its name from that line; a push that exits 0 without it
  # fails rather than guess.
  push_out="$(wal-g backup-push "$PGDATA" 2>&1)" || {
    printf "%s\n" "$push_out" >&2
    exit 1
  }
  printf "%s\n" "$push_out" >&2
  name="$(printf "%s\n" "$push_out" | grep -o "Wrote backup with name base_[0-9A-Za-z_]*" | tail -n 1 | sed "s/^Wrote backup with name //")" || true
  if [ -z "$name" ]; then
    echo "backup-push exited 0 but printed no backup name (no Wrote backup with name line), so nothing proves what landed" >&2
    exit 1
  fi
  echo "BACKUP_RESULT=pushed:$name"
  # RETENTION, a separate step after the marker: the base above is in the
  # bucket whatever happens here, and a failure exits 3 (base pushed,
  # retention failed), never 1. `delete garbage BACKUPS` sweeps
  # sentinel-less orphans (an interrupted backup-push writes its stop-sentinel
  # LAST, so a mid-upload failure leaves data files with no sentinel) BEFORE
  # the delete, which hard-crashes on such an orphan ("object
  # …_backup_stop_sentinel.json not found in storage") on every run until
  # someone deletes it by hand (2026-08-30 RCA: a stale-storage-frontend
  # window orphaned one push and wedged all five retry attempts). Safe under
  # the flock above: no concurrent push on this host can look like an orphan
  # mid-flight.
  # Retention is by TIME and keeps the full RETAIN days. The cutoff is RETAIN
  # days ago; the target is the NEWEST base that finished at or before it, and
  # `delete before FIND_FULL <that base>` removes what precedes it, so that
  # base and its WAL stay: a restore to any moment in the last RETAIN days has
  # its base. No base that old (a young environment): nothing is deleted, and
  # the newest base always survives. (wal-g given a bare timestamp would keep
  # only the first base AFTER it and shorten the window.) The list is parsed
  # without jq (the db image is Alpine busybox, no coreutils or jq): the cutoff
  # is epoch arithmetic, the JSON is split with tr and sed. It acts on this
  # lineage folder only (WALG_S3_PREFIX from walg-env.sh). The fence object
  # lives at the lineage root, outside what the delete touches; it is read
  # back after, and a fence that changed or vanished fails retention loudly.
  RETAIN_DAYS='"${RETAIN}"'
  retain_out="$( { cutoff="$(date -u -d "@$(( $(date +%s) - RETAIN_DAYS * 86400 ))" +%Y-%m-%dT%H:%M:%SZ)" && [ -n "$cutoff" ] && wal-g delete garbage BACKUPS --confirm && list="$(wal-g backup-list --detail --json)" && target="$(printf "%s" "$list" | tr "}" "\n" | sed -n "s/.*\"backup_name\":\"\([^\"]*\)\".*\"finish_time\":\"\([^\"]*\)\".*/\2 \1/p" | awk -v c="$cutoff" "substr(\$1,1,19) <= substr(c,1,19)" | sort | tail -n 1 | cut -d " " -f 2)" && { if [ -n "$target" ]; then wal-g delete before FIND_FULL "$target" --confirm; else echo "no base backup is older than ${RETAIN_DAYS} days, nothing to delete"; fi; } && { [ -z "$fence" ] || [ "$(wal-g st cat vibecarbon-fence.json 2>&1)" = "$fence" ] || { echo "the backup-prefix fence (vibecarbon-fence.json) changed or vanished during retention"; false; }; }; } 2>&1)" || {
    printf "%s\n" "$retain_out" >&2
    echo "retention failed after pushing $name: $(printf "%s\n" "$retain_out" | grep -v "^$" | tail -n 1)" >&2
    exit 3
  }
  printf "%s\n" "$retain_out" >&2
'

echo "=== Backup completed at $(date) ==="
