# syntax=docker/dockerfile:1
# Static wal-g, built ONCE and published to ghcr.io/hyperformant/wal-g —
# the single build point for the binary the db image copies in
# (docker/postgres-walg/Dockerfile).
#
# WHY BUILD FROM SOURCE: upstream wal-g releases are glibc-only. Our backup
# config uses lz4 compression (pure Go) and no libsodium/PGP, so
# CGO_ENABLED=0 with no build tags produces a fully static binary that runs
# on any libc. This also retires the release-asset BUMP TRAP (upstream
# renamed assets in v3.0.8) — we pin a source tag instead of a release
# asset name.
#
# CI builds each arch on its own native runner (ubuntu-24.04 /
# ubuntu-24.04-arm, .github/workflows/native-multiarch-image.yml), so there
# BUILDPLATFORM equals TARGETPLATFORM and the smoke stage below executes
# natively, never under QEMU. The build stage still runs on $BUILDPLATFORM
# with GOARCH from TARGETARCH, so a local cross-platform build keeps the
# `go build` itself emulation-free.
FROM --platform=$BUILDPLATFORM golang:1.26.9-alpine3.24@sha256:3082400e369fa24d5fc60bca20edab3f6d604e0c5a690ec66b295eff4dd87ade AS build
RUN apk add --no-cache git
ARG WALG_VERSION=v3.0.9
RUN git clone --depth 1 --branch "${WALG_VERSION}" https://github.com/wal-g/wal-g.git /src
WORKDIR /src
ARG TARGETARCH
# GOEXPERIMENT=jsonv2: wal-g 3.x imports encoding/json/v2 directly
# (internal/uploader.go) — the build fails without it. The -X pins mirror
# upstream's Makefile so `wal-g --version` reports honestly.
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} GOEXPERIMENT=jsonv2 \
    go build -C main/pg -tags "" \
      -ldflags "-s -w -X github.com/wal-g/wal-g/cmd/pg.walgVersion=${WALG_VERSION}" \
      -o /out/wal-g

# Native-arch smoke stage: actually EXECUTE the binary. The build stage
# above runs on BUILDPLATFORM and may have cross-compiled, so the exec has
# to happen in a TARGETPLATFORM stage. A wrong-arch or dynamically-linked
# binary fails HERE, in the build — not silently in archive_command later.
FROM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a AS smoke
COPY --from=build /out/wal-g /usr/local/bin/wal-g
RUN wal-g --version

FROM scratch
COPY --from=smoke /usr/local/bin/wal-g /usr/local/bin/wal-g

# OCI metadata — see docker/carbon-autoscaler/Dockerfile for the full
# rationale (description is the ghcr package page; LABEL last so prose
# edits never invalidate the build layers; no versions in the prose — the
# tag and ARG WALG_VERSION above already carry them).
LABEL org.opencontainers.image.title="wal-g" \
      org.opencontainers.image.description="Statically linked wal-g PostgreSQL binary, built from the pinned upstream source tag with CGO disabled so it runs on musl and glibc images alike. This is the single build point for the wal-g binary in vibecarbon's database image, the one published image every deploy mode and local development pull, so it takes the binary from here instead of downloading upstream release assets. The tag names the wal-g version it contains." \
      org.opencontainers.image.source="https://github.com/hyperformant/vibecarbon"
