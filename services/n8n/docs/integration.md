# n8n Integration with Supabase

This guide shows how to connect n8n workflows to your Vibecarbon application's Supabase backend.

## Overview

n8n is pre-configured with:
- Dedicated PostgreSQL database (`n8n`) for workflow storage
- Environment variables for easy Supabase integration
- Network access to all your app's services

## Quick Start

### 1. Access n8n

```bash
# Start services (if not already running)
pnpm docker:up

# Open n8n
open http://n8n.localhost
```

**Login:** Use your admin email and the password set during project creation. In development, n8n uses its own built-in authentication (ForwardAuth SSO only applies in production).

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
Action 1: Send welcome email (Email node)
Action 2: Create user profile (HTTP Request to your API)
Action 3: Add to analytics (HTTP Request to analytics service)
```

### Scheduled Reports

```
Trigger: Cron (daily at 9 AM)
Action 1: Query database for metrics (Postgres node)
Action 2: Generate report (Code node)
Action 3: Send email (Email node)
```

### API Integration

```
Trigger: Webhook (from external service)
Action 1: Transform data (Code node)
Action 2: Insert into Supabase (HTTP Request or Postgres node)
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

Add **Error Trigger** nodes to handle failures gracefully.

### 3. Testing

Use the **Manual Trigger** node during development.

### 4. Security

- Use `SUPABASE_SERVICE_ROLE_KEY` only for admin operations
- Use `SUPABASE_ANON_KEY` for public operations
- Never expose service role key in client-side workflows

## Learn More

- [n8n Documentation](https://docs.n8n.io/)
- [Supabase API Reference](https://supabase.com/docs/reference/javascript/introduction)
