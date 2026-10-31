# syntax=docker/dockerfile:1
# vibecarbon's node runtime base: a bare Alpine with exactly what a built
# vibecarbon app needs to run (the node binary, libstdc++ and the non-root
# `hono` user), and nothing it needs to build (no npm, no corepack, no yarn).
# Built ONCE per revision by .github/workflows/publish-node-runtime-image.yml,
# and every app image builds FROM it (carbon/Dockerfile, `ARG RUNTIME_IMAGE`,
# byte-for-byte NODE_RUNTIME_IMAGE in src/lib/images.js). Because every app
# image shares these layers, a deploy pulls them from ghcr at datacenter speed
# once per server and ships only the app's own layers from the operator.
#
# The ONE Node pin in this file, by multi-arch INDEX digest. `pnpm node:sync`
# writes its major from the repo's .nvmrc (tests/unit/lib/node-version-pins.test.ts).
#
# The alpine minor is load-bearing, not cosmetic: the node binary is COPY'd
# out of the node image onto the bare alpine below, so both must be the SAME
# alpine or the binary hits a musl/libstdc++ mismatch at runtime. The tag in
# NODE_RUNTIME_IMAGE names both (<node major>-alpine<alpine minor>-r<N>), and
# the pins test holds all three to one minor.
ARG NODE_IMAGE=node:24-alpine3.24@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

# BuildKit REJECTS `COPY --from=${NODE_IMAGE}` ("variable expansion is not
# supported for --from"); a stage built FROM the global ARG is the workaround.
FROM ${NODE_IMAGE} AS node

FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

RUN apk add --no-cache libstdc++ && \
    addgroup -g 1001 -S hono && \
    adduser -S hono -u 1001 -G hono

COPY --from=node /usr/local/bin/node /usr/local/bin/node

# OCI metadata, see docker/postgres-walg/Dockerfile for the rationale: the
# description is the only input to the ghcr package page, LABEL sits last
# because it is config, not a layer, and the prose names no versions (the tag
# carries them) and no angle brackets. No licenses label: this image is
# upstream bits only (Node.js, Alpine, libstdc++) plus a user account.
# Guarded by tests/unit/deploy/oci-image-metadata.test.ts.
LABEL org.opencontainers.image.title="node-runtime" \
      org.opencontainers.image.description="A bare Alpine base with just the Node.js binary, libstdc++ and an unprivileged hono user, the runtime every vibecarbon app image builds on. No npm and no build tooling: apps are built in their own builder stage and copy only their output here. Every tag names the Node.js major, then the Alpine minor, then a revision that moves whenever this image changes. Pulled by vibecarbon deploys and local builds, so servers fetch the shared base from this registry and receive only each app's own layers." \
      org.opencontainers.image.source="https://github.com/hyperformant/vibecarbon"
