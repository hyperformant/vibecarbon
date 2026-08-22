/**
 * Hetzner Cloud DNS Operations
 *
 * DNS management through the Hetzner Cloud API (api.hetzner.cloud/v1).
 * Uses the same API token as server operations — no additional credentials needed.
 *
 * The Cloud API uses `/zones/{id}/rrsets` for record management (not `/records`).
 * Updates are performed via delete + create (PUT on rrsets returns 422).
 *
 * API Documentation: https://docs.hetzner.cloud/
 */

import { challengeRecordNames } from './acme-challenge.js';
import { spinner } from './cli/progress.js';
import { fetchWithRetry } from './fetch-retry.js';
import { HetznerProvider } from './providers/hetzner.js';

const API_BASE = HetznerProvider.API_BASE;

// Default TTL for HA records (low for fast failover propagation)
const HA_TTL = 60;
// Default TTL for standard records (low to prevent stale DNS between test runs)
const DEFAULT_TTL = 60;

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Convert an FQDN to a zone-relative name for the Hetzner DNS API.
 *
 * Hetzner DNS records use names relative to the zone:
 *   example.com       (zone: example.com)  → "@"
 *   *.example.com     (zone: example.com)  → "*"
 *   sub.example.com   (zone: example.com)  → "sub"
 *   a.b.example.com   (zone: example.com)  → "a.b"
 *
 * @param {string} fqdn - Fully qualified domain name
 * @param {string} zoneName - Zone name (e.g. "example.com")
 * @returns {string} Zone-relative record name
 */
function fqdnToRelative(fqdn, zoneName) {
  // Strip trailing dots
  const clean = fqdn.replace(/\.$/, '');
  const zone = zoneName.replace(/\.$/, '');

  if (clean === zone) return '@';
  if (clean === `*.${zone}`) return '*';
  if (clean.endsWith(`.${zone}`)) {
    return clean.slice(0, -(zone.length + 1));
  }
  // If no match, return as-is (caller may have already passed a relative name)
  return clean;
}

// zoneId → zone name, so the uniform record CRUD (which receives only a
// zoneId, like every other backend) doesn't refetch the zone per call.
// Zone names are immutable on Hetzner (rename = delete + recreate with a
// new id), so a process-lifetime cache is safe.
const zoneNameCache = new Map();

async function zoneNameForId(apiToken, zoneId) {
  const cached = zoneNameCache.get(zoneId);
  if (cached) return cached;
  const zone = await getZone(apiToken, zoneId);
  zoneNameCache.set(zoneId, zone.name);
  return zone.name;
}

// ============================================================================
// LOW-LEVEL API FUNCTIONS
// ============================================================================

/**
 * Get all DNS zones in the Hetzner Cloud project.
 *
 * @param {string} apiToken - Hetzner Cloud API token
 * @returns {Promise<Array>} Array of zone objects
 */
export async function getZones(apiToken) {
  const zones = [];
  let page = 1;

  while (true) {
    const response = await fetchWithRetry(`${API_BASE}/zones?page=${page}&per_page=50`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Hetzner DNS API error: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();
    zones.push(...(data.zones || []));

    if (!data.meta?.pagination?.next_page) break;
    page = data.meta.pagination.next_page;
  }

  return zones;
}

/**
 * Get a single DNS zone by ID.
 *
 * @param {string} apiToken - Hetzner Cloud API token
 * @param {string} zoneId - Zone ID
 * @returns {Promise<object>} Zone object (includes `name`)
 */
export async function getZone(apiToken, zoneId) {
  const response = await fetchWithRetry(`${API_BASE}/zones/${zoneId}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`Hetzner DNS API error: ${error.error?.message || response.statusText}`);
  }

  const data = await response.json();
  return data.zone;
}

/**
 * List all rrsets (record sets) in a DNS zone.
 *
 * @param {string} apiToken - Hetzner Cloud API token
 * @param {string} zoneId - Zone ID
 * @returns {Promise<Array>} Array of rrset objects
 */
export async function getRrsets(apiToken, zoneId) {
  const rrsets = [];
  let page = 1;

  while (true) {
    const response = await fetchWithRetry(
      `${API_BASE}/zones/${zoneId}/rrsets?page=${page}&per_page=100`,
      {
        headers: { Authorization: `Bearer ${apiToken}` },
      },
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Hetzner DNS API error: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();
    rrsets.push(...(data.rrsets || []));

    if (!data.meta?.pagination?.next_page) break;
    page = data.meta.pagination.next_page;
  }

  return rrsets;
}

/**
 * Create or update a DNS record (uniform backend contract: FQDN in,
 * zone-relative conversion internal, `value` field).
 *
 * Uses the /rrsets endpoint. If a matching rrset (same type + name) exists,
 * deletes it first then creates a new one (PUT is not supported on rrsets).
 *
 * @param {string} apiToken - Hetzner Cloud API token
 * @param {string} zoneId - Zone ID
 * @param {object} config - Record config
 * @param {string} config.type - Record type (A, AAAA, CNAME, etc.)
 * @param {string} config.name - Record name (FQDN — converted to relative internally)
 * @param {string} config.value - Record value (e.g. IP address)
 * @param {number} [config.ttl] - TTL in seconds (default: DEFAULT_TTL = 60)
 * @returns {Promise<object>} Created rrset object
 */
export async function createDNSRecord(apiToken, zoneId, config) {
  const { type, name, value, ttl = DEFAULT_TTL } = config;
  const zoneName = await zoneNameForId(apiToken, zoneId);
  const relativeName = fqdnToRelative(name, zoneName);

  // Delete existing rrset if present (PUT is not supported, so we delete + create)
  const existing = await getRrsets(apiToken, zoneId);
  const match = existing.find((r) => r.type === type && r.name === relativeName);

  if (match) {
    const delResponse = await fetchWithRetry(
      `${API_BASE}/zones/${zoneId}/rrsets/${relativeName}/${type}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${apiToken}` },
      },
    );
    if (!delResponse.ok) {
      const error = await delResponse.json().catch(() => ({}));
      throw new Error(
        `Failed to remove existing DNS record: ${error.error?.message || delResponse.statusText}`,
      );
    }
  }

  // Create new rrset
  const response = await fetchWithRetry(`${API_BASE}/zones/${zoneId}/rrsets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: relativeName,
      type,
      ttl,
      records: [{ value }],
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`Failed to create DNS record: ${error.error?.message || response.statusText}`);
  }

  const data = await response.json();
  return data.rrset;
}

