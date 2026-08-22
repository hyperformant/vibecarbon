/**
 * Vultr DNS Operations
 *
 * DNS management through the Vultr API v2 (api.vultr.com/v2). Uses the same
 * API key as instance operations — no additional credentials.
 *
 * Zone identity is the domain NAME, not a numeric id: every records call is
 * `/v2/domains/{dns-domain}/records`, so the `zoneId` parameter every function
 * here takes carries the domain name. `getZones` returns `{id, name}` rows
 * where both fields hold the same string — the shape keeps Vultr
 * interchangeable with the id-keyed backends (Linode, Hetzner) at the registry
 * level.
 *
 * Two Vultr-shaped hazards this module handles explicitly:
 *   1. CURSOR pagination. Vultr answers with `meta.links.next`, and "no more
 *      pages" is an EMPTY STRING, not a missing key — a null-check alone would
 *      loop forever. Same idiom as `_walkCursor` in src/lib/providers/vultr.js,
 *      reimplemented locally because DNS backends must not import provider
 *      classes.
 *   2. Record updates are PATCH and answer 204 No Content. Parsing a body off
 *      that response throws, so the update path returns the record it wrote
 *      rather than a parsed one.
 *
 * API documentation verified against (2026-08-08, via the Vultr API reference
 * at https://www.vultr.com/api/ — the live page 403s to plain fetchers, so it
 * was read through Context7's mirror of the same index):
 *   - GET  /v2/domains                              → {domains: [{domain}], meta.links.next}
 *   - GET  /v2/domains/{dns-domain}/records         → {records: [{id, type, name, data, ttl}], meta.links.next}
 *   - POST /v2/domains/{dns-domain}/records         → 201 {record: {...}}, body {name, type, data, ttl}
 *   - PATCH /v2/domains/{dns-domain}/records/{id}   → 204 No Content, body {name, data, ttl}
 *   - DELETE /v2/domains/{dns-domain}/records/{id}  → 204 No Content
 *   - per_page default 100, max 500; auth is `Authorization: Bearer <key>`
 *
 * Two documentation gaps worth knowing about, and how they are resolved here:
 *   - Vultr's reference states no MINIMUM ttl and gives no default; its
 *     examples use 300. We send the project-wide 60 (the failover story), and
 *     the e2e DNS-propagation check is the canary if Vultr silently floors it.
 *   - The reference never spells out the apex record's name. Its create
 *     example uses a relative label ("www") while its list example shows a
 *     fully-qualified one ("foo.example.com"). We write the apex as the empty
 *     string (the Terraform/Ansible ecosystem convention) and, on read, match
 *     a record under EITHER the relative or the fully-qualified spelling so an
 *     inconsistency can't turn an update into a duplicate create.
 */

import { challengeRecordNames } from './acme-challenge.js';
import { spinner } from './cli/progress.js';
import { fetchWithRetry } from './fetch-retry.js';

const API_BASE = 'https://api.vultr.com/v2';

// Default TTL for HA records (low for fast failover propagation)
const HA_TTL = 60;
// Default TTL for standard records (low to prevent stale DNS between runs)
const DEFAULT_TTL = 60;

// Vultr's per_page maximum, and the cursor-walk guard. 500 x 20 = 10000
// records, far beyond any zone we manage; the guard exists so a server-side
// pagination bug can't spin a deploy forever.
const PER_PAGE = 500;
const MAX_PAGES = 20;

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Convert an FQDN to a zone-relative name for the Vultr DNS API.
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
 * Vultr's error envelope is `{error, status}`; the same shape every
 * VultrProvider call site already unwraps. Never interpolate the token.
 * @param {Response} response
 * @param {string} prefix
 * @returns {Promise<Error>}
 */
async function apiError(response, prefix) {
  const body = await response.json().catch(() => ({}));
  return new Error(`${prefix}: ${body.error || response.statusText || `HTTP ${response.status}`}`);
}

/**
 * Cursor-paginated collection walk (Vultr's `meta.links.next` idiom).
 * A terminal page reports `next` as an EMPTY STRING, so the loop exits on
 * falsiness rather than on the key being absent.
 *
 * @param {string} apiToken
 * @param {string} path - e.g. '/domains'
 * @param {string} key - response array key (e.g. 'domains')
 * @param {string} errorPrefix
 * @returns {Promise<object[]>}
 */
