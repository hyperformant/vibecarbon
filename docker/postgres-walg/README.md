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

Tag scheme: `<PG_VERSION>-walg<WALG_VERSION>-r<N>` e.g. `17.11-walg3.0.9-r1`,
where `PG_VERSION` is the base image's major.minor and `-r<N>` is OUR revision.

The revision exists because every consumer pulls with "only if missing"
semantics (compose `pull_policy: missing`, k8s `IfNotPresent`): a republish
under an unchanged tag never reaches a server that already has that tag, so
it would keep running the old bits. Any change to this image's own inputs (the
`Dockerfile`, `db-entrypoint.sh`, `postgresql.conf`, the pg_cron pin) must move
`-r<N>`. `tests/unit/deploy/db-image-fingerprint.test.ts` enforces it: it hashes
every file here except this README and compares with `DB_IMAGE_INPUTS_SHA256` in
`src/lib/images.js`, failing with "image inputs changed: bump the -r revision
and update the hash" (and printing the new hash). Bumping is a deliberate
two-line edit in `src/lib/images.js`. When the PostgreSQL or wal-g version
moves, reset the revision to `-r1`. Editing only this README never requires a
new tag.

## Testing an unpublished tag

Locally:

```bash
pnpm db-image:build-local   # builds this directory, tags it DB_IMAGE:DB_IMAGE_TAG
```

Compose's default `pull_policy: missing` then uses the local image without
contacting the registry, so a generated project's `vibecarbon up` (and
`pnpm test:docker`) run against it. Nothing is pushed.

On real infrastructure (a deploy or an e2e scenario), servers pull from ghcr,
so the tag has to exist there first. The only way to get it there before merge
is running `publish-db-image.yml` from the branch with `workflow_dispatch`.
That IS a publish: it pushes a public image under a tag every future deploy
may pull, so ask Brandon before running it.

## Bump procedure
1. Edit `Dockerfile`: both `FROM postgres:...@sha256:...` lines together (they
   must stay identical), and/or `ARG PG_CRON_VERSION` plus the `ADD --checksum`
   value, and/or the `FROM ghcr.io/hyperformant/wal-g:<v>` pin (whose version is
   set by `ARG WALG_VERSION` in `docker/wal-g/Dockerfile`; bump both).
   Resolve a new base digest with
   `docker buildx imagetools inspect postgres:<major>.<minor>-alpine<alpine>`.
2. Update `src/lib/images.js`: `DB_IMAGE_TAG` (new versions, or the next `-r<N>`
   for a change of our own) and `DB_IMAGE_INPUTS_SHA256` (the fingerprint test
   prints the value). Update the pins in
   `tests/unit/deploy/walg-dockerfile-arch.test.ts` if a version moved.
3. `pnpm db-image:build-local`, then `pnpm test:docker` and a generated
   project's `npm run test:db` against it.
4. Merge. `.github/workflows/publish-db-image.yml` runs on any push to main
   touching `docker/postgres-walg/**`, `docker/wal-g/**` or `src/lib/images.js`,
   builds both platforms and pushes.
5. Verify: `docker run --rm --entrypoint wal-g ghcr.io/hyperformant/postgres:<tag> --version`
   (the workflow already runs this against the published image).
