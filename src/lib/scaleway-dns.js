/**
 * Scaleway DNS Operations
 *
 * DNS management through Scaleway's Domains and DNS API
 * (api.scaleway.com/domain/v2beta1). Uses the same SECRET KEY as instance
 * operations — no additional credentials — but sends it as `X-Auth-Token`
 * rather than a Bearer header (Scaleway's REST convention; the secret key
 * alone authenticates, the access key is an S3/IAM concern).
 *
 * THREE THINGS MAKE SCALEWAY THE ODD ONE OUT. All three are handled here and
 * pinned in tests/unit/lib/scaleway-dns.test.ts:
 *
 *  1. ZONE IDENTITY IS THE ZONE NAME. Every records call is
 *     `/dns-zones/{dns_zone}/records`, where `{dns_zone}` is the zone's own
 *     name ("example.com", or "s1.example.com" for a sub-zone) — never a UUID.
 *     The `zoneId` parameter the DNS-backend contract passes around therefore
 *     carries that name, exactly as it carries the domain name on DigitalOcean
 *     and Vultr, and `getZones` returns `{id, name}` rows whose two fields hold
 *     the same string. A Scaleway zone object splits the name across two fields
 *     (`domain` + `subdomain`), so `zoneName()` rejoins them.
 *
 *  2. THERE IS NO PER-RECORD ENDPOINT. Create, update and delete are all one
 *     PATCH of `/dns-zones/{dns_zone}/records` carrying a `changes` array
 *     (`add` / `set` / `delete` / `clear`) — so a "delete" on this backend is
 *     an HTTP PATCH, not an HTTP DELETE, and several records can be removed in
 *     ONE round trip. The ownership filter and the return shapes are unchanged;
 *     only the wire verb differs. Both PATCHes of a pair are issued
 *     SEQUENTIALLY (see deleteApexAndWildcard) because each one bumps the
 *     zone's serial, and two concurrent updates of the same zone race on it.
 *
 *  3. THE ACCOUNT CANNOT CREATE A ZONE FOR A DOMAIN IT DOES NOT MANAGE.
 *     Every zone and record call for an unknown domain answers 403 "domain not
 *     found" — there is no sibling equivalent (on Hetzner/DO/Linode/Vultr,
 *     "add a zone" is just a POST). A domain registered elsewhere must first be
 *     onboarded as an EXTERNAL DOMAIN and have its ownership proven, which is
 *     an out-of-band, human-timescale step: hence `registerExternalDomain` /
 *     `getExternalDomainRegistration` / `waitForExternalDomainActive` below,
 *     driven by the operator-facing flow in scaleway-guided-setup.js
 *     (`onboardDomain`).
 *
 *     THE ORDER IS MANDATORY AND COUNTERINTUITIVE: validate FIRST, move the
 *     nameservers SECOND. The ownership TXT has to be resolvable, and until the
 *     domain validates Scaleway refuses to serve its zone at all (403 for the
 *     entire `checking` period — confirmed live over a 9-minute poll). So an
 *     operator who delegates to ns0/ns1.dom.scw.cloud first DEADLOCKS: the
 *     challenge record can no longer resolve anywhere, because the domain now
 *     points at a host that will not answer for it, and validation can never
 *     complete. The only way out is to point the nameservers back at the
 *     previous DNS host. The onboarding flow detects this state and says so.
 *
 * API documentation verified against (2026-08-12):
 *   - scaleway-sdk-go api/domain/v2beta1/domain_sdk.go — the authoritative
 *     shapes: ListDNSZonesResponse `{total_count, dns_zones:[{domain,
 *     subdomain, ns, status, project_id}]}`; ListDNSZoneRecordsResponse
 *     `{total_count, records:[{id, name, data, type, ttl, priority}]}`;
 *     UpdateDNSZoneRecordsRequest `{changes:[{add|set|delete|clear}], ...}`
 *     with RecordChangeDelete/-Set carrying `id` OR `id_fields`;
 *     RegistrarAPI.RegisterExternalDomain → POST /domain/v2beta1/external-domains
 *     `{domain, project_id}` → `{domain, organization_id, project_id,
 *     validation_token, created_at}`; RegistrarAPI.ListDomains → GET
 *     /domain/v2beta1/domains → `{total_count, domains:[{domain, status,
 *     is_external, external_domain_registration_status:{validation_token}}]}`.
 *   - scaleway-sdk-go scw/errors.go — the error envelope is `{message, type,
 *     resource, fields}`; `message` is the human-readable half.
 *   - docs-content pages/domains-and-dns/how-to/add-external-domain.mdx —
 *     ownership is proven with a `TXT` record named `_scaleway-challenge` in
 *     the domain's CURRENT DNS zone, checked for 48 hours; delegation is then
 *     to ns0.dom.scw.cloud / ns1.dom.scw.cloud, with a 14-day overall deadline.
 *
 * TTL: the project-wide 60 (the failover story) is sent as-is. Scaleway accepts
 * it — lego's own Scaleway solver defaults `SCW_TTL` to 60 for the challenge
 * records it writes through this same API.
 *
 * NOT IMPLEMENTED ON PURPOSE: `DELETE /domain/v2beta1/external-domains/{domain}`
 * (RegistrarAPI.DeleteExternalDomain) exists, but destroy must never call it. An
 * onboarded domain is an ACCOUNT-level asset that outlives the environment
 * deployed under it — de-registering it on teardown would revoke DNS for every
 * other environment in the same zone, which is the blast-radius class the
 * ownership filter below exists to prevent.
 */

