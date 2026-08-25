# AGENTS.md

Guidance for AI coding agents working on this codebase. The **Security Rules** section below is mandatory — violations introduce real vulnerabilities.

## Tech Stack

- **Frontend**: React 19, Vite, React Router, TanStack Query, Shadcn UI, Launch UI, Tailwind CSS v4, i18next
- **Backend**: Hono (lightweight Node.js framework), Pino logger, Zod validation, nodemailer (SMTP email)
- **Auth/Database**: Self-hosted Supabase (PostgreSQL, Auth, REST API, Realtime, Storage)
- **Billing**: Multi-provider — Stripe, Paddle, Polar (subscriptions, checkout, webhooks, plan gating)
- **Content**: MDX (blog, changelog, docs) with remark/rehype plugins
- **Tooling**: Biome (lint/format), TypeScript, esbuild, Vitest
- **Package manager**: npm (ships with Node — nothing extra to install)

## Commands

```bash
# Development
npm run dev:start       # Full cold start: Docker + migrations + dev servers
npm run dev             # Start API (port 3000) and Vite (port 5173)
npm run dev:reset       # Remove containers, volumes, and built images

# Build & Test
npm run build           # Build client and server
npm run lint            # Biome linting
npm run typecheck       # TypeScript type checking
npm test                # Run every tier (unit + component + integration)
npm run test:unit       # Pure functions, validators, shared lib
npm run test:component  # React components + hooks (RTL + jsdom)
npm run test:integration # Hono routes with mocked Supabase/Stripe/SMTP
npm run test:watch      # Vitest watch mode
npm run test:coverage   # Generate coverage/ report (v8)
npm run test:prepush    # What the pre-push git hook runs

# Docker
npm run docker:up       # Start Supabase services
npm run docker:down     # Stop services
npm run docker:reset    # Remove containers, volumes, and built images
npm run db:migrate      # Run SQL migrations
```

## Architecture

### Directory Structure
```
src/
├── client/                  # React SPA (Vite dev server on :5173)
│   ├── components/
│   │   ├── ui/              # 50+ Shadcn UI components
│   │   └── auth/            # AuthProvider, ProtectedRoute
│   ├── hooks/               # Custom React hooks
│   ├── pages/               # Route pages (admin/, settings/, organizations/)
│   ├── lib/                 # supabase.ts, i18n.ts, utils.ts, blog/changelog/docs loaders
│   └── locales/             # i18n translation files
├── server/                  # Hono API (Node.js on :3000)
│   ├── index.ts             # App entry, middleware, route mounting
│   ├── routes/              # health.ts, v1/, webhooks/, _internal/
│   ├── emails/              # React Email templates
│   └── lib/                 # supabase.ts, env.ts, email.ts, stripe.ts, logger.ts, rate-limiter.ts, seo.ts
├── shared/                  # Shared TypeScript types (types.ts, pricing.ts)
content/                     # MDX content (blog/, changelog/, docs/)
supabase/migrations/         # SQL migrations (run with npm run db:migrate)
```

### API Routes

