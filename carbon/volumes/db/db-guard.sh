#!/bin/sh
# Entrypoint of the db container on both tiers: refuse to boot over an
# interrupted restore, apply the k8s wal-g role intent, then hand over to the
# image's own entrypoint (db-entrypoint.sh) unchanged.
#
# `vibecarbon restore` fetches the backup into a staging dir inside PGDATA and
# only then swaps it in, with .vc-restore-in-progress in PGDATA for the length
# of the swap. A boot that finds the marker would start postgres on a half
# moved data directory, or initdb an empty one over it. So it stops and says
# what to do; rerunning the restore settles the swap. The restore's own
# container sets RESTORE_BACKUP and passes through.
#
# Invoked as `sh /usr/local/bin/db-guard.sh` (carbon/docker-compose.yml, and
# the db StatefulSet's `command`, k8s/base/db/statefulset.yaml), so the file
# mode of the scaffold copy or the ConfigMap mount does not matter. The k8s
# copy is the `db-guard.sh` key of the vibecarbon-wal-archive ConfigMap
# (k8s/base/backup/configmap-walg.yaml), byte-identical to this file
# (tests/unit/deploy/walg-archive-script-parity.test.ts).
set -eu

PGDATA="${PGDATA:-/var/lib/postgresql/data}"

if [ -z "${RESTORE_BACKUP:-}" ] && [ -e "$PGDATA/.vc-restore-in-progress" ]; then
  echo "restore interrupted; rerun vibecarbon restore" >&2
  exit 1
fi

# k8s wal-g role intent (ConfigMap vibecarbon-db-role, src/lib/deploy/walg-role.js).
# Compose never sets it. Applied on every container start, so a db pod the CLI
# could not reach comes back with the role the CLI last recorded.
VC_ROLE_DIR="${VC_WALG_ROLE_DIR:-/var/lib/vibecarbon/role}"
if [ -n "${VC_WALG_ROLE_INTENT:-}" ] && [ -d "$VC_ROLE_DIR" ] && [ ! -L "$VC_ROLE_DIR" ]; then
  chown 0:0 "$VC_ROLE_DIR" 2>/dev/null || true
  chmod 0755 "$VC_ROLE_DIR"
  case "$VC_WALG_ROLE_INTENT" in
    primary|standby)
      rm -f "$VC_ROLE_DIR/walg-role.tmp"
      printf '%s\n' "$VC_WALG_ROLE_INTENT" > "$VC_ROLE_DIR/walg-role.tmp"
      chmod 0644 "$VC_ROLE_DIR/walg-role.tmp"
      mv -f "$VC_ROLE_DIR/walg-role.tmp" "$VC_ROLE_DIR/walg-role"
      sync
      ;;
    *)
      echo "db-guard: VC_WALG_ROLE_INTENT is not primary or standby; removing the role file (no role: WAL is held)" >&2
      rm -f "$VC_ROLE_DIR/walg-role"
      ;;
  esac
fi

exec db-entrypoint.sh "$@"
