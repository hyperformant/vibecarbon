#!/usr/bin/env bash
# Remove linked worktrees and local branches whose work has already merged.
# Best-effort: exits 0 on every path so it never blocks a session.
#
# A branch counts as merged only on proof, and a missed proof just leaves it:
#   1. A merged PR has the same head branch name and the same commit as the
#      branch tip (covers squash and rebase merges), or
#   2. the branch tip is reachable from origin/<default branch> but is not on
#      its first-parent line, which is how a merge commit brings a branch in.
#      A tip ON the first-parent line is where new work starts (a fresh
#      worktree, or a branch fast-forwarded to main), so it proves nothing.
# Needs only git, sed, awk and grep. The merged-PR proof also needs `gh` on
# PATH and logged in; without it only proof 2 applies. `lsof` is optional.
#
# A worktree is left alone, with a reason in the output, when this session is
# working in it, when it has uncommitted changes, or when another process has
# its working directory inside it. Nothing is ever forced. If git itself
# refuses (a locked worktree, submodules), the worktree and its branch stay.
#
# Removing a worktree deletes everything in its directory, ignored files
# included (node_modules, .env files), exactly as `git worktree remove` does.
# Only tracked changes and untracked files keep a worktree.
#
# Test-only override: CLEAN_MERGED_PROC_DIR replaces /proc in the process scan.
#
# Output: one JSON line with additionalContext listing what was removed or
# left, and nothing at all when there was nothing to report.
#
# Why: 2026-11-13, five worktrees and 24 branches were still around after
# their PRs merged.
set -u

