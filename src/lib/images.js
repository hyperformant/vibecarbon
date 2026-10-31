/**
 * Single source of truth for the pre-published db image: the official
 * postgres Alpine image plus pg_cron, wal-g and a baked postgresql.conf
 * (docker/postgres-walg/). Built once per version by
 * .github/workflows/publish-db-image.yml for linux/amd64 and linux/arm64, and
 * PULLED by every mode: compose and compose-ha (docker-compose.yml's
 * `image: ${DB_IMAGE}:${DB_IMAGE_TAG}`, written into the project's .env by
 * create, upgrade and every deploy bundle), k8s and k8s-ha (the chart values),
 * and local `vibecarbon up` (arm64 is for Apple Silicon machines). Nothing
 * builds a db image on a server. Bumping the tag here + the Dockerfile is the
 * whole version-bump surface; `pnpm db-image:build-local` builds an
 * unpublished tag into the local Docker image store for testing.
 */
// Publish to ghcr (GitHub Container Registry) under the hyperformant org
// (this repo is hyperformant/vibecarbon). The package must be set to PUBLIC
// so servers and developer machines pull without a secret.
//
// Tag scheme: <PostgreSQL major.minor>-walg<wal-g version>-r<N>. The first two
// parts are read from the Dockerfile's pins (guarded by
// tests/unit/deploy/walg-dockerfile-arch.test.ts). -r<N> is OUR revision: it
// must move whenever this image's own inputs change (the Dockerfile,
// db-entrypoint.sh, postgresql.conf, the pg_cron pin), because compose pulls
// with policy `missing` and k8s with IfNotPresent, so a republish under an
// unchanged tag never reaches a server that already has it. Reset to -r1
// when the PostgreSQL or wal-g version moves.
export const DB_IMAGE = 'ghcr.io/hyperformant/postgres';
export const DB_IMAGE_TAG = '17.11-walg3.0.9-r3';

// sha256 fingerprint of docker/postgres-walg's inputs (every file there but
// README.md; see tests/unit/deploy/db-image-fingerprint.test.ts for the exact
// hashing). Changing any input fails that test until you bump the -r revision
// in DB_IMAGE_TAG above AND paste the new hash here: a deliberate two-line edit.
export const DB_IMAGE_INPUTS_SHA256 =
  '9e4807d6a1f02552de0e3987933411e6cbe496f930e1092ba12d4b32ac1bc09b';

/** @returns {string} e.g. "ghcr.io/hyperformant/postgres:17.11-walg3.0.9-r3" */
export function dbImageRef() {
  return `${DB_IMAGE}:${DB_IMAGE_TAG}`;
}

// The dev channel: .github/workflows/publish-db-image-dev.yml publishes every
// branch build of docker/postgres-walg here, as `${DB_IMAGE_TAG}-<sha12>`
// (see DEV_DB_IMAGE_SHA_LENGTH), and cleanup-db-image-dev.yml prunes it after
// 14 days. Nothing selects it by default: only VIBECARBON_DB_IMAGE does.
export const DEV_DB_IMAGE = 'ghcr.io/hyperformant/postgres-dev';
export const DEV_DB_IMAGE_SHA_LENGTH = 12;

/** The env var that swaps the db image for a full `repo:tag` ref (testing only). */
export const DB_IMAGE_OVERRIDE_ENV = 'VIBECARBON_DB_IMAGE';

// Where the "using dev db image" warning goes. Plain stderr by default so this
// module stays dependency-free (scripts/mirror-matrix.mjs imports it in CI
// with no node_modules); cli.js routes it through the clack logger.
/** @type {(msg: string) => void} */
let warningSink = (msg) => process.stderr.write(`warning: ${msg}\n`);
const warnedOverrides = new Set();

/** @param {(msg: string) => void} sink */
export function setDbImageWarningSink(sink) {
  warningSink = sink;
}

/** @param {string} msg */
function warnOnce(msg) {
  if (warnedOverrides.has(msg)) return;
  warnedOverrides.add(msg);
  warningSink(msg);
}

/**
 * What is wrong with VIBECARBON_DB_IMAGE, as one line, or null when it is
 * unset or a usable `repo:tag`. cli.js checks this before any command runs, so
 * a typo stops the CLI with this line instead of a stack mid-deploy.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null}
 */
export function dbImageOverrideProblem(env = process.env) {
  const raw = (env[DB_IMAGE_OVERRIDE_ENV] ?? '').trim();
  if (!raw) return null;
  return splitImageRef(raw)
    ? null
    : `${DB_IMAGE_OVERRIDE_ENV} must be a full image ref like ${DEV_DB_IMAGE}:<tag>, got "${raw}"`;
}

/**
 * Split on the last colon AFTER the last slash, so a registry port
 * (localhost:5000/x:tag) stays in the repository. A digest ref has no tag for
 * DB_IMAGE_TAG to carry, so it is refused rather than mangled.
 *
 * @param {string} raw
 * @returns {{ image: string, tag: string } | null}
 */
function splitImageRef(raw) {
  if (raw.includes('@') || /\s/.test(raw)) return null;
  const colon = raw.lastIndexOf(':');
  if (colon <= raw.lastIndexOf('/')) return null;
  const image = raw.slice(0, colon);
  const tag = raw.slice(colon + 1);
  return image && tag ? { image, tag } : null;
}

/**
 * THE db image every mode runs: create, upgrade and every deploy bundle write
 * it into .env, k8s renders it into the chart values, and local `up` hands it
 * to compose on every start (so a stale .env value never decides). Default is
 * the pinned release (DB_IMAGE:DB_IMAGE_TAG). VIBECARBON_DB_IMAGE (a full
 * `repo:tag`, e.g. a dev channel build) replaces it, and while it is set the
 * resolver warns, once per process, that this is not a production image.
 * Unset the variable and the next up, upgrade or deploy is back on the
 * release pin.
 *
 * @param {{ env?: Record<string, string | undefined>, warn?: (msg: string) => void }} [opts]
 * @returns {{ image: string, tag: string, ref: string, override: boolean }}
 */
