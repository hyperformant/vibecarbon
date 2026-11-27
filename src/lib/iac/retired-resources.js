/**
 * Take resources a program no longer declares out of a stack's state, so
 * Pulumi never deletes them.
 *
 * The case it exists for: DigitalOcean k8s clusters made before 2026-11 hold
 * a reserved IP (`ReservedIp('ingress')`) assigned to the master
 * (`ReservedIpAssignment('ingress-assignment')`), and today's program makes
 * neither (`DigitalOceanProvider.K8S_FLOATING_IP = false`). Left in state,
 * the next `up` or preview plans to delete both, and the delete is what we
 * must not run:
 *   - the unassign ends the address's traffic at once, while the domain's
 *     records still point at it until DNS moves and caches expire;
 *   - the assignment's delete is the same droplet action that failed deploys
 *     with `422 Droplet already has a pending event` (run 42401297085), and
 *     the provider's Delete dereferences the IP's droplet without a nil check
 *     (terraform-provider-digitalocean resource_reserved_ip_assignment.go);
 *   - and `vibecarbon scale` and `vibecarbon failover` converge the same
 *     program, so they would delete the address without moving DNS at all.
 *
 * Dropped from state, the address stays assigned to the master and keeps
 * serving. The deploy releases it by address once DNS has moved off it
 * (lib/deploy/k8s/retired-reserved-ip.js), and destroy's backstop releases a
 * recorded one by address as before. Both read the address from the
 * environment's record, so the surgery hands every address it takes out to
 * a recorder before the import: an environment saved before the record kept
 * it would otherwise lose the only trace of an address it still pays for.
 *
 * Every path that runs `up` or a preview calls this first, before the
 * refresh (upStack's prepareStackForUp, convergeClusterInfra's preview), via
 * `dropRetiredStackResources` in ./index.js. The list per provider is
 * `RETIRED_STACK_RESOURCES` on the provider class.
 */

import { dropResourcesByUrn } from './state-drop.js';

/**
 * @typedef {{ type: string, name: string }} RetiredResource
 *   A resource's type token and its logical name (the URN's last segment).
 */

/** The logical name a URN ends with (`urn:pulumi:<stack>::<proj>::<type>::<name>`). */
function logicalName(urn) {
  const parts = String(urn ?? '').split('::');
  return parts[parts.length - 1];
}

/**
 * Remove every resource matching `retired` from an exported deployment, and
 * every reference to it (dropResourcesByUrn, ./state-drop.js). Pure: returns
 * a new deployment, `removed` empty (and the same content) when nothing
 * matched.
 *
 * @param {{ deployment?: { resources?: object[], pending_operations?: object[] } }} state - exportStack's result
 * @param {readonly RetiredResource[]} retired
 * @returns {{ deployment: object, removed: string[], addresses: string[] }}
 *   `removed`: the URNs taken out, once each. `addresses`: the IP addresses
 *   those resources held (`outputs.ipAddress`), once each.
 */
export function dropStackResources(state, retired) {
  const resources = state?.deployment?.resources;
  const isRetired = (r) =>
    retired.some((spec) => r?.type === spec.type && logicalName(r?.urn) === spec.name);
  const gone = Array.isArray(resources) ? resources.filter(isRetired) : [];
  const { deployment, removed } = dropResourcesByUrn(
    state,
    gone.map((r) => r.urn),
  );
  if (removed.length === 0) return { deployment, removed, addresses: [] };
  const addresses = [
    ...new Set(
      gone.map((r) => r?.outputs?.ipAddress).filter((a) => typeof a === 'string' && a !== ''),
    ),
  ];
  return { deployment, removed, addresses };
}
