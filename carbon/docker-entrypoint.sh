#!/bin/sh
set -e

echo "Starting ${PROJECT_NAME}..."

# The server applies the database migrations (db/migrations) itself at
# startup; see src/server/db/migrate.ts.

echo "Starting application..."

# Execute the main command
exec "$@"
