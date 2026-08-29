/**
 * ACME / TLS challenge strategy for Compose deploys.
 *
 * Managed-DNS providers (cloudflare, hetzner, digitalocean, linode, vultr —
 * the DNS01_PROVIDERS table) expose an API that lego — the
 * ACME client embedded in Traefik — can use to solve the DNS-01 challenge:
 * Traefik writes a `_acme-challenge` TXT record, Let's Encrypt validates it,
 * and a cert is issued. DNS-01 needs no inbound port-80 reachability and does
 * not race against A-record propagation, so it eliminates the cold-deploy ACME
 * race that the DNS-propagation poll (src/lib/dns-propagation.js) and the
 * Traefik cert self-heal were built to paper over.
 *
 * `manual` DNS has no API we can drive, so it falls back to the HTTP-01
 * challenge (and keeps the DNS-propagation poll that guards it).
 *
 * Tokens: lego selects the provider implementation from ACME_DNS_PROVIDER and
 * reads that provider's token env var (DNS01_PROVIDERS.tokenEnvVar, one per
 * row, each verified against go-acme.github.io/lego/dns/). Hetzner
 * consolidated its DNS into the core Cloud API (api.hetzner.cloud) — the
 * legacy dns.hetzner.com console was retired May 2026 — so lego v4.27+ reads
 * HETZNER_API_TOKEN, the SAME Cloud token used for server ops (no separate DNS
 * credential). That lego ships in Traefik >= 3.6.6; we pin v3.6.11.
 */

import { DNS01_PROVIDERS } from '../dns-provider.js';

/** Compose override file that swaps Traefik from HTTP-01 to DNS-01. */
export const DNS01_OVERRIDE_FILE = 'docker-compose.dns01.prod.yml';

/**
 * True when the deploy's DNS provider exposes an API lego can use for DNS-01.
 * @param {string|null|undefined} dnsProvider
 * @returns {boolean}
 */
export function useDnsChallenge(dnsProvider) {
  return Boolean(DNS01_PROVIDERS[dnsProvider]);
}

/**
 * Env vars Traefik needs to solve the DNS-01 challenge for the given provider.
 * Returns `null` for non-DNS-01 (manual / unknown) providers — `Object.assign`
 * ignores it, so callers can merge it unconditionally.
 *
 * `dnsToken` is the ONE credential for whichever provider is selected; the
 * caller resolves it (the CLI never holds five provider tokens at once). The
 * token key is omitted when the token is absent, so an empty `${VAR:-}`
 * interpolation stays empty rather than landing a literal "undefined" in the
 * server .env.
 *
 * @param {string|null|undefined} dnsProvider
 * @param {string|null} [dnsToken]
 * @returns {Record<string, string>|null}
 */
export function dnsChallengeEnv(dnsProvider, dnsToken) {
  const row = DNS01_PROVIDERS[dnsProvider];
  if (!row) return null;
  // The table key IS lego's provider code for every row (see DNS01_PROVIDERS).
  const env = { ACME_DNS_PROVIDER: dnsProvider };
  if (dnsToken) env[row.tokenEnvVar] = dnsToken;
  // Provider-specific lego tuning (e.g. DigitalOcean's propagation window —
  // see that row's rationale). Registry-owned so the values live beside the
  // provider they compensate for; acme.test.ts drift-guards the override
  // file's passthrough of every tuning var.
  if (row.legoTuningEnv) Object.assign(env, row.legoTuningEnv);
  return env;
}