export function resolveDbImage({ env = process.env, warn = warnOnce } = {}) {
  const raw = (env[DB_IMAGE_OVERRIDE_ENV] ?? '').trim();
  if (!raw) return { image: DB_IMAGE, tag: DB_IMAGE_TAG, ref: dbImageRef(), override: false };
  const split = splitImageRef(raw);
  if (!split) throw new Error(/** @type {string} */ (dbImageOverrideProblem(env)));
  warn(`using dev db image ${raw}; not for production`);
  return { ...split, ref: raw, override: true };
}

/**
 * The environment for every LOCAL `docker compose` run (up, down, reset, the
 * `compose ps` probes): `base` plus the db image this CLI resolves, ALWAYS.
 * The compose file requires DB_IMAGE/DB_IMAGE_TAG (`:?`), and compose ranks
 * the environment above .env for interpolation, so the CLI decides locally
 * just as the deploy bundle does on a server: a project .env that lacks the
 * pair (the carbon/ source tree's dev-init writes none) still works, and a
 * dev-channel ref a past `create` wrote while VIBECARBON_DB_IMAGE was set is
 * never run silently once the variable is gone. While it is set,
 * resolveDbImage warns.
 *
 * @param {Record<string, string | undefined>} [base]
 * @returns {Record<string, string | undefined>}
 */
export function localComposeEnv(base = process.env) {
  const { image, tag } = resolveDbImage({ env: base });
  return { ...base, DB_IMAGE: image, DB_IMAGE_TAG: tag };
}

// The node runtime base every app image builds FROM (docker/node-runtime/):
// Alpine + the node binary + libstdc++ + the `hono` user. Built once per
// revision for linux/amd64 and linux/arm64 by
// .github/workflows/publish-node-runtime-image.yml. carbon/Dockerfile's
// `ARG RUNTIME_IMAGE=` default is this exact string
// (tests/unit/deploy/image-digest-census.test.ts), so a deploy can pre-pull
// the base on a server and ship only the app's own layers. The package must
// be PUBLIC so servers and developer machines pull it without a secret.
//
// Tag scheme, the db image's: <node major>-alpine<alpine minor>-r<N>. The
// first two parts are the Dockerfile's pins
// (tests/unit/lib/node-version-pins.test.ts). -r<N> is OUR revision: it must
// move whenever docker/node-runtime changes, since a machine that already
// holds a tag never sees a republish under it.
//
// Pre-publish this is the tag alone. Once the tag is published and public,
// append its index digest (`@sha256:...`) here and in carbon/Dockerfile:
// release.yml refuses to release until both carry it and it matches what the
// tag resolves to (docker/node-runtime/README.md, "After the first publish").
//
// `pnpm node:sync` rewrites the major (resetting to -r1, digest dropped) when
// .nvmrc moves. `pnpm node-runtime:build-local` builds an unpublished tag into
// the local Docker image store for testing.
export const NODE_RUNTIME_IMAGE = 'ghcr.io/hyperformant/node-runtime:24-alpine3.24-r2';

// sha256 fingerprint of docker/node-runtime's inputs (every file there but
// README.md; tests/unit/deploy/node-runtime-image-fingerprint.test.ts has the
// hashing). It is committed as a pair with the tag above: changing an input
// fails that test until the hash AND the -r revision move together (and the
// carbon/Dockerfile copy with them).
export const NODE_RUNTIME_INPUTS_SHA256 =
  '6ed48efc09951538f09ee3bf9ab7638f2c9dceb6cf4a6ca455fafe1a252a824e';

// Single source of truth for the pre-published carbon-autoscaler image
// (src/autoscaler/). Built once per version by
// .github/workflows/publish-images.yml; pulled (never
// built) by k8s deploys. Bumping the tag here + docker/carbon-autoscaler/
// Dockerfile is the whole version-bump surface. Publish to ghcr (GitHub
// Container Registry) under the hyperformant org (this repo is
// hyperformant/vibecarbon). The package must be PUBLIC so k3s nodes pull
// without a secret.
export const CARBON_AUTOSCALER_IMAGE = 'ghcr.io/hyperformant/carbon-autoscaler';
// The tag MUST move whenever the image contents change — including when only
// the config changes. publish-images.yml pushes to whatever
// tag this constant names, and every previous tag is already published and
// already running in a live cluster; reusing one would leave two clusters both
// reporting the same version with different bits and no way to tell them apart.
//   0.1.2 — rebased onto node:24-alpine (was node:22-alpine).
//   0.1.3 — adds the OCI metadata LABEL block (ghcr package-page description).
//           Metadata only: every layer is byte-identical to 0.1.2, but a LABEL
//           lives in the image config, so the config digest — and therefore the
//           manifest digest — moves. `crictl images` would show two different
//           digests under one tag if this stayed at 0.1.2, which is exactly the
//           ambiguity the rule above exists to prevent.
export const CARBON_AUTOSCALER_TAG = '0.1.3';

/** @returns {string} e.g. "ghcr.io/hyperformant/carbon-autoscaler:0.1.3" */
export function carbonAutoscalerImageRef() {
  return `${CARBON_AUTOSCALER_IMAGE}:${CARBON_AUTOSCALER_TAG}`;
}

