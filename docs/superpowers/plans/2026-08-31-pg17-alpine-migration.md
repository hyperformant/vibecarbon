# PG17/Alpine supabase-postgres Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move both wal-g database images from `supabase/postgres:15.8.1.085` (Ubuntu 20.04/glibc, PG15) to `supabase/postgres:17.6.1.167` (Alpine/musl + Nix, PG17), with wal-g v3.0.9 delivered as a static binary from a new vibecarbon-published image.

**Architecture:** One new binary-only image (`docker/wal-g/`) compiles wal-g v3.0.9 statically (CGO off → runs on musl) and publishes to ghcr; both consumer Dockerfiles (`carbon/db/` for compose — built on user servers and dev machines — and `docker/postgres-walg/` for k8s) switch to `COPY --from` that image instead of curling upstream's glibc release tarballs. This retires the glibc-matching RCA guard and the upstream asset-rename BUMP TRAP in one move.

**Tech Stack:** Docker multi-stage builds, Go 1.26 (wal-g build), vitest guards, GitHub Actions (ghcr publish), hetzner/digitalocean e2e.

**Spec:** Inline below (this migration was designed in-session 2026-08-31; no separate spec doc).

## Spec (inline)

- Base image becomes `supabase/postgres:17.6.1.167@sha256:6942962433a569e87f228b4d4ab7e11db5deca64e43babb3a038443ad6c4f1bb` in both consumer Dockerfiles. Verified upstream facts: image is Alpine + Nix store (production stage `FROM alpine` in supabase/postgres `Dockerfile-supabase`, built via their dockerhub-release-matrix); 353MB compressed vs 649MB for the old pin; ships wal-g *scaffolding* (wal-g user, `/etc/postgresql-custom/wal-g.conf` include, helper scripts) but NOT the binary; supabase pairs PG17 with wal-g v3.0.9 in their own nix packaging (`nix/packages/wal-g.nix`, INDATA-904).
- wal-g v3.0.9 static build: our config uses only lz4 compression (pure Go) and no libsodium/PGP, so `CGO_ENABLED=0` with no build tags covers everything. Upstream Makefile facts (v3.0.9): `export GOEXPERIMENT=jsonv2` (required — wal-g 3.x imports `encoding/json/v2`); build is `cd main/pg && go build -tags "" -ldflags "-s -w -X github.com/wal-g/wal-g/cmd/pg.walgVersion=..."`. Release tarballs have no `vendor/`, so build with plain module downloads, NOT `-mod vendor`.
- **Breaking change, approved by Brandon 2026-08-31: "new environments only."** Existing deployed environments cannot redeploy onto PG17 (PGDATA 15 format) and PG15 wal-g backups cannot restore into PG17. Commit footer must carry `BREAKING CHANGE:` and release notes must say existing environments stay on their deployed image.
- k8s pulls `ghcr.io/hyperformant/postgres:<tag>` (amd64-only publish, unchanged); compose builds `carbon/db/Dockerfile` on the target server AND on dev machines (incl. Apple Silicon), so the wal-g image must be multi-arch (amd64+arm64) and publicly pullable.
- e2e certification: compose legs are currently red on an UNRELATED hetzner ACME DNS-01 issue (issue #14), so certify compose/compose-ha on digitalocean and k8s/k8s-ha on hetzner.

## Global Constraints

- Base pin (both consumers): `supabase/postgres:17.6.1.167@sha256:6942962433a569e87f228b4d4ab7e11db5deca64e43babb3a038443ad6c4f1bb`
- wal-g version: `v3.0.9`; image `ghcr.io/hyperformant/wal-g:3.0.9`
- DB image tag: `17.6.1.167-walg3.0.9` (scheme `<PG_VERSION>-walg<WALG_VERSION>`, `src/lib/images.js` is the source of truth)
- `wal-g --version` must EXECUTE in-build in every image that contains the binary (the only place a broken binary fails loudly — deploy only asserts `archive_mode=on`)
- No hardcoded arch in any download URL or build (repo-wide guard); cross-compile via `GOARCH=$TARGETARCH`
- Shared-checkout hygiene: work in an isolated worktree; commit with pathspecs
- Follow [[running-tests]] for tiers; [[running-e2e-matrix]] for e2e

---

### Task 1: Rewrite the wal-g Dockerfile guards (failing first)

**Files:**
- Modify: `tests/unit/deploy/walg-dockerfile-arch.test.ts` (full rewrite of the two describe blocks; keep `findDockerfiles`/`logicalInstructions` helpers)

**Interfaces:**
- Produces: guard invariants that Tasks 2–4 must satisfy: (a) `docker/wal-g/Dockerfile` exists, pins `ARG WALG_VERSION=v3.0.9`, sets `CGO_ENABLED=0` and `GOEXPERIMENT=jsonv2`, uses `GOARCH` from `TARGETARCH`, and executes `wal-g --version`; (b) both consumer Dockerfiles `COPY --from=ghcr.io/hyperformant/wal-g:3.0.9` and execute `wal-g --version` in a RUN layer; (c) both consumers are `FROM supabase/postgres:17.6.1.167`; (d) the Dockerfile census includes `docker/wal-g/Dockerfile`.

- [ ] **Step 1: Rewrite the guard test.** Replace the `describe.each(WALG_DOCKERFILES)` block and the census list with:

```typescript
const WALG_VERSION = 'v3.0.9';
const WALG_IMAGE = `ghcr.io/hyperformant/wal-g:${WALG_VERSION.slice(1)}`;
const PG_BASE = 'supabase/postgres:17.6.1.167';

const WALG_BUILDER = join('docker', 'wal-g', 'Dockerfile');
const WALG_CONSUMERS = [
  join('carbon', 'db', 'Dockerfile'),
  join('docker', 'postgres-walg', 'Dockerfile'),
];

describe('docker/wal-g/Dockerfile builds wal-g static (musl-safe)', () => {
  const dockerfile = readFileSync(join(ROOT, WALG_BUILDER), 'utf-8');
  const instructions = logicalInstructions(dockerfile);
  const buildLayer = instructions.find((i) => /^RUN\b/.test(i) && i.includes('go build')) ?? '';

  it('pins the wal-g version as an ARG', () => {
    expect(dockerfile).toMatch(new RegExp(`^ARG WALG_VERSION=${WALG_VERSION}\\s*$`, 'm'));
  });

  it('builds with CGO disabled — a static binary is the musl guard (replaces RCA 2026-05-30 glibc pin)', () => {
    expect(buildLayer).toContain('CGO_ENABLED=0');
  });

  it('sets GOEXPERIMENT=jsonv2 (wal-g 3.x imports encoding/json/v2)', () => {
    expect(dockerfile).toMatch(/GOEXPERIMENT=jsonv2/);
  });

  it('cross-compiles from TARGETARCH instead of hardcoding an arch', () => {
    expect(dockerfile).toMatch(/^ARG TARGETARCH\s*$/m);
    expect(buildLayer).toMatch(/GOARCH=\$\{?TARGETARCH\}?/);
  });

  it('EXECUTES the binary in-build so a broken build fails loudly', () => {
    const execLayer = instructions.find((i) => /^RUN\b/.test(i) && /wal-g --version/.test(i));
    expect(execLayer, 'no RUN layer executes wal-g --version').toBeTruthy();
  });
});

describe.each(WALG_CONSUMERS)('%s takes wal-g from the published static image', (relPath) => {
  const dockerfile = readFileSync(join(ROOT, relPath), 'utf-8');
  const instructions = logicalInstructions(dockerfile);

  it(`is FROM ${PG_BASE} (Alpine/Nix base) by digest`, () => {
    expect(dockerfile).toMatch(
      new RegExp(`^FROM ${PG_BASE.replace(/[/.]/g, '\\$&')}@sha256:[0-9a-f]{64}`, 'm'),
    );
  });

  it(`COPYies the binary from the pinned ${WALG_IMAGE} stage`, () => {
    expect(dockerfile).toContain(`FROM ${WALG_IMAGE}`);
    expect(instructions.some((i) => /^COPY --from=walg\b/.test(i) && i.includes('/usr/local/bin/wal-g'))).toBe(true);
  });

  it('EXECUTES wal-g --version so an incompatible binary fails the build, not the backups', () => {
    expect(instructions.some((i) => /^RUN\b/.test(i) && /wal-g --version/.test(i))).toBe(true);
  });

  it('has no apt-get and no curl of upstream release assets (Alpine base; BUMP TRAP retired)', () => {
    expect(dockerfile).not.toMatch(/apt-get/);
    expect(dockerfile).not.toMatch(/wal-g\/wal-g\/releases/);
  });
});
```

In the repo-wide census `it('knows about every Dockerfile in the repo')`, add `join('docker', 'wal-g', 'Dockerfile')` to the expected array. Keep the `fetches no hardcoded-arch release asset` sweep unchanged. Update the file's header comment to describe the new invariants (static build + single build point + in-build execution) instead of the glibc/asset-name story.

- [ ] **Step 2: Run and verify the new guards fail** (old Dockerfiles still present):

Run: `pnpm test:unit tests/unit/deploy/walg-dockerfile-arch.test.ts`
Expected: FAIL — `docker/wal-g/Dockerfile` missing (census + builder describe), consumers not FROM 17.6.1.167.

- [ ] **Step 3: Commit**

```bash
git commit -m "test(walg): rewrite Dockerfile guards for static-musl wal-g on PG17 base" -- tests/unit/deploy/walg-dockerfile-arch.test.ts
```

---

### Task 2: New static wal-g builder image (`docker/wal-g/`)

**Files:**
- Create: `docker/wal-g/Dockerfile`
- Create: `docker/wal-g/README.md`

**Interfaces:**
- Produces: image `ghcr.io/hyperformant/wal-g:3.0.9` containing exactly `/usr/local/bin/wal-g` (static, amd64+arm64), consumed by Tasks 3–4 via `COPY --from`.

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1
# Static wal-g, built ONCE and published to ghcr.io/hyperformant/wal-g —
# the single build point for the binary both database images copy in
# (carbon/db/Dockerfile and docker/postgres-walg/Dockerfile).
#
# WHY BUILD FROM SOURCE: supabase/postgres 17.x is Alpine/musl; upstream
# wal-g releases are glibc-only (the alpine variant was retired upstream in
# 2026-04). Our config uses lz4 compression (pure Go) and no libsodium/PGP,
# so CGO_ENABLED=0 with no build tags produces a fully static binary that
# runs on musl and glibc alike. This also retires the release-asset BUMP
# TRAP (upstream renamed assets in v3.0.8) — we pin a source tag instead.
#
# Cross-compile on the BUILD platform (no QEMU): Go targets TARGETARCH
# directly, so the multi-arch publish is two `go build`s, not emulation.
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build
RUN apk add --no-cache git
ARG WALG_VERSION=v3.0.9
RUN git clone --depth 1 --branch "${WALG_VERSION}" https://github.com/wal-g/wal-g.git /src
WORKDIR /src
ARG TARGETARCH
# GOEXPERIMENT=jsonv2: wal-g 3.x imports encoding/json/v2 directly
# (internal/uploader.go) — the build fails without it. Same ldflags -X
# pins upstream's Makefile uses, so `wal-g --version` reports honestly.
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} GOEXPERIMENT=jsonv2 \
    go build -C main/pg -tags "" \
      -ldflags "-s -w -X github.com/wal-g/wal-g/cmd/pg.walgVersion=${WALG_VERSION}" \
      -o /out/wal-g

