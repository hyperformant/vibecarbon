/**
 * DNS-provider registry + dispatch.
 *
 * Single source of truth for automated-DNS backends, mirroring
 * providers/index.js#PROVIDERS on the compute axis. Each `DNS_PROVIDERS`
 * row maps a DNS provider id to its backend module (uniform surface:
 * getZones, setupSimple, setupHA, upsertApexAndWildcard, createDNSRecord,
 * deleteDNSRecord, deleteApexAndWildcard — contract-tested), the operator
 * credential env var, and the compute provider whose token it can alias.
 *
 * Dispatch is throw-on-unknown: 'manual' and unrecognized ids are ERRORS
 * here — callers gate automated-DNS flows behind `hasAutomatedDns(id)`
 * first. The pre-convergence silent fallback (everything non-cloudflare
 * resolved to the hetzner module) is deliberately gone — same
 * de-defaulting doctrine as the compute axis (2026-08-08 DNS seam
 * convergence; the dns-seam-audit plan).
 *
 * The same-token rule: a compute-backed DNS provider (hetzner,
 * digitalocean, linode, vultr, scaleway) uses the SAME API token as its
 * compute sibling — `resolveDnsToken` aliases the in-hand compute token when
 * the clouds match and falls back to the row's tokenEnv otherwise. Cloudflare
 * has no compute sibling and always resolves from its env.
 */

import { readOperatorVar } from './operator-env.js';

/**
 * @typedef {object} DnsProviderRow
 * @property {string} name - Human-readable label for menus and messages.
 * @property {string} modulePath - Backend module specifier relative to this
 *   file; every row follows `./<id>-dns.js` (the registration census and
 *   the contract test walk this).
 * @property {string} tokenEnv - Operator credential env var. For
 *   compute-backed rows this is byte-identical to PROVIDERS[id].TOKEN_ENV —
 *   lockstep-pinned in tests/unit/lib/dns-provider.test.ts.
 * @property {string|null} computeProviderId - Compute provider whose token
 *   this backend aliases (the same-token rule), or null (cloudflare).
 * @property {'zone-id'|'domain-name'|'numeric-id'} zoneIdKind - What the
 *   opaque zoneId string means on this provider's wire (informational:
 *   callers must treat zoneId as opaque either way).
 */

/** @type {Record<string, DnsProviderRow>} */
export const DNS_PROVIDERS = {
  hetzner: {
    name: 'Hetzner DNS',
    modulePath: './hetzner-dns.js',
    tokenEnv: 'HETZNER_API_TOKEN',
    computeProviderId: 'hetzner',
    zoneIdKind: 'zone-id',
  },
  cloudflare: {
    name: 'Cloudflare',
    modulePath: './cloudflare-dns.js',
    tokenEnv: 'CLOUDFLARE_API_TOKEN',
    computeProviderId: null,
    zoneIdKind: 'zone-id',
    // The only backend with deploy-created health checks (setupSimple /
    // setupHA create them; destroy's preview + cleanup key off this flag —
    // the module capability is the paired deleteHealthCheck export).
    healthChecks: true,
    // Interactive token-onboarding module (guide + verify + save offer).
    // Most native rows have none: they alias the compute token, so there is
    // nothing to onboard. Scaleway is the exception — see its row.
    guidedSetupModulePath: './cloudflare-guided-setup.js',
  },
  digitalocean: {
    name: 'DigitalOcean DNS',
    modulePath: './digitalocean-dns.js',
    tokenEnv: 'DIGITALOCEAN_API_TOKEN',
    computeProviderId: 'digitalocean',
    zoneIdKind: 'domain-name',
  },
  linode: {
    name: 'Linode DNS',
    modulePath: './linode-dns.js',
    tokenEnv: 'LINODE_API_TOKEN',
    computeProviderId: 'linode',
    zoneIdKind: 'numeric-id',
  },
  vultr: {
    name: 'Vultr DNS',
    modulePath: './vultr-dns.js',
    tokenEnv: 'VULTR_API_TOKEN',
    computeProviderId: 'vultr',
    zoneIdKind: 'domain-name',
  },
  scaleway: {
    name: 'Scaleway DNS',
    modulePath: './scaleway-dns.js',
    tokenEnv: 'SCALEWAY_SECRET_KEY',
    computeProviderId: 'scaleway',
    // The zoneId carries the DNS ZONE NAME ("example.com", or "s1.example.com"
    // for a sub-zone) — Scaleway addresses records at
    // /dns-zones/{dns_zone}/records and has no zone UUID.
    zoneIdKind: 'domain-name',
    // The ONE native row with a guided setup, and the reason is structural
    // rather than cosmetic: Scaleway's credential is a TRIPLE (secret key +
    // access key + Project ID), so the same-token rule only ever hands over
    // one third of it. A cross-cloud pick (say Hetzner compute, Scaleway DNS)
    // has none of it in hand, and external-domain onboarding needs the
    // Project ID that the plain password prompt would never collect. The
    // module is the same one the Providers menu drives.
    guidedSetupModulePath: './scaleway-guided-setup.js',
  },
};