// Single source of truth for the UPSTREAM cluster-autoscaler image — the
// other container in the same pod as the carbon-autoscaler sidecar above.
// We deploy it from a mirror in our own ghcr org, not from registry.k8s.io.
//
// WHY THE MIRROR — incident 2026-07-31, e3 k8s e2e. The cluster-autoscaler
// rollout wait burned its full 300s budget. Kubelet events on the
// control-plane node were unambiguous:
//
//   Failed to pull image
//   "registry.k8s.io/autoscaling/cluster-autoscaler:v1.32.7": ... failed to
//   resolve reference ... unexpected status from HEAD request to
//   https://europe-west3-docker.pkg.dev/v2/k8s-artifacts-prod/images/
//   autoscaling/cluster-autoscaler/manifests/v1.32.7: 403 Forbidden
//
// Three pull attempts, three 403s, then BackOff x20 over 5m11s. Meanwhile the
// carbon-autoscaler sidecar — same pod, same node, same containerd — pulled
// from ghcr.io in 4.6s and ran fine.
//
// registry.k8s.io is not a registry, it is a REDIRECTOR: it routes each
// client to a cloud-hosted backend (AWS ECR / GCP Artifact Registry / Azure)
// based on the client's IP. Its GCP backend intermittently 403s datacenter IP
// ranges, Hetzner's among them. Nothing on our side is misconfigured and
// nothing on our side can fix it — retries hit the same backend. The blind
// CA-rollout timeout of 2026-07-27 (before the pod-level `describe` landed in
// applyK3sManifests' failure diagnostics) is most likely the same failure
// wearing a different hat.
//
// ghcr.io was ALREADY a hard dependency of this exact pod, so mirroring costs
// no new trust and removes a third-party redirector from the deploy's
// critical path: one registry instead of two.
//
// The mirror is a digest-preserving MANIFEST COPY (`docker buildx imagetools
// create` in .github/workflows/publish-images.yml), never a
// rebuild — same bits, same tag, different host. The tag must stay
// byte-identical to upstream's so `v1.32.7` means exactly one thing
// everywhere. Bumping CA therefore means: bump CLUSTER_AUTOSCALER_TAG, let
// the mirror workflow run, THEN deploy.
//
// Like every other package in the org, ghcr.io/hyperformant/cluster-autoscaler
// must be set PUBLIC — k3s nodes pull it anonymously, with no imagePullSecret.
export const CLUSTER_AUTOSCALER_UPSTREAM_IMAGE = 'registry.k8s.io/autoscaling/cluster-autoscaler';
export const CLUSTER_AUTOSCALER_IMAGE = 'ghcr.io/hyperformant/cluster-autoscaler';
// Version pin shared by BOTH refs above — deliberately one constant, so the
// mirror can never end up copying one version under another version's tag.
export const CLUSTER_AUTOSCALER_TAG = 'v1.32.7';
// Upstream's linux/amd64 manifest digest for that tag. The mirror copies
// exactly this manifest, so the digest is identical on both hosts and the
// deployed ref pins it (see MirroredImage.digest below).
export const CLUSTER_AUTOSCALER_DIGEST =
  'sha256:b3a67e07244033d36adc1cbe236fdbf9729b968f9c1c47477e26547a78131c81';

/** @returns {string} the ref k8s deploys — e.g. "ghcr.io/hyperformant/cluster-autoscaler:v1.32.7@sha256:…" */
export function clusterAutoscalerImageRef() {
  return `${CLUSTER_AUTOSCALER_IMAGE}:${CLUSTER_AUTOSCALER_TAG}@${CLUSTER_AUTOSCALER_DIGEST}`;
}

/** @returns {string} the ref the mirror workflow COPIES FROM — never deployed directly */
export function clusterAutoscalerUpstreamRef() {
  return `${CLUSTER_AUTOSCALER_UPSTREAM_IMAGE}:${CLUSTER_AUTOSCALER_TAG}`;
}

// ---------------------------------------------------------------------------
// The registry.k8s.io mirror set
// ---------------------------------------------------------------------------
//
// Everything below generalizes the cluster-autoscaler mirror above to EVERY
// registry.k8s.io image that can reach a customer cluster. Same root cause,
// hit twice:
//
//   2026-07-31 (e3)      `autoscaling/cluster-autoscaler:v1.32.7` — 403, three
//                        pulls, BackOff x20, CA rollout wait blew its 300s
//                        budget and failed the deploy. Fixed by the mirror.
//   2026-08-05 (k8s-ha)  `sig-storage/csi-node-driver-registrar:v2.11.1` +
//                        `sig-storage/livenessprobe:v2.13.1` — 403 on ONE node
//                        of three. That node's hcloud-csi node plugin never
//                        registered, so its CSINode object never got a
//                        topology key; the db PVC then failed to provision
//                        ("no topology key found on CSINode"), `helm upgrade
//                        --wait` sat until timeout, and the deploy died. The
//                        two sibling nodes pulled the identical images fine.
//
// That second incident is the important one, because it shows the blast radius
// is not "one pod retries a bit". registry.k8s.io routes by CLIENT IP, so the
// 403 is per-node roulette: a three-node cluster can lose storage entirely
// because one node lost the coin flip. Mirroring removes the redirector from
// the deploy path — ghcr.io is already a hard dependency of every cluster we
// build (the app image, the db image, the autoscaler), so this costs no new
// trust and leaves ONE registry on the critical path instead of two.
//
// HOW THE MIRROR WORKS — .github/workflows/publish-images.yml
// runs one matrix leg per entry below, each a digest-preserving `docker buildx
// imagetools create` manifest copy of upstream's linux/amd64 child. Never a
// rebuild: same layers, same config, same tag, different host. The matrix is
// generated by scripts/mirror-matrix.mjs, which imports THIS list — there is no
// second place to edit.
//
// OPERATOR CONTRACT — a newly mirrored package is created PRIVATE, and k3s nodes
// pull anonymously with no imagePullSecret. Every name in
// `mirroredPackageNames()` must be flipped PUBLIC by hand in the org's
// package settings (there is no REST API for container package visibility)
// BEFORE any deploy consumes it. Same proven sequence as #222: publish, flip,
// verify an unauthenticated pull, then merge the code that switches over.

/** ghcr org every mirror lands in. Flat: no nested paths (ghcr has no such thing). */
export const K8S_MIRROR_ORG = 'ghcr.io/hyperformant';
/** The redirector we are mirroring AWAY from. */
export const K8S_UPSTREAM_REGISTRY = 'registry.k8s.io';