import { challengeRecordNames } from './acme-challenge.js';
import { spinner } from './cli/progress.js';
import { fetchWithRetry } from './fetch-retry.js';

const API_BASE = 'https://api.scaleway.com';
const DOMAIN_API = `${API_BASE}/domain/v2beta1`;

// Default TTL for HA records (low for fast failover propagation)
const HA_TTL = 60;
// Default TTL for standard records (low to prevent stale DNS between runs)
const DEFAULT_TTL = 60;

// Scaleway paginates with page/page_size and reports `total_count`. 100 is
// accepted on every collection here; the walk stops on a short page, so the
// guard only exists so a server-side pagination bug can't spin a deploy
// forever. 100 x 20 = 2000 records, far beyond any zone we manage.
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/** Scaleway's nameservers — where an onboarded domain must be delegated. */
export const NAMESERVERS = ['ns0.dom.scw.cloud', 'ns1.dom.scw.cloud'];

/**
 * The TXT record name that proves ownership of an external domain. Written in
 * the domain's CURRENT (non-Scaleway) DNS zone — which is a host we may or may
 * not hold a credential for; see dns-provider.js#locateDomainBackend.
 */
export const EXTERNAL_DOMAIN_CHALLENGE_NAME = '_scaleway-challenge';

/**
 * How long Scaleway keeps re-checking for the ownership TXT before deleting
 * the registration outright ("If it has not been set within 48 hours, the
 * external domain will be deleted from the service" —
 * docs-content add-external-domain.mdx). The separate 14-day ceiling covers
 * the whole process including the nameserver move.
 */
export const VALIDATION_WINDOW_HOURS = 48;
export const ONBOARDING_WINDOW_DAYS = 14;

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Convert an FQDN to a zone-relative name for the Scaleway DNS API.
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
 * The zone's own name, rejoined from Scaleway's split representation. A root
 * zone reports an EMPTY `subdomain`; a delegated child reports the label.
 * @param {{domain: string, subdomain?: string}} zone
 * @returns {string}
 */
function zoneName(zone) {
  const sub = String(zone.subdomain ?? '').trim();
  return sub ? `${sub}.${zone.domain}` : zone.domain;
}

