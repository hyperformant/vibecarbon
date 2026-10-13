# Testing

Four tiers, picked to mirror what each tier actually proves:

| Tier | Env | Wall-clock | What it tests |
|---|---|---|---|
| `unit` | node | <1s | Pure functions, validators, pricing/format helpers, cross-cutting invariants |
| `component` | jsdom | a few s | React components + custom hooks via React Testing Library |
| `integration` | node | <30s | Hono route handlers end-to-end with externals (database, Supabase Auth, Stripe, SMTP) mocked |
| `db` | node | a few s | RLS policies and SQL against a real Postgres (skipped unless `TEST_DB_HOST` is set) |

Run them:

```bash
npm test               # every tier
npm run test:unit
npm run test:component
npm run test:integration
npm run test:db         # real Postgres, see "Database tier" below
npm run test:watch     # vitest watch mode (all tiers)
npm run test:coverage  # writes coverage/ HTML (v8)
npm run test:prepush   # what the pre-push git hook runs (lint + all three tiers)
```

The pre-push hook is installed automatically by `vibecarbon create` — bypass with `git push --no-verify` only if you understand why the tests are red.

## Database tier

RLS is the boundary between tenants, and only the engine that enforces it can prove it. The `db` tier (`tests/db/`) runs against a real Postgres: each test opens a transaction, switches to the `app_user` role with `app.user_id` set, and checks which rows come back. Every suite skips itself unless `TEST_DB_HOST` is set, so `npm test` stays fast and offline.

To run it, start the local database and auth service, apply the migrations, then point the tests at it:

```bash
node scripts/dev-init.js        # once: writes .env and the generated compose files
docker compose -f docker-compose.yml -f docker-compose.override.yml \
  -f docker-compose.dev-init.yml up -d --wait db auth
npm run db:migrate
TEST_DB_HOST=localhost TEST_DB_PASSWORD=<POSTGRES_PASSWORD from .env> npm run test:db
```

`auth` comes up alongside `db` because it finishes the `auth.users` table that the migrations' super-admin seed writes to. The tests themselves only need `db`.

