#!/usr/bin/env bash
# Quality gate: runs lint + typecheck when backend-engineer or frontend-engineer go idle.
# Exit 0 = pass, exit 2 = block with feedback message.
set -euo pipefail

TEAMMATE=$(jq -r '.teammate_name // empty' 2>/dev/null || true)

case "$TEAMMATE" in
  backend-engineer|frontend-engineer)
    ;;
  *)
    exit 0
    ;;
esac

ERRORS=""

if ! pnpm lint 2>&1; then
  ERRORS+="Lint errors found. Run 'pnpm lint' to see details.\n"
fi

if ! pnpm typecheck 2>&1; then
  ERRORS+="Type errors found. Run 'pnpm typecheck' to see details.\n"
fi

if [ -n "$ERRORS" ]; then
  echo -e "$ERRORS"
  exit 2
fi
