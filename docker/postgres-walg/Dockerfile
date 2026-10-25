# syntax=docker/dockerfile:1
# vibecarbon's database image: the official postgres Alpine image plus three
# additions, pg_cron, wal-g and a baked postgresql.conf. Built ONCE per version
# by .github/workflows/publish-db-image.yml and PULLED by every deploy mode
# (compose, compose-ha, k8s, k8s-ha) and by local `vibecarbon up`. Nothing
# builds a database image on a server or a developer machine any more.
#
# BASE: postgres:<major>.<minor>-alpine<alpine>, pinned by the multi-arch INDEX
# digest (amd64 + arm64 children, so an Apple Silicon `vibecarbon up` resolves
# its own platform). The builder stage and the final stage MUST name the
# identical ref: pg_cron's shared library is compiled against that exact
# server's headers, and a minor-version skew between the two stages would ship
# a library built for a different server. Guarded by
# tests/unit/deploy/walg-dockerfile-arch.test.ts, which also pins the tag in
# src/lib/images.js to <PG_VERSION>-walg<WALG_VERSION> from these two pins.
#
# wal-g comes from vibecarbon's single build point (docker/wal-g/, published as
# ghcr.io/hyperformant/wal-g): a fully static binary, so there is no libc to
# match against the base. Pinned by the multi-arch index digest like the base:
# this line is the one record of which wal-g build the db image carries.
# publish-db-image.yml republishes the wal-g tag only when docker/wal-g
# changes, and never feeds that fresh digest into the db build in the same
# run; adopting a new wal-g build is a re-pin here (Dependabot proposes it,
# since the docker ecosystem watches this directory) plus a DB_IMAGE_TAG
# revision bump. The dev channel (publish-db-image-dev.yml) overrides this
# exact ref with a build context when a branch rebuilt wal-g.
FROM ghcr.io/hyperformant/wal-g:3.0.9@sha256:c278e2f144a6118409174b2f614329e2846aa5842d65c47aa98e0190cd374ce2 AS walg

# --- pg_cron builder -------------------------------------------------------
# Compiled from a pinned upstream release tag. ADD --checksum verifies the
# tarball before a single byte of it is unpacked, so a retagged or tampered
# release fails the build instead of shipping.
#
# The tarball is GitHub's on-the-fly archive of the tag, and GitHub has changed
# those bytes before (a compression change) without the tag moving. So if this
# checksum fails while upstream shows no change to the tag, re-download, verify
# the contents against the tag, and re-pin the new checksum. Never remove or
# bypass the check.
#
# The toolchain lives only in this stage; the final stage copies out exactly
# the files `make install` produced.
#
# with_llvm=no: the base postgres is built --with-llvm, so PGXS would otherwise
# also emit JIT bitcode and need clang + llvm (hundreds of MB) in the builder.
# The bitcode only lets the JIT inline pg_cron's C functions, which no query
# path of ours benefits from.
FROM postgres:17.11-alpine3.24@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb AS pg_cron
ARG PG_CRON_VERSION=1.6.8
ADD --checksum=sha256:c19ab9bb35406c60fb51ecda993737c083850abe424acb6c1030439d00a1f8e4 \
    https://github.com/citusdata/pg_cron/archive/refs/tags/v${PG_CRON_VERSION}.tar.gz /tmp/pg_cron.tar.gz
RUN apk add --no-cache build-base \
 && mkdir -p /tmp/pg_cron \
 && tar -xzf /tmp/pg_cron.tar.gz -C /tmp/pg_cron --strip-components=1 \
 && make -C /tmp/pg_cron with_llvm=no \
 && make -C /tmp/pg_cron with_llvm=no install DESTDIR=/out

# --- final image -----------------------------------------------------------
FROM postgres:17.11-alpine3.24@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb

# pg_cron: the shared library and the extension's control + SQL scripts. Only
# those two directories come across; no compiler, headers or build output.
COPY --from=pg_cron /out/usr/local/lib/postgresql/ /usr/local/lib/postgresql/
COPY --from=pg_cron /out/usr/local/share/postgresql/extension/ /usr/local/share/postgresql/extension/
COPY --from=walg /usr/local/bin/wal-g /usr/local/bin/wal-g
COPY postgresql.conf /etc/postgresql/postgresql.conf
COPY --chmod=0755 db-entrypoint.sh /usr/local/bin/db-entrypoint.sh

# The load-bearing execs: deploy only asserts archive_mode=on, never that wal-g
# runs, so this is the only place a broken binary fails loudly. The pg_cron
# check proves the library the builder produced landed where the server loads
# shared_preload_libraries from; the pg_stat_statements check proves the base
# image still ships the contrib module postgresql.conf preloads.
RUN wal-g --version \
 && test -f "$(pg_config --pkglibdir)/pg_cron.so" \
 && test -f "$(pg_config --sharedir)/extension/pg_cron.control" \
 && test -f "$(pg_config --pkglibdir)/pg_stat_statements.so" \
 && test -f "$(pg_config --sharedir)/extension/pg_stat_statements.control"

# db-entrypoint.sh wraps the official docker-entrypoint.sh (it sources it and
# keeps WAL archiving off the init-time temporary server; the script says why).
# CMD is restated because setting ENTRYPOINT resets the inherited one.
ENTRYPOINT ["db-entrypoint.sh"]
CMD ["postgres"]

# OCI metadata — see docker/carbon-autoscaler/Dockerfile for the full rationale.
# Short version: `org.opencontainers.image.description` is the ONLY input to a
# ghcr package page's description, and LABEL sits last because it is config
# metadata, not a layer, so editing the prose cannot invalidate the layers
# above.
#
# The prose names NO version numbers, and no angle brackets. No versions,
# because they already appear in this file (the `FROM` pins and the pg_cron
# tarball) and again in the published tag — another copy in a label is another
# thing to forget. Describing how to READ the tag is drift-proof and more
# useful anyway. No angle brackets, because a `<placeholder>` in the
# description is at the mercy of whatever ghcr does with HTML-looking text on
# the page, and a silently swallowed word is worse than a clumsier sentence.
#
# No `org.opencontainers.image.licenses`: this image is overwhelmingly upstream
# bits (PostgreSQL, pg_cron, wal-g, Alpine) under a mix of licenses, and our
# contribution is a config file and a short entrypoint wrapper. Any one SPDX
# expression here would be a compliance claim we cannot actually back, and an
# absent label reads as "unknown", which is the truth. carbon-autoscaler, which
# IS our code end to end, does declare one.
#
# Guarded by tests/unit/deploy/oci-image-metadata.test.ts.
LABEL org.opencontainers.image.title="postgres" \
      org.opencontainers.image.description="The official PostgreSQL Alpine image with three additions: the pg_cron extension for scheduled jobs inside the database, the wal-g binary for continuous WAL archiving, base backups and point-in-time restore from inside the database container itself, and a small baked postgresql.conf that preloads pg_cron. Every tag names both versions it composes: the PostgreSQL version, then -walg, then the wal-g version. Built once and pulled by every vibecarbon deploy mode, Docker Compose and Kubernetes alike, and by local development." \
      org.opencontainers.image.source="https://github.com/hyperformant/vibecarbon"