# Native-arch smoke stage: actually EXECUTE the binary. The build stage
# above runs on BUILDPLATFORM and may have cross-compiled, so the exec has
# to happen in a TARGETPLATFORM stage. A wrong-arch or dynamically-linked
# binary fails HERE, in the build — not silently in archive_command later.
FROM alpine:3.24 AS smoke
COPY --from=build /out/wal-g /usr/local/bin/wal-g
RUN wal-g --version

FROM scratch
COPY --from=smoke /usr/local/bin/wal-g /usr/local/bin/wal-g
```

- [ ] **Step 2: Write `docker/wal-g/README.md`**

```markdown
# wal-g (static)

Static musl-safe wal-g `pg` binary, built from the pinned upstream source
tag with `CGO_ENABLED=0` (lz4-only: no brotli/libsodium/lzo, which is all
vibecarbon's backup config uses). Published to `ghcr.io/hyperformant/wal-g`,
tagged with the wal-g version (e.g. `3.0.9`), multi-arch (amd64 + arm64).

Consumed via `COPY --from` by:
- `carbon/db/Dockerfile` — compose path, built on target servers and dev machines
- `docker/postgres-walg/Dockerfile` — k8s path, pre-published

Version changes happen in lockstep with `src/lib/images.js` (`DB_IMAGE_TAG`
suffix) and both consumers — guarded by
`tests/unit/deploy/walg-dockerfile-arch.test.ts`.
```

- [ ] **Step 3: Build and smoke it locally** (amd64 host):

Run: `docker build -t ghcr.io/hyperformant/wal-g:3.0.9 docker/wal-g/`
Expected: build succeeds; the `smoke` stage prints `wal-g version v3.0.9 ...`.
Then: `docker build --platform linux/arm64 -t walg-arm64-check docker/wal-g/ --target build` — cross-compile must also succeed (skip the smoke stage: it can't exec arm64 on this host).

- [ ] **Step 4: Run the Task 1 guards** — builder describe should now pass, consumer describes still fail:

Run: `pnpm test:unit tests/unit/deploy/walg-dockerfile-arch.test.ts`
Expected: builder + census assertions pass; consumer assertions still FAIL.

- [ ] **Step 5: Commit**

```bash
git add docker/wal-g/
git commit -m "feat(walg): static musl wal-g v3.0.9 builder image — single build point for both db images" -- docker/wal-g/
```

---

### Task 3: Rewrite `docker/postgres-walg/Dockerfile` (k8s image)

**Files:**
- Modify: `docker/postgres-walg/Dockerfile` (full rewrite)
- Modify: `docker/postgres-walg/README.md` (tag scheme example line)

**Interfaces:**
- Consumes: `ghcr.io/hyperformant/wal-g:3.0.9` (Task 2)
- Produces: `ghcr.io/hyperformant/postgres:17.6.1.167-walg3.0.9` for k8s deploys (values placeholder `{{DB_IMAGE}}:{{DB_IMAGE_TAG}}`)

- [ ] **Step 1: Rewrite the Dockerfile.** Replace everything above the `LABEL` block with:

```dockerfile
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
# src/lib/images.js's DB_IMAGE_TAG suffix.
FROM ghcr.io/hyperformant/wal-g:3.0.9 AS walg

FROM supabase/postgres:17.6.1.167@sha256:6942962433a569e87f228b4d4ab7e11db5deca64e43babb3a038443ad6c4f1bb

COPY --from=walg /usr/local/bin/wal-g /usr/local/bin/wal-g
# The load-bearing exec: deploy only asserts archive_mode=on, never that
# wal-g runs, so this is the only place a broken binary fails loudly.
RUN wal-g --version
```

Keep the existing `LABEL` block (OCI metadata) verbatim — its prose already names no versions by design.

- [ ] **Step 2: Update `docker/postgres-walg/README.md:13`** — tag scheme example: `` Tag scheme: `<PG_VERSION>-walg<WALG_VERSION>` e.g. `17.6.1.167-walg3.0.9`. ``

- [ ] **Step 3: Build locally** (the Task 2 image is in the local cache under its ghcr name, so `COPY --from` resolves without a pull):

Run: `docker build -t ghcr.io/hyperformant/postgres:17.6.1.167-walg3.0.9 docker/postgres-walg/`
Expected: build succeeds, `wal-g --version` prints v3.0.9.
Then prove postgres itself: `docker run --rm ghcr.io/hyperformant/postgres:17.6.1.167-walg3.0.9 postgres --version`
Expected: `postgres (PostgreSQL) 17.x`.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(db-image): k8s postgres image onto supabase PG17 Alpine base, static wal-g v3.0.9" -- docker/postgres-walg/
```

---

### Task 4: Rewrite `carbon/db/Dockerfile` (compose image)

**Files:**
- Modify: `carbon/db/Dockerfile` (full rewrite)

**Interfaces:**
- Consumes: `ghcr.io/hyperformant/wal-g:3.0.9` — pulled from ghcr at build time on the user's server/dev machine (multi-arch, must be public; see Task 8)

- [ ] **Step 1: Rewrite the Dockerfile:**

```dockerfile
# syntax=docker/dockerfile:1
# supabase/postgres + wal-g for the compose path. This image IS the backup
# tooling (wal-g runs co-located with PGDATA for continuous WAL archiving,
# base backups, and restore — no separate backup image).
#
# ARCH: this Dockerfile is built ON THE TARGET SERVER by the compose path
# (`build: ./db` in docker-compose.yml) and on dev machines (incl. Apple
# Silicon). The wal-g image below is multi-arch (amd64+arm64), so docker
# resolves the right platform automatically — no TARGETARCH plumbing here.
#
# The base moved to supabase's Alpine/Nix image at PG17 (353MB compressed
# vs 649MB for the Ubuntu-era 15.x pin — a real win when every server
# pulls it). The Nix postgres carries its own libc and the wal-g binary is
# fully static, so the RCA 2026-05-30 glibc matching and the upstream
# release-asset BUMP TRAP are both retired; wal-g comes from vibecarbon's
# single build point (docker/wal-g/ → ghcr.io/hyperformant/wal-g),
# version-locked with docker/postgres-walg/Dockerfile and
# src/lib/images.js. Guarded by tests/unit/deploy/walg-dockerfile-arch.test.ts.
FROM ghcr.io/hyperformant/wal-g:3.0.9 AS walg

FROM supabase/postgres:17.6.1.167@sha256:6942962433a569e87f228b4d4ab7e11db5deca64e43babb3a038443ad6c4f1bb

COPY --from=walg /usr/local/bin/wal-g /usr/local/bin/wal-g
# The load-bearing exec: deploy only asserts archive_mode=on, never that
# wal-g runs, so this is the only place a broken binary fails loudly.
RUN wal-g --version
```

- [ ] **Step 2: Run the Task 1 guards — all green now:**

Run: `pnpm test:unit tests/unit/deploy/walg-dockerfile-arch.test.ts`
Expected: PASS (all describes).

- [ ] **Step 3: Build locally:**

Run: `docker build -t carbondb-pg17-check carbon/db/`
Expected: succeeds; `wal-g --version` prints v3.0.9.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(template): compose db image onto supabase PG17 Alpine base, static wal-g v3.0.9" -- carbon/db/Dockerfile
```

---

### Task 5: Version constants, prepull pin, and stale comments

**Files:**
- Modify: `src/lib/images.js:14` (`DB_IMAGE_TAG`)
- Modify: `tests/unit/lib/images.test.ts:7-8`
- Modify: `tests/unit/deploy/k3s-prepull-images.test.ts:43` (tag fixture)
- Modify: `carbon/k8s/values/supabase.values.yaml` (~line 58: comment "wal-g v3.0.5" → "wal-g v3.0.9")
- Modify: `carbon/docker-compose.yml:185` (hot_standby comment)

**Interfaces:**
- Produces: `DB_IMAGE_TAG = '17.6.1.167-walg3.0.9'` — deploys and the publish workflow both read this.

- [ ] **Step 1: Update the images test first:**

```typescript
expect(DB_IMAGE_TAG).toBe('17.6.1.167-walg3.0.9');
expect(dbImageRef()).toBe('ghcr.io/hyperformant/postgres:17.6.1.167-walg3.0.9');
```

Run: `pnpm test:unit tests/unit/lib/images.test.ts` — Expected: FAIL (constant still 15.x).

- [ ] **Step 2: Update `src/lib/images.js`:** `export const DB_IMAGE_TAG = '17.6.1.167-walg3.0.9';` and the JSDoc example on line 16. Update the `k3s-prepull-images.test.ts` fixture tag `15.8.1.085` → `17.6.1.167-walg3.0.9` (read the test first; keep its intent — it pins what k3s pre-pulls).

- [ ] **Step 3: Fix the two stale comments.** `carbon/docker-compose.yml:185`: the claim "PG15 default is on, but supabase/postgres:15.8.1.085 ships with it off" becomes "PG default is on, but supabase's image config has shipped it off (seen on 15.8.1.085), so set it explicitly" — the explicit `-c hot_standby=on` stays regardless (cheap insurance, no-op on primaries). `supabase.values.yaml` comment: "wal-g v3.0.5" → "wal-g v3.0.9".

- [ ] **Step 4: Run: `pnpm test:unit`** — Expected: images + prepull + walg guards all PASS; only doc-fact-census may still be red (fixed in Task 6).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(deploy): db image ref → 17.6.1.167-walg3.0.9; refresh version-coupled comments" -- src/lib/images.js tests/unit/lib/images.test.ts tests/unit/deploy/k3s-prepull-images.test.ts carbon/k8s/values/supabase.values.yaml carbon/docker-compose.yml
```

---

### Task 6: Docs — PostgreSQL version claims

**Files:**
- Modify: `docs/technical.md:16` (`PostgreSQL 15` → `PostgreSQL 17`)
- Modify: `carbon/README.md:71` (`db · PostgreSQL 15` → `db · PostgreSQL 17`)

- [ ] **Step 1: Make both edits.** Then sweep for stragglers: `grep -rn 'PostgreSQL 15\|Postgres 15' docs/ carbon/ README.md --include='*.md'` — fix any hit that claims the shipped version (leave historical/changelog prose alone).

- [ ] **Step 2: Run: `pnpm test:unit tests/unit/docs/doc-fact-census.test.ts`** — Expected: PASS ("every claimed framework major on a SURFACE matches the real dependency" — the census reads `carbon/db/Dockerfile`'s FROM, now 17.x).

- [ ] **Step 3: Commit**

```bash
git commit -m "docs: PostgreSQL 15 → 17 on all claim surfaces" -- docs/technical.md carbon/README.md
```

---

### Task 7: Publish workflow — wal-g image job + ordering

**Files:**
- Modify: `.github/workflows/publish-db-image.yml`

**Interfaces:**
- Produces: on push to main touching `docker/wal-g/**` or `docker/postgres-walg/**` (or dispatch), publishes `ghcr.io/hyperformant/wal-g:3.0.9` (multi-arch) FIRST, then `ghcr.io/hyperformant/postgres:17.6.1.167-walg3.0.9` (amd64-only, unchanged policy) — the db image's `COPY --from` pulls the wal-g image, so ordering is load-bearing.

- [ ] **Step 1: Add a `publish-walg` job** before the existing `publish` job, and make `publish` `needs: publish-walg`. New job mirrors the existing job's checkout/login/build-push steps with: multi-arch `platforms: linux/amd64,linux/arm64` (add `docker/setup-qemu-action` is NOT needed — the Dockerfile cross-compiles from `$BUILDPLATFORM`; `docker/setup-buildx-action` suffices), tag resolved from the Dockerfile pin:

```yaml
  publish-walg:
    runs-on: ubuntu-latest
    environment: e2e-infra
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
      - id: ref
        name: Resolve wal-g version from docker/wal-g/Dockerfile
        run: |
          V=$(grep -oP 'ARG WALG_VERSION=v\K[0-9.]+' docker/wal-g/Dockerfile)
          echo "image=ghcr.io/hyperformant/wal-g:$V" >> "$GITHUB_OUTPUT"
```

…then the same buildx/login/push steps as the existing job, `context: docker/wal-g`, `platforms: linux/amd64,linux/arm64`, `tags: ${{ steps.ref.outputs.image }}`. Add `docker/wal-g/**` to the workflow's `paths:` trigger. Match the existing workflow's action SHAs and comment style; if the existing job's build step lacks buildx, copy its exact pattern rather than inventing one.

- [ ] **Step 2: Sanity-check the workflow parses:** `gh workflow view publish-db-image.yml` after push (or `actionlint` if available locally: `actionlint .github/workflows/publish-db-image.yml`).

- [ ] **Step 3: Commit**

```bash
git commit -m "ci(publish): build+push static wal-g image before the db image that copies from it" -- .github/workflows/publish-db-image.yml
```

---

### Task 8: Full local verification + branch publish + package visibility

**Files:** none (verification + operations)

- [ ] **Step 1: Full local gates:** `pnpm test:prepush` (lint + unit + integration), then `pnpm test:template`. Expected: all green.

- [ ] **Step 2: Push the branch, open the PR** (title `feat(db)!: PostgreSQL 17 on supabase Alpine/Nix base`, body summarizes the migration + "new environments only" stance, commit/PR footer carries `BREAKING CHANGE: existing deployed environments cannot redeploy onto PG17 (PG15 PGDATA and wal-g backups are not forward-compatible); they stay on their deployed image. New environments only.`).

- [ ] **Step 3: Publish images from the branch** so e2e can pull them before merge: `gh workflow run publish-db-image.yml --ref <branch>` (the workflow resolves versions from the branch's files; new tags, nothing clobbered). Wait for green.

- [ ] **Step 4: Make `ghcr.io/hyperformant/wal-g` public** — first publish of a new ghcr package defaults to private, and user servers pull it anonymously during compose builds. Try `gh api -X PATCH` on the package; if the API refuses visibility changes, flag to Brandon — it's a 30-second UI toggle (Package settings → Change visibility), and compose e2e legs CANNOT pass until it's done. Verify with an anonymous pull: `docker logout ghcr.io && docker pull ghcr.io/hyperformant/wal-g:3.0.9`.

---

### Task 9: E2E certification

**Files:** none (runs)

Read [[running-e2e-matrix]] first and follow it — this task only fixes the scenario/provider selection:

- [ ] **Step 1: k8s legs on hetzner** (both green on current main, so a red here is the migration): `k8s` + `k8s-ha`. This exercises: sideload/pull of the new db image, PG17 boot on the Nix entrypoint, wal-g archiving (backup step), PITR restore, and for k8s-ha the full failover + WALG_ROLE audit.

- [ ] **Step 2: compose legs on digitalocean** (hetzner compose is red on the unrelated ACME DNS-01 issue #14 — do not burn migration signal there): `compose` + `compose-ha`. This exercises the on-server `carbon/db` build (ghcr anonymous pull), hot_standby behavior on the new image, backup/restore, compose-ha failover.

- [ ] **Step 3: Triage.** Any failure in backup/restore/failover steps is presumed migration-caused until proven otherwise — RCA per the e2e skill's discipline (categorize, don't retry-ladder). Known watch-items from the design review: `hot_standby` default on the new image (compose sets it explicitly, so should be inert), `POSTGRES_USER=supabase_admin` default (same as the old image — but verify verify-deploy's 32 checks all pass), initdb migrations under the docker-library alpine entrypoint.

- [ ] **Step 4: On full green (4 legs): merge the PR.** Squash message keeps the `feat(db)!` type and `BREAKING CHANGE:` footer. NOTE for the release after merge: semantic-release will read the breaking-change footer — on a 0.x package this cuts **v1.0.0** by default. Surface this to Brandon BEFORE dispatching the release; do not dispatch without his explicit go on the version.

---

## Self-Review (done at write time)

- Spec coverage: base swap (T3/T4), static wal-g (T2), ghcr delivery incl. compose's anonymous pull (T7/T8), guards (T1), version constants (T5), docs (T6), breaking-change stance (T8/T9), e2e split around the ACME blocker (T9). No gaps found.
- Placeholders: none — all code blocks are literal.
- Type/name consistency: `ghcr.io/hyperformant/wal-g:3.0.9`, `17.6.1.167-walg3.0.9`, digest `6942…f1bb` used identically in T1–T5.
- Known open risk (not plan-blocking): whether supabase's PG17 initdb/migration set behaves identically under compose's mounted init SQL — surfaced in T9 triage list; e2e verify-deploy is the arbiter.
