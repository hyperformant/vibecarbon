#!/bin/bash
set -u

# ============================================================================
# Vibecarbon TLS retry: compose certificate issuance scheduling
#
# Traefik never retries a failed first issuance on its own: a new domain keeps
# the Traefik default certificate "until Traefik is restarted" (Traefik ACME
# docs, Fallback). A deploy whose first look at TLS found no trusted
# certificate finishes with TLS pending (src/lib/deploy/tls-ready.js), and
# this script, run by cron every 30 minutes, restarts Traefik until the apex
# certificate lands. It is installed by setupComposeBackupCron
# (src/lib/deploy/compose/index.js) beside the backup cron:
#
#   */30 * * * * cd <project-dir> && bash backup/tls-retry.sh >> <project-dir>/backups/tls-retry.log 2>&1
#
# Each run, in order:
#   1. A retired node (.vibecarbon-retired): nothing to issue, exit 0.
#   2. No running traefik container: nothing to restart, exit 0.
#   3. A disarmed issuer (compose-ha standby, src/lib/deploy/acme-role.js):
#      exit 0. Read from the RUNNING container command, never from .env.
#   4. acme.json already holds a certificate whose "main" is the apex: done,
#      the restart counter resets, exit 0. acme.json is only ever grep -q-ed
#      inside the traefik container; its content never reaches this output.
#   5. 48 restarts already (24 hours): giving up, exit 0. A permanently broken
#      DNS setup stops costing Let's Encrypt orders; `vibecarbon status` shows
#      it, and the next deploy clears the counter.
#   6. A Traefik younger than 15 minutes: leave it alone, exit 0. A restart
#      abandons an in-flight DNS-01 order, and a second order on the same
#      _acme-challenge name meets cached DNS answers (the DNS-01 settle
#      doctrine). The settle floor itself is not touched here.
#   7. Otherwise count the restart and run `docker compose restart traefik`.
#
# Rate limit: each restart places the apex and wildcard orders, so two
# restarts an hour stay at 4 failed validations per hostname per hour, under
# the Let's Encrypt limit of 5.
#
# The apex is read from the app router rule on the running app container
# (Host(`<domain>`)), so no shell here parses .env.
# ============================================================================

MAX_RESTARTS=48
MIN_TRAEFIK_AGE_SECONDS=900
COUNT_FILE=backups/tls-retry.count

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) tls-retry: $*"
}

if [ -f .vibecarbon-retired ]; then
  log "retired node, nothing to issue"
  exit 0
fi

traefik="$(docker compose ps -q traefik 2>/dev/null)" || traefik=""
if [ -z "$traefik" ]; then
  log "traefik is not running, nothing to retry"
  exit 0
fi

cmd="$(docker inspect -f '{{json .Config.Cmd}}' "$traefik" 2>/dev/null)" || cmd=""
case "$cmd" in
  "")
    log "could not read the traefik command, not restarting"
    exit 0
    ;;
  *acme-disarmed.invalid*)
    log "issuer disarmed on this node (compose-ha standby), nothing to issue"
    exit 0
    ;;
esac

app="$(docker compose ps -q app 2>/dev/null)" || app=""
rule=""
if [ -n "$app" ]; then
  rule="$(docker inspect -f '{{index .Config.Labels "traefik.http.routers.app.rule"}}' "$app" 2>/dev/null)" || rule=""
fi
domain="$(printf '%s\n' "$rule" | sed -n 's/^Host(`\([A-Za-z0-9.-]*\)`)$/\1/p')"
if [ -z "$domain" ]; then
  log "could not read the apex domain from the app router, not restarting"
  exit 0
fi

apex_re="$(printf '%s' "$domain" | sed 's/[.]/\\./g')"
if docker compose exec -T traefik grep -Eq "\"main\": ?\"${apex_re}\"" /letsencrypt/acme.json; then
  rm -f "$COUNT_FILE"
  log "certificate for ${domain} is present"
  exit 0
fi

count=0
if [ -f "$COUNT_FILE" ]; then
  read -r count < "$COUNT_FILE" || count=0
fi
[[ "$count" =~ ^[0-9]+$ ]] || count=0
if [ "$count" -ge "$MAX_RESTARTS" ]; then
  log "no certificate for ${domain} after ${count} restarts, giving up (run vibecarbon deploy once the ACME error in docker compose logs traefik is fixed)"
  exit 0
fi

# StartedAt is RFC 3339 with nanoseconds (2026-10-21T10:00:00.123456789Z).
# Cut it to "YYYY-MM-DD hh:mm:ss", which GNU and busybox date both parse.
started="$(docker inspect -f '{{.State.StartedAt}}' "$traefik" 2>/dev/null)" || started=""
started="${started%%.*}"
started="${started%Z}"
started="${started/T/ }"
start_s=""
if [ -n "$started" ]; then
  start_s="$(date -u -d "$started" +%s 2>/dev/null)" || start_s=""
fi
if ! [[ "$start_s" =~ ^[0-9]+$ ]]; then
  log "could not read when traefik started, not restarting"
  exit 0
fi
age=$(($(date -u +%s) - start_s))
if [ "$age" -lt "$MIN_TRAEFIK_AGE_SECONDS" ]; then
  log "traefik started ${age}s ago, letting its ACME order finish"
  exit 0
fi

count=$((count + 1))
mkdir -p backups
printf '%s\n' "$count" > "$COUNT_FILE"
log "no certificate for ${domain} yet, restarting traefik to retry issuance (${count} of ${MAX_RESTARTS})"
if ! docker compose restart traefik; then
  log "traefik restart failed"
  exit 1
fi