async function walkCursor(apiToken, path, key, errorPrefix) {
  const items = [];
  let cursor = '';

  for (let guard = 0; guard < MAX_PAGES; guard++) {
    const response = await fetchWithRetry(
      `${API_BASE}${path}?per_page=${PER_PAGE}${cursor ? `&cursor=${cursor}` : ''}`,
      { headers: { Authorization: `Bearer ${apiToken}` } },
    );

    if (!response.ok) throw await apiError(response, errorPrefix);

    const data = await response.json();
    if (Array.isArray(data[key])) items.push(...data[key]);

    const next = data.meta?.links?.next;
    if (!next) break;
    cursor = next;
  }

  return items;
}

/**
 * Every record in a zone.
 * @param {string} apiToken
 * @param {string} zoneName - the domain name (Vultr's zone identity)
 * @returns {Promise<object[]>}
 */
async function getRecords(apiToken, zoneName) {
  return walkCursor(apiToken, `/domains/${zoneName}/records`, 'records', 'Vultr DNS API error');
}

/**
 * Records at a given (relative name, type). Vultr's own reference shows both
 * relative and fully-qualified spellings for a listed record's `name`, so we
 * accept either — see the module header.
 * @param {object[]} records
 * @param {string} relativeName
 * @param {string} fqdn
 * @param {string} type
 * @returns {object[]}
 */
function matching(records, relativeName, fqdn, type) {
  return records.filter((r) => r.type === type && (r.name === relativeName || r.name === fqdn));
}

// ============================================================================
// LOW-LEVEL API FUNCTIONS
// ============================================================================

/**
 * Get all DNS zones (domains) in the Vultr account.
 *
 * @param {string} apiToken - Vultr API key
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
export async function getZones(apiToken) {
  const domains = await walkCursor(apiToken, '/domains', 'domains', 'Vultr DNS API error');
  // The name IS the id on Vultr — see the module header.
  return domains.map((d) => ({ id: d.domain, name: d.domain }));
}

/**
 * Create or update a DNS record.
 *
 * Update-or-create, never blind-create: a second deploy into the same zone
 * must repoint the existing record rather than stack a second A record beside
 * it (two A records at the apex would round-robin traffic at a dead IP).
 *
 * @param {string} apiToken - Vultr API key
 * @param {string} zoneId - Zone identity — the domain NAME on Vultr
 * @param {object} config
 * @param {string} config.type - Record type (A, AAAA, CNAME, ...)
 * @param {string} config.name - Record name (FQDN — converted to relative here)
 * @param {string} config.value - Record value (e.g. IP address)
 * @param {number} [config.ttl] - TTL in seconds (default 60)
 * @returns {Promise<object>} The created/updated record
 */
