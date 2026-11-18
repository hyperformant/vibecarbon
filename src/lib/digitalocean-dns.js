/**
 * DigitalOcean DNS Operations
 *
 * DNS management through the DigitalOcean API v2 (api.digitalocean.com/v2).
 * Uses the same API token as droplet operations — no additional credentials.
 *
 * Zone identity is the domain NAME, not a numeric id: every records call is
 * `/v2/domains/{domain_name}/records`, so the `zoneId` parameter every
 * function here takes carries the domain name. `getZones` therefore returns
 * `{id, name}` rows where both fields hold the same string — the shape keeps
 * DO interchangeable with the id-keyed backends (Linode, Hetzner) at the
 * registry level.
 *
 * API documentation verified against (2026-08-08):
 *   - https://raw.githubusercontent.com/digitalocean/openapi/main/specification/resources/domains/models/domain_record.yml
 *     (A-record IPv4 lives in `data`; apex `name` is `@`)
 *   - https://raw.githubusercontent.com/digitalocean/openapi/main/specification/resources/domains/domains_list_records.yml
 *   - https://raw.githubusercontent.com/digitalocean/openapi/main/specification/resources/domains/domains_create_record.yml
 *     (POST → 201, body nested under `domain_record`)
 *   - https://raw.githubusercontent.com/digitalocean/openapi/main/specification/resources/domains/domains_update_record.yml
 *     (update is PUT /v2/domains/{name}/records/{id})
 *   - https://raw.githubusercontent.com/digitalocean/openapi/main/specification/resources/domains/responses/all_domain_records_response.yml
 *     (array key `domain_records`; page walk via `links.pages.next`)
 *   - https://docs.digitalocean.com/products/networking/dns/details/limits/
 *     ("All DNS records require a minimum TTL value of 30 seconds" — our 60
 *     clears the floor, so DO carries the project-wide failover TTL verbatim)
 */

import {
  aTargetsAt,
  bearerHeaders,
  bearerJsonHeaders,
  deleteOwnedRecords,
  matching,
  namesPointingAt,
  pairDeleteResult,
  setupApexAndWildcard,
  setupHaRecords,
  toRelativeName,
  wholeZone,
} from './dns-backend-helpers.js';
import { fetchWithRetry } from './fetch-retry.js';

const API_BASE = 'https://api.digitalocean.com/v2';

// Default TTL for HA records (low for fast failover propagation)
const HA_TTL = 60;
// Default TTL for standard records (low to prevent stale DNS between runs)
const DEFAULT_TTL = 60;

// per_page ceiling we ask for, and the page-walk guard. 200 x 20 = 4000
// records, far beyond any zone we manage; the guard exists so a server-side
// pagination bug can't spin a deploy forever (same idiom as the sibling
// providers' walks in src/lib/providers/digitalocean.js).
const PER_PAGE = 200;
const MAX_PAGES = 20;

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Convert an FQDN to a zone-relative name for the DigitalOcean DNS API.
 *
 *   example.com      (zone: example.com) → "@"
 *   *.example.com    (zone: example.com) → "*"
 *   sub.example.com  (zone: example.com) → "sub"
 *   a.b.example.com  (zone: example.com) → "a.b"
 *
 * @param {string} fqdn - Fully qualified domain name
 * @param {string} zoneName - Zone name (e.g. "example.com")
 * @returns {string} Zone-relative record name
 */
function fqdnToRelative(fqdn, zoneName) {
  return toRelativeName(fqdn, zoneName, '@');
}

/**
 * DO's error envelope is `{id, message, request_id}`; the same shape every
 * DigitalOceanProvider call site already unwraps. Never interpolate the token.
 * @param {Response} response
 * @param {string} prefix
 * @returns {Promise<Error>}
 */
async function apiError(response, prefix) {
  const body = await response.json().catch(() => ({}));
  return new Error(
    `${prefix}: ${body.message || response.statusText || `HTTP ${response.status}`}`,
  );
}

