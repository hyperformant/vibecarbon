#!/bin/bash
# Fault-tolerant archive_command for Postgres + wal-g.
#
# This wrapper:
#   1. Tries `wal-g wal-push` with $RETRIES attempts and exponential backoff.
#   2. On final failure, logs WAL_ARCHIVE_FAILED to stderr (the db container's
#      logs) and exits 1: postgres keeps the segment and retries it, and
#      pg_stat_archiver's failed_count / last_failed_time show the failure
#      (vibecarbon status turns red). No segment is lost to a bucket outage.
#   3. Drops a segment (exit 0) only under disk pressure: when the pg_wal
#      filesystem has less than 10% or less than 2 GiB free, a held segment
#      would take the database down with the disk. It logs WAL_ARCHIVE_DROPPED
#      and appends `<segment> <UTC time>` to $PGDATA/vibecarbon-wal-gap, the
#      durable record vibecarbon status reads (a restore across a dropped
#      segment stops at it). The next pushed base backup clears the entries
#      older than itself (backup/compose-backup.sh, the k8s backup CronJob).
#   4. Refuses (exit 1) on a node a failover retired: its PGDATA carries the
#      vibecarbon-retired marker, or the backup prefix's fence object names
#      its database on a newer timeline.
#
# THIS FILE IS THE SINGLE SOURCE OF TRUTH FOR BOTH DEPLOY TIERS. compose mounts
# it directly; k8s ships a byte-identical copy in the vibecarbon-wal-archive
# ConfigMap (carbon/k8s/base/backup/configmap-walg.yaml), pinned by
# tests/unit/deploy/walg-archive-script-parity.test.ts. Edit here, then re-run
# that test — it prints the exact indented block to paste into the ConfigMap.
#
# Trade-off: during a bucket outage pg_wal grows until the outage ends or the
# disk-pressure guard trips; only then is there a PITR gap, and it is recorded.
#
# Invoked by postgres as: wal-archive.sh <wal-file-path>
# %p is passed by Postgres and is the absolute path to the WAL segment.

set -u
WAL_PATH="${1:?archive_command requires a WAL file path}"
RETRIES="${WAL_ARCHIVE_RETRIES:-3}"
SLEEP_BASE="${WAL_ARCHIVE_SLEEP:-2}"
PGDATA_DIR="${PGDATA:-/var/lib/postgresql/data}"
# The durable record of segments dropped under disk pressure (see above).
WAL_GAP_FILE="${PGDATA_DIR}/vibecarbon-wal-gap"
# The wal-g binary. WAL_ARCHIVE_WALG exists for the script tests only (a stub
# in place of the real binary); nothing in a deploy sets it.
WALG="${WAL_ARCHIVE_WALG:-/usr/local/bin/wal-g}"

# RETIRED-NODE FENCE: a failover retired this node (the old primary), and the
# CLI placed this marker in PGDATA when it next reached it. Its WAL belongs to a
# timeline the promoted node has left, and the backup prefix is the promoted
# node's now. It exits 1 on purpose: a refused push fails loudly (postgres
# logs every retry) rather than reading as a skip. The
# reseed that rebuilds this node as the standby replaces PGDATA and the marker
# with it. Checked first, before any other guard, psql or wal-g.
if [ -f "${PGDATA_DIR}/vibecarbon-retired" ]; then
    echo "wal-archive: retired node: backups refused, not archiving '${WAL_PATH}' (run vibecarbon deploy to rebuild it as the standby)." >&2
    exit 1
fi

# WRITE-GUARD (finding #3): a standby node must NEVER push WAL into the single
# canonical WALG_S3_PREFIX. WALG_ROLE=standby is set on the standby's db env
# (compose .env / k8s db/statefulset.yaml). This closes the bring-up window
# that the pg_is_in_recovery() gate below can't: a freshly-provisioned standby
# db can briefly be an INDEPENDENT primary (not yet in recovery) before it is
# reseeded — WALG_ROLE=standby stops it archiving into the primary's stream even
# then. Exit 0 (not error) so PG recycles the segment instead of pinning WAL.
if [ "${WALG_ROLE:-primary}" = "standby" ]; then
    echo "wal-archive: WALG_ROLE=standby — skipping archive of '${WAL_PATH}' (only the primary writes to the canonical prefix)." >&2
    exit 0
fi

