# n8n Single Sign-On via Traefik ForwardAuth

## How it works

### Production (real domains)

In production, the app and n8n share a parent domain (e.g., `app.example.com` and `n8n.example.com`). The Supabase auth cookie is set with `domain=.example.com`, so it's sent to all subdomains. The flow:

1. User visits `n8n.example.com`
2. Traefik applies `super-admin-auth@file` middleware (ForwardAuth)
3. `verify-role.ts` reads the `sb-auth-token` cookie, validates the JWT, checks `super_admin` role
4. On success, Traefik forwards `X-User-Email` header to n8n
5. `hooks.js` middleware reads the header, finds/creates the n8n user, issues `n8n-auth` session cookie
6. User sees the n8n editor — no login page

### Development (localhost)

In dev, `localhost` and `n8n.localhost` are treated as **separate domains** by browsers (`.localhost` is a public suffix). Cookies set on `localhost` are NOT sent to `n8n.localhost`. This means ForwardAuth can't work — the auth cookie never reaches the verify-role endpoint.

Instead, n8n uses its **own built-in auth** in dev:

1. `setup.sh` sidecar creates an owner user with a random password hash (stored in the n8n database)
2. User visits `http://n8n.localhost` → sees n8n's login page
3. Logs in with their admin email and the password configured at project creation

The SSO hook (`hooks.js`) is still loaded but has no effect since ForwardAuth headers are absent — it calls `next()` and falls through to n8n's normal auth.

## Architecture

```
Production:
  Browser → Traefik → ForwardAuth (verify-role) → n8n (hooks.js sets cookie)
                           │                            │
                      Reads sb-auth-token          Reads X-User-Email
                      Sets X-User-* headers        Issues n8n-auth cookie

Development:
  Browser → Traefik → n8n (no ForwardAuth, native login)
```

## Components

| Component | File | Purpose |
|-----------|------|---------|
| SSO hook | `volumes/n8n/hooks.js` | Express middleware: reads `X-User-Email`, auto-creates user, issues session cookie |
| DB setup sidecar | `volumes/n8n/scripts/setup.sh` | Creates owner user in PostgreSQL so setup wizard is skipped |
| ForwardAuth config (prod) | `volumes/traefik/middlewares.yml` | Chains header stripping → role verification |
| ForwardAuth config (dev) | `volumes/traefik/middlewares.dev.yml` | Same, routes to `host.docker.internal:3000` |
| Verify-role endpoint | `src/server/routes/_internal/verify-role.ts` | Validates JWT, checks role, sets `X-User-*` headers |
| Compose (dev) | `docker-compose.n8n.yml` | No ForwardAuth middleware on n8n router |
| Compose (prod) | Production overlay adds `super-admin-auth@file` middleware label |

## Key implementation details

### hooks.js (n8n v2.x / Express 5)

- **Export format**: `{ n8n: { ready: [fn] } }` — two-level nested, NOT `{ 'n8n.ready': [fn] }`
- **Router access**: Express 5 uses `app.router.stack` (not `app._router.stack`)
- **Layer creation**: Must use `require('router/lib/layer')` to create proper Layer instances (plain objects cause `layer.match is not a function`)
- **User repository**: Available via `this.dbCollections.User` (provided by hook context)
- **Session cookies**: Use `Container.get(AuthService).issueCookie()` from `@n8n/di` (not `@n8n/api` which doesn't exist)
- **User role column**: n8n v2.x uses `roleSlug` (FK to `role` table), not `role`
- **User lookup**: Must include `relations: ['role']` for `issueCookie()` to work

### setup.sh (n8n v2.x schema)

n8n v2.x auto-creates a skeleton owner row (no email) during migration. The setup script:

1. Waits for n8n's `user` table to exist
2. UPDATEs the skeleton owner to set email, name, bcrypt password, and `lastActiveAt`
3. Falls back to INSERT if no skeleton owner exists
4. Sets `userManagement.isInstanceOwnerSetUp = true` in the `settings` table

All three are required to skip the setup wizard:
- `hasInstanceOwner()` checks: `password IS NOT NULL` OR `lastActiveAt IS NOT NULL`
- `showSetupOnFirstLoad` checks: `!(await hasInstanceOwner())`
- Frontend also checks the `isInstanceOwnerSetUp` setting

### DB password

The n8n compose uses `POSTGRES_PASSWORD` (the project's DB password) for the n8n DB connection. This matches what `n8n-init.sh` sets for the `n8n` PostgreSQL role. Do NOT use a separate `N8N_DB_PASSWORD` with a different default.

## Troubleshooting

### n8n crash loop: "Problem loading external hook file"

Check the export format. n8n's `loadHooks()` expects `{ resource: { operation: [fn] } }`. A flat key like `'n8n.ready'` causes `Spread syntax requires ...iterable[Symbol.iterator]` because it tries to spread a function.

### n8n crash loop: "layer.match is not a function"

The hooks.js spliced a plain object into Express 5's router stack. Use `require('router/lib/layer')` to create proper Layer instances.

### Setup wizard still appears

Check all three conditions:
```bash
# 1. Owner has password or lastActiveAt
docker compose exec db psql -U supabase_admin -d n8n -c \
  "SELECT email, password IS NOT NULL, \"lastActiveAt\" FROM \"user\" WHERE \"roleSlug\" = 'global:owner';"

# 2. Setting is true
docker compose exec db psql -U supabase_admin -d n8n -c \
  "SELECT value FROM settings WHERE key = 'userManagement.isInstanceOwnerSetUp';"

# 3. REST API confirms
curl -s http://n8n.localhost/rest/settings | python3 -m json.tool | grep showSetup
```

### "password authentication failed for user n8n"

The n8n compose DB password doesn't match what `n8n-init.sh` set. Ensure both use `${POSTGRES_PASSWORD}`.

### ForwardAuth returns 401 in production

1. Check the `sb-auth-token` cookie is set with the correct domain (`.example.com`)
2. Check `authRequestHeaders` includes `Cookie`, `Authorization`, and `Accept`
3. Check the user has `super_admin` in `app_metadata.role`

### SSO hook doesn't fire (no log output)

1. Verify hooks.js is mounted: `docker exec <n8n> cat /home/node/.n8n/hooks.js`
2. Check `EXTERNAL_HOOK_FILES` env var is set
3. Check for `[hooks.js] ForwardAuth SSO middleware installed` in logs
4. If middleware installed but not firing, check for stale `n8n-auth` cookie (hook skips when present)
