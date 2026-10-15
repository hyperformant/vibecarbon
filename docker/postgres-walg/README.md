# ghcr.io/hyperformant/postgres (official postgres Alpine + pg_cron + wal-g)

vibecarbon's one database image. Every mode pulls it: compose and compose-ha
servers, k8s and k8s-ha nodes, and local `vibecarbon up`. Nothing builds a db
image on a server or a developer machine.

What it adds to the official `postgres:<major>.<minor>-alpine<alpine>` image,
pinned by digest:

- **pg_cron**, compiled in a builder stage from a pinned upstream release tag
  (tarball checksum verified by `ADD --checksum`). Only the shared library and
  the extension's control and SQL files reach the final image; no toolchain.
- **wal-g**, the static binary from `ghcr.io/hyperformant/wal-g` (see
  `docker/wal-g/`), for WAL archiving, base backups and restore.
- **`/etc/postgresql/postgresql.conf`**, the baked server config
  (`postgresql.conf` here). Deploys start postgres with
  `-c config_file=/etc/postgresql/postgresql.conf` and pass the WAL and
  archiving settings as their own `-c` flags.
- **`db-entrypoint.sh`**, a wrapper around the official entrypoint that keeps
  WAL archiving off the init-time temporary server, so a first boot with an
  unreachable backup bucket cannot crash (the script explains why).

Published for **linux/amd64 and linux/arm64**: servers are x86-64, and arm64 is
for local development on Apple Silicon. The arm64 leg is built under QEMU,
because pg_cron is compiled inside the target platform's postgres image.

Tag scheme: `<PG_VERSION>-walg<WALG_VERSION>` e.g. `17.11-walg3.0.9`, where
`PG_VERSION` is the base image's major.minor.

The tag names the two upstream versions this image composes and nothing else,
so a change that leaves both of them alone (the OCI `LABEL` block, the baked
config, the pg_cron pin) republishes the SAME tag with a new digest unless you
move the tag yourself. Move it whenever the bits a running server uses change
(config, entrypoint, pg_cron): `DB_IMAGE_TAG` is what compose and k8s pull, and
nodes that already cached the old digest keep running it until the tag moves.
A metadata-only republish can keep the tag, since every layer is identical.

## Testing an unpublished tag locally

```bash
pnpm db-image:build-local   # builds this directory, tags it DB_IMAGE:DB_IMAGE_TAG
```

Compose's default `pull_policy: missing` then uses the local image without
contacting the registry, so a generated project's `vibecarbon up` (and
`pnpm test:docker`) run against it. Nothing is pushed.

## Bump procedure
1. Edit `Dockerfile`: both `FROM postgres:...@sha256:...` lines together (they
   must stay identical), and/or `ARG PG_CRON_VERSION` plus the `ADD --checksum`
   value, and/or the `FROM ghcr.io/hyperformant/wal-g:<v>` pin (whose version is
   set by `ARG WALG_VERSION` in `docker/wal-g/Dockerfile`; bump both).
   Resolve a new base digest with
   `docker buildx imagetools inspect postgres:<major>.<minor>-alpine<alpine>`.
2. Update `src/lib/images.js` (`DB_IMAGE_TAG`) and the pins in
   `tests/unit/deploy/walg-dockerfile-arch.test.ts`.
3. `pnpm db-image:build-local`, then `pnpm test:docker` and a generated
   project's `npm run test:db` against it.
4. Merge. `.github/workflows/publish-db-image.yml` runs on any push to main
   touching `docker/postgres-walg/**`, `docker/wal-g/**` or `src/lib/images.js`,
   builds both platforms and pushes.
5. Verify: `docker run --rm --entrypoint wal-g ghcr.io/hyperformant/postgres:<tag> --version`
   (the workflow already runs this against the published image).
