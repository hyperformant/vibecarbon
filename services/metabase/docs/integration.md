# Metabase Integration Guide

Metabase is an open-source business intelligence tool that lets you create dashboards and visualizations from your data without writing SQL.

## Getting Started

Metabase is **automatically configured** when you start your development environment:

1. **Start services**: `vibecarbon up`
2. **Access Metabase**: http://metabase.localhost
3. **Sign in** with your admin email and password

The setup container automatically:
- Creates the admin user
- Connects to your application database (named "Application Data")
- Configures recommended settings

> **Security Note**: In production, Metabase is protected by Traefik ForwardAuth requiring the `super_admin` role. Users must be signed in to the main application with super admin privileges to access it.

## Architecture

Metabase uses **two database connections**:

1. **Application Database** (`metabase` db): Stores Metabase's own data - dashboards, saved questions, user accounts, etc.
2. **Your Data** (`postgres` db): The database you want to analyze - automatically configured as "Application Data"

## Creating Dashboards

### Basic Workflow

1. **Ask a Question**: Click "New" > "Question"
2. **Choose Data**: Select "Application Data" and your table
3. **Build Query**: Use the visual query builder or write SQL
4. **Save & Visualize**: Save to a collection and add to dashboards

### Example Queries

**User signups over time:**
```sql
SELECT
  DATE_TRUNC('day', created_at) as signup_date,
  COUNT(*) as signups
FROM auth.users
GROUP BY 1
ORDER BY 1
```

**Active users last 30 days:**
```sql
SELECT COUNT(DISTINCT id)
FROM auth.users
WHERE last_sign_in_at > NOW() - INTERVAL '30 days'
```

## Embedding Dashboards

Metabase supports embedding dashboards in your application:

### Public Links (Simple)

1. Enable sharing on dashboard
2. Copy public link
3. Embed via iframe

### Signed Embedding (Secure)

```typescript
import jwt from 'jsonwebtoken';

// Use environment variable for flexibility between local/production
const METABASE_SITE_URL = process.env.METABASE_URL || "http://localhost:3001";
// In production: "https://your-domain.com/admin/metabase"

const METABASE_SECRET_KEY = "your-embedding-secret"; // From Admin > Embedding

function getEmbedUrl(dashboardId: number, params: Record<string, any> = {}) {
  const payload = {
    resource: { dashboard: dashboardId },
    params,
    exp: Math.round(Date.now() / 1000) + (10 * 60) // 10 minute expiration
  };

  const token = jwt.sign(payload, METABASE_SECRET_KEY);
  return `${METABASE_SITE_URL}/embed/dashboard/${token}`;
}
```

## Environment Variables

These are automatically configured:

```env
# Metabase admin credentials
METABASE_ADMIN_EMAIL=admin@localhost
METABASE_ADMIN_PASSWORD=<generated>
```

## Manual Database Connection

If you need to add additional database connections manually:

| Setting | Value |
|---------|-------|
| Database type | PostgreSQL |
| Display name | Your choice |
| Host | `db` |
| Port | `5432` |
| Database name | Your database |
| Username | Your user |
| Password | Your password |

## Docker Commands

```bash
# View Metabase logs
pnpm docker:logs metabase

# View setup logs
docker logs {{PROJECT_NAME}}-metabase-setup

# Restart Metabase
docker restart {{PROJECT_NAME}}-metabase

# Re-run setup (if needed)
docker restart {{PROJECT_NAME}}-metabase-setup

# Access Metabase shell
docker exec -it {{PROJECT_NAME}}-metabase /bin/sh
```

## Backup & Restore

### Backup Metabase Data

```bash
# Backup metabase database
docker exec {{PROJECT_NAME}}-db pg_dump -U postgres metabase > metabase-backup.sql
```

### Restore Metabase Data

```bash
# Restore metabase database
docker exec -i {{PROJECT_NAME}}-db psql -U postgres metabase < metabase-backup.sql
```

## Performance Tips

1. **Add database indexes** for columns you frequently filter/group by
2. **Use caching**: Admin > Performance > enable query caching
3. **Schedule refreshes**: Set dashboards to refresh on a schedule rather than live
4. **Limit results**: Use LIMIT in custom SQL to prevent large result sets

## Troubleshooting

### Setup didn't run

Check the setup container logs:
```bash
docker logs {{PROJECT_NAME}}-metabase-setup
```

Re-run setup:
```bash
docker restart {{PROJECT_NAME}}-metabase-setup
```

### Metabase won't start

Check if the metabase database was created:
```bash
docker exec {{PROJECT_NAME}}-db psql -U postgres -c "\l" | grep metabase
```

If missing, run the init script:
```bash
docker exec {{PROJECT_NAME}}-db bash /docker-entrypoint-initdb.d/zz-metabase-init.sh
```

### Connection refused to db

Ensure the database is healthy:
```bash
docker exec {{PROJECT_NAME}}-db pg_isready
```

### Slow queries

1. Check query in Metabase > Admin > Troubleshooting > Logs
2. Add indexes to your database tables
3. Enable query caching in Admin > Performance
