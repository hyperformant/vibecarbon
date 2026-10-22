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
#   */30 * * * * cd <project-dir> && bash backup/tls-retry.sh <apex> >> <project-dir>/backups/tls-retry.log 2>&1
#
# Invoked as `bash backup/tls-retry.sh <apex>`: the apex rides on the cron
# line (validated by setupComposeBackupCron, re-checked here), so no shell
# here parses .env.
#
# Each run, in order:
#   1. A retired node (.vibecarbon-retired): nothing to issue, exit 0.
#   2. No valid apex argument: nothing to retry for, exit 0.
#   3. No running traefik container: nothing to restart, exit 0.
#   4. A disarmed issuer (compose-ha standby, src/lib/deploy/acme-role.js):
#      exit 0. Read from the RUNNING container command, never from .env.
#   5. acme.json already holds a certificate whose "main" is the apex: done,
#      the restart counter resets, exit 0. The first run that sees it also
#      runs backup/tls-snapshot.sh once, so the certificate is saved before
#      the next nightly backup. acme.json is only ever grep -q-ed inside the
#      traefik container; its content never reaches this output.
#   6. The apex does not resolve to this host ("deploy first, point DNS
#      after"): waiting for DNS, exit 0, neither restarting nor counting. A
#      host with no public address of its own (behind NAT) cannot tell, so it
#      does not gate.
#   7. 48 restarts already (24 hours of retries once DNS points here): giving
#      up, exit 0. A permanently broken setup stops costing Let's Encrypt
#      orders; `vibecarbon status` shows it, and the next deploy clears the
#      counter.
#   8. A Traefik younger than 15 minutes: leave it alone, exit 0. A restart
#      abandons an in-flight DNS-01 order, and a second order on the same
#      _acme-challenge name meets cached DNS answers (the DNS-01 settle
#      doctrine). The settle floor itself is not touched here.
#   9. Otherwise count the restart and run `docker compose restart traefik`.
#
# Rate limit: each restart places the apex and wildcard orders. Two restarts
# an hour on their own stay at 4 failed validations per hostname per hour,
# under the Let's Encrypt limit of 5, but in the first hour the deploy's own
# orders come on top and can pass it. Let's Encrypt then refuses new orders
# for that hostname until the hour rolls over; a later tick retries, so it
# heals by itself.
#
# Logging: a state is logged only when it changes (backups/tls-retry.state),
# so a healthy env adds nothing to tls-retry.log every 30 minutes. Every
# restart is logged; there are at most 48.
# ============================================================================

MAX_RESTARTS=48
MIN_TRAEFIK_AGE_SECONDS=900
COUNT_FILE=backups/tls-retry.count
STATE_FILE=backups/tls-retry.state

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) tls-retry: $*"
}

# note <state> <message>: log the message only when the state changed.
# Returns 0 when it changed, 1 when it did not.
note() {
  local last=""
  if [ -f "$STATE_FILE" ]; then
    read -r last < "$STATE_FILE" || true
  fi
  if [ "$last" != "$1" ]; then
    log "$2"
    mkdir -p backups
    printf '%s\n' "$1" > "$STATE_FILE"
    return 0
  fi
  return 1
}

if [ -f .vibecarbon-retired ]; then
  note retired "retired node, nothing to issue"
  exit 0
fi

domain="${1:-}"
if ! [[ "$domain" =~ ^[A-Za-z0-9.-]+$ ]]; then
  note no-apex "no valid apex domain argument, nothing to retry"
  exit 0
fi

traefik="$(docker compose ps -q traefik 2>/dev/null)" || traefik=""
if [ -z "$traefik" ]; then
  note no-traefik "traefik is not running, nothing to retry"
  exit 0
fi

cmd="$(docker inspect -f '{{json .Config.Cmd}}' "$traefik" 2>/dev/null)" || cmd=""
case "$cmd" in
  "")
    note no-cmd "could not read the traefik command, not restarting"
    exit 0
    ;;
  *acme-disarmed.invalid*)
    note disarmed "issuer disarmed on this node (compose-ha standby), nothing to issue"
    exit 0
    ;;
esac

apex_re="$(printf '%s' "$domain" | sed 's/[.]/\\./g')"
if docker compose exec -T traefik grep -Eq "\"main\": ?\"${apex_re}\"" /letsencrypt/acme.json; then
  rm -f "$COUNT_FILE"
  if note present "certificate for ${domain} is present"; then
    # First tick that sees it: save the snapshot now, so a certificate this
    # retry landed is in the bucket before the next nightly backup. Output to
    # stderr (the log); its status never changes this run.
    bash backup/tls-snapshot.sh >&2 || true
  fi
  exit 0
fi

# Does the apex resolve to this host? Compared against the host's own
# addresses (hostname -I). IPv6 counts only when the host has a global IPv6;
# getent ahostsv6 maps A records to ::ffff: addresses, which are dropped.
host_addrs=" $(hostname -I 2>/dev/null || true) "
host_public_v4=0
host_v6=0
for a in $host_addrs; do
  case "$a" in
    fe80:* | fc* | fd*) ;;
    *:*) host_v6=1 ;;
    10.* | 127.* | 169.254.* | 192.168.*) ;;
    172.1[6-9].* | 172.2[0-9].* | 172.3[01].*) ;;
    100.6[4-9].* | 100.[7-9][0-9].* | 100.1[01][0-9].* | 100.12[0-7].*) ;;
    *) host_public_v4=1 ;;
  esac
done
if [ "$host_public_v4" = 1 ] || [ "$host_v6" = 1 ]; then
  points_here=0
  for r in $(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u); do
    case "$host_addrs" in *" $r "*) points_here=1 ;; esac
  done
  if [ "$host_v6" = 1 ]; then
    for r in $(getent ahostsv6 "$domain" 2>/dev/null | awk '{print $1}' | grep -v '^::ffff:' | sort -u); do
      case "$host_addrs" in *" $r "*) points_here=1 ;; esac
    done
  fi
  if [ "$points_here" = 0 ]; then
    note waiting-dns "waiting for DNS: ${domain} does not point here"
    exit 0
  fi
fi

count=0
if [ -f "$COUNT_FILE" ]; then
  read -r count < "$COUNT_FILE" || [ -n "$count" ] || count=0
fi
[[ "$count" =~ ^[0-9]+$ ]] || count=0
if [ "$count" -ge "$MAX_RESTARTS" ]; then
  note gave-up "no certificate for ${domain} after ${count} restarts, giving up (run vibecarbon deploy once the ACME error in docker compose logs traefik is fixed)"
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
  note no-age "could not read when traefik started, not restarting"
  exit 0
fi
age=$(($(date -u +%s) - start_s))
if [ "$age" -lt "$MIN_TRAEFIK_AGE_SECONDS" ]; then
  note young "traefik started ${age}s ago, letting its ACME order finish"
  exit 0
fi

count=$((count + 1))
mkdir -p backups
printf '%s\n' "$count" > "$COUNT_FILE"
printf '%s\n' restart > "$STATE_FILE"
log "no certificate for ${domain} yet, restarting traefik to retry issuance (${count} of ${MAX_RESTARTS})"
if ! docker compose restart traefik; then
  log "traefik restart failed"
  exit 1
fi
