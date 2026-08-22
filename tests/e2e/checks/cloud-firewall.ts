/**
 * Cloud-firewall-presence check — a continuous e2e guard that each deployed
 * compose/compose-ha server carries its own cloud firewall.
 *
 * RCA (`.superpowers/sdd/fwtest-findings.md`, 2026-07-25): a scratch
 * experiment against real DigitalOcean infra proved `buildDigitalOcean
 * ComposeProgram`'s `digitalocean.Firewall` resource IS genuinely created and
 * attached — Pulumi state and DO's own `/v2/firewalls` API agreed, both
 * account-wide and by direct ID lookup. But two earlier ad-hoc account
 * snapshots taken mid e2e-run had read zero firewalls, and nothing in the
 * suite continuously asserts a deployed server actually carries its
 * firewall — so a real regression there (a Pulumi program silently dropping
 * the resource, a provider bug eating it post-apply) would go unnoticed
 * indefinitely. This turns that one-off mystery into a standing assertion.
 *
 * Provider-neutral through `BaseProvider.findFirewallByName` (see
 * src/lib/providers/base.js) — both HetznerProvider and DigitalOceanProvider
 * implement it, and both compose IaC programs name each server's firewall
 * `${serverName}-firewall` (src/lib/iac/programs/hetzner-compose.js,
 * digitalocean-compose.js). Existence is the MUST: a missing firewall fails
 * the check outright, no skip/bypass — there is no legitimate case today
 * where a deployed compose/compose-ha server has no cloud firewall.
 * Attachment (the firewall's own rules apply to THIS server's id) is only a
 * WARN surfaced in `details`, never a fail, because the two providers expose
 * attachment in different, differently-timed shapes (DigitalOcean's flat
 * `droplet_ids`, Hetzner's `applied_to[].server.id`) and neither is the
 * empirically-verified invariant here — existence is.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerificationResult } from '../scenarios/types.js';

/** One deployed server to check a firewall for. */
export interface FirewallCheckServer {
  /** Provider-side server name — the firewall is named `${name}-firewall`. */
  name: string;
  /** Provider-assigned server id, when known. Used only for the attachment warn. */
  id?: string | number | null;
}

/**
 * Minimal provider surface this check depends on — see
 * `BaseProvider.findFirewallByName` (src/lib/providers/base.js). Kept
 * narrow (rather than importing the concrete provider classes) so unit
 * tests can pass a trivial mock without touching real provider wiring.
 * Return type is the untyped `object` BaseProvider's JSDoc infers (not
 * `Record<string, unknown>`, which real provider instances don't
 * structurally satisfy) — callers cast to `Record<string, unknown>` to read
 * fields, since both providers' firewall objects are plain JSON.
 */
export interface FirewallProvider {
  findFirewallByName(name: string): Promise<object | null>;
}

/**
 * Best-effort extraction of the server ids a firewall is attached to, across
 * both provider wire shapes seen in this codebase: DigitalOcean's flat
 * `droplet_ids: number[]` (digitalocean.js's setFirewallRules reads/writes
 * this same field) and Hetzner's `applied_to: [{ type: 'server', server: {
 * id } }, ...]` (the Hetzner Cloud API's firewall resource shape). Returns
 * null when neither field is present/array-shaped — "can't tell", which the
 * caller must treat differently from "known not attached".
 */
export function extractAttachedServerIds(firewall: Record<string, unknown>): string[] | null {
  const dropletIds = firewall.droplet_ids;
  if (Array.isArray(dropletIds)) {
    return dropletIds.map((id) => String(id));
  }
  const appliedTo = firewall.applied_to;
  if (Array.isArray(appliedTo)) {
    return appliedTo
      .map((entry) => {
        const server = (entry as { server?: { id?: unknown } } | null)?.server;
        return server && server.id != null ? String(server.id) : null;
      })
      .filter((id): id is string => id !== null);
  }
  return null;
}

/**
 * Assert `${server.name}-firewall` exists. Existence is the MUST (fails the
 * check on false/error); attachment to `server.id` is a lenient WARN carried
 * in `details.attachmentWarning` only — see the module doc for why.
 */
