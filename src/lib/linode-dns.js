/**
 * Linode DNS Operations
 *
 * DNS management through the Linode API v4 (api.linode.com/v4). Uses the same
 * personal access token as instance operations — no additional credentials.
 *
 * Zone identity is a NUMERIC domain id (unlike DigitalOcean and Vultr, where
 * it is the domain name), so the `zoneId` every function takes is that id as a
 * string. Turning a caller's FQDN into Linode's relative form needs the
 * domain's *name*, which costs one `GET /v4/domains/{id}` — the public entry
 * points resolve it once and hand it down to the private core, exactly as
 * hetzner-dns.js threads `zoneName` through its own helpers.
 *
 * TTL DEVIATION — read before changing: the DNS-backend contract asks for
 * TTL 60 everywhere (the failover story), but Linode's `ttl_sec` is an enum
 * whose floor is 300. The API does not reject an out-of-enum value; it rounds
 * it, so a literal 60 would be silently stored as 300 and every read-back
 * would disagree with what we sent. We round to the nearest allowed member
 * client-side instead, which makes the wire value and the stored value the
 * same number. Net effect: Linode zones propagate a failover flip in up to
 * 300s rather than 60s.
 *
 * API documentation verified against (2026-08-08):
 *   - https://techdocs.akamai.com/linode-api/reference/get-domain-records
 *     (A-record IP is `target`; TTL field is `ttl_sec`; apex `name` is the
 *     empty string; envelope is `{data, page, pages, results}`)
 *   - https://techdocs.akamai.com/linode-api/reference/post-domain-record
 *     ("Valid values are 300, 3600, 7200, 14400, 28800, 57600, 86400, 172800,
 *     345600, 604800, 1209600, and 2419200 - any other value will be rounded
 *     to the nearest valid value.")
 *   - https://techdocs.akamai.com/linode-api/reference/put-domain-record
 *     (update is PUT /v4/domains/{domainId}/records/{recordId}; the record is
 *     returned at the top level, not nested under a key)
 */

import { challengeRecordNames } from './acme-challenge.js';
import { spinner } from './cli/progress.js';
import { fetchWithRetry } from './fetch-retry.js';

const API_BASE = 'https://api.linode.com/v4';

// The TTL the rest of the CLI asks for. Linode can't honour it (see the
// header) — everything goes through nearestTtlSec() before hitting the wire.
const HA_TTL = 60;
const DEFAULT_TTL = 60;

/**
 * The only values Linode's `ttl_sec` accepts. Anything else is rounded by the
 * API to the nearest member; we do the same rounding here so what we send is
 * what gets stored.
 */
const ALLOWED_TTL_SEC = [
  300, 3600, 7200, 14400, 28800, 57600, 86400, 172800, 345600, 604800, 1209600, 2419200,
];

const PAGE_SIZE = 200;
const MAX_PAGES = 20;

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Round a requested TTL to the nearest value Linode's `ttl_sec` enum allows,
 * preferring the SMALLER member on an exact tie (shorter caching means faster
 * failover propagation, which is the whole reason we ask for a low TTL).
 *
 * @param {number} ttl - Requested TTL in seconds
 * @returns {number} An allowed ttl_sec value
 */
