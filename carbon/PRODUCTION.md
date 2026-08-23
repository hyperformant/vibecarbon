# Production Deployment Guide

This guide explains the differences between local development and production deployments.

## Deploying to production

```bash
vibecarbon deploy
```

is the supported path to production. It provisions servers on your chosen cloud provider via Pulumi, configures DNS and TLS, syncs environment variables and secrets, sets up S3-compatible backup storage, and starts the services — all from one command.

See the in-app deployment guide (`content/docs/deployment.mdx`, rendered at `/docs/deployment`) for the full flow, provider options, and Kubernetes/HA modes. The rest of this document describes the production **stack** — the services and settings that differ between local and production regardless of how you deploy — plus an appendix on what `vibecarbon deploy` does under the hood.

## Architecture Differences

### Local Development
**Goal**: Fast startup, minimal resources, easy debugging

Services included:
- ✓ Core Supabase stack (Auth, Database, Storage, Realtime, REST API)
- ✓ Development tools (Studio, Meta)
- ✓ Basic networking

**Start command:**
```bash
npm run docker:up
# or
docker compose up -d
```

### Production
**Goal**: Performance, reliability, scalability

Additional services:
- ✓ **Supavisor** - Connection pooling (handles 1000+ concurrent connections)
- ✓ **Edge Functions** - Serverless function runtime
- ✓ **Resource limits** - Prevents resource exhaustion
- ✓ **Optimized settings** - Production-tuned configurations

**Start command:**
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

## Key Differences

### 1. Connection Pooling (Supavisor)

**Local**: Direct database connections
- Simpler debugging
- Lower latency
- No connection limits needed

**Production**: Supavisor pooler for EXTERNAL clients only
- Handles 1000+ concurrent external connections efficiently (`POOLER_MAX_CLIENT_CONN`)
- Connection pooling (default: 15 per pool)
- Session mode on port 5432, transaction mode on port 6543 (Supavisor's defaults, pinned explicitly via `PROXY_PORT_SESSION` / `PROXY_PORT_TRANSACTION` in `docker-compose.prod.yml`)
- The internal Supabase stack (auth, rest, realtime, storage, meta) always connects **directly** to `db:5432` — a transaction pooler breaks realtime's replication slot, PostgREST's NOTIFY-based schema reload, and migration advisory locks

```bash
# Internal services (fixed — do not route these through the pooler)
DATABASE_URL=postgres://postgres:password@db:5432/postgres

# External clients via Supavisor (BI tools, Metabase, Prisma, one-off scripts,
# serverless). The username carries the tenant id: postgres.<PROJECT_NAME>

# Session mode (port 5432) — prepared statements, LISTEN/NOTIFY, session state:
DATABASE_URL=postgres://postgres.my-app:password@yourdomain.com:5432/postgres

# Transaction mode (port 6543) — short stateless queries, serverless workers:
DATABASE_URL=postgres://postgres.my-app:password@yourdomain.com:6543/postgres
```

> **Firewall:** the pooler ports are locked to your operator CIDR allowlist —
> the same list that guards SSH — never opened to the internet (this is
> password auth straight into Postgres). Connecting from a new machine or a
> BI server? Allowlist it first: `vibecarbon access add <ip>/32`.

> The pooler is exercised end-to-end on every compose e2e run (tenant routing
> through both modes + external reachability through the operator firewall).

### 2. Edge Functions

**Local**: Not included (use your Hono API for custom logic)
- Faster startup
- Simpler stack

**Production**: Edge Functions runtime available
- Run Deno/TypeScript functions
- Webhook handlers
- Scheduled tasks
- Custom API endpoints

```typescript
// Example edge function: functions/hello-world/index.ts
Deno.serve((req) => {
  return new Response(JSON.stringify({ message: "Hello World!" }), {
    headers: { "Content-Type": "application/json" },
  });
});
```

### 3. Resource Limits

**Local**: No limits
- Use whatever resources you have
- Services compete for resources

**Production**: Hard limits enforced
- Database: 4GB RAM, 2 CPUs
- API services: 512MB RAM, 1 CPU
- Prevents one service from consuming all resources
- Predictable performance

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
SUPABASE_URL=http://localhost:8000

# No SMTP (emails logged to console)
SMTP_HOST=
SMTP_PORT=
```

### Production (.env.production)
```bash
# Production URLs — ONE public origin: the apex serves the app, the Hono API,
# and the Supabase gateway (Traefik path-routes /auth/v1, /rest/v1,
# /realtime/v1, /storage/v1 to Kong). SUPABASE_URL is the server-side
# (in-network) Kong address, never a public host.
SITE_URL=https://yourdomain.com
SUPABASE_URL=http://kong:8000

# Real SMTP
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=your_api_key

# S3 storage (required for production)
STORAGE_BACKEND=s3
S3_BUCKET=your-bucket
S3_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret
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

# Test connection pooling
psql postgres://postgres:password@localhost:5432/postgres
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

### Connection Pooler Stats
```bash
# Supavisor metrics
curl http://localhost:9999/metrics
```

### View Logs
```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f supavisor
```

## Troubleshooting

### Too Many Database Connections

**Problem**: "remaining connection slots are reserved"

**Solution**: Use Supavisor in production
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### Out of Memory

**Problem**: Services crash with OOM errors

**Solution**: Resource limits in `docker-compose.prod.yml` prevent this
- Database limited to 4GB
- Services limited to 512MB each

### Slow Performance

**Problem**: Queries are slow under load

**Solution**: Connection pooling + resource limits
- Supavisor handles connection overhead
- Resource limits prevent resource starvation

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
For even more performance, run multiple instances behind a load balancer:
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --scale rest=3
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

- [Supavisor Documentation](https://github.com/supabase/supavisor)
- [Edge Functions Guide](https://supabase.com/docs/guides/functions)
- [Docker Compose Production Guide](https://docs.docker.com/compose/production/)
- [Self-Hosting Supabase](https://supabase.com/docs/guides/self-hosting)
