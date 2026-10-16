#!/usr/bin/env bash
# Smoke test for the db image (docker/postgres-walg), run by
# .github/workflows/native-multiarch-image.yml on each arch's own runner
# BEFORE that arch is pushed, and again against the published tag.
#
# A real start on this arch: both binaries execute, then initdb into a tmp
# dir, the server up with the baked config (so shared_preload_libraries loads
# pg_cron.so), then CREATE EXTENSION. pg_ctl -w waits for readiness itself.
#
# Usage: smoke-db-image.sh <image ref>
# Lives outside docker/postgres-walg on purpose: every file there is an image
# input (tests/unit/deploy/db-image-fingerprint.test.ts).
set -euo pipefail
IMAGE=${1:?usage: smoke-db-image.sh <image ref>}
docker run --rm --entrypoint postgres "$IMAGE" --version
docker run --rm --entrypoint wal-g "$IMAGE" --version
docker run --rm -i --user postgres --entrypoint bash "$IMAGE" -euo pipefail <<'SH'
initdb -D /tmp/pgdata -U postgres --auth=trust >/dev/null
pg_ctl -D /tmp/pgdata -w -o "-c config_file=/etc/postgresql/postgresql.conf -c listen_addresses=" start
psql -U postgres -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION pg_cron'
test "$(psql -U postgres -tAc "SELECT count(*) FROM pg_extension WHERE extname = 'pg_cron'")" = 1
pg_ctl -D /tmp/pgdata -w stop
SH
