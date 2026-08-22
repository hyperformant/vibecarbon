/**
 * Cloudflare API operations
 * Shared across deploy.js and destroy.js
 */

import { challengeRecordNames } from './acme-challenge.js';
import { spinner } from './cli/progress.js';
import { fetchWithRetry } from './fetch-retry.js';

// ============================================================================
// TOKEN VERIFICATION
// ============================================================================

/**
 * Verify a Cloudflare API token via the tokens/verify endpoint. Used by
 * cloudflare-guided-setup.js's env-lookup and interactive-prompt loops, and
 * by deploy/prompts.js's DNS-provider flow before accepting a token.
 *
 * Semantics mirror hetzner-guided-setup.js's validateHetznerToken /
 * digitalocean-guided-setup.js's validateDigitalOceanToken exactly: a
 * network failure is NOT treated as an invalid token (a flaky connection
 * shouldn't strand an otherwise-good token) — it comes back valid:true +
 * unreachable:true so the caller can proceed with a warning instead of
 * blocking.
 *
 * @param {string} apiToken - Cloudflare API token
 * @returns {Promise<{ valid: boolean, error?: string, unreachable?: boolean }>}
 */
export async function verifyToken(apiToken) {
  try {
    const response = await fetchWithRetry(
      'https://api.cloudflare.com/client/v4/user/tokens/verify',
      {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
      },
    );

    if (response.status === 401 || response.status === 403) {
      let message = 'Token is invalid or expired';
      try {
        const data = await response.json();
        message = data.errors?.[0]?.message || message;
      } catch {
        // Body wasn't JSON (or was empty) — keep the default message.
      }
      return { valid: false, error: message };
    }

    if (!response.ok) {
      return { valid: false, error: `Cloudflare API returned status ${response.status}` };
    }

    const data = await response.json();
    if (data.success) return { valid: true };
    return { valid: false, error: data.errors?.[0]?.message || 'Token verification failed' };
  } catch {
    return { valid: true, unreachable: true };
  }
}

// ============================================================================
// ZONE AND ACCOUNT OPERATIONS
// ============================================================================

/**
 * Get all zones in the Cloudflare account
 *
 * @param {string} apiToken - Cloudflare API token
 * @returns {Promise<Array>} - Array of zone objects
 */
export async function getZones(apiToken) {
  const response = await fetchWithRetry('https://api.cloudflare.com/client/v4/zones', {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Cloudflare API error: ${JSON.stringify(error.errors)}`);
  }

  const data = await response.json();
  return data.result;
}

// ============================================================================
// DNS RECORD OPERATIONS
// ============================================================================

/**
 * Create or update a DNS record (uniform backend contract: the record
 * target arrives as `value`; Cloudflare's wire field `content` is an
 * internal mapping here).
 *
 * @param {string} apiToken - Cloudflare API token
 * @param {string} zoneId - Zone ID
 * @param {object} config - Record configuration
 * @param {string} config.type - Record type (A, CNAME, etc.)
 * @param {string} config.name - Record name
 * @param {string} config.value - Record target (IP address, etc.)
 * @param {boolean} [config.proxied=true] - Whether to proxy through Cloudflare
 * @param {number} [config.ttl=1] - TTL (1 = auto)
 * @returns {Promise<object>} - API response
 */
export async function createDNSRecord(apiToken, zoneId, config) {
  const { type, name, value: content, proxied = true, ttl = 1 } = config;

  // Check if record already exists
  const listResponse = await fetchWithRetry(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=${type}&name=${name}`,
    {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    },
  );

  const listData = await listResponse.json();
  const existing = listData.result?.find((r) => r.name === name && r.type === type);

  if (existing) {
    // Update existing record
    const updateResponse = await fetchWithRetry(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${existing.id}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content, proxied, ttl }),
      },
    );
    return updateResponse.json();
  }

  // Create new record
  const response = await fetchWithRetry(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type, name, content, proxied, ttl }),
    },
  );

  return response.json();
}

