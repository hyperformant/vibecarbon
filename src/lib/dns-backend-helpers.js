/**
 * Leaf helpers the DNS backends (`<id>-dns.js`) share.
 *
 * Only what is the same in every backend that uses it lives here: header
 * construction, record-name conversion, the name-and-type match, the record
 * reads over a listed zone, the ownership-filtered delete loop around a
 * backend's own delete request, two result shapes, and the two setup flows
 * the non-Cloudflare backends run around their own record writer. Each
 * backend keeps its own requests (page walk, error envelope, upsert,
 * delete): those differ per provider, and the source censuses under
 * tests/unit/dns/ read them per backend file.
 *
 * It also holds the A record shape the failover flip judges (ARecord), the
 * apex-and-wildcard write that returns it, and the one rule its callers share
 * for which listed records a write did not name (otherARecords).
 */

import { spinner } from './cli/progress.js';

/**
 * Bearer auth for a request with no body. Never interpolate the token into a
 * URL or an error.
 * @param {string} apiToken
 * @returns {{Authorization: string}}
 */
export function bearerHeaders(apiToken) {
  return { Authorization: `Bearer ${apiToken}` };
}

/**
 * Bearer auth for a request that carries a JSON body.
 * @param {string} apiToken
 * @returns {{Authorization: string, 'Content-Type': string}}
 */