/**
 * @param {string} dnsProvider
 * @returns {DnsProviderRow}
 * @throws {Error} on manual/unknown/absent ids — callers gate automated
 *   flows behind `hasAutomatedDns` first; reaching here with 'manual' is a
 *   caller bug, not a user error.
 */
function dnsRowOrThrow(dnsProvider) {
  const row = DNS_PROVIDERS[dnsProvider];
  if (!row) {
    throw new Error(
      `Unknown DNS provider '${dnsProvider}'. Automated DNS providers: ` +
        `${Object.keys(DNS_PROVIDERS).sort().join(', ')}. ` +
        `Use 'manual' (and manage records yourself) if your DNS host is not listed.`,
    );
  }
  return row;
}

/**
 * True iff the id names a registered automated-DNS backend. 'manual' and
 * unknown ids are false — the one sanctioned way to branch on "is DNS
 * automated here" (a src-wide census bans literal `dnsProvider === '...'`
 * comparisons outside this file).
 *
 * @param {string|null|undefined} dnsProvider
 * @returns {boolean}
 */
export function hasAutomatedDns(dnsProvider) {
  return Boolean(dnsProvider) && Object.hasOwn(DNS_PROVIDERS, dnsProvider);
}

/**
 * Resolve a DNS provider id to its backend module.
 *
 * @param {string} dnsProvider - A DNS_PROVIDERS key
 * @returns {Promise<object>} the backend module (uniform contract surface)
 * @throws {Error} on manual/unknown ids (synchronously — before the import)
 */
export function getDnsProvider(dnsProvider) {
  const row = dnsRowOrThrow(dnsProvider);
  return import(row.modulePath);
}

/**
 * Resolve the API token for a DNS provider under the same-token rule:
 * when the DNS backend and the deploy's compute provider are the same
 * cloud, the in-hand compute token IS the DNS token (native DNS needs zero
 * extra credentials); otherwise the token comes from the row's env var.
 * Returns null when unavailable — callers fail loudly with setup guidance
 * or degrade to manual DNS, never silently borrow another cloud's token.
 *
 * @param {string} dnsProvider - A DNS_PROVIDERS key
 * @param {object} [ctx]
 * @param {string} [ctx.computeProviderId]
 * @param {string} [ctx.computeToken]
 * @returns {string|null}
 */
export function resolveDnsToken(dnsProvider, { computeProviderId, computeToken } = {}) {
  const row = dnsRowOrThrow(dnsProvider);
  if (row.computeProviderId && row.computeProviderId === computeProviderId && computeToken) {
    return computeToken;
  }
  return readOperatorVar(row.tokenEnv).value;
}

