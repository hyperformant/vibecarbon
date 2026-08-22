# Testing

Three tiers, picked to mirror what each tier actually proves:

| Tier | Env | Wall-clock | What it tests |
|---|---|---|---|
| `unit` | node | <1s | Pure functions, validators, pricing/format helpers, cross-cutting invariants |
| `component` | jsdom | a few s | React components + custom hooks via React Testing Library |
| `integration` | node | <30s | Hono route handlers end-to-end with externals (Supabase, Stripe, SMTP) mocked |

Run them:

```bash
npm test               # every tier
npm run test:unit
npm run test:component
npm run test:integration
npm run test:watch     # vitest watch mode (all tiers)
npm run test:coverage  # writes coverage/ HTML (v8)
npm run test:prepush   # what the pre-push git hook runs (lint + all three tiers)
```

The pre-push hook is installed automatically by `vibecarbon create` — bypass with `git push --no-verify` only if you understand why the tests are red.

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
| `factories.ts` → `makeUser`, `makeOrg`, `makeContactSubmission` | Plausible domain objects to hand to mocked Supabase resolved values. |
| `jwt.ts` → `mockJwt(payload, secret?)` | HS256-signed bearer token for auth-protected routes. |
| `env.ts` → `mockEnv({...})` | Temporarily swap process.env vars for one test; returns a restore closure. |
| `setup-rtl.ts` | Wired into the `component` project — loads jest-dom matchers and runs RTL's cleanup between tests. |
| `setup-integration.ts` | Wired into the `integration` project — seeds plausible Supabase env values so server modules pass zod validation when imported. |

## Mocking the external boundary

Server-side modules are imported with their relative paths inside `src/server/`. Pass the path alias `@server/...` to `vi.mock` — vitest matches by resolved file path, so it'll intercept whichever path the production code happens to use.

```ts
// Supabase
vi.mock('@server/lib/supabase', () => ({
  supabaseAdmin: { from: () => ({ insert: vi.fn().mockResolvedValue({ error: null }) }) },
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

- **No real Postgres in `integration`.** The Supabase dev container doesn't expose Postgres on the host. Mocking at the Supabase client boundary gives fast, deterministic tests and covers the route logic. If you need SQL-level coverage (RLS, triggers, complex joins), add testcontainers or expose a dev port and write a `tests/database/` tier — the boundary stays the same.
- **No E2E / Playwright.** Add when you actually have flows worth black-box testing through the browser.
- **No snapshot tests.** Brittle and noisy in a fast-moving template; assert behavior instead.
- **No MSW.** `vi.stubGlobal('fetch', ...)` covers the seed cases; adopt MSW if your fetch surface grows.

## When you use the test-maintainer agent

It reads `tests/_helpers/` and the existing test files to learn this project's conventions, then matches the style when writing new tests. The smaller and more consistent the seed it sees, the more consistent its output. If you find yourself adjusting its output the same way twice, encode the convention here.
