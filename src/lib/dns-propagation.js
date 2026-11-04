import { PUBLIC_DNS_SERVERS, publicResolver, resolvePublicA } from './deploy/public-dns-lookup.js';

/**
 * Wait for a DNS A record to propagate to public resolvers.
 *
 * Every poll asks Cloudflare (1.1.1.1) and Google (8.8.8.8) on their own, each
 * through its own Resolver (public-dns-lookup.js), and returns true as soon as
 * any one of them answers with the expected IP; false if the budget runs out
 * (caller decides whether to proceed or hard-fail). They are NOT one two-server
 * Resolver: c-ares moves to the next server only on a timeout, SERVFAIL or
 * REFUSED, so an NXDOMAIN or stale address from 1.1.1.1 is a final answer and
 * 8.8.8.8 would never be asked. The 0.0.0.0 warm-up placeholder never matches.
 *
 * Why this matters for compose deploys: Traefik attempts ACME HTTP-01
 * challenges immediately on container start and bursts ~7 attempts in
 * ~30s. Let's Encrypt rejects challenges with "no valid A records found"
 * if its own resolver sees stale or absent records (the 0.0.0.0 warm-up
 * placeholder also fails this check — LE treats 0.0.0.0 as not-a-valid-
 * A-record). Once Traefik gives up, acme.json has zero certs and the
 * browser sees the TRAEFIK DEFAULT CERT, which is self-signed and shows
 * NET::ERR_CERT_AUTHORITY_INVALID. Cold-deploy 2026-05-19 RCA against
 * vibecarbon.com hit exactly this.
 *
 * The fix: gate compose-up on DNS propagation so Traefik's first ACME
 * attempt sees real records. Polling public resolvers is the closest
 * approximation we have to "LE will see this" without actually calling
 * LE's resolver directly.
 *
 * @param {string} domain - The hostname to check (e.g. "vibecarbon.com")
 * @param {string} expectedIp - The IP we expect the record to point to
 * @param {number} [timeoutMs=120_000] - Total budget in ms
 * @param {object} [deps]
 * @param {(server: string) => {resolve4: Function, cancel?: Function}} [deps.makeResolver] -
 *   one Resolver per server (injectable for tests)
 * @returns {Promise<boolean>} true if propagated, false if timed out
 */
export async function waitForDNSPropagation(
  domain,
  expectedIp,
  timeoutMs = 120_000,
  { makeResolver } = {},
) {
  // The system resolver is no stand-in here: its negative cache is exactly the
  // stale view this gate exists to see past. Silent public DNS counts as "not yet".
  const noFallback = (_host, _opts, cb) => cb(null, []);
  const seenOn = async (server) => {
    const addrs = await resolvePublicA(domain, {
      servers: [server],
      ...(makeResolver ? { makeResolver } : {}),
      fallback: noFallback,
    });
    return addrs.includes(expectedIp);
  };

  // Deliberately NOT lib/retry.js#pollUntil: this loop must sleep via the
  // global setTimeout so the fake-timer unit tests (vi.useFakeTimers) can
  // advance it — retry.js sleeps via node:timers/promises, which vitest's
  // fake timers do not patch.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // NXDOMAIN / SERVFAIL / timeout on a resolver just reads as "not yet";
    // resolvePublicA never rejects. Retry; cheap to fail.
    const seen = await Promise.all(PUBLIC_DNS_SERVERS.map(seenOn));
    if (seen.some(Boolean)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(5_000, remaining)));
  }
  return false;
}

/**
 * The nameservers a domain is currently DELEGATED to, as public resolvers see
 * them.
 *
 * Added for Scaleway's external-domain onboarding, where delegation order is
 * load-bearing and getting it wrong deadlocks: the ownership TXT has to be
 * resolvable at the domain's CURRENT DNS host, so moving the nameservers to
 * the new host BEFORE validation completes means the challenge can never be
 * answered (the new host refuses to serve an unvalidated zone). Reading the
 * live delegation is the only way to tell an operator they are already in
 * that state rather than merely waiting.
 *
 * Same public-resolver approach as `waitForDNSPropagation` above: what a third
 * party sees is what matters, not what any one account's API claims.
 *
 * @param {string} domain - apex domain (trailing dot tolerated)
 * @returns {Promise<string[]|null>} lowercased, dot-stripped NS hostnames, or
 *   null when the lookup fails (NXDOMAIN / SERVFAIL / no answer) — an unknown
 *   delegation must never read as "delegated nowhere".
 */
export async function resolveNameservers(domain) {
  // One Resolver per public server, asked in turn: a two-server Resolver never
  // reaches 8.8.8.8 after an NXDOMAIN or stale answer from 1.1.1.1.
  for (const server of PUBLIC_DNS_SERVERS) {
    const servers = await new Promise((resolve) => {
      publicResolver([server]).resolveNs(String(domain).replace(/\.$/, ''), (err, ns) =>
        resolve(err || !Array.isArray(ns) ? [] : ns),
      );
    });
    if (servers.length > 0) {
      return servers.map((ns) => String(ns).replace(/\.$/, '').toLowerCase());
    }
  }
  return null;
}
