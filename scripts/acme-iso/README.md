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
  the provider's `*_PROPAGATION_TIMEOUT`. A/B them to calibrate the values
  in `src/lib/dns-provider.js`'s `legoTuningEnv`.
- `PROVIDER` selects the lego DNS provider + token: `digitalocean`
  (default, `DIGITALOCEAN_API_TOKEN` → `DO_AUTH_TOKEN`) or `vultr`
  (`VULTR_API_TOKEN` → `VULTR_API_KEY`). Pick a `DOMAIN` under a zone that
  provider actually hosts (do.appcarbon.dev / threvidence.com).
- `MODE` selects the cert-request shape under test:
  - `split` (default) — the SHIPPED template: store-wildcard cert +
    router-apex cert = two concurrent orders sharing one `_acme-challenge`
    name.
  - `combined` — one order, apex main + wildcard SAN (two TXT values at one
    name, presented together).
  - `disjoint` — no wildcard: apex + `studio.<domain>` each get their own
    order at their own challenge name.
- Use a UNIQUE subdomain per trial (fresh `_acme-challenge` name — no
  contention with CI's cid* names or a concurrent trial).
- The token is read from ENV_FILE at runtime and never stored here.

2026-08-30 Vultr findings (issue #14 RCA): Vultr's authoritative frontends
NEGATIVELY CACHE a name queried before its record lands — an unqueried TXT
record serves in <=5s, but one pre-creation dig leaves the same name dark
for minutes. So with `DELAY=0s` EVERY mode fails (lego's first check
poisons its own challenge name — split, combined, and disjoint all
NXDOMAIN'd in trials), and the shape of the cert request was never the
root cause. Fix = the vultr `legoTuningEnv` row (60s delayBeforeChecks
floor + 300s propagation window). Two harness gotchas this implies:
use a FRESH subdomain per trial (a failed trial's names stay poisoned for
minutes), and never hand-dig a challenge name mid-trial before lego's
floor has elapsed — your own query poisons it.
