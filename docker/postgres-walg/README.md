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

Published for **linux/amd64 and linux/arm64**. Servers are amd64 only
(`src/lib/deploy/platform.js`); the arm64 child exists solely so local
`vibecarbon up` on an Apple Silicon machine runs Postgres natively, since local
dev pulls this image like every other mode.

Each arch is built **natively**, never under QEMU: the shared
`native-multiarch-image.yml` workflow (called by `publish-db-image.yml` and by
the dev channel below) runs one leg on `ubuntu-24.04` (amd64) and one on
`ubuntu-24.04-arm` (arm64). pg_cron is compiled inside that arch's own postgres
image, and before anything is pushed each leg smoke-tests the image it just
built on its own hardware with `.github/scripts/smoke-db-image.sh`:
`postgres --version`, `wal-g --version`, then an initdb into a temp dir, a
server start with the baked config (which preloads pg_cron.so), and
`CREATE EXTENSION pg_cron`. Each leg pushes by digest only; the `merge` job
then joins the two digests under the one tag with
`docker buildx imagetools create` and runs the same smoke script on the
published tag, so the tag never names a half-built image.

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

Locally, with no registry at all:

```bash
pnpm db-image:build-local   # builds this directory, tags it DB_IMAGE:DB_IMAGE_TAG
```

Compose's default `pull_policy: missing` then uses the local image without
contacting the registry, so a generated project's `vibecarbon up` (and
`pnpm test:docker`) run against it. Nothing is pushed.

The local image **shadows the registry image** under the same tag: once that
tag is published, this machine still runs your local build and never pulls the
published one, until you remove it. The build prints this reminder. When you
are done testing:

```bash
pnpm db-image:remove-local  # removes the local DB_IMAGE:DB_IMAGE_TAG; the next start pulls
```

### The dev channel

Servers pull from ghcr, so real infrastructure needs a published image. A
branch gets one without touching the release package:
`.github/workflows/publish-db-image-dev.yml` runs on every push to a branch
other than `main` that changes `docker/postgres-walg/**`, `docker/wal-g/**` or
`src/lib/images.js` (and by hand with `workflow_dispatch`), never on pull requests. It is the
release build (same native per-arch legs and smoke script) published to
**`ghcr.io/hyperformant/postgres-dev`** under

```
<DB_IMAGE_TAG>-<sha12>     e.g. 17.11-walg3.0.9-r2-0123456789ab
```

where `sha12` is the first 12 hex digits of the last commit that touched the
image inputs or `src/lib/images.js` (the READMEs excluded), so later commits that touch only other
files keep pointing at the same build. A dev tag is never rebuilt or moved. A push that does not trigger the
workflow (history rewritten with the same inputs) needs it run by hand:
`gh workflow run publish-db-image-dev.yml --ref <branch>`.
If the branch changed `docker/wal-g`, the same run builds wal-g too (natively
per arch, like the release, tagged `walg-<sha12>` in `postgres-dev`) and the db
image consumes that build by digest; otherwise it uses the published wal-g.
`cleanup-db-image-dev.yml` deletes `postgres-dev` versions older than 14 days.

Finding the tag: the workflow run's summary prints it (`dev tag ...`), or
compute it from your checkout:

```bash
git log -1 --format=%H HEAD -- docker/postgres-walg docker/wal-g src/lib/images.js \
  ':(exclude)docker/postgres-walg/README.md' ':(exclude)docker/wal-g/README.md' | cut -c1-12
```

Selecting it: nothing picks the dev channel by default. `VIBECARBON_DB_IMAGE`
(a full `repo:tag`) replaces the release pin in the one resolver every mode
uses (`resolveDbImage` in `src/lib/images.js`): `create`, `upgrade`, every
deploy bundle, k8s, and local `vibecarbon up` / `pnpm dev`. Each command
warns `using dev db image <ref>; not for production` while it is set. Unset
it and the next `upgrade` or deploy is back on the release pin.

```bash
export VIBECARBON_DB_IMAGE=ghcr.io/hyperformant/postgres-dev:<DB_IMAGE_TAG>-<sha12>
vibecarbon up                 # locally
vibecarbon deploy staging     # on real infrastructure
```

The real-infra e2e harness picks it for you: with `VIBECARBON_DB_IMAGE`
unset and the release tag not on ghcr, `pnpm test:e2e*` (and
`scripts/iter-step.js`) look up the dev tag for HEAD and set the variable for
the run, or stop at once if it is not published yet or the image inputs have
uncommitted changes (`tests/e2e/utils/db-image-select.js`).

One-time setup: the first dev publish creates the `postgres-dev` package as
private. Flip it public by hand in the org's package settings, as with every
ghcr package here, so servers and the harness pull it without credentials.

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
4. Push the branch and test on the dev channel (above), then merge.
   `.github/workflows/publish-db-image.yml` runs on any push to main
   touching `docker/postgres-walg/**`, `docker/wal-g/**` or `src/lib/images.js`,
   builds and smoke-tests each platform natively, then pushes the tag.
5. Verify: `docker run --rm --entrypoint wal-g ghcr.io/hyperformant/postgres:<tag> --version`
   (the workflow already runs this against the published image).
