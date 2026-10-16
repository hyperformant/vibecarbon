# n8n Integration with Your App

> **Parked for the MVP launch.** The n8n add-on is currently disabled in
> `vibecarbon add` (`status: 'parked'` in `src/add.js`) and is not linked from
> the README/docs indexes. This guide is retained for when the add-on returns
> via the add-on marketplace.

This guide shows how to connect n8n workflows to your Vibecarbon application: its Postgres database and its API.

## Overview

n8n is pre-configured with:
- ✓ Its own PostgreSQL database and role (`n8n`) on your project's Postgres, for workflow storage
- ✓ Queue mode on Redis for executions
- ✓ Network access to your app's services (`db`, `app`) on the private Docker network

n8n gets no credentials for your app's data by default. You add them in n8n's credential store, so each workflow uses exactly the access it needs.

## Quick Start

### 1. Access n8n

In **development**, n8n uses its own built-in authentication (ForwardAuth cannot work because `localhost` and `n8n.localhost` are treated as separate browser domains):

```bash
# Start services (if not already running)
npm run docker:up

# Access n8n
open http://n8n.localhost
```

**Development login:** Use your admin email and the password `changeme` (set by the setup sidecar).

In **production**, n8n is protected by Traefik ForwardAuth. Only users with the `super_admin` role can access it: opening it from the app's admin panel mints a short-lived `vc-admin-token` cookie (a dedicated ForwardAuth token, never the app session), and n8n signs them in from that (see `services/n8n/docs/SSO.md`).

### 2. Reach your app from a workflow

Two ways in, pick by what the workflow does:

| Path | Use it for | Access |
|------|------------|--------|
| **Your app's API** (`http://app:3000/api/v1/...`) | Anything a user-facing feature already does | Goes through your routes, validation and RLS |
| **Postgres** (`db:5432`) | Reports, exports, bulk jobs | Whatever role you give the credential |

Prefer the API: it keeps business rules in one place. Reach for Postgres when a workflow needs a query no route offers.

## Example Workflows

### Example 1: Query the database

Create a **Postgres** credential in n8n:

```
Host: db
Port: 5432
Database: postgres
User: n8n
Password: your N8N_DB_PASSWORD (from .env.local)
```

Never use `postgres` here: it is the superuser, so a workflow on it could read the auth tables and run shell commands in the db container (`COPY ... TO PROGRAM`). The `n8n` role is what the add-on sets up for this (`volumes/db/n8n-init.sh`, at first boot and on every `vibecarbon up` in development), with its own password: not a superuser, bypasses row-level security, read and write on your business tables, and no access to the server-only tables (`"user"`, `session`, `account`, `failed_login_attempts`, ...). A workflow on it sees and can change every business row.

A narrower role does not get you a "read-only view of everything" for free. Row-level security applies to every role without `BYPASSRLS`, and the policies decide by the app user a request runs as (`app.user_id()`). A report connection has no app user, so a plain role sees only what the policies allow it, which is no rows (or an error from a helper function it may not call). For a cross-tenant, read-only report, create a role that bypasses RLS but can only read the tables you grant (over `vibecarbon shell`, or psql against the local dev db):

```sql
CREATE ROLE n8n_reports LOGIN BYPASSRLS PASSWORD '...';
GRANT CONNECT ON DATABASE postgres TO n8n_reports;
GRANT USAGE ON SCHEMA public TO n8n_reports;
GRANT SELECT ON public.organizations, public.memberships TO n8n_reports;
```

It still cannot read the auth tables (`"user"`, `session`, `account`, ...) or write anything, because it holds no grant for them.

Then use the **Postgres** node:

```sql
SELECT id, name, created_at FROM organizations WHERE created_at > NOW() - INTERVAL '1 day';
```

### Example 2: Call your app's API

Add a route for the job under `src/server/routes/` (an internal route that checks a shared secret header, or a webhook under `/api/webhooks/`), then call it from an **HTTP Request** node:

```
Method: POST
URL: http://app:3000/api/webhooks/my-job

Headers:
- X-Job-Secret: {{$env.MY_JOB_SECRET}}
- Content-Type: application/json

Body (JSON):
{ "title": "Created from n8n" }
```

### Example 3: Receive webhooks

1. Create a **Webhook** node in n8n
2. Copy the webhook URL (e.g., `http://n8n:5678/webhook/my-webhook` inside Docker)
3. Call it from your app when the event happens (after the write commits)

### Example 4: Trigger on database changes

Use the **Postgres Trigger** node with the credential from Example 1:

```
Trigger: On Row Insert
Table: organizations

Returns:
- NEW row data
```

## Common Use Cases

### Onboarding

```
Trigger: Webhook (your app calls it after sign-up)
↓
Action 1: Send welcome email (Email node)
↓
Action 2: Add to your CRM (HTTP Request)
```

### Scheduled Reports

```
Trigger: Cron (daily at 9 AM)
↓
Action 1: Query database for metrics (Postgres node, read-only role)
↓
Action 2: Generate report (Code node)
↓
Action 3: Send email (Email node)
```

### API Integration

```
Trigger: Webhook (from external service)
↓
Action 1: Transform data (Code node)
↓
Action 2: Hand it to your app (HTTP Request to /api/webhooks/...)
↓
Action 3: Notify users (Email node)
```

## Best Practices

### 1. Keep credentials in n8n's store

Create a Postgres or Header Auth credential once and reference it from nodes. Never paste a password into a node or a Code block.

### 2. Error Handling

Add **Error Trigger** nodes to handle failures gracefully:
```
Main Workflow → [Success]
             ↘ [Error] → Error Trigger → Log/Notify
```

### 3. Testing

Use the **Manual Trigger** node during development:
```
Manual Trigger → Your Workflow → Check Results
```

### 4. Security

- Give each credential the narrowest role that does the job; `postgres` is for admin work only
- Prefer your app's API, which applies RLS and validation, over direct table writes
- Webhook routes verify a secret or signature before they act

## Troubleshooting

### Can't connect to database

Check that services are running:
```bash
docker compose ps
```

All services should show "healthy" or "running". The host is `db` (the service name), never `localhost`, from inside n8n.

### Webhook not receiving data

Ensure the webhook URL uses the correct hostname:
- Inside Docker: `http://n8n:5678/webhook/...`
- From your host: `http://n8n.localhost/webhook/...`

## Learn More

- [n8n Documentation](https://docs.n8n.io/)
- [PostgreSQL Node](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.postgres/)
- [HTTP Request Node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/)
