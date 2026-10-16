#!/usr/bin/env bash
# Smoke test for the static wal-g image (docker/wal-g), run by
# .github/workflows/native-multiarch-image.yml on each arch's own runner
# BEFORE that arch is pushed, and again against the published tag.
#
# The image is FROM scratch with one file, so the test is the one thing that
# matters: the binary EXECUTES on this arch. A wrong-arch or dynamically
# linked build fails here, not later in a database's archive_command.
#
# Usage: smoke-walg-image.sh <image ref>
# Lives outside docker/wal-g on purpose: every file there is an image input
# (the dev channel's pathspec, tests/e2e/utils/db-image-select.js).
set -euo pipefail
IMAGE=${1:?usage: smoke-walg-image.sh <image ref>}
docker run --rm --entrypoint /usr/local/bin/wal-g "$IMAGE" --version
