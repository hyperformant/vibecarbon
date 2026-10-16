# Vibecarbon Technical Documentation

Complete technical reference for developing with Vibecarbon.

---

## Tech Stack

### Core Stack (100% Self-hosted)

| Layer | Technologies | Description |
|-------|--------------|-------------|
| **Frontend** | React 19 + Vite + Shadcn UI | Ultra-fast development with modern styling |
| **Backend** | Hono 4 + Node.js | Lightweight API framework (~13KB) with full type safety |
| **Auth** | Better Auth (in the Hono app) | Email + password, magic links, Google/Microsoft OAuth, MFA; sessions are HttpOnly cookies |
| **Database** | PostgreSQL 17 (pg_cron, WAL-G) + Drizzle ORM | Your own Postgres; the API server queries it directly; Row Level Security on every table |
| **Storage** | Any S3-compatible bucket | Uploads go straight to the bucket through presigned URLs (Garage locally) |
| **Orchestration** | Docker Compose + Kubernetes | Container orchestration with auto-scaling |
| **Proxy** | Traefik | Reverse proxy with automatic HTTPS |
| **Tooling** | Biome + TypeScript | Fast linting/formatting with full type safety |

### Optional Components

| Layer | Technologies | Description |
|-------|--------------|-------------|
| **HA/Failover** | Postgres streaming replication | Manual failover, two regions. k8s-ha: pilot-light standby (2-node idle floor, cold app tier, IaC worker provisioning at failover, convergent role reconciliation via deploy). compose-ha: always-warm two-VPS standby, its own failover path |
| **Observability** | Prometheus + Grafana + Loki | Metrics, dashboards, and log aggregation (`vibecarbon add observability`) |
| **Cache** | Redis | Shared rate-limit counters across app replicas, plus a cache or queue you build on it (`vibecarbon add redis`) |

---

## Architecture

### Generated Project Structure

```
my-app/
├── src/
│   ├── client/                  # React 19 SPA (Vite)
│   │   ├── components/ui/       # 52+ Shadcn UI components
│   │   ├── components/auth/     # AuthProvider (session, sign-in, MFA)
│   │   ├── pages/               # Route pages (Home, Login, Dashboard)
│   │   ├── hooks/               # Custom React hooks
│   │   └── lib/                 # api.ts, auth-client.ts, utils.ts
│   ├── server/                  # Hono API (Node.js)
│   │   ├── auth/                # Better Auth instance, mounted at /api/auth
│   │   ├── db/                  # client.ts (withUserDb, adminDb), schema.ts, migrate.ts
│   │   ├── routes/              # API routes (health, v1/, api/)
│   │   └── lib/                 # env.ts, logger.ts, rate-limiter.ts, storage.ts
│   └── shared/                  # Shared TypeScript types
├── db/
│   └── migrations/              # Drizzle migrations with RLS, applied by the app at startup
├── k8s/                         # Kubernetes manifests with Kustomize overlays
├── volumes/                     # Docker volume mounts
│   ├── traefik/                 # Traefik routing and ForwardAuth middlewares
│   ├── s3/                      # Local S3 (Garage) config
│   └── db/                      # Database initialization and WAL archiving
├── docker-compose.yml           # Postgres, the app and Traefik
├── docker-compose.prod.yml      # Production overlay
├── Dockerfile                   # Production-optimized container
└── .github/workflows/           # CI/CD pipelines
```

### CLI Flow

`src/create.js` uses `@clack/prompts` for interactive CLI. It:
1. Parses CLI arguments (`-pm`, `-y`, `-admin-email`, etc.)
2. Prompts for admin email and password (required for dashboard access)
3. Generates secure secrets (`BETTER_AUTH_SECRET`, the database and replication passwords)
4. Copies template files from `carbon/` directory
5. Replaces placeholders (e.g., `{{PROJECT_NAME}}`, `{{ADMIN_EMAIL}}`)
6. Writes `ADMIN_EMAIL`/`ADMIN_PASSWORD` to `.env.local`; the app creates the super admin from them at startup
7. Installs dependencies and initializes git

