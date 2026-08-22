#!/usr/bin/env bash
# Fast-forward the local main branch to origin/main. Best-effort: exits 0 on
# any failure so it never blocks a session or a tool loop.
#
# Wired twice in .claude/settings.json:
#   - SessionStart: every session opens with local main current, no matter
#     where the merge happened (GitHub UI, auto-merge, another machine).
#   - PostToolUse (if: "Bash(gh pr merge*)"): long sessions stay fresh right
#     after an in-session merge.
#
# Why: stale local main refs poison merge-base comparisons and any branch or
# worktree created from them (2026-07-29 session: phantom review diffs, a
# worktree cut from a pre-merge base).
set -u

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$ROOT" || exit 0

# Refresh remote refs (and drop remote-branch corpses left by merged PRs).
git fetch --quiet --prune origin main 2>/dev/null || exit 0

# Where (if anywhere) is main checked out?
MAIN_WT=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{w=substr($0,10)} /^branch refs\/heads\/main$/{print w}')

if [ -n "$MAIN_WT" ]; then
  # main is checked out: only a fast-forward merge, and only when no tracked
  # files are modified (untracked files are fine — git's own --ff-only merge
  # additionally refuses to overwrite any local change, so this guard is
  # belt-and-suspenders, not the safety net).
  if [ -z "$(git -C "$MAIN_WT" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    git -C "$MAIN_WT" merge --ff-only --quiet origin/main 2>/dev/null || true
  fi
else
  # main not checked out: update the ref directly (refuses non-fast-forward).
  git fetch --quiet origin main:main 2>/dev/null || true
fi

exit 0
