# Production Deployment Guide

This guide explains the differences between local development and production deployments.

## Deploying to production

```bash
vibecarbon deploy
```

is the supported path to production. It provisions servers on your chosen cloud provider via Pulumi, configures DNS and TLS, syncs environment variables and secrets, sets up S3-compatible backup storage, and starts the services — all from one command.

See the in-app deployment guide (`content/docs/deployment.mdx`, rendered at `/docs/deployment`) for the full flow, provider options, and Kubernetes/HA modes. The rest of this document describes the production **stack** — the services and settings that differ between local and production regardless of how you deploy — plus an appendix on what `vibecarbon deploy` does under the hood.

## Architecture Differences

The same four services run in both places: your Postgres 17 (`db`, with pg_cron and WAL-G), your app (`app`, the Hono API with Better Auth, serving the SPA), Traefik, and in production the Docker socket proxy Traefik reads through. What changes is how they are tuned and exposed.

### Local Development
**Goal**: Fast startup, minimal resources, easy debugging

Services included:
- ✓ Postgres 17, published on `localhost` only
- ✓ Traefik, with the admin tools open (no ForwardAuth) on `*.localhost`
- ✓ Your app, either in Docker or as `npm run dev` (API on :3000, Vite on :5173)
- ✓ A local S3 bucket (Garage) for uploads

**Start command:**
```bash
npm run docker:up
# or
docker compose up -d
```

### Production
**Goal**: Performance, reliability, scalability

What the production overlay adds:
- ✓ **TLS and one public origin** - Traefik terminates HTTPS and sends every public path to the app
- ✓ **ForwardAuth** - The Traefik dashboard and any admin add-on require a `super_admin`
- ✓ **Resource limits** - Prevents one service from starving the others
- ✓ **Backups** - WAL-G archives every WAL segment and takes base backups to your S3 bucket
- ✓ **No public database port** - Postgres listens on the private network only

**Start command:**
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

## Key Differences

### 1. Database Access

**Local**: Postgres on `localhost:5432` (shifted by `DEV_PORT_OFFSET` when you run several projects), so `psql`, Drizzle Studio or any GUI connects directly.

**Production**: Postgres is reachable only on the private network. The app connects to `db:5432` with its own pool (`max: 10` per replica, `src/server/db/client.ts`) against `max_connections=200`. No firewall rule opens 5432 to the internet or to your IP. To run SQL by hand:

```bash
vibecarbon shell            # SSH to the server
docker compose exec db psql -U postgres
```

A BI tool or script that needs the database runs next to it (an add-on such as Metabase, or a job inside the app), never across the internet.

### 2. Resource Limits

**Local**: No limits
- Use whatever resources you have
- Services compete for resources

**Production**: Hard limits enforced (`docker-compose.prod.yml`)
- Database: 4 GB RAM, 2 CPUs
- Traefik: 256 MB RAM, 0.5 CPU
- Docker socket proxy: 128 MB RAM, 0.25 CPU
- The app is not capped, so it can use what the database leaves free

## Configuration Files

```
.
├── docker-compose.yml               # Base (local + production)
├── docker-compose.prod.yml          # Production enhancements
├── docker-compose.observability.yml # Optional: Grafana, Prometheus, Loki (via `vibecarbon add observability`)
├── docker-compose.n8n.yml           # Optional: n8n workflow automation
├── docker-compose.metabase.yml      # Optional: Metabase analytics
├── k8s/                             # Kubernetes manifests with Kustomize overlays
└── k8s/overlays/                    # Optional: HA multi-region overlays
```

### Composition Examples

**Local development:**
```bash
docker compose up -d
```

**Local with n8n:**
```bash
docker compose -f docker-compose.yml -f docker-compose.n8n.yml up -d
# Access: http://n8n.localhost (requires super_admin login)
```

**Local with Metabase:**
```bash
docker compose -f docker-compose.yml -f docker-compose.metabase.yml up -d
# Access: http://metabase.localhost (requires super_admin login)
```

**Local with all optional services:**
```bash
docker compose -f docker-compose.yml \
  -f docker-compose.observability.yml \
  -f docker-compose.n8n.yml \
  -f docker-compose.metabase.yml up -d
```

**Production:**
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

**Production with n8n + Metabase:**
```bash
docker compose -f docker-compose.yml \
  -f docker-compose.prod.yml \
  -f docker-compose.n8n.yml \
  -f docker-compose.metabase.yml up -d
```

## Environment Variables

Most environment variables are the same between local and production. Key differences:

### Local (.env.local)
```bash
# Development URLs
SITE_URL=http://localhost:5173
DB_HOST=localhost

# No SMTP (emails logged to console)
SMTP_HOST=
SMTP_PORT=
```

### Production (.env.production)
```bash
# Production URLs: ONE public origin. The apex serves the app and the Hono
# API (auth included, at /api/auth); nothing else is public.
SITE_URL=https://yourdomain.com

# Real SMTP
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=your_api_key

# S3 storage for uploads (`vibecarbon deploy` provisions the bucket and
# writes these; when any is missing, uploads are disabled and the app still boots)
S3_ENDPOINT=https://your-provider-endpoint
S3_REGION=us-east-1
S3_BUCKET=your-bucket
S3_ACCESS_KEY=your_key
S3_SECRET_KEY=your_secret
```

