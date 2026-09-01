# wal-g (static)

Static musl-safe wal-g `pg` binary, built from the pinned upstream source
tag with `CGO_ENABLED=0` (lz4-only: no brotli/libsodium/lzo, which is all
vibecarbon's backup config uses). Published to `ghcr.io/hyperformant/wal-g`,
tagged with the wal-g version (e.g. `3.0.9`), multi-arch (amd64 + arm64 —
the compose path builds `carbon/db/Dockerfile` on dev machines too, Apple
Silicon included).

Consumed via `COPY --from` by:

- `carbon/db/Dockerfile` — compose path, built on target servers and dev machines
- `docker/postgres-walg/Dockerfile` — k8s path, pre-published

Version changes happen in lockstep with `src/lib/images.js` (`DB_IMAGE_TAG`
suffix) and both consumers — guarded by
`tests/unit/deploy/walg-dockerfile-arch.test.ts`.

Published by `.github/workflows/publish-db-image.yml` (the wal-g job runs
before the db-image job, which `COPY --from`s this image). The ghcr package
must stay **public** — target servers pull it anonymously during compose
builds.