export async function checkServerFirewall(
  provider: FirewallProvider,
  server: FirewallCheckServer,
): Promise<VerificationResult> {
  const start = Date.now();
  const firewallName = `${server.name}-firewall`;
  const checkName = `cloud_firewall_present:${server.name}`;

  let firewall: Record<string, unknown> | null;
  try {
    firewall = (await provider.findFirewallByName(firewallName)) as Record<string, unknown> | null;
  } catch (err) {
    return {
      checkName,
      status: 'fail',
      responseTimeMs: Date.now() - start,
      errorMessage: `findFirewallByName('${firewallName}') threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
      details: { firewallName, serverId: server.id ?? null },
    };
  }

  if (!firewall) {
    return {
      checkName,
      status: 'fail',
      responseTimeMs: Date.now() - start,
      errorMessage: `No cloud firewall named '${firewallName}' found for server '${server.name}'`,
      details: { firewallName, serverId: server.id ?? null },
    };
  }

  const attachedIds = extractAttachedServerIds(firewall);
  const serverId = server.id != null ? String(server.id) : null;
  // null = undeterminable (unknown shape, or we never learned this server's
  // provider id) — never treated as a failed attachment.
  const attached =
    attachedIds === null || serverId === null ? null : attachedIds.includes(serverId);

  const details: Record<string, unknown> = {
    firewallName,
    firewallId: (firewall as { id?: unknown }).id ?? null,
    serverId,
    attached,
  };
  if (attached === false) {
    details.attachmentWarning =
      `Firewall '${firewallName}' exists but its attachment list ` +
      `[${(attachedIds ?? []).join(', ')}] does not include server id ${serverId}`;
  }

  return {
    checkName,
    status: 'pass',
    responseTimeMs: Date.now() - start,
    details,
  };
}

/**
 * Run the firewall-presence check for every deployed server. Never throws —
 * a missing provider or empty server list is itself a loud FAIL (not a
 * skip): there is no legitimate compose/compose-ha deploy with no cloud
 * firewall concept today, so nothing here silently passes.
 */
export async function runCloudFirewallChecks(
  provider: FirewallProvider | null,
  servers: FirewallCheckServer[],
): Promise<VerificationResult[]> {
  if (!provider) {
    return [
      {
        checkName: 'cloud_firewall_present',
        status: 'fail',
        errorMessage: 'No provider instance available to check cloud firewalls',
      },
    ];
  }
  if (servers.length === 0) {
    return [
      {
        checkName: 'cloud_firewall_present',
        status: 'fail',
        errorMessage: 'No deployed servers found to check cloud firewalls for',
      },
    ];
  }

  const results: VerificationResult[] = [];
  for (const server of servers) {
    results.push(await checkServerFirewall(provider, server));
  }
  return results;
}

// ---------------------------------------------------------------------------
// .vibecarbon.json server resolution
// ---------------------------------------------------------------------------

interface RawServerEntry {
  name?: string;
  /**
   * Compose (non-HA) persists the role label `master` as `name` and the
   * REAL provider-side server name (`${projectName}-${environment}`,
   * src/lib/deploy/effects/index.js) separately as `providerServerName` —
   * see orchestrator.js's "Single-server fall-through" comment. Compose-HA
   * never sets this field because its `name` IS already the real provider
   * name (`${projectName}-${environment}-primary`/`-standby`,
   * src/lib/deploy/effects/compose-ha.js). Preferring providerServerName
   * when present handles both shapes uniformly.
   */
  providerServerName?: string;
  id?: string | number;
}

interface RawEnvConfig {
  servers?: RawServerEntry[];
}

interface RawProjectConfig {
  environments?: Record<string, RawEnvConfig>;
}

/**
 * Resolve the servers to check from `.vibecarbon.json`, mapping each
 * persisted entry to its real provider-side name (see RawServerEntry's doc
 * on providerServerName vs name). Fails soft (empty array) on any read/parse
 * error or a missing env — `runCloudFirewallChecks` turns that into a loud
 * FAIL rather than a silent skip, so this soft-failure never masks anything.
 */
export function resolveComposeFirewallServers(
  projectDir: string,
  env: string,
): FirewallCheckServer[] {
  try {
    const configPath = join(projectDir, '.vibecarbon.json');
    if (!existsSync(configPath)) return [];
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as RawProjectConfig;
    const envConfig = config.environments?.[env];
    const servers = envConfig?.servers ?? [];

    const out: FirewallCheckServer[] = [];
    for (const s of servers) {
      const name = s.providerServerName || s.name;
      if (!name) continue;
      out.push({ name, id: s.id ?? null });
    }
    return out;
  } catch {
    return [];
  }
}
