#!/usr/bin/env bash
#
# Generate dev config files from templates
# Replaces {{PLACEHOLDERS}} with hardcoded dev values
#
# Usage:
#   ./generate-dev-configs.sh          # Only generate missing files
#   ./generate-dev-configs.sh --force  # Regenerate all files
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CARBON_DIR="$(dirname "$SCRIPT_DIR")"

FORCE=false
if [[ "${1:-}" == "--force" ]]; then
  FORCE=true
fi

cd "$CARBON_DIR"

# Dev value substitutions (add new placeholders here).
# Note: ANON_KEY and SERVICE_ROLE_KEY are signed at runtime by
# scripts/_dev-jwt.mjs against JWT_SECRET. Committing literal JWT
# strings tripped GitHub's secret-scanner on every push; signing on
# the fly keeps the dev workflow deterministic without leaking
# service-role-shaped values into git history.
JWT_SECRET_VALUE="local-dev-jwt-secret-must-be-at-least-32-chars-padded-padded"
ANON_KEY_VALUE=$(JWT_SECRET="$JWT_SECRET_VALUE" node "$SCRIPT_DIR/_dev-jwt.mjs" anon)
SERVICE_ROLE_KEY_VALUE=$(JWT_SECRET="$JWT_SECRET_VALUE" node "$SCRIPT_DIR/_dev-jwt.mjs" service_role)

declare -A SUBSTITUTIONS=(
  ["{{PROJECT_NAME}}"]="vibecarbon"
  ["{{ANON_KEY}}"]="$ANON_KEY_VALUE"
  ["{{SERVICE_ROLE_KEY}}"]="$SERVICE_ROLE_KEY_VALUE"
  ["{{JWT_SECRET}}"]="$JWT_SECRET_VALUE"
  ["{{DB_PASSWORD}}"]="local-postgres-password-for-dev-only"
  ["{{ADMIN_EMAIL}}"]="admin@localhost"
  ["{{ADMIN_PASSWORD}}"]="local-admin-password"
  ["{{GRAFANA_PASSWORD}}"]="admin"
  ["{{N8N_PASSWORD}}"]="local-n8n-password"
  ["{{REALTIME_SECRET}}"]="local-realtime-secret-padded"
  ["{{VAULT_ENC_KEY}}"]="local-vault-encryption-key-1234567890"
  ["{{DB_ENC_KEY}}"]="devdbencryptkey1"
)

# Files that need dev variants (relative to carbon/)
# Format: "template_path:dev_path"
declare -a CONFIG_PAIRS=(
  # Database initialization (only super-admin needs dev variant — roles/services use runtime env vars)
  "volumes/db/super-admin.sql:volumes/db/super-admin.dev.sql"
)

# Directories where all files need dev variants.
# (Observability's Grafana dev variants ship pre-made with the `observability`
# add-on bundle — see services/observability/ — so they are not generated here.)
declare -a CONFIG_DIRS=()

generate_dev_file() {
  local src="$1"
  local dest="$2"

  if [[ ! -f "$src" ]]; then
    echo "  SKIP: $src (template not found)"
    return
  fi

  if [[ -f "$dest" && "$FORCE" == "false" ]]; then
    echo "  SKIP: $dest (exists, use --force to regenerate)"
    return
  fi

  # Start with source content
  local content
  content=$(<"$src")

  # Apply all substitutions
  for placeholder in "${!SUBSTITUTIONS[@]}"; do
    local value="${SUBSTITUTIONS[$placeholder]}"
    content="${content//${placeholder}/${value}}"
  done

  # Write dev file
  mkdir -p "$(dirname "$dest")"
  echo "$content" > "$dest"

  if [[ "$FORCE" == "true" ]]; then
    echo "  REGENERATED: $dest"
  else
    echo "  CREATED: $dest"
  fi
}

echo "Generating dev config files..."
echo ""

# Process individual file pairs
echo "Config files:"
for pair in "${CONFIG_PAIRS[@]}"; do
  src="${pair%%:*}"
  dest="${pair##*:}"
  generate_dev_file "$src" "$dest"
done

echo ""

# Process directories
echo "Config directories:"
for dir_pair in ${CONFIG_DIRS[@]+"${CONFIG_DIRS[@]}"}; do
  src_dir="${dir_pair%%:*}"
  dest_dir="${dir_pair##*:}"

  if [[ ! -d "$src_dir" ]]; then
    echo "  SKIP: $src_dir (not found)"
    continue
  fi

  mkdir -p "$dest_dir"

  for src_file in "$src_dir"/*; do
    if [[ -f "$src_file" ]]; then
      filename=$(basename "$src_file")
      generate_dev_file "$src_file" "$dest_dir/$filename"
    fi
  done
done

echo ""
echo "Done. Remember to verify the generated files before committing."