export function bearerJsonHeaders(apiToken) {
  return { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' };
}

/**
 * Convert an FQDN to the name a zone stores, relative to the zone. Providers
 * spell the apex differently, so the caller says how (`'@'` or `''`):
 *
 *   example.com      (zone: example.com) → apex
 *   *.example.com    (zone: example.com) → "*"
 *   sub.example.com  (zone: example.com) → "sub"
 *   a.b.example.com  (zone: example.com) → "a.b"
 *
 * @param {string} fqdn - Fully qualified domain name
 * @param {string} zoneName - Zone name (e.g. "example.com")
 * @param {string} apex - the provider's spelling of the zone apex
 * @returns {string} Zone-relative record name
 */
export function toRelativeName(fqdn, zoneName, apex) {
  const clean = String(fqdn).replace(/\.$/, '');
  const zone = String(zoneName).replace(/\.$/, '');

  if (clean === zone) return apex;
  if (clean === `*.${zone}`) return '*';
  if (clean.endsWith(`.${zone}`)) {
    return clean.slice(0, -(zone.length + 1));
  }
  // No match: the caller may have already passed a relative name.
  return clean;
}

/**
 * A record's name as the zone stores it, fully qualified: the apex spelling
 * ('@', '') is the zone itself, a name already under the zone stays.
 * @param {string} name
 * @param {string} zoneName
 * @returns {string}
 */
export function relativeToFqdn(name, zoneName) {
  const clean = String(name ?? '').replace(/\.$/, '');
  const zone = String(zoneName).replace(/\.$/, '');
  if (clean === '@' || clean === '' || clean === zone) return zone;
  if (clean.endsWith(`.${zone}`)) return clean;
  return `${clean}.${zone}`;
}

/**
 * Records at a given (relative name, type). Either spelling of the name
 * matches, relative or fully qualified, so a zone that stores the other one
 * cannot turn an update into a duplicate create: Linode documents a record's
 * `name` as "the hostname or FQDN", and Vultr's reference shows both.
 * @param {object[]} records
 * @param {string} relativeName
 * @param {string} fqdn
 * @param {string} type
 * @returns {object[]}
 */
export function matching(records, relativeName, fqdn, type) {
  return records.filter((r) => r.type === type && (r.name === relativeName || r.name === fqdn));
}

/**
 * The error a whole-zone read throws when the zone is longer than the page
 * walk reads (findARecordsAt, deleteDNSRecord): part of a zone must not pass
 * for the whole.
 * @param {number} limit - the most records the walk reads
 * @returns {string}
 */
function zoneTooLongMessage(limit) {
  return `the zone has more than ${limit} records, more than vibecarbon reads`;
}

/**
 * A backend's page-walk options for getRecords: a whole-zone read throws past
 * the page guard rather than return part of the zone.
 * @param {boolean} whole
 * @param {number} limit - the most records the walk reads
 * @returns {{pastGuard?: string}}
 */
export function wholeZone(whole, limit) {
  return whole ? { pastGuard: zoneTooLongMessage(limit) } : {};
}

/**
 * An A record as the failover flip judges it: the provider's id for the
 * record and the address it holds.
 *
 * Every backend but Hetzner stores one row per record, and the id is that
 * row's. Hetzner stores every value at a (name, type) as one rrset that a
 * write replaces whole, so each value carries the rrset's key, `<name>/<type>`:
 * the set a write's response returns is then the whole truth at the name, and
 * the list can show no record there that the write did not name. One shape,
 * so flipAndVerifyDns has one rule for every backend.
 *
 * @typedef {{ id: string, value: string }} ARecord
 */

/**
 * The A record a backend's write response returned, as ARecords: the record
 * the provider says it now holds. Empty when the response names no id or no
 * address; the flip then fails, since nothing proves what the record holds.
 * @param {object|null|undefined} record - the record from the write's response
 * @param {string} [field='data'] - the record field that holds the address
 * @returns {ARecord[]}
 */
export function writtenARecords(record, field = 'data') {
  const id = record?.id;
  const value = record?.[field];
  if (id == null || id === '' || typeof value !== 'string') return [];
  return [{ id: String(id), value }];
}

/**
 * Every A record at a name, with its id, for readARecords: what the zone's
 * list shows. Empty when the name has no A record; a stale second record
 * stays visible.
 * @param {object[]} records - the zone's records
 * @param {string} relativeName - the name as the backend stores it
 * @param {string} name - the name, fully qualified
 * @param {string} [field='data'] - the record field that holds the address
 * @returns {ARecord[]}
 */
export function aRecordsAt(records, relativeName, name, field = 'data') {
  const fqdn = String(name).replace(/\.$/, '');
  return matching(records, relativeName, fqdn, 'A').map((r) => ({
    id: String(r.id),
    value: r[field],
  }));
}

/**
 * The listed A records a write did not name. The list can lag the write (on
 * 2026-11-19 Linode's record list served a record's old value in the same
 * second its event log recorded the update to the new one), so a record the
 * write named is judged by the write's response, never by the list; the list
 * only finds the others, such as a stale second record that keeps traffic on
 * a retired node.
 * @param {ARecord[]|null|undefined} listed - the list's A records at the name
 * @param {ARecord[]|null|undefined} written - what the write's response returned there
 * @returns {ARecord[]}
 */
export function otherARecords(listed, written) {
  const ours = new Set((written ?? []).map((r) => r.id));
  return (listed ?? []).filter((r) => !ours.has(r.id));
}

/**
 * upsertApexAndWildcard's shared body: each record through the backend's own
 * `write`, one after the other (Scaleway's zone serial forbids two in flight),
 * which returns the ARecords its response holds. Returns them by name. A write
 * that throws carries what the writes before it returned as `error.written`:
 * scale reads the records back after a failed update (readDnsMove), and a
 * record that landed is judged by its own response there too.
 * @param {Array<{type: string, name: string, value: string, ttl?: number}>} records - the apex, then the wildcard
 * @param {(config: {type: string, name: string, value: string, ttl?: number}) => Promise<ARecord[]>} write
 * @returns {Promise<Record<string, ARecord[]>>}
 */
export async function writeARecords(records, write) {
  const written = {};
  for (const config of records) {
    try {
      written[config.name] = await write(config);
    } catch (error) {
      if (error && typeof error === 'object') error.written = { ...written };
      throw error;
    }
  }
  return written;
}

/**
 * Every A record name whose value is `address`, fully qualified: what
 * findARecordsAt answers from a whole-zone read.
 * @param {object[]} records - the whole zone's records
 * @param {string} address - an IPv4 address
 * @param {string} zoneName
 * @param {string} [field='data'] - the record field that holds the address
 * @returns {string[]} sorted, each name once
 */
export function namesPointingAt(records, address, zoneName, field = 'data') {
  const names = records
    .filter((r) => r.type === 'A' && r[field] === address)
    .map((r) => relativeToFqdn(r.name, zoneName));
  return [...new Set(names)].sort();
}

/**
 * The records at one (name, type), split by ownership. A record is ours iff
 * the address it holds is in `ownedIps`; an empty `ownedIps` owns nothing,
 * the safer default when the caller has no server IPs to compare against
 * (the 2026-05-16 blast-radius bug, where one scenario's destroy zeroed a
 * neighbour's record in a shared zone). Order is the zone's.
 * @param {object[]} records - the whole zone's records
 * @param {{relativeName: string, name: string, type: string, ownedIps?: string[], field?: string}} at
 * @returns {{fqdn: string, total: number, owned: object[], skippedTargets: string[]}}
 */
export function recordsOwnedAt(records, { relativeName, name, type, ownedIps, field = 'data' }) {
  const fqdn = String(name).replace(/\.$/, '');
  const atName = matching(records, relativeName, fqdn, type);
  const ours = new Set(ownedIps || []);
  return {
    fqdn,
    total: atName.length,
    owned: atName.filter((r) => ours.has(r[field])),
    skippedTargets: atName.filter((r) => !ours.has(r[field])).map((r) => r[field]),
  };
}

/**
 * A record delete the DNS API refused: the record still exists. A 404 is a
 * record already gone, never one of these. destroy reports each as a leak.
 * @typedef {{name: string, target: string, reason: string}} DnsDeleteFailure
 */

/**
 * deleteDNSRecord for a backend that stores one row per record and deletes
 * them one request at a time: each owned record at the name, in zone order,
 * through the backend's own `remove`. A 404 is a record already gone.
 * @param {object[]} records - the whole zone's records
 * @param {{relativeName: string, name: string, type: string, ownedIps?: string[], field?: string}} at
 * @param {(record: object) => Promise<Response>} remove - the backend's DELETE of one record
 * @returns {Promise<{deleted: number, skipped: number, total: number, skippedTargets: string[], failed: DnsDeleteFailure[]}>}
 */
export async function deleteOwnedRecords(records, at, remove) {
  const field = at.field ?? 'data';
  const { fqdn, total, owned, skippedTargets } = recordsOwnedAt(records, at);
  let deleted = 0;
  const failed = [];
  for (const record of owned) {
    const response = await remove(record);
    if (response.ok) deleted++;
    else if (response.status !== 404) {
      failed.push({ name: fqdn, target: record[field], reason: `HTTP ${response.status}` });
    }
  }
  return { deleted, skipped: skippedTargets.length, total, skippedTargets, failed };
}

/**
 * deleteApexAndWildcard's result, from the two deleteDNSRecord results.
 * @typedef {{deleted: number, skippedTargets: string[], failed: object[]}} DeleteResult
 * @param {DeleteResult} root
 * @param {DeleteResult} wildcard
 * @returns {{deletedAny: boolean, preservedTargets: string[], failed: object[]}}
 */
export function pairDeleteResult(root, wildcard) {
  return {
    deletedAny: root.deleted > 0 || wildcard.deleted > 0,
    preservedTargets: [...root.skippedTargets, ...wildcard.skippedTargets],
    failed: [...root.failed, ...wildcard.failed],
  };
}

/**
 * A backend's own create-or-update writer for one record.
 * @typedef {(config: {type: string, name: string, value: string, ttl: number}) => Promise<object>} RecordWriter
 */

/**
 * The single-server setup every backend but Cloudflare runs: the apex and
 * wildcard A records at one IP. With `onProgress` the caller owns the line,
 * so no spinner of our own starts (a second one garbles it). Never throws: a
 * refused write returns `{success: false, error}`, and every caller reads it
 * (dns-setup-result-consumed-census).
 *
 * @param {object} args
 * @param {string} args.label - the provider, as the failure line names it
 * @param {string} args.domain - the apex (the wildcard is `*.<domain>`)
 * @param {string} args.ip - the target address
 * @param {number} args.ttl
 * @param {RecordWriter} args.write - the backend's record writer
 * @param {boolean} [args.withRecord=true] - false answers without the apex
 *   record the writer returned (Hetzner never returned it)
 * @param {(msg: string) => void} [args.onProgress] - progress callback (skips the spinner)
 * @returns {Promise<object>} setup result
 */
export async function setupApexAndWildcard({
  label,
  domain,
  ip,
  ttl,
  write,
  withRecord = true,
  onProgress,
}) {
  const s = onProgress ? null : spinner();

  try {
    s?.start(`Creating DNS records for ${domain}`);
    onProgress?.(`Creating DNS records for ${domain}`);

    const record = await write({ type: 'A', name: domain, value: ip, ttl });

    // Wildcard A record for subdomains (registry, api, etc.)
    await write({ type: 'A', name: `*.${domain}`, value: ip, ttl });

    s?.stop('DNS records created (root + wildcard)');
    onProgress?.('DNS records created (root + wildcard)');

    return withRecord
      ? { success: true, mode: 'simple', record }
      : { success: true, mode: 'simple' };
  } catch (error) {
    s?.stop(`${label} DNS setup failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * The HA setup every backend but Cloudflare runs: the apex and wildcard A
 * records at the primary (`servers[0]`, an explicit target list from the
 * deploy effect that just provisioned the pair, not a lookup), at the
 * backend's failover TTL. No health checks or load balancers: failover is
 * triggered by hand with `vibecarbon failover`. Same spinner and result
 * contract as setupApexAndWildcard.
 *
 * @param {object} args
 * @param {string} args.label - the provider, as the failure line names it
 * @param {string} args.domain - the apex (the wildcard is `*.<domain>`)
 * @param {Array<{ip: string}>} args.servers - primary first, then the standby
 * @param {number} args.ttl - the backend's HA_TTL
 * @param {RecordWriter} args.write - the backend's record writer
 * @param {() => Promise<void>} [args.prepare] - a read the writer needs,
 *   run before the spinner starts (Linode resolves its zone name here)
 * @param {(msg: string) => void} [args.onProgress] - progress callback (skips the spinner)
 * @returns {Promise<object>} setup result
 */
export async function setupHaRecords({ label, domain, servers, ttl, write, prepare, onProgress }) {
  const s = onProgress ? null : spinner();

  try {
    if (prepare) await prepare();

    s?.start(`Creating DNS record for ${domain}`);
    onProgress?.(`Creating DNS record for ${domain}`);
    await write({ type: 'A', name: domain, value: servers[0].ip, ttl });
    s?.stop('Primary DNS record created');

    await write({ type: 'A', name: `*.${domain}`, value: servers[0].ip, ttl });

    return {
      success: true,
      mode: 'dns',
      primaryIp: servers[0].ip,
      standbyIp: servers[1]?.ip,
    };
  } catch (error) {
    s?.stop(`${label} DNS setup failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}
