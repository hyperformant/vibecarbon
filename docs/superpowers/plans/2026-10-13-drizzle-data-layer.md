# Drizzle Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Hono server reads and writes Postgres directly through Drizzle over a pooled connection, with row-level security enforced by a per-request transaction, and no longer uses PostgREST for data.

**Architecture:** `carbon/src/server/db/` owns a `pg` Pool, the Drizzle schema (TypeScript mirror of the SQL migrations), `adminDb` (the connection role, which bypasses RLS) and `withUserDb(userId, fn)` (opens a transaction, sets `role = app_user` and `app.user_id` in ONE parameterized round trip via `set_config`, runs `fn(tx)`). RLS policies stop calling `auth.uid()` and call `app.user_id()`. Auth (GoTrue via supabase-js `auth.*`) is untouched in this plan; Better Auth replaces it in the next plan. Migrations stay plain SQL files applied by the existing deploy runner; Drizzle is the query layer and schema declaration.

**Tech Stack:** `drizzle-orm` (pg-core), `pg`, `drizzle-kit` (dev, for `pull`/`check` only), Hono, Vitest, Docker Postgres for RLS tests.

**Spec:** `~/.claude/plans/glowing-bubbling-papert.md`, decisions 1 (keep RLS) and 2 (Drizzle), plus the measured rule "send the RLS wrapper as one round trip".

## Global Constraints

- RLS stays the authorization boundary for user-scoped queries. User-context queries ALWAYS go through `withUserDb`; `adminDb` only where the code today uses `supabaseAdmin`.
- The RLS setup is one parameterized statement: `select set_config('role', 'app_user', true), set_config('app.user_id', $1, true)` inside the transaction. Never interpolate the user id into SQL text.
- New Postgres objects: role `app_user` (NOLOGIN), schema `app`, function `app.user_id() returns uuid` (`select nullif(current_setting('app.user_id', true), '')::uuid`, `stable`). Policies currently written `TO authenticated` with `auth.uid()` become `TO app_user` with `app.user_id()`. `anon`-targeted policies become `TO app_user` only if they are meant for signed-in users; public-read policies (e.g. app_settings read) target `app_user` too, and anonymous server reads go through `withUserDb(null, ...)` which sets `app.user_id` to `''`.
- The app connects with discrete env vars `DB_HOST`, `DB_PORT` (default 5432), `DB_USER` (default `postgres`), `DB_PASSWORD`, `DB_NAME` (default `postgres`) — no URL string, so passwords never need URL-encoding. Pool `max` 10, `idleTimeoutMillis` 30000.
- At startup the server asserts the connection role can bypass RLS (`select rolsuper or rolbypassrls from pg_roles where rolname = current_user`) and logs a fatal error + exits if not, so `adminDb` can never silently become RLS-scoped.
- Migrations: edit the existing SQL files in `carbon/supabase/migrations/` (no customers; base migrations may be rewritten). Directory rename is out of scope (terminology sweep later).
- No new Supabase vocabulary. New identifiers: `adminDb`, `withUserDb`, `app_user`, `app.user_id()`.
- Template uses npm. Conventional commits, pathspec commits, never `--no-verify`.

## Review Focus

1. A route that used the user-scoped client is converted to `adminDb` by accident, silently dropping RLS. Every converted user-context query must stay behind `withUserDb`; Task 6 adds a census test that fails if a route file imports `adminDb` without being on an explicit allowlist that mirrors today's `supabaseAdmin` usage.
2. Pool exhaustion when `fn` inside `withUserDb` throws: the transaction must roll back and release the client. Test in Task 2.
3. A request without a session (anonymous) reaching a user-scoped query: `app.user_id()` is NULL, so policies comparing to it return no rows (not an error). Test in Task 2 against real Postgres.
4. `set_config('role', ...)` leaking past the transaction to the next pooled request: `is_local = true` must reset at COMMIT/ROLLBACK. Test in Task 2 (two sequential calls, the second as admin sees `current_user` = connection role).
5. Database unreachable at boot (db container still starting): server starts, `/api/health` reports db down, requests 503 rather than crash-looping. Test in Task 2.

---