/** @param {string} apiToken */
function authHeaders(apiToken) {
  // The SECRET key alone authenticates the REST path — same header every
  // ScalewayProvider call site uses. Never interpolate it into a URL or error.
  return { 'X-Auth-Token': apiToken };
}

/** @param {string} apiToken */
function jsonHeaders(apiToken) {
  return { ...authHeaders(apiToken), 'Content-Type': 'application/json' };
}

/**
 * Scaleway's error envelope is `{message, type, resource, fields}` (scw/errors.go).
 * A 403 "domain not found" is the single most confusing one this backend can
 * produce — it does NOT mean the credential is wrong, it means the account does
 * not manage that domain yet — so it gets the onboarding pointer attached.
 * Never interpolate the token.
 * @param {Response} response
 * @param {string} prefix
 * @returns {Promise<Error>}
 */
async function apiError(response, prefix) {
  const body = await response.json().catch(() => ({}));
  const message = body.message || response.statusText || `HTTP ${response.status}`;
  const hint =
    response.status === 403 && /domain not found/i.test(String(body.message ?? ''))
      ? ', Scaleway does not manage this domain yet. Add it as an external domain and prove ' +
        `ownership with a ${EXTERNAL_DOMAIN_CHALLENGE_NAME} TXT record first (vibecarbon offers ` +
        'this when it finds no zone for your domain).'
      : '';
  return new Error(`${prefix}: ${message}${hint}`);
}

/**
 * Walk a page/page_size collection to completion. Scaleway reports
 * `total_count`, but the terminating condition here is a SHORT PAGE — that
 * works whether or not the count is present and cannot loop on a stale count.
 *
 * @param {string} apiToken
 * @param {string} path - e.g. '/dns-zones'
 * @param {string} key - response array key (e.g. 'dns_zones')
 * @param {string} errorPrefix
 * @returns {Promise<object[]>}
 */
async function walkPages(apiToken, path, key, errorPrefix) {
  const items = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await fetchWithRetry(
      `${DOMAIN_API}${path}?page=${page}&page_size=${PAGE_SIZE}`,
      { headers: authHeaders(apiToken) },
    );

    if (!response.ok) throw await apiError(response, errorPrefix);

    const data = await response.json();
    const rows = Array.isArray(data[key]) ? data[key] : [];
    items.push(...rows);

    if (rows.length < PAGE_SIZE) break;
  }

  return items;
}

/**
 * Every record in a zone.
 * @param {string} apiToken
 * @param {string} zone - the zone NAME (Scaleway's zone identity)
 * @returns {Promise<object[]>}
 */
async function getRecords(apiToken, zone) {
  return walkPages(apiToken, `/dns-zones/${zone}/records`, 'records', 'Scaleway DNS API error');
}

/**
 * Records at a given (relative name, type). Scaleway stores and returns the
 * zone-relative name, but we accept the fully-qualified spelling too so an
 * inconsistency can't turn an update into a duplicate create — the same
 * tolerance every sibling backend applies.
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
 * TXT payloads travel QUOTED on this API (`"token"`, not `token`) — the shape
 * a live add was verified in. Everything else (A/AAAA/CNAME) is sent verbatim.
 * Idempotent: an already-quoted value is left alone.
 * @param {string} type
 * @param {string} value
 * @returns {string}
 */
function wireData(type, value) {
  const raw = String(value);
  if (type !== 'TXT') return raw;
  return raw.startsWith('"') && raw.endsWith('"') ? raw : `"${raw}"`;
}

/**
 * The one mutation primitive: PATCH the zone's records with a `changes` array.
 * Returns the raw Response so callers choose their own failure posture —
 * creates throw, deletes swallow (the sibling contract).
 *
 * @param {string} apiToken
 * @param {string} zone - the zone NAME
 * @param {object[]} changes - RecordChange items (add / set / delete / clear)
 * @returns {Promise<Response>}
 */
