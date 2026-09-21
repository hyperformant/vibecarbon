# syntax=docker/dockerfile:1
# supabase/postgres + wal-g for the compose path. This image IS the backup
# tooling (wal-g runs co-located with PGDATA in this container for continuous
# WAL archiving, base backups, and restore — no separate backup image).
#
# ARCH: this Dockerfile is built ON THE TARGET SERVER by the compose path
# (`build: ./db` in docker-compose.yml) and on dev machines (incl. Apple
# Silicon). The wal-g image below is multi-arch (amd64+arm64), so docker
# resolves the right platform automatically — no TARGETARCH plumbing here.
#
# The base moved to supabase's Alpine/Nix image at PG17 (353MB compressed
# vs 649MB for the Ubuntu-era 15.x pin — a real win when every server pulls
# it). The Nix-built postgres carries its own libc inside /nix, and the
# wal-g binary is fully static, so the RCA 2026-05-30 glibc matching and
# the upstream release-asset BUMP TRAP are both retired; wal-g comes from
# vibecarbon's single build point (docker/wal-g/, published as
# ghcr.io/hyperformant/wal-g), version-locked with
# docker/postgres-walg/Dockerfile and src/lib/images.js's DB_IMAGE_TAG
# suffix. Guarded by tests/unit/deploy/walg-dockerfile-arch.test.ts.
FROM ghcr.io/hyperformant/wal-g:3.0.9 AS walg

FROM supabase/postgres:17.6.1.172@sha256:9468db51b26ebb11bf29b6be2f061ac9fd6f3912a0f311c3e84f4ba96e097a9f

COPY --from=walg /usr/local/bin/wal-g /usr/local/bin/wal-g
# The load-bearing exec: deploy only asserts archive_mode=on, never that
# wal-g runs, so this is the only place a broken binary fails loudly.
RUN wal-g --version

# The supabase image already has many configurations.
# We will enable archiving via environment variables or a custom config snippet if needed.
