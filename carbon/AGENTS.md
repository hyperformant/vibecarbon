# AGENTS.md

Guidance for AI coding agents working on this codebase. The **Security Rules** section below is mandatory — violations introduce real vulnerabilities.

## Tech Stack

- **Frontend**: React 19, Vite, React Router, TanStack Query, Shadcn UI, Launch UI, Tailwind CSS v4, i18next
- **Backend**: Hono (lightweight Node.js framework), Pino logger, Zod validation, nodemailer (SMTP email)
- **Auth/Database**: In-process auth (Better Auth, `src/server/auth/`) on self-hosted Supabase (PostgreSQL, Realtime); the API server queries Postgres directly with Drizzle ORM (node-postgres); file uploads go to S3 object storage via presigned URLs
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
npm run test:integration # Hono routes with mocked database/Auth/Stripe/SMTP
npm run test:watch      # Vitest watch mode
npm run test:coverage   # Generate coverage/ report (v8)
npm run test:prepush    # What the pre-push git hook runs

# Docker
npm run docker:up       # Start Supabase services
npm run docker:down     # Stop services
npm run docker:reset    # Remove containers, volumes, and built images
npm run db:migrate      # Apply pending database migrations (the app also does at startup)
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
│   ├── lib/                 # auth-client.ts, api.ts, i18n.ts, utils.ts, blog/changelog/docs loaders
│   └── locales/             # i18n translation files
├── server/                  # Hono API (Node.js on :3000)
│   ├── index.ts             # App entry, middleware, route mounting
│   ├── routes/              # health.ts, v1/, webhooks/, _internal/
│   ├── db/                  # client.ts (withUserDb, adminDb), schema.ts (Drizzle tables), errors.ts
│   ├── emails/              # React Email templates
│   ├── auth/                # In-process auth (Better Auth): sessions, 2FA, impersonation, ForwardAuth tokens
│   └── lib/                 # auth.ts (isSuperAdmin), env.ts, email.ts, stripe.ts, logger.ts, rate-limiter.ts, seo.ts
├── shared/                  # Shared TypeScript types (types.ts, pricing.ts)
content/                     # MDX content (blog/, changelog/, docs/)
db/migrations/               # Drizzle migrations, applied by the app at startup (see Changing the Database Schema)
```

### API Routes

| Route | Description |
|-------|-------------|
| `GET /api/health` | Liveness probe (no DB check, public) |
| `GET /api/health/ready` | Readiness probe (checks DB connectivity, public) |
| `GET/POST /api/auth/*` | In-process auth (Better Auth): sign-up, sign-in (with account lockout), sign-out, session, OAuth callbacks, email verification, password reset, magic link |
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
| `POST /api/auth/admin/impersonate-user` | Impersonate a regular user for at most 1 h (super admin, aal2 while MFA is on); `POST /api/auth/admin/stop-impersonating` returns |
| `POST/DELETE /api/v1/admin/forwardauth-cookie` | Mint/clear the `vc-admin-token` ForwardAuth cookie (super admin, aal2 while MFA is on) |
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
| `POST /api/v1/files/presign` | Get a signed upload URL for an avatar or private file (`{kind, contentType, size}`) |
| `GET /api/files/<key>` | 302 to a 5-minute signed download URL (404 unless you may read it) |
| `GET /api/_internal/verify-role` | Traefik ForwardAuth |
| `POST /api/webhooks/billing` | Billing webhook handler (Stripe/Paddle/Polar) |
| `POST /api/webhooks/stripe` | Stripe webhook handler (backward compat) |
| `GET /api/docs` | Scalar API reference (dev only) |

### Authentication Flow

1. **Auth endpoints**: the in-process auth (`src/server/auth/`, Better Auth) at `/api/auth/*` handles sign-up, sign-in (email/password, Google/Microsoft, magic link), sign-out and sessions, and sets an HttpOnly session cookie
2. **API requests**: the browser sends that cookie with every same-origin request; page JS never sees a session token (no `Authorization` header, no token in any response body)
3. **Server middleware** (`src/server/middleware/session.ts`): reads the session cookie with `auth.api.getSession()` (`src/server/auth/`), sets `c.get('user')` and `c.get('session')` (the session's assurance level is `session.twoFactorVerified`; gate on it with `requireAal2`)
4. **RLS**: Routes run user queries through `withUserDb(user.id, ...)`, so row-level security decides what the caller sees

**Two-factor and assurance level** (`src/server/auth/assurance.ts`): users enroll TOTP (authenticator app) with backup codes. A session is `aal2` when it passed a second factor itself (`session.twoFactorVerified`, written only by the verify hook, never client input); every other session is `aal1`. A password sign-in with 2FA enabled stops at a code; a magic-link, social or trusted-device sign-in does not, and stays `aal1` until the user verifies a code from that session (step-up: `POST /api/auth/two-factor/verify-totp`). Gate sensitive routes with `requireAal2` / `assertAal2` (`src/server/middleware/requireAal2.ts`): it passes `aal2`, or anyone while MFA is globally off (`app_settings.mfa_enabled`), else answers 403 `mfa_required` with `mfa_enrolled` telling the client to verify (true) or enroll (false). Better Auth's `/api/auth/admin/*` endpoints follow the same rule, and reading, regenerating or removing an enrolled factor always needs `aal2`. Step-up attempts share the factor's lock (10 wrong codes lock it for 15 minutes), so someone holding a stolen session can lock the owner out of verifying codes for that long; magic link and social sign-in keep working meanwhile. Rules the client must handle on `/api/auth/two-factor/*`: an account with no password (social or magic link only) and no confirmed factor can enable, read the setup URI, regenerate backup codes, or confirm its first code only from a session signed in within the last 10 minutes, else 403 `{ error: 'reauth_required' }` (send the user to sign in again); disable answers 403 `TWO_FACTOR_NOT_ENABLED` when nothing is enrolled; an impersonation session gets 403 `IMPERSONATION_NOT_ALLOWED` on every two-factor endpoint; a session cookie whose session has ended gets 401 `SESSION_EXPIRED`. The password itself cannot be unlinked (`/api/auth/unlink-account` on the credential account answers 403 `PASSWORD_UNLINK_NOT_ALLOWED`).

## Database Access

This is the #1 source of bugs. The server talks to Postgres through `src/server/db/client.ts` and nothing else:

```typescript
import { and, eq } from 'drizzle-orm';
import { adminDb, withUserDb } from '../../db/client';
import { items } from '../../db/schema';

// Anything done for a user (or an anonymous visitor: pass null). Runs in one
// transaction as role app_user with app.user_id set, so RLS applies to every
// statement inside. This is the default.
const rows = await withUserDb(user.id, (tx) =>
  tx.select().from(items).where(eq(items.organizationId, orgId))
);

// Only where the server acts for itself: webhooks, admin tools, jobs.
// adminDb BYPASSES RLS and sees every row of every user.
await adminDb.insert(items).values({ ... });
```

- **Default to `withUserDb`.** `adminDb` is allowed only in the files listed (with a reason each) in `tests/structural/db-access-census.test.ts`; that test fails on any other import. Adding a file there is a security decision.
- **Before any `adminDb` query that takes a user-supplied id**, check authorization yourself (super_admin, or org membership via `requireOrgRole`). RLS is not there to catch you.
- **Never build SQL text from input.** Use Drizzle's query builder or the `sql` template, which binds values as parameters. Never `sql.raw()` user input. RLS inside `withUserDb` catches logic mistakes (a missing `where`), not injection: injected SQL could `reset role`.
- **Log database errors through `dbErrorForLog(err)`** (`src/server/db/errors.ts`), and never log or return `err.message` of one: Drizzle puts the SQL and every bound value (emails, tokens) in it. The logger strips them from `err`/`error` fields as a backstop.
- **The server has no Supabase client.** Auth is the in-process auth API (`src/server/auth/`); users are rows in `"user"`, read and written through `adminDb` in the census-allowlisted files (the auth tables have no `app_user` privileges). The census fails on any `@supabase/supabase-js` import under `src/server`.
- **Schema changes** start in `src/server/db/schema.ts` and become a migration with `npx drizzle-kit generate` (see Changing the Database Schema); `tests/structural/migrations-drift.test.ts` fails while a change has no migration.

## Key Patterns

### Adding an API Endpoint

1. Create route in `src/server/routes/v1/` — follow existing routes for the `Variables` type, Zod validation, and auth check pattern
2. Mount in `src/server/index.ts`: `app.route('/api/v1/items', myRoutes)`

### Adding a Page

1. Create component in `src/client/pages/` — use `SidebarProvider` + `AppSidebar` + `SidebarInset` layout (see existing pages)
2. Add route in `src/client/App.tsx` wrapped in `<ProtectedRoute>`
3. Classify it for search: add the path to `PRIVATE_ROUTES` in `src/shared/routes.ts` (served `200` + `noindex`), or, for a public page, a manifest entry in `scripts/generate-seo.ts`. Unclassified routes return `404` on a hard load; `tests/structural/route-indexing.test.ts` enforces this.

### Rebranding the logo

Logo artwork lives in `src/client/assets/` and renders via `src/client/components/Logo.tsx`. To rebrand, replace these SVGs in place (keep the filenames):

- `logo-light.svg` / `logo-dark.svg` — the full logo lockup (`<Wordmark>`: nav, footers, auth pages). **Minimum to replace.**
- `logo-icon.svg` — the standalone mark (`<Logo>`: collapsed sidebar, plus the marketing-section motif). **Minimum to replace.**
- `logo-wordmark-light.svg` / `logo-wordmark-dark.svg` — the wordmark alone (`<WordmarkText>`); only needed if you keep the collapsible sidebar header.
- `public/favicon.svg` — the browser-tab icon (separate square asset).

Set `VITE_PROJECT_NAME` to your project name; it supplies the logo images' `alt` text and the page/SEO titles.

### Changing the Database Schema

`src/server/db/schema.ts` is the source of truth for tables, columns, constraints, indexes, foreign keys and RLS policies (`pgPolicy`, with `appUser` from the same file for `to: appUser`). `drizzle-kit` turns a change there into a SQL migration in `db/migrations/`, and **the app applies pending migrations itself at startup** (`src/server/db/migrate.ts`, under a Postgres advisory lock so replicas take turns, ledger in `drizzle.__drizzle_migrations`). Nothing else applies migrations: no deploy step, no psql. `npm run db:migrate` runs the same code locally. Until migrations are applied the server answers every route except `/api/health` with 503, and `/api/health` reports `migrationStatus` (`pending | applied | failed`); a failed migration is final for that boot, so fix it and restart.

1. **Tables, columns, indexes, policies**: edit `schema.ts`, then
   ```bash
   npx drizzle-kit generate --name add_projects   # writes db/migrations/NNNN_add_projects.sql + meta/
   ```
   A new table needs: `id uuid().defaultRandom().primaryKey()`, `createdAt`/`updatedAt`, an index on every foreign key column, and RLS in the same migration: `pgPolicy` entries using `(SELECT app.user_id())` and the org helpers, with `withCheck` mirroring `using` on every write policy (see `organizations` and `memberships`, and Database Security below). Name constraints and indexes explicitly (`unique('projects_slug_key')`, `foreignKey({ name: 'projects_org_id_fkey', ... })`, `index('idx_projects_org_id')`).
2. **Anything drizzle-kit cannot model** (functions, triggers such as `update_updated_at()`, grants and revokes, pg_cron schedules, seed rows, extensions):
   ```bash
   npx drizzle-kit generate --custom --name projects_triggers   # an empty migration to fill in
   ```
   Separate statements with `--> statement-breakpoint`. A `SECURITY DEFINER` function needs `SET search_path = ''` and, unless policies call it, `REVOKE EXECUTE ... FROM PUBLIC, app_user`.
3. Start the app (or `npm run db:migrate`), add API types to `src/shared/types.ts`, and run `npm run test:prepush`.

Rules:

- **Never edit or delete a migration that has been applied anywhere** (deployed, or on a teammate's machine). The ledger records it as done, so an edit never runs; write a new migration instead.
- **Renames**: `drizzle-kit generate` asks whether a column or table was renamed or dropped and re-created. Answer the prompt (a rename keeps the data), or write the `ALTER ... RENAME` in a `--custom` migration.
- **Your `db/migrations/` is your project's own history.** It starts with the template's baseline (`0000_baseline_pre.sql`, `0001_baseline_schema.sql`, `0002_baseline_post.sql`) and grows with every `generate`. `vibecarbon upgrade` never writes to `db/migrations/**`, and a feature that brings tables (`vibecarbon add ...`) ships its schema as its own new migration appended to this history, never as an edit to an existing one.
- `tests/structural/migrations-drift.test.ts` (in `test:prepush`) fails when `schema.ts` has a change with no migration: run `npx drizzle-kit generate`.

### Data Fetching (TanStack Query)

**NEVER use raw `fetch` in `useEffect`** — always use `useQuery` for reads and `useMutation` for writes. Raw fetch in useEffect bypasses TanStack Query's deduplication, caching, and retry logic, and React StrictMode will double-fire it in development.

```typescript
// CORRECT: useQuery with auth guard
const { data, isLoading } = useQuery({
  queryKey: ['items', orgId],
  queryFn: () => apiJson<Item[]>(`/api/v1/items?orgId=${orgId}`, {}, 'Failed to fetch items'),
  enabled: !!user && !!orgId, // Skip fetch when unauthenticated or missing params
});

// WRONG: raw fetch in useEffect
useEffect(() => {
  fetch('/api/v1/items').then(r => r.json()).then(setItems);
}, []);
```

Rules:
- **Gate authenticated queries** with `enabled: !!user` to prevent 401s for logged-out users
- **Call the API through `apiJson` / `apiFetch`** from `@/lib/api.ts`. The session is an HttpOnly cookie the browser sends same-origin; there is no token in page JS, so never add an `Authorization` header. When a route answers 403 `mfa_required`, `apiFetch` asks the user for a code (or sends them to enroll) and retries once; `reauth_required` sends them to sign in again
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
| `user`, `session`, `account`, `verification`, `two_factor` | Auth (Better Auth). Server-only: RLS on with no policies, `app_user` has no privileges. `user.role = 'super_admin'` is the platform admin. Every `user_id` FK references `"user"(id)` |
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
| `integration` | node | Hono route handlers end-to-end via `app.request()`, with the database, the auth API, Stripe and SMTP mocked at the module boundary | `tests/integration/` |
| `db` | node | RLS policies and SQL against a real Postgres (skipped unless `TEST_DB_HOST` is set; see `TESTING.md`) | `tests/db/` |

Helpers live in `tests/_helpers/`:

- `app.ts` — `mountRoute(prefix, routes)` to build a tiny Hono app for one route; `jsonPost(body)` for request boilerplate.
- `factories.ts` — `makeUser`, `makeOrg`, `makeContactSubmission` for plausible domain fixtures.
- `jwt.ts` — `mockJwt(payload)` for HS256-signed test tokens.
- `env.ts` — `mockEnv({...})` returning a restore closure (no globals).
- `setup-rtl.ts` — vitest setup for the component project (jest-dom matchers + RTL cleanup).
- `setup-integration.ts` — seeds plausible env values so server modules load without zod-validation errors.

**Mocking conventions:**
- Database: `vi.mock('@server/db/client', () => ({ adminDb: { select: () => queryChain(() => rows) }, withUserDb: ... }))`. `queryChain` (`tests/_helpers/drizzle-mock.ts`) stands in for any Drizzle chain. Prove RLS itself in the `db` tier, never with mocks.
- Server auth: `vi.mock('@server/auth', () => ({ auth: { api: { getSession: vi.fn() } } }))` for a route that calls the auth API itself; most routes only read `c.get('user')` / `c.get('session')`, so seed those in a pre-route middleware instead. Prove real auth flows in the `db` tier (`tests/db/auth*.test.ts`, `tests/db/admin-surfaces.test.ts`).
- Client auth: `vi.mock('@/lib/auth-client', () => ({ authClient: { signIn: { email: vi.fn() }, getSession: vi.fn(), ... } }))`. Each call resolves `{ data, error }` and never throws. See `tests/component/auth-provider.test.tsx`.
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
| `backend-engineer` | Backend APIs, database, Docker/K8s, server logic | `npm run lint` + `npm run typecheck` + `npm run test:security` on idle |
| `frontend-engineer` | Frontend pages, components, layouts, styling | `npm run lint` + `npm run typecheck` + `npm run test:security` on idle |
| `security-reviewer` | Security audit after backend/infra changes | — |
| `test-maintainer` | Test writing after any meaningful code change | `npm test` on task complete |

**Typical workflow**: Use the lead-coordinator for complex multi-step tasks. It decomposes the work, spawns specialists in dependency order (migrations -> API -> security review -> frontend -> tests), and synthesizes results. For simple single-domain tasks, invoke the specialist directly.

**Quality gates** are enforced via hooks in `.claude/hooks/`:
- `teammate-idle-gate.sh` — lint + typecheck + security invariants before backend/frontend engineers go idle
- `task-completed-gate.sh` — the full test suite must pass before QA marks a task complete

**Configuration**: the agent definitions live in `.claude/agents/`, one `.md` per agent — edit them to teach the team about your project. `.claude/settings.json` registers the hooks and the `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env var required for agent teams, and each agent keeps notes under `.claude/agent-memory/<agent>/`.

## File Uploads (signed URLs)

Files go from the browser straight to the S3 bucket. They never touch the server's disk and never pass through Hono, so uploads stay fast and the VPS stays small. The server only signs short-lived URLs (`src/server/lib/storage.ts`).

- **Upload**: the client calls `POST /api/v1/files/presign` with `{kind, contentType, size}` and gets back `{key, url, headers, expiresIn, fileUrl}`. It then `PUT`s the file to `url` with those `headers`. The URL expires after 300 seconds.
- **Read**: `GET /api/files/<key>` answers with a 302 to a 5-minute signed URL. Anything the caller may not read is a 404, so key existence does not leak.
- **Kinds**: `avatar` (max 2 MB; jpeg, png, gif, webp; readable by anyone through the app) and `private` (max 10 MB; jpeg, png, gif, webp, pdf, txt, csv; readable only by the owner and served as a download). Keys look like `avatars/<userId>/<uuid>.<ext>` and `private/<userId>/<uuid>.<ext>`.
- **Components**: `FileUpload` takes a `kind` and an optional `prepare` hook that transforms the file before upload. `AvatarUpload` uses it to resize to a 256px WebP in the browser.
- **Showing files**: a `fileUrl` works as a plain link. An avatar is `<img src={fileUrl}>`, since anyone may read it. A private file is `<a href={fileUrl} download>` or `<img src={fileUrl}>` too: the browser sends the HttpOnly session cookie with the request, so the owner gets the signed read and anyone else a 404. To hand the bytes to code instead (a preview, a parse), fetch them with `apiFetch`, which follows the redirect (the bucket CORS allows `GET` from your origin):

  ```ts
  const res = await apiFetch(fileUrl);
  if (!res.ok) throw new Error(t('upload.failed'));
  const href = URL.createObjectURL(await res.blob());
  // <a href={href} download> or <img src={href}>; URL.revokeObjectURL(href) when done
  ```
- **Optional**: when any `S3_*` variable (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`) is missing, presign returns `503 storage_not_configured` and reads return 404. The app still boots.
- **Local dev**: a SeaweedFS `s3` service in `docker-compose.override.yml` listens on `127.0.0.1:8333`. `scripts/ensure-dev-bucket.js` creates the bucket and its CORS rules on dev start, and `vibecarbon create` writes the dev `S3_*` variables.
- **Deployed**: `vibecarbon deploy` provisions your provider's native S3 bucket and sets its CORS for `https://<your-domain>`. The bucket stays private; never add public-read ACLs or bucket policies.
- **NEVER** accept file bytes in a route or write them to disk. Add new file kinds in `storage.ts`, with an explicit size cap and content-type allowlist.

## Important Notes

- **Prefer existing patterns** — follow the established code style in existing routes/components
- **Auth is the in-process auth API** (`src/server/auth/`, `/api/auth/*`). On the client use `useAuth()` (`src/client/components/auth/AuthProvider.tsx`), which wraps `authClient` (`src/client/lib/auth-client.ts`); don't hand-roll sign-in, session or two-factor calls
- **Two UI libraries** — build UI from **Shadcn UI** primitives (`src/client/components/ui/`) for interface elements (buttons, inputs, dialogs, dropdowns, tabs, tooltips, badges) and **Launch UI** blocks (MIT, vendored copy/paste; retinted to the OKLCH palette) for marketing/landing sections (hero, feature grids, pricing, FAQ, CTA). Write a custom component only when neither covers the need, and note what was missing in a short comment.
- **Add Shadcn components** with `npx shadcn@latest add [component-name]`

---

# Security Rules (Mandatory)

The rules below are mandatory — violations introduce real vulnerabilities. The three most critical:

1. **Always check auth** — every endpoint must verify `c.get('user')` and return 401 if null
2. **Always validate input** — use Zod schemas for all API request bodies before processing
3. **Use `withUserDb(user.id, ...)` for user data** — never use `adminDb` for queries shown to end users; it bypasses RLS

## Role Model & Authorization

There are **two independent role axes** — do not conflate them:

- **Platform role** lives in the server-controlled `user.role` column. The only elevated value is **`super_admin`**. There is **no platform `admin` role.** Check it with `isSuperAdmin(user)` (server) or `is_super_admin()` (SQL). Every platform-admin surface (the `/admin/*` API, Studio, Grafana, n8n, Metabase, the Traefik dashboard) requires `super_admin`.
- **Org role** lives in the `memberships` table as `OWNER` / `ADMIN` / `MEMBER`. This is a per-organization membership tier enforced by RLS (`get_user_admin_org_ids()` etc.) and `requireOrgRole(...)`. An org `ADMIN` has authority **only within its own org** and **never** any platform capability.

Rules:

- **MUST** read the role only through `isSuperAdmin(user)` (exact match on `user.role`) or `is_super_admin()` in SQL. **NEVER** gate anything on a field the user can write (`name`, `image`, `onboardingCompleted`, anything set through `/api/auth/update-user`): that is a self-service privilege escalation.
- **MUST** gate a super-admin API route with `requireSuperAdmin` (middleware) or `checkSuperAdmin(c)` (inline), both in `src/server/middleware/requireSuperAdmin.ts`. They check the role, then the aal2 rule of `requireAal2`: while MFA is globally on, the session must have verified a second factor, so an aal1 admin session can't turn MFA off. A bare `if (!isSuperAdmin(user))` in a route fails `tests/structural/security-invariants.test.ts`.
- **MUST** keep every admin-gated surface accepting `super_admin`. If you ever introduce a user-defined tier below super_admin, the ForwardAuth gate must be `?roles=<tier>,super_admin` (any-of) and the code check `isSuperAdmin(user) || is<Tier>(user)` — a bare `role === 'admin'` / `?role=admin` **locks super admins out** and is a bug.
- **MUST NOT** trust the `X-User-Id` / `X-User-Email` / `X-User-Role` / `X-Authenticated-User` request headers as auth input. Traefik sets them for downstream services (e.g. Grafana) and strips client-supplied copies; app code derives identity **only** from the cookie session the session middleware verified: `c.get('user')` / `c.get('session')`.
- **MUST NOT** add a public route or client flow against `/api/_internal/verify-role` — it is the ForwardAuth trust anchor, denied on the public edge and called by Traefik internally only.
- **NEVER** add an API path that writes `user.role`. Role assignment is operator-bootstrap only: the app makes `ADMIN_EMAIL` a super admin at startup (`src/server/auth/bootstrap-admin.ts`), the admin plugin's set-role path is disabled, and the `super_admin` access-control role has no `set-role` permission.

## Session Cookies & ForwardAuth (split-cookie contract)

Two cookies, two jobs — never merge them (spec `2026-07-24-session-cookie-split`, invariants pinned in `tests/structural/security-invariants.test.ts`):

- **The session cookie** is set by the auth API (`/api/auth/*`): **HttpOnly** and **host-only** (apex). Page JS never sees it or any session token, and the SPA keeps no session store of its own. It **MUST NOT** get a `domain=` attribute: a parent-domain scope would send every user's session to every admin subdomain, where XSS in any bundled tool (Grafana, Metabase, n8n) could ride it. It is **NOT** a ForwardAuth credential.
- **`vc-admin-token`** is the only credential `/api/_internal/verify-role` accepts (no session cookie, no `Authorization` / `X-Forwarded-Access-Token` header): **HttpOnly**, 1h, parent-domain scoped, minted by `POST /api/v1/admin/forwardauth-cookie` for super admins only (aal2 while MFA is globally on, never from an impersonation session). It carries a dedicated ForwardAuth token, **never the session token** (the parent-domain cookie reaches Grafana, n8n, Metabase and Studio): 32 random bytes, stored only as a SHA-256 hash in the `verification` table (`forwardauth:<hash>`, bound to the minting session, expires in 1 h; minting again keeps the session's two newest tokens, DELETE forgets all of them). verify-role looks the hash up, then the bound session, from the database every time, so an expired or forgotten token, signing out, a revoked or banned session, a role change, or MFA turned on with an aal1 session ends it at once. The token is useless against the app's own API. Never log it. Regular users carry no domain-wide cookie at all. **NEVER** let verify-role read the app's session cookie.
- **Impersonation never client-stores the admin session.** The client impersonates through the admin plugin (`POST /api/auth/admin/impersonate-user`, `stop-impersonating`), which keeps the admin's session server-side in its own HttpOnly signed cookie. Rules (`src/server/auth/impersonation.ts`): super admin only, aal2 while MFA is on, never yourself (400 `CANNOT_IMPERSONATE_SELF`), never another super admin (403 `CANNOT_IMPERSONATE_ADMIN`), no nesting. The impersonation session lasts at most 1 h (its expiry never slides forward), and may not change how the account signs in or read its provider tokens (`/change-password`, `/change-email`, `/link-social`, `/unlink-account`, `/verify-password`, token endpoints: 403 `IMPERSONATION_NOT_ALLOWED`), touch two-factor, mint the ForwardAuth cookie, or pass `requireAal2` (403 `impersonation_not_allowed`). **NEVER** write a session into `localStorage`/`sessionStorage`.

## Database Security (RLS)

**Why this is load-bearing:** every user request's queries run through `withUserDb` as role `app_user`. RLS is what stands between one tenant's rows and another's — a missing or under-scoped policy is a live data breach, not a theoretical one. Enable RLS + write policies in the **same migration** that creates the table, before it ships.

- **MUST** enable RLS on every new table: give it `pgPolicy(...)` entries in `schema.ts` (which enables RLS), or `.enableRLS()` for a server-only table with no policies
- **MUST** give every `UPDATE`/`INSERT` policy a `WITH CHECK` that mirrors the full scope of its `USING`. Postgres evaluates `USING` (which rows you may target) and `WITH CHECK` (what the row may become) **independently** — a `WITH CHECK` that drops the org/owner scope lets a user rewrite a row they can see into a tenant they cannot, a cross-tenant takeover. Never rely on the implicit `WITH CHECK = USING` default for a boundary column.
- **MUST** use `(SELECT app.user_id())` in RLS policies, not bare `app.user_id()` — the subquery form prevents the query planner from re-evaluating per row. User requests run as role `app_user` with `app.user_id` set for the transaction (`NULL` when anonymous); `auth.uid()` is never set on that path, so a policy reading it silently matches nothing
- **MUST** read roles in policies via `is_super_admin()`, which reads the caller's server-controlled `"user".role` (SECURITY DEFINER, since `app_user` cannot read the auth tables)
- **NEVER** add a policy or grant for `app_user` on the auth tables (`user`, `session`, `account`, `verification`, `two_factor`): they hold password hashes, session tokens and TOTP secrets. Expose what a user may see through a server route
- **MUST** `REVOKE EXECUTE ... FROM PUBLIC, app_user` on any `SECURITY DEFINER` function meant only for the server (functions get `app_user` EXECUTE by default privileges, and SECURITY DEFINER bypasses RLS), so only `adminDb` can call it
- **MUST** use `SECURITY DEFINER` + `SET search_path = ''` on all helper functions used in RLS policies
- **NEVER** disable RLS on existing tables
- **NEVER** use `USING (true)` as a policy for user data — every table needs real ownership checks
- **NEVER** add an `app_user` `INSERT`/`UPDATE` policy on a table written only by the server (e.g. billing `customers`/`subscriptions`) — leave it server-only (`adminDb`) rather than opening needless write surface
- **NEVER** grant direct table access to `app_user` beyond what RLS policies allow

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
  USING (user_id = (SELECT app.user_id()));

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
  USING (user_id = app.user_id());

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
- **MUST** use `withUserDb(user.id, ...)` for user-facing database queries — RLS applies inside it
- **MUST** validate redirect URLs against an allowlist — never redirect to arbitrary user-supplied URLs
- **MUST** verify webhook signatures before processing webhook payloads (Stripe uses `stripe.webhooks.constructEvent()`)
- **MUST** perform your own authorization check (super_admin, or org membership via `requireOrgRole`) **before** any `adminDb` query that touches user-supplied IDs — `adminDb` bypasses ALL RLS, so a missing check is a direct IDOR
- **NEVER** use `adminDb` for data shown to end users — it bypasses RLS
- **NEVER** build SQL text from input — query builder or the `sql` template only (values become bound parameters)
- **NEVER** return raw database errors to clients (`sanitizeError(err, 'Failed to ...')`), and log them as `{ err: dbErrorForLog(err) }` — a Drizzle error message carries the query's bound values

### Data and Auth Client Selection

| Client | Import | RLS | Use For |
|--------|--------|-----|---------|
| `withUserDb(userId, fn)` | `src/server/db/client.ts` | Enforced (`app_user`) | All user-facing queries; `null` user for anonymous reads |
| `adminDb` | `src/server/db/client.ts` | Bypassed | Webhooks, admin tools, jobs; census allowlist only |
| `auth.api.*` | `src/server/auth/index.ts` | N/A (auth tables) | Server-side auth calls (`getSession`, ...); sessions and users otherwise come from `c.get('user')` / `c.get('session')` |

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

  // 3. Query as the user: RLS decides what this insert may write
  try {
    const [item] = await withUserDb(user.id, (tx) =>
      tx.insert(items).values({ ...result.data, createdBy: user.id }).returning()
    );
    return c.json({ item }, 201);
  } catch (err) {
    // 4. Generic error response; params stripped from the log
    logger.error({ err: dbErrorForLog(err) }, 'Failed to create item');
    return c.json({ error: 'Failed to create item' }, 500);
  }
});
```

## Privileged Services

- **MUST** protect Studio, the Traefik dashboard, n8n, Metabase, and Grafana with `super-admin-auth` (compose) / `admin-auth` (k8s) in production
- **MUST** use Docker socket proxy in production — never mount `/var/run/docker.sock` directly into Traefik
- **NEVER** expose internal Supabase services (PostgREST, Realtime) directly — they must go through Kong
- **NEVER** remove ForwardAuth middleware from production compose files or Kubernetes manifests

### Public Exposure (single origin)

The app has **one public origin** (the apex). Traefik path-routes only the **versioned** Supabase prefixes — `/rest/v1`, `/realtime/v1` — to Kong; everything else is the app (SPA + Hono API, auth at `/api/auth`). Rules:

- **NEVER** add a new public path that reaches Kong or an internal Supabase service, and **NEVER** use a **bare** `/rest`/`/storage`/`/realtime` prefix, or any `/auth` prefix, in a Traefik rule — the SPA owns `/auth/callback` and `/reset-password`, and auth is the app's own `/api/auth`. **NEVER** run or route a separate auth service (`tests/structural/security-invariants.test.ts` fails on any `/auth/v1` route).
- **NEVER** re-introduce an `api.<domain>` host for Supabase. `SITE_URL` is the single origin; it feeds auth links and OAuth callbacks, billing return URLs, and CSP.

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

## CSRF

Sessions are cookies, so every mutating `/api/*` request (anything but GET, HEAD, OPTIONS) that carries a Cookie header passes an origin check, whatever its content type (`src/server/middleware/csrf.ts`, against `allowedOrigins()` in `src/server/lib/origins.ts`: `SITE_URL`, `CORS_ORIGINS` and the dev ports, each normalized to its origin). The `Origin` header must be one of ours; a `null` Origin is refused. Without an `Origin`, the `Referer`'s origin must be one of ours. With neither, only `Sec-Fetch-Site: same-origin` passes. Anything else gets a 403. `/api/auth/*` is checked by Better Auth itself; `/api/webhooks/*` is exempt and verifies signatures instead; `/api/_internal/verify-role` is exempt because Traefik ForwardAuth relays the admin tool's own Origin and it reads only the `vc-admin-token` cookie; the rest of `/api/_internal/*` (services restart) acts on the session cookie and is checked like any route. A new webhook route belongs under `/api/webhooks/`. A script that calls the API with a session cookie must send a matching `Origin`.

## Rate Limiting

These limits are configured in `src/server/index.ts` (the `/api/auth` caps in `src/server/middleware/auth-rate-limits.ts`):

| Route Pattern | Limit | Reason |
|--------------|-------|--------|
| `/api/v1/*` | 100/min per IP | Standard API endpoints |
| `/api/webhooks/*` | 500/min per IP | External services (Stripe) send bursts |
| `/api/auth/*` | 100/min per IP | Auth endpoints |
| `/api/auth/sign-in/email` | 10/15min per IP | Credential stuffing across emails (the account lockout is per email + IP) |
| `/api/auth/sign-in/social` | 10/min per IP | Starts an OAuth redirect |
| `/api/auth/sign-in/magic-link` | 5/min per IP | Sends an email |
| `/api/auth/sign-up/*`, `change-password`, `change-email`, `two-factor/*` | 3/10s per IP | Account creation and credential changes |
| `/api/auth/request-password-reset`, `send-verification-email` | 3/min per IP | Sends an email |
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
