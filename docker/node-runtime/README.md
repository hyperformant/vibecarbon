# ghcr.io/hyperformant/node-runtime (Alpine + the node binary)

The base every vibecarbon app image runs on. `carbon/Dockerfile` builds the app
in a `node:` builder stage, then its runner stage is `FROM ${RUNTIME_IMAGE}`,
whose default is `NODE_RUNTIME_IMAGE` from `src/lib/images.js`, byte for byte
(`tests/unit/deploy/image-digest-census.test.ts`).

What it holds, on `alpine:<minor>` pinned by digest:

- the `node` binary, copied from the official `node:<major>-alpine<minor>`
  image (pinned by digest, the same alpine minor, or the binary hits a
  musl/libstdc++ mismatch);
- `libstdc++`, which that binary links against;
- the unprivileged `hono` user and group, uid/gid 1001 (the app's
  `USER hono`).

No npm, corepack or yarn: apps are built in their own builder stage. The
image does not set `USER`, so the app's Dockerfile can still `RUN` as root
before its own `USER hono`.

Why it is published rather than built per app: every app image shares these
layers, so a server pulls them from ghcr at datacenter speed once and the
deploy ships only the app's own layers from the operator's machine.

Published for **linux/amd64 and linux/arm64** by
`.github/workflows/publish-node-runtime-image.yml` on merge to main, each arch
built natively through `native-multiarch-image.yml` and smoke-tested with
`.github/scripts/smoke-node-runtime-image.sh` (node runs, `hono` is 1001, no
npm) before it is pushed. Servers pull the amd64 child; arm64 is for local
builds on Apple Silicon.

**The package must be PUBLIC.** ghcr creates a new package private, so after
the workflow's first run on main, set `node-runtime`'s visibility to public by
hand (package settings, Change visibility). Until then nothing can pull it
anonymously, and `release.yml` refuses to cut a release.

## After the first publish (and after every new revision)

A new tag is pinned by tag alone, because its digest does not exist until the
workflow runs on main. A tag can be moved by anyone who can push the package,
so `release.yml` refuses to release until the ref also names the digest.
Once the tag is published and public:

```bash
DOCKER_CONFIG=$(mktemp -d) docker buildx imagetools inspect \
  ghcr.io/hyperformant/node-runtime:<tag> --format '{{json .Manifest}}' | jq -r .digest
```

Append `@<that digest>` to `NODE_RUNTIME_IMAGE` in `src/lib/images.js` and to
`carbon/Dockerfile`'s `ARG RUNTIME_IMAGE=` (the census keeps the two equal),
in one commit. The release gate then checks, anonymously, that the tag still
resolves to exactly that digest. A new revision drops the digest again until
its own tag is published.

## Tag scheme and bumping

`<NODE_MAJOR>-alpine<ALPINE_MINOR>-r<N>`, e.g. `24-alpine3.24-r1`, the same
shape as the db image's. The first two parts name this Dockerfile's pins
(`tests/unit/lib/node-version-pins.test.ts`); `-r<N>` is OUR revision.

A tag is published once and never moved, because any machine that already
holds it never sees a republish. So any change to this directory's inputs
(every file but this README: the node digest, the alpine digest, the packages,
the user) is a new revision. `tests/unit/deploy/node-runtime-image-fingerprint.test.ts`
enforces it: it hashes the inputs and compares with `NODE_RUNTIME_INPUTS_SHA256`,
printing the new hash when they differ. A bump is:

1. edit `docker/node-runtime/Dockerfile`;
2. in `src/lib/images.js`, move `NODE_RUNTIME_IMAGE`'s `-r<N>` (dropping any
   `@sha256:`) and paste the printed `NODE_RUNTIME_INPUTS_SHA256`. The test
   also compares the pair with the last commit: a new hash under the old tag
   fails;
3. copy the new `NODE_RUNTIME_IMAGE` into `carbon/Dockerfile`'s
   `ARG RUNTIME_IMAGE=` (the census fails until they are equal);
4. after merge and publish, pin the digest as above.

A Node major comes from `.nvmrc`: `pnpm node:sync` rewrites this Dockerfile's
major and both copies of the tag, resetting the revision to `-r1`; then paste
the new hash. Dependabot's `node-runtime` group proposes digest moves here; its
PR is red until steps 2 and 3 land in it. carbon/Dockerfile's `NODE_IMAGE` must
be the same digest as this Dockerfile's (the app is built with the node it runs
on), so move both in that PR. Dependabot never touches carbon's
`ARG RUNTIME_IMAGE=`: `src/lib/images.js` owns that ref.

## Testing an unpublished tag

```bash
pnpm node-runtime:build-local    # builds this directory, tags it NODE_RUNTIME_IMAGE
```

`docker build` and `docker compose build` (so `vibecarbon up` and a local
deploy build) then find the tag in the local image store and never contact the
registry. Nothing is pushed. The local image shadows the published one under
the same tag until you remove it:

```bash
pnpm node-runtime:remove-local
```

A server cannot see your local image: a deploy that builds or pulls on the
server needs the tag published (and public) first.
