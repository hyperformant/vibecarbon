/**
 * Per-run DNS names for the real-infrastructure e2e harness.
 *
 * Each run serves its scenarios from `<envPrefix>-<runTag>.<baseDomain>`, a
 * name no earlier run used. Two reasons:
 *   - DNS providers keep a "doesn't exist" answer for up to 30 minutes for a
 *     name looked up while absent, so reusing the name a previous run just
 *     destroyed can fail validation.
 *   - Let's Encrypt production allows 5 identical certificates per week per
 *     exact name set.
 *
 * The env name (`envPrefix`) is unchanged: it still names Pulumi stacks and
 * every other resource. Only the DNS name carries the tag. This is separate
 * from E2E_NAMESPACE (namespace.ts), which remaps the env prefix itself.
 */

/** First 6 lowercase hex characters of the run id, computed once per run. */
export function runTagFor(runId: string): string {
  return runId.slice(0, 6).toLowerCase();
}

export function scenarioDomain(envPrefix: string, runTag: string, baseDomain: string): string {
  return `${envPrefix}-${runTag}.${baseDomain}`;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * True when a DNS record name belongs to this env: `<envPrefix>` or
 * `<envPrefix>-<6 hex>` directly under the base domain, optionally as the
 * wildcard `*.` form. Lookalikes (`d40`, `d4-xyz`, 7-hex tags, deeper
 * subdomains, other zones) do not match, so a crashed run's names are found
 * without touching a neighbour's.
 */
export function dnsNameBelongsToEnv(name: string, envPrefix: string, baseDomain: string): boolean {
  const re = new RegExp(
    `^(?:\\*\\.)?${escapeRe(envPrefix)}(?:-[0-9a-f]{6})?\\.${escapeRe(baseDomain)}\\.?$`,
  );
  return re.test(name);
}
