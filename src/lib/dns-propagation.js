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
 * Wait until a domain's own delegated nameservers actually ANSWER for it.
 *
 * A zone existing in a provider's API is not the same as that provider's
 * nameservers serving it. Linode serves DNS only for accounts holding at least
 * one active Linode: create the zone before the instance and every
 * ns1-5.linode.com returns REFUSED while the API reports `"status": "active"`.
 * `status` is a user-settable render flag, not a published-to-nameservers
 * signal, and no API field exposes the account-level gate — the wire is the
 * only source of truth.
 *
 * Left ungated, DNS-01 starts against a zone nobody answers for and the deploy
 * finds out ~20 minutes later when ACME gives up. Preflight cannot catch it:
 * preflight runs BEFORE the instance exists, which is exactly the state that
 * produces REFUSED. So the gate belongs here, at cert-issuance time.
 *
 * POLLED, NOT SLEPT. Linode's publish cadence is undocumented — the commonly
 * cited "~15 minutes" traces to retired GUI text and Linode Support has quoted
 * 30. A fixed sleep is simultaneously too long for the common case and too
 * short for the bad one; the wire tells us exactly when to stop.
 *
 * FAIL-OPEN. This trades a short bounded wait for a long ACME failure; it must
 * never itself fail a deploy. On timeout it returns `served: false` and the
 * caller proceeds anyway. Only an explicit REFUSED/SERVFAIL means "not yet";
 * every inconclusive state (no NS published, unresolvable NS, timeouts) also
 * keeps waiting but can never harden into an error.
 *
 * The e2e preflight's `probeZoneAuthoritative` (tests/e2e/utils/preflight.ts)
 * is the one-shot twin of this poll and shares its REFUSED/SERVFAIL-only rule.
 *
 * @param {string} domain - FQDN being deployed (e.g. "e1.example.com")
 * @param {object} [options]
 * @param {number} [options.timeoutMs=180_000] - total budget
 * @param {number} [options.pollIntervalMs=5_000]
 * @param {object} [options.deps] - injected resolvers (tests)
 * @param {(detail: string) => void} [options.onProgress]
 * @returns {Promise<{served: boolean, detail: string, waitedMs: number}>}
 */
export async function waitForZoneServed(domain, options = {}) {
  const { timeoutMs = 180_000, pollIntervalMs = 5_000, deps: injected, onProgress } = options;

  const deps = injected ?? (await nodeZoneProbeDeps());
  const started = Date.now();
  const deadline = started + timeoutMs;
  let detail = 'not probed';

  while (Date.now() < deadline) {
    const verdict = await probeZoneServedOnce(domain, deps);
    detail = verdict.detail;
    if (verdict.served) {
      return { served: true, detail, waitedMs: Date.now() - started };
    }
    onProgress?.(detail);

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, remaining)));
  }

  return { served: false, detail, waitedMs: Date.now() - started };
}

/**
 * One probe: find the closest enclosing zone that publishes NS records, then
 * ask that zone's own nameserver for its SOA.
 *
 * Walking UP from the FQDN is what makes this work without a provider API
 * call — the deploy knows `e1.example.com`, not which of `e1.example.com` /
 * `example.com` is the delegated zone. Stopping at the FIRST level that
 * answers is also what makes a delegated child (`do.appcarbon.dev`) win over
 * its parent, which matters because records for the child subtree are only
 * served from the child's nameservers.
 *
 * The walk stops at two labels so a zone that is nowhere visible can never
 * end up asking a TLD for its SOA.
 *
 * @param {string} domain
 * @param {{resolveNs: Function, resolveAddr: Function, soaFrom: Function}} deps
 * @returns {Promise<{served: boolean, detail: string}>}
 */
async function probeZoneServedOnce(domain, deps) {
  const labels = String(domain).replace(/\.$/, '').split('.');

  let zone = null;
  let nameservers = [];
  for (let i = 0; i <= labels.length - 2; i++) {
    const candidate = labels.slice(i).join('.');
    try {
      const found = await deps.resolveNs(candidate);
      if (Array.isArray(found) && found.length > 0) {
        zone = candidate;
        nameservers = found;
        break;
      }
    } catch {
      // ENODATA/ENOTFOUND at this level just means "not the zone apex" (or not
      // published yet) — keep walking up.
    }
  }

  if (!zone) return { served: false, detail: `no NS published for ${domain} yet` };

  const host = String(nameservers[0]).replace(/\.$/, '');
  let addrs;
  try {
    addrs = await deps.resolveAddr(host);
  } catch (err) {
    return { served: false, detail: `NS ${host} unresolvable (${dnsErrCode(err)})` };
  }
  if (!Array.isArray(addrs) || addrs.length === 0) {
    return { served: false, detail: `NS ${host} has no address` };
  }

  try {
    await deps.soaFrom(addrs[0], zone);
    return { served: true, detail: `${zone} authoritative at ${host}` };
  } catch (err) {
    const code = dnsErrCode(err);
    // REFUSED/SERVFAIL is the provider saying "I do not serve this" — the
    // signal this gate exists for. Anything else is inconclusive; both keep
    // waiting, but the detail distinguishes them in the log.
    return { served: false, detail: `${host} returned ${code} for ${zone}` };
  }
}

/** Extract a DNS error code for logging. */
function dnsErrCode(err) {
  const code = err?.code;
  if (typeof code === 'string') return code;
  return err instanceof Error ? err.message.split('\n')[0].slice(0, 40) : String(err);
}

/** Real resolver wiring for {@link waitForZoneServed}. */
async function nodeZoneProbeDeps() {
  const { promises: dnsp, Resolver } = await import('node:dns');
  return {
    resolveNs: (zone) => dnsp.resolveNs(zone),
    resolveAddr: (host) => dnsp.resolve4(host),
    soaFrom: (serverIp, zone) => {
      // Bounded: a hung authoritative server must not stall the deploy.
      const r = new Resolver({ timeout: 3_000, tries: 1 });
      r.setServers([serverIp]);
      return new Promise((resolve, reject) => {
        r.resolveSoa(zone, (err, address) => (err ? reject(err) : resolve(address)));
      });
    },
  };
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
