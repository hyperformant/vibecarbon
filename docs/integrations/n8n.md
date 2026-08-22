# n8n Integration with Supabase

> **Parked for the MVP launch.** The n8n add-on is currently disabled in
> `vibecarbon add` (`status: 'parked'` in `src/add.js`) and is not linked from
> the README/docs indexes. This guide is retained for when the add-on returns
> via the add-on marketplace.

This guide shows how to connect n8n workflows to your Vibecarbon application's Supabase backend.

## Overview

n8n is pre-configured with:
- ✓ Dedicated PostgreSQL database (`n8n`) for workflow storage
- ✓ Environment variables for easy Supabase integration
- ✓ Network access to all your app's services

## Quick Start

### 1. Access n8n

In **development**, n8n uses its own built-in authentication (ForwardAuth cannot work because `localhost` and `n8n.localhost` are treated as separate browser domains):

```bash
# Start services (if not already running)
pnpm docker:up

# Access n8n
open http://n8n.localhost
```

**Development login:** Use your admin email and the password `changeme` (set by the setup sidecar).

In **production**, n8n is protected by Traefik ForwardAuth. Only users with the `super_admin` role can access it — they are signed in automatically via their existing app session.

### 2. Use Supabase in Workflows

n8n has the following environment variables available:

```bash
SUPABASE_URL=http://kong:8000          # Internal Supabase API Gateway
SUPABASE_ANON_KEY=your_anon_key        # Public API key
SUPABASE_SERVICE_ROLE_KEY=your_key     # Admin API key
SUPABASE_DB_HOST=db                    # Direct database access
SUPABASE_DB_PORT=5432
SUPABASE_DB_NAME=postgres
SUPABASE_DB_USER=postgres
SUPABASE_DB_PASSWORD=your_password
```

## Example Workflows

### Example 1: Query Supabase Database

Use the **Postgres** node:

```
Connection Settings:
- Host: {{$env.SUPABASE_DB_HOST}}
- Port: {{$env.SUPABASE_DB_PORT}}
- Database: {{$env.SUPABASE_DB_NAME}}
- User: {{$env.SUPABASE_DB_USER}}
- Password: {{$env.SUPABASE_DB_PASSWORD}}

Query:
SELECT * FROM users WHERE created_at > NOW() - INTERVAL '1 day';
```

### Example 2: Call Supabase REST API

Use the **HTTP Request** node:

```
Method: POST
URL: {{$env.SUPABASE_URL}}/rest/v1/todos

Headers:
- apikey: {{$env.SUPABASE_SERVICE_ROLE_KEY}}
- Authorization: Bearer {{$env.SUPABASE_SERVICE_ROLE_KEY}}
- Content-Type: application/json

Body (JSON):
{
  "title": "New todo from n8n",
  "completed": false
}
```

### Example 3: Listen to Supabase Webhooks

1. Create a **Webhook** node in n8n
2. Copy the webhook URL (e.g., `http://localhost:5678/webhook/my-webhook`)
3. In Supabase (or your app), configure a webhook to call this URL

### Example 4: Trigger on Database Changes

Use **Postgres Trigger** node:

```
Connection Settings: (use environment variables as above)

Trigger: On Row Insert
Table: users

Returns:
- NEW row data
```

## Common Use Cases

### User Onboarding

```
Trigger: Postgres Trigger (users table insert)
↓
Action 1: Send welcome email (Email node)
↓
Action 2: Create user profile (HTTP Request to your API)
↓
Action 3: Add to analytics (HTTP Request to analytics service)
```

### Scheduled Reports

```
Trigger: Cron (daily at 9 AM)
↓
Action 1: Query database for metrics (Postgres node)
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
Action 2: Insert into Supabase (HTTP Request or Postgres node)
↓
Action 3: Notify users (Push notification)
```

## Best Practices

### 1. Use Environment Variables

Instead of hardcoding credentials, always use:
```
{{$env.SUPABASE_URL}}
{{$env.SUPABASE_SERVICE_ROLE_KEY}}
```

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

- Use `SUPABASE_SERVICE_ROLE_KEY` only for admin operations
- Use `SUPABASE_ANON_KEY` for public operations
- Never expose service role key in client-side workflows

## Direct Database Access

For complex queries, connect directly to PostgreSQL:

```javascript
// In a Code node
const { Client } = require('pg');

const client = new Client({
  host: process.env.SUPABASE_DB_HOST,
  port: process.env.SUPABASE_DB_PORT,
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
});

await client.connect();
const result = await client.query('SELECT * FROM users LIMIT 10');
await client.end();

return result.rows;
```

## Supabase Realtime Integration

To react to real-time database changes:

1. Use the **Postgres Trigger** node (recommended)
2. Or set up a webhook in your app code:

```typescript
// In your app
supabase
  .channel('todos')
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'todos' },
    (payload) => {
      // Call n8n webhook
      fetch('http://n8n:5678/webhook/todo-created', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }
  )
  .subscribe();
```

## Troubleshooting

### Can't connect to database

Check that services are running:
```bash
docker compose ps
```

All services should show "healthy" or "running".

### Environment variables not found

Restart n8n container:
```bash
docker compose restart n8n
```

### Webhook not receiving data

Ensure the webhook URL uses the correct hostname:
- Inside Docker: `http://n8n:5678/webhook/...`
- From your host: `http://localhost:5678/webhook/...`

## Learn More

- [n8n Documentation](https://docs.n8n.io/)
- [Supabase API Reference](https://supabase.com/docs/reference/javascript/introduction)
- [PostgreSQL Node](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.postgres/)
- [HTTP Request Node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/)