### Task 1: Roles, `app.user_id()`, and policy rewrite (SQL)

**Files:** `carbon/supabase/migrations/00001_init.sql` and every later migration that creates a policy or calls `auth.uid()` (`grep -n "auth.uid()\|TO authenticated\|TO anon" carbon/supabase/migrations/*.sql`); Test: `carbon/tests/db/rls-policies.test.ts` (new `db` vitest project, see Task 2 for the harness; this task may land the harness skeleton early).

- [ ] Add at the top of `00001_init.sql`: create role `app_user` NOLOGIN if missing (DO block), `grant app_user to current_user` is NOT needed (set_config('role') requires membership: grant `app_user` to the connection role `postgres`), create schema `app`, function `app.user_id()`, `grant usage on schema public, app to app_user`, `grant select, insert, update, delete on all tables in schema public to app_user`, `grant execute on all functions in schema public, app to app_user`, and default privileges for future tables.
- [ ] Rewrite every policy: `auth.uid()` → `app.user_id()`, `TO authenticated` → `TO app_user`, `TO anon` → `TO app_user` (anonymous server reads run as `app_user` with an empty id). SECURITY DEFINER helper functions (`get_user_org_ids`, `is_super_admin`, ...) that read `auth.uid()` switch to `app.user_id()`. `is_super_admin` currently reads the JWT/app_metadata: keep its semantics by reading `auth.users.raw_app_meta_data` for `app.user_id()` (auth schema still exists until the Better Auth plan).
- [ ] Failing-then-passing tests against real Postgres: as `app_user` with user A's id, A sees A's org/memberships and not B's; with empty id sees no private rows; public settings readable.
- [ ] Commit `refactor(template): RLS policies read app.user_id() instead of auth.uid()`.

### Task 2: DB module and RLS wrapper

**Files:** Create `carbon/src/server/db/client.ts` (pool, `adminDb`, `withUserDb`, `assertBypassRole`, `pingDb`), `carbon/src/server/db/schema.ts` (Drizzle tables mirroring the SQL; generate a starting point with `npx drizzle-kit pull` against a migrated local db, then hand-tidy names), `carbon/drizzle.config.ts`; Modify `carbon/src/server/lib/env.ts` (DB_* vars), `carbon/package.json` (`drizzle-orm`, `pg`, `@types/pg`, dev `drizzle-kit`), `carbon/vitest.config.ts` (add `db` project: `tests/db/**`, skipped unless `TEST_DB_HOST` is set), `carbon/package.json` script `test:db`; Tests: `carbon/tests/db/with-user-db.test.ts`, `carbon/tests/db/schema-drift.test.ts`.

**Interfaces (produced):**
```ts
export const pool: Pool;
export const adminDb: NodePgDatabase<typeof schema>;
export type UserDb = NodePgTransaction<...>; // the tx type drizzle gives inside db.transaction
export async function withUserDb<T>(userId: string | null, fn: (tx: UserDb) => Promise<T>): Promise<T>;
export async function assertBypassRole(): Promise<void>;
export async function pingDb(): Promise<boolean>;
```
`withUserDb` = `adminDb.transaction(async (tx) => { await tx.execute(sql\`select set_config('role', 'app_user', true), set_config('app.user_id', ${userId ?? ''}, true)\`); return fn(tx); })`.

- [ ] Tests (real Postgres via `TEST_DB_HOST` etc.; document in `carbon/TESTING.md` how to start one with `docker compose up -d db` + migrations): Review Focus 2, 3, 4, 5; `schema-drift.test.ts` asserts every Drizzle table/column exists in `information_schema.columns` after migrations.
- [ ] Wire `assertBypassRole()` + pool into server startup in `carbon/src/server/index.ts`; `/api/health` uses `pingDb()` (replace the `supabaseAdmin` health query).
- [ ] Commit `feat(template): Drizzle client with one-round-trip RLS wrapper`.

### Task 3: Convert settings, theme, docs, MFA settings, setup, crawler tracking

