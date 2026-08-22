/**
 * E2E run namespacing — lets two operators (e.g. a laptop matrix and the CI
 * US-perf workflow) share one Hetzner project + DNS zones without seeing or
 * sweeping each other's resources.
 *
 * `E2E_NAMESPACE=ci` shifts every operator-distinguishing identifier:
 *   - scratch project names:  testapp-<mode>-<ts>  →  citest-<mode>-<ts>
 *   - env prefixes (DNS):     e1..e4               →  ci1..ci4
 *   - preflight residue scan + `scripts/sweep-hetzner.js` scope follow the
 *     same prefix (the sweep derives it independently — plain-JS script —
 *     with unit tests pinning the two derivations together).
 *
 * Unset ⇒ all three fall back to today's literals; local runs are unchanged.
 */

const NAMESPACE_RE = /^[a-z][a-z0-9]{0,7}$/;

/**
 * The validated namespace, or null when none is configured. Throws on a
 * malformed value — the namespace lands in DNS labels and Hetzner resource
 * names, so failing loudly beats deploying with a broken identifier.
 */
export function activeNamespace(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.E2E_NAMESPACE?.trim();
  if (!raw) return null;
  if (!NAMESPACE_RE.test(raw)) {
    throw new Error(
      `E2E_NAMESPACE must match ${NAMESPACE_RE} (lowercase alphanumeric, starts with a letter, ≤8 chars); got '${raw}'`,
    );
  }
  return raw;
}

/** Name prefix for every e2e scratch resource (Hetzner + S3 + project dirs). */
export function scratchNamePrefix(env: NodeJS.ProcessEnv = process.env): string {
  const ns = activeNamespace(env);
  return ns ? `${ns}test-` : 'testapp-';
}

/** Remap a scenario env prefix (`e1`..`e4`) into the namespace (`ci1`..`ci4`). */
export function remapEnvPrefix(envPrefix: string, env: NodeJS.ProcessEnv = process.env): string {
  const ns = activeNamespace(env);
  if (!ns) return envPrefix;
  return `${ns}${envPrefix.replace(/^e/, '')}`;
}

/**
 * The ONE long-lived Pulumi state bucket this host reuses across e2e runs.
 *
 * Every scratch project is named per-run, so without a pin each scenario of
 * each run derives a brand-new state bucket and does all its Pulumi work
 * against a bucket minutes old — the worst window for the state-backend
 * failure class, and an artifact of the harness rather than anything customers
 * hit (a real project's bucket is warm long before it matters).
 *
 * CRITICAL: this must never start with `scratchNamePrefix()`. The orphan sweeps
 * collect that prefix, so a bucket we intend to KEEP would be deleted and
 * counted as a destroy regression on every run. The `vc-` prefix follows the
 * same convention as the standing DigitalOcean Spaces anchor bucket.
 *
 * Override with VC_E2E_STATE_BUCKET: bucket names are global per provider, so
 * two operators sharing a provider account need distinct names — and pointing
 * it at a throwaway value is how you exercise the cold-start path a customer's
 * first deploy really takes.
 */
export function sharedStateBucketName(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.VC_E2E_STATE_BUCKET?.trim();
  if (override) return override;
  return `vc-e2e-state-${activeNamespace(env) ?? 'local'}`;
}