INPUT=""
[ -t 0 ] || INPUT=$(cat 2>/dev/null || true)
EVENT=$(printf '%s' "$INPUT" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
[ -n "$EVENT" ] || EVENT=SessionStart

git rev-parse --git-dir >/dev/null 2>&1 || exit 0
git remote 2>/dev/null | grep -qx origin || exit 0

# A failed fetch (offline, or a lock held by ff-main.sh) is fine: both proofs
# stay valid on stale refs and can only miss newly merged work.
git fetch --quiet --prune origin 2>/dev/null || true

DEF=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
DEF=${DEF#origin/}
if [ -z "$DEF" ]; then
  if git show-ref --verify --quiet refs/remotes/origin/main; then
    DEF=main
  elif git show-ref --verify --quiet refs/remotes/origin/master; then
    DEF=master
  else
    exit 0
  fi
fi
git rev-parse --verify --quiet "refs/remotes/origin/$DEF" >/dev/null || exit 0

# The default branch's first-parent line, one sha per line.
FIRST_PARENT=$(mktemp 2>/dev/null) || exit 0
trap 'rm -f "$FIRST_PARENT"' EXIT
git rev-list --first-parent "refs/remotes/origin/$DEF" >"$FIRST_PARENT" 2>/dev/null || exit 0

# Is "$1" reachable from origin/<default> but off its first-parent line?
contained() {
  git merge-base --is-ancestor "$1" "refs/remotes/origin/$DEF" 2>/dev/null || return 1
  grep -qxF "$1" "$FIRST_PARENT" && return 1
  return 0
}

# Merged PR heads, "<branch> <sha>" per line.
MERGED_PRS=""
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  MERGED_PRS=$(gh pr list --state merged --limit 200 --json headRefName,headRefOid \
    --jq '.[] | "\(.headRefName) \(.headRefOid)"' 2>/dev/null || true)
fi

physical() { (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"; }

# Is "$2" (a path) equal to or inside "$1"?
inside() {
  case "$2" in
    "$1" | "$1"/*) return 0 ;;
  esac
  return 1
}

HOOK_CWD=$(physical "$PWD")
PROJECT_DIR=""
[ -n "${CLAUDE_PROJECT_DIR:-}" ] && PROJECT_DIR=$(physical "$CLAUDE_PROJECT_DIR")

# Is branch "$1" at tip "$2" merged?
is_merged() {
  _b=$1
  _tip=$2
  if contained "$_tip"; then
    return 0
  fi
  [ -n "$MERGED_PRS" ] || return 1
  _up=$(git for-each-ref --format='%(upstream:short)' "refs/heads/$_b" 2>/dev/null)
  _up=${_up#origin/}
  for _n in "$_up" "$_b"; do
    [ -n "$_n" ] || continue
    if printf '%s\n' "$MERGED_PRS" | grep -Fxq "$_n $_tip"; then
      return 0
    fi
  done
  return 1
}

# Echo a reason when something is working in "$1"; return 0 if so.
busy_reason() {
  if [ -n "$PROJECT_DIR" ] && inside "$1" "$PROJECT_DIR"; then
    echo "this session is working in it"
    return 0
  fi
  if inside "$1" "$HOOK_CWD"; then
    echo "this session is working in it"
    return 0
  fi
  if [ -n "$(git -C "$1" status --porcelain 2>/dev/null)" ]; then
    echo "it has uncommitted changes"
    return 0
  fi
  _proc=${CLEAN_MERGED_PROC_DIR:-/proc}
  if [ -r "$_proc/self/cwd" ]; then
    for _d in "$_proc"/[0-9]*/cwd; do
      _t=$(readlink "$_d" 2>/dev/null) || continue
      if inside "$1" "$_t"; then
        echo "another process is working in it"
        return 0
      fi
    done
  elif command -v lsof >/dev/null 2>&1; then
    if lsof -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | while IFS= read -r _t; do
      if inside "$1" "$_t"; then echo y; break; fi
    done | grep -q y; then
      echo "another process is working in it"
      return 0
    fi
  else
    echo "cannot tell whether something is working in it"
    return 0
  fi
  return 1
}

LINES=""
add_line() { LINES="${LINES}$1
"; }

CHECKED_OUT=" "
FIRST=1
WORKTREES=$(git worktree list --porcelain 2>/dev/null | awk '
  /^worktree /{ if (p != "") print p "|" h "|" b; p = substr($0, 10); h = ""; b = "" }
  /^HEAD /{ h = substr($0, 6) }
  /^branch refs\/heads\//{ b = substr($0, 19) }
  END { if (p != "") print p "|" h "|" b }')

while IFS='|' read -r WT_PATH WT_HEAD WT_BRANCH; do
  [ -n "$WT_PATH" ] || continue
  [ -n "$WT_BRANCH" ] && CHECKED_OUT="$CHECKED_OUT$WT_BRANCH "
  if [ "$FIRST" = 1 ]; then
    FIRST=0
    continue
  fi
  [ "$WT_BRANCH" = "$DEF" ] && continue
  [ -n "$WT_HEAD" ] || continue
  if [ -n "$WT_BRANCH" ]; then
    is_merged "$WT_BRANCH" "$WT_HEAD" || continue
  else
    contained "$WT_HEAD" || continue
  fi
  LABEL=${WT_BRANCH:-detached}
  PHYS=$(physical "$WT_PATH")
  if REASON=$(busy_reason "$PHYS"); then
    add_line "Left $WT_PATH ($LABEL): $REASON"
    continue
  fi
  if ! git worktree remove "$WT_PATH" >/dev/null 2>&1; then
    add_line "Left $WT_PATH ($LABEL): git would not remove it"
    continue
  fi
  add_line "Removed merged worktree $WT_PATH ($LABEL)"
  if [ -n "$WT_BRANCH" ]; then
    git branch -D "$WT_BRANCH" >/dev/null 2>&1 || true
  fi
done <<EOT
$WORKTREES
EOT

# Merged branches with no worktree.
BRANCHES=$(git for-each-ref --format='%(refname:short) %(objectname)' refs/heads 2>/dev/null)
while read -r B TIP; do
  [ -n "$B" ] || continue
  [ "$B" = "$DEF" ] && continue
  case "$CHECKED_OUT" in *" $B "*) continue ;; esac
  is_merged "$B" "$TIP" || continue
  git branch -D "$B" >/dev/null 2>&1 || continue
  add_line "Deleted merged branch $B"
done <<EOT
$BRANCHES
EOT

[ -n "$LINES" ] || exit 0

TEXT=$(printf '%s' "$LINES" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'NR > 1 { printf "\\n" } { printf "%s", $0 }')
EV=$(printf '%s' "$EVENT" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\n' "$EV" "$TEXT"
exit 0
