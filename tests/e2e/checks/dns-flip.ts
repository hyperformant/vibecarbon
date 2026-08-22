/**
 * `dns_failover_flip` — did the failover's A-record flip actually PUBLISH?
 *
 * WHY IT IS SEPARATE FROM THE SERVING CHECKS
 * ------------------------------------------
 * `compose-ha` failover repoints the environment by rewriting the apex and
 * wildcard A records (`upsertApexAndWildcard`, src/failover.js). Two distinct
 * things can go wrong and they need two distinct assertions:
 *
 *   1. The promoted node does not serve the environment.
 *   2. The flip never published, so the world still resolves to the retired one.
 *
 * The rest of the verify-failover battery answers (1) and, to keep answering
 * only (1), it runs under a resolution pin that dials the promoted node
 * directly (tests/e2e/utils/dns-pin.ts). This check answers (2) — and it is
 * what keeps that pin honest, because without it a pinned battery could pass
 * against a node whose record was never published.
 *
 * WHY IT REFUSES THE OS RESOLVER
 * ------------------------------
 * DNS-based failover leaves every client on the old address until its cached
 * record expires — docs/rto-rpo.md bounds that tail by "the 60s record TTL the
 * failover flip writes" and counts it as part of the published RTO, not as a
 * deployment fault. The operator's resolver chain (router → ISP → public
 * resolver) is somewhere inside that tail at an unknowable offset; the
 * hetzner/compose-ha run of 2026-08-11 saw it hold the retired address for
 * ~5–10 minutes. Asking that chain "has the flip happened?" measures the
 * operator's cache, not the deployment.
 *
 * So this check goes to the ZONE'S AUTHORITATIVE NAMESERVERS, which by
 * definition hold no cache of their own zone and answer the published truth the
 * instant the write lands. Only if the zone cut cannot be located does it fall
 * back to a cache-bypassing public resolver (1.1.1.1 / 8.8.8.8) — never to
 * `dns.lookup` / the OS resolver, and the fallback is reported in `details.source`
 * so a pass earned that way is legible rather than silent.
 */

import dns from 'node:dns';
import type { VerificationResult } from '../scenarios/types.js';

export const DNS_FLIP_CHECK_NAME = 'dns_failover_flip';

/** Cache-free public resolvers used to bootstrap the NS lookup (and as fallback). */
const BOOTSTRAP_SERVERS = ['1.1.1.1', '8.8.8.8'];

/** Lowest number of labels that can be a zone (`example.dev`). */
const MIN_ZONE_LABELS = 2;

export interface AuthoritativeAnswer {
  /** A records observed for the domain. Empty when nothing answered. */
  ips: string[];
  /** Nameserver hostnames of the zone the answer came from ([] on fallback). */
  nameservers: string[];
  /** The zone cut that was located, or null when none was. */
  zone: string | null;
  /** Which path produced `ips` — a fallback answer is a weaker assertion. */
  source: 'authoritative' | 'public-resolver';
}

/**
 * Injectable DNS primitives. Every one of them is a *directed* query — none
 * consults the OS resolver — so the unit tier can drive the zone walk and the
 * flip assertion without a network.
 */
export interface AuthoritativeDeps {
  /** NS records for a candidate zone name. Rejects/returns [] when it is not a zone cut. */
  ns: (zone: string) => Promise<string[]>;
  /** A records for a nameserver hostname, resolved via the bootstrap servers. */
  nsAddrs: (host: string) => Promise<string[]>;
  /** A records for `domain`, queried directly against the given servers. */
  a: (domain: string, servers: string[]) => Promise<string[]>;
}

function makeResolver(servers: string[]): dns.promises.Resolver {
  const r = new dns.promises.Resolver();
  r.setServers(servers);
  return r;
}

const defaultDeps: AuthoritativeDeps = {
  ns: (zone) => makeResolver(BOOTSTRAP_SERVERS).resolveNs(zone),
  nsAddrs: (host) => makeResolver(BOOTSTRAP_SERVERS).resolve4(host),
  a: (domain, servers) => makeResolver(servers).resolve4(domain),
};

/**
 * Candidate zone names for `domain`, most specific first:
 * `e1.env.example.dev` → `e1.env.example.dev`, `env.example.dev`, `example.dev`.
 * The first candidate that answers NS is the zone cut — the environment domain
 * itself is usually a record inside a wider zone (`vibecarbon.dev`), so the walk
 * cannot start at the registrable name and cannot assume a fixed depth either.
 */
export function zoneCandidates(domain: string): string[] {
  const labels = domain.trim().toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i + MIN_ZONE_LABELS <= labels.length; i++) {
    out.push(labels.slice(i).join('.'));
  }
  return out;
}

/**
 * Resolve `domain`'s A records from the authoritative nameservers of whichever
 * zone actually contains it. Never throws — an unreachable zone degrades to the
 * public-resolver fallback, and a total failure returns an empty `ips`.
 */