| Route | Description |
|-------|-------------|
| `GET /api/health` | Liveness probe (no DB check, public) |
| `GET /api/health/ready` | Readiness probe (checks DB connectivity, public) |
| `POST /api/v1/auth/login` | Email/password login with lockout protection |
| `GET /api/v1/auth/settings` | Auth settings (enabled providers, MFA config) |
| `GET /api/v1/me` | Current user info with memberships |
| `GET/POST /api/v1/organizations` | List/create organizations |
| `GET/POST /api/v1/organizations/:orgId/members` | Manage members |
| `PATCH /api/v1/organizations/:orgId/members/:userId` | Update member role |
| `GET /api/v1/notifications` | User's active notifications |
| `POST /api/v1/notifications/:id/dismiss` | Dismiss notification |
| `POST /api/v1/billing/checkout` | Create checkout session (Stripe/Paddle/Polar) |
| `POST /api/v1/billing/portal` | Create customer portal session |
| `POST /api/v1/contact/submit` | Submit contact form (public, rate-limited) |
| `POST /api/v1/newsletter/subscribe` | Subscribe to newsletter (public, rate-limited) |
| `GET /api/v1/newsletter/confirm` | Confirm newsletter subscription (via email token) |
| `GET /api/v1/newsletter/unsubscribe` | Unsubscribe from newsletter |
| `GET /api/v1/admin/users` | List all users (super admin) |
| `GET /api/v1/admin/organizations` | List all organizations (super admin) |
| `POST /api/v1/admin/impersonate/:userId` | Impersonate user (super admin) |
| `GET/POST /api/v1/admin/notifications` | Manage notifications (super admin) |
| `GET /api/v1/admin/stats` | Platform-wide stats (super admin) |
| `GET /api/v1/admin/performance` | Service performance/health checks (super admin) |
| `GET /api/v1/admin/crawlers` | AI/search crawler analytics, `?days=1..365` (super admin) |
| `GET /api/v1/admin/jobs` | Background jobs and execution history (super admin) |
| `POST /api/v1/admin/jobs/trigger` | Manually trigger a background job (super admin) |
| `GET/PATCH/DELETE /api/v1/admin/contact` | Manage contact submissions (super admin) |
| `GET /api/v1/admin/newsletter` | Manage newsletter subscribers (super admin) |
| `POST /api/v1/admin/newsletter/send` | Send newsletter to active subscribers (super admin) |
| `GET /api/v1/admin/newsletter/export` | Export subscribers as CSV (super admin) |
| `GET /api/_internal/verify-role` | Traefik ForwardAuth |
| `POST /api/webhooks/billing` | Billing webhook handler (Stripe/Paddle/Polar) |
| `POST /api/webhooks/stripe` | Stripe webhook handler (backward compat) |
| `GET /api/docs` | Scalar API reference (dev only) |

### Authentication Flow

1. **Client-side**: Supabase JS handles auth (email/password, OAuth, magic links, MFA)
2. **API requests**: Client sends JWT in `Authorization: Bearer <token>` header
3. **Server middleware**: Extracts token, calls `supabase.auth.getUser()`, sets `c.get('user')`
4. **RLS**: Database queries respect row-level security based on authenticated user

## Supabase Client Usage

This is the #1 source of bugs. Three clients exist:

**Client-side** (`src/client/lib/supabase.ts`) — uses anon key, RLS enforced:
```typescript
import { supabase } from '@/lib/supabase';
const { data } = await supabase.from('organizations').select('*'); // RLS enforced
```

**Server-side** (`src/server/lib/supabase.ts`) — two options:
```typescript
// User-context queries (respects RLS) — use for most routes
const supabase = c.get('supabase');

// Admin operations (bypasses RLS) — use only when necessary
import { supabaseAdmin } from '@/server/lib/supabase';

// Auth operations — NEVER use supabaseAdmin for signInWithPassword
// (stores session state on singleton, contaminates subsequent queries)
import { createAuthClient } from '@/server/lib/supabase';
const authClient = createAuthClient();
```

## Key Patterns

### Adding an API Endpoint

1. Create route in `src/server/routes/v1/` — follow existing routes for the `Variables` type, Zod validation, and auth check pattern
2. Mount in `src/server/index.ts`: `app.route('/api/v1/items', myRoutes)`

### Adding a Page

1. Create component in `src/client/pages/` — use `SidebarProvider` + `AppSidebar` + `SidebarInset` layout (see existing pages)
2. Add route in `src/client/App.tsx` wrapped in `<ProtectedRoute>`

### Rebranding the logo

Logo artwork lives in `src/client/assets/` and renders via `src/client/components/Logo.tsx`. To rebrand, replace these SVGs in place (keep the filenames):

- `logo-light.svg` / `logo-dark.svg` — the full logo lockup (`<Wordmark>`: nav, footers, auth pages). **Minimum to replace.**
- `logo-icon.svg` — the standalone mark (`<Logo>`: collapsed sidebar, plus the marketing-section motif). **Minimum to replace.**
- `logo-wordmark-light.svg` / `logo-wordmark-dark.svg` — the wordmark alone (`<WordmarkText>`); only needed if you keep the collapsible sidebar header.
- `public/favicon.svg` — the browser-tab icon (separate square asset).

Set `VITE_PROJECT_NAME` to your project name; it supplies the logo images' `alt` text and the page/SEO titles.

### Adding a Database Table

