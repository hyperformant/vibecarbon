# HTTP-01 everywhere

Decided by Brandon on 2026-11-04, after a night of probes against DigitalOcean DNS.

## Why

- **DNS-01 breaks itself.** Traefik's lego (compose) and cert-manager (k8s) both look up `_acme-challenge.<domain>` with an SOA query, to find the zone, before they create the TXT record. DigitalOcean's nameservers then hide that record for anywhere from 64 s to more than 420 s on the edges that took the lookup. A record nobody looked up first is served by all three nameservers within 0.3 s, in 6 of 6 trials. Let's Encrypt fails whenever its validators land on a poisoned edge, so failures are intermittent. The 90 s settle floor only shortened the odds.
- **The apex and wildcard share one challenge name.** cert-manager runs them one after the other, and the second waits out caches of the first: 63 s then 133 s in run rd1d4.
- **cert-manager's DigitalOcean cleanup deletes every TXT record at that name**, whatever its value.
- **Teardown can poison the next deploy.** Deleting DNS while an ACME client is still mid-validation left the next deploy on the same name with up to 30 minutes of NXDOMAIN, because the SOA minimum is 1800.

## What

1. Every certificate validates with HTTP-01, in all four modes (compose, compose-ha, k8s, k8s-ha) and for every DNS provider.
2. Certificates list explicit names; there are no wildcards.
   - k8s and k8s-ha route by path on the apex, so their certificate covers the apex only.
   - compose and compose-ha keep their routing. The apex certificate stays. The default certificate covers `traefik.<domain>` plus the enabled feature hosts: `grafana.<domain>`, `n8n.<domain>` and `metabase.<domain>`.
3. No `_acme-challenge` TXT records, settle floors, DNS-01 solvers or webhooks, and no DNS provider API tokens on servers or in clusters. The CLI keeps managing A records from the operator's machine.
4. One issuer pair on k8s: `letsencrypt-prod` and `letsencrypt-staging`, both HTTP-01 through the Traefik ingress class. The HA standby keeps `vibecarbon-standby-selfsigned` until it is promoted.
5. Only the side DNS points at may solve ACME, since only it can pass HTTP-01. That means the compose-ha single-active issuer and the k8s-ha standby self-signed issuer. On failover, the ACME issuer is armed or promoted after the DNS flip.
6. Teardown never deletes DNS records while an ACME client can still be validating. Every mode tears down compute first and DNS last.
7. Each e2e run uses DNS names no earlier run has used. A destroyed name stays poisoned for up to 30 minutes, and a fixed name also hits Let's Encrypt's limit of 5 identical certificates per week.

## Tradeoff accepted

There is no wildcard certificate. A subdomain a customer adds to their own app must be added to the name list. vibecarbon's own features are listed automatically.
