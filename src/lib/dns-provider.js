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
 *
 * `DNS_PROVIDERS` and `DNS01_PROVIDERS` stay separate tables: the former
 * answers "which module manages records for this id", the latter "does
 * this id expose a DNS-01 ACME solver, and what does driving it need".
 * A provider can be in the first without the second (records work,
 * certs fall back to HTTP-01).
 */

/**
 * @typedef {object} Dns01ProviderRow
 * @property {string} tokenEnvVar - Env var lego (Traefik's ACME client)
 *   reads for this provider's DNS-01 token (acme.js `dnsChallengeEnv`).
 *   Verified per-provider against go-acme.github.io/lego/dns/&lt;id&gt;/.
 * @property {string} secretName - cert-manager Secret name the provider's
 *   ClusterIssuer's DNS-01 solver reads (k3s.js `buildDnsProviderSecret`).
 * @property {string} secretKey - `stringData` key inside that Secret.
 * @property {string} missingTokenError - Verbatim error thrown by
 *   `buildDnsProviderSecret` when the token is absent — worded so the
 *   failure is actionable at deploy-start.
 * @property {{repoName: string, repoUrl: string, chart: string, version: string, releaseName: string}|null} webhook -
 *   Third-party cert-manager webhook chart this provider's DNS-01 solver
 *   needs (k3s.js `applyK3sManifests` install block), or `null` when the
 *   solver ships in cert-manager core (no extra chart to install).
 * @property {Record<string, string>} [legoTuningEnv] - Extra lego env vars
 *   this provider's DNS-01 solver needs beyond the token (e.g. a longer
 *   propagation window for slow authoritative anycast). Merged verbatim by
 *   `dnsChallengeEnv`; every key must also be forwarded by the compose
 *   DNS-01 override's `environment:` block (drift-guarded in acme.test.ts).
 */

/**
 * DNS-01 ACME challenge descriptor table, keyed by provider id. A
 * provider's presence here means it can drive cert-manager's DNS-01 solver;
 * `manual` and any unrecognised provider id are absent — consumers treat
 * absence as "fall back to HTTP-01 / no DNS-01 wiring", exactly as the
 * pre-C6 `Set`/ternary branches did.
 *
 * lego (Traefik's embedded ACME client) selects its provider implementation
 * from the ACME_DNS_PROVIDER string. For all six rows lego's provider code
 * is byte-identical to our provider id — verified against
 * go-acme.github.io/lego/dns/{cloudflare,hetzner,digitalocean,linode,vultr,scaleway}/
 * — so the key IS the lego code and no translation field is needed. Add one
 * the day a provider id and its lego code diverge.
 *
 * @type {Record<string, Dns01ProviderRow>}
 */
