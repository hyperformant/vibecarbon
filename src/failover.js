/**
 * Vibecarbon Failover Command
 *
 * Promotes the standby region of an HA deployment to primary. Handles
 * four scenarios: HA+Cloudflare DNS, HA+Hetzner DNS, HA+manual DNS,
 * and single-server (where failover is a no-op + recovery instructions).
 *
 * Form rule: vibecarbon uses single-dash flags only — see
 * memory:feedback_cli_single_dash_flags. `-dry` (not `-dry-run` / `-n`)
 * previews the failover plan without executing.
 */

import { existsSync } from 'node:fs';
import * as p from '@clack/prompts';
import { formatInstant } from './lib/backup-format.js';
import { resolveEnvContext } from './lib/cli/env-context.js';
import { exitCancelled, exitDeclined } from './lib/cli/exit-guard.js';
import { introCommand } from './lib/cli/intro.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { spinner } from './lib/cli/progress.js';
import { c } from './lib/colors.js';
import { loadProjectConfig, saveProjectConfig } from './lib/config.js';
import {
  getReplPasswordFromSecret,
  isStandbyPromoted,
  isStandbyStreaming,
  promoteStandby,
  reseedStandbyFromPrimary,
} from './lib/deploy/replication.js';
import {
  assertWalgBackupsWorking,
  k8sWalgAuditArgv,
  WALG_AUDIT_PROBE_TIMEOUT_MS,
} from './lib/deploy/walg-audit.js';
import {
  k8sDbRolloutStatusArgv,
  k8sSetWalgRoleArgv,
  walgRoleDegradedMessage,
} from './lib/deploy/walg-role.js';
import {
  DNS_PROVIDERS,
  getDnsProvider,
  hasAutomatedDns,
  resolveDnsToken,
} from './lib/dns-provider.js';
import { ensureOperatorIpAccess } from './lib/operator-ip.js';
import { perfTimer } from './lib/perf.js';
import { confirmProdOrExit } from './lib/prod-confirm.js';
import { assertInProjectDir } from './lib/project-guard.js';
import { providerFor, providerIdFor, resolveProviderToken } from './lib/providers/index.js';
import { pollUntil } from './lib/retry.js';
import { getPostgresPod, getSSHKeyPath, sshKubectl, sshRun } from './lib/ssh.js';
import { createTracker } from './lib/tracker.js';
import { listWalgBackups } from './lib/walg-backups.js';

// ============================================================================
// COMMAND SPEC — single source of truth for argv parsing AND help output.
// ============================================================================

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, description?: string, examples?: Array<{ command: string, description?: string }> }} */
const SPEC = {
  name: 'failover',
  summary: 'Promote the standby region to primary',
  description: [
    'Scenarios:',
    '  HA + Cloudflare DNS   Promotes standby DB, switches DNS A record automatically',
    '  HA + Hetzner DNS      Promotes standby DB, switches DNS A record automatically',
    '  HA + Manual DNS       Promotes standby DB, prints DNS update instructions',
    '  Single Server         Prints backup/restore recovery steps',
  ].join('\n'),
  positional: [
    {
      name: 'env',
      optional: true,
      description: 'Environment to fail over (skips the env prompt)',
    },
  ],
  flags: [
    { name: 'h', boolean: true, description: 'Show this help' },
    { name: 'v', boolean: true, description: 'Show version' },
    { name: 'y', boolean: true, description: 'Skip confirmation prompts' },
    { name: 'dry', boolean: true, description: 'Show plan without executing' },
    { name: 'env', value: '<name>', description: 'Environment seed (alternative to positional)' },
    {
      name: 'server-type',
      value: '<id>',
      description: 'Worker server type override for pilot-light failover provisioning (e.g. cx33)',
    },
  ],
  examples: [
    { command: 'vibecarbon failover', description: 'prompts for env' },
    { command: 'vibecarbon failover prod -dry', description: 'preview the failover plan' },
    { command: 'vibecarbon failover prod -y', description: 'execute without confirmation' },
    {
      command: 'vibecarbon failover prod -server-type cpx42',
      description: 'provision failover workers on a specific server type',
    },
  ],
};

// ============================================================================
// SCENARIO DETECTION
// ============================================================================

export function detectScenario(envConfig) {
  const ha = envConfig.ha?.enabled || envConfig.ha === true;
  // Any registered DNS backend with a persisted zone flips automatically;
  // which backend is a strategy detail (dnsStrategyFor), not a scenario.
  // 'manual' or a missing/unknown provider (incl. a deploy that persisted
  // no dns block at all) degrades to the manual-DNS epilogue.
  const automatedDns = hasAutomatedDns(envConfig.dns?.provider) && envConfig.dns?.zoneId;
  if (ha && automatedDns) return 'ha_dns';
  if (ha) return 'ha_manual';
  return 'single_server';
}

/**
 * Identify primary and standby servers from the environment config.
 * HA deployments store server info in ha.primary/ha.standby within the environment,
 * or as separate entries in the servers array with region identifiers in their names.
 */
export function identifyServers(envName, envConfig, _projectConfig) {
  // Check for HA config with primary/standby info nested in the environment
  if (envConfig.ha?.primary && envConfig.ha?.standby) {
    return {
      primary: {
        ip: envConfig.ha.primary.masterIp,
        supabaseIp: envConfig.ha.primary.supabaseIp,
        supabasePrivateIp: envConfig.ha.primary.supabasePrivateIp,
        floatingIp: envConfig.ha.primary.floatingIp || envConfig.ha.primary.masterIp,
        region: envConfig.ha.primary.region,
        envKey: envName,
      },
      standby: {
        ip: envConfig.ha.standby.masterIp,
        supabaseIp: envConfig.ha.standby.supabaseIp,
        supabasePrivateIp: envConfig.ha.standby.supabasePrivateIp,
        floatingIp: envConfig.ha.standby.floatingIp || envConfig.ha.standby.masterIp,
        region: envConfig.ha.standby.region,
        envKey: envName,
      },
    };
  }

  // Fall back to servers array with role/region matching
  const servers = envConfig.servers || [];
  const primaryRegion = envConfig.region;
  const standbyRegion = envConfig.secondaryRegion || envConfig.ha?.failoverRegion;

  if (servers.length >= 2 && primaryRegion && standbyRegion) {
    // Prefer the `role` field — it is the only one a failover updates.
    // failoverComposeHA flips role in place and leaves both the array order and
    // the server names alone (the name is a Pulumi resource identity), so
    // name/region/index matching keeps returning the OLD primary after a
    // failover. Then name-based match (k8s HA stores { name: 'primary' /
    // 'standby' }), then region match (pre-gitops compose-HA used server names
    // that embedded the region).
    const byRole = (role) => servers.find((s) => s.role === role);
    const byName = (role) => servers.find((s) => s.name === role);
    const byRegion = (region) => servers.find((s) => s.name?.includes(region));
    const primary = byRole('primary') || byName('primary') || byRegion(primaryRegion) || servers[0];
    const standby = byRole('standby') || byName('standby') || byRegion(standbyRegion) || servers[1];

    return {
      primary: {
        ip: primary.ip,
        supabaseIp: primary.supabaseIp,
        supabasePrivateIp: primary.supabasePrivateIp,
        region: primaryRegion,
        envKey: envName,
      },
      standby: {
        ip: standby.ip,
        supabaseIp: standby.supabaseIp,
        supabasePrivateIp: standby.supabasePrivateIp,
        region: standbyRegion,
        envKey: envName,
      },
    };
  }

  return null;
}

// ============================================================================
// PROMOTION + SERVICE SCALE HELPERS
// ============================================================================

/**
 * Check whether the primary cluster's postgres is reachable. Used to decide
 * whether to attempt a pg_basebackup re-seed before promoting the standby.
 * Primary-dead failovers skip the re-seed (can't; best-effort promote).
 */
async function isPrimaryPostgresReady(primaryIp, sshKeyPath) {
  try {
    const pod = await getPostgresPod(primaryIp, sshKeyPath);
    const result = await sshKubectl(primaryIp, sshKeyPath, [
      'exec',
      '-n',
      'vibecarbon',
      pod,
      '--',
      'pg_isready',
      '-U',
      'postgres',
      '-t',
      '3',
    ]);
    return result?.includes('accepting connections') ?? false;
  } catch {
    return false;
  }
}

// getReplPasswordFromSecret + reseedStandbyFromPrimary + promoteStandby now live
// in src/lib/deploy/replication.js (finding #2 — shared with restore.js and the
// k8s deploy-time seed). They are imported at the top of this file. The perfTimer
// wrapper for promotion stays here since it is a failover-flow concern.

async function promoteStandbyDatabase(standbyIp, sshKeyPath) {
  const _t = perfTimer('failover.promoteStandby');
  try {
    return await promoteStandby(standbyIp, sshKeyPath);
  } finally {
    _t.end();
  }
}

/**
 * Re-seed the standby from the primary (when reachable) then promote it.
 * ABORTS the whole failover (throws) if the re-seed fails or the promotion
 * cannot be confirmed — we must NEVER scale down the old primary and flip DNS
 * onto a standby that was left half-seeded or is still in recovery. Brings the
 * k8s failover path to parity with compose (compose/ha.js hard-fails both).
 */
