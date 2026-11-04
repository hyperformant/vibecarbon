/**
 * Wait for a DNS A record to propagate to public resolvers.
 *
 * Polls Cloudflare (1.1.1.1) and Google (8.8.8.8) resolvers until at least
 * one returns the expected IP, or the timeout elapses. Returns true on
 * success, false if the budget runs out (caller decides whether to proceed
 * or hard-fail).
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
 * @returns {Promise<boolean>} true if propagated, false if timed out
 */
export async function waitForDNSPropagation(domain, expectedIp, timeoutMs = 120_000) {
  const dns = await import('node:dns');
  const resolver = new dns.promises.Resolver();
  resolver.setServers(['1.1.1.1', '8.8.8.8']);

  // Deliberately NOT lib/retry.js#pollUntil: this loop must sleep via the
  // global setTimeout so the fake-timer unit tests (vi.useFakeTimers) can
  // advance it — retry.js sleeps via node:timers/promises, which vitest's
  // fake timers do not patch.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const addrs = await resolver.resolve4(domain);
      if (addrs.includes(expectedIp)) return true;
    } catch {
      // NXDOMAIN / SERVFAIL / timeout — record may not exist yet or
      // hasn't propagated to this resolver. Retry; cheap to fail.
    }
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
  const dns = await import('node:dns');
  const resolver = new dns.promises.Resolver();
  resolver.setServers(['1.1.1.1', '8.8.8.8']);

  try {
    const servers = await resolver.resolveNs(String(domain).replace(/\.$/, ''));
    if (!Array.isArray(servers) || servers.length === 0) return null;
    return servers.map((ns) => String(ns).replace(/\.$/, '').toLowerCase());
  } catch {
    return null;
  }
}