/**
 * @typedef {{repo: string, tag: string, digest: string, upstream?: string, index?: string}} MirroredImage
 * `upstream` is the registry the mirror job copies FROM, defaulting to
 * `K8S_UPSTREAM_REGISTRY` (every entry that predates the Docker Hub mirrors
 * leaves it out); Docker Hub entries set `DOCKERHUB_UPSTREAM_REGISTRY`.
 * `repo` is the path under that registry (e.g. `sig-storage/livenessprobe`,
 * `library/traefik`);
 * `tag` is upstream's tag, reused verbatim on the mirror so a version string
 * means exactly one thing on both hosts. `digest` is upstream's linux/amd64
 * manifest digest for that tag: the mirror job copies exactly that manifest
 * (and fails if upstream's tag no longer resolves to it), so it is the same
 * digest on ghcr, and every deployed ref pins it (`name:tag@digest`). Read it
 * off upstream before mirroring:
 *   docker buildx imagetools inspect --raw <upstream>/<repo>:<tag> \
 *     | jq -r '.manifests[] | select(.platform.os=="linux" and .platform.architecture=="amd64") | .digest'
 *
 * `index` (optional) is the upstream multi-arch INDEX digest the pinned child
 * belongs to. When set, the mirror job reads the amd64 child from
 * `<upstream>/<repo>@<index>` instead of the tag, so an upstream re-push of
 * the tag (Docker Hub tags move) cannot fail or change a leg. Every Docker Hub
 * entry sets it.
 */

/**
 * CSI driver releases cloud-init installs. Every sidecar tag in
 * `CSI_SIDECAR_MIRRORS` was hand-derived from the manifest at these versions,
 * so bumping one WITHOUT re-deriving the tags would re-pin stale sidecars over
 * a newer driver — or silently no-op if a container was renamed. A unit guard
 * (tests/unit/deploy/k8s-image-mirrors.test.ts) reads the versions back out of
 * the cloud-init scripts and fails on any mismatch.
 *
 * Sources (fetched 2026-08-05):
 *   hetznercloud/csi-driver v2.18.1  deploy/kubernetes/hcloud-csi.yml
 *   digitalocean/csi-digitalocean v4.17.0  .../releases/csi-digitalocean-v4.17.0/driver.yaml
 *
 * WHY v2.18.1 AND NOT THE NEWEST RELEASE (v2.22.1 at time of writing) —
 * upstream supports the latest THREE Kubernetes minors and drops the rest
 * (docs/kubernetes/reference/version-policy.md). k3s is pinned at v1.31.x
 * (K3S_VERSION in deploy/k8s/k3s.js) and v2.18.2's changelog entry is
 * literally "drop Kubernetes v1.31 support", so v2.18.1 is the ceiling until
 * K3S_VERSION moves. A unit guard asserts both ends of that window — the
 * v2.15.0 FLOOR (below it master-init.sh's HCLOUD_VOLUME_EXTRA_LABELS line is
 * a no-op, see below) and the per-k8s-minor ceiling.
 *
 * KNOWN GAP AT v2.18.1 — its ClusterRole omits `volumeattributesclasses`
 * get/list/watch, which csi-resizer v2.0.0 watches, so that container logs a
 * forbidden-list line every few seconds (upstream #1191). Provision, attach,
 * detach and resize all work; upstream fixed the RBAC in v2.18.3, which is
 * past our k8s ceiling. Noise only — do not chase it in a deploy log.
 */
export const HETZNER_CSI_VERSION = 'v2.18.1';
export const DO_CSI_VERSION = 'v4.17.0';

/**
 * Per-provider map of the CSI workloads cloud-init applies from upstream YAML,
 * and the registry.k8s.io sidecar containers inside them.
 *
 * WHY THIS SHAPE — we do not own these manifests. cloud-init applies upstream's
 * YAML verbatim from a URL (master-init.sh / do-master-init.sh), so there is no
 * template seam to patch and no kustomize overlay to add. The seam is
 * `kubectl set image` at deploy time, addressing containers BY NAME — the exact
 * idiom cloud-init itself already uses one line later (`kubectl set env
 * deployment/hcloud-csi-controller HCLOUD_VOLUME_EXTRA_LABELS=...`), and the
 * same idiom applyK3sManifests already uses to re-pin the cluster-autoscaler pod.
 *
 * Only registry.k8s.io containers are listed. The driver containers themselves
 * (docker.io/hetznercloud/hcloud-csi-driver, digitalocean/do-csi-plugin) are
 * deliberately not mirrored: no evidence of a pull failure on those hosts, and
 * mirroring on speculation would add packages nobody has a reason to trust.
 * DO's floating `alpine:3` init container is re-pinned onto our alpine mirror
 * by digest (CSI_UPSTREAM_IMAGE_PINS below).
 *
 * @type {Record<string, Array<{workload: string, containers: Record<string, MirroredImage>}>>}
 */
