# syntax=docker/dockerfile:1
# Pre-published, multi-arch supabase/postgres + wal-g. Built ONCE per version
# (see README) and pulled by every deploy — never built per-project.
# wal-g build MUST match the base glibc: supabase/postgres:15.8.1.085 is
# Ubuntu 20.04 (glibc 2.31) on both arches, so the ubuntu-20.04 wal-g build is
# correct for amd64 AND arm64. (RCA 2026-05-30: the 22.04 build dies with
# "GLIBC_2.3x not found".)
FROM supabase/postgres:17.6.1.167@sha256:6942962433a569e87f228b4d4ab7e11db5deca64e43babb3a038443ad6c4f1bb

ARG TARGETARCH
# BUMP TRAP — upstream RENAMED these release assets. Verified against the
# GitHub Releases API 2026-07-30:
#   v3.0.5, v3.0.7 ship  wal-g-pg-ubuntu-20.04-{amd64,aarch64}
#   v3.0.8         ships wal-g-pg-20.04-{amd64,aarch64}   <- no `ubuntu-`
# Bumping WALG_VERSION to v3.0.8+ ALONE 404s on the curl below; the WALG_ASSET
# pattern must change in the same commit (and in the lockstep copy at
# carbon/db/Dockerfile). v3.0.7 needs no other change.
ARG WALG_VERSION=v3.0.5
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) WALG_ASSET="wal-g-pg-ubuntu-20.04-amd64" ;; \
      arm64) WALG_ASSET="wal-g-pg-ubuntu-20.04-aarch64" ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    apt-get update && apt-get install -y --no-install-recommends curl ca-certificates; \
    curl -fL "https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/${WALG_ASSET}.tar.gz" | tar -xz; \
    mv "${WALG_ASSET}" /usr/local/bin/wal-g; \
    chmod +x /usr/local/bin/wal-g; \
    /usr/local/bin/wal-g --version; \
    apt-get purge -y --auto-remove curl; \
    rm -rf /var/lib/apt/lists/*

# OCI metadata — see docker/carbon-autoscaler/Dockerfile for the full rationale.
# Short version: `org.opencontainers.image.description` is the ONLY input to a
# ghcr package page's description, and LABEL sits last because it is config
# metadata, not a layer, so editing the prose cannot invalidate the wal-g
# download above.
#
# The prose names NO version numbers, and no angle brackets. No versions,
# because both of them already appear twice in this file (the `FROM` tag and
# `ARG WALG_VERSION`) and a third time in the published tag — a fourth copy in
# a label is a fourth thing to forget. Describing how to READ the tag is
# drift-proof and more useful anyway. No angle brackets, because a
# `<placeholder>` in the description is at the mercy of whatever ghcr does with
# HTML-looking text on the page, and a silently swallowed word is worse than a
# clumsier sentence.
#
# No `org.opencontainers.image.licenses`: this image is overwhelmingly upstream
# bits (PostgreSQL, the supabase extension set, wal-g) under a mix of licenses,
# and our contribution is the single RUN layer above. Any one SPDX expression
# here would be a compliance claim we cannot actually back, and an absent label
# reads as "unknown", which is the truth. carbon-autoscaler, which IS our code
# end to end, does declare one.
#
# Guarded by tests/unit/deploy/oci-image-metadata.test.ts.
LABEL org.opencontainers.image.title="postgres" \
      org.opencontainers.image.description="supabase/postgres with the wal-g binary baked in, and nothing else changed. That one addition is what lets continuous WAL archiving, base backups and point-in-time restore run inside the database container itself — PostgreSQL's archive_command shells straight out to wal-g — instead of needing a separate backup sidecar with its own copy of PGDATA. Every tag names both versions it composes: the supabase/postgres version, then -walg, then the wal-g version. Built for vibecarbon's Kubernetes deploys, which pull it; vibecarbon's Docker Compose deploys build the equivalent image on the server and never pull this one." \
      org.opencontainers.image.source="https://github.com/hyperformant/vibecarbon"
