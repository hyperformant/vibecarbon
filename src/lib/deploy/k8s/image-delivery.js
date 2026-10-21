/**
 * Pure helpers for delivering the app image to a k8s cluster's local registry.
 * A k8s-ha standby takes the primary's image by copy instead of building its own.
 */

const LOCAL_REGISTRY_REF = /^([^/\s]+:5000)\/([^\s:]+(?:\/[^\s:]+)*):([^\s/:]+)$/;

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

/** The primary's image ref re-prefixed for the standby master's registry. */
export function standbyImageRef({ primaryRef, standbyMasterPrivateIp }) {
  if (!standbyMasterPrivateIp) throw new Error('standbyMasterPrivateIp is required');
  const { repoTag } = parseLocalRegistryRef(primaryRef);
  return `${standbyMasterPrivateIp}:5000/${repoTag}`;
}

/** What a deploy does about the app image, by HA role. Only a standby copies. */
export function planImageDelivery({ role } = {}) {
  if (role === 'standby') {
    return { build: false, sideload: false, registryPush: false, awaitPeerImage: true };
  }
  return { build: true, sideload: true, registryPush: true, awaitPeerImage: false };
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