export const CSI_SIDECAR_MIRRORS = {
  // hetznercloud/csi-driver v2.18.1 — everything lands in kube-system. Workload
  // names, kinds and container names are byte-identical to v2.9.0's, so the
  // `kubectl set image` seam below survived the bump unchanged; only the
  // sidecar TAGS moved (v2.9.0 shipped registrar v2.11.1 / livenessprobe
  // v2.13.1 / attacher v4.6.1 / resizer v1.11.2 / provisioner v5.0.2).
  hetzner: [
    {
      // The workload from the 2026-08-05 incident: no node plugin, no CSINode
      // topology key, no PVCs anywhere on that node.
      workload: 'daemonset/hcloud-csi-node',
      containers: {
        'csi-node-driver-registrar': {
          repo: 'sig-storage/csi-node-driver-registrar',
          tag: 'v2.15.0',
          digest: 'sha256:1ca23bdbb1504e41233d527e826d02dac98571c45a6cd74c5fb28be485d680fa',
        },
        'liveness-probe': {
          repo: 'sig-storage/livenessprobe',
          tag: 'v2.17.0',
          digest: 'sha256:e8983e659df16bda5bd8d2900651e1236b1c1bd0c96c8600aec736e7eabdb1e4',
        },
      },
    },
    {
      workload: 'deployment/hcloud-csi-controller',
      containers: {
        'csi-attacher': {
          repo: 'sig-storage/csi-attacher',
          tag: 'v4.10.0',
          digest: 'sha256:8a46d7ecbb798f19d7ccd7e510a2efec00ae7ba50fd82cc2f5ac45cedbab0bc1',
        },
        'csi-resizer': {
          repo: 'sig-storage/csi-resizer',
          tag: 'v2.0.0',
          digest: 'sha256:25b17c4f84b0ab061da6397caf407c7251a571df5c4071e4917942684c61689a',
        },
        'csi-provisioner': {
          repo: 'sig-storage/csi-provisioner',
          tag: 'v6.0.0',
          digest: 'sha256:4c7e7c948bed9d8bb117cd4cdff59699568732147ae151842836cfcb385cbf22',
        },
        'liveness-probe': {
          repo: 'sig-storage/livenessprobe',
          tag: 'v2.17.0',
          digest: 'sha256:e8983e659df16bda5bd8d2900651e1236b1c1bd0c96c8600aec736e7eabdb1e4',
        },
      },
    },
  ],
  // digitalocean/csi-digitalocean v4.17.0 — same sig-storage sidecars, but a
  // DIFFERENT tag for every single one, and a snapshotter Hetzner does not
  // ship. This is why the mirror set is keyed by (repo, tag) and not by name.
  digitalocean: [
    {
      workload: 'statefulset/csi-do-controller',
      containers: {
        'csi-provisioner': {
          repo: 'sig-storage/csi-provisioner',
          tag: 'v6.2.0',
          digest: 'sha256:da2f5c41881009b963c121d3605c68ad9127490f2c209a849b4eb26074b0038b',
        },
        'csi-attacher': {
          repo: 'sig-storage/csi-attacher',
          tag: 'v4.11.0',
          digest: 'sha256:4f6b1289ffe62dbe3d2317dd938cd9dd3fb0a7c0088d505cde4effa1e0771dc2',
        },
        'csi-snapshotter': {
          repo: 'sig-storage/csi-snapshotter',
          tag: 'v8.5.0',
          digest: 'sha256:f4d58334dc3c0873e544f110a188be47e224ff7e99c6400d2fd7b35de9b962eb',
        },
        'csi-resizer': {
          repo: 'sig-storage/csi-resizer',
          tag: 'v2.1.0',
          digest: 'sha256:69e7bf7d929e5d98a5a74e753b45220e6e7b04f35163e48e8a5958bf1d819b4c',
        },
      },
    },
    {
      workload: 'daemonset/csi-do-node',
      containers: {
        'csi-node-driver-registrar': {
          repo: 'sig-storage/csi-node-driver-registrar',
          tag: 'v2.16.0',
          digest: 'sha256:aeecba5b171b50558bab359fdb8e28b9da185f666cef35cd87ac9784e51956c5',
        },
      },
    },
  ],
};

/**
 * The `pause` image, used as a do-nothing placeholder container in two places:
 * the local kustomize overlay's stand-in for the app, and the e2e
 * scale-trigger Deployment (whose whole job is to force the autoscaler to add
 * a node — so it pulls on a brand-new worker, which is precisely where the
 * registry.k8s.io roulette is played). Flagged for mirroring in #222's body.
 * @type {MirroredImage}
 */
export const PAUSE_IMAGE = {
  repo: 'pause',
  tag: '3.9',
  digest: 'sha256:8d4106c88ec0bd28001e34c975d65175d994072d65341f62a8ab0754b0fafe10',
};

/** Docker Hub, the other registry the mirror set copies from. */
export const DOCKERHUB_UPSTREAM_REGISTRY = 'docker.io';

// ---------------------------------------------------------------------------
// The Docker Hub mirror set (cold-deploy-speed plan, Task 7)
// ---------------------------------------------------------------------------
//
// Docker Hub rate-limits ANONYMOUS pulls per source IP, and a fresh cloud
// server often inherits an IP that has already spent its quota. A throttled
// pull costs minutes or fails the deploy (a cloud-init pre-pull was reverted
// over exactly this, 7babb8e). So every Docker Hub image on the core deploy
// path is mirrored into ghcr by the same matrix as the registry.k8s.io set,
// and consumers pull `ghcr.io/hyperformant/<basename>:<tag>@<amd64 digest>`.
//
// `digest` is upstream's linux/amd64 CHILD manifest, not the multi-arch index
// Docker Hub refs used to pin (deploy is amd64-only, src/lib/deploy/platform.js;
// the mirror job copies only that child). Read it with the one-liner on the
// MirroredImage typedef.
//
// BUMPING ONE: Dependabot cannot see these (the refs point at our mirror, and
// the mirror tag's digest is the index the job mints, not this child digest).
// Edit {tag, digest, index} here AND the literal copies (compose files and k8s base
// manifests, which cannot import JS; the census
// tests/unit/deploy/core-images-from-mirror-census.test.ts fails until every
// copy names an entry exactly), merge, and publish-images mirrors the new tag.
// The weekly `mirror-upstream-drift` job lists newer upstream tags.
//
// Not here, deliberately: the add-ons (n8n, Metabase, Redis, observability)
// and their alpine helpers, the diagnose-only probes, and BINFMT_IMAGE (runs
// on the operator's machine). `dockerhub-login` still covers the add-ons.