export async function resolveAuthoritativeA(
  domain: string,
  deps: Partial<AuthoritativeDeps> = {},
): Promise<AuthoritativeAnswer> {
  const { ns, nsAddrs, a } = { ...defaultDeps, ...deps };

  for (const zone of zoneCandidates(domain)) {
    let hosts: string[] = [];
    try {
      hosts = await ns(zone);
    } catch {
      continue; // not a zone cut (NXDOMAIN/NODATA) — walk one label up
    }
    if (!hosts || hosts.length === 0) continue;

    const servers: string[] = [];
    for (const host of hosts) {
      try {
        servers.push(...(await nsAddrs(host)));
      } catch {
        // One unreachable nameserver is normal; the others still answer.
      }
    }
    if (servers.length === 0) continue;

    try {
      const ips = await a(domain, servers);
      return { ips: ips ?? [], nameservers: hosts, zone, source: 'authoritative' };
    } catch {
      // The zone exists but has no A for this name yet (or refused the query).
      return { ips: [], nameservers: hosts, zone, source: 'authoritative' };
    }
  }

  // No zone cut located — fall back to the cache-bypassing public resolvers.
  // Still never the OS resolver, but a weaker claim, so it is labelled.
  try {
    const ips = await a(domain, BOOTSTRAP_SERVERS);
    return { ips: ips ?? [], nameservers: [], zone: null, source: 'public-resolver' };
  } catch {
    return { ips: [], nameservers: [], zone: null, source: 'public-resolver' };
  }
}

export interface DnsFlipCheckOptions {
  domain: string;
  /** The promoted node's IP the record must now carry. */
  expectedIp?: string | null;
  /** Non-null turns the check into a documented skip (e.g. modes with no A-record flip). */
  skipReason?: string | null;
  budgetMs?: number;
  intervalMs?: number;
  deps?: Partial<AuthoritativeDeps>;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Result label. Defaults to `dns_failover_flip`; verify-scale reuses this
   * check for its own record flip and labels it `dns_scale_flip` so reports
   * name the step that flipped the record.
   */
  checkName?: string;
}

/**
 * Assert the environment domain's authoritative A record now carries the
 * promoted node's IP.
 *
 * Bounded polling rather than a single shot: the flip is issued by
 * `vibecarbon failover` moments earlier and some DNS backends take a few
 * seconds to make a write visible on every one of the zone's nameservers. The
 * budget is small on purpose — this is an authoritative read, so it is NOT
 * waiting out a cache TTL, and a flip that has not landed within it is a real
 * failure of the failover, not of the operator's network.
 */
export async function runDnsFailoverFlipCheck(
  opts: DnsFlipCheckOptions,
): Promise<VerificationResult> {
  const {
    domain,
    expectedIp,
    skipReason,
    budgetMs = 120_000,
    intervalMs = 5_000,
    deps,
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
    checkName = DNS_FLIP_CHECK_NAME,
  } = opts;

  if (skipReason) {
    return {
      checkName,
      status: 'skip',
      details: { skipped: true, reason: skipReason },
    };
  }

  if (!expectedIp) {
    return {
      checkName,
      status: 'skip',
      details: {
        skipped: true,
        reason:
          'promoted primary IP is unknown (no ha entry in .vibecarbon.json) — nothing to compare the record against',
      },
    };
  }

  const start = Date.now();
  const deadline = start + budgetMs;
  let attempts = 0;
  let last: AuthoritativeAnswer = { ips: [], nameservers: [], zone: null, source: 'authoritative' };

  for (;;) {
    attempts++;
    last = await resolveAuthoritativeA(domain, deps);
    if (last.ips.includes(expectedIp)) {
      return {
        checkName,
        status: 'pass',
        responseTimeMs: Date.now() - start,
        details: {
          domain,
          expectedIp,
          observed: last.ips,
          zone: last.zone,
          nameservers: last.nameservers,
          source: last.source,
          attempts,
        },
      };
    }
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }

  return {
    checkName,
    status: 'fail',
    responseTimeMs: Date.now() - start,
    errorMessage:
      `${domain} still does not resolve to the promoted primary ${expectedIp} on the ` +
      `${last.source === 'authoritative' ? `zone's authoritative nameservers (${last.nameservers.join(', ') || 'none reachable'})` : 'cache-bypassing public resolvers (zone cut not locatable)'} ` +
      `after ${Math.round((Date.now() - start) / 1000)}s — observed ${last.ips.length ? last.ips.join(', ') : '(no A record)'}. ` +
      'This is the FLIP failing to publish, not a resolver cache: authoritative servers hold no cache of their own zone.',
    details: {
      domain,
      expectedIp,
      observed: last.ips,
      zone: last.zone,
      nameservers: last.nameservers,
      source: last.source,
      attempts,
    },
  };
}