1. Create migration in `supabase/migrations/` with:
   - Table with `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `created_at`, `updated_at`
   - Index on foreign key columns
   - `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` **in the same migration** (clients query PostgREST directly — an un-RLS'd `public` table is public)
   - RLS policies using `(SELECT auth.uid())` and the org helpers for user-scoped access, with `WITH CHECK` mirroring `USING` on every write policy (see `00001_init.sql` and Security Rules → Database Security)
   - `update_updated_at()` trigger
2. Run `npm run db:migrate` and add types to `src/shared/types.ts`

### Data Fetching (TanStack Query)

**NEVER use raw `fetch` in `useEffect`** — always use `useQuery` for reads and `useMutation` for writes. Raw fetch in useEffect bypasses TanStack Query's deduplication, caching, and retry logic, and React StrictMode will double-fire it in development.

```typescript
// CORRECT: useQuery with auth guard
const { data, isLoading } = useQuery({
  queryKey: ['items', orgId],
  queryFn: async () => {
    const headers = await getAuthHeaders();
    const res = await fetch(`/api/v1/items?orgId=${orgId}`, { headers });
    if (!res.ok) throw new Error('Failed to fetch items');
    return res.json();
  },
  enabled: !!user && !!orgId, // Skip fetch when unauthenticated or missing params
});