/**
 * Delete a DNS rrset by FQDN and type — but only if every value in the
 * rrset belongs to this caller's stack.
 *
 * Hetzner stores DNS records as rrsets (one row per name+type, with an
 * array of values). The destroy path historically wiped the rrset
 * unconditionally, which was fine for single-tenant zones but blasted
 * shared zones when e2e scenarios reused the same root domain
 * (the 2026-05-16 matrix saw compose-ha's destroy zero compose's
 * `e1.carbonstack.dev` mid-verify).
 *
 * Ownership rule:
 *   - If every value in the rrset is in `ownedIps`, DELETE the rrset.
 *   - If any value is NOT owned, preserve the entire rrset (we don't
 *     PATCH out individual records — Hetzner's API forces delete+recreate
 *     anyway, and a stale recreate risks dropping the others' values).
 *   - If `ownedIps` is empty, preserve (safer default when envConfig
 *     has no IPs to verify against).
 *
 * Result shape is the uniform backend contract (counts, like
 * cloudflare-dns.js — Hetzner's all-or-nothing rrset semantics map onto
 * it as: deleted = every value in the rrset when the delete fires, else
 * 0 with the unowned values in `skippedTargets`).
 *
 * @param {string} apiToken - Hetzner Cloud API token
 * @param {string} zoneId - Zone ID
 * @param {string} name - Record name (FQDN)
 * @param {string[]} ownedIps - IPs that belong to this caller's stack
 * @param {string} [type='A'] - Record type
 * @returns {Promise<{deleted: number, skipped: number, total: number, skippedTargets: string[]}>}
 */
export async function deleteDNSRecord(apiToken, zoneId, name, ownedIps, type = 'A') {
  const zoneName = await zoneNameForId(apiToken, zoneId);
  const relativeName = fqdnToRelative(name, zoneName);

  // Inspect the rrset before deleting. The list endpoint surfaces all
  // values for a (name, type) tuple as a single rrset row.
  const rrsets = await getRrsets(apiToken, zoneId);
  const match = rrsets.find((r) => r.type === type && r.name === relativeName);

  if (!match) {
    return { deleted: 0, skipped: 0, total: 0, skippedTargets: [] };
  }

  const values = (match.records || []).map((r) => r.value);
  const owned = new Set(ownedIps || []);
  const unowned = values.filter((v) => !owned.has(v));

  if (unowned.length > 0) {
    // At least one value belongs to someone else — leave the whole rrset
    // alone. Surfaces to the caller so they can log what was preserved.
    return {
      deleted: 0,
      skipped: unowned.length,
      total: values.length,
      skippedTargets: unowned,
    };
  }

  const response = await fetchWithRetry(
    `${API_BASE}/zones/${zoneId}/rrsets/${relativeName}/${type}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiToken}` },
    },
  );

  return {
    deleted: response.ok ? values.length : 0,
    skipped: 0,
    total: values.length,
    skippedTargets: [],
  };
}

