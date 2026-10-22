/**
 * Why a k8s rollout timed out, when the cause is a mirror package nobody can
 * pull.
 *
 * Every node pulls k3s's own system images (pause, coredns, ...) under the
 * K3S_SYSTEM_REGISTRY alias, which registries.yaml rewrites onto
 * ghcr.io/hyperformant, and the core-path images straight from
 * ghcr.io/hyperformant. Servers pull anonymously, so a mirror package that is
 * still private fails every pull with 401. A private pause image fails every
 * pod sandbox, so the first wait on a pod (the local-registry rollout) times
 * out with nothing but "did not complete". This reads the cluster's events
 * once, read-only and bounded, and names the packages that must be public.
 */
import { K3S_SYSTEM_REGISTRY, K8S_MIRROR_ORG, mirroredImageName } from '../../images.js';

/** One `kubectl get events`, all namespaces, with a request timeout. */
export const MIRROR_PULL_EVENTS_ARGV = [
  'kubectl',
  'get',
  'events',
  '-A',
  '--no-headers',
  '-o',
  'custom-columns=NS:.metadata.namespace,OBJECT:.involvedObject.name,REASON:.reason,MESSAGE:.message',
  '--request-timeout=20s',
];

const PULL_FAILED =
  /failed to pull|ErrImagePull|ImagePullBackOff|Back-off pulling image|failed to get sandbox image|unauthorized|pull access denied/i;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MIRROR_REF = new RegExp(
  `(${escapeRegExp(K3S_SYSTEM_REGISTRY)}|${escapeRegExp(K8S_MIRROR_ORG)})/([a-z0-9._/-]+?)[:@"]`,
  'g',
);

/**
 * @param {string} eventsText - `kubectl get events` output, one event per line
 * @returns {string|null} the cause and the packages to make public, or null
 *   when no event shows a failed pull of a mirror image
 */
export function mirrorPullFailureHint(eventsText) {
  const packages = new Set();
  let systemImage = false;
  for (const line of String(eventsText ?? '').split('\n')) {
    if (!PULL_FAILED.test(line) || /Successfully pulled/i.test(line)) continue;
    for (const [, registry, repo] of line.matchAll(MIRROR_REF)) {
      if (registry === K3S_SYSTEM_REGISTRY) systemImage = true;
      packages.add(`${K8S_MIRROR_ORG}/${mirroredImageName(repo)}`);
    }
  }
  if (packages.size === 0) return null;
  const what = systemImage
    ? `a k3s system image (named under ${K3S_SYSTEM_REGISTRY}, served from the ghcr mirror) failed to pull`
    : 'a ghcr mirror image failed to pull';
  return (
    `${what}. Servers pull mirror packages without credentials, so these must be public: ` +
    `${[...packages].sort().join(', ')}`
  );
}
