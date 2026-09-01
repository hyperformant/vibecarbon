# syntax=docker/dockerfile:1
# Static wal-g, built ONCE and published to ghcr.io/hyperformant/wal-g —
# the single build point for the binary both database images copy in
# (carbon/db/Dockerfile and docker/postgres-walg/Dockerfile).
#
# WHY BUILD FROM SOURCE: supabase/postgres 17.x is Alpine/musl; upstream
# wal-g releases are glibc-only (the alpine variant was retired upstream in
# 2026-04). Our backup config uses lz4 compression (pure Go) and no
# libsodium/PGP, so CGO_ENABLED=0 with no build tags produces a fully
# static binary that runs on musl and glibc alike. This also retires the
# release-asset BUMP TRAP (upstream renamed assets in v3.0.8) — we pin a
# source tag instead of a release asset name.
#
# Cross-compile on the BUILD platform (no QEMU): Go targets TARGETARCH
# directly, so the multi-arch publish is two `go build`s, not emulation.
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build
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
FROM alpine:3.24 AS smoke
COPY --from=build /out/wal-g /usr/local/bin/wal-g
RUN wal-g --version

FROM scratch
COPY --from=smoke /usr/local/bin/wal-g /usr/local/bin/wal-g

# OCI metadata — see docker/carbon-autoscaler/Dockerfile for the full
# rationale (description is the ghcr package page; LABEL last so prose
# edits never invalidate the build layers; no versions in the prose — the
# tag and ARG WALG_VERSION above already carry them).
LABEL org.opencontainers.image.title="wal-g" \
      org.opencontainers.image.description="Statically linked wal-g PostgreSQL binary, built from the pinned upstream source tag with CGO disabled so it runs on musl and glibc images alike. This is the single build point for the wal-g binary that vibecarbon's database images copy in: both the pre-published Kubernetes postgres image and the Docker Compose db image built on each target server take the binary from here instead of downloading upstream release assets. The tag names the wal-g version it contains." \
      org.opencontainers.image.source="https://github.com/hyperformant/vibecarbon"