async function reseedAndPromoteOrAbort(servers, sshKeyPath, s) {
  // Step -1 (convergent-rerun guard): if the standby has ALREADY exited
  // recovery it was promoted by a prior (crashed mid-flow) run. Re-seeding now
  // would pg_basebackup OVER a promoted — possibly already-serving — database.
  // Skip re-seed + promote and let the rest of the flow re-converge idempotently.
  if (await isStandbyPromoted(servers.standby.ip, sshKeyPath)) {
    p.log.info('Standby already promoted, convergent rerun, skipping reseed + promote');
    return { alreadyPromoted: true };
  }

  // Step 0: Re-seed standby from primary — UNLESS the standby is already
  // verifiably streaming. A streaming standby is in-parity with the primary
  // (that is exactly what streaming replication guarantees), so a pre-promotion
  // pg_basebackup is wasted RTO — and worse, the standby's live walreceiver
  // holds the persistent replication slot, so a basebackup that tried to attach
  // to it would error "replication slot is active for PID …" (live RCA
  // compose-ha 2026-07-07; the reseed's basebackup now uses a temp slot, but
  // skipping entirely is still the right call for an already-streaming standby).
  // Prefer the STANDBY-side signal (pg_stat_wal_receiver): failover often runs
  // when the primary is unhealthy, and the standby can see its own receiver even
  // when the primary is unreachable.
  if (await isStandbyStreaming(servers.standby.ip, sshKeyPath)) {
    p.log.info(
      'Standby already streaming, skipping re-seed (parity guaranteed by streaming state)',
    );
  } else if (await isPrimaryPostgresReady(servers.primary.ip, sshKeyPath)) {
    s.start('Re-seeding standby from primary (pg_basebackup)');
    let result;
    try {
      // standby.supabaseIp: the node the standby db pod is pinned to — the
      // re-seed's node-side PGDATA swap ssh's there (roles are not yet swapped;
      // the re-seed runs BEFORE promotion, so the deploy-time gateway relay
      // directions still hold and the re-seed dials the standby's LOCAL
      // WireGuard relay — no primary IP needed, no gateway re-render).
      result = await reseedStandbyFromPrimary(servers.standby.ip, sshKeyPath, {
        standbySupabaseIp: servers.standby.supabaseIp,
        standbySupabasePrivateIp: servers.standby.supabasePrivateIp,
      });
    } catch (err) {
      s.stop('Re-seed failed, aborting failover');
      throw new Error(
        `Failover aborted before promotion: ${err.message}\n` +
          `The standby was NOT promoted and the old primary is untouched: no ` +
          `split-brain and no DNS flip. Resolve the issue (or redeploy the ` +
          `standby) and retry.`,
      );
    }
    s.stop(
      result === 'reseeded'
        ? 'Standby re-seeded with primary state'
        : 'Primary unreachable mid-probe, promoting standby with current state',
    );
  } else {
    p.log.warn('Primary unreachable, skipping re-seed, promoting standby with current state');
  }

  // Step 1: Promote standby database. A failure here is FATAL: continuing would
  // scale down the old primary and flip DNS onto a read-only standby.
  s.start('Promoting standby database');
  const promoted = await promoteStandbyDatabase(servers.standby.ip, sshKeyPath);
  if (!promoted) {
    s.stop('Promotion could not be confirmed, aborting failover');
    throw new Error(
      `Failover aborted: standby ${servers.standby.ip} did not exit recovery mode. ` +
        `Refusing to scale down the old primary or flip DNS onto an unpromoted ` +
        `standby (that would take the app read-only). Verify the standby db pod and retry.`,
    );
  }
  s.stop('Standby database promoted to primary');
}

/**
 * PLANNED-mode zero-data-loss gate: after the primary's app tier is quiesced
 * (no new customer writes) and BEFORE promotion, ensure the standby has
 * replayed every byte of WAL the primary held at quiesce time.
 *
 * Why: streaming ≠ caught-up. reseedAndPromoteOrAbort's streaming short-circuit
 * skips the pre-promote reseed for an already-streaming standby, but the WAL
 * records written just before quiesce may still be in flight — promoting then
 * would silently drop them, making "RPO zero" merely probabilistic. This gate
 * closes that window and is what upgrades planned switchover to a TRUE
 * zero-data-loss guarantee.
 *
 * Scope: only ENFORCED when the standby is STREAMING (the short-circuit path).
 * A non-streaming standby is reseeded downstream by a full pg_basebackup from
 * the quiesced primary, which copies everything — so the WAL-replay gate does
 * not apply and we return early rather than time out against a frozen replay
 * position.
 *
 * Which side we query: we capture the target ONCE on the PRIMARY (reachable by
 * definition in planned mode) via pg_current_wal_lsn(); after quiesce that
 * high-water mark is stable for customer writes. Then each poll runs a single
 * boolean query on the STANDBY (the node we are about to promote — guaranteed
 * reachable) comparing its live pg_last_wal_replay_lsn() to the captured target
 * with pg_wal_lsn_diff(...) >= 0 — one round-trip, freshest replay position. On
 * timeout we THROW so the caller's abort + un-quiesce path runs; a lagging
 * standby is never promoted.
 *
 * @param {{ primary: { ip: string }, standby: { ip: string } }} servers
 * @param {string} sshKeyPath
 * @param {{ attempts?: number, intervalMs?: number, deps?: { kubectl?: Function, getPostgresPod?: Function, isStreaming?: Function, sleep?: Function } }} [opts]
 * @returns {Promise<void>}
 */
export async function waitForStandbyCaughtUp(servers, sshKeyPath, opts = {}) {
  const { attempts = 30, intervalMs = 2000, deps = {} } = opts;
  const kubectl = deps.kubectl ?? sshKubectl;
  const getPod = deps.getPostgresPod ?? getPostgresPod;
  const streamingCheck = deps.isStreaming ?? isStandbyStreaming;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  // Only the streaming short-circuit needs this gate; a non-streaming standby
  // gets a full reseed downstream which is caught-up by construction.
  if (!(await streamingCheck(servers.standby.ip, sshKeyPath))) {
    p.log.info(
      'Standby not streaming, catch-up gate N/A (the downstream reseed copies all state).',
    );
    return;
  }

  // Capture the primary's WAL high-water mark ONCE, after quiesce.
  const primaryPod = await getPod(servers.primary.ip, sshKeyPath);
  const targetRaw = await kubectl(servers.primary.ip, sshKeyPath, [
    'exec',
    '-n',
    'vibecarbon',
    primaryPod,
    '--',
    'psql',
    '-U',
    'supabase_admin',
    '-tAc',
    'SELECT pg_current_wal_lsn()',
  ]);
  const target = (typeof targetRaw === 'string' ? targetRaw : '').trim();
  if (!/^[0-9A-Fa-f]+\/[0-9A-Fa-f]+$/.test(target)) {
    throw new Error(
      `Zero-data-loss gate: could not read the primary's WAL position before promote ` +
        `(got: ${target.slice(0, 80) || 'empty'}). Aborting failover.`,
    );
  }

  const standbyPod = await getPod(servers.standby.ip, sshKeyPath);
  let last = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let out = '';
    try {
      out = await kubectl(servers.standby.ip, sshKeyPath, [
        'exec',
        '-n',
        'vibecarbon',
        standbyPod,
        '--',
        'psql',
        '-U',
        'supabase_admin',
        '-tAc',
        `SELECT pg_wal_lsn_diff(pg_last_wal_replay_lsn(), '${target}') >= 0`,
      ]);
    } catch (err) {
      out = '';
      last = firstErrorLine(err);
    }
    const caughtUp = (typeof out === 'string' ? out : '').trim();
    if (caughtUp === 't') return; // standby replayed up to the primary's quiesce LSN
    last = caughtUp || last;
    if (attempt < attempts) await sleep(intervalMs);
  }
  throw new Error(
    `Zero-data-loss gate: standby did not replay the primary's final WAL (target ${target}) ` +
      `within ${Math.round((attempts * intervalMs) / 1000)}s (last: ${last || 'none'}). ` +
      `Aborting before promotion; the primary is un-quiesced and still serving.`,
  );
}

/**
 * Scale a list of deployments via SSH+kubectl, swallowing per-deployment
 * "not found" so one missing chart-name doesn't abort the whole failover.
 * Reports each result so the operator can see what actually scaled.
 *
 * Entries are the persisted scale-up list shape `{ name, namespace?, replicas }`
 * (Task 7). `namespace` defaults to `'vibecarbon'` (the cluster-autoscaler
 * entry lives in `kube-system`). `replicas` is either a fixed count — e.g. `0`
 * to quiesce/scale-down — or the literal string `'up'`, which scales EACH entry
 * to its OWN persisted `replicas` value (the deploy-rendered target, so a
 * multi-replica component comes back at its real count, not a hardcoded 1/2).
 *
 * @param {string} ip
 * @param {string} sshKeyPath
 * @param {Array<{ name: string, namespace?: string, replicas?: number }>} deployments
 * @param {number|'up'} replicas
 * @param {string} label
 */