/**
 * Walk a paginated DO collection to completion. Past MAX_PAGES the walk
 * stops: by default with what it has read, or, given `pastGuard`, by
 * throwing it, for a caller that must not take part of the collection for
 * the whole (findARecordsAt, deleteDNSRecord).
 * @param {string} apiToken
 * @param {string} path - e.g. '/domains' (no query)
 * @param {string} key - response array key (e.g. 'domains')
 * @param {string} errorPrefix
 * @param {{pastGuard?: string}} [options] - the error a walk past the guard throws
 * @returns {Promise<object[]>}
 */
async function walkPages(apiToken, path, key, errorPrefix, { pastGuard } = {}) {
  const items = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await fetchWithRetry(`${API_BASE}${path}?per_page=${PER_PAGE}&page=${page}`, {
      headers: bearerHeaders(apiToken),
    });

    if (!response.ok) throw await apiError(response, errorPrefix);

    const data = await response.json();
    if (Array.isArray(data[key])) items.push(...data[key]);

    if (!data.links?.pages?.next) return items;
  }

  if (pastGuard) throw new Error(pastGuard);
  return items;
}

/**
 * Every record in a zone. DO's list endpoint does accept `name`/`type` query
 * filters, but we deliberately don't use them: the filter takes a *fully
 * qualified* name while the records come back zone-relative, and relying on
 * the server to agree with us about how a wildcard (`*.example.com`) is
 * spelled would turn a filter miss into a duplicate-record create. Listing
 * the zone and filtering client-side is a handful of records either way, and
 * makes this backend behave identically to the Linode/Vultr twins.
 *
 * @param {string} apiToken
 * @param {string} zoneName - the domain name (DO's zone identity)
 * @param {{whole?: boolean}} [options] - whole: throw rather than return
 *   part of a zone longer than the walk reads
 * @returns {Promise<object[]>}
 */
async function getRecords(apiToken, zoneName, { whole = false } = {}) {
  return walkPages(
    apiToken,
    `/domains/${zoneName}/records`,
    'domain_records',
    'DigitalOcean DNS API error',
    wholeZone(whole, MAX_PAGES * PER_PAGE),
  );
}

// ============================================================================
// LOW-LEVEL API FUNCTIONS
// ============================================================================

/**
 * Get all DNS zones (domains) in the DigitalOcean account.
 *
 * @param {string} apiToken - DigitalOcean API token
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
export async function getZones(apiToken) {
  const domains = await walkPages(apiToken, '/domains', 'domains', 'DigitalOcean DNS API error');
  // The name IS the id on DO — see the module header.
  return domains.map((d) => ({ id: d.name, name: d.name }));
}

/**
 * Create or update a DNS record.
 *
 * Update-or-create, never blind-create: a second deploy into the same zone
 * must repoint the existing record rather than stack a second A record beside
 * it (two A records at the apex would round-robin traffic at a dead IP).
 *
 * @param {string} apiToken - DigitalOcean API token
 * @param {string} zoneId - Zone identity — the domain NAME on DO
 * @param {object} config
 * @param {string} config.type - Record type (A, AAAA, CNAME, ...)
 * @param {string} config.name - Record name (FQDN — converted to relative here)
 * @param {string} config.value - Record value (e.g. IP address)
 * @param {number} [config.ttl] - TTL in seconds (default 60)
 * @returns {Promise<object>} The created/updated domain_record object
 */
export async function createDNSRecord(apiToken, zoneId, config) {
  const { type, name, value, ttl = DEFAULT_TTL } = config;
  const relativeName = fqdnToRelative(name, zoneId);

  const existing = await getRecords(apiToken, zoneId);
  const match = matching(existing, relativeName, String(name).replace(/\.$/, ''), type)[0];

  const body = JSON.stringify({ type, name: relativeName, data: value, ttl });
  const headers = bearerJsonHeaders(apiToken);

  if (match) {
    const response = await fetchWithRetry(`${API_BASE}/domains/${zoneId}/records/${match.id}`, {
      method: 'PUT',
      headers,
      body,
    });
    if (!response.ok) throw await apiError(response, 'Failed to update DNS record');
    const data = await response.json();
    return data.domain_record;
  }

  const response = await fetchWithRetry(`${API_BASE}/domains/${zoneId}/records`, {
    method: 'POST',
    headers,
    body,
  });
  if (!response.ok) throw await apiError(response, 'Failed to create DNS record');
  const data = await response.json();
  return data.domain_record;
}