**Files:** `carbon/src/server/lib/docs-settings.ts`, `lib/mfa-settings.ts`, `routes/v1/theme.ts`, `routes/v1/setup.ts`, `middleware/crawler-tracking.ts`, `routes/v1/admin/crawlers.ts`, `routes/v1/stats.ts` (data parts only; `auth.*` calls stay) and their tests in `carbon/tests/integration/server/routes/*` (replace `vi.mock` of supabase with a mock of `@/server/db/client` or real-db tests where RLS matters).
- [ ] Rule: `supabaseAdmin.from(x)...` → `adminDb` Drizzle query with identical filters/ordering/limits and identical response JSON shape (snake_case keys preserved where the client reads them — check the client callers before renaming any field).
- [ ] Commit per file group `refactor(template): <area> reads Postgres through Drizzle`.

### Task 4: Convert org, membership, notification, customer, subscription paths

**Files:** `carbon/src/server/routes/v1/index.ts`, `middleware/requireOrgRole.ts`, `middleware/requirePlan.ts`, `routes/v1/billing.ts`, `routes/webhooks/billing.ts`, `routes/webhooks/stripe.ts`, `src/server/billing/**` data access, `src/server/types.ts` (context type: replace `supabase` client with nothing; routes call `withUserDb(c.get('user')?.id ?? null, ...)`).
- [ ] The Hono context variable `supabase` is removed for data; user-scoped reads use `withUserDb`. Keep the existing tests passing by updating their mocks; add real-db tests for: member of org A cannot read org B's subscription (`billing-subscription-idor` scenario) and notification dismissals are per-user.
- [ ] Commit `refactor(template): org and billing data through Drizzle with RLS`.

### Task 5: Convert admin contact/newsletter/jobs, public contact/newsletter, auth-lockout RPCs, impersonation data

**Files:** `routes/v1/admin/contact.ts`, `admin/newsletter.ts`, `admin/jobs.ts` (`get_cron_jobs` RPC → `adminDb.execute(sql\`select * from get_cron_jobs()\`)`), `routes/v1/contact.ts`, `routes/v1/newsletter.ts`, `routes/v1/auth.ts` (the five lockout RPCs via `adminDb.execute`), `routes/v1/impersonation.ts` (data only), `routes/_internal/verify-role.ts` (data only).
- [ ] Commit `refactor(template): admin, contact, newsletter and lockout data through Drizzle`.

### Task 6: Remove PostgREST from the app path + census guard + deploy wiring

**Files:**
- `carbon/src/server/lib/supabase.ts`: keep only what auth still needs (`createAuthClient`, `refreshUserSession`, admin auth API); delete data-client helpers.
- Census test `carbon/tests/structural/db-access-census.test.ts`: fails if any file under `src/server` calls `.from(` on a Supabase client, or imports `adminDb` while not on the allowlist (allowlist = files that used `supabaseAdmin` for data before this plan, listed explicitly with a one-line reason each).
- Compose (`carbon/docker-compose.yml` app env + `carbon/docker-compose.prod.yml`): `DB_HOST=db`, `DB_PASSWORD=${POSTGRES_PASSWORD}`, `depends_on: db: service_healthy` for app.
- k8s (`carbon/k8s/base/app/deployment.yaml`): `DB_HOST=supabase-supabase-db` (service name of the chart; renamed when the chart goes away), `DB_PASSWORD` already arrives via `envFrom` `vibecarbon-secrets`; add a NetworkPolicy allowing app → db pod port 5432 if the intra-namespace policy does not already (check `carbon/k8s/base/network-policies.yaml`; test with the existing manifest unit tests under `tests/unit/deploy/`).
- Root CLI tests that pin app env / compose services: update.
- [ ] Root `pnpm lint && pnpm test:unit && pnpm test:integration`; carbon `npm run test:prepush && npm run test:db` (with a local db). Commit `refactor(template): app talks to Postgres directly; PostgREST no longer on the data path`.

### Task 7: Local end-to-end smoke

- [ ] `vibecarbon up` equivalent in the worktree (`pnpm dev` from repo root, or `cd carbon && node scripts/dev-init.js && docker compose up -d` + `npm run dev`), sign in as the dev admin, load dashboard, settings, admin pages, create an org, toggle theme; capture `curl` evidence of 3 API calls returning 200 with data. Paste into the report. No commit unless fixes are needed.
