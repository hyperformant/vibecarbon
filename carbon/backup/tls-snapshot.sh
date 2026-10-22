#!/bin/bash
set -uo pipefail
umask 077

# ============================================================================
# Vibecarbon TLS snapshot: save this server's certificate to the backups bucket
#
# A new or promoted server restores the snapshot instead of asking Let's
# Encrypt again (src/lib/deploy/tls-snapshot.js reads and validates it). Run
# from the project dir, like compose-backup.sh:
#
#   cd /opt/<project> && bash backup/tls-snapshot.sh
#
# compose-backup.sh runs it after every pushed base backup (with stdout sent
# to stderr), and `vibecarbon deploy` runs it once TLS is trusted. Every skip
# exits 0; only a failed upload exits non-zero.
#
# acme.json holds the private key. It is streamed from the traefik container
# straight into `wal-g st put -s` in the db container, which already holds the
# bucket credentials: no copy on the host, never on argv, never printed. The
# object lands at <TLS_SNAPSHOT_S3_PREFIX>/compose-acme.json, uncompressed and
# unencrypted, so the CLI reads it back with a plain GetObject.
#
# A snapshot is written only when it is worth keeping, so a worse file never
# replaces a good one:
#   1. never from a retired node (.vibecarbon-retired);
#   2. only with a valid TLS_SNAPSHOT_S3_PREFIX and TLS_SNAPSHOT_DOMAIN. Both
#      are traefik service env (docker-compose.prod.yml), interpolated from
#      .env by compose; this script never parses .env;
#   3. never from a disarmed issuer (compose-ha standby,
#      src/lib/deploy/acme-role.js), read from the RUNNING traefik command;
#   4. never from a standby-role db (WALG_ROLE=standby);
#   5. only when acme.json holds a certificate whose "main" is the apex.
#      Traefik writes only certificates the CA issued there, and the reader
#      checks the chain, the names and the time left before it restores one.
#
# Output: one line on stderr, never stdout, and never a backup result marker
# (compose-backup.sh prints the only one).
# ============================================================================

# Seconds the upload may take (acme.json is a few KB; a healthy put takes
# about a second). VC_TLS_UPLOAD_TIMEOUT_S exists for the script tests only.
UPLOAD_TIMEOUT_S="${VC_TLS_UPLOAD_TIMEOUT_S:-120}"
[[ "$UPLOAD_TIMEOUT_S" =~ ^[1-9][0-9]*$ ]] || UPLOAD_TIMEOUT_S=120

skip() {
  echo "tls snapshot skipped: $*" >&2
  exit 0
}

if [ -f .vibecarbon-retired ]; then
  skip "retired node"
fi

prefix="$(docker compose exec -T traefik printenv TLS_SNAPSHOT_S3_PREFIX 2>/dev/null)" || prefix=""
if ! [[ "$prefix" =~ ^s3://[A-Za-z0-9.-]+/[A-Za-z0-9._/-]+$ ]]; then
  skip "no valid TLS_SNAPSHOT_S3_PREFIX on the traefik service"
fi

domain="$(docker compose exec -T traefik printenv TLS_SNAPSHOT_DOMAIN 2>/dev/null)" || domain=""
if ! [[ "$domain" =~ ^[A-Za-z0-9.-]+$ ]]; then
  skip "no valid TLS_SNAPSHOT_DOMAIN on the traefik service"
fi

traefik="$(docker compose ps -q traefik 2>/dev/null)" || traefik=""
if [ -z "$traefik" ]; then
  skip "traefik is not running"
fi
cmd="$(docker inspect -f '{{json .Config.Cmd}}' "$traefik" 2>/dev/null)" || cmd=""
case "$cmd" in
  "") skip "could not read the traefik command" ;;
  *acme-disarmed.invalid*) skip "issuer disarmed on this node (compose-ha standby)" ;;
esac

role="$(docker compose exec -T db printenv WALG_ROLE 2>/dev/null)" || role=""
if [ "$role" = "standby" ]; then
  skip "WALG_ROLE=standby (only the primary writes snapshots)"
fi

apex_re="$(printf '%s' "$domain" | sed 's/[.]/\\./g')"
if ! docker compose exec -T traefik grep -Eq "\"main\": ?\"${apex_re}\"" /letsencrypt/acme.json; then
  skip "acme.json holds no certificate for ${domain}"
fi

dest="${prefix}/compose-acme.json"
# Bounded, so a hung exec never holds the backup lock compose-backup.sh took.
# The upload's bound is the shorter one: if the read hangs, the upload is
# killed first and never completes an object from a short stream.
if timeout "$((UPLOAD_TIMEOUT_S + 10))" docker compose exec -T traefik cat /letsencrypt/acme.json |
  timeout "$UPLOAD_TIMEOUT_S" docker compose exec -T -e "WALG_S3_PREFIX=${prefix}" db wal-g st put -s -f --no-compress --no-encrypt compose-acme.json >&2; then
  echo "tls snapshot saved to ${dest}" >&2
else
  up_rc=$?
  if [ "$up_rc" -eq 124 ] || [ "$up_rc" -eq 143 ]; then
    echo "tls snapshot upload failed: ${dest} timed out after ${UPLOAD_TIMEOUT_S}s" >&2
  else
    echo "tls snapshot upload failed: ${dest} was not written (see the wal-g error above)" >&2
  fi
  exit 1
fi