---

## Getting Started

### 1. Configure Environment

The bootstrap process creates a `.env.local` file with secure, randomly generated secrets. Add your OAuth credentials:

```bash
# .env.local

# Generated at create time
BETTER_AUTH_SECRET="..."
DB_HOST=localhost
DB_PASSWORD="..."

# Add your OAuth credentials
GOOGLE_ENABLED=true
GOOGLE_CLIENT_ID="your-client-id"
GOOGLE_CLIENT_SECRET="your-client-secret"

MICROSOFT_ENABLED=true
MICROSOFT_CLIENT_ID="your-client-id"
MICROSOFT_CLIENT_SECRET="your-client-secret"
MICROSOFT_TENANT_ID="your-tenant-id"
```

### 2. Start Development Environment

```bash
npm run dev:start
```

This single command:
1. Starts the Docker containers
2. Runs database migrations
3. Launches development servers

**Services started:**
- PostgreSQL 17 database (pg_cron, WAL-G)
- Traefik reverse proxy
- Local S3 (Garage) for uploads

**Development servers:**
- **API server**: http://localhost:3000
- **Vite dev server**: http://localhost:5173

> **Note:** If containers are already running, use `npm run dev` to just start the dev servers.

---

## Available Scripts

### Development
| Command | Description |
|---------|-------------|
| `npm run dev:start` | **Recommended** - Full cold start: Docker + migrations + dev servers |
| `npm run dev` | Start dev servers only (use when Docker is already running) |
| `npm run dev:server` | Start Hono API server only |
| `npm run dev:client` | Start Vite dev server only |
| `npm run build` | Build for production |
| `npm start` | Run production build |
| `npm run lint` | Check code with Biome |
| `npm run lint:fix` | Fix code issues |
| `npm run typecheck` | TypeScript type checking |

### Docker
| Command | Description |
|---------|-------------|
| `npm run docker:up` | Start all services in background |
| `npm run docker:down` | Stop all services |
| `npm run docker:logs` | View service logs |
| `npm run docker:reset` | Remove containers, volumes, and built images |

### Database
| Command | Description |
|---------|-------------|
| `npm run db:migrate` | Run migrations |
| `npm run db:reset` | Reset database (removes volumes, restarts Docker) |

---

## Code Examples

### Authentication (Server-side)

```typescript
// In any Hono route - user is set by middleware
app.get('/api/protected', (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  return c.json({ user });
});

// Query as the signed-in user: RLS scopes every statement to their rows
import { withUserDb } from '../db/client';
import { organizations } from '../db/schema';

app.get('/api/v1/organizations', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const orgs = await withUserDb(user.id, (tx) => tx.select().from(organizations));
  return c.json({ organizations: orgs });
});
```

### Authentication (Client-side)

```typescript
import { useAuth } from './components/auth/AuthProvider';

function MyComponent() {
  const { user, isLoading, signIn, signOut } = useAuth();

  if (isLoading) return <div>Loading...</div>;

  if (!user) {
    return <button onClick={() => signIn.google()}>Sign in with Google</button>;
  }

  return <button onClick={() => signOut()}>Sign out</button>;
}
```

The session is an HttpOnly cookie Better Auth sets on the app's own origin. Page code never sees a token: calls through `apiJson` / `apiFetch` (`src/client/lib/api.ts`) ride the cookie.

### Database & Row Level Security

The browser never queries Postgres. It calls the Hono API (`/api/v1/...`), and the API server queries Postgres directly with Drizzle through `src/server/db/client.ts`, which exports two handles:

- **`withUserDb(userId, fn)`** opens a transaction, switches to the `app_user` role, and sets `app.user_id` for that transaction in one parameterized statement (`select set_config('role', 'app_user', true), set_config('app.user_id', $1, true)`). Every statement `fn` runs is filtered by RLS. `userId = null` is an anonymous request: `app.user_id()` reads `NULL`, so user-scoped policies match nothing. This is the default for anything done on behalf of a user.
- **`adminDb`** runs as the connection role (`DB_USER`, default `postgres`), which bypasses RLS. It is reserved for the server acting for itself (webhooks, admin tools, background jobs); `tests/structural/db-access-census.test.ts` lists the files allowed to import it.

