/**
 * Resolution pinning for post-failover verification.
 *
 * WHY THIS EXISTS
 * ---------------
 * `compose-ha` failover repoints the environment's DNS: `upsertApexAndWildcard`
 * writes the promoted standby's IP over the retired primary's on both the apex
 * A record and the `*` wildcard (src/failover.js `dnsStrategyFor`). DNS-based
 * failover is inherently eventually-consistent — every resolver that answered
 * for the domain in the seconds before the flip keeps serving the OLD address
 * until its cached record expires. docs/rto-rpo.md states this plainly: the
 * planned-switchover RTO closes "when the promoted app tier serves and DNS
 * propagates", with the propagation tail "bounded by the 60s record TTL the
 * failover flip writes". That tail is a property of the CLIENT's resolver
 * chain, not of the deployment.
 *
 * The e2e verifier used to inherit that tail. Its checks resolve through public
 * resolvers (1.1.1.1 / 8.8.8.8) reached across the operator's uplink, and the
 * hetzner/compose-ha run of 2026-08-11 caught them MID-TTL: some checks got a
 * fresh answer and hit the promoted node (auth_health, auth_signup, rest_api —
 * all passed), while others got the stale answer and hit the DEMOTED node whose
 * app tier is deliberately stopped. That produced spa_auth_callback 404
 * ("swallowed by the gateway"), auth_signin / auth_admin_login timeouts, an
 * unqueryable db_schema, and storage_upload 503 `{"message":"name resolution
 * failed"}` — the retired node's gateway failing to resolve its own stopped
 * upstreams. The promoted node's gateway access log contained none of those
 * request ids; everything healed at TTL expiry.
 *
 * WHAT THE PIN DOES
 * -----------------
 * Inside a pinned scope, every HTTP verification check connects straight to the
 * promoted node's IP while keeping the domain in the `Host` header and the TLS
 * SNI/`servername` — so the node still has to present a valid certificate FOR
 * THE DOMAIN and route the request by name. Nothing about serving correctness
 * is weakened; only the address lookup is short-circuited.
 *
 * The verifier's two jobs are thereby separated:
 *   1. does the promoted node actually SERVE the environment?  → pinned checks
 *   2. did the A-record flip actually PUBLISH?                 → the
 *      `dns_failover_flip` check (tests/e2e/checks/dns-flip.ts), which queries
 *      the zone's AUTHORITATIVE nameservers and never touches the OS resolver.
 *
 * Neither job is "measure how long the operator's ISP cache holds a record",
 * which is what the un-pinned verifier was accidentally measuring.
 *
 * SCOPE
 * -----
 * The pin is entered where a step has just moved the record: `verify-failover`
 * and `verify-failback` on both HA modes (see postFailoverResolutionPin), the
 * observability checks k8s-ha's `reconverge-deploy` runs minutes after that
 * flip, `verify-scale` on compose modes, and `verify-restore`, which pins to what
 * the zone's authoritative servers publish. `verify-deploy` deliberately stays on
 * the public-resolver path: that IS the customer cold path, and pinning it would
 * hide a broken/unpublished record.
 *
 * `k8s-ha` was once left out on the belief that its failover moves a floating IP
 * without rewriting the A record. It does rewrite it, to the promoted cluster's
 * ingress IP (src/failover.js STEP 7), and l4 on 2026-11-15 paid for the gap:
 * inside Linode's 300 s TTL some checks reached the retired cluster, whose app
 * tier is at zero, and got Traefik's "404 page not found".
 *
 * The scope is carried in an AsyncLocalStorage (same convention as
 * `scenarioContext` in tests/e2e/utils/cli-runner.ts) rather than a module-level
 * mutable, so a pin can never leak past the step that entered it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { hasAutomatedDns } from '../../../src/lib/dns-provider.js';

export interface ResolutionPin {
  /** Apex domain whose records are pinned. Subdomains match too (the flip is apex + wildcard). */
  domain: string;
  /** Address every pinned request connects to. TLS SNI / Host stay on `domain`. */
  ip: string;
  /** Short human reason, logged when the scope is entered. */
  reason: string;
}

