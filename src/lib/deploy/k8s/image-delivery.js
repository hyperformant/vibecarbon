/**
 * Pure helpers for delivering the app image to a k8s cluster's local registry.
 * A k8s-ha standby takes the primary's image by copy instead of building its own.
 */

// `@` is excluded from repo and tag so a digest ref (`repo@sha256:…`) is
// refused rather than read as a tag named after the digest. `/` is excluded
// from a repo segment so the segments split one way only (no backtracking).
const LOCAL_REGISTRY_REF = /^([^/\s]+:5000)\/([^\s:@/]+(?:\/[^\s:@/]+)*):([^\s/:@]+)$/;

/**
 * Split a `<host>:5000/<repo>:<tag>` ref. Throws unless the host is a cluster
 * local registry and the tag is present.
 */
export function parseLocalRegistryRef(ref) {
  const m = LOCAL_REGISTRY_REF.exec(String(ref ?? ''));
  if (!m) throw new Error(`not a local-registry ref: ${ref}`);
  const [, host, repo, tag] = m;
  return { host, repo, tag, repoTag: `${repo}:${tag}` };
}

/**
 * The registry ref of an image the operator built locally (`<prefix>/<repo>:<tag>`,
 * image.js generateLocalImageTag): the same repo and tag under the master's
 * registry. The build runs before the cluster exists, so it cannot know the
 * master's private IP (a real Pulumi output on DigitalOcean); deliverAppImage
 * retags the built image with this once it does.
 */
export function registryImageTag(localTag, masterPrivateIp) {
  if (!masterPrivateIp) throw new Error('masterPrivateIp is required');
  const slash = String(localTag ?? '').indexOf('/');
  if (slash < 1) throw new Error(`not a locally built image tag: ${localTag}`);
  return `${masterPrivateIp}:5000/${localTag.slice(slash + 1)}`;
}

/** The primary's image ref re-prefixed for the standby master's registry. */
export function standbyImageRef({ primaryRef, standbyMasterPrivateIp }) {
  if (!standbyMasterPrivateIp) throw new Error('standbyMasterPrivateIp is required');
  const { repoTag } = parseLocalRegistryRef(primaryRef);
  return `${standbyMasterPrivateIp}:5000/${repoTag}`;
}

/**
 * What a deploy does about the app image, by HA role. The operator builds it
 * and delivers it once (`deliver`: a layer delta into the master's registry,
 * which every node pulls from). A k8s-ha standby does neither: it copies the
 * primary's image into its own registry.
 */
export function planImageDelivery({ role } = {}) {
  if (role === 'standby') return { build: false, deliver: false, awaitPeerImage: true };
  return { build: true, deliver: true, awaitPeerImage: false };
}

/** Manifest media types a registry may serve a tag as; the digest HEAD must accept all. */
export const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/**
 * POSIX `digest host repo tag`: prints the Docker-Content-Digest of a tag, or
 * nothing (a 404 included). Callers decide what an empty digest means.
 */
export const MANIFEST_DIGEST_SH = `digest() { curl -fsSI -H "Accept: ${MANIFEST_ACCEPT}" "http://$1/v2/$2/manifests/$3" 2>/dev/null | tr -d '\\r' | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}'; }`;
