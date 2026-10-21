#!/bin/sh
set -e

echo "Starting ${PROJECT_NAME}..."

# The server never applies database migrations: the migrate step does, as
# the owner, before the app starts (`node dist/server/migrate-cli.js`, run by
# the compose app-migrate service and the k8s migrate init container). The
# server only checks the ledger at startup; see src/server/db/startup.ts.

echo "Starting application..."

# Execute the main command
exec "$@"