/** @type {MirroredImage} the ingress proxy, compose and k8s */
export const TRAEFIK_MIRROR = {
  upstream: DOCKERHUB_UPSTREAM_REGISTRY,
  repo: 'library/traefik',
  tag: 'v3.6.11',
  digest: 'sha256:2b6506fde98570702dd026bc70ed307a0f22c2cf693329e91b46f94d371097a1',
  index: 'sha256:acfc80650104f0194a15f73dc1648f517561bc1645391a15705332a064cfc33c',
};
/** @type {MirroredImage} compose prod's two socket proxies (traefik's and the app's) */
export const DOCKER_SOCKET_PROXY_MIRROR = {
  upstream: DOCKERHUB_UPSTREAM_REGISTRY,
  repo: 'tecnativa/docker-socket-proxy',
  tag: 'v0.4.2',
  digest: 'sha256:bd2241b3bec83abcff25927a0a7ae518e0c5bef624b3cc247dcb31e68b53f417',
  index: 'sha256:1f3a6f303320723d199d2316a3e82b2e2685d86c275d5e3deeaf182573b47476',
};
/** @type {MirroredImage} DO CSI's automount-udev-deleter init container */
export const ALPINE_MIRROR = {
  upstream: DOCKERHUB_UPSTREAM_REGISTRY,
  repo: 'library/alpine',
  tag: '3.24.3',
  digest: 'sha256:c26612752c78b18faacd63c7d50f4592c2e7b0f25e0e20e82bd74e465c57ab0d',
  index: 'sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a',
};
/**
 * @type {MirroredImage} the k8s in-cluster registry
 * (carbon/k8s/base/registry/local-registry.yaml). Stays on the 2.x line:
 * registry 3 changed the config format.
 */
export const REGISTRY_MIRROR = {
  upstream: DOCKERHUB_UPSTREAM_REGISTRY,
  repo: 'library/registry',
  tag: '2.8.3',
  digest: 'sha256:46faa9a1ae6813194b53921a370f2f4f8c5e1aae228a89bceafef5847a6a3278',
  index: 'sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373',
};
/**
 * @type {MirroredImage} the replication gateway (compose-ha SOCAT_IMAGE,
 * k8s-ha repl-gateway.yaml and registry-relay.yaml). Upstream has since
 * re-pushed Docker Hub's 1.8.1.3 tag; `index` keeps the bits this repo has
 * always pinned (the old index, sha256:fb3862c9…, and its amd64 child), so
 * the move to the mirror is content-neutral. ghcr's socat:1.8.1.3 therefore
 * names those OLD bits, not what Docker Hub's tag resolves to today.
 */
export const SOCAT_MIRROR = {
  upstream: DOCKERHUB_UPSTREAM_REGISTRY,
  repo: 'alpine/socat',
  tag: '1.8.1.3',
  digest: 'sha256:99316fc7e1e8b5f40308105c54c9bed5a45891acee6480e8f0f9d2f4e69dee02',
  index: 'sha256:fb3862c949af7c79996d0e514ee96128644d840835ed5368eeecb14a869de361',
};
/**
 * @type {MirroredImage} the backup CronJob's kubectl (carbon/k8s/base/backup/
 * cronjob.yaml). Its tag tracks a Kubernetes minor and must stay within one
 * minor of K3S_VERSION (src/lib/deploy/k8s/k3s.js).
 */
export const ALPINE_K8S_MIRROR = {
  upstream: DOCKERHUB_UPSTREAM_REGISTRY,
  repo: 'alpine/k8s',
  tag: '1.31.12',
  digest: 'sha256:d57b0d2e1837411db2616cd680e474a3564b3a129d942d3464deb2b19790c2e4',
  index: 'sha256:5aab84f0ca8ee3ae12dbe2c9fef9502a0c1e2bb0fac913bb3e71e422b642986e',
};

/**
 * The alias k3s's `--system-default-registry` names its system images under.
 * `.invalid` is reserved (RFC 2606): it never resolves, so the only way an
 * image named here is reachable is the ghcr mirror in registries.yaml, and
 * containerd's last-resort default endpoint fails fast on DNS.
 */
export const K3S_SYSTEM_REGISTRY = 'vibecarbon-system.invalid';

/**
 * k3s's OWN system images (ruling D3): k3s pulls these by tag on every node,
 * from docker.io/rancher by default. The master runs k3s with
 * `--system-default-registry K3S_SYSTEM_REGISTRY` (agents inherit it from the
 * server), so k3s names them `<alias>/rancher/<repo>:<tag>`, and the ONLY
 * containerd mirror pointing at ghcr is for that alias, with per-repo
 * rewrites onto ghcr.io/hyperformant/<basename>
 * (carbon/cloud-init/k3s/_k3s-system-image-mirror.yaml, spliced into every
 * role's /etc/rancher/k3s/registries.yaml). There is deliberately NO docker.io
 * mirror: one with a ghcr endpoint would try every docker.io pull as
 * ghcr.io/<same org>/<same name> first (namespace confusion). The cost: no
 * fallback, so a missing or private mirror fails the pull (release.yml's
 * mirrored-images gate covers every entry): every role also runs k3s with
 * --disable-default-registry-endpoint, so containerd never tries the alias's
 * own host. The snippet is spliced into an UNQUOTED heredoc by the
 * DigitalOcean scripts: no capture groups, backticks or dollar-variables in
 * it (a dollar sign followed by a quote stays literal).
 *
 * Tags are k3s-images.txt of K3S_VERSION (v1.31.5+k3s1). Unmirrored on
 * purpose: klipper-helm and mirrored-library-traefik (`--disable traefik`)
 * and klipper-lb (`--disable servicelb`). mirrored-library-busybox (the
 * local-path helper) IS mirrored although the deploy refuses local-path
 * PVCs: through the alias registry below there is no Docker Hub fallback.
 * A K3S_VERSION bump re-derives these from the new release's k3s-images.txt
 * (the census pins the version).
 * @type {MirroredImage[]}
 */
