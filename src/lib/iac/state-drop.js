/**
 * Take resources out of an exported Pulumi deployment by URN, with every
 * reference to them, so `pulumi stack import` accepts what is left.
 *
 * The state surgery's one way to drop a resource: the retired-resource
 * surgery (./retired-resources.js) and the Vultr pre-refresh prune
 * (./vultr-gone-resources.js) both go through it.
 */

/**
 * Remove every resource whose URN is in `urns` from an exported deployment,
 * and every reference to it: `dependencies`, `propertyDependencies`,
 * `deletedWith`, a child's `parent` (moved to the removed resource's own
 * parent) and pending operations on it. `pulumi stack import` verifies the
 * snapshot's integrity and refuses a dangling reference, so a removal that
 * left one would fail the import rather than the up after it. Pure: returns a
 * new deployment, `removed` empty (and the same content) when nothing
 * matched.
 *
 * @param {{ deployment?: { resources?: object[], pending_operations?: object[] } }} state - exportStack's result
 * @param {Iterable<string>} urns
 * @returns {{ deployment: object, removed: string[] }} `removed`: the URNs
 *   taken out, once each, in state order.
 */
export function dropResourcesByUrn(state, urns) {
  const next = structuredClone(state);
  const resources = next?.deployment?.resources;
  const wanted = new Set(urns);
  if (!Array.isArray(resources) || wanted.size === 0) return { deployment: next, removed: [] };
  const gone = resources.filter((r) => wanted.has(r?.urn));
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
      for (const [key, deps] of Object.entries(r.propertyDependencies)) {
        if (Array.isArray(deps)) r.propertyDependencies[key] = deps.filter((u) => !goneUrns.has(u));
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
