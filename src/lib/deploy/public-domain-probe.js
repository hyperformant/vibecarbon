/**
 * The one way the CLI reaches an app's public domain from the operator's
 * machine: deploy's health and TLS probes, `vibecarbon status`'s readiness
 * and TLS rows, and deploy's failure diagnostics all go through here.
 *
 * Resolution goes through public DNS (makePublicDnsLookup), never the
 * operator's system resolver. Destroy deletes the record, and any query made
 * while it is gone is cached as NXDOMAIN for the zone's SOA minimum (30
 * minutes on DigitalOcean, an hour on Hetzner DNS). A redeploy inside that
 * window serves a healthy app the system resolver still calls nonexistent
 * (DO k8s-ha e2e, 2026-11-02: deploy passed, `status` seconds later said
 * `getaddrinfo ENOTFOUND`, because only deploy pinned its lookup). See
 * public-dns-lookup.js for why `dns.setServers` cannot do this and the socket
 * `lookup` option can.
 *
 * Trust policy, shared by every caller: full verification against the
 * platform roots, plus the vendored Let's Encrypt staging roots when
 * ACME_CA_SERVER points at staging (staging-ca.js). `verifyTls: false` is the
 * one opt-out, used only by the k8s deploy's app phase (see probePublicHealth).
 *
 * tests/unit/deploy/public-domain-probe-census.test.ts fails on any request to
 * an `https://${domain}` URL in src/ that does not route through this module.
 */

import tls from 'node:tls';
import { Agent, Response, fetch as undiciFetch } from 'undici';
import { readOperatorVar } from '../operator-env.js';
import { makePublicDnsLookup, resolvePublicA } from './public-dns-lookup.js';
import { stagingProbeCa } from './staging-ca.js';

/**
 * The trust store a verifying probe uses: undefined (the platform roots) on
 * production ACME, the platform roots plus the LE staging roots on staging.
 *
 * @returns {string[]|undefined}
 */
export function probeTrustStore() {
  return (readOperatorVar('ACME_CA_SERVER').value || '').includes('staging')
    ? stagingProbeCa()
    : undefined;
}

/**
 * Socket options for a connection to `domain`: public-DNS lookup, SNI pinned
 * to the domain, the shared trust policy.
 *
 * @param {string} domain
 * @param {{ verifyTls?: boolean, lookup?: Function, ca?: string[] }} [opts]
 *   `lookup` and `ca` are test seams.
 * @returns {Record<string, unknown>} undici `connect` / `tls.connect` options
 */
export function publicProbeConnect(domain, { verifyTls = true, lookup, ca } = {}) {
  const opts = { lookup: lookup ?? makePublicDnsLookup(), servername: domain };
  if (verifyTls === false) {
    opts.rejectUnauthorized = false;
  } else {
    const trust = ca ?? probeTrustStore();
    if (trust) opts.ca = trust;
  }
  return opts;
}

/** Statuses whose Response may not carry a body. */
const NULL_BODY_STATUS = new Set([204, 205, 304]);

/**
 * `fetch` an `https://<domain>/...` URL through public DNS. Each call gets its
 * own dispatcher (a fresh lookup, no pooled socket to a stale address), the
 * body is read in full, and the dispatcher is closed before returning, so a
 * short-lived command never waits on an idle keep-alive socket. The response
 * is a standard Response over the buffered body. The app's health endpoints
 * answer a few hundred bytes.
 *
 * undici's Agent and undici's fetch are always paired: Node's bundled fetch
 * rejects the npm package's Agent (`invalid onRequestStart method`).
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{ verifyTls?: boolean, lookup?: Function, ca?: string[], port?: number }} [opts]
 *   `lookup`, `ca` and `port` are test seams (`port` dials a local server in
 *   place of the URL's own port)
 * @returns {Promise<Response>}
 */
export async function fetchPublicDomain(url, init = {}, { port, ...opts } = {}) {
  const target = new URL(url);
  if (port) target.port = String(port);
  const dispatcher = new Agent({ connect: publicProbeConnect(target.hostname, opts) });
  try {
    const res = await undiciFetch(target, { ...init, dispatcher });
    const body = NULL_BODY_STATUS.has(res.status) ? null : await res.arrayBuffer();
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  } finally {
    await dispatcher.destroy().catch(() => {});
  }
}

/**
 * `tls.connect` with the host resolved through public DNS. The caller's
 * own socket options (SNI, trust store, verification) are passed as given.
 *
 * @param {import('node:tls').ConnectionOptions} options
 * @param {() => void} [onSecure]
 * @param {{ lookup?: Function }} [opts] `lookup` is a test seam
 * @returns {import('node:tls').TLSSocket}
 */
export function connectPublicTls(options, onSecure, { lookup } = {}) {
  return tls.connect({ ...options, lookup: lookup ?? makePublicDnsLookup() }, onSecure);
}

/**
 * The curl arguments that pin `domain`:443 to its public answer
 * (`--resolve domain:443:ip`), for an operator-side curl. Empty when nothing
 * resolves, so curl reports its own failure.
 *
 * @param {string} domain
 * @param {{ resolve?: (hostname: string) => Promise<string[]> }} [opts]
 * @returns {Promise<string[]>}
 */
export async function publicCurlResolveArgs(domain, { resolve = resolvePublicA } = {}) {
  const ips = await resolve(domain).catch(() => []);
  return ips.length > 0 ? ['--resolve', `${domain}:443:${ips[0]}`] : [];
}
