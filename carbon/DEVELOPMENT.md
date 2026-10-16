# Template Development Guide

This guide covers developing and testing the `carbon/` template directory locally.

## Running locally

From the **vibecarbon repo root**, `pnpm dev` is the one-command way to boot the template for testing:

```bash
pnpm dev    # ensures carbon/'s dev env exists, then runs `vibecarbon up` in carbon/
```

`carbon/.env` and `.env.local` are gitignored, so a fresh checkout has none. `pnpm dev` runs `npm run dev:init` inside `carbon/` for you when they're missing, then starts the stack via the working-tree CLI. Running `vibecarbon up` directly from `carbon/` also works, but you must `npm run dev:init` first.

Local dev services don't start by themselves after a reboot, so run `vibecarbon up` again; they cap restarts so a deleted or moved project folder can't leave containers crash-looping forever.

(The vibecarbon repo root uses pnpm; the template in `carbon/` and every generated project use npm.)

## Template Variable System

The CLI replaces placeholders like `{{PROJECT_NAME}}` when users run `vibecarbon create`. However, these placeholders cause issues when testing locally because:

1. Services may reject special characters (`{}`) in identifiers
2. YAML parsers may fail on unquoted template syntax
3. Services expect actual values, not placeholder strings

### Solution: Dev File Pattern

Every config file with template placeholders needs a corresponding dev file:

```
volumes/<service>/config.yml          # Template with {{PLACEHOLDERS}}
volumes/<service>/config.dev.yml      # Dev file with hardcoded values
```

Override files mount dev configs during local development. The build system automatically loads them in the correct order:

```
docker-compose.yml                           # Base services
docker-compose.{service}.yml                 # Optional service (e.g., observability)
docker-compose.{service}.override.yml        # Service-specific dev overrides
docker-compose.override.yml                  # Main dev overrides (loaded last)
```

**Important:** Services defined in optional compose files must have their dev overrides in a matching `{service}.override.yml` file, not the main override file. This prevents errors when running without that service.

## Adding a New Service

### Step 1: Create template config

```yaml
# volumes/myservice/config.yml
name: {{PROJECT_NAME}}
api_key: {{MYSERVICE_KEY}}
```

### Step 2: Create the dev config

Copy the template and replace each placeholder with a hardcoded dev value:

```yaml
# volumes/myservice/config.dev.yml
name: vibecarbon
api_key: dev-key-not-for-production
```

### Step 3: Add override mount

Add the volume mount to the appropriate override file based on **which service** the volume is mounted to:

- If mounting to a service in `docker-compose.yml` (db, traefik, app) → use `docker-compose.override.yml`
- If mounting to a service in `docker-compose.{feature}.yml` → use `docker-compose.{feature}.override.yml`

Example for a service in the base compose file:

```yaml
# docker-compose.override.yml
services:
  db:
    volumes:
      - ./volumes/db/myservice-init.dev.sql:/docker-entrypoint-initdb.d/init-scripts/95-myservice.sql:Z
```

Example for a service in an optional compose file:

```yaml
# docker-compose.observability.override.yml
services:
  grafana:
    volumes:
      - ./volumes/grafana/config.dev.yml:/etc/grafana/config.yml:ro
```

### Step 4: Add placeholder to CLI

In `src/create.js`, add to the replacements map:

```javascript
['{{MYSERVICE_KEY}}', generateSecret()],
```

### Step 5: Test both paths

```bash
# Test local development
npm run dev:start:all

# Test CLI generation
cd .. && node src/cli.js create test-app -y \
  --admin-email=test@example.com \
  --admin-password=testpass123
cd test-app && npm run dev:start
```

## Current Dev File Mappings

### Compose Override Files

| Service Compose | Dev Override | Notes |
|-----------------|--------------|-------|
| `docker-compose.yml` | `docker-compose.override.yml` | Core services (db, traefik, app, local S3) |
| `docker-compose.observability.yml` | `docker-compose.observability.override.yml` | Grafana: volumes + no ForwardAuth (installed via `vibecarbon add observability`) |
| `docker-compose.n8n.yml` | `docker-compose.n8n.override.yml` | n8n: no ForwardAuth |
| `docker-compose.metabase.yml` | `docker-compose.metabase.override.yml` | Metabase: no ForwardAuth |

> Optional services (observability, n8n, metabase, redis) are installed on
> demand with `vibecarbon add <service>`; their compose overlays and config
> files only appear after that.

### Volume Config Files

| Template File | Dev File | Notes |
|--------------|----------|-------|
| `volumes/traefik/middlewares.yml` | `volumes/traefik/middlewares.dev.yml` | ForwardAuth uses host.docker.internal |

Observability's Grafana dev variants ship pre-made with the `observability`
add-on (in `volumes/grafana/`).

The super admin needs no dev file: the app creates it at startup from
`ADMIN_EMAIL` and `ADMIN_PASSWORD` in your env files (`npm run dev:init`
writes both).

## Common Issues

### Container not picking up new mounts

After modifying `docker-compose.override.yml`, recreate the container:

```bash
# Wrong - doesn't apply new mounts
docker compose restart myservice

# Correct - recreates with new mounts
docker compose up -d myservice
```

### Service rejecting config

Check if the service has restrictions on:
- Special characters in identifiers/UIDs
- Required fields that can't be template placeholders
- Strict YAML parsing that rejects `{{}}`

### Template works but dev fails (or vice versa)

Ensure both files have identical structure - only values should differ.

### Admin services (n8n, Metabase, Grafana) in development

In production, these services use Traefik ForwardAuth to require `super_admin` role. In development, ForwardAuth is disabled via service-specific override files:

- `docker-compose.n8n.override.yml`
- `docker-compose.metabase.override.yml`
- `docker-compose.observability.override.yml`

These override files set `traefik.http.routers.{service}.middlewares=` (empty) to remove the ForwardAuth requirement. Docker Compose labels are **additive**, so you must explicitly set the middleware label to empty to override it.

**If you get 401 errors:**

1. Ensure the override files are included in your compose command
2. Force recreate the containers: `docker compose ... up -d --force-recreate n8n metabase grafana`
3. Verify the router has no middlewares: `curl http://traefik.localhost/api/http/routers/n8n@docker | jq .middlewares`
