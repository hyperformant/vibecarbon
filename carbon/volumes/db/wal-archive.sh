#!/bin/bash
# Fault-tolerant archive_command for Postgres + wal-g.
#
# Standard archive_command (`wal-g wal-push %p`) blocks WAL recycling until it
# succeeds. If wal-g fails for any reason (S3 outage, bad credentials, bucket
# missing, network), pg_wal grows unbounded — combined with archive_timeout
# this fills the disk in days even on an idle DB.
#
# This wrapper:
#   1. Tries `wal-g wal-push` with $RETRIES attempts and exponential backoff.
#   2. On final failure, logs loudly to stderr (visible in the db container's
#      logs) and exits 0 so PG can recycle the segment. PITR coverage degrades
#      for the failed segment; the database stays up.
#
# THIS FILE IS THE SINGLE SOURCE OF TRUTH FOR BOTH DEPLOY TIERS. compose mounts
# it directly; k8s ships a byte-identical copy in the vibecarbon-wal-archive
# ConfigMap (carbon/k8s/base/backup/configmap-walg.yaml), pinned by
# tests/unit/deploy/walg-archive-script-parity.test.ts. Edit here, then re-run
# that test — it prints the exact indented block to paste into the ConfigMap.
#
# Trade-off: a persistent archive outage means a gap in your PITR chain. The
# alternative — letting WAL fill the disk and taking the DB offline — is worse
# for any SaaS template. Monitor for the "WAL_ARCHIVE_FAILED" line to detect
# silent backup regressions.
#
# Invoked by postgres as: wal-archive.sh <wal-file-path>
# %p is passed by Postgres and is the absolute path to the WAL segment.

set -u
WAL_PATH="${1:?archive_command requires a WAL file path}"
RETRIES="${WAL_ARCHIVE_RETRIES:-3}"
SLEEP_BASE="${WAL_ARCHIVE_SLEEP:-2}"

# WRITE-GUARD (finding #3): a standby node must NEVER push WAL into the single
# canonical WALG_S3_PREFIX. WALG_ROLE=standby is set on the standby's db env
# (compose .env / k8s supabase.values.yaml). This closes the bring-up window
# that the pg_is_in_recovery() gate below can't: a freshly-provisioned standby
# db can briefly be an INDEPENDENT primary (not yet in recovery) before it is
# reseeded — WALG_ROLE=standby stops it archiving into the primary's stream even
# then. Exit 0 (not error) so PG recycles the segment instead of pinning WAL.
if [ "${WALG_ROLE:-primary}" = "standby" ]; then
    echo "wal-archive: WALG_ROLE=standby — skipping archive of '${WAL_PATH}' (only the primary writes to the canonical prefix)." >&2
    exit 0
fi

# Recovery gate: a node in recovery (a streaming standby) must NEVER archive
# WAL. Doing so would let a standby write into the shared/canonical WAL stream
# and corrupt the PITR timeline (invisible until a restore during an incident).
# PostgreSQL with archive_mode=on already skips archive_command during recovery,
# but gate explicitly as defense in depth (and in case archive_mode=always is
# ever set, or a split-brain leaves two writers). Only SKIP when we can
# POSITIVELY confirm recovery — never fail-closed in a way that would drop a
# real primary's WAL.
PGDATA_DIR="${PGDATA:-/var/lib/postgresql/data}"
in_recovery=""
if command -v psql >/dev/null 2>&1; then
    in_recovery="$(psql -U "${PGUSER:-supabase_admin}" -d postgres -tAXc 'SELECT pg_is_in_recovery()' 2>/dev/null | tr -d '[:space:]')"
fi
# Fall back to the standby.signal marker if psql couldn't answer (e.g. socket
# not reachable from the archive_command context). Postgres removes this file
# atomically on promotion, so its presence == "still a standby".
if [ -z "$in_recovery" ] && [ -f "${PGDATA_DIR}/standby.signal" ]; then
    in_recovery="t"
fi
if [ "$in_recovery" = "t" ]; then
    echo "wal-archive: node is in recovery (standby) — skipping archive of '${WAL_PATH}' (only the primary archives)." >&2
    exit 0
fi

attempt=1
while [ "$attempt" -le "$RETRIES" ]; do
    if /usr/local/bin/wal-g wal-push "$WAL_PATH"; then
        exit 0
    fi
    if [ "$attempt" -lt "$RETRIES" ]; then
        sleep_for=$((SLEEP_BASE ** attempt))
        sleep "$sleep_for"
    fi
    attempt=$((attempt + 1))
done

# All retries exhausted. Loud, greppable log line so monitoring/alerting can
# catch this — but exit 0 so PG recycles the segment instead of pinning it.
echo "WAL_ARCHIVE_FAILED: wal-g wal-push '$WAL_PATH' failed after $RETRIES attempts; allowing PG to recycle (PITR gap for this segment)" >&2
exit 0
