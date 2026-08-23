# Observability Integration

This guide covers the optional observability stack for Vibecarbon: **Prometheus**, **Grafana**, and **Loki**.

## Overview

The observability stack provides:

| Component | Purpose | Port |
|-----------|---------|------|
| **Prometheus** | Metrics collection and storage | 9090 (internal) |
| **Grafana** | Dashboards and visualization | grafana.localhost (dev, via Traefik) / grafana.domain.com (prod) |
| **Loki** | Log aggregation | 3100 (internal) |
| **Promtail** | Docker log shipper | 9080 (internal) |
| **postgres-exporter** | PostgreSQL metrics | 9187 (internal) |

## Quick Start

### Add Observability to Your Project

Run the following CLI command to add the observability stack:

```bash
vibecarbon add observability
```

### Local Development

To enable observability locally:

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

Access Grafana at: **http://grafana.localhost** (via Traefik — Grafana no longer
publishes a host port). Anonymous access is disabled, so sign in with the Grafana
admin credentials (`GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD`, defaulting to
your `ADMIN_EMAIL` / `ADMIN_PASSWORD`).

### Production

For production deployments, the workflow automatically includes:
- `docker-compose.observability.yml` (base services)
- `docker-compose.observability.prod.yml` (SSL subdomain routing)

Access Grafana at: **https://grafana.yourdomain.com**

### Kubernetes (k8s / k8s-ha tiers)

`vibecarbon add observability` also installs the Kubernetes manifests into
`k8s/base/observability/` and adds an `observability/` entry to
`k8s/base/kustomization.yaml`. The k8s deploy applies the base kustomization
(`kubectl apply -k k8s/base`), so the stack — Prometheus, Grafana, Loki, and
their RBAC / PVCs / NetworkPolicies — comes up alongside the app with no extra
flags.

On Kubernetes, Grafana is exposed at **`https://<domain>/admin/grafana`** behind
the Traefik `admin-auth` middleware (super-admin SSO). Prometheus (`:9090`) and
Loki (`:3100`) stay in-cluster (ClusterIP). To remove it, run
`vibecarbon remove observability`, which deletes the manifests and the
kustomization entry.

## Accessing Grafana

Grafana is protected by the unified admin SSO system using Traefik ForwardAuth.

### How to Access

1. **Log in to your main app** at `http://localhost:5173/login` with your admin email/password
2. **Navigate to Grafana** at `http://grafana.localhost` (dev) or `https://grafana.yourdomain.com` (prod)
3. ForwardAuth validates your session and grants access automatically

### First-Time Setup

When you create a project with `vibecarbon create`, you provide an admin email and password. This creates a user in Supabase with `role=super_admin` in their app metadata.

If you try to access Grafana without being logged in, you'll be redirected to the login page.

### Adding More Super Admin Users

Grafana (and other admin services) require the `super_admin` role. To grant another user access:
```sql
UPDATE auth.users
SET raw_app_meta_data = raw_app_meta_data || '{"role": "super_admin"}'::jsonb
WHERE email = 'newadmin@example.com';
```

## Pre-configured Dashboards

Three dashboards are provisioned automatically:

### 1. Vibecarbon Overview
- Service health status (up/down)
- Database connections
- Recent logs from all services

### 2. PostgreSQL
- Active connections
- Database size
- Row operations (fetched/inserted/updated/deleted)
- Cache hit ratio
- Connections by database

### 3. Logs
- Log volume by service (bar chart)
- Log volume by level (ERROR, WARN, INFO, DEBUG)
- Full log explorer with search and filtering

## Log Queries with LogQL

Grafana's Explore feature supports LogQL for querying Loki logs.

### Basic Queries

```logql
# All logs from a specific service
{service="app"}

# Logs containing a specific string
{service="app"} |= "error"

# Regex match
{service=~"app|kong"} |~ "(?i)error"

# Exclude lines
{service="db"} != "STATEMENT:"
```

### Filter by Log Level

```logql
# Only errors
{service=~".+"} | level="ERROR"

# Errors and warnings
{service=~".+"} | level=~"ERROR|WARN"
```

### JSON Log Parsing

```logql
# Parse JSON and filter
{service="app"} | json | status >= 500

# Extract specific fields
{service="app"} | json | line_format "{{.method}} {{.path}} - {{.status}}"
```

## Adding Custom Metrics

### Application Metrics

To expose metrics from your Hono app, add a `/api/metrics` endpoint:

```typescript
import { prometheus } from '@hono/prometheus';

// In your Hono app
app.use('*', prometheus());
app.get('/api/metrics', prometheus.collectMetrics);
```

Then uncomment the `app` job in `volumes/prometheus/prometheus.yml`:

```yaml
- job_name: 'app'
  static_configs:
    - targets: ['app:3000']
  metrics_path: '/api/metrics'
```

### Custom Dashboards

1. Create your dashboard in Grafana UI
2. Export as JSON (Dashboard Settings > JSON Model)
3. Save to `volumes/grafana/dashboards/your-dashboard.json`
4. Dashboard auto-loads on next restart

## n8n Integration

When both n8n (project-level) and observability (environment-level) are enabled:

- **Prometheus** automatically scrapes n8n metrics at `n8n:5678/metrics`
- **Promtail** collects n8n container logs via Docker discovery
- All n8n data appears in existing dashboards

To enable n8n metrics, set in n8n environment:
```yaml
N8N_METRICS=true
```

## Configuration Files

| File | Purpose |
|------|---------|
| `volumes/prometheus/prometheus.yml` | Scrape targets and intervals |
| `volumes/loki/loki-config.yml` | Storage and retention settings |
| `volumes/promtail/promtail-config.yml` | Docker log discovery |
| `volumes/grafana/provisioning/datasources/` | Prometheus + Loki datasources |
| `volumes/grafana/provisioning/dashboards/` | Dashboard provider config |
| `volumes/grafana/dashboards/` | Pre-built dashboard JSON files |

## Data Retention

| Component | Default Retention | Config Location |
|-----------|-------------------|-----------------|
| Prometheus | 15 days | `prometheus.yml` (`--storage.tsdb.retention.time`) |
| Loki | 31 days | `loki-config.yml` (`retention_period: 744h`) |
| Grafana | Unlimited | Stored in `grafana_data` volume |

To adjust, modify the respective config files.

## Troubleshooting

### Prometheus Targets Down

Check if services are running:
```bash
docker compose ps
```

View Prometheus targets:
- Navigate to http://localhost:9090/targets (dev)
- Or check Grafana > Explore > Prometheus > `up`

### No Logs in Loki

1. Check Promtail is running:
   ```bash
   docker logs ${PROJECT_NAME}-promtail
   ```

2. Verify Docker socket access:
   ```bash
   docker exec ${PROJECT_NAME}-promtail ls -la /var/run/docker.sock
   ```

3. Check Loki is receiving data:
   ```bash
   curl http://localhost:3100/ready
   ```

### Grafana Can't Connect to Datasources

Verify services are on the same Docker network:
```bash
docker network inspect vibecarbon-network
```

Test connectivity from Grafana container:
```bash
docker exec ${PROJECT_NAME}-grafana wget -qO- http://prometheus:9090/-/ready
docker exec ${PROJECT_NAME}-grafana wget -qO- http://loki:3100/ready
```

## Best Practices

1. **Don't expose Prometheus/Loki publicly** - They have no authentication by default
2. **Monitor disk usage** - Metrics and logs consume storage over time
3. **Set up alerts** - Configure Grafana alerting for critical metrics
4. **Adjust retention** based on your compliance/debugging needs
5. **Use labels wisely** in Loki - High cardinality labels impact performance