export const K3S_SYSTEM_IMAGE_MIRRORS = [
  {
    upstream: DOCKERHUB_UPSTREAM_REGISTRY,
    repo: 'rancher/mirrored-coredns-coredns',
    tag: '1.12.0',
    digest: 'sha256:2324f485c8db937628a18c293d946327f3a7229b9f77213e8f2256f0b616a4ee',
    index: 'sha256:82979ddf442c593027a57239ad90616deb874e90c365d1a96ad508c2104bdea5',
  },
  {
    upstream: DOCKERHUB_UPSTREAM_REGISTRY,
    repo: 'rancher/local-path-provisioner',
    tag: 'v0.0.30',
    digest: 'sha256:fe541e6e7ee182cd6469c831f74026a4e36a5fa059d582459eca40b17c5275b3',
    index: 'sha256:9b914881170048f80ae9302f36e5b99b4a6b18af73a38adc1c66d12f65d360be',
  },
  {
    upstream: DOCKERHUB_UPSTREAM_REGISTRY,
    repo: 'rancher/mirrored-metrics-server',
    tag: 'v0.7.2',
    digest: 'sha256:78e46b57096ec75e302fbc853e36359555df5c827bb009ecfe66f97474cc2a5a',
    index: 'sha256:dccf8474fb910fef261d31d9483d7e4c1df7b86cf4d638fb6a7d7c88bd51600a',
  },
  {
    upstream: DOCKERHUB_UPSTREAM_REGISTRY,
    repo: 'rancher/mirrored-library-busybox',
    tag: '1.36.1',
    digest: 'sha256:ec15a5bd53cf9507beb851574654669e778a9735f8e605e0ee3d71fd07debbe1',
    index: 'sha256:8a45424ddf949bbe9bb3231b05f9032a45da5cd036eb4867b511b00734756d6f',
  },
  {
    upstream: DOCKERHUB_UPSTREAM_REGISTRY,
    repo: 'rancher/mirrored-pause',
    tag: '3.6',
    digest: 'sha256:c2280d2f5f56cf9c9a01bb64b2db4651e35efd6d62a54dcfc12049fe6449c5e4',
    index: 'sha256:74c4244427b7312c5b901fe0f67cbc53683d06f4f24c6faee65d4182bf0fa893',
  },
];

/**
 * Every Docker Hub image we mirror: the core-path set, then k3s's own.
 * @type {MirroredImage[]}
 */
export const DOCKERHUB_MIRRORS = [
  TRAEFIK_MIRROR,
  DOCKER_SOCKET_PROXY_MIRROR,
  ALPINE_MIRROR,
  REGISTRY_MIRROR,
  SOCAT_MIRROR,
  ALPINE_K8S_MIRROR,
  ...K3S_SYSTEM_IMAGE_MIRRORS,
];

/**
 * Upstream CSI containers that ship FLOATING in upstream's manifest, re-pinned
 * by digest through the same `kubectl set image` seam. DO's v4.17.0
 * driver.yaml runs its `automount-udev-deleter` init container as bare
 * `alpine:3`, a floating major on Docker Hub; it now runs our alpine mirror
 * (ALPINE_MIRROR above), so a rate-limited Docker Hub cannot hold up the
 * node plugin. `kubectl set image` addresses init containers by name too.
 * Values are full refs. csiSidecarSetImagePlan merges these into the same
 * per-workload call as the mirrors, so no extra rollout happens.
 * @type {Record<string, Array<{workload: string, containers: Record<string, string>}>>}
 */
export const CSI_UPSTREAM_IMAGE_PINS = {
  digitalocean: [
    {
      workload: 'daemonset/csi-do-node',
      containers: {
        'automount-udev-deleter': k8sMirrorRef(ALPINE_MIRROR),
      },
    },
  ],
};

/**
 * Every image we mirror (registry.k8s.io and Docker Hub), in publish order.
 *
 * DERIVED, not hand-listed: the CSI entries come from `CSI_SIDECAR_MIRRORS` and
 * the cluster-autoscaler entry from `CLUSTER_AUTOSCALER_TAG`, so "the workflow
 * mirrors something nothing deploys" and — far worse — "something deploys a ref
 * the workflow never mirrored" are both unrepresentable rather than merely
 * tested for. Duplicates collapse by (repo, tag): Hetzner's node DaemonSet and
 * controller both run livenessprobe v2.13.1, and that is one package to mirror.
 * @type {MirroredImage[]}
 */
export const MIRRORED_IMAGES = assertDistinctPackageNames(
  dedupeImages([
    // Keeps its own named constants because deploy code references the CA image
    // directly, but it is mirrored by the same matrix as everything else — one
    // mechanism, not two.
    {
      repo: 'autoscaling/cluster-autoscaler',
      tag: CLUSTER_AUTOSCALER_TAG,
      digest: CLUSTER_AUTOSCALER_DIGEST,
    },
    ...Object.values(CSI_SIDECAR_MIRRORS).flatMap((specs) =>
      specs.flatMap((spec) => Object.values(spec.containers)),
    ),
    PAUSE_IMAGE,
    ...DOCKERHUB_MIRRORS,
  ]),
);

/**
 * @param {MirroredImage[]} images
 * @returns {MirroredImage[]} first-occurrence order, unique by upstream ref
 */