Optional overrides: `TEST_DB_PORT` (default 5432), `TEST_DB_USER` (default `postgres`, the app's connection role, which bypasses RLS and is a member of `app_user`), `TEST_DB_NAME` (default `postgres`). The suites insert their own users and orgs with random ids and delete them afterwards.

When you are done, tear the stack down (`-v` drops the database volume):

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml \
  -f docker-compose.dev-init.yml down -v
```

The tier also runs the server's own DB module (`src/server/db/client.ts`) against that database: `tests/_helpers/setup-db.ts` copies the `TEST_DB_*` values into the `DB_*` vars the server reads, so a suite can import `adminDb` and `withUserDb` directly. `with-user-db.test.ts` proves the wrapper rolls back and releases its connection on error and leaks no role or user id to the next pooled query; `schema-drift.test.ts` fails when `src/server/db/schema.ts` and the migrated tables disagree.

`tests/db/_helpers.ts` has the pieces a new suite needs: `connectTestDb()`, `asUser(client, userId | null, fn)` (runs `fn` as `app_user` and always rolls back), `createTestUser`, `createOrgWithOwner`, `addMembership`, and `cleanupTestData`.

## Where to put a new test

Mirror `src/` under the tier directory:

```
tests/
├── _helpers/                          shared harness
├── unit/
│   ├── shared/pricing.test.ts         src/shared/pricing.ts
│   └── client/utils.test.ts           src/client/lib/utils.ts
├── structural/
│   └── i18n-parity.test.ts            cross-file invariant
├── component/
│   ├── ErrorBoundary.test.tsx         src/client/components/ErrorBoundary.tsx
│   └── use-auth-settings.test.tsx     src/client/hooks/api/useAuthSettings.ts
└── integration/
    └── server/routes/
        ├── health.test.ts             src/server/routes/health.ts
        └── contact.test.ts            src/server/routes/v1/contact.ts
```

**Heuristic** — if the test imports `react` or `@testing-library/react`, it's `component`. If it imports anything from `src/server/`, it's `integration`. Otherwise it's `unit`.

## Tier picking guide

- **Could this be a pure function?** Refactor it into one and write a `unit` test. Cheap, fast, never flaky.
- **Behavior depends on the DOM, focus, keyboard, or React state transitions?** `component` tier.
- **You want to assert what the Hono route returns for a real request?** `integration` tier.
- **You want to prove two files agree on a key set, schema, or constants?** `structural` test under `tests/structural/` — runs under `unit`.

## Helpers

All under `tests/_helpers/`:

| Helper | Use it when |
|---|---|
| `app.ts` → `mountRoute(prefix, routes)` | Building a one-route Hono app for an integration test. No global middleware so assertions stay focused. |
| `app.ts` → `jsonPost(body)` | POSTing JSON to `app.request()` without re-typing headers. |
| `factories.ts` → `makeUser`, `makeOrg`, `makeContactSubmission` | Plausible domain objects to hand back from a mocked query. |
| `drizzle-mock.ts` → `queryChain(run)` | Standing in for a Drizzle query: every builder method returns the chain, and awaiting it calls `run` for the rows (or throws, to simulate a failed query). |
| `jwt.ts` → `mockJwt(payload, secret?)` | HS256-signed bearer token for auth-protected routes. |
| `env.ts` → `mockEnv({...})` | Temporarily swap process.env vars for one test; returns a restore closure. |
| `setup-rtl.ts` | Wired into the `component` project — loads jest-dom matchers and runs RTL's cleanup between tests. |
| `setup-integration.ts` | Wired into the `integration` project — seeds plausible Supabase env values so server modules pass zod validation when imported. |

## Mocking the external boundary

Server-side modules are imported with their relative paths inside `src/server/`. Pass the path alias `@server/...` to `vi.mock` — vitest matches by resolved file path, so it'll intercept whichever path the production code happens to use.

The database seam is `@server/db/client`. Replace `adminDb` and `withUserDb` with `queryChain` doubles, so the route logic runs without Postgres; the `db` tier above is where queries meet the real engine and RLS.

```ts
import { queryChain } from '../../../_helpers/drizzle-mock';

// Database: one chain per query; `run` returns the rows the query would.
const { rows } = vi.hoisted(() => ({ rows: [] as { id: string }[] }));
vi.mock('@server/db/client', () => {
  const db = {
    select: () => queryChain(() => rows),
    insert: () => queryChain(() => [{ id: 'new-id' }]),
  };
  return {
    adminDb: db,
    // Run the callback against the same double; RLS is the db tier's job.
    withUserDb: (_userId: string | null, fn: (tx: typeof db) => unknown) => fn(db),
  };
});

// Supabase Auth (the only thing the Supabase clients still do)
vi.mock('@server/lib/supabase', () => ({
  supabaseAdmin: { auth: { admin: { getUserById: vi.fn() } } },
}));

// Stripe
vi.mock('@server/lib/stripe', () => ({
  stripe: { checkout: { sessions: { create: vi.fn() } } },
}));

// SMTP — fire-and-forget
vi.mock('@server/lib/email', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

// Rate limiter — the real one starts a 60s setInterval at module load;
// replace with a pass-through middleware so tests exit cleanly.
vi.mock('@server/lib/rate-limiter', () => ({
  createRateLimiter: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

// Logger — quiet the expected error-path log
vi.mock('@server/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
```

Client-side fetch — stub the global and unstub in afterEach:

```ts
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());
```

TanStack Query in component tests — wrap with a fresh QueryClient each render, `retry: false` so rejected fetches surface immediately:

```tsx
function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const { result } = renderHook(() => useMyHook(), { wrapper: makeWrapper() });
```

## Don't mock these

- `zod` schemas — they're the contract; test the route's behavior through them.
- The route file under test (obviously).
- `clsx`, `class-variance-authority`, or other pure UI utilities — let them run.

## What we deliberately don't do (yet)

- **No real Postgres in `integration`.** Mocking `@server/db/client` keeps route tests fast and deterministic. SQL-level coverage (RLS, triggers, joins, schema drift) lives in the `db` tier, which runs against the real engine (see "Database tier").
- **No E2E / Playwright.** Add when you actually have flows worth black-box testing through the browser.
- **No snapshot tests.** Brittle and noisy in a fast-moving template; assert behavior instead.
- **No MSW.** `vi.stubGlobal('fetch', ...)` covers the seed cases; adopt MSW if your fetch surface grows.

## When you use the test-maintainer agent

It reads `tests/_helpers/` and the existing test files to learn this project's conventions, then matches the style when writing new tests. The smaller and more consistent the seed it sees, the more consistent its output. If you find yourself adjusting its output the same way twice, encode the convention here.