/**
 * The `operator-env.js` scopes/keys a deploy must validate for a given DNS
 * selection, BEFORE any DNS credential is read for real (a zone lookup, the
 * guided-setup's live verify) — mirrors `resolveDnsToken`'s own same-token
 * comparison exactly, so a scope is asked for if and only if
 * `resolveDnsToken` would actually go read something for it.
 *
 * Three cases:
 *   - Not automated (manual/unknown/absent `dnsProvider`): nothing to check.
 *   - Same-token rule applies (`row.computeProviderId === computeProviderId`,
 *     e.g. Hetzner compute + Hetzner DNS): the DNS backend reads the SAME
 *     token this deploy's own `provider:<computeProviderId>` scope already
 *     covers — no separate scope or key.
 *   - Backend has no compute sibling (Cloudflare): its own scope
 *     (`dns:<dnsProvider>`), which validates every key registered under it.
 *   - Cross-cloud NATIVE DNS (e.g. DigitalOcean compute + Hetzner DNS —
 *     `row.computeProviderId` truthy but NOT this deploy's compute
 *     provider): `resolveDnsToken` falls through to the row's lone
 *     `tokenEnv`, read from a DIFFERENT provider's env var that no scope
 *     this deploy uses otherwise covers. Checking that ONE key (not the
 *     whole `provider:<row.computeProviderId>` scope) is deliberate — the
 *     whole scope would additionally demand that OTHER cloud's S3/
 *     object-storage keys, which this deploy never reads.
 *
 * @param {string|null|undefined} dnsProvider
 * @param {string|null|undefined} computeProviderId - providerIdFor(...) of
 *   THIS deploy's resolved compute provider.
 * @returns {{ scopes: string[], keys: string[] }}
 */
export function operatorConfigForDns(dnsProvider, computeProviderId) {
  if (!hasAutomatedDns(dnsProvider)) return { scopes: [], keys: [] };
  const row = DNS_PROVIDERS[dnsProvider];
  if (!row.computeProviderId) {
    return { scopes: [`dns:${dnsProvider}`], keys: [] };
  }
  if (row.computeProviderId !== computeProviderId) {
    return { scopes: [], keys: [row.tokenEnv] };
  }
  return { scopes: [], keys: [] };
}

/**
 * The shared middle of every operator-config-hygiene gate that has ALREADY
 * resolved a provider/DNS pair: "this provider's own scope, plus whatever
 * its DNS backend needs" — `provider:<providerId>` (skipped when no
 * provider is known yet) plus `operatorConfigForDns`'s scopes/keys (skipped
 * when no DNS provider is known, or when `providerId` is absent — the
 * cross-cloud/same-token logic above needs a compute provider to compare
 * against).
 *
 * Extracted so Gate 1 (`src/deploy.js`, before `gatherDeploymentConfig`'s
 * first network call) and `status`'s Configuration line (`src/status.js`)
 * derive the exact same scopes/keys for the exact same provider+DNS pair
 * instead of two hand-rolled copies of this `if` pair drifting apart.
 * Callers still add their own always-known scopes (`access`/`tls`/`state`,
 * `registry`) and pick their own `presence` — this only knows about the
 * provider/DNS half.
 *
 * @param {string|null|undefined} providerId
 * @param {string|null|undefined} dnsProvider
 * @returns {{ scopes: string[], keys: string[] }}
 */
export function operatorScopesForProviderAndDns(providerId, dnsProvider) {
  const scopes = [];
  const keys = [];
  if (providerId) scopes.push(`provider:${providerId}`);
  if (dnsProvider && providerId) {
    const dns = operatorConfigForDns(dnsProvider, providerId);
    scopes.push(...dns.scopes);
    keys.push(...dns.keys);
  }
  return { scopes, keys };
}

/**
 * Optional interactive guided-setup module for a DNS provider's token
 * (onboarding guide + live verification + save-to-.env.local offer).
 * Returns null when the row has none — callers fall back to a plain
 * password prompt.
 *
 * @param {string} dnsProvider - A DNS_PROVIDERS key
 * @returns {Promise<object>|null}
 */
