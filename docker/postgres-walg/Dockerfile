# syntax=docker/dockerfile:1
# Pre-published supabase/postgres + wal-g. Built ONCE per version (see
# README) and pulled by every k8s deploy — never built per-project.
#
# The base moved to supabase's Alpine/Nix image at PG17 (353MB compressed
# vs 649MB for the Ubuntu-era 15.x pin). The Nix-built postgres carries its
# own libc inside /nix, and the wal-g binary is fully static, so there is
# no glibc/musl matching left to do — that retired the RCA 2026-05-30
# glibc-pin guard and the upstream release-asset BUMP TRAP together. wal-g
# now comes from vibecarbon's own single build point (docker/wal-g/,
# published as ghcr.io/hyperformant/wal-g), version-locked with
# carbon/db/Dockerfile and src/lib/images.js's DB_IMAGE_TAG suffix —
# guarded by tests/unit/deploy/walg-dockerfile-arch.test.ts.
FROM ghcr.io/hyperformant/wal-g:3.0.9 AS walg

FROM supabase/postgres:17.6.1.167@sha256:6942962433a569e87f228b4d4ab7e11db5deca64e43babb3a038443ad6c4f1bb

COPY --from=walg /usr/local/bin/wal-g /usr/local/bin/wal-g
# The load-bearing exec: deploy only asserts archive_mode=on, never that
# wal-g runs, so this is the only place a broken binary fails loudly.
RUN wal-g --version

# OCI metadata — see docker/carbon-autoscaler/Dockerfile for the full rationale.
# Short version: `org.opencontainers.image.description` is the ONLY input to a
# ghcr package page's description, and LABEL sits last because it is config
# metadata, not a layer, so editing the prose cannot invalidate the wal-g
# layers above.
#
# The prose names NO version numbers, and no angle brackets. No versions,
# because both of them already appear in this file (the two `FROM` pins) and
# again in the published tag — another copy in a label is another thing to
# forget. Describing how to READ the tag is drift-proof and more useful
# anyway. No angle brackets, because a `<placeholder>` in the description is
# at the mercy of whatever ghcr does with HTML-looking text on the page, and
# a silently swallowed word is worse than a clumsier sentence.
#
# No `org.opencontainers.image.licenses`: this image is overwhelmingly upstream
# bits (PostgreSQL, the supabase extension set, wal-g) under a mix of licenses,
# and our contribution is the two COPY/RUN layers above. Any one SPDX
# expression here would be a compliance claim we cannot actually back, and an
# absent label reads as "unknown", which is the truth. carbon-autoscaler,
# which IS our code end to end, does declare one.
#
# Guarded by tests/unit/deploy/oci-image-metadata.test.ts.
LABEL org.opencontainers.image.title="postgres" \
      org.opencontainers.image.description="supabase/postgres with the wal-g binary baked in, and nothing else changed. That one addition is what lets continuous WAL archiving, base backups and point-in-time restore run inside the database container itself — PostgreSQL's archive_command shells straight out to wal-g — instead of needing a separate backup sidecar with its own copy of PGDATA. Every tag names both versions it composes: the supabase/postgres version, then -walg, then the wal-g version. Built for vibecarbon's Kubernetes deploys, which pull it; vibecarbon's Docker Compose deploys build the equivalent image on the server and never pull this one." \
      org.opencontainers.image.source="https://github.com/hyperformant/vibecarbon"
