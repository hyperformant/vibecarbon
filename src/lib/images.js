/**
 * Single source of truth for the pre-published db image (supabase/postgres +
 * wal-g). Built once per version by .github/workflows/publish-db-image.yml
 * for linux/amd64 ONLY — vibecarbon standardizes on x86-64 servers, and this
 * image's only consumer is the supabase db pod on a k3s node. (Compose does
 * not pull it at all; it builds carbon/db/ on the host that runs the stack.)
 * Bumping the tag here + Dockerfile is the whole version-bump surface.
 */
// Publish to ghcr (GitHub Container Registry) under the hyperformant org
// (this repo is hyperformant/vibecarbon). The package must be set to PUBLIC
// so k3s/compose nodes pull without a secret. Single source of truth for the
// tag — bump here + the Dockerfile to cut a new version.
export const DB_IMAGE = 'ghcr.io/hyperformant/postgres';
export const DB_IMAGE_TAG = '17.6.1.167-walg3.0.9';

/** @returns {string} e.g. "ghcr.io/hyperformant/postgres:17.6.1.167-walg3.0.9" */
export function dbImageRef() {
  return `${DB_IMAGE}:${DB_IMAGE_TAG}`;
}

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

/** @returns {string} the ref k8s deploys — e.g. "ghcr.io/hyperformant/cluster-autoscaler:v1.32.7" */
export function clusterAutoscalerImageRef() {
  return `${CLUSTER_AUTOSCALER_IMAGE}:${CLUSTER_AUTOSCALER_TAG}`;
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
// `mirroredK8sPackageNames()` must be flipped PUBLIC by hand in the org's
// package settings (there is no REST API for container package visibility)
// BEFORE any deploy consumes it. Same proven sequence as #222: publish, flip,
// verify an unauthenticated pull, then merge the code that switches over.

/** ghcr org every mirror lands in. Flat: no nested paths (ghcr has no such thing). */
export const K8S_MIRROR_ORG = 'ghcr.io/hyperformant';
/** The redirector we are mirroring AWAY from. */
export const K8S_UPSTREAM_REGISTRY = 'registry.k8s.io';

/**
 * @typedef {{repo: string, tag: string}} MirroredImage
 * `repo` is the path under registry.k8s.io (e.g. `sig-storage/livenessprobe`);
 * `tag` is upstream's tag, reused verbatim on the mirror so a version string
 * means exactly one thing on both hosts.
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
 * (docker.io/hetznercloud/hcloud-csi-driver, digitalocean/do-csi-plugin) and
 * DO's `alpine:3` init container are deliberately left alone: no evidence of a
 * pull failure on those hosts, and mirroring on speculation would add packages
 * nobody has a reason to trust.
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
        },
        'liveness-probe': { repo: 'sig-storage/livenessprobe', tag: 'v2.17.0' },
      },
    },
    {
      workload: 'deployment/hcloud-csi-controller',
      containers: {
        'csi-attacher': { repo: 'sig-storage/csi-attacher', tag: 'v4.10.0' },
        'csi-resizer': { repo: 'sig-storage/csi-resizer', tag: 'v2.0.0' },
        'csi-provisioner': { repo: 'sig-storage/csi-provisioner', tag: 'v6.0.0' },
        'liveness-probe': { repo: 'sig-storage/livenessprobe', tag: 'v2.17.0' },
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
        'csi-provisioner': { repo: 'sig-storage/csi-provisioner', tag: 'v6.2.0' },
        'csi-attacher': { repo: 'sig-storage/csi-attacher', tag: 'v4.11.0' },
        'csi-snapshotter': { repo: 'sig-storage/csi-snapshotter', tag: 'v8.5.0' },
        'csi-resizer': { repo: 'sig-storage/csi-resizer', tag: 'v2.1.0' },
      },
    },
    {
      workload: 'daemonset/csi-do-node',
      containers: {
        'csi-node-driver-registrar': {
          repo: 'sig-storage/csi-node-driver-registrar',
          tag: 'v2.16.0',
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
export const PAUSE_IMAGE = { repo: 'pause', tag: '3.9' };

/**
 * Every registry.k8s.io image we mirror, in publish order.
 *
 * DERIVED, not hand-listed: the CSI entries come from `CSI_SIDECAR_MIRRORS` and
 * the cluster-autoscaler entry from `CLUSTER_AUTOSCALER_TAG`, so "the workflow
 * mirrors something nothing deploys" and — far worse — "something deploys a ref
 * the workflow never mirrored" are both unrepresentable rather than merely
 * tested for. Duplicates collapse by (repo, tag): Hetzner's node DaemonSet and
 * controller both run livenessprobe v2.13.1, and that is one package to mirror.
 * @type {MirroredImage[]}
 */
export const MIRRORED_K8S_IMAGES = dedupeImages([
  // Keeps its own named constants because deploy code references the CA image
  // directly, but it is mirrored by the same matrix as everything else — one
  // mechanism, not two.
  { repo: 'autoscaling/cluster-autoscaler', tag: CLUSTER_AUTOSCALER_TAG },
  ...Object.values(CSI_SIDECAR_MIRRORS).flatMap((specs) =>
    specs.flatMap((spec) => Object.values(spec.containers)),
  ),
  PAUSE_IMAGE,
]);

/**
 * @param {MirroredImage[]} images
 * @returns {MirroredImage[]} first-occurrence order, unique by `repo:tag`
 */
function dedupeImages(images) {
  const seen = new Set();
  return images.filter(({ repo, tag }) => {
    const key = `${repo}:${tag}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
export function k8sUpstreamRef({ repo, tag }) {
  return `${K8S_UPSTREAM_REGISTRY}/${repo}:${tag}`;
}

/**
 * @param {MirroredImage} image
 * @returns {string} the ref clusters actually pull — e.g. "ghcr.io/hyperformant/livenessprobe:v2.13.1"
 */
export function k8sMirrorRef({ repo, tag }) {
  return `${K8S_MIRROR_ORG}/${mirroredImageName(repo)}:${tag}`;
}

/**
 * The operator's public-flip checklist: every ghcr package the mirror job
 * creates. Sorted + unique because a package holds ALL its tags (csi-provisioner
 * carries both Hetzner's v5.0.2 and DO's v6.2.0), so this is shorter than the
 * mirror set and is the list to work through in the org's package settings.
 * @returns {string[]}
 */
export function mirroredK8sPackageNames() {
  return [...new Set(MIRRORED_K8S_IMAGES.map((image) => mirroredImageName(image.repo)))].sort();
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
  return specs.map(({ workload, containers }) => ({
    workload,
    setImageArgs: Object.entries(containers).map(
      ([container, image]) => `${container}=${k8sMirrorRef(image)}`,
    ),
  }));
}

/** @returns {string} the mirrored pause ref — e.g. "ghcr.io/hyperformant/pause:3.9" */
export function pauseImageRef() {
  return k8sMirrorRef(PAUSE_IMAGE);
}
