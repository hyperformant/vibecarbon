#!/usr/bin/env bash
# Quality gate: runs lint + typecheck + security invariants when
# backend-engineer or frontend-engineer go idle.
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

if ! npm run lint 2>&1; then
  ERRORS+="Lint errors found. Run 'npm run lint' to see details.\n"
fi

if ! npm run typecheck 2>&1; then
  ERRORS+="Type errors found. Run 'npm run typecheck' to see details.\n"
fi

# Security invariants (RLS enabled + write-policy scoping + single-origin
# routing). Fast (static, no DB) — a red result means a change would introduce
# a data-exposure or auth regression; fix the code, never delete the assertion.
if ! npm run test:security 2>&1; then
  ERRORS+="Security invariants failed. Run 'npm run test:security' — a public table without RLS, a write policy without WITH CHECK, or a broken routing boundary. Fix the code, do not weaken the test.\n"
fi

if [ -n "$ERRORS" ]; then
  echo -e "$ERRORS"
  exit 2
fi