/**
 * Delete a DNS record, but only if its target IP belongs to this caller.
 *
 * Cloudflare zones can hold multiple A records for the same name (e.g. when
 * two e2e scenarios share a root domain and each owns a subdomain).
 * Deleting unconditionally wipes neighbours' records too — the blast-radius
 * bug observed in the 2026-05-16 matrix where compose-ha's destroy zeroed
 * compose's `e1.carbonstack.dev` mid-verify.
 *
 * Ownership rule: a record is "ours" iff its `content` (the target IP) is
 * in `ownedIps`. Records pointing elsewhere are preserved with a `skipped`
 * count. Pass an empty array to refuse all deletes (the safer default when
 * envConfig has no server IPs to compare against).
 *
 * @param {string} apiToken - Cloudflare API token
 * @param {string} zoneId - Zone ID
 * @param {string} name - Record name (FQDN)
 * @param {string[]} ownedIps - IPs that belong to this caller's stack
 * @param {string} [type='A'] - Record type
 * @returns {Promise<{deleted: number, skipped: number, total: number, skippedTargets: string[]}>}
 */
export async function deleteDNSRecord(apiToken, zoneId, name, ownedIps, type = 'A') {
  const listResponse = await fetchWithRetry(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=${type}&name=${name}`,
    {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    },
  );

  const listData = await listResponse.json();
  const records = (listData.result || []).filter((r) => r.name === name && r.type === type);
  const total = records.length;

  if (total === 0) {
    return { deleted: 0, skipped: 0, total: 0, skippedTargets: [] };
  }

  const owned = new Set(ownedIps || []);
  let deleted = 0;
  const skippedTargets = [];

  for (const record of records) {
    if (!owned.has(record.content)) {
      skippedTargets.push(record.content);
      continue;
    }
    const response = await fetchWithRetry(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${record.id}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
      },
    );
    if (response.ok) deleted++;
  }

  return { deleted, skipped: skippedTargets.length, total, skippedTargets };
}

/**
 * Delete the apex + wildcard A-record pair for a domain, ownership-filtered
 * (same `ownedIps` contract as `deleteDNSRecord` above — records pointing
 * elsewhere are preserved, not deleted). Mirrors `upsertApexAndWildcard`
 * below on the create side: deploy always creates both records, so every
 * Cloudflare-DNS destroy path must delete both too.
 *
 * Lives here (not in a single call site) because THREE independent
 * destroy paths need it — destroy.js's compose-tier and k8s-tier destroy
 * sections, and compose/ha.js's destroyComposeHA — and each was found
 * deleting only the root, orphaning the wildcard on every Cloudflare-DNS
 * destroy at a released IP a stranger could later be assigned (M3 Task 9i;
 * the ha.js instance surfaced in fix round 1, after the initial destroy.js
 * fix already shipped). destroy.js and ha.js can't share code directly —
 * destroy.js registers process-level SIGINT/SIGTERM handlers at module load,
 * so importing it from ha.js (loaded on every deploy/scale/failover, not
 * just destroy) would double-register those — so the shared piece lives in
 * this module instead, which both already depend on for DNS primitives.
 *
 * @param {string} apiToken - Cloudflare API token
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
 * Cloudflare stores one row per value, so the 11 stray `_acme-challenge.*`
 * TXTs the 2026-08-10 audit found on appcarbon.dev are 11 deletes, not one.
 *
 * @param {string} apiToken - Cloudflare API token
 * @param {string} zoneId - Zone ID
 * @param {string} domain - the environment's domain
 * @returns {Promise<{deleted: number, names: string[]}>}
 */
export async function deleteChallengeRecords(apiToken, zoneId, domain) {
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };
  let deleted = 0;
  const names = [];

  for (const fqdn of challengeRecordNames(domain)) {
    const listResponse = await fetchWithRetry(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=TXT&name=${fqdn}`,
      { headers },
    );
    const listData = await listResponse.json();
    const records = (listData.result || []).filter((r) => r.name === fqdn && r.type === 'TXT');

    let removedHere = 0;
    for (const record of records) {
      const response = await fetchWithRetry(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${record.id}`,
        { method: 'DELETE', headers },
      );
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
 * the same IP. Shared by scale.js's post-scale DNS update and failover.js's
 * `HA_DNS_STRATEGIES.cloudflare.updateDns` — both flows repoint every
 * subdomain (api, registry, ...) at whichever server IP is currently
 * primary. Extracted in C6b; behavior is unchanged from the two call sites'
 * former inline copies.
 *
 * proxied:false matches the deploy-time setup (Cloudflare LBs removed
 * 2026-03-26 — orange cloud no longer needed; see setupSimple's comment for
 * the full RCA on why proxied must stay false).
 *
 * @param {object} auth
 * @param {string} auth.token - Cloudflare API token
 * @param {string} auth.zoneId - Zone ID
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
    proxied: false,
  });
  await createDNSRecord(token, zoneId, {
    type: 'A',
    name: `*.${domain}`,
    value: ip,
    proxied: false,
  });
}

// ============================================================================
// HEALTH CHECK OPERATIONS
// ============================================================================

/**
 * Create a health check
 *
 * @param {string} apiToken - Cloudflare API token
 * @param {string} zoneId - Zone ID
 * @param {object} config - Health check configuration
 * @returns {Promise<object>} - API response
 */
async function createHealthCheck(apiToken, zoneId, config) {
  const { name, address, path = '/api/health', port = 443 } = config;

  const response = await fetchWithRetry(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/healthchecks`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        address,
        type: 'HTTPS',
        port,
        method: 'GET',
        path,
        interval: 60,
        timeout: 5,
        retries: 2,
        consecutive_fails: 2,
        consecutive_successes: 1,
      }),
    },
  );

  return response.json();
}

