#!/bin/bash
# Metabase Auto-Setup Script
# Automatically configures Metabase with admin user and app database connection
# Added via: vibecarbon add metabase

set -e

METABASE_URL="${METABASE_URL:-http://metabase:3000}"
MAX_RETRIES=60
RETRY_INTERVAL=5

# Admin credentials (from environment)
ADMIN_EMAIL="${METABASE_ADMIN_EMAIL:-admin@localhost}"
ADMIN_PASSWORD="${METABASE_ADMIN_PASSWORD}"
ADMIN_FIRST_NAME="${METABASE_ADMIN_FIRST_NAME:-Admin}"
ADMIN_LAST_NAME="${METABASE_ADMIN_LAST_NAME:-User}"

# App database connection details
APP_DB_HOST="${APP_DB_HOST:-db}"
APP_DB_PORT="${APP_DB_PORT:-5432}"
APP_DB_NAME="${APP_DB_NAME:-postgres}"
APP_DB_USER="${APP_DB_USER:-postgres}"
APP_DB_PASSWORD="${DB_PASSWORD}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >&2
}

wait_for_metabase() {
  log "Waiting for Metabase to be ready..."
  for i in $(seq 1 $MAX_RETRIES); do
    if curl -sf "${METABASE_URL}/api/health" > /dev/null 2>&1; then
      log "Metabase is healthy"
      return 0
    fi
    log "Attempt $i/$MAX_RETRIES - Metabase not ready, waiting ${RETRY_INTERVAL}s..."
    sleep $RETRY_INTERVAL
  done
  log "ERROR: Metabase failed to become healthy after $((MAX_RETRIES * RETRY_INTERVAL)) seconds"
  exit 1
}

get_setup_token() {
  curl -sf "${METABASE_URL}/api/session/properties" | jq -r '.["setup-token"] // empty'
}

check_setup_complete() {
  local props
  props=$(curl -sf "${METABASE_URL}/api/session/properties")
  local setup_token
  setup_token=$(echo "$props" | jq -r '.["setup-token"] // empty')
  # Setup is truly complete only when there's no setup token left
  [ -z "$setup_token" ]
}

run_initial_setup() {
  log "Running initial Metabase setup..."

  local setup_token
  setup_token=$(get_setup_token)

  if [ -z "$setup_token" ]; then
    log "No setup token found — setup already complete."
    return 1
  fi

  log "Got setup token, creating admin user and database connection..."

  # Complete entire setup in one call: admin user + database + preferences.
  # This properly consumes the setup token so Metabase won't show the wizard.
  local payload
  payload=$(cat <<EOF
{
  "token": "${setup_token}",
  "user": {
    "email": "${ADMIN_EMAIL}",
    "password": "${ADMIN_PASSWORD}",
    "first_name": "${ADMIN_FIRST_NAME}",
    "last_name": "${ADMIN_LAST_NAME}",
    "site_name": "{{PROJECT_NAME}}"
  },
  "database": {
    "engine": "postgres",
    "name": "Application Data",
    "details": {
      "host": "${APP_DB_HOST}",
      "port": ${APP_DB_PORT},
      "dbname": "${APP_DB_NAME}",
      "user": "${APP_DB_USER}",
      "password": "${APP_DB_PASSWORD}",
      "ssl": false
    }
  },
  "prefs": {
    "site_name": "{{PROJECT_NAME}}",
    "site_locale": "en",
    "allow_tracking": false
  }
}
EOF
)

  local response
  response=$(curl -sf -X POST "${METABASE_URL}/api/setup" \
    -H "Content-Type: application/json" \
    -d "$payload")

  if [ $? -eq 0 ]; then
    log "Initial setup complete (admin user + database connection)"
    echo "$response" | jq -r '.id // empty'
  else
    log "ERROR: Initial setup failed"
    return 1
  fi
}

main() {
  log "Starting Metabase auto-setup..."

  # Validate required environment variables
  if [ -z "$ADMIN_PASSWORD" ]; then
    log "ERROR: METABASE_ADMIN_PASSWORD is required"
    exit 1
  fi

  if [ -z "$DB_PASSWORD" ]; then
    log "ERROR: DB_PASSWORD is required"
    exit 1
  fi

  # Wait for Metabase to be ready
  wait_for_metabase

  # Try to complete the full setup (consumes the setup token).
  # The /api/setup endpoint creates admin user + database connection in one call.
  if ! check_setup_complete; then
    local session_id
    session_id=$(run_initial_setup)

    if [ -n "$session_id" ]; then
      log "Metabase auto-setup complete!"
      exit 0
    fi

    log "ERROR: Initial setup failed and setup token is still present"
    exit 1
  fi

  log "Metabase setup already complete, nothing to do."
}

main "$@"