/**
 * Read every A record target at a name, for verifying a flip. Empty when the
 * name has no A record; a stale second value must stay visible.
 *
 * @param {string} apiToken
 * @param {string} zoneId - Zone identity
 * @param {string} name - Record name (FQDN)
 * @returns {Promise<string[]>}
 */
export async function readARecord(apiToken, zoneId, name) {
  const records = await getRecords(apiToken, zoneId);
  return aTargetsAt(records, fqdnToRelative(name, zoneId), name);
}

/**
 * Every A record in the zone whose value is `address`, by fully qualified
 * name. The deploy asks before it releases an address the domain used to
 * point at (lib/deploy/k8s/retired-reserved-ip.js): a record outside the
 * apex and the wildcard, one the user added, would hand its name to whoever
 * the address goes to next. Throws when the zone's records cannot be listed,
 * or not all of them (more pages than the walk reads).
 *
 * @param {string} apiToken
 * @param {string} zoneId - Zone identity
 * @param {string} address - an IPv4 address
 * @returns {Promise<string[]>} sorted, each name once
 */
export async function findARecordsAt(apiToken, zoneId, address) {
  // The whole zone or a throw: a partial read that missed the record would
  // let the address go.
  const records = await getRecords(apiToken, zoneId, { whole: true });
  return namesPointingAt(records, address, zoneId);
}

/** @typedef {import('./dns-backend-helpers.js').DnsDeleteFailure} DnsDeleteFailure */

/**
 * Delete a DNS record, but only if its target IP belongs to this caller.
 *
 * DO stores one row per record (like Cloudflare, unlike Hetzner's rrsets), so
 * ownership is filtered per record and the return is the Cloudflare *count*
 * shape rather than Hetzner's boolean.
 *
 * Ownership rule: a record is "ours" iff its `data` (the target IP) is in
 * `ownedIps`. Records pointing elsewhere are preserved and surfaced in
 * `skippedTargets`. An empty `ownedIps` refuses every delete — the safer
 * default when envConfig has no server IPs to compare against, and the exact
 * case behind the 2026-05-16 blast-radius bug where one scenario's destroy
 * zeroed a neighbour's record in a shared zone.
 *
 * Reads the whole zone or throws: past the page guard a partial read would
 * miss the record and answer `total: 0`, and destroy would report it gone
 * while it still points at an address being released. destroy's DNS cleanup
 * catches the throw and reports the records as a leak.
 *
 * @param {string} apiToken - DigitalOcean API token
 * @param {string} zoneId - Zone identity — the domain NAME on DO
 * @param {string} name - Record name (FQDN)
 * @param {string[]} ownedIps - IPs that belong to this caller's stack
 * @param {string} [type='A'] - Record type
 * @returns {Promise<{deleted: number, skipped: number, total: number, skippedTargets: string[], failed: DnsDeleteFailure[]}>}
 */
export async function deleteDNSRecord(apiToken, zoneId, name, ownedIps, type = 'A') {
  const all = await getRecords(apiToken, zoneId, { whole: true });
  return deleteOwnedRecords(
    all,
    { relativeName: fqdnToRelative(name, zoneId), name, type, ownedIps },
    (record) =>
      fetchWithRetry(`${API_BASE}/domains/${zoneId}/records/${record.id}`, {
        method: 'DELETE',
        headers: bearerHeaders(apiToken),
      }),
  );
}

