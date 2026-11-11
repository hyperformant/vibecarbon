/**
 * The address a k8s cluster's domain records point at.
 *
 * Hetzner and Linode give each cluster a floating (reserved) IP, which the
 * program outputs as `floatingIp`. A DigitalOcean cluster has none
 * (`K8S_FLOATING_IP = false`): its records point at the master droplet's own
 * public IPv4, as DigitalOcean compose's do. On DigitalOcean a reserved IP
 * never moved: failover flips DNS between the two clusters and a resize keeps
 * the droplet's address, so it bought nothing, and assigning it could fail on
 * an event the API never shows (`422 Droplet already has a pending event`,
 * run 42401297085).
 *
 * One definition for every reader: the DNS writers (single k8s,
 * k8s/dns-record.js, and k8s-ha, effects/k8s-ha.js), the success save that
 * records it as `ingressIp`, failover's DNS flip and the completion summary.
 * `ingressIp` is the record's own key, apart from `floatingIp`, which names
 * only a floating or reserved IP the environment holds: destroy releases
 * that one by address, and must never be handed a droplet's own IP. A record
 * saved before `ingressIp` existed falls back to its floating IP, then its
 * master.
 *
 * @param {{ingressIp?: string|null, floatingIp?: string|null, masterIp?: string|null}|null|undefined} cluster
 *   A deploy result, an infra-ready signal, or a persisted record.
 * @returns {string|null}
 */
export function clusterIngressIp(cluster) {
  return cluster?.ingressIp || cluster?.floatingIp || cluster?.masterIp || null;
}

/**
 * The floating IP a cluster's `k3s-infra` result names, on a provider whose
 * clusters have one (`K8S_FLOATING_IP`), else none.
 *
 * A DigitalOcean cluster made before 2026-11 saved its reserved IP as
 * `floatingIp` in that result, and a deploy whose infra inputs did not change
 * skips the step and reads the saved result back. Taken as is, the reserved
 * IP would be the cluster's ingress again (clusterIngressIp prefers it), and
 * the domain would stay on an address the deploy is about to release. The
 * environment's record keeps naming that address (`floatingIp`) until the
 * release, which reads it from there (retired-reserved-ip.js).
 *
 * @param {{floatingIp?: string|null}|null|undefined} infra - the `k3s-infra` step result
 * @param {{K8S_FLOATING_IP?: boolean}} Provider
 * @returns {string|undefined}
 */
export function infraFloatingIp(infra, Provider) {
  if (Provider?.K8S_FLOATING_IP === false) return undefined;
  return infra?.floatingIp || undefined;
}
