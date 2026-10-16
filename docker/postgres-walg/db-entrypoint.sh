#!/usr/bin/env bash
# Entrypoint for vibecarbon's db image: the official docker-entrypoint.sh,
# with WAL archiving kept off the init-time temporary server.
#
# WHY: on a fresh volume the official entrypoint runs initdb, then starts a
# TEMPORARY server (socket only) to apply POSTGRES_PASSWORD and any init
# scripts, then stops it with `pg_ctl -w stop` before exec-ing the real
# server. It starts that temporary server with the SAME arguments as the real
# one, so the deploy's `-c archive_mode=on -c archive_command=...` applied to
# it too. A server that is shutting down with archiving on must first archive
# every completed WAL segment. With the backup bucket unreachable (wrong
# endpoint, network down, bucket not created yet) each segment waits out
# wal-archive.sh's attempts, the stop outlasts pg_ctl's wait, the entrypoint
# exits non-zero, and the container crashes once before its second start
# finds an initialized PGDATA and skips init.
#
# FIX: append `-c archive_mode=off` to the temporary server's arguments. The
# official script already appends its own overrides after ours
# (listen_addresses='' and the port), and the last `-c` for a setting wins.
# Nothing the temporary server writes needs archiving: it exists only before
# the first base backup, and PITR starts from a base backup. The real server
# starts with exactly the arguments the deploy passed, archiving included.
#
# HOW: the official script is written to be sourced (it only runs _main when
# executed directly), so this wrapper sources it, renames its
# docker_temp_server_start to upstream_docker_temp_server_start, and wraps it.
#
# One step has to happen here instead of inside _main: started as root, _main
# prepares PGDATA and then re-executes ITS OWN FILE ("$BASH_SOURCE", i.e.
# docker-entrypoint.sh) as the postgres user, which would drop this wrapper
# and its override. So the wrapper does that root step itself, with the same
# two upstream functions, and re-executes "$0" (this file) instead. Everything
# else, initdb, the hba rules, the password, init scripts, stays upstream's.
# tests/integration/docker/db-first-boot.test.ts proves the result.
set -Eeo pipefail

# shellcheck source=/dev/null
source /usr/local/bin/docker-entrypoint.sh

if [ "${1:0:1}" = '-' ]; then
	set -- postgres "$@"
fi

if [ "$1" = 'postgres' ] && [ "$(id -u)" = '0' ] && ! _pg_want_help "$@"; then
	docker_setup_env
	docker_create_db_directories
	exec gosu postgres "$0" "$@"
fi

eval "upstream_$(declare -f docker_temp_server_start)"

docker_temp_server_start() {
	upstream_docker_temp_server_start "$@" -c archive_mode=off
}

_main "$@"
