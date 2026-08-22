#!/usr/bin/env bash
#
# Validate that all template files have corresponding dev files
# Run in CI to catch missing dev configs
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CARBON_DIR="$(dirname "$SCRIPT_DIR")"

cd "$CARBON_DIR"

errors=0

# Known template/dev file pairs that must exist
declare -a REQUIRED_PAIRS=(
  # Database initialization (only super-admin needs dev variant — roles/services use runtime env vars)
  "volumes/db/super-admin.sql:volumes/db/super-admin.dev.sql"
)

# Directories where each template file needs a dev counterpart.
# (Observability's Grafana dev variants ship with the `observability` add-on
# bundle in services/observability/, so they are not validated here.)
declare -a REQUIRED_DIR_PAIRS=()

echo "Validating dev config files..."
echo ""

# Check individual file pairs
echo "Required file pairs:"
for pair in "${REQUIRED_PAIRS[@]}"; do
  template="${pair%%:*}"
  dev_file="${pair##*:}"

  if [[ ! -f "$template" ]]; then
    echo "  SKIP: $template (template not found)"
    continue
  fi

  if [[ -f "$dev_file" ]]; then
    echo "  OK: $dev_file"
  else
    echo "  MISSING: $dev_file"
    ((errors++))
  fi
done

echo ""

# Check directory pairs
echo "Required directory pairs:"
for dir_pair in ${REQUIRED_DIR_PAIRS[@]+"${REQUIRED_DIR_PAIRS[@]}"}; do
  template_dir="${dir_pair%%:*}"
  dev_dir="${dir_pair##*:}"

  if [[ ! -d "$template_dir" ]]; then
    echo "  SKIP: $template_dir (template dir not found)"
    continue
  fi

  for template_file in "$template_dir"/*; do
    if [[ -f "$template_file" ]]; then
      filename=$(basename "$template_file")
      dev_file="$dev_dir/$filename"

      if [[ -f "$dev_file" ]]; then
        echo "  OK: $dev_file"
      else
        echo "  MISSING: $dev_file"
        ((errors++))
      fi
    fi
  done
done

echo ""

# Check for template placeholders in mounted files
echo "Checking for unsubstituted placeholders in dev files..."
dev_files_with_placeholders=$(find volumes -name "*.dev.*" -o -name "*.dev" -type f 2>/dev/null | xargs grep -l '{{[A-Z_]*}}' 2>/dev/null || true)

if [[ -n "$dev_files_with_placeholders" ]]; then
  echo "  WARNING: Dev files still contain template placeholders:"
  echo "$dev_files_with_placeholders" | while read -r f; do
    echo "    $f"
  done
  ((errors++))
fi

echo ""

if [[ $errors -gt 0 ]]; then
  echo "FAILED: $errors issue(s) found"
  echo "Run ./scripts/generate-dev-configs.sh to fix"
  exit 1
else
  echo "PASSED: All dev configs present"
  exit 0
fi