function dedupeImages(images) {
  const seen = new Set();
  return images.filter((image) => {
    const key = upstreamRef(image);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Refuse two DIFFERENT upstream repos that would land in one flat ghcr package
 * (`library/alpine` and `someone/alpine` both -> `alpine`): the package would
 * then hold two unrelated images under one name. The same repo at two tags is
 * one package, which is fine. Runs when MIRRORED_IMAGES is built, so a
 * colliding entry fails at import, in every test and every CLI run.
 * @param {MirroredImage[]} images
 * @returns {MirroredImage[]} `images`, unchanged
 */
export function assertDistinctPackageNames(images) {
  const owner = new Map();
  for (const image of images) {
    const source = `${image.upstream ?? K8S_UPSTREAM_REGISTRY}/${image.repo}`;
    const name = mirroredImageName(image.repo);
    const prior = owner.get(name);
    if (prior && prior !== source) {
      throw new Error(
        `mirror package name collision: ${prior} and ${source} both mirror to ` +
          `${K8S_MIRROR_ORG}/${name}; give one a distinct package name`,
      );
    }
    owner.set(name, source);
  }
  return images;
}

/**
 * The ghcr package name an upstream repo path mirrors to: upstream's basename,
 * flat under the org. `autoscaling/cluster-autoscaler` -> `cluster-autoscaler`,
 * matching the precedent #222 set. ghcr has no nested-path packages, and a
 * slash here would mint a package the org UI cannot flip public.
 * @param {string} repo
 * @returns {string}
 */
export function mirroredImageName(repo) {
  return repo.slice(repo.lastIndexOf('/') + 1);
}

/**
 * @param {MirroredImage} image
 * @returns {string} the ref the mirror job COPIES FROM — never deployed
 */
export function upstreamRef({ upstream = K8S_UPSTREAM_REGISTRY, repo, tag }) {
  return `${upstream}/${repo}:${tag}`;
}

/**
 * @param {MirroredImage} image
 * @returns {string} the tag the mirror job pushes — e.g. "ghcr.io/hyperformant/livenessprobe:v2.17.0"
 */
export function k8sMirrorTagRef({ repo, tag }) {
  return `${K8S_MIRROR_ORG}/${mirroredImageName(repo)}:${tag}`;
}

/**
 * @param {MirroredImage} image
 * @returns {string} the ref clusters actually pull, digest-pinned — e.g.
 *   "ghcr.io/hyperformant/livenessprobe:v2.17.0@sha256:…"
 */
export function k8sMirrorRef(image) {
  return `${k8sMirrorTagRef(image)}@${image.digest}`;
}

/**
 * The operator's public-flip checklist: every ghcr package the mirror job
 * creates. Sorted + unique because a package holds ALL its tags (csi-provisioner
 * carries both Hetzner's v5.0.2 and DO's v6.2.0), so this is shorter than the
 * mirror set and is the list to work through in the org's package settings.
 * @returns {string[]}
 */
export function mirroredPackageNames() {
  return [...new Set(MIRRORED_IMAGES.map((image) => mirroredImageName(image.repo)))].sort();
}

/**
 * Build the `kubectl set image` plan that moves a provider's CSI sidecars onto
 * the mirrors. Unknown/absent provider -> empty plan: applyK3sManifests runs
 * this unconditionally, and a provider that installs no CSI driver must
 * degrade to "do nothing", never to a failed deploy.
 *
 * @param {string|undefined} providerId - 'hetzner' | 'digitalocean'
 * @returns {Array<{workload: string, setImageArgs: string[]}>}
 */
export function csiSidecarSetImagePlan(providerId) {
  const specs = (providerId && CSI_SIDECAR_MIRRORS[providerId]) || [];
  const inPlace = (providerId && CSI_UPSTREAM_IMAGE_PINS[providerId]) || [];
  const plan = specs.map(({ workload, containers }) => ({
    workload,
    setImageArgs: Object.entries(containers).map(
      ([container, image]) => `${container}=${k8sMirrorRef(image)}`,
    ),
  }));
  for (const { workload, containers } of inPlace) {
    const args = Object.entries(containers).map(([container, ref]) => `${container}=${ref}`);
    const entry = plan.find((p) => p.workload === workload);
    if (entry) entry.setImageArgs.push(...args);
    else plan.push({ workload, setImageArgs: args });
  }
  return plan;
}

/**
 * Throwaway probe pods `vibecarbon diagnose` runs in a cluster: busybox for
 * the in-cluster DNS/HTTP probe, netshoot for the deep network battery.
 * Pinned by tag and multi-arch index digest (both carry amd64), so a
 * diagnosis never depends on what a floating tag resolved to that day.
 * Dependabot sees them through .github/image-pins/Dockerfile.
 */
export const DIAG_BUSYBOX_IMAGE =
  'busybox:1.36.1@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662';
export const DIAG_NETSHOOT_IMAGE =
  'nicolaka/netshoot:v0.16@sha256:b09d9b21381f47a79b3cbcb30da25266dc17186ea00ae65e99fdc51396f48e70';

// Per-image mirror refs, digest-pinned: `ghcr.io/hyperformant/<name>:<tag>@<digest>`.
// Compose and k8s manifests carry the same strings as literals; the census
// keeps them equal.

/** @returns {string} the mirrored traefik ref */
export function traefikImageRef() {
  return k8sMirrorRef(TRAEFIK_MIRROR);
}
/** @returns {string} the mirrored docker-socket-proxy ref */
export function dockerSocketProxyImageRef() {
  return k8sMirrorRef(DOCKER_SOCKET_PROXY_MIRROR);
}
/** @returns {string} the mirrored alpine ref */
export function alpineImageRef() {
  return k8sMirrorRef(ALPINE_MIRROR);
}
/** @returns {string} the mirrored registry:2 ref (k8s in-cluster registry) */
export function registryImageRef() {
  return k8sMirrorRef(REGISTRY_MIRROR);
}
/** @returns {string} the mirrored socat ref (both HA tiers' replication gateway) */
export function socatImageRef() {
  return k8sMirrorRef(SOCAT_MIRROR);
}
/** @returns {string} the mirrored alpine/k8s ref (the backup CronJob) */
export function alpineK8sImageRef() {
  return k8sMirrorRef(ALPINE_K8S_MIRROR);
}

/** @returns {string} the mirrored pause ref — e.g. "ghcr.io/hyperformant/pause:3.9@sha256:…" */
export function pauseImageRef() {
  return k8sMirrorRef(PAUSE_IMAGE);
}
