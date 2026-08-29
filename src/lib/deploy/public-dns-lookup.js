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
 * Build a `lookup(hostname, options, callback)` compatible with
 * `net.connect` / undici's `connect.lookup`.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.servers] - resolvers to pin (default public pair)
 * @param {{resolve4: Function}} [opts.resolver] - injectable Resolver (tests)
 * @param {Function} [opts.fallback] - injectable system lookup (tests)
 */
export function makePublicDnsLookup({
  servers = PUBLIC_DNS_SERVERS,
  resolver,
  fallback = dnsCallback.lookup,
} = {}) {
  let r = resolver;
  if (!r) {
    r = new dnsCallback.Resolver({ timeout: 3_000, tries: 2 });
    r.setServers(servers);
  }
  return function publicDnsLookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    r.resolve4(hostname, (err, addresses) => {
      if (err || !Array.isArray(addresses) || addresses.length === 0) {
        // Public DNS unreachable or empty — the system resolver is still
        // better than no answer at all.
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