At startup the server applies any pending migrations from `db/migrations/` itself (drizzle-orm's migrator under a Postgres advisory lock, ledger in `drizzle.__drizzle_migrations`; no deploy step applies SQL, and every route but `/api/health` answers 503 until they are applied), then checks that the connection role bypasses RLS and is a member of `app_user`, and exits if not, so `adminDb` can never silently become RLS-scoped. The connection comes from discrete env vars (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`), never a URL, so passwords need no URL-encoding.

Policies target `app_user` and read the caller from `app.user_id()`:

```sql
-- The shape of what db/migrations/0001_baseline_schema.sql (generated by
-- drizzle-kit from src/server/db/schema.ts) creates

-- Organizations table
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see orgs they belong to.
-- get_user_org_ids() is a SECURITY DEFINER helper that reads
-- memberships for (SELECT app.user_id()).
CREATE POLICY "Users can view their organizations"
  ON organizations FOR SELECT
  TO app_user
  USING (id IN (SELECT get_user_org_ids()));
```

### Querying with Drizzle

```typescript
import { adminDb, withUserDb } from '../db/client';
import { organizations } from '../db/schema';

// On behalf of a user: RLS returns only their organizations
const orgs = await withUserDb(user.id, (tx) => tx.select().from(organizations));

// As the server itself (webhook, admin tool, job): bypasses RLS, so check
// the caller's authorization yourself before passing in any user-supplied id
const allOrgs = await adminDb.select().from(organizations);
```

The client reads through TanStack Query and `apiJson('/api/v1/organizations')` from `src/client/lib/api.ts`. Drizzle binds every value as a query parameter; never build SQL text from input. The real-Postgres `db` test tier (`carbon/tests/db/`, `npm run test:db`) proves the policies against the engine that enforces them.

### File Storage

Uploads go from the browser straight to your S3 bucket. The API signs the request, so the file never passes through the app server:

1. The client asks `POST /api/v1/files/presign` for an upload URL (`presignUpload` in `src/server/lib/storage.ts` checks the user, the kind and the content type, and builds a per-user object key).
2. The browser `PUT`s the file to the presigned URL.
3. Reads go through the app (`/api/files/<key>`), which checks access and redirects to a short-lived presigned read URL.

Locally the bucket is Garage on `localhost`; deployed, it is the S3-compatible object storage of your provider.

---

## API Routes & Patterns

### Data and Auth Clients
- **Data (server only)**: `src/server/db/client.ts` - `withUserDb` (RLS as `app_user`, the default) and `adminDb` (bypasses RLS, census-listed files only)
- **Auth, client-side**: `src/client/lib/auth-client.ts` and `useAuth()` - sign-in, sign-up, MFA, sign-out; the session is a cookie, never a token in page JS
- **Auth, server-side**: `src/server/auth/` - the Better Auth instance (mounted at `/api/auth`) and its plugins: lockout, MFA assurance, impersonation, the super-admin bootstrap

### Route Conventions
| Route | Purpose |
|-------|---------|
| `/api/health` | Liveness probe (no DB check) |
| `/api/health/ready` | Readiness probe (checks DB connectivity) |
| `/api/v1/*` | Versioned API endpoints |
| `/api/v1/admin/stats` | Super admin stats |
| `/api/v1/admin/performance` | Service performance/health checks |
| `/api/_internal/*` | Internal routes (role verification) |

---

## Template Placeholders

When modifying template files in `carbon/`, these placeholders are replaced at generation time:

| Placeholder | Description |
|-------------|-------------|
| `{{PROJECT_NAME}}` | User's project name (machine slug) |
| `{{PROJECT_DISPLAY_NAME}}` | Human-facing name (titles, emails, legal copy) |
| `{{GITHUB_OWNER}}` | GitHub owner for GitOps and image names |
| `{{SITE_URL}}` | The app's public origin |
| `{{ADMIN_EMAIL}}` | Admin user email (entered during creation) |
| `{{ADMIN_PASSWORD}}` | Admin user password (entered during creation; never substituted into a checked-in file) |
| `{{DB_PASSWORD}}` | PostgreSQL password (never substituted into a checked-in file) |
| `{{REPL_PASSWORD}}` | Replication password for the HA modes (never substituted into a checked-in file) |

Secret placeholders go to `.env.local` and are patched in at deploy time. Deploy-time placeholders (`{{DOMAIN}}`, `{{DB_IMAGE}}`, `{{WALG_S3_PREFIX}}`, ...) stay in the scaffold until `vibecarbon deploy` fills them.

---

## Admin Dashboard Access

All admin dashboards are protected by a unified Single Sign-On (SSO) system using Traefik ForwardAuth middleware.

### How It Works

1. **Login via main app** - Sign in at `http://localhost:5173/login` with your admin email/password
2. **Session cookie set** - Better Auth sets an HttpOnly session cookie on the app's origin
3. **Open a dashboard** - The admin panel mints a short-lived, parent-domain `vc-admin-token` cookie (a dedicated ForwardAuth token, never the session) for super admins
4. **ForwardAuth validates** - Traefik forwards requests to `/api/_internal/verify-role?role=super_admin`, which accepts only that token
5. **Access granted** - If valid super admin session, request passes through

### Admin Dashboards

#### External Services

| Dashboard | Local URL | Production URL |
|-----------|-----------|----------------|
| Traefik Dashboard | http://traefik.localhost | https://traefik.yourdomain.com |
| Grafana | http://grafana.localhost | https://grafana.yourdomain.com |

(n8n and Metabase are parked add-ons: their dashboards only exist on projects that installed them before parking; same URL pattern as above.)

#### Built-in Admin Pages

| Page | Path | Purpose |
|------|------|---------|
| Dashboard | `/admin/dashboard` | Service health overview |
| Users | `/admin/users` | User management and impersonation |
| Organizations | `/admin/organizations` | Organization management |
| Notifications | `/admin/notifications` | Create and manage notifications |
| Logs | `/admin/logs` | Docker log viewer |
| Infrastructure | `/admin/infrastructure` | Service topology and health |
| Theme | `/admin/theme` | Custom theme editor |
| Jobs | `/admin/jobs` | Background job monitoring and manual triggers |
| Contact | `/admin/contact` | Contact form submission management |
| Newsletter | `/admin/newsletter` | Subscriber management, compose, send, export |
| Settings | `/admin/settings` | Security (MFA), email, locked accounts |

### Creating Admin Users

The first admin user is created during project setup:

```bash
# Interactive mode
vibecarbon create
# You'll be prompted for admin email and password

# Non-interactive mode
vibecarbon create my-app -y \
  -admin-email admin@example.com \
  -admin-password yourpassword123
```

Additional super admin users can be added via:
1. Sign up through the app
2. Update their role in the database:
   ```sql
   -- over `vibecarbon shell`, or psql against the local dev db
   UPDATE "user" SET role = 'super_admin' WHERE email = 'newadmin@example.com';
   ```

### Unauthenticated Access

When accessing an admin dashboard without a valid session:
- **Browser requests** → Redirected to `/login?returnTo=<original-url>`
- **API requests** → Returns `401 Unauthorized`

---

## Security

### Application Security
- **Rate limiting** - 100 req/min per IP by default
- **Security headers** - CSP, HSTS, X-Frame-Options, X-Content-Type-Options
- **Request limits** - 10MB max body size, 30s timeout
- **CORS** - Configured for SPA origin with credentials

### Database Security
- **Row Level Security** - Policies enforced at database level; user requests run as `app_user` with `app.user_id` set per transaction
- **Role separation** - `app_user` (user requests, RLS enforced), `postgres` (the API server's connection role, bypasses RLS, used by `adminDb`)
- **No public database port** - Postgres listens on the private network only; operators reach it through `vibecarbon shell` (SSH)

### Database Roles

| Role | Used By | Purpose |
|------|---------|---------|
| `postgres` | API server (`adminDb`), migrations | Connection role; bypasses RLS and is a member of `app_user` |
| `app_user` | API server (`withUserDb`) | NOLOGIN; every user request switches to it, RLS enforced |

### Authentication Security
- **Better Auth, in-process** - Sign-in runs inside the app against your own database; no separate auth service
- **HttpOnly session cookies** - Signed with `BETTER_AUTH_SECRET`; page JS never holds a session or refresh token
- **OAuth providers** - Google, Microsoft with PKCE flow
- **Account lockout and MFA** - Failed-login lockout, TOTP with backup codes, step-up for sensitive actions

### Infrastructure Security
- **One public origin** - Traefik routes every public path to the app; nothing else is reachable from the internet
- **Traefik ForwardAuth** - Admin dashboards protected by a super-admin SSO token
- **Non-root containers** - All services run unprivileged
- **Automatic HTTPS** - Traefik handles TLS certificates
- **Operator Access Lock** - SSH (port 22) and Kubernetes API (port 6443) firewall-locked to authenticated CIDRs

### Operator Access & Firewall Management (`vibecarbon access`)

Interactive operations (`deploy`, `shell`, `diagnose`, `scale`, `failover`, `backup`, `restore`) automatically detect the operator's public IPv4 address and append it to `.vibecarbon.json` (`operatorCidrs`), patching the live cloud firewall via the provider API.

#### CIDR Allowlist Management

```bash
# List current operator CIDRs
vibecarbon access

# Manually add an IP or CIDR range (e.g. office IP)
vibecarbon access add 1.2.3.4/32

# Remove a CIDR range from the firewall
vibecarbon access remove 1.2.3.4/32

# Prune inactive CIDRs older than 90 days
vibecarbon access prune
```

#### CI / Ephemeral Runners (`ALLOWED_SSH_IPS`)
In non-interactive CI environments (`-y`), public IP auto-detection is suppressed to prevent polluting the persistent allowlist with ephemeral runner IPs. Set `ALLOWED_SSH_IPS` to pass runner CIDRs dynamically:

```bash
export ALLOWED_SSH_IPS="1.2.3.4/32,5.6.7.8/32"
vibecarbon deploy prod -y
```

### RSC Vulnerability
- **No RSC** - CVE-2025-55182 not applicable (no Flight protocol)
- SPA architecture eliminates entire attack surface

---

## Service Ports Reference

| Service | Port | Access | Purpose |
|---------|------|--------|---------|
| Traefik | 80 | Direct | Reverse proxy (routes to the app and admin tools) |
| App | 3000 | Direct or via Traefik | Your Hono API server |
| Vite | 5173 | Direct | Frontend dev server |
| Traefik Dashboard | - | via Traefik (`traefik.localhost`) | Proxy dashboard |
| PostgreSQL | 5432 | localhost only (dev), private network (deployed) | Database |
| Local S3 (Garage) | 8333 | localhost only (dev) | Upload bucket |

`vibecarbon up` shifts every dev port by `DEV_PORT_OFFSET` when you run more than one project at once.

---

## Resource Requirements

| Component | CPU (max) | RAM (max) |
|-----------|-----------|-----------|
| PostgreSQL | 2.0 | 4 GB |
| App (Hono + Better Auth) | not capped | not capped |
| Traefik | 0.5 | 256 MB |
| Docker socket proxy | 0.25 | 128 MB |
| Observability Stack (optional) | ~1.0 | ~1.5 GB |

The caps are the `deploy.resources.limits` in `docker-compose.prod.yml`. The app has none, so it can use what the database leaves free.

### VPS Recommendations

| Scenario | Hetzner Server | Specs |
|----------|----------------|-------|
| Dev, QA | CX23, CX22, CPX21 | 2 vCPU, 4 GB RAM |
| Prod (Single VPS) | CX33, CPX31 | 4 vCPU, 8 GB RAM |
| Prod HA (2x Standby) | CX33, CPX31 (x2) | 8 vCPU, 16 GB RAM |

*For current monthly costs, see [Hetzner Cloud pricing](https://www.hetzner.com/cloud/). Exact server types are picked per region at deploy time based on availability.*

**x86-64 (amd64) only.** Vibecarbon builds and publishes every image for
`linux/amd64` and provisions only x86 server types. Hetzner's ARM line (`CAX*`)
is not supported and is rejected by `deploy`, `scale`, and `failover`. See
[deploy-hetzner.md](./deploy-hetzner.md#x86-64-only) for the rationale and the
migration path for an environment that predates this.

---

## Deployment

### Deployment Options

The deploy mode sets how many servers an environment runs: one, a primary and a
standby, a cluster, or a cluster plus its standby region. Check your provider's
current pricing for the server types you select at deploy time.

| Option | Tier | Description |
|--------|------|-------------|
| Single VPS | Graphite (free) | Docker Compose on a single VPS |
| Single K8s | Graphene | Single-region k3s cluster |
| Multi-Region K8s HA | Fullerene | k3s primary + standby clusters with PG streaming replication + one-command failover |

Compose HA is also covered under Fullerene, for providers without Kubernetes; select it explicitly with `-mode compose-ha`.

Mode support by provider (same facts as the README architecture diagram):

| Deploy mode | Hetzner | DigitalOcean | Linode | Vultr | Scaleway |
|---|:---:|:---:|:---:|:---:|:---:|
| `compose` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `k8s` | ✅ | ✅ | — | — | — |
| `k8s-ha` | ✅ | ✅ | — | — | — |

Every cell that ships runs the same CLI, the same lifecycle commands, and the same e2e gate. A dash is a mode not yet built for that provider: requesting it fails at deploy-mode selection with an explicit capability-gate error (`assertTierSupported()` in `src/lib/providers/index.js`).

All deployments include:
- Automatic HTTPS via Traefik
- Docker secrets management
- Health monitoring

Kubernetes deployments additionally include:
- CPU-based pod autoscaling via Kubernetes HPA (2-10 replicas)
- Worker scaling via `vibecarbon scale`

### Deployment Guides

| Option | Best For | Guide |
|--------|----------|-------|
| Hetzner Cloud | Cost-effective hosting (single-node + HA) | [deploy-hetzner.md](./deploy-hetzner.md) |
| DigitalOcean | Compose and Kubernetes | [deploy-digitalocean.md](./deploy-digitalocean.md) |

### Integration Guides

| Option | Description | Guide |
|--------|-------------|-------|
| Observability | Prometheus, Grafana, Loki | [observability.md](./integrations/observability.md) |

---

## High Availability & Replication

Both `k8s-ha` and `compose-ha` run two regions with Postgres streaming
replication and manual, one-command failover, but their standby
architectures are not the same:

- **`k8s-ha`** uses a cost-optimized **pilot-light standby** (described in
  full below) with a 2-node idle floor, a cold (`replicas: 0`) app tier, and
  failover that provisions app-tier capacity via the IaC layer before
  promoting.
- **`compose-ha`** keeps its existing **always-warm standby**: two always-on
  VPSs, both running the full stack, with continuous streaming replication.
  Its failover path (`failoverComposeHA`) promotes the standby database, moves
  the wal-g write-guard (see below), and repoints DNS. There is no idle floor,
  no worker provisioning, and no `-server-type` step, because nothing on the
  standby is cold.

The rest of this section (Pilot-Light Standby Architecture, Guarantees,
Observability & Operations, Error Handling) describes **k8s-ha**
specifically.

### Pilot-Light Standby Architecture (k8s-ha)

The standby cluster is deployed as a cost-optimized, non-serving replica designed to minimize idle cost while remaining ready for rapid failover:

**Idle State:**
- **2 nodes only:** master (control plane, ingress, cert-manager, replication gateway, in-cluster registry) + dedicated database node (the streaming replica database)
- Same server types as the primary's master and database nodes: cost savings come from eliminating workers and the warm app tier, not from downsizing
- **Cold app tier, declaratively:** All app-tier workloads (the app Deployment and cluster-autoscaler) are set to `replicas: 0`; the only active workloads are the db StatefulSet and replication gateway
- **Seeded on first boot:** The standby database is initialized by a seed container running `pg_basebackup` at deploy time, booting as a live streaming replica. The 200s stage/swap/reboot reseed cycle is eliminated

**Deploy as role reconciler:**
Re-running `vibecarbon deploy` after any failover converges each cluster to its current role:
- The new primary keeps warm app tier and workers
- The recovered ex-primary is converged back to pilot-light (app tier zeroed, workers removed via the IaC layer)

### Guarantees (k8s-ha)

| Scenario | RPO | RTO | Notes |
|---|---|---|---|
| **Planned switchover** | **Zero**: quiesce-before-promote, enforced by a pre-promotion WAL catch-up gate and evidenced per run by the e2e continuity check | Outage-side ≈ **1m 2s** measured¹ + DNS propagation (≤ 60s record TTL); full operation **3m 25s** measured¹ | Provisioning happens before the outage window opens |
| **Unplanned failover** | Replication lag at failure: seconds when healthy, visible live in `vibecarbon status` | Command-side ≈ **3m 25s** measured¹ (provisioning inside the outage) + failure-detection time + DNS propagation | Clean abort + convergent retry on provisioning failure |
| **Idle** | — | — | Standby ≈ 2 small nodes; no warm app tier; no crash-loop fragility |

¹ Single datapoint from the first CI record run (2026-07-18); breakdown and
provenance in the measured-figures block below. These are measured figures,
**not guaranteed Service Level Objectives**. Your times vary with region
capacity, image sizes, and DNS caching.

**Publication gate (house rule):** HA claims stay pinned to the **latest
green e2e matrix**. The measured-figures block is refreshed only from a green
`k8s-ha` run whose `failover` and `verify-failover` steps and
`replication_failover_continuity` check all passed. The renderer
(`pnpm test:e2e:rto-rpo`) refuses anything less, and flags single-scenario
runs so the publisher confirms the latest full matrix before shipping the
claim.

#### Measured figures

<!-- BEGIN:rto-rpo-figures -->
<!-- Auto-generated by `pnpm test:e2e:rto-rpo` — do not edit by hand -->
<!-- rto-rpo-provenance: mode=k8s-ha;run=05b98e2;date=2026-07-18;regions=ash→hil;gh-run=29629518169 -->

| Measurement | Measured | Maps to |
| :--- | :---: | :--- |
| `failover` command wall-clock (incl. 0→N worker provisioning) | **3m 25s** | Unplanned-failover RTO, command side; planned-switchover operation time |
| — worker provisioning (IaC, 0→N) | 2m 23s | Before the outage window opens in planned mode; inside it when unplanned |
| — standby database promotion | 8.1s | The point of no return |
| — remainder (quiesce, WAL catch-up gate, wal-g write-guard move, app-tier scale-up, readiness gate, DNS flip) | 54.0s | Not individually instrumented yet — see docs/rto-rpo.md |
| Planned outage-side upper bound (wall-clock minus provisioning) | **1m 2s** | Planned-switchover RTO before DNS propagation (≤ 60s record TTL) |
| `verify-failover` (DNS propagation gate + full check battery) | 7m 14s | Independent serving + continuity evidence — not part of the outage |
| RPO evidence: `replication_failover_continuity` | **pass** | Pre-failover write survived onto the promoted primary → planned RPO = 0 |

_Provenance: `k8s-ha` scenario, regions ash→hil, e2e run `05b98e2` on 2026-07-18 (GitHub Actions run 29629518169); green single-scenario run — confirm the latest full matrix is still green before publishing HA claims. Methodology: [docs/rto-rpo.md](./rto-rpo.md)._
<!-- END:rto-rpo-figures -->

**Refreshing after the next green record run:** grab that run's `e2e.db`
(the CI artifact, or the local `tests/results/e2e.db`) and run

```bash
pnpm test:e2e:rto-rpo -- --run latest --db <path-to-e2e.db> \
  --regions "<primary→standby>" --gh-run <actions-run-id> --write
```

which re-renders the block above in place. The full metric mapping (which
`steps` / `perf_substep` / `verifications` rows back each figure, with the
equivalent raw SQL) lives in [docs/rto-rpo.md](./rto-rpo.md).

### Observability & Operations (k8s-ha)

**Replication lag visibility:**
`vibecarbon status <env>` includes a replication-lag line for HA environments, showing the primary's `pg_stat_replication` data and the standby's last-replay LSN. This lets you monitor the unplanned RPO risk.

**Failover command:**
```bash
vibecarbon failover <env>
```

Follows the ordering principle **secure capacity first, cross the point of
no return last**: provisions workers via the IaC layer first (0 → N,
capacity secured before anything irreversible happens), then, in planned
mode, quiesces the old primary, reseeds and promotes the standby database,
moves the wal-g write-guard, scales up the app tier, and repoints DNS.
(Unplanned mode skips the quiesce step; the primary is already unreachable.)
The command:
- Is fully convergent: rerunning it resumes instead of duplicating
- Accepts `-server-type <id>` to retry provisioning on different hardware during capacity events
- Fails gracefully: provisioning failures abort cleanly with the primary untouched (convergent re-run is safe)

**The wal-g write-guard moves with the role (both HA modes).** `WALG_ROLE` is
the backup write-guard: `standby` makes WAL archiving and base backups no-op so
only one node ever writes the single canonical `WALG_S3_PREFIX`. It is rendered
at deploy time, so failover re-renders it directly (`primary` onto the promoted
node and, best-effort, `standby` onto the demoted one) and then recreates the
database container, because container environment is fixed at container-create
time (writing `.env` or patching a StatefulSet alone changes nothing in the
running process). The failover then re-runs the deploy-time backup audit against
the promoted node in `requirePrimary` mode, where a lingering
`WALG_ROLE=standby` is a failure rather than the legitimate skip it is at deploy
time. If that cannot be proven, the failover still completes (promotion, DNS and
the persisted role swap all stand: an aborted post-promotion failover would be
worse) but the command exits non-zero with the remediation, so dead backups are
never reported as a clean success.

**Fail-back semantics:**
- **After a completed failover**, running `vibecarbon failover <env>` again performs a **planned switchover in the reverse direction** (the new primary becomes the standby, and the ex-standby becomes primary)
- **After an unplanned failover**, the normal recovery path is running `vibecarbon deploy <env>`, which converges the recovered ex-primary back to a pilot-light standby (cold app tier, workers removed) and re-establishes streaming replication

### Error Handling (k8s-ha)

- **Seed init failure at deploy** (primary unreachable, bad credentials): the db pod fails its init container, the deploy verification fails, and the deploy fails loud. Retry `vibecarbon deploy`: no partial states to clean.
- **Provisioning failure at failover:** The provisioning step attempts to converge workers to 0 on abort; if that also fails, the exact resource state is reported. The primary is untouched. Re-run `vibecarbon failover` (optionally with a different `-server-type`) to retry.
- **Promotion failure:** The existing abort-before-anything-moves check stands. If promotion is not confirmed, the failover stops before any other resource moves.
- Every failure path reports what state the world is in and what the operator's next command should be.

---

## External Resources

- [PostgreSQL Documentation](https://www.postgresql.org/docs/17/)
- [Better Auth Documentation](https://www.better-auth.com/docs)
- [Drizzle ORM Documentation](https://orm.drizzle.team/docs/overview)
- [Traefik Documentation](https://doc.traefik.io/traefik/)
- [Hono Documentation](https://hono.dev)
- [Vite Documentation](https://vitejs.dev)
- [React Documentation](https://react.dev)
- [TanStack Query](https://tanstack.com/query)