const pinStore = new AsyncLocalStorage<ResolutionPin>();

/**
 * Run `fn` with `pin` active. A null/undefined pin runs `fn` unchanged, so
 * callers can compute the pin conditionally without branching at the call site.
 */
export function withResolutionPin<T>(
  pin: ResolutionPin | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!pin) return fn();
  return pinStore.run(pin, fn);
}

/** The pin governing the current async scope, or null outside any pinned scope. */
export function currentResolutionPin(): ResolutionPin | null {
  return pinStore.getStore() ?? null;
}

/** Case/trailing-dot-insensitive: is `hostname` the pinned domain or a subdomain of it? */
export function pinMatchesHost(pin: ResolutionPin, hostname: string): boolean {
  const normalize = (s: string) => s.trim().toLowerCase().replace(/\.$/, '');
  const host = normalize(hostname);
  const domain = normalize(pin.domain);
  if (!host || !domain) return false;
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * The address `hostname` must be dialed at under the active pin, or null when
 * unpinned / out of the pin's domain. Callers fall back to real resolution on
 * null — the pin narrows, it never broadens.
 */
export function pinnedIpFor(hostname: string): string | null {
  const pin = currentResolutionPin();
  if (!pin) return null;
  return pinMatchesHost(pin, hostname) ? pin.ip : null;
}

/**
 * Chromium's `--host-resolver-rules` equivalent of the pin, or null when
 * unpinned. The browser check (checks/frontend-smoke.ts) cannot go through
 * `dnsSafeFetch` — it drives a real browser — so it gets the same pin through
 * the browser's own resolver override. Both the apex and the wildcard are
 * mapped, mirroring what the failover flip writes.
 */
export function chromeHostResolverRules(hostname: string): string | null {
  const pin = currentResolutionPin();
  if (!pin || !pinMatchesHost(pin, hostname)) return null;
  return `MAP ${pin.domain} ${pin.ip},MAP *.${pin.domain} ${pin.ip}`;
}

/**
 * Whether a failover rewrites the environment's apex + wildcard A records. It
 * does in BOTH HA modes whenever the DNS is automated, the same test the CLI
 * makes (src/failover.js detectScenario's 'ha_dns', compose's
 * failoverComposeHA): compose-ha points them at the promoted node, k8s-ha at
 * the promoted cluster's ingress IP. Manual DNS flips nothing.
 *
 * After a flip every resolver that answered before it keeps the old address
 * for the record's TTL, up to 300 s on Linode (src/lib/linode-dns.js), and the
 * retired side answers 404 meanwhile. Steps that probe the domain then must
 * pin (postFailoverResolutionPin) or, for the real CLI, which the pin cannot
 * reach, keep observing past that TTL (checkStatusHealth's recordJustMoved).
 */
export function failoverFlipsRecord(dnsProvider: string | null | undefined): boolean {
  return hasAutomatedDns(dnsProvider);
}

/**
 * The pin for checks that follow a failover or failback, on either HA mode:
 * every request dials `servingIp`, the address the flip wrote (readServingIp:
 * the promoted node on compose-ha, the promoted cluster's ingress IP on
 * k8s-ha), with Host and SNI kept on the domain. Null when no record moved or
 * the address is unknown, so the checks fall back to the public resolvers.
 */
export function postFailoverResolutionPin(opts: {
  stepName: string;
  domain: string;
  envPrefix: string;
  dnsProvider: string | null | undefined;
  servingIp: string | null;
}): ResolutionPin | null {
  if (!failoverFlipsRecord(opts.dnsProvider) || !opts.servingIp) return null;
  return {
    domain: opts.domain,
    ip: opts.servingIp,
    reason: `${opts.stepName}: promoted serving address for ${opts.envPrefix}`,
  };
}
