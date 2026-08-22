# Observability (Prometheus · Grafana · Loki)

This add-on installs a self-contained monitoring stack into your project for
both the Docker Compose and Kubernetes deploy modes.

## What gets installed

| File / dir | Purpose |
|------------|---------|
| `docker-compose.observability.yml` (+ `.prod.yml`, `.override.yml`) | Compose overlay for Prometheus, Grafana, Loki, Promtail, postgres-exporter |
| `volumes/prometheus/`, `volumes/loki/`, `volumes/promtail/`, `volumes/grafana/` | Scrape config, log pipeline, datasources, and dashboards (prod + dev variants) |
| `volumes/db/observability-init.sh` | Creates the least-privilege `observability_ro` Postgres role (see [Security](#security)) |
| `k8s/base/observability/` | Kubernetes manifests + a kustomization, applied as a SEPARATE unit into the `vibecarbon-observability` namespace (NOT wired into `k8s/base/kustomization.yaml` — see [Security](#security)) |

The `observability/` entry is added to `k8s/base/kustomization.yaml`, so a
`kubectl apply -k k8s/base` (run by `vibecarbon deploy` on the k8s tiers) brings
the stack up alongside the app.

## Access

- **Compose:** Grafana at `http://grafana.localhost`, Prometheus at
  `http://prometheus.localhost`, Loki at `http://loki.localhost`. Grafana has **no
  host port** — reach it only through Traefik. In production it sits behind the
  Traefik `super-admin-auth` ForwardAuth middleware (+ TLS): a signed-in
  super_admin is transparently logged into Grafana via the auth proxy. In dev the
  ForwardAuth requirement is dropped, but since anonymous auth is off (see
  [Security](#security)) you sign in with the Grafana admin credentials
  (`ADMIN_EMAIL` / `ADMIN_PASSWORD`).
- **Kubernetes:** the stack runs in the `vibecarbon-observability` namespace.
  Grafana is exposed at `/admin/grafana` behind the Traefik `admin-auth`
  middleware (super-admin SSO). Prometheus (`:9090`) and Loki (`:3100`) stay
  in-cluster. See [Security](#security) for the namespace isolation.

## Security

- **No anonymous access.** `GF_AUTH_ANONYMOUS_ENABLED=false` in every mode.
  Grafana trusts the `X-Authenticated-User` header (the super_admin's email)
  injected by Traefik's ForwardAuth via Grafana's auth-proxy. Traefik strips any
  client-supplied copy of that header and overwrites it with the verified value,
  so it cannot be spoofed through the proxy.
- **Header trust boundary.** `GF_AUTH_PROXY_WHITELIST` restricts which source IPs
  may present the identity header. In compose, Traefik is pinned to a static IP
  (`${DEV_SUBNET_PREFIX:-172.30.0}.10` on `vibecarbon-network` — whitelist,
  static IP, and the base subnet all derive from the same variable) so the
  whitelist is exact. In k8s it is the pod CIDR as defense-in-depth; the real
  control is the NetworkPolicy.
- **Namespace isolation (k8s).** Grafana, Prometheus and Loki run in a dedicated
  `vibecarbon-observability` namespace with default-deny ingress, so only Traefik
  and the app (for `/api/health`) can reach `grafana:3000` — not the other
  workloads in the `vibecarbon` namespace (n8n/metabase/storage/…). Grafana gets a
  SCOPED secret/config (only `ADMIN_EMAIL`/`ADMIN_PASSWORD`/`SITE_URL`; no
  DB/service-role creds cross the boundary). **Residual risk:** only a COMPROMISED
  app pod could still forge the header (its health poll is a required path) —
  bounded, since that pod already holds the service-role key. **This applies to the
  CLI/direct k3s deploy path only.** The stack is applied there as a separate
  kustomization (never under `k8s/base`, whose `namespace: vibecarbon` transformer
  would undo the isolation). On the **gitops/Flux** path observability is NOT
  deployed at all yet — it is kept out of `k8s/base` (which is all Flux reconciles)
  to avoid ever shipping it un-isolated, and its Flux wiring is a tracked follow-up.
  The gitops deploy proceeds but prints a loud warning that observability is absent
  until that lands (`add` warns too on a CI/CD-enabled project). See the HIGH-1
  addendum in the security-remediation-design spec.
- **Least-privilege datasource role.** The postgres-exporter and Grafana's
  PostgreSQL datasource authenticate as `observability_ro` (granted `pg_monitor`
  only — read access to `pg_stat_*`/settings, **no** SELECT on application
  tables), not the `supabase_admin` superuser. The role is created by
  `volumes/db/observability-init.sh` on first DB init and its password is the
  generated `OBSERVABILITY_DB_PASSWORD`. **Caveat:** like every
  `docker-entrypoint-initdb.d` script, it runs only when the database is first
  initialized — adding observability to a project with an existing db volume
  requires `vibecarbon reset` (or manual role creation) before the exporter and
  datasource can authenticate. On k8s there is no postgres-exporter and the
  PostgreSQL datasource is omitted (the shipped dashboards use only
  Prometheus/Loki).

## Removing

`vibecarbon remove observability` deletes the installed configs and the
kustomization entry. Persisted volume data (Grafana DB, Prometheus/Loki storage)
is left in place.
