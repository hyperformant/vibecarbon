# syntax=docker/dockerfile:1
FROM supabase/postgres:15.8.1.085@sha256:af083ef64d0408c8f098ee6f5c364a59b26f36fbc0f3a334a62c5c1d57362e9b

# Install WAL-G. This image IS the backup tooling now (both compose
# and k8s): wal-g runs co-located with PGDATA in this container for continuous
# WAL archiving, base backups, and restore — no separate backup image.
# Earlier v3.0.3 URL 404'd in 2026-04-26 (alpine variant retired upstream),
# and curl without --fail piped a 404 HTML body into tar which surfaced
# as "not in gzip format" instead of an honest HTTP error. --fail makes
# curl exit non-zero on 4xx/5xx so the failure is unmistakable.
#
# ARCH: this Dockerfile is built ON THE TARGET SERVER by the compose path
# (`build: ./db` in docker-compose.yml), so the server's architecture decides
# what has to run. supabase/postgres:15.8.1.085 is multi-arch, so a hardcoded
# amd64 wal-g asset produced an image that BUILT and came up HEALTHY on an
# arm64 host while every wal-g exec failed — silently dead WAL archiving and
# backups behind green health checks. Select the asset from TARGETARCH
# (BuildKit predefined build arg), identically to docker/postgres-walg/
# Dockerfile; an unset/unknown TARGETARCH fails the build rather than
# guessing.
#
# Build target MUST match the base image's glibc: supabase/postgres:15.8.1.085
# is Ubuntu 20.04 (glibc 2.31) on both arches. The ubuntu-22.04 wal-g build is
# linked against glibc 2.35 and dies at runtime with `version
# 'GLIBC_2.3{2,3,4}' not found` — which breaks BOTH base backups and WAL
# archiving (the archive_command shells out to wal-g). The ubuntu-20.04 build
# links against glibc 2.31 and runs on this base. (RCA 2026-05-30: e2e
# k8s/k8s-ha backup step — wal-g exited 1 with the GLIBC error inside the db
# pod.)
#
# `wal-g --version` is the load-bearing line: it EXECUTES the binary in the
# build, so a wrong-arch ("Exec format error") or glibc-mismatched download
# fails the build loudly instead of shipping a database that looks fine and
# has no backups. Deploy only asserts archive_mode=on, never that wal-g runs,
# so this is the only place the binary is proven to execute at all.
#
# Single RUN with `apt-get purge -y --auto-remove curl` collapses the
# install + cleanup into one layer so the curl binary doesn't end up
# in the published image (saving ~5MB and reducing attack surface).
ARG TARGETARCH
# BUMP TRAP — upstream RENAMED these release assets. Verified against the
# GitHub Releases API 2026-07-30:
#   v3.0.5, v3.0.7 ship  wal-g-pg-ubuntu-20.04-{amd64,aarch64}
#   v3.0.8         ships wal-g-pg-20.04-{amd64,aarch64}   <- no `ubuntu-`
# So bumping WALG_VERSION to v3.0.8+ ALONE 404s on the curl below; the
# WALG_ASSET pattern has to change in the same commit (and in the lockstep
# copy at docker/postgres-walg/Dockerfile). v3.0.7 needs no other change.
# The failure is at least loud: `wal-g --version` below runs the binary in-image.
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

# The supabase image already has many configurations.
# We will enable archiving via environment variables or a custom config snippet if needed.