/**
 * Delete the apex + wildcard A-record pair for a domain, ownership-filtered
 * (same `ownedIps` contract as `deleteDNSRecord`). Mirrors
 * `upsertApexAndWildcard` on the create side: deploy always creates both
 * records, so every destroy path must delete both too — deleting only the
 * root orphans the wildcard at a released IP a stranger could later be
 * assigned (the M3 Task 9i class; see cloudflare.js for the full RCA).
 * Every DNS backend carries this helper so no destroy path can pick a
 * provider that lacks it.
 *
 * @param {string} apiToken - DigitalOcean API token
 * @param {string} zoneId - Zone identity — the domain NAME on DO
 * @param {string} domain - Apex domain (the wildcard record is `*.<domain>`)
 * @param {string[]} ownedIps - IPs that belong to this caller's stack
 * @returns {Promise<{deletedAny: boolean, preservedTargets: string[], failed: DnsDeleteFailure[]}>}
 */
export async function deleteApexAndWildcard(apiToken, zoneId, domain, ownedIps) {
  const [root, wildcard] = await Promise.all([
    deleteDNSRecord(apiToken, zoneId, domain, ownedIps),
    deleteDNSRecord(apiToken, zoneId, `*.${domain}`, ownedIps),
  ]);
  return pairDeleteResult(root, wildcard);
}

/**
 * Create/update the apex + wildcard A records for a domain, both pointed at
 * the same IP (ttl 60). This is the failover flip primitive — scale.js's
 * post-scale DNS update and failover.js's `updateDns` both repoint every
 * subdomain (api, registry, ...) at whichever server IP is currently primary.
 *
 * @param {object} auth
 * @param {string} auth.token - DigitalOcean API token
 * @param {string} auth.zoneId - Zone identity — the domain NAME on DO
 * @param {string} domain - Apex domain (the wildcard record is `*.<domain>`)
 * @param {string} ip - Target IP address
 * @returns {Promise<void>}
 */
export async function upsertApexAndWildcard(auth, domain, ip) {
  const { token, zoneId } = auth;
  await createDNSRecord(token, zoneId, { type: 'A', name: domain, value: ip, ttl: HA_TTL });
  await createDNSRecord(token, zoneId, {
    type: 'A',
    name: `*.${domain}`,
    value: ip,
    ttl: HA_TTL,
  });
}

// ============================================================================
// HIGH-LEVEL SETUP FUNCTIONS
// ============================================================================

/**
 * Set up DigitalOcean DNS for a simple single-server deployment.
 * Creates root A and wildcard A records.
 *
 * @param {string} apiToken - DigitalOcean API token
 * @param {string} zoneId - Zone identity — the domain NAME on DO
 * @param {string} domain - Domain name (e.g. "app.example.com")
 * @param {string} serverIp - Server IP address
 * @param {object} [options]
 * @param {Function} [options.onProgress] - Progress callback (skips internal spinners)
 * @returns {Promise<object>} Setup result
 */
export async function setupSimple(apiToken, zoneId, domain, serverIp, options = {}) {
  return setupApexAndWildcard({
    label: 'DigitalOcean',
    domain,
    ip: serverIp,
    ttl: DEFAULT_TTL,
    write: (config) => createDNSRecord(apiToken, zoneId, config),
    onProgress: options.onProgress,
  });
}

/**
 * Set up DigitalOcean DNS for an HA deployment.
 * Creates root A and wildcard A records pointing to the primary server,
 * with a low TTL for fast failover propagation.
 *
 * Note: DigitalOcean DNS has no health checks or load balancers in this path.
 * Failover is triggered manually via `vibecarbon failover`.
 *
 * @param {string} apiToken - DigitalOcean API token
 * @param {string} zoneId - Zone identity — the domain NAME on DO
 * @param {string} domain - Domain name
 * @param {Array} servers - Array of { name, ip, region } objects (primary first)
 * @param {{onProgress?: (msg: string) => void}} [options] - onProgress: the
 *   caller owns the line, so no spinner of our own starts
 * @returns {Promise<object>} Setup result
 */
export async function setupHA(apiToken, zoneId, domain, servers, options = {}) {
  return setupHaRecords({
    label: 'DigitalOcean',
    domain,
    servers,
    ttl: HA_TTL,
    write: (config) => createDNSRecord(apiToken, zoneId, config),
    onProgress: options.onProgress,
  });
}
