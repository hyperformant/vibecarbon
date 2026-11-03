/**
 * Public-DNS lookup for the deploy's public health probe.
 *
 * The probe runs right after the deploy (re)writes its DNS record, and the
 * OPERATOR-side system resolver may hold a stale negative entry for the name:
 * any query made while the record didn't exist yet (a prior run's teardown
 * window, a failure diagnostic's curl) is cached as NXDOMAIN for the zone's
 * SOA minimum TTL — an hour on Hetzner DNS — by systemd-resolved and most
 * home-router resolvers. The probe then fails `getaddrinfo ENOTFOUND` for its
 * whole budget against a perfectly healthy deploy (e4, 2026-08-28: 118
 * attempts, record live on 1.1.1.1 the entire time).
 *
 * `dns.setServers()` CANNOT fix this: it only redirects the c-ares
 * `dns.resolve*()` family, while fetch/undici resolve via `dns.lookup()`
 * (getaddrinfo → the system resolver). The probe carried exactly that no-op
 * "fix" from matrix #3 until this module replaced it. The real seam is the
 * socket connector's `lookup` option, which this factory supplies: resolve
 * A records through explicit public resolvers (fresh view, no local negative
 * cache), and fall back to the system `dns.lookup` when public DNS is
 * unreachable (egress-filtered networks must not lose the probe entirely).
 */

import dnsCallback from 'node:dns';

export const PUBLIC_DNS_SERVERS = ['1.1.1.1', '8.8.8.8'];

/**
 * Total time the public resolvers get before the system resolver answers
 * instead. Egress filters that silently drop UDP to 1.1.1.1/8.8.8.8 never
 * answer at all, and c-ares's own retry schedule (timeout x tries x servers)
 * would spend 6 to 12 seconds finding that out: longer than status's 5s
 * readiness abort and deploy's 8s probe. 1.5s is well inside the smallest
 * caller timeout and far above a healthy public answer (tens of ms).
 */
export const PUBLIC_DNS_BUDGET_MS = 1_500;

/** A Resolver pinned to `servers`, its own retries already inside the budget. */
function publicResolver(servers) {
  const r = new dnsCallback.Resolver({ timeout: 1_000, tries: 1 });
  r.setServers(servers);
  return r;
}

/**
 * resolve4 through `r`, settled exactly once: the public answer (empty on
 * error), or null when the budget runs out first. A late answer is dropped
 * and the outstanding query cancelled.
 *
 * @param {{resolve4: Function, cancel?: Function}} r
 * @param {string} hostname
 * @param {(addresses: string[]|null) => void} done
 */
function resolve4WithinBudget(r, hostname, done) {
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    r.cancel?.();
    done(null);
  }, PUBLIC_DNS_BUDGET_MS);
  r.resolve4(hostname, (err, addresses) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    done(!err && Array.isArray(addresses) ? addresses : []);
  });
}

/**
 * Build a `lookup(hostname, options, callback)` compatible with
 * `net.connect` / undici's `connect.lookup`.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.servers] - resolvers to pin (default public pair)
 * @param {{resolve4: Function, cancel?: Function}} [opts.resolver] - injectable Resolver (tests)
 * @param {Function} [opts.fallback] - injectable system lookup (tests)
 */
export function makePublicDnsLookup({
  servers = PUBLIC_DNS_SERVERS,
  resolver,
  fallback = dnsCallback.lookup,
} = {}) {
  const r = resolver ?? publicResolver(servers);
  return function publicDnsLookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    resolve4WithinBudget(r, hostname, (addresses) => {
      if (!addresses || addresses.length === 0) {
        // Public DNS unreachable, silent past the budget, or empty: the
        // system resolver is still better than no answer at all.
        fallback(hostname, options, callback);
        return;
      }
      if (options?.all) {
        callback(
          null,
          addresses.map((address) => ({ address, family: 4 })),
        );
      } else {
        callback(null, addresses[0], 4);
      }
    });
  };
}

/**
 * The A records a hostname resolves to, through the public resolvers first (a
 * fresh view, no local negative cache) and the system resolver when public DNS
 * is unreachable or silent past PUBLIC_DNS_BUDGET_MS. Used by the compose-HA
 * reconverge to check DNS already points at the promoted primary before it
 * rebuilds the retired node, and by publicCurlResolveArgs.
 *
 * @param {string} hostname
 * @param {object} [opts]
 * @param {string[]} [opts.servers]
 * @param {{resolve4: Function, cancel?: Function}} [opts.resolver] - injectable Resolver (tests)
 * @param {Function} [opts.fallback] - injectable system lookup (tests)
 * @returns {Promise<string[]>} empty when nothing resolves
 */
export async function resolvePublicA(
  hostname,
  { servers = PUBLIC_DNS_SERVERS, resolver, fallback = dnsCallback.lookup } = {},
) {
  const r = resolver ?? publicResolver(servers);
  const publicAnswer = await new Promise((resolve) => {
    resolve4WithinBudget(r, hostname, (addresses) => resolve(addresses ?? []));
  });
  if (publicAnswer.length > 0) return publicAnswer;
  return new Promise((resolve) => {
    fallback(hostname, { all: true, family: 4 }, (err, addresses) =>
      resolve(err || !Array.isArray(addresses) ? [] : addresses.map((a) => a.address)),
    );
  });
}
