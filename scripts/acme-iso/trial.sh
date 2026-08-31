#!/bin/bash
# One issuance trial:
#   PROVIDER=<digitalocean|vultr> MODE=<split|combined> DOMAIN=<sub> \
#     DELAY=<dur> TIMEOUT=<secs> ./trial.sh
# MODE=split (default) mirrors the shipped template: store-wildcard cert +
# router-apex cert = TWO concurrent ACME orders sharing one _acme-challenge
# name. MODE=combined is the candidate fix: one order, apex main + wildcard
# san. Prints per-name issuance times; exits 0 iff BOTH names are covered.
set -euo pipefail
cd "$(dirname "$0")"
DOMAIN="${DOMAIN:?}"; DELAY="${DELAY:-90s}"; TIMEOUT="${TIMEOUT:-300}"
BUDGET="${BUDGET:-600}"; PROVIDER="${PROVIDER:-digitalocean}"; MODE="${MODE:-split}"
case "$MODE" in
  combined)
    # No store default cert — the router's combined order is the ONLY order.
    printf "tls:\n  stores:\n    default: {}\n" > volumes/traefik/tls-default.yml
    sed "s/ISODOMAIN/${DOMAIN}/" volumes/traefik/router-combined.yml.tpl > volumes/traefik/router.yml
    ;;
  disjoint)
    # No wildcard anywhere: apex + studio.<domain> each get their own order
    # at their own _acme-challenge name.
    printf "tls:\n  stores:\n    default: {}\n" > volumes/traefik/tls-default.yml
    sed "s/ISODOMAIN/${DOMAIN}/" volumes/traefik/router-disjoint.yml.tpl > volumes/traefik/router.yml
    ;;
  *)
    sed "s/ISODOMAIN/${DOMAIN}/" volumes/traefik/tls-default.yml.tpl > volumes/traefik/tls-default.yml
    sed "s/ISODOMAIN/${DOMAIN}/" volumes/traefik/router.yml.tpl > volumes/traefik/router.yml
    ;;
esac
# In disjoint mode the second expected name is studio.<domain>, not the wildcard.
SECOND="\*.$DOMAIN"; [ "$MODE" = "disjoint" ] && SECOND="studio.$DOMAIN"
# Fresh per-trial ACME store OUTSIDE the repo (root-owned acme.json inside
# the tree breaks census walks and user-level cleanup — see compose file).
ACME_STORE_DIR="$(mktemp -d /tmp/acme-iso-XXXXXX)"
export ACME_STORE_DIR
# Token read at runtime from ENV_FILE, single-quote-stripped, NEVER echoed.
case "$PROVIDER" in
  vultr)
    TOKEN_VAR=VULTR_API_KEY; TOKEN_SRC=VULTR_API_TOKEN; TIMEOUT_VAR=VULTR_PROPAGATION_TIMEOUT ;;
  hetzner)
    TOKEN_VAR=HETZNER_API_TOKEN; TOKEN_SRC=HETZNER_API_TOKEN; TIMEOUT_VAR=HETZNER_PROPAGATION_TIMEOUT ;;
  digitalocean)
    TOKEN_VAR=DO_AUTH_TOKEN; TOKEN_SRC=DIGITALOCEAN_API_TOKEN; TIMEOUT_VAR=DO_PROPAGATION_TIMEOUT ;;
  *) echo "unsupported PROVIDER=$PROVIDER" >&2; exit 2 ;;
esac
env "$TOKEN_VAR=$(grep "^${TOKEN_SRC}=" "${ENV_FILE:?}" | cut -d= -f2- | sed -e s/^.// -e s/.$//)" \
  ACME_DNS_PROVIDER="$PROVIDER" \
  ACME_DNS_DELAY_BEFORE_CHECKS="$DELAY" "$TIMEOUT_VAR=$TIMEOUT" \
  docker compose up -d --force-recreate 2>/dev/null
START=$(date +%s)
APEX=""; WILD=""
while true; do
  NOW=$(( $(date +%s) - START ))
  CERTS=$(docker compose exec -T traefik cat /letsencrypt/acme.json 2>/dev/null | python3 -c '
import json,sys
try:
  d=json.load(sys.stdin)
  for c in (d.get("letsencrypt",{}).get("Certificates") or []):
    print(c["domain"].get("main",""))
    for s in (c["domain"].get("sans") or []):
      print(s)
except Exception: pass' || true)
  echo "$CERTS" | grep -qx "$DOMAIN" && [ -z "$APEX" ] && APEX=$NOW && echo "APEX issued at +${NOW}s"
  echo "$CERTS" | grep -qx "$SECOND" && [ -z "$WILD" ] && WILD=$NOW && echo "SECOND NAME ($SECOND) issued at +${NOW}s"
  if [ -n "$APEX" ] && [ -n "$WILD" ]; then echo "TRIAL PASS domain=$DOMAIN delay=$DELAY timeout=$TIMEOUT apex=${APEX}s wildcard=${WILD}s"; docker compose down 2>/dev/null; exit 0; fi
  if [ "$NOW" -ge "$BUDGET" ]; then
    echo "TRIAL FAIL domain=$DOMAIN delay=$DELAY timeout=$TIMEOUT after ${BUDGET}s (apex=${APEX:-none} wildcard=${WILD:-none})"
    docker compose logs traefik 2>&1 | grep -E "ERR|Unable|urn:" | tail -6
    docker compose down 2>/dev/null; exit 1
  fi
  sleep 5
done