// WRONG: raw fetch in useEffect
useEffect(() => {
  fetch('/api/v1/items').then(r => r.json()).then(setItems);
}, []);
```

Rules:
- **Gate authenticated queries** with `enabled: !!user` (or `!!session`) to prevent 401s for logged-out users
- **Use `getAuthHeaders()`** from `@/lib/api.ts` for auth headers — never duplicate it locally, never send empty `Authorization` headers
- **Place reusable hooks** in `src/client/hooks/api/` — page-specific queries can live in the page file
- **Invalidate related queries** after mutations: `queryClient.invalidateQueries({ queryKey: ['items'] })`
- **Set `staleTime`** to control cache freshness (default is 5min via QueryClient config)

## Localization

**Check `src/client/locales/` before writing any user-facing string.** The
files present there are the languages this project ships — `src/client/lib/
locales.ts` globs the directory, so there is no list to consult and nothing
that can disagree with what actually ships.

- **One file (`en.json`) — the default.** The project is monolingual. Write
  English only. Do **not** create other locale files, and do not translate.
- **More than one file.** The project is multilingual. Every user-facing string
  must be added to *every* locale file present, translated, in the same change.
  `tests/structural/i18n-parity.test.ts` fails on a partial add.

Never hardcode a user-facing string, in either mode. Even monolingual projects
route through `t()`, so enabling a language later is a CLI command rather than
a rewrite. `tests/structural/i18n-key-resolution.test.ts` enforces that every
`t()` key resolves against `en.json` — a typo'd key path renders as the raw
path to the user, in every language at once, which is exactly the bug that test
was written after finding.

**French register:** app UI uses *tu*; *vous* is reserved for `landing.*`
marketing copy. Recorded here because the fr locale file no longer exists to
read the convention off it.

**Changing the language set is `vibecarbon configure globalization`**, never a
hand-edited file. Adding a language seeds every key with its English value, so
parity passes immediately and `configure globalization` reports how much is
still untranslated. English cannot be removed: it is i18next's `fallbackLng`.

## Database Schema

| Table | Purpose |
|-------|---------|
| `organizations` | Multi-tenant organizations (name, slug, plan) |
| `memberships` | User-org relationships (role: OWNER, ADMIN, MEMBER) |
| `customers` | Billing customer records (user or org, any provider) |
| `subscriptions` | Billing subscription data |
| `notifications` | System-wide or org-specific notifications |
| `notification_dismissals` | Track dismissed notifications per user |
| `failed_login_attempts` | Brute force protection |
| `app_settings` | Global app configuration |
| `cron_job_history` | Background job execution history (pg_cron) |
| `contact_submissions` | Contact form submissions (name, email, subject, message, status) |
| `newsletter_subscribers` | Newsletter subscribers (email, status: pending/active/unsubscribed) |
| `crawler_hits` | AI/search crawler page fetches (crawler, bucketed path, UA, no IPs; pruned after 90 days) |
| `crawler_hits_daily` | Per-day (crawler, path) hit rollup, pruned after 400 days |

RLS helper functions: `get_user_org_ids()`, `get_user_admin_org_ids()`, `is_super_admin()`

## Path Aliases

- `@/*` resolves to `./src/client/*`
- `@shared/*` resolves to `./src/shared/*`
- `@server/*` resolves to `./src/server/*` (test-only — server code uses relative imports)
- **Never use `@/shared/*`** — it won't resolve

## Testing

Three tiers — pick the narrowest one that exercises the regression you're worried about.

| Tier | Env | What it covers | Where it lives |
|---|---|---|---|
| `unit` | node | Pure functions, validators, pricing/format/business helpers, structural invariants (e.g. i18n parity) | `tests/unit/`, `tests/structural/` |
| `component` | jsdom | React components + custom hooks via React Testing Library | `tests/component/` |
| `integration` | node | Hono route handlers end-to-end via `app.request()`, with Supabase/Stripe/SMTP mocked at the module boundary | `tests/integration/` |

Helpers live in `tests/_helpers/`:

- `app.ts` — `mountRoute(prefix, routes)` to build a tiny Hono app for one route; `jsonPost(body)` for request boilerplate.
- `factories.ts` — `makeUser`, `makeOrg`, `makeContactSubmission` for plausible domain fixtures.
- `jwt.ts` — `mockJwt(payload)` for HS256-signed test tokens.
- `env.ts` — `mockEnv({...})` returning a restore closure (no globals).
- `setup-rtl.ts` — vitest setup for the component project (jest-dom matchers + RTL cleanup).
- `setup-integration.ts` — seeds plausible Supabase env values so server modules load without zod-validation errors.

**Mocking conventions:**
- Supabase: `vi.mock('@server/lib/supabase', () => ({ supabaseAdmin: { from: () => ({ insert: vi.fn() }) } }))`.
- Stripe: `vi.mock('@server/lib/stripe', () => ({ stripe: { ... } }))`.
- fetch (client side): `vi.stubGlobal('fetch', vi.fn(...))` + `vi.unstubAllGlobals()` in afterEach.
- TanStack Query: wrap with a fresh `QueryClient` per render (`retry: false`) — see `tests/component/use-auth-settings.test.tsx`.
- Rate limiter: `vi.mock('@server/lib/rate-limiter', () => ({ createRateLimiter: () => async (_c, next) => { await next(); } }))` — the real module starts a 60s setInterval at module load.

See `TESTING.md` for the full guide. The `test-maintainer` agent reads the tier directories to learn project conventions and will follow them automatically.

## Agent Orchestration

This project uses Claude Code's agent teams with a **lead-coordinator** that orchestrates 4 specialist teammates:

| Agent | Role | Quality Gate |
|-------|------|-------------|
| `lead-coordinator` | Decomposes tasks, delegates, synthesizes results | — |
| `backend-engineer` | Backend APIs, database, Docker/K8s, server logic | `npm run lint` + `npm run typecheck` on idle |
| `frontend-engineer` | Frontend pages, components, layouts, styling | `npm run lint` + `npm run typecheck` on idle |
| `security-reviewer` | Security audit after backend/infra changes | — |
| `test-maintainer` | Test writing after any meaningful code change | `npm run test:unit` on task complete |

**Typical workflow**: Use the lead-coordinator for complex multi-step tasks. It decomposes the work, spawns specialists in dependency order (migrations -> API -> security review -> frontend -> tests), and synthesizes results. For simple single-domain tasks, invoke the specialist directly.

**Quality gates** are enforced via hooks in `.claude/hooks/`:
- `teammate-idle-gate.sh` — lint + typecheck before backend/frontend engineers go idle
- `task-completed-gate.sh` — unit tests must pass before QA marks a task complete

**Configuration**: `.claude/settings.json` registers the hooks and the `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env var required for agent teams.

## Important Notes

- **Prefer existing patterns** — follow the established code style in existing routes/components
- **Auth is handled by Supabase** — don't implement custom auth, use `supabase.auth.*` methods
- **Two UI libraries** — build UI from **Shadcn UI** primitives (`src/client/components/ui/`) for interface elements (buttons, inputs, dialogs, dropdowns, tabs, tooltips, badges) and **Launch UI** blocks (MIT, vendored copy/paste; retinted to the OKLCH palette) for marketing/landing sections (hero, feature grids, pricing, FAQ, CTA). Write a custom component only when neither covers the need, and note what was missing in a short comment.
- **Add Shadcn components** with `npx shadcn@latest add [component-name]`

---

# Security Rules (Mandatory)

The rules below are mandatory — violations introduce real vulnerabilities. The three most critical:

1. **Always check auth** — every endpoint must verify `c.get('user')` and return 401 if null
2. **Always validate input** — use Zod schemas for all API request bodies before processing
3. **Use `c.get('supabase')` for user data** — never use `supabaseAdmin` for queries shown to end users; it bypasses RLS

## Role Model & Authorization

There are **two independent role axes** — do not conflate them:

- **Platform role** lives in the JWT `app_metadata.role`. The only elevated value is **`super_admin`**. There is **no platform `admin` role.** Check it with `isSuperAdmin(user)` (server) or `is_super_admin()` (SQL). Every platform-admin surface (the `/admin/*` API, Studio, Grafana, n8n, Metabase, the Traefik dashboard) requires `super_admin`.
- **Org role** lives in the `memberships` table as `OWNER` / `ADMIN` / `MEMBER`. This is a per-organization membership tier enforced by RLS (`get_user_admin_org_ids()` etc.) and `requireOrgRole(...)`. An org `ADMIN` has authority **only within its own org** and **never** any platform capability.

Rules:

- **MUST** read the role only from `app_metadata` (server-controlled, set via the service role at bootstrap). **NEVER** gate anything — code or RLS policy — on `user_metadata`: it is user-writable via GoTrue `updateUser`, so trusting it is a self-service privilege escalation.
- **MUST** keep every admin-gated surface accepting `super_admin`. If you ever introduce a user-defined tier below super_admin, the ForwardAuth gate must be `?roles=<tier>,super_admin` (any-of) and the code check `isSuperAdmin(user) || is<Tier>(user)` — a bare `role === 'admin'` / `?role=admin` **locks super admins out** and is a bug.
- **MUST NOT** trust the `X-User-Id` / `X-User-Email` / `X-User-Role` / `X-Authenticated-User` request headers as auth input. Traefik sets them for downstream services (e.g. Grafana) and strips client-supplied copies; app code derives identity **only** from the verified JWT via `c.get('user')`.
- **MUST NOT** add a public route or client flow against `/api/_internal/verify-role` — it is the ForwardAuth trust anchor, denied on the public edge and called by Traefik internally only.
- **NEVER** add an API path that writes `app_metadata.role`. Role assignment is operator-bootstrap only (there is intentionally no "set role" endpoint).

## Session Cookies & ForwardAuth (split-cookie contract)

Two cookies, two jobs — never merge them (spec `2026-07-24-session-cookie-split`, invariants pinned in `tests/structural/security-invariants.test.ts`):

- **`sb-auth-token`** is the SPA's supabase session store and **host-only** (apex). It holds the refresh token, so it **MUST NOT** get a `domain=` attribute — a parent-domain scope sends every user's refresh token to every admin subdomain, where XSS in any bundled tool (Grafana, Metabase, n8n) can read it. It is **NOT** a ForwardAuth credential.
- **`vc-admin-token`** is the only cookie `/api/_internal/verify-role` accepts: **HttpOnly**, access token only, 1h, minted by `POST /api/v1/admin/forwardauth-cookie` for super_admins only. Regular users carry no domain-wide cookie at all. **NEVER** relax verify-role to read `sb-*` cookies again.
- **Impersonation never client-stores the admin session.** The admin refresh token is parked in the HttpOnly, `SameSite=Strict`, path-scoped **`vc-impersonation-restore`** cookie (1h hard window); restore is the server round-trip `POST /api/v1/admin/impersonate/stop`. **NEVER** write a session into `localStorage`/`sessionStorage`.

## Database Security (RLS)

**Why this is load-bearing:** the browser queries PostgREST **directly** through Kong (`/rest/v1`) with the anon key + user JWT. RLS is the *only* thing between a `public.*` table and the internet — a missing or under-scoped policy is a live data breach, not a theoretical one. Enable RLS + write policies in the **same migration** that creates the table, before it ships.

- **MUST** enable RLS on every new table: `ALTER TABLE my_table ENABLE ROW LEVEL SECURITY;`
- **MUST** give every `UPDATE`/`INSERT` policy a `WITH CHECK` that mirrors the full scope of its `USING`. Postgres evaluates `USING` (which rows you may target) and `WITH CHECK` (what the row may become) **independently** — a `WITH CHECK` that drops the org/owner scope lets a user rewrite a row they can see into a tenant they cannot, a cross-tenant takeover. Never rely on the implicit `WITH CHECK = USING` default for a boundary column.
- **MUST** use `(SELECT auth.uid())` in RLS policies, not bare `auth.uid()` — the subquery form prevents the query planner from re-evaluating per row
- **MUST** read roles in policies from `auth.jwt() -> 'app_metadata' ->> 'role'` (via `is_super_admin()`), **never** `user_metadata` (user-writable)
- **MUST** `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` on any `SECURITY DEFINER` function not meant for direct client RPC — PostgREST exposes `public` functions at `/rest/v1/rpc/<name>`, and SECURITY DEFINER bypasses RLS
- **MUST** use `SECURITY DEFINER` + `SET search_path = ''` on all helper functions used in RLS policies
- **NEVER** disable RLS on existing tables
- **NEVER** use `USING (true)` as a policy for user data — every table needs real ownership checks
- **NEVER** add a client `INSERT`/`UPDATE` policy on a table written only by the server (e.g. billing `customers`/`subscriptions`) — leave it server-only (service role) rather than opening needless write surface
- **NEVER** grant direct table access to `anon` or `authenticated` roles beyond what RLS policies allow

### RLS Helper Functions

Use these existing functions in policies instead of writing inline queries:

| Function | Returns | Use When |
|----------|---------|----------|
| `get_user_org_ids()` | `SETOF UUID` | User needs access to any org they belong to |
| `get_user_admin_org_ids()` | `SETOF UUID` | Only OWNER or ADMIN roles should have access |
| `get_user_owner_org_ids()` | `SETOF UUID` | Only OWNER role should have access |
| `get_user_customer_ids()` | `SETOF UUID` | Billing data — includes personal + org customers |
| `is_super_admin()` | `BOOLEAN` | Platform-wide admin operations |

### RLS Policy Pattern

```sql
-- Correct: subquery form
CREATE POLICY "Users can view own data"
  ON my_table FOR SELECT
  USING (user_id = (SELECT auth.uid()));

-- Correct: using helper function
CREATE POLICY "Users can view org data"
  ON my_table FOR SELECT
  USING (organization_id IN (SELECT get_user_org_ids()));

-- Correct: UPDATE — WITH CHECK mirrors the full scope of USING
CREATE POLICY "Org admins can update org rows"
  ON my_table FOR UPDATE
  USING (organization_id IN (SELECT get_user_admin_org_ids()))
  WITH CHECK (organization_id IN (SELECT get_user_admin_org_ids()));

-- WRONG: bare function call (performance issue)
CREATE POLICY "bad_policy"
  ON my_table FOR SELECT
  USING (user_id = auth.uid());

-- WRONG: WITH CHECK narrower than USING → cross-tenant takeover
-- (an admin can rewrite organization_id into an org they don't administer)
CREATE POLICY "dangerous_update"
  ON my_table FOR UPDATE
  USING (organization_id IN (SELECT get_user_admin_org_ids()))
  WITH CHECK (true);
```

## API Route Security

- **MUST** check authentication on every endpoint: `const user = c.get('user'); if (!user) return c.json({ error: 'Unauthorized' }, 401);`
- **MUST** validate all input with Zod schemas before processing
- **MUST** use `c.get('supabase')` for user-facing database queries — this client respects RLS
- **MUST** validate redirect URLs against an allowlist — never redirect to arbitrary user-supplied URLs
- **MUST** use `createAuthClient()` for `signInWithPassword()` operations — never use the `supabaseAdmin` singleton for auth flows (it stores session state and contaminates subsequent queries)
- **MUST** verify webhook signatures before processing webhook payloads (Stripe uses `stripe.webhooks.constructEvent()`)
- **MUST** perform your own authorization check (super_admin, or org membership via `requireOrgRole`) **before** any `supabaseAdmin` query that touches user-supplied IDs — the service role bypasses ALL RLS, so a missing check is a direct IDOR
- **NEVER** use `supabaseAdmin` for data shown to end users — it bypasses RLS
- **NEVER** return raw database errors to clients — always return a generic error message

### Supabase Client Selection

| Client | Import / Access | RLS | Use For |
|--------|----------------|-----|---------|
| `c.get('supabase')` | Hono context (middleware-injected) | Enforced | All user-facing queries |
| `supabaseAdmin` | `import { supabaseAdmin } from '@/server/lib/supabase'` | Bypassed | Admin operations, webhooks, background jobs |
| `createAuthClient()` | `import { createAuthClient } from '@/server/lib/supabase'` | N/A | `signInWithPassword()` and other auth flows |

### API Endpoint Pattern

```typescript
myRoutes.post('/', async (c) => {
  // 1. Auth check
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  // 2. Input validation
  const body = await c.req.json();
  const result = schema.safeParse(body);
  if (!result.success) {
    return c.json({ error: result.error.issues.map(e => e.message).join(', ') }, 400);
  }

  // 3. Use RLS-enforced client
  const supabase = c.get('supabase');
  const { data, error } = await supabase.from('items').insert(result.data).select().single();

  // 4. Generic error response
  if (error) return c.json({ error: 'Failed to create item' }, 500);
  return c.json({ item: data }, 201);
});
```

## Privileged Services

- **MUST** protect Studio, the Traefik dashboard, n8n, Metabase, and Grafana with `super-admin-auth` (compose) / `admin-auth` (k8s) in production
- **MUST** use Docker socket proxy in production — never mount `/var/run/docker.sock` directly into Traefik
- **NEVER** expose internal Supabase services (Auth, PostgREST, Realtime, Storage) directly — they must go through Kong
- **NEVER** remove ForwardAuth middleware from production compose files or Kubernetes manifests

### Public Exposure (single origin)

The app has **one public origin** (the apex). Traefik path-routes only the **versioned** Supabase prefixes — `/auth/v1`, `/rest/v1`, `/realtime/v1`, `/storage/v1` — to Kong; everything else is the app (SPA + Hono API). Rules:

- **NEVER** add a new public path that reaches Kong or an internal Supabase service, and **NEVER** use a **bare** `/auth` (or `/rest`/`/storage`/`/realtime`) prefix in a Traefik rule — the SPA owns `/auth/callback` and `/reset-password`; a bare `/auth` prefix sends the OAuth landing page to Kong (404) and breaks every login.
- **NEVER** re-introduce an `api.<domain>` host for Supabase. `SITE_URL` is the single origin; it feeds GoTrue redirects, billing return URLs, and CSP.

### Adding a New Admin Service

1. Add Traefik ForwardAuth label in the service's compose config:
   ```yaml
   labels:
     - "traefik.http.routers.myservice.middlewares=super-admin-auth@file"
   ```
2. Create a dev override file that disables the middleware for local development:
   ```yaml
   labels:
     - "traefik.http.routers.myservice.middlewares="
   ```
3. Use `Host(\`myservice.localhost\`)` for the routing rule

### ForwardAuth Middleware Reference

Both gates require `super_admin` (the only elevated platform role). `super-admin-auth` is what every privileged compose router uses; `admin-auth` is its k8s-side equivalent and a seam for future user-defined tiers — it too gates `super_admin` today (see Role Model & Authorization). Never point either at `?role=admin`.

| Middleware | Required Role | Used By |
|-----------|--------------|---------|
| `super-admin-auth` | `super_admin` | Studio, Traefik dashboard, n8n, Metabase, Grafana (Docker Compose) |
| `admin-auth` | `super_admin` | Studio, Traefik dashboard, admin routes (Kubernetes) |

## Environment & Secrets

- **NEVER** commit `.env`, `.env.local`, or any file containing secrets
- **NEVER** hardcode secrets, API keys, or passwords in source code
- **MUST** use the `VITE_` prefix for any environment variable that needs client-side access
- **NEVER** expose `SUPABASE_SERVICE_ROLE_KEY` to the client — it bypasses all RLS
- **MUST** validate all server environment variables in `src/server/lib/env.ts`

## Rate Limiting

Three tiers are configured in `src/server/index.ts`:

| Route Pattern | Limit | Reason |
|--------------|-------|--------|
| `/api/v1/*` | 100/min per IP | Standard API endpoints |
| `/api/webhooks/*` | 500/min per IP | External services (Stripe) send bursts |
| `/api/_internal/*` | 1000/min per IP | Infrastructure calls (Traefik ForwardAuth) |

When adding new route groups, assign an appropriate rate limit tier.

## Infrastructure (Kubernetes)

- **MUST** use deny-all NetworkPolicy as the default — explicitly allowlist each communication path
- **MUST** set pod security context on all new deployments:
  ```yaml
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    readOnlyRootFilesystem: true
    allowPrivilegeEscalation: false
    capabilities:
      drop:
        - ALL
  ```
- **MUST** use `emptyDir` volumes for any writable paths (e.g., `/tmp`)
- **NEVER** run application containers as root (init containers are the only exception)
- **NEVER** add capabilities — drop ALL and don't add any back