function nearestTtlSec(ttl) {
  let best = ALLOWED_TTL_SEC[0];
  let bestDistance = Math.abs(ALLOWED_TTL_SEC[0] - ttl);
  for (const candidate of ALLOWED_TTL_SEC) {
    const distance = Math.abs(candidate - ttl);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Convert an FQDN to a zone-relative name for the Linode DNS API.
 *
 *   example.com      (zone: example.com) → ""   (apex is the empty string)
 *   *.example.com    (zone: example.com) → "*"
 *   sub.example.com  (zone: example.com) → "sub"
 *   a.b.example.com  (zone: example.com) → "a.b"
 *
 * @param {string} fqdn - Fully qualified domain name
 * @param {string} zoneName - Zone name (e.g. "example.com")
 * @returns {string} Zone-relative record name
 */
function fqdnToRelative(fqdn, zoneName) {
  const clean = String(fqdn).replace(/\.$/, '');
  const zone = String(zoneName).replace(/\.$/, '');

  if (clean === zone) return '';
  if (clean === `*.${zone}`) return '*';
  if (clean.endsWith(`.${zone}`)) {
    return clean.slice(0, -(zone.length + 1));
  }
  // No match — caller may have already passed a relative name.
  return clean;
}

/**
 * Linode's error envelope is `{errors: [{reason, field}]}`; the same shape
 * every LinodeProvider call site already unwraps. Never interpolate the token.
 * @param {Response} response
 * @param {string} prefix
 * @returns {Promise<Error>}
 */
async function apiError(response, prefix) {
  const body = await response.json().catch(() => ({}));
  const reason =
    body.errors?.map((e) => e.reason).join('; ') ||
    response.statusText ||
    `HTTP ${response.status}`;
  return new Error(`${prefix}: ${reason}`);
}

/**
 * Walk a paginated Linode collection to completion via the `page`/`pages`
 * envelope.
 * @param {string} apiToken
 * @param {string} path - e.g. '/domains'
 * @param {string} errorPrefix
 * @returns {Promise<object[]>}
 */
async function walkPages(apiToken, path, errorPrefix) {
  const items = [];
  let page = 1;

  for (let guard = 0; guard < MAX_PAGES; guard++) {
    const response = await fetchWithRetry(
      `${API_BASE}${path}?page=${page}&page_size=${PAGE_SIZE}`,
      { headers: { Authorization: `Bearer ${apiToken}` } },
    );

    if (!response.ok) throw await apiError(response, errorPrefix);

    const data = await response.json();
    if (Array.isArray(data.data)) items.push(...data.data);

    if (!data.pages || page >= data.pages) break;
    page++;
  }

  return items;
}

/**
 * Resolve the domain NAME behind a numeric zone id. Every public entry point
 * calls this exactly once and passes the result down, so a multi-record
 * operation costs one lookup rather than one per record.
 * @param {string} apiToken
 * @param {string} zoneId - Numeric Linode domain id
 * @returns {Promise<string>} The domain name (e.g. "example.com")
 */
async function getZoneName(apiToken, zoneId) {
  const response = await fetchWithRetry(`${API_BASE}/domains/${zoneId}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (!response.ok) throw await apiError(response, 'Linode DNS API error');
  const data = await response.json();
  return data.domain;
}

/**
 * Every record in a zone.
 * @param {string} apiToken
 * @param {string} zoneId
 * @returns {Promise<object[]>}
 */
async function getRecords(apiToken, zoneId) {
  return walkPages(apiToken, `/domains/${zoneId}/records`, 'Linode DNS API error');
}

/**
 * Records at a given (relative name, type). Linode documents a record's
 * `name` as "the hostname or FQDN", so we accept either spelling rather than
 * betting on which one a given zone stores.
 * @param {object[]} records
 * @param {string} relativeName
 * @param {string} fqdn
 * @param {string} type
 * @returns {object[]}
 */
function matching(records, relativeName, fqdn, type) {
  return records.filter((r) => r.type === type && (r.name === relativeName || r.name === fqdn));
}

/**
 * Create-or-update core. Takes the already-resolved `zoneName` so callers
 * doing several records pay for one domain lookup, not several.
 * @param {string} apiToken
 * @param {string} zoneId
 * @param {string} zoneName
 * @param {{type: string, name: string, value: string, ttl?: number}} config
 * @returns {Promise<object>} The created/updated record
 */
async function putRecord(apiToken, zoneId, zoneName, config) {
  const { type, name, value, ttl = DEFAULT_TTL } = config;
  const relativeName = fqdnToRelative(name, zoneName);

  const existing = await getRecords(apiToken, zoneId);
  const match = matching(existing, relativeName, String(name).replace(/\.$/, ''), type)[0];

  const body = JSON.stringify({
    type,
    name: relativeName,
    target: value,
    ttl_sec: nearestTtlSec(ttl),
  });
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };

  const response = match
    ? await fetchWithRetry(`${API_BASE}/domains/${zoneId}/records/${match.id}`, {
        method: 'PUT',
        headers,
        body,
      })
    : await fetchWithRetry(`${API_BASE}/domains/${zoneId}/records`, {
        method: 'POST',
        headers,
        body,
      });

  if (!response.ok) {
    throw await apiError(
      response,
      match ? 'Failed to update DNS record' : 'Failed to create DNS record',
    );
  }
  // Linode returns the record at the top level — no wrapper key.
  return response.json();
}

/**
 * Ownership-filtered delete core. Takes the already-resolved `zoneName` for
 * the same reason as putRecord.
 * @param {string} apiToken
 * @param {string} zoneId
 * @param {string} zoneName
 * @param {string} name - FQDN
 * @param {string[]} ownedIps
 * @param {string} type
 * @returns {Promise<{deleted: number, skipped: number, total: number, skippedTargets: string[]}>}
 */
async function removeRecords(apiToken, zoneId, zoneName, name, ownedIps, type) {
  const relativeName = fqdnToRelative(name, zoneName);
  const all = await getRecords(apiToken, zoneId);
  const records = matching(all, relativeName, String(name).replace(/\.$/, ''), type);
  const total = records.length;

  if (total === 0) {
    return { deleted: 0, skipped: 0, total: 0, skippedTargets: [] };
  }

  const owned = new Set(ownedIps || []);
  let deleted = 0;
  const skippedTargets = [];

  for (const record of records) {
    if (!owned.has(record.target)) {
      skippedTargets.push(record.target);
      continue;
    }
    const response = await fetchWithRetry(`${API_BASE}/domains/${zoneId}/records/${record.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (response.ok) deleted++;
  }

  return { deleted, skipped: skippedTargets.length, total, skippedTargets };
}

// ============================================================================
// LOW-LEVEL API FUNCTIONS
// ============================================================================

/**
 * Get all DNS zones (domains) in the Linode account.
 *
 * @param {string} apiToken - Linode personal access token
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
export async function getZones(apiToken) {
  const domains = await walkPages(apiToken, '/domains', 'Linode DNS API error');
  // Ids are numeric on Linode; stringify so the registry can treat every
  // backend's zone id uniformly.
  return domains.map((d) => ({ id: String(d.id), name: d.domain }));
}

/**
 * Create or update a DNS record.
 *
 * Update-or-create, never blind-create: a second deploy into the same zone
 * must repoint the existing record rather than stack a second A record beside
 * it (two A records at the apex would round-robin traffic at a dead IP).
 *
 * @param {string} apiToken - Linode personal access token
 * @param {string} zoneId - Numeric Linode domain id
 * @param {object} config
 * @param {string} config.type - Record type (A, AAAA, CNAME, ...)
 * @param {string} config.name - Record name (FQDN — converted to relative here)
 * @param {string} config.value - Record value (e.g. IP address)
 * @param {number} [config.ttl] - TTL in seconds (default 60, rounded into Linode's enum)
 * @returns {Promise<object>} The created/updated record
 */
export async function createDNSRecord(apiToken, zoneId, config) {
  const zoneName = await getZoneName(apiToken, zoneId);
  return putRecord(apiToken, zoneId, zoneName, config);
}

/**
 * Delete a DNS record, but only if its target IP belongs to this caller.
 *
 * Linode stores one row per record (like Cloudflare, unlike Hetzner's rrsets),
 * so ownership is filtered per record and the return is the Cloudflare *count*
 * shape rather than Hetzner's boolean.
 *
 * Ownership rule: a record is "ours" iff its `target` (the IP) is in
 * `ownedIps`. Records pointing elsewhere are preserved and surfaced in
 * `skippedTargets`. An empty `ownedIps` refuses every delete — the safer
 * default when envConfig has no server IPs to compare against, and the exact
 * case behind the 2026-05-16 blast-radius bug where one scenario's destroy
 * zeroed a neighbour's record in a shared zone.
 *
 * @param {string} apiToken - Linode personal access token
 * @param {string} zoneId - Numeric Linode domain id
 * @param {string} name - Record name (FQDN)
 * @param {string[]} ownedIps - IPs that belong to this caller's stack
 * @param {string} [type='A'] - Record type
 * @returns {Promise<{deleted: number, skipped: number, total: number, skippedTargets: string[]}>}
 */
export async function deleteDNSRecord(apiToken, zoneId, name, ownedIps, type = 'A') {
  const zoneName = await getZoneName(apiToken, zoneId);
  return removeRecords(apiToken, zoneId, zoneName, name, ownedIps, type);
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
 * @param {string} apiToken - Linode personal access token
 * @param {string} zoneId - Numeric Linode domain id
 * @param {string} domain - Apex domain (the wildcard record is `*.<domain>`)
 * @param {string[]} ownedIps - IPs that belong to this caller's stack
 * @returns {Promise<{deletedAny: boolean, preservedTargets: string[]}>}
 */
export async function deleteApexAndWildcard(apiToken, zoneId, domain, ownedIps) {
  const zoneName = await getZoneName(apiToken, zoneId);
  const [root, wildcard] = await Promise.all([
    removeRecords(apiToken, zoneId, zoneName, domain, ownedIps, 'A'),
    removeRecords(apiToken, zoneId, zoneName, `*.${domain}`, ownedIps, 'A'),
  ]);
  return {
    deletedAny: root.deleted > 0 || wildcard.deleted > 0,
    preservedTargets: [...root.skippedTargets, ...wildcard.skippedTargets],
  };
}

/**
 * Delete this environment's leftover DNS-01 challenge TXT records.
 *
 * Ownership is by NAME, not by value — see acme-challenge.js for why the
 * `ownedIps` filter that guards the A-record path cannot apply to an opaque
 * ACME token, and why the exact name is used instead of a subtree sweep.
 * Every DNS backend carries this helper so no destroy path can pick a
 * provider that lacks it (dns-challenge-cleanup.test.ts is the census).
 *
 * @param {string} apiToken - Linode personal access token
 * @param {string} zoneId - Numeric Linode domain id
 * @param {string} domain - the environment's domain
 * @returns {Promise<{deleted: number, names: string[]}>}
 */
export async function deleteChallengeRecords(apiToken, zoneId, domain) {
  const wanted = challengeRecordNames(domain);
  if (wanted.length === 0) return { deleted: 0, names: [] };

  const zoneName = await getZoneName(apiToken, zoneId);
  const all = await getRecords(apiToken, zoneId);
  let deleted = 0;
  const names = [];

  for (const fqdn of wanted) {
    const records = matching(all, fqdnToRelative(fqdn, zoneName), fqdn, 'TXT');
    let removedHere = 0;
    for (const record of records) {
      const response = await fetchWithRetry(`${API_BASE}/domains/${zoneId}/records/${record.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      if (response.ok) removedHere += 1;
    }
    if (removedHere > 0) {
      deleted += removedHere;
      names.push(fqdn);
    }
  }

  return { deleted, names };
}

/**
 * Create/update the apex + wildcard A records for a domain, both pointed at
 * the same IP. This is the failover flip primitive — scale.js's post-scale
 * DNS update and failover.js's `updateDns` both repoint every subdomain
 * (api, registry, ...) at whichever server IP is currently primary.
 *
 * @param {object} auth
 * @param {string} auth.token - Linode personal access token
 * @param {string} auth.zoneId - Numeric Linode domain id
 * @param {string} domain - Apex domain (the wildcard record is `*.<domain>`)
 * @param {string} ip - Target IP address
 * @returns {Promise<void>}
 */
export async function upsertApexAndWildcard(auth, domain, ip) {
  const { token, zoneId } = auth;
  const zoneName = await getZoneName(token, zoneId);
  await putRecord(token, zoneId, zoneName, { type: 'A', name: domain, value: ip, ttl: HA_TTL });
  await putRecord(token, zoneId, zoneName, {
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
 * Set up Linode DNS for a simple single-server deployment.
 * Creates root A and wildcard A records.
 *
 * @param {string} apiToken - Linode personal access token
 * @param {string} zoneId - Numeric Linode domain id
 * @param {string} domain - Domain name (e.g. "app.example.com")
 * @param {string} serverIp - Server IP address
 * @param {object} [options]
 * @param {Function} [options.onProgress] - Progress callback (skips internal spinners)
 * @returns {Promise<object>} Setup result
 */
export async function setupSimple(apiToken, zoneId, domain, serverIp, options = {}) {
  const { onProgress } = options;
  // When caller provides onProgress, skip internal spinners (caller manages UI)
  const s = onProgress ? null : spinner();

  try {
    s?.start(`Creating DNS records for ${domain}`);
    onProgress?.(`Creating DNS records for ${domain}`);

    const zoneName = await getZoneName(apiToken, zoneId);

    const record = await putRecord(apiToken, zoneId, zoneName, {
      type: 'A',
      name: domain,
      value: serverIp,
      ttl: DEFAULT_TTL,
    });

    // Wildcard A record for subdomains (registry, api, etc.)
    await putRecord(apiToken, zoneId, zoneName, {
      type: 'A',
      name: `*.${domain}`,
      value: serverIp,
      ttl: DEFAULT_TTL,
    });

    s?.stop('DNS records created (root + wildcard)');
    onProgress?.('DNS records created (root + wildcard)');

    return { success: true, mode: 'simple', record };
  } catch (error) {
    s?.stop(`Linode DNS setup failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Set up Linode DNS for an HA deployment.
 * Creates root A and wildcard A records pointing to the primary server, at
 * the lowest TTL Linode allows (300s — see the module header's TTL note).
 *
 * Note: Linode DNS has no health checks or load balancers in this path.
 * Failover is triggered manually via `vibecarbon failover`.
 *
 * @param {string} apiToken - Linode personal access token
 * @param {string} zoneId - Numeric Linode domain id
 * @param {string} domain - Domain name
 * @param {Array} servers - Array of { name, ip, region } objects (primary first)
 * @returns {Promise<object>} Setup result
 */
export async function setupHA(apiToken, zoneId, domain, servers) {
  const s = spinner();

  try {
    const zoneName = await getZoneName(apiToken, zoneId);

    s.start(`Creating DNS record for ${domain}`);
    await putRecord(apiToken, zoneId, zoneName, {
      type: 'A',
      name: domain,
      value: servers[0].ip,
      ttl: HA_TTL,
    });
    s.stop('Primary DNS record created');

    await putRecord(apiToken, zoneId, zoneName, {
      type: 'A',
      name: `*.${domain}`,
      value: servers[0].ip,
      ttl: HA_TTL,
    });

    return {
      success: true,
      mode: 'dns',
      primaryIp: servers[0].ip,
      standbyIp: servers[1]?.ip,
    };
  } catch (error) {
    s.stop(`Linode DNS setup failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}
