/**
 * Paid-engine surface manifest for Vibecarbon.
 *
 * Vibecarbon ships everything in the public FSL npm package today — the
 * license gate is a runtime check (see ./index.js, ./tiers.js), not a
 * packaging boundary. This module DECLARES where the paid-tier deploy
 * engines (Compose HA, Kubernetes, Kubernetes HA) live as data, so that:
 *
 *   1. `scripts/check-paid-boundary.js` can enforce at lint time that free
 *      code only reaches into paid engines through their entry points, and
 *   2. a future Sidekiq-style split (paid engines fetched from a
 *      license-authenticated registry) is a mechanical extraction instead
 *      of an archaeology project.
 *
 * This is a seam, not a split. As of this writing:
 *   - No files have moved.
 *   - The orchestrator (src/lib/deploy/orchestrator.js) is NOT untangled
 *     from paid effects — it still calls through the free/paid effect
 *     registry uniformly.
 *   - `src/lib/deploy/effects/index.js` (~line 341-362) statically spreads
 *     the paid effect sets (compose-ha, k8s, k8s-ha) into one map. THAT
 *     static spread is the seam a future split would cut to lazy-load paid
 *     effects only when a license authorizes them. It is intentionally
 *     left alone here — no lazy loading, no dynamic registry.
 *   - Entry points below are NOT narrowed today; they're the contract a
 *     split would freeze.
 *   - No per-file license headers are added.
 *
 * Keep this file, PAID_SURFACE, and PAID_ENTRY_POINTS in sync with the
 * tree by hand — `tests/unit/licensing/paid-surface.test.ts` fails the
 * build if any listed path stops existing (catches rot on renames), and
 * `scripts/check-paid-boundary.js` fails if free code reaches past an
 * entry point into engine internals.
 */

/**
 * Repo-relative paths / dir-prefixes of paid-engine source, keyed by engine
 * id. A path ending in `/` is a directory prefix (everything under it is
 * in-surface); otherwise it's an exact file.
 *
 * @type {Record<'compose-ha' | 'k8s' | 'k8s-ha' | 'ha-common', string[]>}
 */
export const PAID_SURFACE = {
  // Kubernetes (single-cluster + the k8s-specific IaC program + scale
  // planning that only k8s modes need).
  k8s: ['src/lib/deploy/k8s/', 'src/lib/iac/programs/hetzner-k8s.js', 'src/lib/scale-plan.js'],

  // Compose HA (the standby/replication-aware compose path).
  'compose-ha': ['src/lib/deploy/compose/ha.js', 'src/lib/deploy/effects/compose-ha.js'],

  // Kubernetes HA. Note: the plain-k8s effects file (effects/k8s.js) is
  // filed under the `k8s` engine's directory but is itself only the
  // effects-registry adapter for src/lib/deploy/k8s/ — it's listed here
  // explicitly (not under the k8s dir prefix above) because it's a
  // standalone file, not part of src/lib/deploy/k8s/.
  'k8s-ha': ['src/lib/deploy/effects/k8s-ha.js', 'src/lib/deploy/effects/k8s.js'],

  // Shared across both HA flavors (compose-ha and k8s-ha): replication,
  // the wireguard tunnel used for cross-region standby traffic, and the
  // failover command itself.
  'ha-common': ['src/lib/deploy/replication.js', 'src/lib/deploy/wireguard.js', 'src/failover.js'],
};

/**
 * Paid-tier template assets scaffolded into user projects (carbon/).
 * Declaration only — nothing enforces these yet. A future split would need
 * to fetch these from the license-authenticated registry alongside the
 * engine source above.
 */
export const PAID_TEMPLATE_ASSETS = ['carbon/k8s/', 'carbon/ha/', 'carbon/cloud-init/k3s/'];

/**
 * The only paid-surface files free code may import from. Anything else
 * inside PAID_SURFACE is an engine internal — free code reaching past an
 * entry point is exactly the drift this manifest exists to catch.
 *
 * Files inside PAID_SURFACE may import each other (and their own entry
 * points) freely; this list only constrains imports from OUTSIDE the
 * surface.
 *
 * `src/failover.js` is both a PAID_SURFACE file (ha-common) and its own
 * entry point: it's the direct target of `vibecarbon failover` dispatch
 * from src/cli.js and of the identifyServers() reach from src/restore.js,
 * the same "engine index doubles as the entry point" pattern as
 * src/lib/deploy/k8s/index.js and src/lib/deploy/compose/ha.js below.
 *
 * `src/failover.js` also contains `failoverSingleServer()` (src/failover.js:762),
 * the FREE single-server Compose recovery guide (`failover` is a no-op there;
 * it just prints backup/restore steps — see gate.js, which never charges
 * single-server Compose). That function is free-tier code living inside a
 * paid-surface file because the command dispatches to one module regardless
 * of mode. On a future split, extract `failoverSingleServer()` out to free
 * code BEFORE moving the rest of this file behind the license-authenticated
 * registry — otherwise the free recovery path would ship as paid.
 */
export const PAID_ENTRY_POINTS = [
  'src/lib/deploy/effects/compose-ha.js',
  'src/lib/deploy/effects/k8s.js',
  'src/lib/deploy/effects/k8s-ha.js',
  'src/lib/deploy/compose/ha.js',
  'src/lib/deploy/k8s/index.js',
  'src/lib/deploy/k8s/gitops-deploy.js',
  'src/lib/deploy/replication.js',
  'src/lib/deploy/wireguard.js',
  'src/failover.js',
  'src/lib/scale-plan.js',
  'src/lib/iac/programs/hetzner-k8s.js',
];