async function scaleDeployments(ip, sshKeyPath, deployments, replicas, label) {
  for (const dep of deployments) {
    const ns = dep.namespace || 'vibecarbon';
    const target = replicas === 'up' ? (dep.replicas ?? 1) : replicas;
    try {
      await sshKubectl(ip, sshKeyPath, [
        'scale',
        'deployment',
        dep.name,
        '-n',
        ns,
        `--replicas=${target}`,
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "no objects passed to scale" / "deployments.apps not found" → log and continue.
      // Anything else (auth failure, network) we still want to surface.
      const isMissing = /not found|no objects passed/i.test(msg);
      if (isMissing) {
        p.log.warn(`${label}: ${dep.name} not found; skipped`);
      } else {
        p.log.warn(`${label}: ${dep.name} failed: ${msg.split('\n')[0]}`);
      }
    }
  }
}

// ============================================================================
// POST-PROMOTION READINESS GATE (product-side)
// ============================================================================

/**
 * Build the argv for a public-ingress probe against the promoted master. Uses
 * `--resolve <domain>:443:127.0.0.1` so the probe traverses the REAL public path
 * (traefik hostPort → kong/app) on the promoted node without waiting on DNS
 * propagation — the DNS A record was flipped moments ago and the test runner's
 * resolver may still be cached. Mirrors compose/ha.js newPrimaryApiProbeCmd.
 *
 * `anonKey` (when known) is sent as the `apikey` header: kong's declarative
 * config runs a key-auth plugin on `/auth/v1/*`, so a keyless probe gets 401
 * from kong before GoTrue is reached and the auth half of the gate can never
 * confirm (2026-07-08 matrix: every k8s failover burned the full 300s budget
 * on "last auth=401"). Harmless on the un-gated app routes.
 */
export function promotedProbeArgv(domain, path, anonKey) {
  return [
    'curl',
    '-sk',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    '--max-time',
    '5',
    '--resolve',
    `${domain}:443:127.0.0.1`,
    ...(anonKey ? ['-H', `apikey: ${anonKey}`] : []),
    `https://${domain}${path}`,
  ];
}

/**
 * Read the anon key from the promoted cluster's own `vibecarbon-secrets`
 * Secret (the same key the app pods consume). Sourced from the cluster rather
 * than the local .env so failover works from any operator machine with SSH
 * access, even if the local project files drifted. Best-effort: returns ''
 * on any failure — the probe then runs keyless and the gate soft-fails
 * exactly as before, it just can't confirm the auth path.
 */
export async function getPromotedAnonKey(ip, sshKeyPath, opts = {}) {
  const { kubectl = sshKubectl } = opts;
  try {
    const b64 = await kubectl(
      ip,
      sshKeyPath,
      [
        'get',
        'secret',
        'vibecarbon-secrets',
        '-n',
        'vibecarbon',
        '-o',
        'jsonpath={.data.ANON_KEY}',
      ],
      // 15s cap (not sshRun's 120s default): this runs mid-failover against a
      // possibly-sick apiserver, and a slow secret read must not stall the
      // gate — '' falls back to a keyless probe.
      { silent: true, timeout: 15_000 },
    );
    const raw = typeof b64 === 'string' ? b64.trim() : '';
    if (!raw) return '';
    return Buffer.from(raw, 'base64').toString('utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Poll the promoted cluster's public API until it actually SERVES — the app
 * health endpoint (/api/health), an auth-path endpoint (/auth/v1/health), AND
 * the storage health endpoint (/storage/v1/status) all return 200 within a
 * budget (k8s path-based routing → kong → gotrue/storage-api).
 *
 * This is the k8s mirror of compose/ha.js waitForNewPrimaryApi: `vibecarbon
 * failover` returns via the skip-if-streaming fast path in ~44s (promotion ~9s),
 * but the promoted cluster's supabase services then spend a window
 * restarting/reconnecting — auth 502s and PostgREST serves schema-cache misses
 * against the (present!) tables. failover used to report "complete" straight
 * into that window and verify-failover (which does not retry) caught it.
 *
 * Storage is part of the gate since 2026-08-19 (DO run 32309395314): the
 * compose sibling proved rest only and verify's single-shot upload met Kong's
 * 502 while storage-api was still replaying its boot-time DB migrations — the
 * slowest riser of the restarted tier. This gate had the same
 * one-service-short premise. /storage/v1/status is key-auth'd at kong, so the
 * probe rides the same anonKey the auth probe already needs.
 *
 * Best-effort, matching compose: returns false + a LOUD warning on timeout
 * rather than throwing — a not-yet-confirmed promoted API is still better than
 * failing a promotion + DNS flip that already succeeded.
 */
export async function waitForPromotedApiServing(domain, ip, sshKeyPath, opts = {}) {
  const {
    budgetMs = 300_000,
    runner = sshRun,
    poll = pollUntil,
    healthPath = '/api/health',
    authPath = '/auth/v1/health',
    storagePath = '/storage/v1/status',
    anonKey = '',
    initialDelayMs = 3000,
    maxDelayMs = 15_000,
  } = opts;
  let last = '';
  const codeOf = async (path) => {
    const out = await runner(ip, sshKeyPath, promotedProbeArgv(domain, path, anonKey), {
      silent: true,
      timeout: 12_000,
    });
    return typeof out === 'string' ? out.trim() : '';
  };
  const probe = async () => {
    const health = await codeOf(healthPath);
    if (health !== '200') {
      last = `health=${health || 'none'}`;
      return false;
    }
    const auth = await codeOf(authPath);
    if (auth !== '200') {
      last = `auth=${auth || 'none'}`;
      return false;
    }
    const storage = await codeOf(storagePath);
    if (storage !== '200') {
      last = `storage=${storage || 'none'}`;
      return false;
    }
    return true;
  };
  try {
    await poll(probe, {
      budgetMs,
      initialDelayMs,
      maxDelayMs,
      description: `promoted API to serve ${domain} (health + auth + storage)`,
    });
    return true;
  } catch {
    p.log.warn(
      `Promoted API not confirmed serving (last ${last || 'none'}) within ` +
        `${Math.round(budgetMs / 1000)}s, proceeding, but verify-failover may race API readiness`,
    );
    return false;
  }
}

/**
 * Post-promotion readiness gate for the k8s failover paths. Runs AFTER the
 * promoted app tier is scaled up: rollout-status-waits EACH persisted scale-up
 * entry (so "Failover complete" means the freshly-scaled deployments actually
 * rolled out on the just-provisioned workers), then gates on the public API
 * actually serving.
 *
 * The scale-up already recreated the pods against the promoted (writable) db, so
 * a separate rollout-RESTART is no longer needed — the fresh pods open their
 * pools against the primary from the start. We only wait for those rollouts to
 * settle. Per-deployment failures are logged + swallowed (best-effort): a
 * missing/hung chart name must not sink a promotion that already happened.
 *
 * RTO note: this gate trades a few minutes of REPORTED failover time for a
 * true-when-reported signal. It is best-effort (loud warning, never throws): the
 * promotion already happened, so a slow API is a readiness delay, not an abort.
 *
 * @param {string} domain
 * @param {string} promotedIp
 * @param {string} sshKeyPath
 * @param {{ start: Function, stop: Function }} s
 * @param {{ scaleUpList?: any[], kubectl?: Function, runner?: Function }} [opts]
 */
export async function gatePromotedApiReadiness(domain, promotedIp, sshKeyPath, s, opts = {}) {
  const { scaleUpList = [], kubectl = sshKubectl, runner = sshRun } = opts;

  s.start('Waiting for the promoted app tier to roll out');
  // Roll out every deployment IN PARALLEL. Serially, this gate waits up to
  // ~11 deployments × 130s ≈ 24 min in the worst case — enough to blow the e2e
  // failover step budget on its own. Each rollout-status keeps its own
  // best-effort swallow (a stuck/missing chart name must not sink a promotion
  // that already happened) so Promise.all never rejects, and its own client-cap
  // timeout per call. The deleted restartPromotedPostgresDependents fanned out
  // exactly like this.
  await Promise.all(
    scaleUpList.map(async (dep) => {
      const ns = dep.namespace || 'vibecarbon';
      try {
        // 120s server-side inside a 130s client cap: the kubectl --timeout must
        // sit INSIDE the SSH client timeout or the client kills the connection
        // first and the kubectl error (which names the stuck deployment) never
        // surfaces (sshRun's default cap is 120s).
        await kubectl(
          promotedIp,
          sshKeyPath,
          ['rollout', 'status', `deployment/${dep.name}`, '-n', ns, '--timeout=120s'],
          { timeout: 130_000 },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        p.log.warn(`rollout status promoted: ${dep.name} did not settle: ${msg.split('\n')[0]}`);
      }
    }),
  );
  s.stop('Promoted app tier rolled out (best-effort)');

  if (!domain) {
    p.log.warn('No domain configured, skipping public API readiness probe');
    return;
  }
  // The auth probe is kong-key-gated (see promotedProbeArgv); without the
  // anon key the gate can never confirm and always times out.
  const anonKey = await getPromotedAnonKey(promotedIp, sshKeyPath, { kubectl });
  if (!anonKey) {
    p.log.warn('Could not read ANON_KEY from the promoted cluster, auth probe will run keyless');
  }
  s.start('Waiting for promoted API to serve (health + auth)');
  const ready = await waitForPromotedApiServing(domain, promotedIp, sshKeyPath, {
    anonKey,
    runner,
  });
  s.stop(
    ready
      ? 'Promoted API serving (health + auth 200)'
      : 'Promoted API not confirmed, proceeding (see warning)',
  );
}

// ============================================================================
// PILOT-LIGHT FAILOVER: PREFLIGHT + STANDBY WORKER PROVISIONING
// ============================================================================

/**
 * Distinct failover-abort type raised when standby worker provisioning fails
 * (converge threw, or the workers never registered Ready). Task 10's failover
 * flow catches THIS specifically — an AbortProvisioningError means the primary
 * was never touched (provisioning is the first, capacity-adding step) and the
 * standby was best-effort converged back to 0 workers, so the flow must stop
 * before promote/scale/DNS. `logLines` carries the exact operator-facing lines
 * (mirrors convergeClusterInfra's abort convention) so a caller can replay
 * them; `cause` is the underlying provisioning error.
 */
export class AbortProvisioningError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown, logLines?: string[] }} [opts]
   */
  constructor(message, { cause, logLines } = {}) {
    super(message);
    this.name = 'AbortProvisioningError';
    if (cause !== undefined) this.cause = cause;
    this.logLines = Array.isArray(logLines) && logLines.length ? logLines : [message];
  }
}

/** First line of an Error/string — matches convergeClusterInfra's log shaping. */
function firstErrorLine(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return (msg ?? '').split('\n')[0];
}

/**
 * Reconstruct the s3Config the deploy used so a Pulumi state-backend read hits
 * the same bucket. Mirrors convergeClusterInfra's reconstruction (envConfig.s3
 * + resolved creds). Returns undefined when this env has no S3 backend (falls
 * back to the local file:// backend inside the iac layer).
 */
function buildStateS3Config(envConfig, s3Creds) {
  if (!envConfig.s3?.bucket || !s3Creds) return undefined;
  return {
    bucket: envConfig.s3.bucket,
    region: envConfig.s3.region,
    endpoint: envConfig.s3.endpoint,
    stateBucket: envConfig.s3.stateBucket,
    accessKey: s3Creds.accessKey,
    secretKey: s3Creds.secretKey,
  };
}

/**
 * Resolve the compute + object-storage credentials the IaC converge seam needs,
 * ONCE per provisioning flow. Reused for the up converge, the revert converge
 * (s3Creds threaded in so convergeClusterInfra never re-prompts), and the
 * leftover-state summary on a failed revert. Mirrors scale.js's resolution:
 * provider class via providerFor(), token via resolveProviderToken (the same
 * path failover's firewall step uses), S3 creds via
 * Provider.promptObjectStorageCredentials (env-first — see
 * getS3Credentials — so the interactive prompt only fires when truly absent).
 */
async function resolveConvergeCreds({ envConfig, projectConfig }) {
  const Provider = providerFor(envConfig);
  const apiToken = resolveProviderToken(providerIdFor(envConfig));
  const s3Creds = envConfig.s3?.bucket
    ? await Provider.promptObjectStorageCredentials(projectConfig.projectName, { save: false })
    : null;
  return { Provider, apiToken, s3Creds };
}

/**
 * Bind the hardened IaC converge seam (convergeClusterInfra) with the resolved
 * provider/token/creds. Dynamic import keeps @pulumi out of failover.js's
 * static-load graph (this module otherwise takes no top-level iac import).
 */
async function makeDefaultConverge(creds) {
  const { convergeClusterInfra } = await import('./lib/iac/converge-cluster.js');
  return (args) =>
    convergeClusterInfra({
      ...args,
      Provider: creds.Provider,
      apiToken: creds.apiToken,
      s3Creds: creds.s3Creds,
    });
}

/**
 * Best-effort read of the standby stack's current outputs so a failed revert
 * can tell the operator how much capacity leaked. Never throws — returns a
 * short summary line, or [] on any backend/parse failure.
 */
async function summarizeStandbyStack({ envConfig, standbyStack, creds, projectName }) {
  try {
    const { getStackOutputs } = await import('./lib/iac/index.js');
    const outputs = await getStackOutputs(standbyStack, async () => ({}), {
      provider: providerIdFor(envConfig),
      providerToken: creds.apiToken,
      s3Config: buildStateS3Config(envConfig, creds.s3Creds),
      projectName,
    });
    const workerIps = Array.isArray(outputs?.workerIps) ? outputs.workerIps : [];
    return [`Stack ${standbyStack} currently reports ${workerIps.length} worker node(s).`];
  } catch {
    return [];
  }
}

/**
 * Fire-and-forget supabase-image pre-pull on the standby nodes right after the
 * new workers register Ready. Overlaps the app-tier scale-up (Task 10) so
 * kubelet finds images already present. Best-effort by contract — every failure
 * degrades to on-demand pulls. Only the standby cluster's nodes are targeted.
 */
async function prePullStandbyImages({ servers, envName, workerIps }) {
  const { prePullChartImages } = await import('./lib/deploy/k8s/k3s.js');
  const { knownHostsPath } = await import('./lib/host-keys.js');
  const nodeIps = [servers.standby.ip, servers.standby.supabaseIp, ...(workerIps ?? [])].filter(
    Boolean,
  );
  return prePullChartImages({
    nodeIps,
    sshKeyPath: getSSHKeyPath(envName),
    khPath: knownHostsPath(envName),
  });
}

/**
 * Preflight the pilot-light failover: verify the deploy-time config the
 * provisioning step depends on is present, then probe the standby stack's state
 * backend so we fail BEFORE mutating anything if the backend is unreachable or
 * the stack is missing.
 *
 * Exits 1 (config absent) or 1 (backend unreachable) — the two hard blockers a
 * pilot-light failover cannot recover from. Returns the persisted pieces the
 * caller needs on success. NOTHING is mutated on any path.
 *
 * @param {string} _envName  Reserved for the caller contract (Task 10 passes
 *   the env name positionally); the probe reads everything it needs from
 *   envConfig + the on-disk project config.
 * @param {object} envConfig
 * @param {{ resolveCreds?: Function, readStackOutputs?: Function }} [deps]  Test
 *   seams; default to the real cred resolver + iac getStackOutputs.
 * @returns {Promise<{ workerSpec: {count:number, serverType:string}, scaleUpList: any[], standbyStack: string, creds: any }>}
 *   `creds` is the ONCE-resolved provider/token/S3 bundle — the caller threads
 *   it into provisionStandbyCapacity so an operator without a creds file is
 *   prompted at most once per failover (Task 9 review finding #1).
 */
export async function preflightPilotFailover(_envName, envConfig, deps = {}) {
  const { resolveCreds = resolveConvergeCreds, readStackOutputs } = deps;
  const ha = envConfig.ha ?? {};
  const workerSpec = ha.standbyWorkerSpec;
  const scaleUpList = ha.scaleUpList;
  const standbyStack = ha.standby?.stack;

  // Config-presence gate: these are written by `vibecarbon deploy` (Task 7).
  // Their absence means this env predates pilot-light HA (or was hand-edited) —
  // there is nothing to provision or scale, so fail fast with a fix-it hint.
  if (!workerSpec || !Array.isArray(scaleUpList) || !standbyStack) {
    p.log.error('Pilot-light failover config missing — run `vibecarbon deploy` first');
    process.exit(1);
  }

  // Backend-reachability probe: reading the standby stack's outputs touches the
  // exact state backend the provisioning converge will drive. A throw here means
  // the backend is unreachable or the stack is missing — surface it now, before
  // any capacity is added. `creds` is resolved HERE (once) and returned.
  const s = spinner();
  s.start(`Verifying standby stack state (${standbyStack})`);
  let creds;
  let standbyOutputs;
  try {
    const projectConfig = loadProjectConfig();
    creds = await resolveCreds({ envConfig, projectConfig });
    const getStackOutputs =
      readStackOutputs ?? (await import('./lib/iac/index.js')).getStackOutputs;
    standbyOutputs = await getStackOutputs(standbyStack, async () => ({}), {
      provider: providerIdFor(envConfig),
      providerToken: creds.apiToken,
      s3Config: buildStateS3Config(envConfig, creds.s3Creds),
      projectName: projectConfig.projectName,
    });
    s.stop(`Standby stack state reachable (${standbyStack})`);
  } catch (err) {
    s.stop('Standby stack state unreachable');
    p.log.error(
      `Could not read standby stack '${standbyStack}' from the state backend ` +
        `(${firstErrorLine(err)}). The backend is unreachable or the stack is ` +
        `missing, nothing was changed.`,
    );
    process.exit(1);
  }

  // The probe read doubles as a freshness source: the outputs are the LIVE
  // infra truth (private IPs are DHCP-assigned on DO and rot across node
  // replacement), so surface them for the caller to prefer over the
  // deploy-time persisted snapshot.
  return { workerSpec, scaleUpList, standbyStack, creds, standbyOutputs: standbyOutputs ?? {} };
}

/**
 * Bring the pilot-light standby cluster's worker floor 0→N through the hardened
 * IaC converge seam, then wait for those nodes to register Ready. This is the
 * ONLY step in a pilot-light failover that adds cloud capacity, and it runs
 * FIRST — so on ANY failure (converge throw or workers-never-Ready) the still-
 * serving primary is untouched. On failure it best-effort converges the standby
 * back to 0 workers and throws AbortProvisioningError; if the revert ALSO fails
 * it reports the leftover state (stack name + cleanup command) before throwing.
 *
 * @param {object} args
 * @param {string} args.envName
 * @param {object} args.envConfig
 * @param {object} args.projectConfig
 * @param {{ standby: { ip: string, supabaseIp?: string } }} args.servers
 * @param {{ count: number, serverType: string }} args.workerSpec  Persisted spec.
 * @param {string|null} [args.serverTypeOverride]  `-server-type` — wins over spec.
 * @param {{ converge?: Function, kubectl?: Function, sleep?: Function, creds?: any }} [args.deps]
 *   `deps.creds` is the preflight-resolved provider/token/S3 bundle, threaded in
 *   so this step never re-prompts for object-storage credentials (Task 9 review
 *   finding #1 — an operator without a creds file is prompted at most once).
 * @returns {Promise<{ provisioned: true }>}
 */
export async function provisionStandbyCapacity(args) {
  const _t = perfTimer('failover.provisionWorkers');
  try {
    return await _provisionStandbyCapacityImpl(args);
  } finally {
    _t.end();
  }
}

async function _provisionStandbyCapacityImpl({
  envName,
  envConfig,
  projectConfig,
  servers,
  workerSpec,
  serverTypeOverride,
  deps = {},
}) {
  const standbyStack = envConfig.ha?.standby?.stack;
  const clusterRegion = envConfig.ha?.standby?.region;
  const count = workerSpec.count;
  const serverType = serverTypeOverride || workerSpec.serverType;

  // The standby's region-resolved master/supabase types persisted at deploy
  // (may differ from the primary's when the standby region doesn't stock the
  // same SKU). Pinning them on EVERY converge (the up AND the
  // 0-worker revert) keeps buildProgramConfig's current-type slots matched to
  // the standby's reality, so the converge never plans an in-place resize
  // (reboot) of the standby's master/db node mid-failover. Undefined on envs
  // that predate this persist → falls back to envConfig, matching prior behavior.
  const standbyMasterType = envConfig.ha?.standby?.masterServerType;
  const standbySupabaseType = envConfig.ha?.standby?.supabaseServerType;

  // Architecture gate on every type that will actually reach Pulumi.
  // `-server-type` was already checked in run(); what this adds is the three
  // PERSISTED types — the worker spec plus the two standby node types read
  // just above — each of which reaches Pulumi verbatim (converge →
  // buildProgramConfig) without passing any filtered option list. On an env
  // deployed before the x86-64 standardization those are the only ways an ARM
  // SKU can still reach real hardware, so all three are asserted: the stated
  // invariant is "no ARM type reaches Pulumi", and guarding one of three paths
  // would only hold because the worker guard happens to fire first on a
  // uniformly-ARM environment. A hand-mixed config (x86 workers, ARM master)
  // would sail through.
  //
  // It rejects rather than rescuing, and it rejects HERE — before the converge
  // seam is even resolved — so this throw provisions nothing and has nothing to
  // revert. The alternative was to silently substitute an x86 SKU
  // (HetznerProvider.resolveServerTypeForRegion still can, for the deploy-time
  // standby fan-out), but a DR action is exactly where a silent substitution is
  // worst: the failover would go on to quiesce the primary and promote the
  // standby database (steps 2-3) and only then discover, at "wait for the
  // promoted API to serve", that the amd64 app image cannot exec on arm64 nodes.
  // That converts a recoverable abort into an unrecoverable one — the old site
  // torn down, the new one unable to serve.
  //
  // Only the worker path has a one-flag escape hatch. `-server-type` overrides
  // the worker type and nothing else, so an ARM standby master or database node
  // has no mid-outage workaround — it already exists as arm64 hardware and
  // Hetzner cannot rescale across architectures. Say so rather than pointing at
  // a flag that would not help.
  const Provider = providerFor(envConfig);
  const guardedTypes = [
    {
      type: serverType,
      role: 'standby worker',
      source: serverTypeOverride
        ? '-server-type'
        : '.vibecarbon.json ha.standbyWorkerSpec.serverType',
      // The worker type is the one `-server-type` overrides, so a re-run with
      // an x86 value unblocks this path whichever source it came from.
      flagFixable: true,
    },
    {
      type: standbyMasterType,
      role: 'standby master',
      source: '.vibecarbon.json ha.standby.masterServerType',
      flagFixable: false,
    },
    {
      type: standbySupabaseType,
      role: 'standby database',
      source: '.vibecarbon.json ha.standby.supabaseServerType',
      flagFixable: false,
    },
  ];
  for (const { type, role, source, flagFixable } of guardedTypes) {
    try {
      Provider.assertAmd64ServerType(type, source);
    } catch (err) {
      const suggestion = Provider.armToAmd64Equivalent(type);
      const logLines = [
        firstErrorLine(err),
        flagFixable
          ? `Re-run with an explicit x86 worker type: ` +
            `\`vibecarbon failover ${envName} -server-type ${suggestion}\` ` +
            `(${suggestion} meets or exceeds ${type}'s vCPU and RAM).`
          : `\`-server-type\` cannot unblock this one; it overrides the standby ` +
            `WORKER type only, and the ${role} node already exists on arm64 ` +
            `hardware. Its x86 equivalent is ${suggestion} (meets or exceeds ` +
            `${type}'s vCPU and RAM), but that is a replacement, not a resize.`,
        `Servers cannot be rescaled across architectures, so the permanent fix is to ` +
          `replace this environment's nodes: deploy fresh on x86 types and ` +
          `\`vibecarbon restore\` from a backup. See docs/deploy-${providerIdFor(envConfig)}.md ` +
          `("x86-64 only").`,
      ];
      for (const line of logLines) p.log.error(line);
      throw new AbortProvisioningError(`Failover aborted: ${role} type '${type}' is not amd64.`, {
        cause: err,
        logLines,
      });
    }
  }

  // Resolve the converge seam. Default = the hardened IaC converge bound with
  // this env's provider/token/creds, reused for BOTH the up and the revert
  // (s3Creds threaded in → convergeClusterInfra never re-prompts). The creds are
  // resolved ONCE per failover in preflight and threaded in as deps.creds — so
  // an operator without a creds file is prompted at most once (finding #1). We
  // fall back to resolving here only if the caller didn't thread them. Tests
  // inject deps.converge (and skip all cred resolution / real Pulumi).
  let creds = deps.creds ?? null;
  let converge = deps.converge;
  if (!converge) {
    if (!creds) creds = await resolveConvergeCreds({ envConfig, projectConfig });
    converge = await makeDefaultConverge(creds);
  }

  const convergeArgs = (overrides) => ({
    projectConfig,
    envConfig,
    clusterEnv: standbyStack,
    clusterRegion,
    environment: envName,
    isHA: true,
    // DR-flavored abort wording (the converge module defaults to 'scale').
    action: 'failover',
    // Pin the standby's resolved master/supabase types on both the up and the
    // revert (see standbyMasterType/standbySupabaseType above). The per-call
    // overrides (minWorkers/workerServerType) win when spread last.
    overrides: {
      ...(standbyMasterType ? { masterServerType: standbyMasterType } : {}),
      ...(standbySupabaseType ? { supabaseServerType: standbySupabaseType } : {}),
      ...overrides,
    },
    label: standbyStack,
  });

  try {
    const up = await converge(convergeArgs({ minWorkers: count, workerServerType: serverType }));

    // Gate on the freshly-provisioned workers registering Ready before the
    // caller scales the app tier onto them.
    await waitForWorkersReady(servers.standby.ip, getSSHKeyPath(envName), count, { deps });

    // Best-effort image pre-pull on the standby nodes, overlapping Task 10's
    // app scale-up. Never awaited into the failover critical path; every
    // failure degrades to kubelet on-demand pulls. Skipped when deps.converge
    // is injected (unit tests) — there are no real nodes to reach.
    if (!deps.converge) {
      try {
        prePullStandbyImages({
          servers,
          envName,
          workerIps: up?.outputs?.workerIps,
        }).catch(() => {});
      } catch {
        /* fire-and-forget — a synchronous setup slip must not sink provisioning */
      }
    }

    return { provisioned: true };
  } catch (err) {
    // Generic abort: ANY provisioning failure converges the standby back to 0
    // workers (the primary is still serving and was never touched), then aborts.
    const cause = firstErrorLine(err);
    const revertNotice =
      `Provisioning failed (${cause}). Converging the standby back to 0 workers, ` +
      `the primary is untouched.`;
    p.log.warn(revertNotice);
    const logLines = [revertNotice];

    try {
      await converge(convergeArgs({ minWorkers: 0 }));
      p.log.info('Standby converged back to 0 workers; no leftover capacity.');
    } catch (revertErr) {
      // Revert ALSO failed — capacity may be stranded. Report the stack + the
      // exact commands to finish the cleanup. Best-effort state summary (real
      // path only; creds is null when a test injects deps.converge).
      const revCause = firstErrorLine(revertErr);
      const summary = creds
        ? await summarizeStandbyStack({
            envConfig,
            standbyStack,
            creds,
            projectName: projectConfig.projectName,
          })
        : [];
      const leftover = [
        `Revert to 0 workers FAILED (${revCause}).`,
        ...summary,
        `Leftover workers may exist in stack ${standbyStack}; re-run ` +
          `\`vibecarbon failover ${envName}\` (optionally with \`-server-type <id>\`) ` +
          `or \`vibecarbon destroy ${envName}\` to clean up.`,
      ];
      for (const line of leftover) p.log.error(line);
      logLines.push(...leftover);
    }

    throw new AbortProvisioningError(
      `Failover aborted: standby worker provisioning failed (${cause}).`,
      { cause: err, logLines },
    );
  }
}

/**
 * Poll the standby master's node list until at least `count` worker nodes are
 * Ready, or the budget is exceeded. A worker row is a `kubectl get nodes`
 * line containing `-worker-` (the Pulumi-assigned worker node name segment) and
 * a standalone `Ready` status. Returns the Ready worker count on success;
 * throws once the budget elapses.
 *
 * deps.kubectl (argv) => stdout and deps.sleep (ms) => Promise are injected by
 * tests so no SSH runs and no real 10s waits elapse.
 *
 * @param {string} masterIp
 * @param {string} sshKeyPath
 * @param {number} count
 * @param {{ budgetMs?: number, deps?: { kubectl?: Function, sleep?: Function } }} [opts]
 * @returns {Promise<number>}
 */
export async function waitForWorkersReady(
  masterIp,
  sshKeyPath,
  count,
  { budgetMs = 600_000, deps = {} } = {},
) {
  const kubectl = deps.kubectl ?? ((argv) => sshKubectl(masterIp, sshKeyPath, argv));
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + budgetMs;
  for (;;) {
    let out = '';
    try {
      out = await kubectl(['get', 'nodes', '--no-headers']);
    } catch {
      out = '';
    }
    const ready = (typeof out === 'string' ? out : '')
      .split('\n')
      .filter((l) => l.includes('-worker-') && /\bReady\b/.test(l)).length;
    if (ready >= count) return ready;
    if (Date.now() > deadline) {
      throw new Error(
        `standby workers not Ready: ${ready}/${count} after ${Math.round(budgetMs / 1000)}s`,
      );
    }
    await sleep(10_000);
  }
}

// ============================================================================
// FAILOVER: HA (shared core; per-DNS-provider strategy)
// ============================================================================

/**
 * Per-DNS-provider strategy for the k8s HA failover, derived from the
 * DNS_PROVIDERS registry. The promote / scale / health / readiness core
 * (failoverHA below) is identical across providers — only the DNS flip
 * differs:
 *   - getAuth: resolve the provider API token (env var → prompt;
 *     prompt-cancel exits 0) and zone id. Absent for manual DNS.
 *   - updateDns: flip apex + wildcard A records to the promoted IP via the
 *     backend's upsertApexAndWildcard (each backend keeps its own wire
 *     details — Cloudflare's proxied:false RCA, Hetzner's ttl:60). Absent
 *     for manual DNS — the epilogue prints instructions instead.
 *
 * The token prompt is deliberately NOT the provider's guided-setup module
 * (B2): those show multi-step onboarding guides, verify tokens against the
 * API, and offer persistence — deploy-flow UX that doesn't fit an
 * active-incident failover, where the prompt must stay minimal and fast.
 * Operators who want zero prompts set the row's tokenEnv in the shell or
 * the project's .env.local ahead of time (`vibecarbon configure` →
 * Providers). No compute token is in scope here (failover is DNS-only), so
 * resolveDnsToken resolves env-first — for native DNS that env var IS the
 * compute credential, so it's normally already present.
 */
function dnsStrategyFor(dnsProvider) {
  const row = DNS_PROVIDERS[dnsProvider];
  return {
    async getAuth(envConfig) {
      let token = resolveDnsToken(dnsProvider, {
        computeProviderId: providerIdFor(envConfig),
        computeToken: undefined,
      });
      if (!token) {
        token = await p.text({
          message: `${row.name} API token:`,
          validate: (v) => (!v ? 'Required' : undefined),
        });
        if (p.isCancel(token)) {
          exitCancelled();
        }
        // In-process coherence (A2): make the freshly-entered token visible
        // to any later env-first resolution in this same failover run.
        process.env[row.tokenEnv] = token;
      }
      return { token, zoneId: envConfig.dns.zoneId };
    },
    async updateDns(auth, domain, ip) {
      const dns = await getDnsProvider(dnsProvider);
      return dns.upsertApexAndWildcard(auth, domain, ip);
    },
  };
}

/** Manual DNS: no auth, no flip — failoverHA prints the epilogue instead. */
const MANUAL_DNS_STRATEGY = {};

/**
 * Persist the post-failover role swap — the SINGLE terminal write that lets a
 * later `vibecarbon deploy` converge the recovered ex-primary to pilot-light
 * (Task 6's role reconciler reads ha.{primary,standby}.stack as the role↔stack
 * map, so this write is what points a redeploy at the right clusters).
 *
 * Swaps ha.primary↔ha.standby WHOLESALE — the objects carry their own stack +
 * region + IP fields, which ride along — and the top-level region↔secondaryRegion.
 * Flags the env `replication: 'degraded'` / `degraded: true`: honest until a
 * reconverge deploy re-establishes streaming from the NEW primary. The
 * role-agnostic pilot config (standbyWorkerSpec, scaleUpList) is preserved
 * untouched — it describes whatever cluster is currently the standby.
 *
 * Loads a FRESH project config (never a stale in-memory envConfig — the deploy
 * paths save mid-flight) and saves via saveProjectConfig. Exported for tests.
 *
 * @param {string} envName
 */
export function swapHaRoles(envName) {
  const config = loadProjectConfig();
  const envConfig = config?.environments?.[envName];
  if (!envConfig?.ha?.primary || !envConfig.ha.standby) {
    // Nothing structured to swap. The promotion + DNS flip already happened, so
    // warn rather than throw — a role reconcile just can't be persisted here.
    p.log.warn('Could not persist role swap, ha.primary/standby missing from config');
    return;
  }
  const ha = envConfig.ha;
  // Swap the role objects wholesale (stack / region / IP fields ride along).
  [ha.primary, ha.standby] = [ha.standby, ha.primary];
  // Swap the top-level regions to match the new primary / standby.
  [envConfig.region, envConfig.secondaryRegion] = [envConfig.secondaryRegion, envConfig.region];
  // failoverRegion tracks the standby's region — keep it consistent.
  ha.failoverRegion = envConfig.secondaryRegion;
  // Honest DR posture until a reconverge deploy re-establishes streaming.
  envConfig.replication = 'degraded';
  envConfig.degraded = true;
  saveProjectConfig(config);
}

/**
 * Move the wal-g WRITE-GUARD onto the cluster this failover just promoted, and
 * PROVE it took — see src/lib/deploy/walg-role.js for why nothing else does.
 *
 * On k8s, `WALG_ROLE` is rendered into the supabase-db container env at helm
 * install time and the backup CronJob has none of its own: it `kubectl exec`s
 * into the db pod and INHERITS it. So a promoted cluster that still reads
 * `standby` skips every base backup, and — once the k8s copy of wal-archive.sh
 * carries the same write-guard as the compose copy — every WAL segment too.
 * `kubectl set env` rewrites the StatefulSet, the resulting roll is what makes
 * the new value visible to postgres, and the rollout wait is what makes the
 * audit that follows read the NEW pod rather than the old one.
 *
 * Returns rather than throws, for the same reason the compose sibling does: the
 * standby is already promoted, so aborting here would strand it behind un-flipped
 * DNS. The caller finishes the failover and fails the command at the end.
 *
 * @param {object} args
 * @param {string} args.promotedIp    the promoted cluster's master (old standby)
 * @param {string} args.oldPrimaryIp  demoted best-effort; may be unreachable
 * @param {string} args.sshKeyPath
 * @param {object} [args.deps] injected seams for unit tests
 * @returns {Promise<{ok: boolean, error?: Error}>}
 */
export async function restorePromotedWalgRole({ promotedIp, oldPrimaryIp, sshKeyPath, deps = {} }) {
  const {
    kubectl = (ip, argv, opts) => sshKubectl(ip, sshKeyPath, argv, opts),
    audit = assertWalgBackupsWorking,
    log = (msg) => p.log.info(msg),
    warn = (msg) => p.log.warn(msg),
  } = deps;

  try {
    await kubectl(promotedIp, k8sSetWalgRoleArgv('primary'));
    // Blocks on the pod actually rolling. Budget sits just above the kubectl
    // --timeout so the remote command reports the rollout failure rather than
    // the SSH layer reporting a timeout with no detail.
    await kubectl(promotedIp, k8sDbRolloutStatusArgv(300), { timeout: 330_000 });
    // requirePrimary: the ONLY reason this audit is here is to catch a promoted
    // node still reading `standby`, which the deploy-time probe treats as a
    // legitimate skip.
    await audit({
      path: 'k8s',
      context: 'failover',
      probe: async () => {
        const out = await kubectl(
          promotedIp,
          k8sWalgAuditArgv(undefined, { requirePrimary: true }),
          { timeout: WALG_AUDIT_PROBE_TIMEOUT_MS },
        );
        return typeof out === 'string' ? out : '';
      },
    });
    log(
      `[walg-role] promoted cluster ${promotedIp} is archiving (WALG_ROLE=primary, audit passed).`,
    );
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }

  // Demote the old primary so the two clusters never write the same canonical
  // WAL prefix at once. Best-effort by design (an unreachable old primary is
  // the usual reason to fail over) and NOT waited on: nothing downstream reads
  // it, and the StatefulSet write is what carries the intent.
  //
  // Safe to do here, unlike on compose, because the old primary's app tier is
  // never serving at this point: a PLANNED failover quiesced it to zero before
  // the promotion, and an UNPLANNED one is running precisely because its
  // postgres stopped answering. So the roll this triggers on its db pod has no
  // live traffic to disturb.
  try {
    await kubectl(oldPrimaryIp, k8sSetWalgRoleArgv('standby'), { timeout: 60_000 });
    log(`[walg-role] old primary ${oldPrimaryIp} demoted to the standby write-guard.`);
  } catch (err) {
    warn(
      `Could not demote the old primary's wal-g write-guard (${oldPrimaryIp}): ${err.message}. ` +
        `If it comes back up it may archive into the same backup prefix as the new primary, ` +
        `\`vibecarbon deploy\` fixes this when it converges the ex-primary to pilot-light.`,
    );
  }
  return { ok: true };
}

/**
 * Pilot-light HA failover core (shared across DNS-provider strategies). Order:
 *   1. preflight (verify persisted config + probe standby state backend)
 *   2. provision standby worker capacity 0→N          (abort = clean exit)
 *   3. quiesce primary app tier                        (planned only)
 *   4. re-seed + promote standby                       (abort = un-quiesce + throw)
 *   5. scale up promoted app tier
 *   6. readiness gate (rollout-status each + public API probe)
 *  6b. scale down old primary                          (unplanned only, best-effort)
 *   7. DNS flip, then TERMINAL persist of the role swap
 *
 * All step seams default to the real implementations and are overridable via
 * `deps` for unit tests (the closure-injection pattern) so no ssh / iac / config
 * write runs under test.
 */
export async function failoverHA(
  envName,
  envConfig,
  projectConfig,
  parsed,
  tracker,
  strategy,
  deps = {},
) {
  const {
    identify = identifyServers,
    getKeyPath = getSSHKeyPath,
    keyExists = existsSync,
    preflight = preflightPilotFailover,
    provision = provisionStandbyCapacity,
    isPrimaryReady = isPrimaryPostgresReady,
    scale = scaleDeployments,
    catchUp = waitForStandbyCaughtUp,
    reseedPromote = reseedAndPromoteOrAbort,
    restoreWalgRole = restorePromotedWalgRole,
    gate = gatePromotedApiReadiness,
    swapRoles = swapHaRoles,
  } = deps;

  const servers = identify(envName, envConfig, projectConfig);
  if (!servers) {
    p.log.error('Could not identify primary and standby servers');
    p.log.info('Ensure HA deployment was set up with vibecarbon deploy');
    process.exit(1);
  }

  const sshKeyPath = getKeyPath(envName);
  if (!keyExists(sshKeyPath)) {
    p.log.error(`SSH key not found: ${sshKeyPath}`);
    process.exit(1);
  }

  const auth = strategy.getAuth ? await strategy.getAuth(envConfig) : null;
  const domain = envConfig.domain || envConfig.dns?.domain;
  const standbyFloatingIp = servers.standby.floatingIp || servers.standby.ip;

  // Display current state
  p.log.info(c.bold('Current HA state:'));
  p.log.message(
    `  ${c.dim(`Primary (${servers.primary.region})`.padEnd(22))} ${servers.primary.floatingIp || servers.primary.ip}`,
  );
  p.log.message(
    `  ${c.dim(`Standby (${servers.standby.region})`.padEnd(22))} ${standbyFloatingIp}`,
  );

  // Pilot-light failover plan (the standby cluster is cold: worker floor 0, app
  // tier scaled to 0 until we promote).
  p.log.info(c.bold('This will (pilot-light failover):'));
  p.log.message('  1. Provision standby worker capacity (0 → N nodes)');
  p.log.message('  2. Quiesce the primary app tier (planned failover: brief write outage)');
  p.log.message('  3. Re-seed + promote the standby database');
  p.log.message('  4. Scale up the promoted app tier');
  p.log.message('  5. Wait for the promoted API to serve (rollout + health/auth)');
  p.log.message(
    strategy.updateDns
      ? `  6. Update DNS A record → ${standbyFloatingIp}`
      : '  6. Print DNS update instructions for you to complete',
  );
  p.log.message('  7. Persist the role swap (standby becomes primary)');

  // Dry run stops here
  if (parsed.dryRun) {
    p.log.info(c.dim('Dry run: no changes made'));
    return;
  }

  // Confirmation
  if (!parsed.yes) {
    const confirm = await p.confirm({
      message: `Execute failover for ${c.bold(envName)}?`,
    });
    // Ctrl-C/ESC and an explicit "no" are different answers: one is an
    // interrupt, the other a considered refusal. Both stop the run.
    if (p.isCancel(confirm)) {
      exitCancelled();
    }
    if (!confirm) {
      exitDeclined();
    }
  }

  const s = tracker.spinner();

  // STEP 1 — Preflight: verify the persisted pilot-light config + probe the
  // standby state backend BEFORE mutating anything. Resolves the converge creds
  // ONCE and returns them (threaded into provisioning below so an operator
  // without a creds file is prompted at most once). Exits 1 on either blocker.
  const { workerSpec, scaleUpList, creds, standbyOutputs } = await preflight(envName, envConfig);

  // Freshness refresh: prefer the LIVE stack output over the persisted
  // deploy-time snapshot for the standby supabase node's private IP — the
  // re-seed dials it, and on DO it is DHCP-assigned (a droplet replacement
  // hands out a new one, silently rotting the persisted value). Hetzner pins
  // it statically, so fresh === persisted there and this is a no-op.
  const freshSupabasePrivateIp = standbyOutputs?.supabasePrivateIp;
  if (freshSupabasePrivateIp) {
    if (
      servers.standby.supabasePrivateIp &&
      servers.standby.supabasePrivateIp !== freshSupabasePrivateIp
    ) {
      p.log.warn(
        `Standby supabase private IP moved since deploy ` +
          `(${servers.standby.supabasePrivateIp} → ${freshSupabasePrivateIp}); ` +
          `using the live stack output.`,
      );
    }
    servers.standby.supabasePrivateIp = freshSupabasePrivateIp;
  }

  // STEP 2 — Provision standby worker capacity (0→N). The ONLY step that adds
  // cloud capacity, and it runs FIRST: on ANY failure here (an
  // AbortProvisioningError OR a pre-converge cred-resolution throw) the
  // still-serving primary is untouched. Clean abort — replay the abort's
  // logLines, tell the operator nothing needs cleanup on the primary, exit 1.
  try {
    await provision({
      envName,
      envConfig,
      projectConfig,
      servers,
      workerSpec,
      serverTypeOverride: parsed.serverType,
      deps: { creds },
    });
  } catch (err) {
    const lines = Array.isArray(err?.logLines) ? err.logLines : [firstErrorLine(err)];
    p.log.error('Failover aborted before any change to the primary; it is still serving.');
    for (const line of lines) p.log.message(`  ${line}`);
    p.log.info(
      `Nothing to clean up on the primary. Resolve the issue and re-run ` +
        `\`vibecarbon failover ${envName}\` (optionally with \`-server-type <id>\`).`,
    );
    process.exit(1);
  }

  // STEP 3 — Quiesce the primary app tier (PLANNED failover only). Scaling the
  // scale-up list to 0 stops every writer while leaving postgres (a StatefulSet,
  // not in the list) up for the final catch-up re-seed. THE WRITE OUTAGE OPENS
  // HERE — quiesce-BEFORE-promote is what makes this a true zero-data-loss
  // upgrade (no writer can commit past the final catch-up). Unplanned (primary
  // unreachable) skips quiesce; the old primary's app tier is scaled down after
  // the gate instead (step 6b).
  const planned = await isPrimaryReady(servers.primary.ip, sshKeyPath);
  if (planned) {
    s.start('Quiescing primary app tier (write outage begins)');
    await scale(servers.primary.ip, sshKeyPath, scaleUpList, 0, 'quiesce primary app tier');
    s.stop('Primary app tier quiesced');
  }

  // STEP 4 — Final catch-up re-seed (against the now-quiesced primary) + promote.
  // A re-seed failure or unconfirmed promotion ABORTS (throws). In planned mode
  // the primary was just quiesced, so before rethrowing we best-effort un-quiesce
  // it — an aborted failover must NOT leave the site down.
  try {
    // STEP 3b (PLANNED only) — zero-data-loss gate. The primary is quiesced (no
    // new customer writes), so before crossing the point of no return, wait for
    // the STREAMING standby to replay the primary's WAL up to its quiesce-time
    // position — streaming ≠ caught-up, and the streaming short-circuit would
    // otherwise promote a standby that hasn't replayed the last pre-quiesce
    // records. A timeout THROWS into the catch below → the primary is
    // un-quiesced and the failover aborts (a lagging standby is never promoted).
    if (planned) {
      s.start("Verifying the standby replayed the primary's final WAL (zero-data-loss)");
      try {
        await catchUp(servers, sshKeyPath);
        s.stop('Standby caught up to the primary: safe to promote');
      } catch (cuErr) {
        s.stop('Standby did not catch up, aborting failover');
        throw cuErr;
      }
    }
    await reseedPromote(servers, sshKeyPath, s);
  } catch (err) {
    if (planned) {
      // The primary was quiesced moments ago — an aborted failover must not
      // leave the site down. Un-quiesce (best-effort) BEFORE rethrowing.
      p.log.warn('Failover aborted after quiesce, re-scaling the primary app tier back up.');
      await scale(
        servers.primary.ip,
        sshKeyPath,
        scaleUpList,
        'up',
        'un-quiesce primary (failover aborted)',
      ).catch(() => {});
      p.log.info('Primary app tier restored; the original primary is serving again.');
    }
    // reseedAndPromoteOrAbort's error already states the world (standby NOT
    // promoted, DNS NOT flipped) and the retry guidance — rethrow so it
    // surfaces once via the top-level handler instead of duplicating it here.
    throw err;
  }

  // STEP 4b — Move the wal-g WRITE-GUARD onto the promoted cluster. The standby
  // was deployed with WALG_ROLE=standby, which no-ops the base-backup CronJob
  // (it inherits the db pod's env) and, with the write-guard now present in the
  // k8s archive wrapper too, WAL archiving as well — on the cluster that from
  // here on holds the only live copy of the data.
  //
  // Placed HERE, between promote and scale-up, because the env change rolls the
  // db pod: the app tier is still at zero replicas (pilot-light), so the roll
  // costs RTO and disturbs no traffic. Doing it after scale-up would bounce the
  // database under a live app tier instead. Never throws — see
  // restorePromotedWalgRole.
  s.start('Moving the wal-g write-guard to the promoted cluster');
  const backupHealth = await restoreWalgRole({
    promotedIp: servers.standby.ip,
    oldPrimaryIp: servers.primary.ip,
    sshKeyPath,
  });
  s.stop(
    backupHealth.ok
      ? 'wal-g write-guard moved, promoted cluster is archiving'
      : 'wal-g write-guard NOT confirmed on the promoted cluster',
  );
  if (!backupHealth.ok) {
    p.log.error(
      walgRoleDegradedMessage({
        path: 'k8s',
        envName,
        promotedIp: servers.standby.ip,
        detail: backupHealth.error?.message ?? 'unknown failure',
      }),
    );
  }

  // STEP 5 — Scale up the promoted app tier from the persisted list ('up' = each
  // entry's own deploy-rendered replica count), on the promoted cluster.
  s.start('Scaling up the promoted app tier');
  await scale(servers.standby.ip, sshKeyPath, scaleUpList, 'up', 'scale up promoted app tier');
  s.stop('Promoted app tier scaled up');

  // STEP 6 — Readiness gate: rollout-status each scaled deployment on the
  // promoted cluster, then gate on the public API actually serving. Best-effort;
  // for manual DNS the probe still works via `--resolve …:127.0.0.1`.
  await gate(domain, servers.standby.ip, sshKeyPath, s, { scaleUpList });

  // STEP 6b — Split-brain prevention (UNPLANNED only, best-effort). In planned
  // mode the primary is already quiesced; when it was unreachable we could not
  // quiesce pre-promotion, so scale its app tier down NOW — after the gate,
  // BEFORE the DNS flip. If the old primary is still unreachable this no-ops.
  if (!planned) {
    s.start('Scaling down the old primary app tier (best-effort split-brain prevention)');
    await scale(
      servers.primary.ip,
      sshKeyPath,
      scaleUpList,
      0,
      'scale-down old primary (best-effort)',
    );
    s.stop('Old primary app tier scaled down (best-effort)');
  }

  // STEP 7 — Switch apex + wildcard A records to the standby floating IP.
  // Manual DNS skips this — instructions are printed in the epilogue.
  if (strategy.updateDns) {
    s.start('Updating DNS A record');
    try {
      await strategy.updateDns(auth, domain, standbyFloatingIp);
      s.stop(`DNS updated: ${domain} → ${standbyFloatingIp}`);
    } catch (error) {
      s.stop('DNS update failed');
      p.log.error(error.message);
      p.log.warn(`Manually update the A record for ${domain} to ${standbyFloatingIp}`);
    }
  }

  // TERMINAL WRITE — persist the role swap LAST, after the DNS flip. A rerun
  // BEFORE this point keeps the ORIGINAL direction (identifyServers reads the
  // unswapped config), so a mid-flow crash re-runs the SAME failover — the
  // already-promoted guard in reseedAndPromoteOrAbort makes that convergent.
  // Persisting mid-flow would instead flip a rerun's direction. One write, here.
  swapRoles(envName);

  if (strategy.updateDns) {
    p.log.success('Failover complete');
    p.log.info(c.bold('Recovery instructions:'));
    p.log.message(
      `  Re-run \`vibecarbon deploy ${envName}\`; it converges the recovered ex-primary ` +
        `(${servers.primary.ip}) to pilot-light and re-establishes streaming.`,
    );
  } else {
    const displayDomain = domain || '<your-domain>';
    p.log.success('Standby region activated');
    p.log.info(c.bold('Update DNS to complete failover:'));
    p.log.message(`  ${c.dim('Domain'.padEnd(14))} ${c.bold(displayDomain)}`);
    p.log.message(`  ${c.dim('New IP'.padEnd(14))} ${c.bold(standbyFloatingIp)} (promoted master)`);
    p.log.info(c.bold('Steps:'));
    p.log.message('  1. Log into your DNS provider');
    p.log.message(`  2. Update the A record for ${displayDomain} to ${c.bold(standbyFloatingIp)}`);
    p.log.message(`  3. Wait for DNS propagation (check: ${c.dim(`dig ${displayDomain}`)})`);
    p.log.info(
      `  Then re-run \`vibecarbon deploy ${envName}\` to converge the ex-primary to ` +
        `pilot-light and re-establish streaming.`,
    );
  }

  // TERMINAL: the failover itself succeeded (promoted, scaled, DNS flipped, role
  // swap persisted, recovery steps printed above) but its backups did not. Throw
  // LAST so the command exits non-zero — a failover that leaves the new primary
  // archiving nothing must never be reported as a clean success, and an
  // automated caller has to be able to see that.
  if (!backupHealth.ok) {
    throw new Error(
      walgRoleDegradedMessage({
        path: 'k8s',
        envName,
        promotedIp: servers.standby.ip,
        detail: backupHealth.error?.message ?? 'unknown failure',
      }),
    );
  }
}

// ============================================================================
// FAILOVER: SINGLE SERVER (RECOVERY GUIDE)
// ============================================================================

async function failoverSingleServer(envName, envConfig) {
  const serverIp = envConfig.servers?.[0]?.ip;
  const sshKeyPath = getSSHKeyPath(envName);

  p.log.warn('This environment has no standby region');
  p.log.info('Recovery requires deploying a new server and restoring from backup');

  // Check for available backups. wal-g is the SINGLE SOURCE OF TRUTH for what is
  // actually restorable — the legacy `/backups/*_full.tar.gz` + `*.sql.gz` S3
  // objects are NOT wal-g backups and `vibecarbon restore` cannot replay them,
  // so listing them here would tempt an operator to pick a non-restorable
  // artifact mid-disaster. List wal-g base backups only.
  if (serverIp && existsSync(sshKeyPath)) {
    const s = spinner();
    s.start('Checking for available backups (wal-g)');
    const projectConfig = loadProjectConfig();
    const projectName = projectConfig?.projectName || 'project';
    const isCompose = envConfig.deployMode === 'compose' || envConfig.deployMode === 'compose-ha';
    const backups = await listWalgBackups({ serverIp, sshKeyPath, projectName, isCompose });
    s.stop('Backup check complete');

    if (backups.length > 0) {
      p.log.info(c.bold(`Available wal-g base backups (${backups.length}, newest first):`));
      for (const b of backups.slice(0, 5)) {
        p.log.message(`  ${formatInstant(b.time).padEnd(22)} ${c.dim(b.name)}`);
      }
    } else {
      p.log.info('No wal-g base backups found on the server');
      p.log.info(`Create one with: ${c.info(`vibecarbon backup ${envName}`)}`);
    }
  }

  p.log.info(c.bold('Recovery steps:'));
  p.log.message(`  1. ${c.info(`vibecarbon deploy ${envName}`)}`);
  p.log.message(`  2. ${c.info(`vibecarbon restore ${envName}`)}`);
  p.log.message(`  3. ${c.info(`vibecarbon status ${envName}`)}`);
  p.log.info('To enable HA for one-command failover in the future:');
  p.log.message(`  ${c.info(`vibecarbon deploy ${envName} -mode compose-ha`)}`);
}

// ============================================================================
// MAIN
// ============================================================================

export async function run(args) {
  const { values, positional, handled } = parseFlagsOrExit(args, SPEC);
  if (handled) return;

  // Project guard runs before banner so an accidental `vibecarbon
  // failover` from a parent directory emits the canonical message.
  const projectConfig = assertInProjectDir();

  introCommand('failover');

  // License-gates before any paid work (including the operator-IP firewall
  // check below). Single-server Compose stays free — it only ever reaches
  // failoverSingleServer(), a printed recovery guide.
  const { envName, envConfig } = await resolveEnvContext({
    command: 'failover',
    actionVerb: 'fail over',
    envRequirement: 'name an environment to fail over',
    values,
    positional,
    projectConfig,
  });

  // Compatibility shim — the existing failover orchestration helpers
  // read `parsed.dryRun` and `parsed.yes` from the legacy struct shape.
  // Build that shape from the new flag values without changing the
  // helpers (each is hundreds of lines and well-tested).
  const parsed = {
    env: envName,
    dryRun: !!values.dry,
    yes: !!values.y,
    // Pilot-light failover worker server-type override. Consumed by
    // Task 10's provisioning step (provisionStandbyCapacity's
    // serverTypeOverride) — null means "use the persisted standbyWorkerSpec".
    serverType: values['server-type'] || null,
  };

  // `-server-type` is raw operator input that goes straight to the converge as
  // workerServerType, so it never passes through a filtered option list.
  // vibecarbon is x86-64 only (src/lib/deploy/platform.js) — reject a non-amd64
  // SKU up front rather than provisioning standby workers the app image can't
  // run on, mid-failover.
  //
  // This catches the flag only. The PERSISTED `ha.standbyWorkerSpec.serverType`
  // reaches the converge just as verbatim and is guarded separately, inside
  // provisionStandbyCapacity (which sees the flag-vs-persisted resolution) —
  // see the comment there for why an ARM standby spec is rejected rather than
  // silently rescued. Nothing on this path calls
  // HetznerProvider.resolveServerTypeForRegion.
  try {
    providerFor(envConfig).assertAmd64ServerType(parsed.serverType, '-server-type');
  } catch (err) {
    p.log.error(err.message);
    process.exit(1);
  }

  // Failover hits the active and standby clusters via SSH + kubectl, so the
  // operator's IP must be in the firewall allowlist for both.
  const apiToken = resolveProviderToken(providerIdFor(envConfig));
  if (apiToken) {
    try {
      const result = await ensureOperatorIpAccess({
        projectConfig,
        environment: envName,
        isHA: true,
        apiToken,
        yes: !!parsed.yes,
        onMessage: (msg) => p.log.info(msg),
      });
      if (result.added) {
        p.log.success(`Firewall updated: SSH/k8s API now allow ${result.cidr}`);
      }
    } catch (err) {
      p.log.error(`Operator-IP check failed: ${err.message}`);
      process.exit(1);
    }
  }

  // Single-server compose has no failover target
  if (envConfig.deployMode === 'compose') {
    p.log.info('Failover is not available for single-server Compose deployments.');
    p.log.info(`Environment "${envName}" uses Docker Compose on a single VPS.`);
    p.log.info('');
    p.log.info(`${c.dim('To enable failover, redeploy in an HA mode:')}`);
    p.log.info(`  ${c.info(`vibecarbon deploy ${envName} -mode compose-ha`)}`);
    p.outro('');
    return;
  }

  // SECURITY: production type-to-confirm runs UNCONDITIONALLY here — even with
  // -y — for any DESTRUCTIVE failover (compose-HA or an HA k8s scenario), so a
  // scripted `failover -y prod` can never silently promote/flip production. This
  // is deliberately OUTSIDE every `if (!parsed.yes)` soft-confirm block (those
  // are skippable with -y; this hard gate is not). Mirrors restore/destroy.
  // Skipped for -dry (previews nothing destructive) and for the single-server
  // recovery guide (informational only — no promotion/DNS change).
  const isDestructiveFailover =
    envConfig.deployMode === 'compose-ha' || detectScenario(envConfig) !== 'single_server';
  if (!parsed.dryRun && isDestructiveFailover) {
    await confirmProdOrExit(envName, { actionLabel: 'failover', yes: !!parsed.yes });
  }

  // Compose-HA failover uses docker compose exec instead of kubectl
  if (envConfig.deployMode === 'compose-ha') {
    const composeHATracker = createTracker('failover', {
      environment: envName,
      scenario: 'compose_ha',
    });
    const { failoverComposeHA } = await import('./lib/deploy/compose/ha.js');
    await failoverComposeHA(envName, envConfig, projectConfig, parsed, composeHATracker);
    composeHATracker.finish();
    p.outro(c.success('Done'));
    return;
  }

  // Detect scenario
  const scenario = detectScenario(envConfig);
  const tracker = createTracker('failover', { environment: envName, scenario });

  switch (scenario) {
    case 'ha_dns': {
      const dnsRow = DNS_PROVIDERS[envConfig.dns.provider];
      p.log.info(`Scenario: ${c.bold(`HA + ${dnsRow.name}`)} (automatic DNS failover)`);
      await failoverHA(
        envName,
        envConfig,
        projectConfig,
        parsed,
        tracker,
        dnsStrategyFor(envConfig.dns.provider),
      );
      break;
    }

    case 'ha_manual':
      p.log.info(`Scenario: ${c.bold('HA + Manual DNS')}`);
      await failoverHA(envName, envConfig, projectConfig, parsed, tracker, MANUAL_DNS_STRATEGY);
      break;

    case 'single_server':
      p.log.info(`Scenario: ${c.bold('Single Server')} (no HA configured)`);
      await failoverSingleServer(envName, envConfig);
      break;
  }

  tracker.finish();
  p.outro(c.success('Done'));
}

// Exported for tests. (failoverHA, swapHaRoles, gatePromotedApiReadiness,
// waitForPromotedApiServing, promotedProbeArgv, getPromotedAnonKey,
// preflightPilotFailover, provisionStandbyCapacity, and AbortProvisioningError
// are exported inline at their definitions above.)
export { getReplPasswordFromSecret, reseedAndPromoteOrAbort, reseedStandbyFromPrimary, SPEC };