/**
 * Delete the apex + wildcard A-record pair for a domain, ownership-filtered
 * (same `ownedIps` contract as `deleteDNSRecord` above). Uniform-contract
 * twin of cloudflare-dns.js's deleteApexAndWildcard: deploy always creates
 * both records, so every destroy path must delete both too — the destroy
 * paths used to hand-roll this pair per site, which is how the wildcard
 * orphan class (M3 Task 9i) happened on the Cloudflare side.
 *
 * @param {string} apiToken - Hetzner Cloud API token
 * @param {string} zoneId - Zone ID
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
 *
 * Hetzner's rrset model works in our favour here: the twelve accumulated
 * tokens the 2026-08-10 audit found under `_acme-challenge.e1` are ONE rrset,
 * so one DELETE removes the pile.
 *
 * The name segment is interpolated RAW. Percent-encoding it 404s: live
 * confirmation 2026-08-10 on this very endpoint — `%2A.ci3` → 404, literal
 * `*.ci3` → 201. An encoded name would make this delete a silent no-op.
 *
 * @param {string} apiToken - Hetzner Cloud API token
 * @param {string} zoneId - Zone ID
 * @param {string} domain - the environment's domain
 * @returns {Promise<{deleted: number, names: string[]}>} count of TXT values
 *   removed, and the record names they were removed from.
 */
export async function deleteChallengeRecords(apiToken, zoneId, domain) {
  const wanted = challengeRecordNames(domain);
  if (wanted.length === 0) return { deleted: 0, names: [] };

  const zoneName = await zoneNameForId(apiToken, zoneId);
  const rrsets = await getRrsets(apiToken, zoneId);
  let deleted = 0;
  const names = [];

  for (const fqdn of wanted) {
    const relativeName = fqdnToRelative(fqdn, zoneName);
    const match = rrsets.find((r) => r.type === 'TXT' && r.name === relativeName);
    if (!match) continue;
    const response = await fetchWithRetry(
      `${API_BASE}/zones/${zoneId}/rrsets/${relativeName}/TXT`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${apiToken}` },
      },
    );
    if (!response.ok) continue;
    deleted += (match.records || []).length || 1;
    names.push(fqdn);
  }

  return { deleted, names };
}

/**
 * Create/update the apex + wildcard A records for a domain, both pointed at
 * the same IP (ttl:60). Shared by scale.js's post-scale DNS update and
 * failover.js's `HA_DNS_STRATEGIES.hetzner.updateDns` — both flows repoint
 * every subdomain (api, registry, ...) at whichever server IP is currently
 * primary. Extracted in C6b; behavior is unchanged from the two call
 * sites' former inline copies.
 *
 * @param {object} auth
 * @param {string} auth.token - Hetzner Cloud API token
 * @param {string} auth.zoneId - DNS zone ID
 * @param {string} domain - Apex domain (the wildcard record is `*.<domain>`)
 * @param {string} ip - Target IP address
 * @returns {Promise<void>}
 */
export async function upsertApexAndWildcard(auth, domain, ip) {
  const { token, zoneId } = auth;
  await createDNSRecord(token, zoneId, {
    type: 'A',
    name: domain,
    value: ip,
    ttl: 60,
  });
  await createDNSRecord(token, zoneId, {
    type: 'A',
    name: `*.${domain}`,
    value: ip,
    ttl: 60,
  });
}

// ============================================================================
// HIGH-LEVEL SETUP FUNCTIONS
// ============================================================================

/**
 * Set up Hetzner DNS for a simple single-server deployment.
 * Creates root A and wildcard A records.
 *
 * @param {string} apiToken - Hetzner Cloud API token
 * @param {string} zoneId - DNS zone ID
 * @param {string} domain - Domain name (e.g. "app.example.com")
 * @param {string} serverIp - Server IP address
 * @param {object} [options] - Options
 * @param {Function} [options.onProgress] - Progress callback (skips internal spinners)
 * @returns {Promise<object>} Setup result
 */
export async function setupSimple(apiToken, zoneId, domain, serverIp, options = {}) {
  const { onProgress } = options;
  const s = onProgress ? null : spinner();

  try {
    s?.start(`Creating DNS records for ${domain}`);
    onProgress?.(`Creating DNS records for ${domain}`);

    // Root A record
    await createDNSRecord(apiToken, zoneId, {
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

    return { success: true, mode: 'simple' };
  } catch (error) {
    s?.stop(`Hetzner DNS setup failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Set up Hetzner DNS for an HA deployment.
 * Creates root A and wildcard A records pointing to the primary server,
 * with a low TTL for fast failover propagation.
 *
 * Note: Hetzner DNS has no health checks or load balancers.
 * Failover is triggered manually via `vibecarbon failover`.
 *
 * @param {string} apiToken - Hetzner Cloud API token
 * @param {string} zoneId - DNS zone ID
 * @param {string} domain - Domain name
 * @param {Array} servers - Array of { name, ip } objects (primary first)
 * @returns {Promise<object>} Setup result
 */
export async function setupHA(apiToken, zoneId, domain, servers) {
  const s = spinner();

  try {
    // Root A record (low TTL for fast failover)
    s.start(`Creating DNS record for ${domain}`);
    await createDNSRecord(apiToken, zoneId, {
      type: 'A',
      name: domain,
      value: servers[0].ip,
      ttl: HA_TTL,
    });
    s.stop('Primary DNS record created');

    // Wildcard A record (low TTL for fast failover)
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
    s.stop(`Hetzner DNS setup failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}