async function patchChanges(apiToken, zone, changes) {
  return fetchWithRetry(`${DOMAIN_API}/dns-zones/${zone}/records`, {
    method: 'PATCH',
    headers: jsonHeaders(apiToken),
    body: JSON.stringify({ changes }),
  });
}

// ============================================================================
// LOW-LEVEL API FUNCTIONS
// ============================================================================

/**
 * Get all DNS zones in the Scaleway account.
 *
 * Deliberately NOT filtered by `project_id`: the dedicated-Project doctrine
 * (see scaleway-guided-setup.js) governs where SERVERS land, but a zone parked
 * in a sibling Project is still perfectly usable for DNS, and hiding it would
 * strand an operator whose domain has been managed for years.
 *
 * @param {string} apiToken - Scaleway secret key
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
export async function getZones(apiToken) {
  const zones = await walkPages(apiToken, '/dns-zones', 'dns_zones', 'Scaleway DNS API error');
  // The name IS the id on Scaleway — see the module header.
  return zones.map((z) => ({ id: zoneName(z), name: zoneName(z) }));
}

/**
 * Create or update a DNS record.
 *
 * Update-or-create, never blind-create: a second deploy into the same zone
 * must repoint the existing record rather than stack a second A record beside
 * it (two A records at the apex would round-robin traffic at a dead IP). The
 * update is a `set` keyed on the existing record's id; the create is an `add`.
 *
 * @param {string} apiToken - Scaleway secret key
 * @param {string} zoneId - Zone identity — the zone NAME on Scaleway
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
  const record = { name: relativeName, type, ttl, data: wireData(type, value) };

  const existing = await getRecords(apiToken, zoneId);
  const match = matching(existing, relativeName, String(name).replace(/\.$/, ''), type)[0];

  const response = await patchChanges(apiToken, zoneId, [
    match ? { set: { id: match.id, records: [record] } } : { add: { records: [record] } },
  ]);

  if (!response.ok) {
    throw await apiError(
      response,
      match ? 'Failed to update DNS record' : 'Failed to create DNS record',
    );
  }

  // The response carries records (which ones depends on `return_all_records`,
  // whose default we do not rely on), so pick ours out of whatever came back
  // and fall back to what we wrote.
  const body = await response.json().catch(() => ({}));
  const written = Array.isArray(body.records)
    ? body.records.find((r) => r.type === type && r.name === relativeName)
    : null;
  return written ?? record;
}

/**
 * Delete a DNS record, but only if its target IP belongs to this caller.
 *
 * Scaleway stores one row per record (like Cloudflare, unlike Hetzner's
 * rrsets), so ownership is filtered per record and the return is the
 * Cloudflare *count* shape rather than Hetzner's boolean. The wire call is a
 * single PATCH carrying one `delete` change per doomed record — there is no
 * per-record DELETE endpoint on this API (module header, point 2).
 *
 * Ownership rule: a record is "ours" iff its `data` (the target IP) is in
 * `ownedIps`. Records pointing elsewhere are preserved and surfaced in
 * `skippedTargets`. An empty `ownedIps` refuses every delete — the safer
 * default when envConfig has no server IPs to compare against, and the exact
 * case behind the 2026-05-16 blast-radius bug where one scenario's destroy
 * zeroed a neighbour's record in a shared zone.
 *
 * @param {string} apiToken - Scaleway secret key
 * @param {string} zoneId - Zone identity — the zone NAME on Scaleway
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
  const doomed = [];
  const skippedTargets = [];

  for (const record of records) {
    if (owned.has(record.data)) doomed.push(record);
    else skippedTargets.push(record.data);
  }

  let deleted = 0;
  if (doomed.length > 0) {
    const response = await patchChanges(
      apiToken,
      zoneId,
      doomed.map((record) => ({ delete: { id: record.id } })),
    );
    // One PATCH, all-or-nothing: the zone update either applies or it doesn't.
    if (response.ok) deleted = doomed.length;
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
 * SEQUENTIAL, unlike the siblings' Promise.all: each PATCH bumps the zone's
 * SOA serial, and two in-flight updates of the same zone race on it.
 *
 * @param {string} apiToken - Scaleway secret key
 * @param {string} zoneId - Zone identity — the zone NAME on Scaleway
 * @param {string} domain - Apex domain (the wildcard record is `*.<domain>`)
 * @param {string[]} ownedIps - IPs that belong to this caller's stack
 * @returns {Promise<{deletedAny: boolean, preservedTargets: string[]}>}
 */
