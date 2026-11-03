#!/bin/sh
# vc-reseed-protocol: 1
# Entrypoint of the db container on both tiers: refuse to boot over an
# interrupted restore, apply the k8s wal-g role intent, finish a pending
# in-place standby reseed, then hand over to the image's own entrypoint
# (db-entrypoint.sh) unchanged.
#
# Line 2 is the reseed protocol marker: the CLI greps it in the RUNNING pod's
# mounted copy before it stops postgres for an in-place reseed.
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
      sync
      mv -f "$VC_ROLE_DIR/walg-role.tmp" "$VC_ROLE_DIR/walg-role"
      sync
      ;;
    *)
      echo "db-guard: VC_WALG_ROLE_INTENT is not primary or standby; removing the role file (no role: WAL is held)" >&2
      rm -f "$VC_ROLE_DIR/walg-role"
      ;;
  esac
fi

# Pending in-place reseed (src/lib/deploy/replication.js reseedStandbyInPlace).
# A swap STARTS only on a standby (VC_WALG_ROLE_INTENT=standby) whose staged
# tree proves itself and carries the ready marker's attempt id. One already
# under way always finishes or rolls back: half way is no bootable tree.
# Every move fails the script (never skipped), and each phase checks it left
# nothing behind before the marker moves on, so a crash or a failed move at
# any point leaves the old tree or the whole new one, never a mix.
R_STAGE="$PGDATA/.vc-reseed"; R_READY="$PGDATA/.vc-reseed-ready"
R_MARK="$PGDATA/.vc-reseed-in-progress"; R_DONE="$PGDATA/.vc-reseeded-from"; R_DISC="$PGDATA/.vc-discard"
# A marker is replaced by rename between two syncs: every move before it is on
# disk before it, and it is on disk before the next move.
vc_put() { rm -f "$1.tmp"; printf '%s' "$2" > "$1.tmp"; sync; mv -f "$1.tmp" "$1"; sync; }
vc_cluster() { find "$PGDATA" -mindepth 1 -maxdepth 1 ! -name '.vc-*'; }
if [ -e "$R_MARK" ] || [ -e "$R_READY" ] || [ -L "$R_MARK" ] || [ -L "$R_READY" ]; then
  for f in "$R_MARK" "$R_READY" "$R_STAGE" "$R_DISC" "$PGDATA/.vc-restore.lock"; do
    if [ -L "$f" ]; then echo "db-guard: $f is a symlink; refusing" >&2; exit 1; fi
  done
  exec 9>"$PGDATA/.vc-restore.lock"
  flock -n 9 || { echo "db-guard: a restore holds $PGDATA/.vc-restore.lock; refusing" >&2; exit 75; }
  state=""
  if [ -e "$R_MARK" ]; then
    state="$(cat "$R_MARK")"
    case "$state" in
      "out "?*|"in "?*) ;;
      *) echo "db-guard: $R_MARK holds an unknown reseed state '$state'; refusing to boot (no tree is moved). The old cluster is in $PGDATA or $R_DISC: run vibecarbon restore, or move $R_DISC's entries back into $PGDATA and remove $R_MARK, $R_READY and $R_STAGE" >&2; exit 1 ;;
    esac
  fi
  if [ -z "$state" ]; then
    id="$(cat "$R_READY" 2>/dev/null || true)"
    # A staged tree carries no .vc-* but its own id: pg_basebackup copies them
    # from a source that was once a standby, and one moved in would clobber a
    # marker or wedge the move. A find that fails counts as carrying one.
    vc_extra="$(find "$R_STAGE" -mindepth 1 -maxdepth 1 -name '.vc-*' ! -name '.vc-reseed-id' 2>&1)" || vc_extra="unreadable"
    if [ "${VC_WALG_ROLE_INTENT:-}" = standby ] && [ -n "$id" ] && [ -z "$vc_extra" ] \
      && [ "$(cat "$R_STAGE/.vc-reseed-id" 2>/dev/null || true)" = "$id" ] \
      && [ -f "$R_STAGE/PG_VERSION" ] && [ -f "$R_STAGE/standby.signal" ] \
      && grep -q '^[[:space:]]*primary_conninfo' "$R_STAGE/postgresql.auto.conf" 2>/dev/null; then
      rm -rf "$R_DISC"
      vc_put "$R_MARK" "out $id"; state="out $id"
    else
      echo "db-guard: RESEED_REFUSED: no standby intent, or the staged tree does not prove itself (attempt '${id}'); booting the existing data directory" >&2
      rm -rf "$R_STAGE"; rm -f "$R_READY" "$R_READY.tmp"
    fi
  fi
  case "$state" in
    "out "*)
      id="${state#out }"
      if [ ! -f "$R_STAGE/PG_VERSION" ]; then
        if [ -d "$R_DISC" ]; then
          find "$R_DISC" -mindepth 1 -maxdepth 1 | while IFS= read -r e; do mv "$e" "$PGDATA/" || exit 1; done
          left="$(find "$R_DISC" -mindepth 1 -maxdepth 1)"
          if [ -n "$left" ]; then echo "db-guard: $R_DISC still holds entries after the roll back; refusing" >&2; exit 1; fi
          rmdir "$R_DISC"
        fi
        sync
        rm -rf "$R_STAGE"; rm -f "$R_READY" "$R_MARK"
        echo "db-guard: RESEED_ROLLED_BACK $id: staging incomplete, the previous data directory is back" >&2
        state=""
      else
        mkdir -p "$R_DISC"
        vc_cluster | while IFS= read -r e; do mv "$e" "$R_DISC/" || exit 1; done
        left="$(vc_cluster)"
        if [ -n "$left" ]; then echo "db-guard: the old cluster did not fully move to $R_DISC; refusing" >&2; exit 1; fi
        vc_put "$R_MARK" "in $id"; state="in $id"
      fi
      ;;
  esac
  case "$state" in
    "in "*)
      id="${state#in }"
      if [ -d "$R_STAGE" ]; then
        find "$R_STAGE" -mindepth 1 -maxdepth 1 ! -name '.vc-reseed-id' | while IFS= read -r e; do mv "$e" "$PGDATA/" || exit 1; done
        left="$(find "$R_STAGE" -mindepth 1 -maxdepth 1 ! -name '.vc-reseed-id')"
        if [ -n "$left" ]; then echo "db-guard: $R_STAGE did not fully move in; refusing" >&2; exit 1; fi
        rm -rf "$R_STAGE"
      fi
      if [ ! -f "$PGDATA/PG_VERSION" ]; then
        echo "db-guard: reseed $id moved in no PG_VERSION; refusing to boot. The old cluster is in $R_DISC: run vibecarbon restore, or replace what the reseed moved into $PGDATA with $R_DISC's entries and remove $R_MARK and $R_READY" >&2
        exit 1
      fi
      vc_put "$R_DONE" "$id"
      rm -f "$R_READY" "$R_MARK"
      echo "db-guard: RESEED_SWAPPED $id" >&2
      ;;
  esac
  exec 9>&-
fi

exec db-entrypoint.sh "$@"
