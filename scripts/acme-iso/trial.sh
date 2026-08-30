#!/bin/bash
# One issuance trial: DOMAIN=<sub> DELAY=<dur> TIMEOUT=<secs> ./trial.sh
# Prints per-cert issuance times; exits 0 iff BOTH apex+wildcard issued.
set -euo pipefail
cd "$(dirname "$0")"
DOMAIN="${DOMAIN:?}"; DELAY="${DELAY:-90s}"; TIMEOUT="${TIMEOUT:-300}"
BUDGET="${BUDGET:-600}"
sed "s/ISODOMAIN/${DOMAIN}/" volumes/traefik/tls-default.yml.tpl > volumes/traefik/tls-default.yml
sed "s/ISODOMAIN/${DOMAIN}/" volumes/traefik/router.yml.tpl > volumes/traefik/router.yml
rm -f letsencrypt/acme.json
DO_AUTH_TOKEN="$(grep "^DIGITALOCEAN_API_TOKEN=" "${ENV_FILE:?}" | cut -d= -f2- | sed -e s/^.// -e s/.$//)" \
  ACME_DNS_DELAY_BEFORE_CHECKS="$DELAY" DO_PROPAGATION_TIMEOUT="$TIMEOUT" \
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
except Exception: pass' || true)
  echo "$CERTS" | grep -qx "$DOMAIN" && [ -z "$APEX" ] && APEX=$NOW && echo "APEX issued at +${NOW}s"
  echo "$CERTS" | grep -qx "\*.$DOMAIN" && [ -z "$WILD" ] && WILD=$NOW && echo "WILDCARD issued at +${NOW}s"
  if [ -n "$APEX" ] && [ -n "$WILD" ]; then echo "TRIAL PASS domain=$DOMAIN delay=$DELAY timeout=$TIMEOUT apex=${APEX}s wildcard=${WILD}s"; docker compose down 2>/dev/null; exit 0; fi
  if [ "$NOW" -ge "$BUDGET" ]; then
    echo "TRIAL FAIL domain=$DOMAIN delay=$DELAY timeout=$TIMEOUT after ${BUDGET}s (apex=${APEX:-none} wildcard=${WILD:-none})"
    docker compose logs traefik 2>&1 | grep -E "ERR|Unable|urn:" | tail -6
    docker compose down 2>/dev/null; exit 1
  fi
  sleep 5
done