# THIS DATABASE'S ARCHIVE FOLDER: walg-env.sh turns WALG_S3_PREFIX_BASE into
# WALG_S3_PREFIX, the folder of this database's lineage (its system
# identifier), so a recreated database never archives into, or fences, the
# archive an earlier one left. Sourced before anything reads the prefix. A
# system identifier it cannot read, or a missing walg-env.sh (bash would carry
# on with no prefix and skip the segment as "no backup target"), exits 1:
# postgres retries the segment rather than drop it or archive it into a
# guessed folder. WALG_ENV_SH exists for the
# script tests only (the backup scripts read the same name), like WAL_ARCHIVE_WALG.
. "${WALG_ENV_SH:-/etc/postgresql/walg-env.sh}" || exit 1

# No backup target: nothing to push to. Local dev sets WALG_S3_PREFIX_BASE to
# "" (docker-compose.override.yml), which walg-env.sh turns into an empty
# WALG_S3_PREFIX, and a deploy with no bucket name renders a bucketless
# "s3:///..." prefix. Without this, every segment waits out the
# wal-g attempts below and logs WAL_ARCHIVE_FAILED. Same guard as
# backup/compose-backup.sh; a real deploy without archiving is still failed
# by the deploy's wal-g audit (src/lib/deploy/walg-audit.js).
case "${WALG_S3_PREFIX:-}" in
    ""|s3:///*)
        echo "wal-archive: no backup target (WALG_S3_PREFIX='${WALG_S3_PREFIX:-}'), not archiving '${WAL_PATH}'." >&2
        exit 0
        ;;
esac

# Recovery gate: a node in recovery (a streaming standby) must NEVER archive
# WAL. Doing so would let a standby write into the shared/canonical WAL stream
# and corrupt the PITR timeline (invisible until a restore during an incident).
# PostgreSQL with archive_mode=on already skips archive_command during recovery,
# but gate explicitly as defense in depth (and in case archive_mode=always is
# ever set, or a split-brain leaves two writers). Only SKIP when we can
# POSITIVELY confirm recovery — never fail-closed in a way that would drop a
# real primary's WAL.
in_recovery=""
if command -v psql >/dev/null 2>&1; then
    in_recovery="$(psql -U "${PGUSER:-postgres}" -d postgres -tAXc 'SELECT pg_is_in_recovery()' 2>/dev/null | tr -d '[:space:]')"
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

