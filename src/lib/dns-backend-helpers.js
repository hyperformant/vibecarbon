/**
 * Leaf helpers the DNS backends (`<id>-dns.js`) share.
 *
 * Only what is the same in every backend that uses it lives here: header
 * construction, record-name conversion, the name-and-type match, and two
 * result shapes. Each backend keeps its own request flow (page walk, error
 * envelope, upsert, delete loop, setup spinner): those differ per provider,
 * and the source censuses under tests/unit/dns/ read them per backend file.
 */

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
export function zoneTooLongMessage(limit) {
  return `the zone has more than ${limit} records, more than vibecarbon reads`;
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
