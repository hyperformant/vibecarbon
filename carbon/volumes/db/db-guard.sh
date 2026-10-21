#!/bin/sh
# Entrypoint of the db container: refuse to boot over an interrupted restore,
# then hand over to the image's own entrypoint (db-entrypoint.sh) unchanged.
#
# `vibecarbon restore` fetches the backup into a staging dir inside PGDATA and
# only then swaps it in, with .vc-restore-in-progress in PGDATA for the length
# of the swap. A boot that finds the marker would start postgres on a half
# moved data directory, or initdb an empty one over it. So it stops and says
# what to do; rerunning the restore settles the swap. The restore's own
# container sets RESTORE_BACKUP and passes through.
#
# Invoked as `sh /usr/local/bin/db-guard.sh` (carbon/docker-compose.yml), so
# the scaffold copy's file mode does not matter.
set -eu

PGDATA="${PGDATA:-/var/lib/postgresql/data}"

if [ -z "${RESTORE_BACKUP:-}" ] && [ -e "$PGDATA/.vc-restore-in-progress" ]; then
  echo "restore interrupted; rerun vibecarbon restore" >&2
  exit 1
fi

exec db-entrypoint.sh "$@"
