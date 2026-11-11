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
 * recorded one by address as before.
 *
 * Every path that runs `up` or a preview calls this first, before the
 * refresh (upStack's prepareStackForUp, convergeClusterInfra's preview), via
 * `dropRetiredStackResources` in ./index.js. The list per provider is
 * `RETIRED_STACK_RESOURCES` on the provider class.
 */

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
 * every reference to it: `dependencies`, `propertyDependencies`,
 * `deletedWith`, a child's `parent` (moved to the removed resource's own
 * parent) and pending operations on it. `pulumi stack import` verifies the
 * snapshot's integrity and refuses a dangling reference, so a removal that
 * left one would fail the import rather than the up after it. Pure: returns a
 * new deployment, `removed` empty (and the same content) when nothing
 * matched.
 *
 * @param {{ deployment?: { resources?: object[], pending_operations?: object[] } }} state - exportStack's result
 * @param {readonly RetiredResource[]} retired
 * @returns {{ deployment: object, removed: string[] }} `removed`: the URNs taken out, once each
 */
export function dropStackResources(state, retired) {
  const next = structuredClone(state);
  const resources = next?.deployment?.resources;
  if (!Array.isArray(resources) || retired.length === 0) {
    return { deployment: next, removed: [] };
  }
  const isRetired = (r) =>
    retired.some((spec) => r?.type === spec.type && logicalName(r?.urn) === spec.name);
  const gone = resources.filter(isRetired);
  if (gone.length === 0) return { deployment: next, removed: [] };

  const goneUrns = new Set(gone.map((r) => r.urn));
  // A child of a removed resource moves to that resource's parent; follow the
  // chain in case a removed resource's parent was removed too.
  const parentOf = new Map(gone.map((r) => [r.urn, r.parent]));
  const survivingParent = (urn) => {
    let p = urn;
    while (p && goneUrns.has(p)) p = parentOf.get(p);
    return p;
  };

  const kept = resources.filter((r) => !goneUrns.has(r?.urn));
  for (const r of kept) {
    if (Array.isArray(r.dependencies)) {
      r.dependencies = r.dependencies.filter((u) => !goneUrns.has(u));
    }
    if (r.propertyDependencies && typeof r.propertyDependencies === 'object') {
      for (const [key, urns] of Object.entries(r.propertyDependencies)) {
        if (Array.isArray(urns)) r.propertyDependencies[key] = urns.filter((u) => !goneUrns.has(u));
      }
    }
    if (r.deletedWith && goneUrns.has(r.deletedWith)) delete r.deletedWith;
    if (r.parent && goneUrns.has(r.parent)) {
      const parent = survivingParent(r.parent);
      if (parent) r.parent = parent;
      else delete r.parent;
    }
  }
  next.deployment.resources = kept;
  // An operation a crashed run left pending on a removed resource would name
  // a URN the snapshot no longer holds.
  if (Array.isArray(next.deployment.pending_operations)) {
    next.deployment.pending_operations = next.deployment.pending_operations.filter(
      (op) => !goneUrns.has(op?.resource?.urn),
    );
  }
  return { deployment: next, removed: [...goneUrns] };
}