## Package.json Scripts

These `docker:*` scripts already ship in `package.json`:

| Script | Purpose |
|--------|---------|
| `docker:up` | Start the local stack |
| `docker:up:all` | Start the local stack plus optional services (n8n, Metabase, observability) |
| `docker:down` | Stop the local stack |
| `docker:down:all` | Stop the local stack plus optional services |
| `docker:reset` | Stop the local stack and remove volumes/images |
| `docker:reset:all` | Stop the local stack plus optional services and remove volumes/images |
| `docker:logs` | Tail logs for the running stack |
| `docker:prod:up` | Start the production compose overlay |
| `docker:prod:down` | Stop the production compose overlay |

## Migration Strategy

### 1. Test Locally First
```bash
# Start local stack
npm run docker:up

# Run your application
npm run dev

# Test everything works
```

### 2. Test Production Stack Locally
```bash
# Stop local stack
docker compose down

# Start with production config
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Verify services start correctly
docker compose ps

# Check the database answers
docker compose exec db psql -U postgres -c 'select 1'
```

Once the production stack checks out locally, deploy it with `vibecarbon deploy` (see [Deploying to production](#deploying-to-production) above). For what that command does under the hood, see [Under the hood / manual operation](#under-the-hood--manual-operation).

## Monitoring Production

### Check Service Health
```bash
docker compose ps
```

All services should show "healthy" or "Up".

### Check Resource Usage
```bash
docker stats
```

Monitor CPU, memory, and network usage.

### View Logs
```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f app
```

## Troubleshooting

### Too Many Database Connections

**Problem**: "remaining connection slots are reserved"

**Solution**: Count who holds connections, then fix the holder
```bash
docker compose exec db psql -U postgres -c \
  "select usename, application_name, state, count(*) from pg_stat_activity group by 1,2,3 order by 4 desc"
```
Each app replica holds at most 10. Many idle connections from one client usually means a script or add-on that never closes them.

### Out of Memory

**Problem**: Services crash with OOM errors

**Solution**: Resource limits in `docker-compose.prod.yml` prevent this
- Database limited to 4 GB
- Traefik and the socket proxy limited to 256 MB and 128 MB

### Slow Performance

**Problem**: Queries are slow under load

**Solution**: Find the slow query, then index or scale
- `EXPLAIN ANALYZE` the query over `vibecarbon shell`; add an index for the filter
- Resource limits keep the database's share of the box predictable
- Scale the app tier (`vibecarbon scale`) when the app, not the database, is the bottleneck

## Rate Limiting Considerations

The API server includes built-in rate limiting (100 requests/minute per IP). This uses an in-memory store which works well for:
- Single-server deployments
- Development and testing

### Horizontal Scaling Limitation

When running multiple API instances (Kubernetes deployments), the in-memory rate limiter does not share state across pods. This means:
- Each pod tracks its own request counts
- Users could potentially make 100 * N requests/minute (where N = number of pods)

### Solutions for Multi-Instance Deployments

**Option 1: Use Traefik Rate Limiting (Recommended)**
Configure rate limiting at the ingress level in `volumes/traefik/middlewares.yml`:
```yaml
http:
  middlewares:
    rate-limit:
      rateLimit:
        average: 100
        burst: 200
        period: 1m
```

**Option 2: Add Redis for Shared State**
Add the Redis service and configure the rate limiter to use it:
```bash
vibecarbon add redis
```
Then update the rate limiter configuration to use Redis as the backing store.

**Option 3: External Rate Limiting**
Use Cloudflare Rate Limiting rules if using Cloudflare for DNS/CDN.

## Best Practices

### 1. Always Use Production Config in Production
Never run production with just `docker-compose.yml`.

### 2. Test Production Config Locally
Before deploying, test the full production stack locally.

### 3. Monitor Resource Usage
Use `docker stats` to ensure limits are appropriate.

### 4. Scale Horizontally
For more capacity, resize the server (Compose, blue-green: the app pauses while its database moves) or add workers (Kubernetes, the autoscaler's floor and ceiling):
```bash
vibecarbon scale <env>
```

### 5. Use External Database for Large Deployments
For very large deployments, consider external managed PostgreSQL:
- Better backups
- Automated failover
- Dedicated resources

## Under the hood / manual operation

`vibecarbon deploy` is the recommended way to get the production stack onto a server — it provisions the machine, wires up DNS/TLS, syncs secrets, and starts the services for you. This section shows what it's doing under the hood, useful for debugging a deploy or for air-gapped/manual operation. It is not the recommended path.

```bash
# SSH to your production server
ssh user@your-server

# Clone your repo
git clone your-repo

# Copy production environment variables
cp .env.example .env.production
# Edit .env.production with production values

# Start production stack
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production up -d
```

## Learn More

- [Docker Compose Production Guide](https://docs.docker.com/compose/production/)
- [PostgreSQL 17 Documentation](https://www.postgresql.org/docs/17/)
- [WAL-G for PostgreSQL](https://wal-g.readthedocs.io/PostgreSQL/)
- [Traefik Documentation](https://doc.traefik.io/traefik/)
