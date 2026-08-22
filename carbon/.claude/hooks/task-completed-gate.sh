#!/usr/bin/env bash
# Quality gate: runs tests when test-maintainer marks a task complete.
# Exit 0 = pass, exit 2 = block with feedback message.
set -euo pipefail

TEAMMATE=$(jq -r '.teammate_name // empty' 2>/dev/null || true)

case "$TEAMMATE" in
  test-maintainer)
    ;;
  *)
    exit 0
    ;;
esac

if ! npm test 2>&1; then
  echo "Tests are failing. Fix them before marking the task complete."
  exit 2
fi
