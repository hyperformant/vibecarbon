/**
 * Source mutations for the `warm-redeploy-change` e2e step.
 *
 * E2E almost always COLD-deploys, so the warm/state-resumed path is the
 * repo's biggest unexercised state space (docs/tests.md, escape class 6).
 * Two real bugs shipped inside it and both were invisible to a green matrix:
 *
 *   - #202 — `k3s-apply`'s skip gate digested only `projectDir/k8s`, never the
 *     CLI's own bundled `carbon/k8s` tree, so a manifest change left every gate
 *     input identical and a state-resumed redeploy SKIPPED the apply.
 *   - #234 — the Supabase chart's PVCs were never pinned to a StorageClass, so
 *     a state-resumed deploy that re-ran `installSupabase` could put PGDATA on
 *     node-local `local-path` instead of the provider CSI. Silent durability
 *     loss: replication, failover and wal-g restore all break with no error.
 *
 * Both are "the gate said nothing changed" bugs, and the only thing that
 * catches that class end-to-end is: change something, redeploy against
 * EXISTING state, and prove the change is live.
 *
 * These mutators are deliberately pure string-in/string-out so the anchoring
 * (the part that silently rots when a template file is reshaped) is unit-tested
 * against the real template fixtures without a cluster. Every one of them
 * THROWS when its anchor is missing rather than returning the input unchanged —
 * a mutation that quietly no-ops would make the whole step assert nothing,
 * which is the vacuous-guard failure mode docs/tests.md warns about.
 *
 * What each mutation targets, and why that target:
 *
 *   - ConfigMap (`k8s/base/config/configmap.yaml`): an ADDITIVE key on
 *     `vibecarbon-config`. Additive because deploy patches `SITE_URL` on this
 *     same object (kubectlPatch) and the base kustomization's `labels` block
 *     propagates to selectors — a new leaf key collides with neither, and
 *     nothing in-cluster reconciles it away. Observable with one jsonpath read.
 *     Deliberately NOT `spec.replicas` on the app Deployment: an HPA owns that
 *     field (`k8s/base/app/hpa.yaml`, minReplicas 2) and would fight us.
 *   - App source (`src/server/routes/health.ts`): an ADDITIVE Hono route. Its
 *     response body is the marker, so "is the new app code serving?" is a
 *     single HTTP GET with no bundle parsing and no browser.
 *
 * Both are ordinary edits a customer makes (add a config key, add a route) —
 * no test-only escape hatch, per the e2e-mirrors-the-customer rule.
 */

/** ConfigMap key carrying the marker. Namespaced so it can never collide. */
export const WARM_REDEPLOY_CONFIGMAP_KEY = 'E2E_WARM_REDEPLOY_MARKER';

/** ConfigMap object the key is added to (base/config/configmap.yaml). */
export const WARM_REDEPLOY_CONFIGMAP_NAME = 'vibecarbon-config';

/** Route path appended to the health router; served at /api/health<this>. */
export const WARM_REDEPLOY_ROUTE_PATH = '/e2e-warm-marker';

/** Full public path of the marker route. */
export const WARM_REDEPLOY_ROUTE_URL_PATH = `/api/health${WARM_REDEPLOY_ROUTE_PATH}`;

/** Project-relative paths the step mutates. */
export const WARM_REDEPLOY_MANIFEST_FILE = 'k8s/base/config/configmap.yaml';
export const WARM_REDEPLOY_APP_FILE = 'src/server/routes/health.ts';

/**
 * Build the marker value. Constrained to `[a-z0-9-]` on purpose: it is
 * embedded in YAML (unquoted-safe), in a TypeScript string literal, and
 * compared byte-for-byte out of an HTTP body and a kubectl jsonpath — no
 * quoting or escaping anywhere in that chain.
 */
export function warmRedeployMarker(seed: string): string {
  const clean = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `e2e-warm-${clean || 'run'}`;
}

/**
 * Insert `<KEY>: "<marker>"` as the first entry of the ConfigMap's `data:`
 * block. Anchors on the top-level `data:` line rather than on any particular
 * existing key, so re-ordering or renaming the map's contents cannot rot this.
 *
 * Idempotent: re-applying with the same marker returns the input unchanged, so
 * a retried step cannot stack duplicate keys (which YAML would reject).
 */
export function mutateConfigMapManifest(yaml: string, marker: string): string {
  const entry = `  ${WARM_REDEPLOY_CONFIGMAP_KEY}: "${marker}"`;
  if (yaml.includes(`${WARM_REDEPLOY_CONFIGMAP_KEY}: "${marker}"`)) return yaml;

  const lines = yaml.split('\n');
  // Drop a previous marker (different value) so a re-run replaces rather than
  // duplicates the key.
  const deduped = lines.filter((l) => !l.trimStart().startsWith(`${WARM_REDEPLOY_CONFIGMAP_KEY}:`));
  const dataIdx = deduped.indexOf('data:');
  if (dataIdx === -1) {
    throw new Error(
      `mutateConfigMapManifest: no top-level \`data:\` line in ${WARM_REDEPLOY_MANIFEST_FILE} — ` +
        'the template was reshaped and this mutation would have silently no-opped.',
    );
  }
  deduped.splice(dataIdx + 1, 0, entry);
  return deduped.join('\n');
}

/**
 * Append a marker route to the health router, immediately before its export.
 * Anchors on the `export { healthRoutes };` statement — the one line that must
 * exist for the module to be a router at all.
 *
 * Idempotent for the same marker, and replaces a stale marker route rather
 * than appending a second one (Hono would serve the first and the assertion
 * would read a stale body).
 */
export function mutateAppHealthRoute(source: string, marker: string): string {
  const route = `healthRoutes.get('${WARM_REDEPLOY_ROUTE_PATH}', (c) => c.text('${marker}'));`;
  if (source.includes(route)) return source;

  const stripped = source
    .split('\n')
    .filter((l) => !l.includes(`healthRoutes.get('${WARM_REDEPLOY_ROUTE_PATH}'`))
    .join('\n');

  const anchor = 'export { healthRoutes };';
  if (!stripped.includes(anchor)) {
    throw new Error(
      `mutateAppHealthRoute: anchor \`${anchor}\` not found in ${WARM_REDEPLOY_APP_FILE} — ` +
        'the template was reshaped and this mutation would have silently no-opped.',
    );
  }
  return stripped.replace(
    anchor,
    `// e2e warm-redeploy marker route — asserts a warm/state-resumed deploy\n` +
      `// rebuilds and ships changed APP SOURCE, not just changed manifests.\n` +
      `${route}\n\n${anchor}`,
  );
}