export async function createDNSRecord(apiToken, zoneId, config) {
  const { type, name, value, ttl = DEFAULT_TTL } = config;
  const relativeName = fqdnToRelative(name, zoneId);

  const existing = await getRecords(apiToken, zoneId);
  const match = matching(existing, relativeName, String(name).replace(/\.$/, ''), type)[0];

  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };

  if (match) {
    // PATCH takes only the mutable attributes — `type` is fixed at create.
    const response = await fetchWithRetry(`${API_BASE}/domains/${zoneId}/records/${match.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: relativeName, data: value, ttl }),
    });
    if (!response.ok) throw await apiError(response, 'Failed to update DNS record');
    // 204 No Content — there is no body to parse, so report what we wrote.
    return { ...match, name: relativeName, data: value, ttl };
  }

  const response = await fetchWithRetry(`${API_BASE}/domains/${zoneId}/records`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type, name: relativeName, data: value, ttl }),
  });
  if (!response.ok) throw await apiError(response, 'Failed to create DNS record');
  const data = await response.json();
  return data.record;
}

/**
 * Delete a DNS record, but only if its target IP belongs to this caller.
 *
 * Vultr stores one row per record (like Cloudflare, unlike Hetzner's rrsets),
 * so ownership is filtered per record and the return is the Cloudflare *count*
 * shape rather than Hetzner's boolean.
 *
 * Ownership rule: a record is "ours" iff its `data` (the target IP) is in
 * `ownedIps`. Records pointing elsewhere are preserved and surfaced in
 * `skippedTargets`. An empty `ownedIps` refuses every delete — the safer
 * default when envConfig has no server IPs to compare against, and the exact
 * case behind the 2026-05-16 blast-radius bug where one scenario's destroy
 * zeroed a neighbour's record in a shared zone.
 *
 * @param {string} apiToken - Vultr API key
 * @param {string} zoneId - Zone identity — the domain NAME on Vultr
 * @param {string} name - Record name (FQDN)
 * @param {string[]} ownedIps - IPs that belong to this caller's stack
 * @param {string} [type='A'] - Record type
 * @returns {Promise<{deleted: number, skipped: number, total: number, skippedTargets: string[]}>}
 */
export async function deleteDNSRecord(apiToken, zoneId, name, ownedIps, type = 'A') {
  const relativeName = fqdnToRelative(name, zoneId);
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
    if (!owned.has(record.data)) {
      skippedTargets.push(record.data);
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
 * @param {string} apiToken - Vultr API key
 * @param {string} zoneId - Zone identity — the domain NAME on Vultr
 * @param {string} domain - Apex domain (the wildcard record is `*.<domain>`)
 * @param {string[]} ownedIps - IPs that belong to this caller's stack
 * @returns {Promise<{deletedAny: boolean, preservedTargets: string[]}>}
 */
export async function deleteApexAndWildcard(apiToken, zoneId, domain, ownedIps) {
  const [root, wildcard] = await Promise.all([
    deleteDNSRecord(apiToken, zoneId, domain, ownedIps),
    deleteDNSRecord(apiToken, zoneId, `*.${domain}`, ownedIps),
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
 * @param {string} apiToken - Vultr API key
 * @param {string} zoneId - Zone identity — the domain NAME on Vultr
 * @param {string} domain - the environment's domain
 * @returns {Promise<{deleted: number, names: string[]}>}
 */
export async function deleteChallengeRecords(apiToken, zoneId, domain) {
  const wanted = challengeRecordNames(domain);
  if (wanted.length === 0) return { deleted: 0, names: [] };

  const all = await getRecords(apiToken, zoneId);
  let deleted = 0;
  const names = [];

  for (const fqdn of wanted) {
    const records = matching(all, fqdnToRelative(fqdn, zoneId), fqdn, 'TXT');
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
 * the same IP (ttl 60). This is the failover flip primitive — scale.js's
 * post-scale DNS update and failover.js's `updateDns` both repoint every
 * subdomain (api, registry, ...) at whichever server IP is currently primary.
 *
 * @param {object} auth
 * @param {string} auth.token - Vultr API key
 * @param {string} auth.zoneId - Zone identity — the domain NAME on Vultr
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
 * Set up Vultr DNS for a simple single-server deployment.
 * Creates root A and wildcard A records.
 *
 * @param {string} apiToken - Vultr API key
 * @param {string} zoneId - Zone identity — the domain NAME on Vultr
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

    const record = await createDNSRecord(apiToken, zoneId, {
      type: 'A',
      name: domain,
      value: serverIp,
      ttl: DEFAULT_TTL,
    });

    // Wildcard A record for subdomains (registry, api, etc.)
    await createDNSRecord(apiToken, zoneId, {
      type: 'A',
      name: `*.${domain}`,
      value: serverIp,
      ttl: DEFAULT_TTL,
    });

    s?.stop('DNS records created (root + wildcard)');
    onProgress?.('DNS records created (root + wildcard)');

    return { success: true, mode: 'simple', record };
  } catch (error) {
    s?.stop(`Vultr DNS setup failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Set up Vultr DNS for an HA deployment.
 * Creates root A and wildcard A records pointing to the primary server,
 * with a low TTL for fast failover propagation.
 *
 * Note: Vultr DNS has no health checks or load balancers in this path.
 * Failover is triggered manually via `vibecarbon failover`.
 *
 * @param {string} apiToken - Vultr API key
 * @param {string} zoneId - Zone identity — the domain NAME on Vultr
 * @param {string} domain - Domain name
 * @param {Array} servers - Array of { name, ip, region } objects (primary first)
 * @returns {Promise<object>} Setup result
 */
export async function setupHA(apiToken, zoneId, domain, servers) {
  const s = spinner();

  try {
    s.start(`Creating DNS record for ${domain}`);
    await createDNSRecord(apiToken, zoneId, {
      type: 'A',
      name: domain,
      value: servers[0].ip,
      ttl: HA_TTL,
    });
    s.stop('Primary DNS record created');

    await createDNSRecord(apiToken, zoneId, {
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
    s.stop(`Vultr DNS setup failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}