export function getDnsGuidedSetup(dnsProvider) {
  const row = dnsRowOrThrow(dnsProvider);
  return row.guidedSetupModulePath ? import(row.guidedSetupModulePath) : null;
}

/**
 * Find which REGISTERED backend already serves `domain`, by asking every one
 * whose credential is in hand and keeping the most specific zone found.
 *
 * Exists for Scaleway's external-domain onboarding, where the ownership TXT
 * must be published at the domain's CURRENT DNS host — a host that is very
 * often another backend we already drive, in which case the CLI can write the
 * record itself instead of printing instructions. Registry-driven on purpose:
 * the caller never learns a provider id it has to branch on, and a sixth
 * backend becomes a candidate host automatically.
 *
 * Failures are per-backend and silent: a revoked token or an unreachable API
 * means "not this one", never an aborted search. Callers treat null as "we
 * don't manage this domain's DNS" and fall back to manual instructions.
 *
 * @param {string} domain - FQDN to locate (trailing dot tolerated)
 * @param {object} [options]
 * @param {string[]} [options.exclude] - backend ids to skip (e.g. the backend
 *   the domain is being MOVED to, which by definition does not serve it yet)
 * @param {string} [options.computeProviderId] - same-token-rule context
 * @param {string} [options.computeToken] - same-token-rule context
 * @returns {Promise<{providerId: string, token: string, zone: {id: string|number, name: string}}|null>}
 */
export async function locateDomainBackend(domain, options = {}) {
  const { exclude = [], computeProviderId, computeToken } = options;
  let best = null;

  for (const id of Object.keys(DNS_PROVIDERS)) {
    if (exclude.includes(id)) continue;
    const token = resolveDnsToken(id, { computeProviderId, computeToken });
    if (!token) continue;

    let zone = null;
    try {
      const { getZones } = await getDnsProvider(id);
      zone = findZoneForDomain(await getZones(token), domain);
    } catch {
      continue;
    }
    if (!zone) continue;

    // Most-specific wins ACROSS backends too, for the same reason it does
    // within one: a delegated child zone is the only place a record for that
    // subtree is actually served from.
    if (!best || String(zone.name).length > String(best.zone.name).length) {
      best = { providerId: id, token, zone };
    }
  }

  return best;
}

/**
 * Pick the zone that serves `domain` from a backend's getZones() result —
 * the ONE zone-matching rule for every consumer (deploy prompts'
 * auto-discovery, destroy's pre-persist fallback).
 *
 * Two properties, both load-bearing:
 *  - Label boundary, never bare endsWith: `d1.evilappcarbon.dev` must NOT
 *    match zone `appcarbon.dev` (bare endsWith reaches into a stranger's
 *    zone; the e2e preflight's zoneCovers pins the same rule test-side).
 *  - MOST-SPECIFIC wins, not first-found: an account holding both
 *    `appcarbon.dev` and `do.appcarbon.dev` must resolve
 *    `d1.do.appcarbon.dev` to the child zone regardless of listing order
 *    (find(endsWith) was order-dependent — records written into the parent
 *    zone are invisible to the delegated child's nameservers).
 *
 * @param {Array<{id: string|number, name: string}>} zones
 * @param {string} domain - FQDN (trailing dot tolerated)
 * @returns {{id: string|number, name: string}|null}
 */
export function findZoneForDomain(zones, domain) {
  const clean = String(domain).replace(/\.$/, '');
  let best = null;
  let bestLength = -1;
  for (const zone of zones || []) {
    const zoneName = String(zone.name).replace(/\.$/, '');
    if (clean !== zoneName && !clean.endsWith(`.${zoneName}`)) continue;
    if (zoneName.length > bestLength) {
      best = zone;
      bestLength = zoneName.length;
    }
  }
  return best;
}
