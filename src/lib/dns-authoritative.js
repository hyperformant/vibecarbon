/**
 * What a domain's own nameservers answer for its A records, asked directly.
 *
 * The deploy uses it before it releases an address the domain used to point
 * at (lib/deploy/k8s/retired-reserved-ip.js): a released DigitalOcean reserved
 * IP goes back to the pool, and whoever gets it next can serve on any name
 * that still resolves to it. So the question is what the zone itself serves
 * now, not what one recursive resolver has cached:
 *
 *   1. the zone's nameservers: an NS lookup of the domain through the public
 *      resolvers, walking up a label at a time while the answer is "no NS
 *      here" (an `app.example.com` record lives in the `example.com` zone);
 *   2. each nameserver's IPv4 addresses, through the public resolvers;
 *   3. every name asked of every one of those addresses, with the answer's
 *      TTL (the record's own, since an authoritative server holds no cache).
 *
 * Every name looked up already exists (the deploy just wrote the records, or
 * the user keeps them), so no lookup here can seed a negative cache for a
 * name created later: DigitalOcean's nameservers hid a name for minutes after
 * a lookup made before it existed (direct probes, 2026-11-04).
 *
 * Any answer it could not get makes the whole lookup fail (`ok: false`, with
 * the reason): the caller keeps the address rather than release it on a
 * partial view. "No such name" and "no A record" are answers (empty), not
 * failures, except where the name is a CNAME: a nameserver answers an A
 * query for a CNAME whose target lives in another zone with the CNAME alone,
 * which c-ares reads as "no A record" (an empty list), while the target may
 * resolve to the very address. So "no A record" is asked again as a CNAME, and a CNAME fails the
 * lookup: this does not follow it. Bounded: each query has
 * AUTHORITATIVE_QUERY_TIMEOUT_MS and two tries, and they run side by side.
 */
import dnsCallback from 'node:dns';
import { PUBLIC_DNS_SERVERS, publicResolver } from './deploy/public-dns-lookup.js';

/** Per query, per try. Nameservers answer in tens of ms; two tries each. */
export const AUTHORITATIVE_QUERY_TIMEOUT_MS = 2_000;

/** c-ares codes that are an answer (the name or its A record does not exist). */
const NO_RECORD_CODES = new Set([dnsCallback.NODATA, dnsCallback.NOTFOUND]);

/**
 * The names whose records a deploy manages for `domain`: the apex and the
 * wildcard, as every DNS backend's setupSimple and setupHA write them.
 *
 * @param {string} domain
 * @returns {string[]}
 */
export function managedRecordNames(domain) {
  return [domain, `*.${domain}`];
}

/**
 * A Resolver pinned to `servers` for the authoritative queries: one per
 * server address, so one server's answer never stands in for another's.
 * Exported for the integration test, which points it at a local server.
 */
export function authoritativeResolver(servers) {
  const r = new dnsCallback.Resolver({ timeout: AUTHORITATIVE_QUERY_TIMEOUT_MS, tries: 2 });
  r.setServers(servers);
  return r;
}

/**
 * Promisified callback query: `{ value }` or `{ code }`. A query that throws
 * before it is sent (a name c-ares refuses) is a `{ code }` too, which no
 * caller reads as "no record".
 */
function ask(resolver, method, name, ...args) {
  return new Promise((resolve) => {
    try {
      resolver[method](name, ...args, (err, value) =>
        resolve(err ? { code: err.code ?? String(err) } : { value }),
      );
    } catch (err) {
      resolve({ code: err?.code ?? String(err) });
    }
  });
}

/**
 * The zone's nameserver host names: NS of `domain`, else of its parent, while
 * every public resolver says there is none at that name.
 *
 * @returns {Promise<{ok: true, zone: string, hosts: string[]} | {ok: false, reason: string}>}
 */
async function zoneNameservers(domain, { makePublicResolver, publicServers }) {
  const labels = String(domain).replace(/\.$/, '').split('.');
  for (let i = 0; labels.length - i >= 2; i++) {
    const name = labels.slice(i).join('.');
    const errors = [];
    for (const server of publicServers) {
      const { value, code } = await ask(makePublicResolver([server]), 'resolveNs', name);
      if (Array.isArray(value) && value.length > 0) {
        return {
          ok: true,
          zone: name,
          hosts: value.map((ns) => String(ns).replace(/\.$/, '').toLowerCase()),
        };
      }
      if (code && !NO_RECORD_CODES.has(code)) errors.push(`${server} ${code}`);
    }
    // A resolver that did not answer could have named the zone right here:
    // walking up past it would ask the parent's servers, which serve no A
    // records for this name.
    if (errors.length > 0) {
      return { ok: false, reason: `the NS lookup of ${name} failed (${errors.join(', ')})` };
    }
  }
  return { ok: false, reason: `no nameservers found for ${domain}` };
}

