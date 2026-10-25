#!/usr/bin/env bash
# Smoke test for the node runtime base (docker/node-runtime), run by
# .github/workflows/native-multiarch-image.yml on each arch's own runner
# BEFORE that arch is pushed, and again against the published tag.
#
# What an app image relies on: node EXECUTES on this arch against this
# Alpine's musl and libstdc++ and is the .nvmrc major, the `hono` user is uid
# 1001 (carbon/Dockerfile ends in `USER hono`), and no npm ships (build
# tooling belongs in the app's builder stage, never in the shared runtime).
#
# Usage: smoke-node-runtime-image.sh <image ref>
# Lives outside docker/node-runtime on purpose: every file there is an image
# input (tests/unit/deploy/node-runtime-image-fingerprint.test.ts).
set -euo pipefail
IMAGE=${1:?usage: smoke-node-runtime-image.sh <image ref>}
# The workflow runs this from the repo checkout, so .nvmrc (the bare Node
# major every pin derives from) is right here.
want=$(tr -d '[:space:]' < .nvmrc)
got=$(docker run --rm "$IMAGE" node --version)
echo "node $got"
major=${got#v}
major=${major%%.*}
if [ "$major" != "$want" ]; then
  echo "$IMAGE runs node $got, but .nvmrc says major $want" >&2
  exit 1
fi
docker run --rm "$IMAGE" node -e 'require("node:crypto").createHash("sha256").update("x").digest("hex")'
test "$(docker run --rm "$IMAGE" id -u hono)" = 1001
if docker run --rm "$IMAGE" sh -c 'command -v npm'; then
  echo "npm is present in $IMAGE; the runtime base must not ship build tooling" >&2
  exit 1
fi