export const DNS01_PROVIDERS = {
  cloudflare: {
    tokenEnvVar: 'CF_DNS_API_TOKEN',
    secretName: 'cloudflare-api-token',
    secretKey: 'api-token',
    missingTokenError:
      'Cloudflare DNS-01 requires a Cloudflare API token. ' +
      "Set CLOUDFLARE_API_TOKEN in your shell or the project's .env.local. " +
      'The token must have Zone:Zone:Read on all zones + Zone:DNS:Edit on the target zone.',
    // Cloudflare's DNS-01 solver ships in cert-manager core — no extra
    // webhook chart to install.
    webhook: null,
  },
  hetzner: {
    tokenEnvVar: 'HETZNER_API_TOKEN',
    secretName: 'hetzner',
    secretKey: 'token',
    missingTokenError:
      'Hetzner DNS-01 requires a Cloud API token with read+write on the zones API. ' +
      "Set HETZNER_API_TOKEN in your shell or the project's .env.local.",
    // cert-manager core has no native Hetzner solver — the third-party
    // cert-manager-webhook-hetzner chart registers the APIService cert-manager
    // dispatches dns01.webhook(groupName=acme.hetzner.com) calls to. Pinned
    // explicitly (not `latest`) so `helm repo update` can't silently drift
    // the API surface; bump in lockstep with CERT_MANAGER_VERSION, canary is
    // the k8s-hetzner-dns e2e scenario.
    webhook: {
      repoName: 'hetzner-cloud',
      repoUrl: 'https://charts.hetzner.cloud',
      chart: 'hetzner-cloud/cert-manager-webhook-hetzner',
      version: '0.7.0',
      releaseName: 'cert-manager-webhook-hetzner',
    },
  },
  digitalocean: {
    // lego reads DO_AUTH_TOKEN, which is NOT the env var the rest of the CLI
    // uses for the same credential (DigitalOceanProvider.CLI_TOKEN_ENV =
    // DIGITALOCEAN_TOKEN). The bundler writes the value under lego's name in
    // the server .env; operators still set DIGITALOCEAN_TOKEN locally.
    tokenEnvVar: 'DO_AUTH_TOKEN',
    // cert-manager's documented Secret for its native solver.
    secretName: 'digitalocean-dns',
    secretKey: 'access-token',
    missingTokenError:
      'DigitalOcean DNS-01 requires a DigitalOcean API token with write scope. ' +
      "Set DIGITALOCEAN_TOKEN in your shell or the project's .env.local. " +
      'The token needs read+write on the Domains API for the target domain.',
    // DigitalOcean's DNS-01 solver ships in cert-manager core
    // (dns01.digitalocean.tokenSecretRef) — no extra webhook chart.
    webhook: null,
    // lego's per-attempt propagation wait defaults to 60s
    // (DO_PROPAGATION_TIMEOUT, go-acme.github.io/lego/dns/digitalocean/) —
    // and DO's OWN authoritative anycast nameservers routinely take longer
    // than that to serve a freshly written TXT record (run 33266321881:
    // "NS ns1.digitalocean.com:53 did not return the expected TXT record",
    // repeating). Each expired attempt rewrites the challenge value, so
    // issuance churns instead of converging, and stale values cached at
    // anycast POPs 403 the NEXT attempt ("Incorrect TXT record ... found").
    // 300s lets a single attempt outlive the observed convergence lag.
    // ACME_DNS_DELAY_BEFORE_CHECKS is OUR interpolation var, not lego's: the
    // dns01 override's Traefik command feeds it to
    // dnschallenge.propagation.delayBeforeChecks. It is a settle FLOOR
    // before lego's own check even starts — run 33283466928 showed lego's
    // anycast POP converging fast while LE's validation POP still answered
    // "No TXT record found"; the record needs wall-time in the zone, not
    // just visibility from one vantage.
    legoTuningEnv: { DO_PROPAGATION_TIMEOUT: '300', ACME_DNS_DELAY_BEFORE_CHECKS: '90s' },
  },
  // linode, vultr and scaleway are compose-only tiers: there is no k8s deploy
  // mode for any of them, so cert-manager never sees them and none ships a
  // cluster-issuers-<id>.yaml. Only the lego half of these rows is live —
  // Traefik solves DNS-01 on the single compose host. `webhook: null` here
  // therefore means "no k8s tier at all", not "solver is in cert-manager
  // core" as it does for cloudflare/digitalocean. secretName/secretKey follow
  // cert-manager's <provider>-dns naming so that wiring a webhook solver
  // later only needs the issuer YAML, but nothing reads them today.
  linode: {
    tokenEnvVar: 'LINODE_TOKEN',
    secretName: 'linode-dns',
    secretKey: 'token',
    missingTokenError:
      'Linode DNS-01 requires a Linode API token with read/write on Domains. ' +
      "Set LINODE_TOKEN in your shell or the project's .env.local.",
    webhook: null,
  },
  vultr: {
    tokenEnvVar: 'VULTR_API_KEY',
    secretName: 'vultr-dns',
    secretKey: 'api-key',
    missingTokenError:
      'Vultr DNS-01 requires a Vultr API key with DNS write access. ' +
      "Set VULTR_API_KEY in your shell or the project's .env.local.",
    webhook: null,
    // Vultr's authoritative frontends NEGATIVELY CACHE a name that was
    // queried before its record landed (proven 2026-08-30 by direct probes
    // on threvidence.com: an unqueried TXT record serves in <=5s; the same
    // create preceded by ONE dig stays invisible for minutes). lego's
    // default delayBeforeChecks=0s queries the instant it presents, poisons
    // its own challenge name, then polls the poisoned cache until its 60s
    // default window dies — "NS ns1.vultr.com:53 returned NXDOMAIN for
    // _acme-challenge...", or, with the apex+wildcard orders sharing one
    // name, the sibling order's stale token (run 33287840597 vultr
    // compose-ha). The 60s floor makes the FIRST query land after the
    // record is live so no negative entry ever forms; 300s covers
    // cache-expiry stragglers on freshly churned names (failover re-arm,
    // retried deploys reuse the same challenge names).
    legoTuningEnv: { VULTR_PROPAGATION_TIMEOUT: '300', ACME_DNS_DELAY_BEFORE_CHECKS: '60s' },
  },
  scaleway: {
    // lego reads SCW_SECRET_KEY (verified against
    // go-acme.github.io/lego/dns/scaleway/, provider code `scaleway` since
    // lego v3.4.0) — the PLUGIN-native spelling, same one
    // ScalewayProvider.CLI_TOKEN_ENV carries, not the operator-facing
    // SCALEWAY_SECRET_KEY. lego's other two vars, SCW_ACCESS_KEY and
    // SCW_PROJECT_ID, are OPTIONAL there, so the one-token-per-row contract
    // holds and nothing else has to ride along. Note the near-miss: our
    // compute path emits SCW_DEFAULT_PROJECT_ID (what the Pulumi/Terraform
    // provider reads — ScalewayProvider.buildIacEnv), while lego would want
    // SCW_PROJECT_ID for the same value. Deliberately NOT forwarded: passing
    // an optional var under the wrong name buys nothing, and under the right
    // name it would scope challenge writes to one Project when the zone may
    // live in another (getZones is Project-agnostic for the same reason).
    tokenEnvVar: 'SCW_SECRET_KEY',
    secretName: 'scaleway-dns',
    secretKey: 'secret-key',
    missingTokenError:
      'Scaleway DNS-01 requires a Scaleway secret key whose IAM policy allows DNS write. ' +
      "Set SCALEWAY_SECRET_KEY in your shell or the project's .env.local.",
    // Compose-only tier, like linode/vultr above — no cert-manager, so there
    // is no webhook chart and no cluster-issuers-scaleway.yaml.
    webhook: null,
  },
};

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
  return process.env[row.tokenEnv] || null;
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
