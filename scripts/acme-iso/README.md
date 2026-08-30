# ACME DNS-01 isolation harness

Reproduces the compose template's exact Traefik resolver config (apex router
cert + wildcard default-store cert, LE staging) against a throwaway
subdomain — locally, with zero droplets. DNS-01 needs no inbound
connectivity, so one trial measures real end-to-end issuance on the real
zone in minutes instead of a 45–90 min scenario run.

Built during the 2026-08-29/30 DigitalOcean cert campaign (issue #11);
validation: with the shipped tuning (90s settle floor, 300s propagation
window) both certs issued in ~110s on DO DNS.

```bash
cd scripts/acme-iso
ENV_FILE=../../tests/.env.e2e \
  DOMAIN=isoX$(date +%H%M).do.appcarbon.dev \
  DELAY=90s TIMEOUT=300 BUDGET=600 ./trial.sh
```

- `DELAY` → `dnschallenge.propagation.delayBeforeChecks`; `TIMEOUT` →
  `DO_PROPAGATION_TIMEOUT`. A/B them to calibrate the values in
  `src/lib/dns-provider.js`'s `legoTuningEnv`.
- Use a UNIQUE subdomain per trial (fresh `_acme-challenge` name — no
  contention with CI's cid* names or a concurrent trial).
- The token is read from ENV_FILE at runtime and never stored here.
