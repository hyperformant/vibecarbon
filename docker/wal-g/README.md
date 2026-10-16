# wal-g (static)

Static wal-g `pg` binary, built from the pinned upstream source tag with
`CGO_ENABLED=0` (lz4-only: no brotli/libsodium/lzo, which is all vibecarbon's
backup config uses), so it runs on any libc. Published to
`ghcr.io/hyperformant/wal-g`, tagged with the wal-g version (e.g. `3.0.9`),
multi-arch (amd64 + arm64, because the db image that copies it is multi-arch).

Consumed via `COPY --from` by `docker/postgres-walg/Dockerfile`, the one db
image every mode pulls.

Version changes happen in lockstep with `src/lib/images.js` (`DB_IMAGE_TAG`
suffix) and that consumer — guarded by
`tests/unit/deploy/walg-dockerfile-arch.test.ts`.

Published by `.github/workflows/publish-db-image.yml` (the wal-g job runs
before the db-image job, which `COPY --from`s this image). Both arches build
**natively** through the same `native-multiarch-image.yml` the db image uses:
one leg on `ubuntu-24.04`, one on `ubuntu-24.04-arm`, so the Dockerfile's smoke
stage (`RUN wal-g --version`) executes on real hardware, never under QEMU or a
runner's preinstalled binfmt. Each leg also runs
`.github/scripts/smoke-walg-image.sh` before its digest is pushed. The ghcr
package must stay **public**, like every package in the org.
