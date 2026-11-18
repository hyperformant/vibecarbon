#!/usr/bin/env bash
# Lints what Biome cannot read: shell scripts, GitHub workflows, Dockerfiles,
# and the commits of the current branch for secrets. Each linter runs from the
# image pinned in .github/lint-tools/Dockerfile, so CI and a laptop run the
# same version and nothing has to be installed beyond Docker.
#
#   pnpm lint:infra                 all four
#   pnpm lint:infra shell workflows any subset: shell workflows docker secrets
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

image() {
  awk -v stage="$1" '$1 == "FROM" && $4 == stage { print $2 }' .github/lint-tools/Dockerfile
}

# Warnings and errors gate; style notes do not. actionlint hands each run:
# block to shellcheck, which reads the same variable.
run() {
  local stage="$1"
  shift
  docker run --rm -v "$PWD:/repo:ro" -w /repo \
    -e SHELLCHECK_OPTS=--severity=warning "$(image "$stage")" "$@"
}

lint_shell() {
  local templates=() scripts=() f
  while IFS= read -r f; do
    case "$f" in
      carbon/cloud-init/*) templates+=("$f") ;;
      # No shebang, by design: the first is sourced by bash scripts in the db
      # container, the second is handed to `ssh <target> sh -c`.
      carbon/volumes/db/walg-env.sh | src/lib/deploy/layer-delta-remote.sh) ;;
      *) scripts+=("$f") ;;
    esac
  done < <(git ls-files '*.sh')

  # Every pass runs, so one report lists everything; any failure fails the lot.
  local status=0
  # SC1090: a path sourced through a variable can never be followed.
  run shellcheck --exclude=SC1090 "${scripts[@]}" || status=1
  run shellcheck --shell=bash carbon/volumes/db/walg-env.sh || status=1
  run shellcheck --shell=sh src/lib/deploy/layer-delta-remote.sh || status=1
  # The cloud-init files are templates: loadCloudInit fills ${lower_case} and
  # @{slot} placeholders and splices the _snippet files into their parents
  # before any shell reads them. So a placeholder is not an unassigned
  # variable (SC2154), a slot's braces are not stray (SC1083), a variable can
  # be set in one file and read in the snippet spliced after it (SC2034), and
  # a snippet has no shebang of its own.
  run shellcheck --shell=bash \
    --exclude=SC2154,SC1083,SC2034 "${templates[@]}" || status=1
  return "$status"
}

lint_workflows() {
  run actionlint -color
}

lint_docker() {
  local files=()
  mapfile -t files < <(git ls-files | grep -E '(^|/)Dockerfile$')
  run hadolint hadolint --config .hadolint.yaml "${files[@]}"
}

# Only the commits this branch adds. The whole history is scanned on a
# schedule elsewhere; a PR gate has to answer for the PR alone.
lint_secrets() {
  local base="${LINT_SECRETS_BASE:-origin/main}"
  # The repo is mounted read-only and owned by another uid inside the image.
  docker run --rm -v "$PWD:/repo:ro" -w /repo \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0=/repo \
    "$(image gitleaks)" git /repo --redact --no-banner \
    --config /repo/.gitleaks.toml --log-opts="$base..HEAD"
}

targets=("$@")
[ ${#targets[@]} -gt 0 ] || targets=(shell workflows docker secrets)

status=0
for target in "${targets[@]}"; do
  case "$target" in
    shell | workflows | docker | secrets)
      echo "== $target"
      "lint_$target" || status=1
      ;;
    *)
      echo "unknown target: $target (shell, workflows, docker, secrets)" >&2
      exit 2
      ;;
  esac
done
exit "$status"
