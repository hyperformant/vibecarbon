#!/bin/sh
set -e

echo "Starting ${PROJECT_NAME}..."

# Note: Database migrations are handled by Supabase
# Run migrations manually with: docker compose exec db psql -U postgres -d postgres -f /migrations/init.sql

echo "Starting application..."

# Execute the main command
exec "$@"
