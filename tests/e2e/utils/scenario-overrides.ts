/**
 * Scenario-level env overrides for the e2e matrix.
 *
 * The baseline matrix (tests/config.ts) splits DNS providers for coverage:
 * Hetzner scenarios alternate hetzner/cloudflare DNS, and each non-Hetzner
 * cloud that has a delegated e2e zone runs on its OWN native DNS backend
 * (DigitalOcean scenarios on DigitalOcean DNS, Linode on Linode DNS) —
 * exercising every DNS-01 path we ship rather than funnelling them all
 * through Cloudflare. Perf-focused runs (the CI US-region workflow) don't
 * want that split: DNS provider variance adds noise, and a Cloudflare
 * dependency means an extra credential. These knobs let a run pin
 * everything to one provider / one base domain:
 *
 *   E2E_DNS_PROVIDER=hetzner   → every scenario uses Hetzner DNS
 *   E2E_DOMAIN=carbonstack.dev → every scenario's base domain (env prefixes
 *                                still namespace subdomains: ci1.<domain>…)
 *
 * Both are no-ops when unset — the local matrix keeps its coverage split.
 */

/**
 * DNS backends a run may be pinned to. Mirrors the `DNS_PROVIDERS` registry
 * in src/lib/dns-provider.js minus `manual` — pinning the whole matrix to
 * hand-edited DNS is not a thing a run can do.
 *
 * Membership here is NOT a promise that the provider has an e2e base domain:
 * `vultr` is selectable (a scenario may name it once its apex domain is
 * delegated) but has no entry in the domains map yet, so pinning to it fails
 * loudly in `resolveBaseDomain` rather than silently producing `x.undefined`.
 */
const PROVIDERS = ['hetzner', 'cloudflare', 'digitalocean', 'linode', 'vultr'] as const;
export type DnsProvider = (typeof PROVIDERS)[number];

/** Force every scenario onto one DNS provider (E2E_DNS_PROVIDER). */
export function overrideDnsProvider<T extends { dnsProvider: DnsProvider }>(
  scenarios: readonly T[],
  provider: string | undefined,
): readonly T[] {
  const p = provider?.trim();
  if (!p) return scenarios;
  if (!(PROVIDERS as readonly string[]).includes(p)) {
    throw new Error(`E2E_DNS_PROVIDER must be one of ${PROVIDERS.join(', ')}; got '${p}'`);
  }
  return scenarios.map((s) => ({ ...s, dnsProvider: p as DnsProvider }));
}

/**
 * Base domain for a scenario: E2E_DOMAIN override, else the provider map.
 *
 * A DNS provider with no domains-map entry throws. It used to return
 * `undefined`, which the single caller (runner.ts) interpolated into
 * `${envPrefix}.${undefined}` — the scenario then provisioned against the
 * literal domain `d1.undefined`, failing tens of minutes later at cert
 * issuance with an error naming neither the scenario nor the missing key.
 * Every DNS backend in `PROVIDERS` above needs a delegated zone before a
 * scenario can name it; this is where that debt comes due.
 */
export function resolveBaseDomain(
  domains: Readonly<Partial<Record<DnsProvider, string>>>,
  dnsProvider: DnsProvider,
  domainOverride: string | undefined,
): string {
  const d = domainOverride?.trim();
  if (d) return d;
  const mapped = domains[dnsProvider];
  if (!mapped) {
    throw new Error(
      `No e2e base domain configured for DNS provider '${dnsProvider}' — ` +
        `add a '${dnsProvider}' entry to testConfig.e2e.domains (tests/config.ts) ` +
        `pointing at a delegated zone, or set E2E_DOMAIN to override every scenario. ` +
        `Configured: ${Object.keys(domains).join(', ') || '(none)'}.`,
    );
  }
  return mapped;
}
