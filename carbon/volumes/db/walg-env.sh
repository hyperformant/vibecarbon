# The WAL-G prefix of this database's own archive. SOURCED, never executed,
# inside the db container: by wal-archive.sh, the base backup scripts
# (backup/compose-backup.sh, the k8s backup CronJob), the k8s walg-restore
# init, the restore_command a restore writes, and every script the CLI runs
# in the container that calls wal-g.
#
# Each database lineage archives under its own folder of the environment's
# prefix, named by its system identifier (pg_controldata):
#
#   <WALG_S3_PREFIX_BASE>/<system identifier>/{basebackups_005,wal_005,vibecarbon-fence.json}
#
# A destroyed and redeployed environment is a new database with a new system
# identifier, so it never archives into, or takes over the newest base of, the
# archive the old one left. A restore keeps the system identifier, so a
# restored database archives on in the lineage it came from, and a promoted
# standby (a copy of its primary) does too.
#
#   WALG_S3_PREFIX_BASE  the environment's prefix (compose db env, k8s db pod).
#                        Empty means no backup target: WALG_S3_PREFIX is
#                        exported empty, and every script skips as before. A
#                        bucketless s3:///... is passed through as is, for the
#                        same skip.
#   RESTORE_LINEAGE      set by a restore, whose fetch runs before PGDATA holds
#                        the database it names: that lineage's folder.
#   otherwise            the system identifier of the cluster in $PGDATA. One
#                        that cannot be read exits 1: nothing may guess a
#                        folder.
#
# THIS FILE IS THE SINGLE SOURCE OF TRUTH FOR BOTH DEPLOY TIERS. compose mounts
# it at /etc/postgresql/walg-env.sh; k8s ships a byte-identical copy in the
# vibecarbon-wal-archive ConfigMap (carbon/k8s/base/backup/configmap-walg.yaml),
# pinned by tests/unit/deploy/walg-archive-script-parity.test.ts.
# The wal-g WRITE-GUARD role (src/lib/deploy/walg-role.js WALG_ROLE_PARSE_SH,
# carried verbatim): one word in a file OUTSIDE PGDATA (k8s: a sibling subPath
# of the db volume; compose: a host directory bound read-only), so
# pg_basebackup never copies it into a standby. Exactly "primary" or
# "standby"; anything else, a missing file or a symlink is no role, which
# every writer of WAL or base backups treats as "do not write".
# Test seams, for the script tests only: VC_WALG_ROLE_FILE here (the file),
# VC_WALG_ROLE_DIR in db-guard.sh (its directory).
vc_walg_role_file="${VC_WALG_ROLE_FILE:-/var/lib/vibecarbon/role/walg-role}"
VC_WALG_ROLE=""
if [ -f "$vc_walg_role_file" ] && [ ! -L "$vc_walg_role_file" ]; then
    case "$(cat "$vc_walg_role_file" 2>/dev/null)" in
        primary) VC_WALG_ROLE=primary ;;
        standby) VC_WALG_ROLE=standby ;;
    esac
fi
export VC_WALG_ROLE
unset vc_walg_role_file
vc_walg_base="${WALG_S3_PREFIX_BASE:-}"
if [ -z "$vc_walg_base" ]; then
    WALG_S3_PREFIX=""
elif [ "${vc_walg_base#s3:///}" != "$vc_walg_base" ]; then
    # A deploy with no bucket name renders a bucketless base: still no backup
    # target, which every caller skips on, so no folder is read.
    WALG_S3_PREFIX="$vc_walg_base"
elif [ -n "${RESTORE_LINEAGE:-}" ]; then
    case "$RESTORE_LINEAGE" in
        *[!0-9]*)
            echo "walg-env: RESTORE_LINEAGE=$RESTORE_LINEAGE is not a database system identifier" >&2
            exit 1
            ;;
    esac
    WALG_S3_PREFIX="${vc_walg_base}/${RESTORE_LINEAGE}"
else
    vc_walg_pgdata="${PGDATA:-/var/lib/postgresql/data}"
    vc_walg_sysid="$(pg_controldata "$vc_walg_pgdata" 2>/dev/null | awk -F': *' '/Database system identifier/{print $2}')" || vc_walg_sysid=""
    case "$vc_walg_sysid" in
        "" | *[!0-9]*)
            echo "walg-env: no database system identifier in $vc_walg_pgdata" >&2
            exit 1
            ;;
    esac
    WALG_S3_PREFIX="${vc_walg_base}/${vc_walg_sysid}"
fi
export WALG_S3_PREFIX
unset vc_walg_base vc_walg_pgdata vc_walg_sysid
