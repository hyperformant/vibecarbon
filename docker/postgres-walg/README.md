# ghcr.io/hyperformant/postgres (supabase/postgres + wal-g)

Pre-published for **linux/amd64 only**. Built once per version; k8s deploys
PULL it (compose builds `carbon/db/` instead — it never pulls this).

vibecarbon standardizes on x86-64 servers (decision 2026-07-30), and this
image's only consumer is the supabase db pod on a k3s node. Arch handling
lives one level down since the PG17 move: the wal-g binary comes from the
multi-arch `ghcr.io/hyperformant/wal-g` image (see `docker/wal-g/`), so
docker resolves the right platform per build — there is no `TARGETARCH`
plumbing left in this Dockerfile or `carbon/db/Dockerfile` (which IS built
on arm64 hosts during local development).

Tag scheme: `<PG_VERSION>-walg<WALG_VERSION>` e.g. `17.6.1.167-walg3.0.9`.

The tag names the two upstream versions this image composes and nothing else,
so a change that leaves both of them alone — the OCI `LABEL` block at the
bottom of the `Dockerfile`, for instance — republishes the SAME tag with a new
digest. That is deliberate here, and it is the opposite of the rule for
`carbon-autoscaler` (whose tag is a version of OUR code, so any content change
must move it; see `src/lib/images.js`). The reason for the asymmetry is cost:
`DB_IMAGE_TAG` is substituted into the supabase Helm values, so moving it
changes the db StatefulSet's image and restarts PostgreSQL on every existing
cluster's next `vibecarbon deploy`. Trading a database restart for a package-page
edit is a bad deal. Layers are untouched by a metadata-only republish, so a node
that already cached the old digest keeps running identical bits.

## Bump procedure
1. Edit `Dockerfile` (base `FROM` and/or the `FROM ghcr.io/hyperformant/wal-g:<v>`
   pin — whose version is set by `ARG WALG_VERSION` in `docker/wal-g/Dockerfile`;
   bump all three together, plus the same pin in `carbon/db/Dockerfile`).
2. Update `src/lib/images.js` (`DB_IMAGE_TAG`).
3. Push a commit touching `docker/postgres-walg/**` or `src/lib/images.js`;
   `.github/workflows/publish-db-image.yml` builds amd64 and pushes.
4. Verify: `docker run --rm --entrypoint wal-g ghcr.io/hyperformant/postgres:<tag> --version`
   (the workflow already runs this against the published image).
5. To sanity-check the arm64 build path without publishing it:
   `docker buildx build --platform linux/arm64 docker/postgres-walg` — this
   is what local dev on an Apple Silicon Mac exercises via `carbon/db/`.