/**
 * Delete a health check
 *
 * @param {string} apiToken - Cloudflare API token
 * @param {string} zoneId - Zone ID
 * @param {string} name - Health check name
 * @returns {Promise<boolean>} - True if deleted
 */
export async function deleteHealthCheck(apiToken, zoneId, name) {
  // List health checks
  const listResponse = await fetchWithRetry(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/healthchecks`,
    {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    },
  );

  const listData = await listResponse.json();
  const healthCheck = listData.result?.find((h) => h.name === name);

  if (!healthCheck) return false;

  const response = await fetchWithRetry(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/healthchecks/${healthCheck.id}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    },
  );

  return response.ok;
}

// ============================================================================
// HIGH-LEVEL SETUP FUNCTIONS
// ============================================================================

/**
 * Set up Cloudflare for HA deployment with DNS records and health checks
 *
 * @param {string} apiToken - Cloudflare API token
 * @param {string} zoneId - Zone ID
 * @param {string} domain - Domain name
 * @param {Array} servers - Array of server objects with name and ip
 * @returns {Promise<object>} - Setup result
 */
export async function setupHA(apiToken, zoneId, domain, servers) {
  const s = spinner();

  try {
    // Create A record pointing to primary server.
    //
    // proxied: false (gray cloud, DNS-only). Was `true` (orange cloud)
    // back when we used Cloudflare Load Balancers for automatic
    // failover — the proxy was load-bearing because LB rules ran at
    // CF's edge. Cloudflare LBs were removed 2026-03-26 in favor of
    // manual failover (rewriting this A record on demand), so the
    // proxy is no longer needed and is actively harmful: with orange
    // cloud, CF intercepts the apex and serves a 404 from its edge
    // until it can verify the origin's cert and a route exists. The
    // wildcard below was already gray-cloud — apex matches it now so
    // both are direct-to-origin via Traefik + Let's Encrypt.
    // RCA: k8s-ha 2026-04-30 deploy probe got 404 for 1200s — DNS
    // resolved fine, but CF proxy returned 404 instead of forwarding.
    s.start(`Creating DNS record for ${domain}`);
    await createDNSRecord(apiToken, zoneId, {
      type: 'A',
      name: domain,
      value: servers[0].ip,
      proxied: false,
    });
    s.stop('Primary DNS record created');

    // Create wildcard A record for subdomains (registry, api, etc.)
    // DNS-only (not proxied) — Traefik handles TLS via Let's Encrypt
    await createDNSRecord(apiToken, zoneId, {
      type: 'A',
      name: `*.${domain}`,
      value: servers[0].ip,
      proxied: false,
    });

    // Create health checks for monitoring both regions
    for (const server of servers) {
      s.start(`Creating health check for ${server.name}`);
      await createHealthCheck(apiToken, zoneId, {
        name: `${server.name}-health`,
        address: server.ip,
        path: '/api/health',
      });
      s.stop(`Health check created for ${server.name}`);
    }

    return {
      success: true,
      mode: 'dns',
      primaryIp: servers[0].ip,
      standbyIp: servers[1]?.ip,
    };
  } catch (error) {
    s.stop(`Cloudflare DNS setup failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Set up Cloudflare for simple single-server deployment
 *
 * @param {string} apiToken - Cloudflare API token
 * @param {string} zoneId - Zone ID
 * @param {string} domain - Domain name
 * @param {string} serverIp - Server IP address
 * @returns {Promise<object>} - Setup result
 */
export async function setupSimple(apiToken, zoneId, domain, serverIp, options = {}) {
  // proxied default flipped to false (DNS-only / gray-cloud) on
  // 2026-04-26 after e2e run #3 surfaced the orange-cloud
  // chicken-and-egg: with proxied=true, dig resolves to CF edge IPs
  // (172.67.x / 104.21.x), not the origin floating IP. CF then
  // intercepts HTTPS, terminates with its Universal SSL cert, and
  // tries to talk to origin per the zone's SSL mode (default Full
  // (strict) for new zones — requires a valid origin cert). Origin's
  // cert-manager can't issue via HTTP-01 because LE follows CF's
  // Always-Use-HTTPS redirect and gets rejected at origin since cert
  // isn't issued yet. Loop. With proxied=false, dig resolves to the
  // origin IP directly, LE HTTP-01 hits origin on :80, traefik serves
  // the challenge, cert issues, HTTPS works. Callers that want CF's
  // edge TLS can opt in via options.proxied=true (they're then
  // responsible for setting the zone SSL mode + ensuring origin
  // accepts CF's challenge path).
  const { proxied = false, onProgress } = options;
  // When caller provides onProgress, skip internal spinners (caller manages UI)
  const s = onProgress ? null : spinner();

  try {
    // Create A record for main domain
    s?.start(`Creating DNS records for ${domain}`);
    onProgress?.(`Creating DNS records for ${domain}`);
    const result = await createDNSRecord(apiToken, zoneId, {
      type: 'A',
      name: domain,
      value: serverIp,
      proxied,
    });

    // Create wildcard A record for all subdomains (api, registry, etc.)
    // DNS-only (not proxied) — Cloudflare free/pro plans don't proxy wildcards,
    // and Traefik handles TLS via Let's Encrypt anyway.
    await createDNSRecord(apiToken, zoneId, {
      type: 'A',
      name: `*.${domain}`,
      value: serverIp,
      proxied: false,
    });
    s?.stop('DNS records created (root + wildcard)');
    onProgress?.('DNS records created (root + wildcard)');

    // Create health check (informational, doesn't affect routing without LB)
    s?.start('Creating health check');
    onProgress?.('Creating health check');
    await createHealthCheck(apiToken, zoneId, {
      name: `${domain}-health`,
      address: serverIp,
      path: '/api/health',
    });
    s?.stop('Health check created');
    onProgress?.('Health check created');

    return { success: true, mode: 'simple', record: result.result };
  } catch (error) {
    s?.stop(`Cloudflare setup failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}