# BACKUP-PREFIX FENCE: a failover wrote vibecarbon-fence.json into this prefix,
# naming the promoted primary's database, the timeline it promoted onto and the
# segment that timeline branched in. An old primary that rebooted unreached is
# the same database on an OLDER timeline: its segments from the branch on
# would land in, and fork, the promoted node's stream. The segment's timeline
# is the first 8 hex digits of its name, its number the next 16. Segments of
# the parent timeline before the branch are history both timelines share (an
# archive backlog at a planned failover), and the .history and .partial files
# are what a promotion itself archives, so those pass. No fence object (an env that never failed
# over) or another database is allowed; a fence that cannot be read falls
# through to the push, which fails the same way.
WAL_NAME="$(basename "$WAL_PATH")"
case "$WAL_NAME" in
    *.history|*.partial) ;;
    *)
        fence="$("$WALG" st cat vibecarbon-fence.json 2>/dev/null)"
        fence_tl="$(printf '%s' "$fence" | grep -o '"timeline":[0-9]*' | grep -o '[0-9]*$')"
        fence_sysid="$(printf '%s' "$fence" | grep -o '"systemIdentifier":"[0-9]*"' | grep -o '[0-9][0-9]*')"
        fence_switch="$(printf '%s' "$fence" | grep -o '"switchSegment":"[0-9A-F]\{16\}"' | grep -o '[0-9A-F]\{16\}')"
        seg_tl="${WAL_NAME:0:8}"
        seg_no="${WAL_NAME:8:16}"
        before_switch=0
        # Only on the PARENT timeline (the one the switch point is on); any
        # older timeline, and any fence without a switch point, refuses.
        if [ -n "$fence_switch" ] && [ -n "$fence_tl" ] && [[ "$seg_tl" =~ ^[0-9A-Fa-f]{8}$ ]] \
            && [ "$((16#$seg_tl))" -eq "$((fence_tl - 1))" ] && [[ "$seg_no" =~ ^[0-9A-F]{16}$ ]]; then
            # Numerically, in two 32-bit halves (log id, segment).
            s_hi=$((16#${seg_no:0:8})); s_lo=$((16#${seg_no:8:8}))
            f_hi=$((16#${fence_switch:0:8})); f_lo=$((16#${fence_switch:8:8}))
            if [ "$s_hi" -lt "$f_hi" ] || { [ "$s_hi" -eq "$f_hi" ] && [ "$s_lo" -lt "$f_lo" ]; }; then
                before_switch=1
            fi
        fi
        if [ "$before_switch" = 0 ] && [ -n "$fence_tl" ] && [[ "$seg_tl" =~ ^[0-9A-Fa-f]{8}$ ]] && [ "$((16#$seg_tl))" -lt "$fence_tl" ]; then
            local_sysid=""
            if command -v psql >/dev/null 2>&1; then
                local_sysid="$(psql -U "${PGUSER:-postgres}" -d postgres -tAXc 'SELECT system_identifier FROM pg_control_system()' 2>/dev/null | tr -d '[:space:]')"
            fi
            if [ -z "$local_sysid" ] || [ "$local_sysid" = "$fence_sysid" ]; then
                echo "wal-archive: backup prefix fenced to another primary (timeline ${fence_tl}): not archiving '${WAL_PATH}' from timeline $((16#$seg_tl)) (a failover retired this node; run vibecarbon status, then vibecarbon deploy to rebuild it as the standby)." >&2
                exit 1
            fi
        fi
        ;;
esac

attempt=1
while [ "$attempt" -le "$RETRIES" ]; do
    push_out="$("$WALG" wal-push "$WAL_PATH" 2>&1)"
    push_rc=$?
    [ -n "$push_out" ] && printf '%s\n' "$push_out" >&2
    if [ "$push_rc" -eq 0 ]; then
        exit 0
    fi
    # WALG_PREVENT_WAL_OVERWRITE: the archive already holds this segment name
    # with other bytes. No retry can change that, so no backoff either: say so
    # on its own line, then give the segment up like any other failure.
    case "$push_out" in
        *"already archived, contents differ"*)
            echo "WAL_ARCHIVE_OVERWRITE_REFUSED: wal-g refused to overwrite '$WAL_PATH': the archive already holds this segment name with other bytes (WALG_PREVENT_WAL_OVERWRITE); check for a second writer on this lineage" >&2
            echo "WAL_ARCHIVE_FAILED: wal-g wal-push '$WAL_PATH' refused (overwrite); allowing PG to recycle (PITR gap for this segment)" >&2
            exit 0
            ;;
    esac
    if [ "$attempt" -lt "$RETRIES" ]; then
        sleep_for=$((SLEEP_BASE ** attempt))
        sleep "$sleep_for"
    fi
    attempt=$((attempt + 1))
done

# All retries exhausted. Hold the segment (exit 1: postgres retries it, and
# pg_stat_archiver shows the failure) unless the pg_wal filesystem is nearly
# full: under 10% or under 2 GiB free. A full disk stops the database, which
# is worse than the PITR gap a dropped segment leaves, so only then is the
# segment given up, with a durable record. Free space that cannot be read
# holds the segment. VC_WAL_GUARD_FREE_BYTES and VC_WAL_GUARD_TOTAL_BYTES
# exist for the script tests only.
wal_fs="$(df -Pk "${PGDATA_DIR}/pg_wal" 2>/dev/null | awk 'NR == 2 { print $2, $4 }')"
total_kb="${wal_fs%% *}"
free_kb="${wal_fs##* }"
if [[ "${VC_WAL_GUARD_TOTAL_BYTES:-}" =~ ^[0-9]+$ ]]; then
    total_kb=$((VC_WAL_GUARD_TOTAL_BYTES / 1024))
fi
if [[ "${VC_WAL_GUARD_FREE_BYTES:-}" =~ ^[0-9]+$ ]]; then
    free_kb=$((VC_WAL_GUARD_FREE_BYTES / 1024))
fi
if [[ "$total_kb" =~ ^[0-9]+$ && "$free_kb" =~ ^[0-9]+$ ]] \
    && { [ "$free_kb" -lt $((2 * 1024 * 1024)) ] || [ "$((free_kb * 10))" -lt "$total_kb" ]; }; then
    printf '%s %s\n' "$WAL_NAME" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$WAL_GAP_FILE"
    echo "WAL_ARCHIVE_DROPPED: wal-g wal-push '$WAL_PATH' failed after $RETRIES attempts and pg_wal has $((free_kb / 1024)) MiB free (under 10% or 2 GiB): dropping it so the disk does not fill (PITR gap, recorded in $WAL_GAP_FILE)" >&2
    exit 0
fi
echo "WAL_ARCHIVE_FAILED: wal-g wal-push '$WAL_PATH' failed after $RETRIES attempts; keeping the segment, postgres retries it" >&2
exit 1