export async function deleteApexAndWildcard(apiToken, zoneId, domain, ownedIps) {
  const root = await deleteDNSRecord(apiToken, zoneId, domain, ownedIps);
  const wildcard = await deleteDNSRecord(apiToken, zoneId, `*.${domain}`, ownedIps);
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
 * @param {string} apiToken - Scaleway secret key
 * @param {string} zoneId - Zone identity — the zone NAME on Scaleway
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
    if (records.length === 0) continue;
    // All the accumulated tokens under one name go in a single PATCH.
    const response = await patchChanges(
      apiToken,
      zoneId,
      records.map((record) => ({ delete: { id: record.id } })),
    );
    if (response.ok) {
      deleted += records.length;
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
 * @param {string} auth.token - Scaleway secret key
 * @param {string} auth.zoneId - Zone identity — the zone NAME on Scaleway
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
// EXTERNAL-DOMAIN ONBOARDING (no sibling backend has an equivalent)
// ============================================================================

/**
 * The registration state of a domain, from the Registrar API's own listing.
 *
 * `GET /domains` is the only read that answers "does this account manage the
 * domain, and if not yet, what token proves it" — the DNS-zones endpoints 403
 * for anything unknown, which reads as an auth failure rather than the
 * onboarding gap it actually is.
 *
 * @param {string} apiToken - Scaleway secret key
 * @param {string} domain - the registrable domain (e.g. "example.com")
 * @returns {Promise<{found: boolean, status: string|null, isExternal: boolean, validationToken: string|null, createdAt: string|null}>}
 */
export async function getExternalDomainRegistration(apiToken, domain) {
  const clean = String(domain).replace(/\.$/, '').toLowerCase();
  const domains = await walkPages(apiToken, '/domains', 'domains', 'Scaleway Domains API error');
  const row = domains.find((d) => String(d.domain).toLowerCase() === clean);

  if (!row) {
    return {
      found: false,
      status: null,
      isExternal: false,
      validationToken: null,
      createdAt: null,
    };
  }
  return {
    found: true,
    status: row.status ?? null,
    isExternal: Boolean(row.is_external),
    validationToken: row.external_domain_registration_status?.validation_token ?? null,
    // Carried so the 48h window can be shown as an ABSOLUTE moment. An
    // operator who comes back tomorrow cannot do anything with "48 hours".
    createdAt: row.created_at ?? null,
  };
}

/**
 * The absolute moment the ownership check expires: registration time + 48h.
 * Null when the API gave us no usable timestamp — a missing deadline must
 * read as unknown, never as "plenty of time".
 *
 * @param {string|null|undefined} createdAt - ISO timestamp from the API
 * @returns {Date|null}
 */
export function validationDeadline(createdAt) {
  if (!createdAt) return null;
  const started = new Date(createdAt);
  if (Number.isNaN(started.getTime())) return null;
  return new Date(started.getTime() + VALIDATION_WINDOW_HOURS * 3600_000);
}

/**
 * Poll until the domain's registration goes `active`, or the budget runs out.
 *
 * Deliberately SHORT-budgeted by default. Scaleway re-checks the TXT on its
 * own cadence — a live onboarding was still `checking` nine minutes in — so
 * blocking a deploy until it flips would usually just burn the operator's
 * time. The poll exists to catch the fast case; timing out is an ordinary
 * outcome the caller reports alongside the deadline, not a failure.
 *
 * @param {string} apiToken - Scaleway secret key
 * @param {string} domain - the registrable domain
 * @param {object} [options]
 * @param {number} [options.timeoutMs=90000] - total budget
 * @param {number} [options.intervalMs=10000] - gap between checks
 * @param {(elapsedMs: number, status: string|null) => void} [options.onTick]
 * @returns {Promise<{active: boolean, status: string|null}>}
 */
export async function waitForExternalDomainActive(apiToken, domain, options = {}) {
  const { timeoutMs = 90_000, intervalMs = 10_000, onTick } = options;
  const started = Date.now();
  const deadline = started + timeoutMs;
  let status = null;

  while (true) {
    try {
      const registration = await getExternalDomainRegistration(apiToken, domain);
      status = registration.status;
      if (status === 'active') return { active: true, status };
    } catch {
      // A blip mid-poll is not an answer — keep the previous status and retry
      // while budget remains.
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) return { active: false, status };

    onTick?.(Date.now() - started, status);
    // Global setTimeout, not node:timers/promises — same reason as
    // dns-propagation.js: vitest's fake timers only patch the global one.
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
  }
}

/**
 * Register a domain held at another registrar as an EXTERNAL domain, returning
 * the token that proves ownership of it.
 *
 * The domain is NOT usable when this resolves: Scaleway polls for a
 * `_scaleway-challenge` TXT record carrying `validationToken` in the domain's
 * CURRENT DNS zone (48h window), and only then creates the root DNS zone and
 * accepts the NS delegation to `NAMESERVERS` (14 days overall). Callers must
 * surface both steps, IN THAT ORDER, rather than treat this as provisioning —
 * see scaleway-guided-setup.js#onboardDomain.
 *
 * @param {string} apiToken - Scaleway secret key
 * @param {string} domain - the registrable domain (e.g. "example.com")
 * @param {string} projectId - Scaleway Project the domain is registered into
 * @returns {Promise<{domain: string, validationToken: string, projectId: string, createdAt: string|null}>}
 */
export async function registerExternalDomain(apiToken, domain, projectId) {
  if (!projectId) {
    throw new Error(
      'Registering an external domain needs a Scaleway Project ID. Set ' +
        "SCALEWAY_DEFAULT_PROJECT_ID in your shell or the project's .env.local " +
        '(vibecarbon configure → Providers → Scaleway collects it).',
    );
  }

  const response = await fetchWithRetry(`${DOMAIN_API}/external-domains`, {
    method: 'POST',
    headers: jsonHeaders(apiToken),
    body: JSON.stringify({ domain, project_id: projectId }),
  });

  if (!response.ok) throw await apiError(response, 'Failed to register external domain');

  const body = await response.json();
  return {
    domain: body.domain,
    validationToken: body.validation_token,
    projectId: body.project_id,
    createdAt: body.created_at ?? null,
  };
}

// ============================================================================
// HIGH-LEVEL SETUP FUNCTIONS
// ============================================================================

/**
 * Set up Scaleway DNS for a simple single-server deployment.
 * Creates root A and wildcard A records.
 *
 * @param {string} apiToken - Scaleway secret key
 * @param {string} zoneId - Zone identity — the zone NAME on Scaleway
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
    s?.stop(`Scaleway DNS setup failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Set up Scaleway DNS for an HA deployment.
 * Creates root A and wildcard A records pointing to the primary server,
 * with a low TTL for fast failover propagation.
 *
 * Note: Scaleway DNS has health checks and dynamic records, but this path uses
 * neither — failover is triggered manually via `vibecarbon failover`, the same
 * as every other backend.
 *
 * @param {string} apiToken - Scaleway secret key
 * @param {string} zoneId - Zone identity — the zone NAME on Scaleway
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
    s.stop(`Scaleway DNS setup failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}