/**
 * A nameserver host's IPv4 addresses, from the first public resolver with any.
 *
 * SECURITY: a resolver that failed (a timeout, SERVFAIL, a refusal) is not a
 * host without addresses. When no resolver named any and one of them failed,
 * this fails (`ok: false`): that resolver could have named a server that
 * still answers with the address about to be released. Only "no such name"
 * and "no A record" from every resolver mean the host has none (`ips: []`),
 * which the caller refuses separately.
 *
 * @returns {Promise<{ok: true, ips: string[]} | {ok: false, reason: string}>}
 */
async function hostAddresses(host, { makePublicResolver, publicServers }) {
  const errors = [];
  for (const server of publicServers) {
    const { value, code } = await ask(makePublicResolver([server]), 'resolve4', host);
    if (Array.isArray(value) && value.length > 0) return { ok: true, ips: value };
    if (code && !NO_RECORD_CODES.has(code)) errors.push(`${server} ${code}`);
  }
  if (errors.length > 0) {
    return {
      ok: false,
      reason: `the address lookup of nameserver ${host} failed (${errors.join(', ')})`,
    };
  }
  return { ok: true, ips: [] };
}

/**
 * @typedef {{ name: string, server: string, host: string, addresses: string[], ttl: number|null }} AuthoritativeAnswer
 *   One nameserver address's answer for one name: its A records and their
 *   TTL in seconds (null when it has none).
 */

/**
 * Ask the zone's own nameservers for `names`' A records.
 *
 * @param {string[]} names - names under `domain` (managedRecordNames)
 * @param {object} o
 * @param {string} o.domain - the name the zone is found from
 * @param {(servers: string[]) => object} [o.makePublicResolver] - injectable (tests)
 * @param {(servers: string[]) => object} [o.makeAuthoritativeResolver] - injectable (tests)
 * @param {string[]} [o.publicServers]
 * @returns {Promise<{ok: true, zone: string, answers: AuthoritativeAnswer[]} | {ok: false, reason: string}>}
 */
export async function lookupAuthoritativeA(
  names,
  {
    domain,
    makePublicResolver = publicResolver,
    makeAuthoritativeResolver = authoritativeResolver,
    publicServers = PUBLIC_DNS_SERVERS,
  },
) {
  const deps = { makePublicResolver, publicServers };
  const ns = await zoneNameservers(domain, deps);
  if (!ns.ok) return ns;

  const servers = await Promise.all(
    ns.hosts.map(async (host) => ({ host, ...(await hostAddresses(host, deps)) })),
  );
  const failed = servers.filter((s) => !s.ok).map((s) => s.reason);
  if (failed.length > 0) return { ok: false, reason: failed.join('; ') };
  // SECURITY: a nameserver this cannot ask (no IPv4 address) is a part of the
  // zone's answer never seen; it fails the lookup rather than shrink it.
  const unresolved = servers.filter((s) => s.ips.length === 0).map((s) => s.host);
  if (unresolved.length > 0) {
    return { ok: false, reason: `no IPv4 address for nameserver ${unresolved.join(', ')}` };
  }

  const queries = servers.flatMap(({ host, ips }) =>
    ips.flatMap((ip) => names.map((name) => ({ host, ip, name }))),
  );
  const results = await Promise.all(
    queries.map(async ({ host, ip, name }) => {
      const resolver = makeAuthoritativeResolver([ip]);
      const { value, code } = await ask(resolver, 'resolve4', name, { ttl: true });
      if (code && !NO_RECORD_CODES.has(code)) {
        return { error: `no answer for ${name} at ${host} (${ip}): ${code}` };
      }
      // SECURITY: "no A record" may be a CNAME the server answered alone (its
      // target in another zone). Where it leads is not this zone's answer, so
      // a CNAME, or a CNAME query that fails, fails the lookup. Node 24's
      // c-ares hands that answer back as an empty list, not ENODATA (a local
      // server, tests/integration/dns/authoritative-lookup.test.ts), so both
      // spellings of "no A record" are asked again.
      const noA = code === dnsCallback.NODATA || (Array.isArray(value) && value.length === 0);
      if (noA) {
        const cname = await ask(resolver, 'resolveCname', name);
        if (Array.isArray(cname.value) && cname.value.length > 0) {
          return {
            error:
              `${name} at ${host} (${ip}) is a CNAME to ${cname.value.join(', ')}, ` +
              'which this check does not follow',
          };
        }
        if (cname.code && !NO_RECORD_CODES.has(cname.code)) {
          return { error: `no answer for ${name}'s CNAME at ${host} (${ip}): ${cname.code}` };
        }
      }
      const records = Array.isArray(value) ? value : [];
      return {
        answer: {
          name,
          server: ip,
          host,
          addresses: records.map((rec) => rec.address),
          ttl: records.length > 0 ? Math.max(...records.map((rec) => Number(rec.ttl) || 0)) : null,
        },
      };
    }),
  );
  const errors = results.filter((r) => r.error).map((r) => r.error);
  if (errors.length > 0) return { ok: false, reason: errors.join('; ') };
  return { ok: true, zone: ns.zone, answers: results.map((r) => r.answer) };
}
