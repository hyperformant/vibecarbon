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
import { resolveEnvContext } from './lib/cli/env-context.js';
import { exitCancelled, exitDeclined } from './lib/cli/exit-guard.js';
import { introCommand } from './lib/cli/intro.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { spinner } from './lib/cli/progress.js';
import { assertInteractiveStdin } from './lib/cli/tty-guard.js';
import { c } from './lib/colors.js';
import { loadProjectConfig, saveProjectConfig } from './lib/config.js';
import {
  backupFenceWarning,
  recordBackupFence,
  writeK8sBackupFence,
} from './lib/deploy/backup-fence.js';
import { DB_CONTAINER, DB_POD, DB_POD_SELECTOR, DB_STATEFULSET } from './lib/deploy/db-workload.js';
import { abortFailover } from './lib/deploy/failover-abort.js';
import {
  assertFailoverClassified,
  assertFailoverPreconditions,
  classifyFailover,
  clearFailoverJournal,
  confirmUnprovenFailover,
  dnsDidNotMessage,
  FailoverDnsError,
  FailoverRefusedError,
  flipAndVerifyDns,
  promotionNotIssuedMessage,
  promotionUnknownMessage,
  readReplicaState,
  recordSystemIdentifier,
  UNPROVEN_RISK_LINE,
  writeFailoverJournal,
} from './lib/deploy/failover-guard.js';
import {
  PROMOTABLE_CERTIFICATES,
  PROMOTE_ISSUER_ANNOTATION,
} from './lib/deploy/k8s/acme-issuer-policy.js';
import {
  assertStandbyNotWriteFenced,
  DB_STS_BOOT_TIMEOUT_S,
  fenceDatabaseWrites,
  getReplPasswordFromSecret,
  isStandbyStreaming,
  k8sPsqlRunner,
  promoteStandby,
  reseedStandbyFromPrimary,
  UNFENCE_SQL_HINT,
  unfenceDatabaseWrites,
  waitForStandbyCaughtUp,
} from './lib/deploy/replication.js';
import { haTierOf, reconcileRetiredFence } from './lib/deploy/retired-fence.js';
import {
  assertWalgBackupsWorking,
  k8sWalgAuditArgv,
  WALG_AUDIT_PROBE_TIMEOUT_MS,
} from './lib/deploy/walg-audit.js';
import {
  demoteK8sWalgRole,
  k8sDbRolloutStatusArgv,
  k8sSetWalgRoleArgv,
  walgRoleDegradedMessage,
} from './lib/deploy/walg-role.js';
import {
  clearWriteFenceMarker,
  liftStrandedWriteFence,
  writeWriteFenceMarker,
} from './lib/deploy/write-fence.js';
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
import { declaredAddonNames, k8sPrimaryOnlyWorkloads } from './lib/services/standby-policy.js';
import { getPostgresPod, getSSHKeyPath, sshKubectl, sshRun } from './lib/ssh.js';
import { createTracker } from './lib/tracker.js';
import {
  backupCredentialVars,
  printBaseBackupList,
  readEnvBaseBackups,
} from './lib/walg/restore-base.js';

// Shared with the compose-ha failover; re-exported where tests and callers
// have always found them.
export { confirmUnprovenFailover, promotionUnknownMessage, UNPROVEN_RISK_LINE };

// ============================================================================
// COMMAND SPEC — single source of truth for argv parsing AND help output.
// ============================================================================

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, description?: string, examples?: Array<{ command: string, description?: string }> }} */
const SPEC = {
  name: 'failover',
  summary: 'Initiate failover to the standby region',
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
    {
      name: 'force-unproven',
      boolean: true,
      description:
        'Primary is dead and nothing proves the standby holds its data: promote it anyway (unplanned only)',
    },
    {
      name: 'force-unplanned',
      boolean: true,
      description:
        'Your machine cannot reach the primary but the standby still sees it streaming: fail over anyway, knowing the old primary may still be serving',
    },
    {
      name: 'allow-degraded',
      boolean: true,
      description:
        'Only applies together with -force-unproven (refused on its own): also accept a standby the last deploy flagged degraded',
    },
    {
      name: 'abort',
      boolean: true,
      description:
        'Call off a failover that is stuck mid-flight: stops the standby database, and the old primary serves again',
    },
    { name: 'env', value: '<name>', description: 'Environment seed (alternative to positional)' },
    {
      name: 'server-type',
      value: '<id>',
      description: 'Worker server type override for pilot-light failover provisioning (e.g. cx33)',
    },
    {
      name: 'confirm',
      value: '<value>',
      description:
        'Production only: supply the type-to-confirm value on the command line (scripts / no TTY)',
    },
  ],
  examples: [
    { command: 'vibecarbon failover', description: 'prompts for env' },
    { command: 'vibecarbon failover prod -dry', description: 'preview the failover plan' },
    { command: 'vibecarbon failover prod -y', description: 'execute without confirmation' },
    {
      command: 'vibecarbon failover prod -abort',
      description: 'call off a stuck failover and keep the old primary',
    },
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
        dbIp: envConfig.ha.primary.dbIp,
        dbPrivateIp: envConfig.ha.primary.dbPrivateIp,
        floatingIp: envConfig.ha.primary.floatingIp || envConfig.ha.primary.masterIp,
        region: envConfig.ha.primary.region,
        envKey: envName,
      },
      standby: {
        ip: envConfig.ha.standby.masterIp,
        dbIp: envConfig.ha.standby.dbIp,
        dbPrivateIp: envConfig.ha.standby.dbPrivateIp,
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
        dbIp: primary.dbIp,
        dbPrivateIp: primary.dbPrivateIp,
        region: primaryRegion,
        envKey: envName,
      },
      standby: {
        ip: standby.ip,
        dbIp: standby.dbIp,
        dbPrivateIp: standby.dbPrivateIp,
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
    return await promoteStandby(standbyIp, sshKeyPath, {
      readState: () => readReplicaState({ exec: k8sPsqlRunner(standbyIp, sshKeyPath) }),
    });
  } finally {
    _t.end();
  }
}

/**
 * Re-seed the standby from the primary when it needs it, before promotion.
 * ABORTS the whole failover (throws) if the re-seed fails: we must NEVER flip
 * DNS onto a standby that was left half-seeded. Promotion itself is a separate
 * step (failoverHA), gated by failover-guard's preconditions and journal.
 *
 * @param {object} servers
 * @param {string} sshKeyPath
 * @param {{ start: Function, stop: Function }} s
 * @param {{ onSeeded?: (systemIdentifier: string) => void }} [opts]
 */
async function reseedStandbyOrAbort(servers, sshKeyPath, s, { onSeeded, mustReseed = false } = {}) {
  // Skip the re-seed when the standby is already verifiably streaming. A
  // streaming standby is in-parity with the primary (that is exactly what
  // streaming replication guarantees), so a pre-promotion pg_basebackup is
  // wasted RTO, and worse, the standby's live walreceiver holds the persistent
  // replication slot, so a basebackup that tried to attach to it would error
  // "replication slot is active for PID ..." (live RCA compose-ha 2026-07-07;
  // the reseed's basebackup now uses a temp slot, but skipping entirely is
  // still the right call for an already-streaming standby).
  // Prefer the STANDBY-side signal (pg_stat_wal_receiver): failover often runs
  // when the primary is unhealthy, and the standby can see its own receiver even
  // when the primary is unreachable.
  // mustReseed: the catch-up gate already read it not streaming, so a
  // streaming read now carries no catch-up proof and cannot skip the reseed.
  if (!mustReseed && (await isStandbyStreaming(servers.standby.ip, sshKeyPath))) {
    p.log.info(
      'Standby already streaming, skipping re-seed (parity guaranteed by streaming state)',
    );
    return;
  }
  if (!(await isPrimaryPostgresReady(servers.primary.ip, sshKeyPath))) {
    p.log.warn('Primary unreachable, skipping re-seed, promoting standby with current state');
    return;
  }
  s.start('Re-seeding standby from primary (pg_basebackup)');
  let result;
  try {
    // standby.dbIp: the node the standby db pod is pinned to; the re-seed's
    // node-side PGDATA swap ssh's there (roles are not yet swapped; the
    // re-seed runs BEFORE promotion, so the deploy-time gateway relay
    // directions still hold and the re-seed dials the standby's LOCAL
    // WireGuard relay: no primary IP needed, no gateway re-render).
    result = await reseedStandbyFromPrimary(servers.standby.ip, sshKeyPath, {
      standbyDbIp: servers.standby.dbIp,
      standbyDbPrivateIp: servers.standby.dbPrivateIp,
      onSeeded,
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
}

/** How long a quiesce may take to show every quiesced pod gone. */
export const QUIESCE_DEADLINE_MS = 180_000;

/**
 * Prove a quiesce: every Deployment in `deployments` has no pods left (none
 * running, none terminating). A scale to 0 returns before its pods terminate,
 * and a terminating app pod can still hold a database session. A Deployment
 * that does not exist has nothing to wait for. Deadline-bounded (R3).
 *
 * @returns {Promise<{ ok: boolean, remaining: string[] }>} remaining names the
 *   Deployments that still had pods (or could not be read) at the deadline
 */
export async function waitForAppTierGone(ip, sshKeyPath, deployments, opts = {}) {
  const {
    kubectl = sshKubectl,
    deadlineMs = QUIESCE_DEADLINE_MS,
    pollMs = 3000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
  } = opts;
  const deadline = now() + deadlineMs;
  const selectors = [];
  for (const dep of deployments) {
    const ns = dep.namespace || 'vibecarbon';
    let raw;
    try {
      raw = await kubectl(ip, sshKeyPath, [
        'get',
        'deployment',
        dep.name,
        '-n',
        ns,
        '-o',
        'jsonpath={.spec.selector.matchLabels}',
      ]);
    } catch (err) {
      if (/not found/i.test(String(err?.message ?? err))) continue;
      return { ok: false, remaining: [`${dep.name} (unreadable: ${firstErrorLine(err)})`] };
    }
    let labels;
    try {
      labels = JSON.parse(String(raw ?? '').trim() || 'null');
    } catch {
      labels = null;
    }
    if (!labels || typeof labels !== 'object' || Object.keys(labels).length === 0) {
      return { ok: false, remaining: [`${dep.name} (no pod selector)`] };
    }
    const selector = Object.entries(labels)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    selectors.push({ name: dep.name, ns, selector });
  }

  let remaining = selectors.map((x) => x.name);
  for (;;) {
    const still = [];
    for (const { name, ns, selector } of selectors) {
      try {
        const out = await kubectl(ip, sshKeyPath, [
          'get',
          'pods',
          '-n',
          ns,
          '-l',
          selector,
          '-o',
          'name',
        ]);
        if (String(out ?? '').trim() !== '') still.push(name);
      } catch {
        still.push(name);
      }
    }
    remaining = still;
    if (remaining.length === 0) return { ok: true, remaining };
    if (now() >= deadline) return { ok: false, remaining };
    await sleep(pollMs);
  }
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
/**
 * Single-ACME-issuer policy, promote half — see
 * src/lib/deploy/k8s/acme-issuer-policy.js for the full account.
 *
 * For each deploy-owned Certificate on the promoted cluster: read the
 * `vibecarbon.dev/promote-issuer` annotation (stamped by the deploy) and,
 * when the live issuerRef differs, patch it to the annotated ACME issuer —
 * making the promoted cluster the environment's sole ACME solver.
 *
 * Best-effort BY CONTRACT: this runs after the point of no return (standby
 * promoted, DNS about to flip), and a promoted site serving on the
 * self-signed cert is strictly better than an aborted failover. Not-found
 * certificates (a pilot-standby never installs observability) are skipped
 * quietly; every other failure warns loudly and continues — the reconverge
 * redeploy repairs issuer ownership.
 *
 * @param {object} args
 * @param {string} args.promotedIp - promoted cluster master IP (kubectl target)
 * @param {string} args.sshKeyPath
 * @param {{kubectl?: Function, warn?: (msg: string) => void}} [args.deps]
 * @returns {Promise<{patched: string[]}>} `ns/name` keys actually re-pointed
 */
export async function promoteAcmeIssuer({ promotedIp, sshKeyPath, deps = {} }) {
  const { kubectl = sshKubectl, warn = (m) => p.log.warn(m) } = deps;
  const patched = [];
  for (const { namespace, name } of PROMOTABLE_CERTIFICATES) {
    try {
      const raw = await kubectl(promotedIp, sshKeyPath, [
        'get',
        'certificate',
        name,
        '-n',
        namespace,
        '-o',
        'json',
      ]);
      const cert = JSON.parse(String(raw));
      const target = cert?.metadata?.annotations?.[PROMOTE_ISSUER_ANNOTATION];
      const current = cert?.spec?.issuerRef?.name;
      // No annotation = a pre-policy cluster (or a hand-managed cert): its
      // issuerRef was never redirected, so there is nothing to promote.
      if (!target || target === current) continue;
      await kubectl(promotedIp, sshKeyPath, [
        'patch',
        'certificate',
        name,
        '-n',
        namespace,
        '--type=merge',
        '-p',
        JSON.stringify({ spec: { issuerRef: { name: target, kind: 'ClusterIssuer' } } }),
      ]);
      patched.push(`${namespace}/${name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found|no objects passed/i.test(msg)) continue;
      warn(
        `promote-issuer: could not re-point ${namespace}/${name} at its ACME issuer ` +
          `(${msg.split('\n')[0]}). The site serves on the standby self-signed cert until ` +
          `the next deploy reconverges issuer ownership.`,
      );
    }
  }
  return { patched };
}

/**
 * Scale each deployment on one cluster, best-effort: a missing one is skipped,
 * any other failure is warned and named in `failed`. `reached` is true once
 * kubectl itself ran on the far end (a success, or an exit status other than
 * ssh's own 255), so a caller can tell a cluster that answered and refused
 * from one that never answered.
 *
 * @returns {Promise<{ reached: boolean, failed: string[] }>}
 */
export async function scaleDeployments(ip, sshKeyPath, deployments, replicas, label, opts = {}) {
  const { kubectl = sshKubectl } = opts;
  let reached = false;
  const failed = [];
  for (const dep of deployments) {
    const ns = dep.namespace || 'vibecarbon';
    const target = replicas === 'up' ? (dep.replicas ?? 1) : replicas;
    try {
      await kubectl(ip, sshKeyPath, [
        'scale',
        'deployment',
        dep.name,
        '-n',
        ns,
        `--replicas=${target}`,
      ]);
      reached = true;
    } catch (err) {
      if (typeof err?.status === 'number' && err.status !== 255) reached = true;
      const msg = err instanceof Error ? err.message : String(err);
      // "no objects passed to scale" / "deployments.apps not found" → log and continue.
      // Anything else (auth failure, network) we still want to surface.
      const isMissing = /not found|no objects passed/i.test(msg);
      if (isMissing) {
        p.log.warn(`${label}: ${dep.name} not found; skipped`);
      } else {
        failed.push(dep.name);
        p.log.warn(`${label}: ${dep.name} failed: ${msg.split('\n')[0]}`);
      }
    }
  }
  return { reached, failed };
}

// ============================================================================
// POST-PROMOTION READINESS GATE (product-side)
// ============================================================================

/**
 * Build the argv for a public-ingress probe against the promoted master. Uses
 * `--resolve <domain>:443:127.0.0.1` so the probe traverses the REAL public path
 * (traefik hostPort → app) on the promoted node without waiting on DNS
 * propagation — the DNS A record was flipped moments ago and the test runner's
 * resolver may still be cached. Mirrors compose/ha.js newPrimaryApiProbeCmd.
 */
export function promotedProbeArgv(domain, path) {
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
    `https://${domain}${path}`,
  ];
}

/**
 * Poll the promoted cluster's public API until it actually SERVES — the app's
 * liveness (/api/health) AND its readiness (/api/health/ready: the app answers
 * against the promoted database) both return 200 within a budget. Auth runs
 * inside the app on that database, so readiness is also "sign-in works".
 *
 * This is the k8s mirror of compose/ha.js waitForNewPrimaryApi: `vibecarbon
 * failover` returns via the skip-if-streaming fast path in ~44s (promotion ~9s),
 * but the promoted cluster's pods then spend a window starting/reconnecting.
 * failover used to report "complete" straight into that window and
 * verify-failover (which does not retry) caught it.
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
    readyPath = '/api/health/ready',
    initialDelayMs = 3000,
    maxDelayMs = 15_000,
  } = opts;
  let last = '';
  const codeOf = async (path) => {
    const out = await runner(ip, sshKeyPath, promotedProbeArgv(domain, path), {
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
    const ready = await codeOf(readyPath);
    if (ready !== '200') {
      last = `ready=${ready || 'none'}`;
      return false;
    }
    return true;
  };
  try {
    await poll(probe, {
      budgetMs,
      initialDelayMs,
      maxDelayMs,
      description: `promoted API to serve ${domain} (health + ready)`,
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
 * `kubectl rollout status` for one scale-up entry on the promoted cluster.
 * The kubectl --timeout sits INSIDE the SSH client cap (10s more), or the
 * client kills the connection first and the kubectl error, which names the
 * stuck deployment, never surfaces (sshRun's default cap is 120s).
 *
 * @returns {Promise<string | null>} null once rolled out, else the error's first line
 */
async function rolloutStatus(kubectl, ip, sshKeyPath, dep, timeoutS) {
  const ns = dep.namespace || 'vibecarbon';
  try {
    await kubectl(
      ip,
      sshKeyPath,
      ['rollout', 'status', `deployment/${dep.name}`, '-n', ns, `--timeout=${timeoutS}s`],
      { timeout: (timeoutS + 10) * 1000 },
    );
    return null;
  } catch (err) {
    return firstErrorLine(err);
  }
}

/**
 * After the DNS flip: wait (in parallel, 300s each) for every add-on entry of
 * the scale-up list to roll out on the promoted cluster. The pre-flip gate
 * skips them so a slow add-on never lengthens the outage; this is where an
 * add-on that never comes up gets named. Warn-only: the failover has
 * completed, so a not-ready add-on is a line telling the operator what to
 * run, never a failure.
 *
 * @param {string} promotedIp
 * @param {string} sshKeyPath
 * @param {Array<{name: string, namespace?: string, addon?: true}>} scaleUpList
 * @param {{ kubectl?: Function }} [opts]
 * @returns {Promise<{ notReady: string[] }>}
 */
export async function checkPromotedAddonRollouts(promotedIp, sshKeyPath, scaleUpList, opts = {}) {
  const { kubectl = sshKubectl } = opts;
  const addons = scaleUpList.filter((dep) => dep.addon === true);
  const results = await Promise.all(
    addons.map(async (dep) => ({
      dep,
      err: await rolloutStatus(kubectl, promotedIp, sshKeyPath, dep, 300),
    })),
  );
  const notReady = [];
  for (const { dep, err } of results) {
    if (!err) continue;
    notReady.push(dep.name);
    p.log.warn(
      `add-on ${dep.name} is not ready on the promoted cluster (${err}); the failover ` +
        `is complete, so check it with: ssh root@${promotedIp} 'kubectl rollout status ` +
        `deployment/${dep.name} -n ${dep.namespace || 'vibecarbon'}'`,
    );
  }
  return { notReady };
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

  // Add-on entries (deriveScaleUpList marks them `addon: true`) are not
  // awaited: this gate sits before the DNS flip, and a slow add-on (Metabase's
  // cold JVM start) must not lengthen the outage. After the flip the failover
  // checks their rollout (checkPromotedAddonRollouts) and warns on one that is
  // not ready.
  const appTier = scaleUpList.filter((dep) => dep.addon !== true);
  const addons = scaleUpList.filter((dep) => dep.addon === true).map((dep) => dep.name);
  if (addons.length > 0) {
    p.log.info(
      `add-ons not awaited before the DNS flip: ${addons.join(', ')} ` +
        '(failover checks their rollout after the flip and warns if one is not ready)',
    );
  }
  s.start('Waiting for the promoted app tier to roll out');
  // Roll out every deployment IN PARALLEL. Serially, this gate waits up to
  // ~11 deployments × 130s ≈ 24 min in the worst case — enough to blow the e2e
  // failover step budget on its own. Each rollout-status keeps its own
  // best-effort swallow (a stuck/missing chart name must not sink a promotion
  // that already happened) so Promise.all never rejects, and its own client-cap
  // timeout per call. The deleted restartPromotedPostgresDependents fanned out
  // exactly like this.
  await Promise.all(
    appTier.map(async (dep) => {
      const err = await rolloutStatus(kubectl, promotedIp, sshKeyPath, dep, 120);
      if (err) p.log.warn(`rollout status promoted: ${dep.name} did not settle: ${err}`);
    }),
  );
  s.stop('Promoted app tier rolled out (best-effort)');

  if (!domain) {
    p.log.warn('No domain configured, skipping public API readiness probe');
    return;
  }
  s.start('Waiting for promoted API to serve (health + ready)');
  const ready = await waitForPromotedApiServing(domain, promotedIp, sshKeyPath, { runner });
  s.stop(
    ready
      ? 'Promoted API serving (health + ready 200)'
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
    stateBucketRegion: envConfig.s3.stateBucketRegion,
    stateEndpoint: envConfig.s3.stateEndpoint,
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
 * Fire-and-forget image pre-pull (the cluster-autoscaler pod's pair) on the
 * standby nodes right after the new workers register Ready. Overlaps the app-tier scale-up (Task 10) so
 * kubelet finds images already present. Best-effort by contract — every failure
 * degrades to on-demand pulls. Only the standby cluster's nodes are targeted.
 */
async function prePullStandbyImages({ servers, envName, workerIps }) {
  const { prePullImages } = await import('./lib/deploy/k8s/k3s.js');
  const { knownHostsPath } = await import('./lib/host-keys.js');
  const nodeIps = [servers.standby.ip, servers.standby.dbIp, ...(workerIps ?? [])].filter(Boolean);
  return prePullImages({
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
  // ha.primary / ha.standby are the role objects the terminal swap rewrites:
  // without both, a promote would end with nothing to persist and the journal
  // left set, so refuse here, before anything is written.
  if (!workerSpec || !Array.isArray(scaleUpList) || !standbyStack || !ha.primary || !ha.standby) {
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
 * @param {{ standby: { ip: string, dbIp?: string } }} args.servers
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

  // The standby's region-resolved master/database types persisted at deploy
  // (may differ from the primary's when the standby region doesn't stock the
  // same SKU). Pinning them on EVERY converge (the up AND the
  // 0-worker revert) keeps buildProgramConfig's current-type slots matched to
  // the standby's reality, so the converge never plans an in-place resize
  // (reboot) of the standby's master/db node mid-failover. Undefined on envs
  // that predate this persist → falls back to envConfig, matching prior behavior.
  const standbyMasterType = envConfig.ha?.standby?.masterServerType;
  const standbyDbType = envConfig.ha?.standby?.dbServerType;

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
      type: standbyDbType,
      role: 'standby database',
      source: '.vibecarbon.json ha.standby.dbServerType',
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
    // Pin the standby's resolved master/database types on both the up and the
    // revert (see standbyMasterType/standbyDbType above). The per-call
    // overrides (minWorkers/workerServerType) win when spread last.
    overrides: {
      ...(standbyMasterType ? { masterServerType: standbyMasterType } : {}),
      ...(standbyDbType ? { dbServerType: standbyDbType } : {}),
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
export function dnsStrategyFor(dnsProvider) {
  const row = DNS_PROVIDERS[dnsProvider];
  return {
    async getAuth(envConfig) {
      let token = resolveDnsToken(dnsProvider, {
        computeProviderId: providerIdFor(envConfig),
        computeToken: undefined,
      });
      if (!token) {
        // A prompt that can never be answered must not "cancel" (exit 0) in
        // the middle of an incident: say what to export and fail.
        assertInteractiveStdin({
          what: `the ${row.name} API token`,
          envVar: row.tokenEnv,
        });
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
    async readDns(auth, name) {
      const dns = await getDnsProvider(dnsProvider);
      return dns.readARecord(auth.token, auth.zoneId, name);
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
export function swapHaRoles(envName, { override } = {}) {
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
  // The failback guard compares this with deployedAt: until a deploy
  // reconverges, the new standby is the old primary and holds no replica.
  envConfig.lastFailover = new Date().toISOString();
  // A failover that skipped the replica proof says so on the record.
  if (override) envConfig.lastFailoverOverride = override;
  else delete envConfig.lastFailoverOverride;
  // R2: the journal is cleared by the same save that persists the swap, so no
  // crash can leave a swapped config that still claims a failover in flight.
  delete ha.failoverInFlight;
  // The retired side's read-only state now belongs to the retired-node
  // handling, not to the interrupted-fence marker.
  delete ha.writeFence;
  saveProjectConfig(config);
}

/** How long `-abort` waits for the standby's db pod to be gone after the scale to zero. */
export const ABORT_DB_GONE_TIMEOUT_S = 180;

/**
 * The k8s-HA backend of `vibecarbon failover <env> -abort` (failover-abort.js).
 * The standby's db StatefulSet is scaled to zero and its pod proven gone (the
 * StatefulSet is never applied by Flux, so nothing scales it back); its app
 * tier goes to zero and its db template to WALG_ROLE=standby, so a later scale
 * up cannot archive. The old primary gets its write fence lifted, WALG_ROLE
 * back to primary when a failover's demote got that far (the set env rolls its
 * db pod, which serves nothing while its app is at zero), then its app tier up.
 *
 * @param {object} args
 * @param {string} args.envName
 * @param {object} args.envConfig
 * @param {object} args.strategy - dnsStrategyFor(...) or MANUAL_DNS_STRATEGY
 * @param {object} [args.deps] test seams
 * @returns {import('./lib/deploy/failover-abort.js').AbortBackend}
 */
export function k8sFailoverAbortBackend({ envName, envConfig, strategy, deps = {} }) {
  const sshKeyPath = deps.sshKeyPath ?? getSSHKeyPath(envName);
  const {
    kubectl = (ip, argv, opts) => sshKubectl(ip, sshKeyPath, argv, opts),
    psql = (ip) => k8sPsqlRunner(ip, sshKeyPath),
    isPrimaryReady = (ip) => isPrimaryPostgresReady(ip, sshKeyPath),
    unfenceWrites = (exec) => unfenceDatabaseWrites({ exec }),
    scale = (ip, list, replicas, label) => scaleDeployments(ip, sshKeyPath, list, replicas, label),
  } = deps;
  const servers = identifyServers(envName, envConfig, {});
  if (!servers?.primary?.ip || !servers?.standby?.ip) {
    throw new FailoverRefusedError(
      `Abort refused: the primary and standby clusters of ${envName} could not be read from ` +
        '.vibecarbon.json (ha.primary and ha.standby)',
    );
  }
  const scaleUpList = Array.isArray(envConfig.ha?.scaleUpList) ? envConfig.ha.scaleUpList : [];
  const { primary, standby } = servers;
  const ns = ['-n', 'vibecarbon'];
  const quietly = async (fn) => {
    try {
      await fn();
      return true;
    } catch {
      return false;
    }
  };
  return {
    ips: { primary: primary.floatingIp || primary.ip, standby: standby.ip },
    stopDbHint: `ssh root@${standby.ip} 'kubectl scale statefulset/${DB_STATEFULSET} -n vibecarbon --replicas=0'`,
    unfenceHint: `ssh root@${primary.ip} 'kubectl -n vibecarbon exec ${DB_POD} -- ${UNFENCE_SQL_HINT}'`,
    stopStandbyDb: async () => {
      try {
        await kubectl(standby.ip, [
          ...ns,
          'scale',
          `statefulset/${DB_STATEFULSET}`,
          '--replicas=0',
        ]);
      } catch (err) {
        return { ok: false, reason: firstErrorLine(err) };
      }
      // The wait reports a pod already gone as an error on some kubectl
      // versions, so its verdict is the read that follows, not its exit.
      await quietly(() =>
        kubectl(
          standby.ip,
          [...ns, 'wait', '--for=delete', `pod/${DB_POD}`, `--timeout=${ABORT_DB_GONE_TIMEOUT_S}s`],
          { timeout: (ABORT_DB_GONE_TIMEOUT_S + 30) * 1000 },
        ),
      );
      let left;
      try {
        left = String(
          (await kubectl(standby.ip, [
            ...ns,
            'get',
            'pods',
            '-l',
            DB_POD_SELECTOR,
            '-o',
            'name',
          ])) ?? '',
        ).trim();
      } catch (err) {
        return { ok: false, reason: `its pods could not be listed: ${firstErrorLine(err)}` };
      }
      return left === ''
        ? { ok: true }
        : { ok: false, reason: `${left.split('\n').join(', ')} still exists` };
    },
    disarmStandby: async () => {
      await scale(standby.ip, scaleUpList, 0, 'abort: standby app tier to zero');
      // The slot drop inside fails quietly (its db pod is gone); the role write
      // lands on the StatefulSet template, so a later scale up cannot archive.
      return quietly(() => demoteK8sWalgRole({ ip: standby.ip, kubectl, warn: () => {} }));
    },
    repointDns: strategy?.updateDns
      ? async () => {
          const auth = strategy.getAuth ? await strategy.getAuth(envConfig) : null;
          const domain = envConfig.domain || envConfig.dns?.domain;
          const ip = primary.floatingIp || primary.ip;
          return flipAndVerifyDns({
            update: () => strategy.updateDns(auth, domain, ip),
            read: (name) => strategy.readDns(auth, name),
            domain,
            ip,
          });
        }
      : null,
    primaryReachable: () => isPrimaryReady(primary.ip),
    unfencePrimary: () => unfenceWrites(psql(primary.ip)),
    writeBackupFence: () =>
      (deps.writeFence ?? writeK8sBackupFence)({
        ip: primary.ip,
        sshKeyPath,
        primaryNode: primary.ip,
      }),
    armPrimary: async () => {
      let role;
      try {
        const sts = JSON.parse(
          await kubectl(primary.ip, [...ns, 'get', `statefulset/${DB_STATEFULSET}`, '-o', 'json']),
        );
        const db = (sts?.spec?.template?.spec?.containers ?? []).find(
          (ct) => ct.name === DB_CONTAINER,
        );
        role = (db?.env ?? []).find((e) => e.name === 'WALG_ROLE')?.value;
      } catch {
        return false;
      }
      if (role === 'primary') return true;
      return quietly(async () => {
        await kubectl(primary.ip, k8sSetWalgRoleArgv('primary'), { timeout: 60_000 });
        await kubectl(primary.ip, k8sDbRolloutStatusArgv(DB_STS_BOOT_TIMEOUT_S), {
          timeout: (DB_STS_BOOT_TIMEOUT_S + 30) * 1000,
        });
      });
    },
    startPrimaryWriters: async () => {
      if (scaleUpList.length === 0) return false;
      await scale(primary.ip, scaleUpList, 'up', 'abort: primary app tier back up');
      return true;
    },
  };
}

/**
 * Move the wal-g WRITE-GUARD onto the cluster this failover just promoted, and
 * PROVE it took — see src/lib/deploy/walg-role.js for why nothing else does.
 *
 * On k8s, `WALG_ROLE` is rendered into the db container env at deploy
 * time and the backup CronJob has none of its own: it `kubectl exec`s
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
 * Two verdicts, independent by construction (H3): arming the promoted side and
 * disarming the old primary. The disarm runs in a `finally`, so a promoted
 * rollout or audit that fails can never skip it. It used to: an early return
 * left the stale ex-primary on WALG_ROLE=primary, and its nightly base backups
 * could become LATEST in the shared prefix if it came back.
 *
 * @param {object} args
 * @param {string} args.promotedIp    the promoted cluster's master (old standby)
 * @param {string} args.oldPrimaryIp  demoted best-effort; may be unreachable
 * @param {string} args.sshKeyPath
 * @param {object} [args.deps] injected seams for unit tests
 * @returns {Promise<{promoted: {ok: boolean, error?: Error}, demoted: {ok: boolean, error?: Error}}>}
 */
export async function restorePromotedWalgRole({ promotedIp, oldPrimaryIp, sshKeyPath, deps = {} }) {
  const {
    kubectl = (ip, argv, opts) => sshKubectl(ip, sshKeyPath, argv, opts),
    audit = assertWalgBackupsWorking,
    log = (msg) => p.log.info(msg),
    warn = (msg) => p.log.warn(msg),
  } = deps;

  const asError = (err) => (err instanceof Error ? err : new Error(String(err)));
  const health = { promoted: { ok: false }, demoted: { ok: false } };
  try {
    await kubectl(promotedIp, k8sSetWalgRoleArgv('primary'));
    // Blocks on the pod actually rolling. Budget sits just above the kubectl
    // --timeout so the remote command reports the rollout failure rather than
    // the SSH layer reporting a timeout with no detail.
    await kubectl(promotedIp, k8sDbRolloutStatusArgv(DB_STS_BOOT_TIMEOUT_S), {
      timeout: (DB_STS_BOOT_TIMEOUT_S + 30) * 1000,
    });
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
    health.promoted = { ok: true };
  } catch (err) {
    health.promoted = { ok: false, error: asError(err) };
  } finally {
    // Demote the old primary so the two clusters never write the same canonical
    // WAL prefix at once, WHATEVER the promoted side's verdict. Best-effort by
    // design (an unreachable old primary is the usual reason to fail over) and
    // NOT waited on: nothing downstream reads it, and the StatefulSet write is
    // what carries the intent.
    //
    // Safe to do here, unlike on compose, because the old primary's app tier is
    // never serving at this point: a PLANNED failover quiesced it to zero before
    // the promotion, and an UNPLANNED one is running precisely because its
    // postgres stopped answering. So the roll this triggers on its db pod has no
    // live traffic to disturb. demoteK8sWalgRole also drops the old primary's
    // inactive replication slots, which would otherwise pin WAL there.
    try {
      await demoteK8sWalgRole({ ip: oldPrimaryIp, kubectl, warn });
      log(`[walg-role] old primary ${oldPrimaryIp} demoted to the standby write-guard.`);
      health.demoted = { ok: true };
    } catch (err) {
      const error = asError(err);
      warn(
        `Could not demote the old primary's wal-g write-guard (${oldPrimaryIp}): ${error.message}. ` +
          `If it comes back up it may archive into the same backup prefix as the new primary, ` +
          `\`vibecarbon deploy\` fixes this when it converges the ex-primary to pilot-light.`,
      );
      health.demoted = { ok: false, error };
    }
  }
  return health;
}

/**
 * One line per verdict of restorePromotedWalgRole, for the failure banner and
 * the terminal error, so an operator sees which side needs the fix.
 *
 * @param {{promoted: {ok: boolean, error?: Error}, demoted: {ok: boolean, error?: Error}}} health
 * @returns {string}
 */
export function walgVerdictsDetail(health) {
  const promoted = health.promoted.ok
    ? 'promoted cluster: armed (WALG_ROLE=primary, audit passed).'
    : `promoted cluster: write-guard not confirmed, ${health.promoted.error?.message ?? 'unknown failure'}.`;
  const demoted = health.demoted.ok
    ? 'old primary: demoted to WALG_ROLE=standby.'
    : `old primary: NOT demoted, ${health.demoted.error?.message ?? 'unknown failure'}; ` +
      'if it comes back it may archive into the shared backup prefix until a deploy converges it.';
  return `${promoted} ${demoted}`;
}

/**
 * Pilot-light HA failover core (shared across DNS-provider strategies). Order:
 *   1. preflight (verify persisted config + probe standby state backend)
 *  1b. replica proof (failover-guard)                  (refuse = nothing touched)
 *   2. provision standby worker capacity 0→N          (abort = clean exit)
 *   3. quiesce + write-fence the primary               (planned only; unproven = abort)
 *   4. catch-up, re-seed, journal, promote standby     (skipped on resume;
 *                                                       unconfirmed = kept fenced)
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
    readStandbyState = (srv, key) => readReplicaState({ exec: k8sPsqlRunner(srv.standby.ip, key) }),
    readPrimaryState = (srv, key) => readReplicaState({ exec: k8sPsqlRunner(srv.primary.ip, key) }),
    scale = scaleDeployments,
    psql = k8sPsqlRunner,
    isStreaming = isStandbyStreaming,
    confirmQuiesced = waitForAppTierGone,
    fenceWrites = (exec) => fenceDatabaseWrites({ exec }),
    unfenceWrites = (exec) => unfenceDatabaseWrites({ exec }),
    assertUnfenced = (exec) => assertStandbyNotWriteFenced({ exec }),
    writeMarker = writeWriteFenceMarker,
    clearMarker = clearWriteFenceMarker,
    liftStranded = liftStrandedWriteFence,
    catchUp = (srv, key) =>
      waitForStandbyCaughtUp({
        primaryExec: psql(srv.primary.ip, key),
        standbyExec: psql(srv.standby.ip, key),
        isStreaming: () => isStreaming(srv.standby.ip, key),
      }),
    reseed = reseedStandbyOrAbort,
    writeJournal = writeFailoverJournal,
    clearJournal = clearFailoverJournal,
    promote = (srv, key) => promoteStandbyDatabase(srv.standby.ip, key),
    confirmUnproven = confirmUnprovenFailover,
    restoreWalgRole = restorePromotedWalgRole,
    gate = gatePromotedApiReadiness,
    swapRoles = swapHaRoles,
    promoteIssuer = promoteAcmeIssuer,
    addonRollouts = checkPromotedAddonRollouts,
    writeFence = (srv, key) =>
      writeK8sBackupFence({ ip: srv.standby.ip, sshKeyPath: key, primaryNode: srv.standby.ip }),
    recordFence = recordBackupFence,
    reconcileRetired = () =>
      reconcileRetiredFence({
        environment: envName,
        envConfig: loadProjectConfig()?.environments?.[envName],
        projectConfig,
        tier: 'k8s-ha',
      }),
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
  // deploy-time snapshot for the standby database node's private IP — the
  // re-seed dials it, and on DO it is DHCP-assigned (a droplet replacement
  // hands out a new one, silently rotting the persisted value). Hetzner pins
  // it statically, so fresh === persisted there and this is a no-op.
  const freshDbPrivateIp = standbyOutputs?.dbPrivateIp;
  if (freshDbPrivateIp) {
    if (servers.standby.dbPrivateIp && servers.standby.dbPrivateIp !== freshDbPrivateIp) {
      p.log.warn(
        `Standby database private IP moved since deploy ` +
          `(${servers.standby.dbPrivateIp} → ${freshDbPrivateIp}); ` +
          `using the live stack output.`,
      );
    }
    servers.standby.dbPrivateIp = freshDbPrivateIp;
  }

  // STEP 1b — Positive replica proof (R1), before any cloud change, quiesce or
  // kubectl write. Reads the standby's recovery flag, system identifier and
  // walreceiver, plus the primary's identifier when it answers (planned mode).
  // A refusal throws FailoverRefusedError naming the reason and the deploy that
  // fixes it; `resume` means a previous run of THIS failover (its journal) already
  // promoted the standby, so reseed and promote are skipped.
  const planned = await isPrimaryReady(servers.primary.ip, sshKeyPath);
  const primaryPsql = psql(servers.primary.ip, sshKeyPath);
  // A planned run that died between its database fence and its journal left
  // the primary read-only with nothing promoted: lift it first (a journal
  // means the promote may have started, and the journal flow owns it).
  if (planned) {
    await liftStranded({
      environment: envName,
      envConfig,
      rolePrimary: { ip: servers.primary.ip },
      exec: primaryPsql,
      log: (line) => p.log.info(line),
    });
  } else if (envConfig?.ha?.writeFence && !envConfig?.ha?.failoverInFlight) {
    p.log.warn(
      'an interrupted failover left a write fence on the primary, which does not answer; ' +
        'the next deploy or failover that reaches it lifts it',
    );
  }
  const standbyState = await readStandbyState(servers, sshKeyPath);
  // R8: "unreachable from here" is not "dead". A standby still streaming fresh
  // WAL from the primary proves it alive behind a partition; refuse unless the
  // operator passed -force-unplanned.
  assertFailoverClassified(classifyFailover({ primaryReachable: planned, standbyState }), parsed);
  const primaryState = planned ? await readPrimaryState(servers, sshKeyPath) : null;
  // Whether an earlier run left a journal: only without one can a promote this
  // run never sent prove that nothing will promote the standby.
  const journalAtEntry = !!envConfig?.ha?.failoverInFlight;
  const { mode, unproven } = assertFailoverPreconditions({
    envConfig,
    environment: envName,
    standbyState,
    tier: 'k8s-ha',
    planned,
    primaryState,
    forceUnproven: !!parsed.forceUnproven,
    allowDegraded: !!parsed.allowDegraded,
  });
  if (unproven) {
    // The operator asked to skip the identifier proof on a dead primary. Say the
    // risk once, and make them type the env name (or pass -y) before anything moves.
    p.log.warn(UNPROVEN_RISK_LINE);
    await confirmUnproven(envName, parsed);
  }
  if (mode === 'resume') {
    p.log.info(
      'Standby already promoted by an unfinished run of this failover (journal set), ' +
        'resuming after the promote',
    );
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

  /**
   * STEP 4: final catch-up gate, re-seed, journal, promote. Until the journal is
   * written nothing is promoted, so any throw un-quiesces the primary (planned)
   * and aborts. From the journal write on only two verdicts are answers (R3): a
   * proven 'promoted', and a 'not-issued' (this run sent nothing) on a run that
   * started with no journal, which clears the journal and un-quiesces. Anything
   * else keeps the old primary fenced, leaves the journal set and exits
   * non-zero, and the rerun resumes from the journal. With a journal from an
   * earlier run, 'not-issued' proves nothing: that run's promote may be landing.
   */
  async function catchUpReseedAndPromote() {
    try {
      // STEP 3b (PLANNED only): zero-data-loss gate. The primary is quiesced, so
      // wait for the STREAMING standby to replay the primary's WAL up to its
      // quiesce-time position (R1d); its captured LSN goes into the journal. A
      // standby that is not streaming cannot catch up: the reseed below copies
      // it in full from the quiesced primary.
      let primaryLsn = null;
      let caughtUp = null;
      if (planned) {
        s.start("Verifying the standby replayed the primary's final WAL (zero-data-loss)");
        try {
          const caught = await catchUp(servers, sshKeyPath);
          primaryLsn = caught.primaryLsn;
          caughtUp = caught.caughtUp;
          s.stop(
            caught.caughtUp
              ? 'Standby caught up to the primary: safe to promote'
              : 'Standby not streaming, it is re-seeded from the quiesced primary',
          );
        } catch (cuErr) {
          s.stop('Standby did not catch up, aborting failover');
          throw cuErr;
        }
      }
      // A reseed rewrites the standby's identity: the journal must name what
      // was just seeded, not the pre-reseed reading.
      let seededSysid = null;
      let reseeded = false;
      await reseed(servers, sshKeyPath, s, {
        // A standby the gate found not streaming has no catch-up proof, so a
        // later streaming read must not skip its reseed.
        mustReseed: planned && caughtUp === false,
        onSeeded: (sysid) => {
          reseeded = true;
          seededSysid = sysid;
          recordSystemIdentifier({ environment: envName }, sysid);
        },
      });
      // The basebackup copied the fenced primary's postgresql.auto.conf; the
      // staged script strips the fence from it. Prove that before the promote,
      // or the promoted primary would come up read-only.
      if (reseeded && planned) {
        try {
          await assertUnfenced(psql(servers.standby.ip, sshKeyPath));
        } catch (err) {
          throw new Error(`Failover aborted before promotion: ${err.message}`);
        }
      }
      // R2: the journal goes down immediately before the promote call.
      await writeJournal(
        { environment: envName },
        {
          target: 'standby',
          primaryLsn: primaryLsn ?? null,
          systemIdentifier: seededSysid ?? standbyState.systemIdentifier,
          ...(unproven && { override: 'force-unproven' }),
        },
      );
    } catch (err) {
      // An aborted failover must not leave the site down. The error already
      // states the world (standby NOT promoted, DNS NOT flipped) and the retry
      // guidance, so rethrow it for the top-level handler.
      await unquiesce();
      throw err;
    }

    // STEP 4a: promote. The deadline bounds RTO only; the verdict decides.
    s.start('Promoting standby database');
    let verdict;
    try {
      verdict = await promote(servers, sshKeyPath);
    } catch {
      verdict = 'unknown';
    }
    if (verdict === 'promoted') {
      s.stop('Standby database promoted to primary');
      return;
    }
    // 'not-issued' un-fences only when this run started with no journal: then
    // nothing anywhere asked the standby to promote. With a journal from an
    // earlier run, its promote may still be landing, so it reads as 'unknown'.
    if (verdict === 'not-issued' && !journalAtEntry) {
      s.stop('Promote never sent, aborting failover');
      // Un-fence first, and independently: a failed journal clear must not
      // leave the serving primary read-only (unquiesce never throws).
      await unquiesce();
      await clearJournal({ environment: envName }).catch((err) =>
        p.log.warn(`Could not clear the failover journal: ${firstErrorLine(err)}`),
      );
      throw new Error(promotionNotIssuedMessage(envName, servers.standby.ip));
    }
    s.stop('Promotion could not be confirmed, old primary kept fenced');
    throw new Error(promotionUnknownMessage(envName));
  }

  // STEP 3 — Quiesce the primary app tier (PLANNED failover only). Scaling the
  // scale-up list to 0 stops every writer while leaving postgres (a StatefulSet,
  // not in the list) up for the final catch-up re-seed. THE WRITE OUTAGE OPENS
  // HERE: quiesce-BEFORE-promote is what makes this a true zero-data-loss
  // upgrade (no writer can commit past the final catch-up). Unplanned (primary
  // unreachable) skips quiesce; the old primary's app tier is scaled down after
  // the gate instead (step 6b). On resume the scale to 0 re-applies the fence.
  //
  // The scale is only the outward signal (scaleDeployments returns before pods
  // terminate and swallows failures). The fence is proven: every quiesced
  // Deployment's pods are gone, then the database itself is fenced (read-only
  // default, client sessions terminated). Only then is the primary's WAL
  // position final. A fence that cannot be proven aborts a promote-mode run.
  let dbFenceAttempted = false;

  /**
   * Lift the fence after an abort that promoted nothing: only when this run
   * started with no journal (R3). With an earlier run's journal its promote may
   * still land, so the old primary stays quiesced. Never throws, so it cannot
   * mask the abort it runs for.
   */
  const unquiesce = async () => {
    if (!planned) return;
    if (journalAtEntry) {
      p.log.warn(
        'The old primary stays quiesced: an earlier run of this failover journaled a promote ' +
          'that may still land.',
      );
      return;
    }
    p.log.warn('Failover aborted after quiesce, lifting the fence on the primary.');
    try {
      if (dbFenceAttempted) {
        if (await unfenceWrites(primaryPsql)) {
          clearMarker({ environment: envName });
        } else {
          const pod = await getPostgresPod(servers.primary.ip, sshKeyPath).catch(() => '');
          p.log.warn(
            `Could not lift the database write fence on the primary (${servers.primary.ip}). ` +
              `Lift it by hand: ssh root@${servers.primary.ip} 'kubectl -n vibecarbon exec ` +
              `${String(pod || '').trim() || '<db pod>'} -- ${UNFENCE_SQL_HINT}'`,
          );
        }
      }
      await scale(
        servers.primary.ip,
        sshKeyPath,
        scaleUpList,
        'up',
        'un-quiesce primary (failover aborted)',
      );
      p.log.info('Primary app tier restored; the original primary is serving again.');
    } catch (err) {
      p.log.warn(`Could not lift the fence on the primary: ${firstErrorLine(err)}`);
    }
  };

  if (planned) {
    s.start('Quiescing primary app tier (write outage begins)');
    try {
      await scale(servers.primary.ip, sshKeyPath, scaleUpList, 0, 'quiesce primary app tier');
      const gone = await confirmQuiesced(servers.primary.ip, sshKeyPath, scaleUpList);
      if (!gone.ok) {
        throw new Error(
          `the quiesced app tier on the primary did not stop (still running: ` +
            `${gone.remaining.join(', ') || 'unknown'})`,
        );
      }
      // Recorded BEFORE it is applied: an interrupted run then leaves a marker
      // the next failover or deploy lifts (write-fence.js).
      writeMarker({ environment: envName }, { node: servers.primary.ip, ip: servers.primary.ip });
      dbFenceAttempted = true;
      await fenceWrites(primaryPsql);
      s.stop('Primary fenced: app tier gone, database read-only');
    } catch (err) {
      s.stop('Primary NOT fenced');
      if (mode === 'promote') {
        await unquiesce();
        throw new Error(
          `Failover aborted: ${firstErrorLine(err)}. Nothing was promoted; fix it and rerun ` +
            `vibecarbon failover ${envName}`,
        );
      }
      p.log.warn(`Could not prove the primary fenced: ${firstErrorLine(err)}`);
    }
  }

  if (mode === 'promote') {
    await catchUpReseedAndPromote();
  }

  // STEP 4a2 — The backup-prefix fence (backup-fence.js), before the DNS flip
  // and the swap save: an old primary that reboots unreached refuses its own
  // pushes once it reads this. On resume it is written again (idempotent).
  const fenceWrite = await writeFence(servers, sshKeyPath);
  if (!fenceWrite.ok) p.log.warn(backupFenceWarning(servers.standby.ip, fenceWrite.reason));
  recordFence({ environment: envName }, fenceWrite);

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
  // Each verdict on its own: the old primary is disarmed whatever the promoted
  // side's outcome, and a failed disarm is named even when the arm is clean.
  s.stop(
    `${
      backupHealth.promoted.ok
        ? 'wal-g write-guard moved, promoted cluster is archiving'
        : 'wal-g write-guard NOT confirmed on the promoted cluster'
    }; ${backupHealth.demoted.ok ? 'old primary disarmed' : 'old primary NOT disarmed'}`,
  );
  if (!backupHealth.promoted.ok) {
    p.log.error(
      walgRoleDegradedMessage({
        path: 'k8s',
        envName,
        promotedIp: servers.standby.ip,
        detail: walgVerdictsDetail(backupHealth),
      }),
    );
  }

  // STEP 5 — Scale up the promoted app tier from the persisted list ('up' = each
  // entry's own deploy-rendered replica count), on the promoted cluster. The
  // primary-only add-ons (n8n, metabase) are held back to STEP 6c: they run
  // cron and webhooks against the database, so they start only once the old
  // primary's copies are scaled down. Add-ons that follow the app tier (redis)
  // come up with it.
  const primaryOnlyKeys = new Set(
    k8sPrimaryOnlyWorkloads(declaredAddonNames()).map((w) => `${w.namespace}/${w.name}`),
  );
  const isPrimaryOnly = (dep) =>
    dep.addon === true && primaryOnlyKeys.has(`${dep.namespace || 'vibecarbon'}/${dep.name}`);
  const primaryOnlyAddons = scaleUpList.filter(isPrimaryOnly);
  s.start('Scaling up the promoted app tier');
  await scale(
    servers.standby.ip,
    sshKeyPath,
    scaleUpList.filter((dep) => !isPrimaryOnly(dep)),
    'up',
    'scale up promoted app tier',
  );
  s.stop('Promoted app tier scaled up');

  // STEP 5b — Single-ACME-issuer policy, promote half (d4 2026-08-28): the
  // pilot-standby deploy pointed this cluster's Certificate at the local
  // self-signed issuer so two clusters never solve DNS-01 for the same names
  // (cert-manager's DO solver keys challenge records by NAME — concurrent
  // issuers live-lock). Patch issuerRef back to the ACME issuer stamped in
  // the promote annotation NOW, so real-cert issuance overlaps the rollout
  // gate below and this cluster becomes the SOLE ACME solver. Runs before
  // the gate on purpose; best-effort inside (a promoted site serving on the
  // self-signed cert is strictly better than an aborted failover, and the
  // reconverge redeploy repairs issuer ownership).
  s.start('Promoting ACME issuer on the promoted cluster');
  const promoted = await promoteIssuer({ promotedIp: servers.standby.ip, sshKeyPath });
  s.stop(
    promoted.patched.length > 0
      ? `ACME issuer promoted (${promoted.patched.join(', ')})`
      : 'ACME issuer already in place',
  );

  // STEP 6 — Readiness gate: rollout-status each scaled deployment on the
  // promoted cluster, then gate on the public API actually serving. Best-effort;
  // for manual DNS the probe still works via `--resolve …:127.0.0.1`.
  await gate(domain, servers.standby.ip, sshKeyPath, s, { scaleUpList });

  // STEP 6b — Split-brain prevention (UNPLANNED only, best-effort). In planned
  // mode the primary is already quiesced; when it was unreachable we could not
  // quiesce pre-promotion, so scale its app tier down NOW — after the gate,
  // BEFORE the DNS flip. If the old primary is still unreachable this no-ops.
  // An old cluster that answered but did not scale everything down may still
  // run its primary-only add-ons: starting ours too would fire the same cron
  // and webhooks twice, so STEP 6c holds them back. One that never answered
  // keeps today's behaviour (it is fenced when it comes back).
  let oldPrimaryStillWriting = false;
  if (!planned) {
    s.start('Scaling down the old primary app tier (best-effort split-brain prevention)');
    const down = await scale(
      servers.primary.ip,
      sshKeyPath,
      scaleUpList,
      0,
      'scale-down old primary (best-effort)',
    );
    oldPrimaryStillWriting = Boolean(down?.reached && down.failed?.length > 0);
    s.stop(
      oldPrimaryStillWriting
        ? `Old primary app tier NOT fully scaled down (${down.failed.join(', ')})`
        : 'Old primary app tier scaled down (best-effort)',
    );
  }

  // STEP 6c — Start the primary-only add-ons on the promoted cluster, now that
  // the old primary's are scaled down (unplanned, STEP 6b, a no-op when it is
  // unreachable) or quiesced (planned, STEP 2). Starting them earlier would
  // leave two n8n instances firing the same cron and webhooks while the old
  // primary still answers. Not awaited here: checkPromotedAddonRollouts names
  // a slow one after the DNS flip.
  if (primaryOnlyAddons.length > 0 && oldPrimaryStillWriting) {
    const startCmd = primaryOnlyAddons
      .map(
        (d) =>
          `kubectl -n ${d.namespace || 'vibecarbon'} scale deployment/${d.name} --replicas=${d.replicas ?? 1}`,
      )
      .join(' && ');
    p.log.warn(
      `Not starting the primary-only add-ons (${primaryOnlyAddons.map((d) => d.name).join(', ')}) ` +
        `on the promoted cluster: the old primary (${servers.primary.ip}) answered but did not ` +
        'scale everything down, so both would run them. Once its app tier and add-ons are at ' +
        `zero, start them: ssh root@${servers.standby.ip} '${startCmd}'`,
    );
  } else if (primaryOnlyAddons.length > 0) {
    s.start('Starting the primary-only add-ons on the promoted cluster');
    await scale(
      servers.standby.ip,
      sshKeyPath,
      primaryOnlyAddons,
      'up',
      'start primary-only add-ons on the promoted cluster',
    );
    s.stop(`Primary-only add-ons scaled up: ${primaryOnlyAddons.map((d) => d.name).join(', ')}`);
  }

  // STEP 7 — Switch apex + wildcard A records to the standby floating IP.
  // Manual DNS skips this — instructions are printed in the epilogue.
  let dnsFlip = { ok: true };
  if (strategy.updateDns) {
    s.start('Updating DNS A record');
    dnsFlip = await flipAndVerifyDns({
      update: () => strategy.updateDns(auth, domain, standbyFloatingIp),
      read: (name) => strategy.readDns(auth, name),
      domain,
      ip: standbyFloatingIp,
    });
    if (dnsFlip.ok) {
      s.stop(`DNS updated and verified: ${domain} → ${standbyFloatingIp}`);
    } else {
      s.stop('DNS update not confirmed');
      p.log.error(dnsFlip.reason);
    }
  }

  // TERMINAL WRITE: persist the role swap LAST, after the DNS flip. A rerun
  // BEFORE this point keeps the ORIGINAL direction (identifyServers reads the
  // unswapped config), so a mid-flow crash re-runs the SAME failover, and the
  // journal written before the promote lets that rerun resume instead of
  // promoting again. The same save clears the journal. One write, here.
  // On resume the override was recorded by the run that skipped the proof.
  const override = unproven
    ? 'force-unproven'
    : mode === 'resume'
      ? envConfig?.ha?.failoverInFlight?.override
      : undefined;
  swapRoles(envName, override ? { override } : undefined);
  // The old primary is now the retired side: fence it (marker, app at zero,
  // WALG_ROLE=standby) if it answers. One that does not is fenced by the next
  // status, failover or deploy that reaches it, before it can push a backup.
  // Never fails the failover: it has completed, and the terminal checks below
  // must still report.
  try {
    await reconcileRetired();
  } catch (err) {
    p.log.warn(
      `could not fence the retired node (${String(err?.message ?? err).split('\n')[0]}); the ` +
        'next status, failover or deploy that reaches it fences it',
    );
  }

  // Every add-on's rollout, now that it no longer holds the outage open.
  // Warn-only: a not-ready add-on never fails a completed failover.
  if (scaleUpList.some((dep) => dep.addon === true)) {
    s.start('Checking the add-on rollouts on the promoted cluster');
    try {
      const { notReady } = await addonRollouts(servers.standby.ip, sshKeyPath, scaleUpList);
      s.stop(
        notReady.length === 0
          ? 'Add-ons rolled out on the promoted cluster'
          : `Add-ons not ready yet: ${notReady.join(', ')}`,
      );
    } catch (err) {
      s.stop('Add-on rollouts not checked');
      p.log.warn(`could not check the add-on rollouts: ${firstErrorLine(err)}`);
    }
  }

  if (!dnsFlip.ok) {
    p.log.warn(
      'The standby is promoted and the roles are saved, but DNS still points at the old primary.',
    );
  } else if (strategy.updateDns) {
    p.log.success('Failover complete');
    p.log.info(c.bold('Recovery instructions:'));
    p.log.message(
      `  Re-run \`vibecarbon deploy ${envName}\`; it converges the recovered ex-primary ` +
        `(${servers.primary.ip}) to pilot-light and re-establishes streaming.`,
    );
    p.log.message(
      `  If ${servers.primary.ip} was down, run \`vibecarbon status ${envName}\` as soon as it ` +
        'answers: that fences it (backups and writes refused) before it can push a backup.',
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
  if (!dnsFlip.ok) {
    throw new FailoverDnsError(
      dnsDidNotMessage({ domain, ip: standbyFloatingIp, reason: dnsFlip.reason }),
    );
  }
  if (!backupHealth.promoted.ok) {
    throw new Error(
      walgRoleDegradedMessage({
        path: 'k8s',
        envName,
        promotedIp: servers.standby.ip,
        detail: walgVerdictsDetail(backupHealth),
      }),
    );
  }
}

// ============================================================================
// FAILOVER: SINGLE SERVER (RECOVERY GUIDE)
// ============================================================================

async function failoverSingleServer(envName, envConfig) {
  p.log.warn('This environment has no standby region');
  p.log.info('Recovery requires deploying a new server and restoring from backup');

  // The restorable base backups, read from the backup bucket's stop sentinels
  // (the listing restore resolves from). Never SSH: the server may be the
  // thing that is gone. The legacy `/backups/*_full.tar.gz` + `*.sql.gz`
  // objects are not wal-g backups and restore cannot replay them, so they are
  // never offered here.
  const s = spinner();
  s.start('Checking for available backups');
  const projectName = loadProjectConfig()?.projectName || 'project';
  try {
    const listing = await readEnvBaseBackups({
      envName,
      envConfig,
      projectName,
      // A recovery guide never stops to ask: env vars or nothing.
      skipPrompts: true,
    });
    s.stop('Backup check complete');
    if (listing.s3Config) {
      printBaseBackupList({
        backups: listing.backups,
        envName,
        location: listing.location,
        limit: 5,
      });
    } else {
      p.log.info(
        `Export ${backupCredentialVars(envConfig)} to list the backups ${c.info(`vibecarbon restore ${envName}`)} can use.`,
      );
    }
  } catch (err) {
    s.stop('Backup check failed');
    p.log.warn(
      `Could not read the base backups from the backup bucket: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  p.log.info(c.bold('Recovery steps:'));
  p.log.message(`  1. ${c.info(`vibecarbon deploy ${envName}`)}`);
  p.log.message(`  2. ${c.info(`vibecarbon restore ${envName}`)}`);
  p.log.message(`  3. ${c.info(`vibecarbon status ${envName}`)}`);
  p.log.info('To enable HA for one-command failover in the future:');
  p.log.message(`  ${c.info(`vibecarbon deploy ${envName} -mode compose-ha`)}`);
}

// ============================================================================
// ABORT
// ============================================================================

/**
 * `vibecarbon failover <env> -abort`, both HA tiers. Refuses on a non-HA env,
 * and (inside abortFailover) when no journal is set or the standby's database
 * cannot be proven down.
 *
 * @param {{ envName: string, envConfig: object, projectConfig: object, parsed: object }} args
 * @param {object} [deps] test seams: backend, abort
 */
export async function runFailoverAbort({ envName, envConfig, projectConfig, parsed }, deps = {}) {
  const tier = haTierOf(envConfig);
  if (!tier) {
    p.log.error(`-abort applies to an HA environment only; ${envName} has no standby`);
    process.exit(1);
  }
  const { abort = abortFailover } = deps;
  p.log.info(c.bold('This will (call off the failover in flight):'));
  p.log.message("  1. Stop the standby's database and prove it down, so it cannot promote");
  p.log.message('  2. Point DNS back at the old primary (managed DNS)');
  p.log.message("  3. Lift the old primary's write fence and start its app tier");
  p.log.message('  4. Clear the failover journal and mark replication degraded');
  if (parsed.dryRun) {
    p.log.info(c.dim('Dry run: no changes made'));
    return;
  }
  // No journal: abortFailover refuses and says why, with nothing to confirm.
  if (envConfig?.ha?.failoverInFlight && !parsed.yes) {
    const confirm = await p.confirm({
      message: `Call off the failover of ${c.bold(envName)} and keep the old primary?`,
    });
    if (p.isCancel(confirm)) exitCancelled();
    if (!confirm) exitDeclined();
  }
  let backend = deps.backend;
  if (!backend) {
    if (tier === 'compose-ha') {
      const { composeFailoverAbortBackend } = await import('./lib/deploy/compose/ha.js');
      backend = composeFailoverAbortBackend({
        envName,
        envConfig,
        projectName: projectConfig.projectName,
        sshKeyPath: getSSHKeyPath(envName),
      });
    } else {
      const scenario = detectScenario(envConfig);
      backend = k8sFailoverAbortBackend({
        envName,
        envConfig,
        strategy:
          scenario === 'ha_dns' ? dnsStrategyFor(envConfig.dns.provider) : MANUAL_DNS_STRATEGY,
      });
    }
  }
  await abort({
    environment: envName,
    envConfig,
    backend,
    log: (line) => p.log.info(line),
    warn: (line) => p.log.warn(line),
  });
  p.outro(c.success('Done'));
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
    confirm: values.confirm ?? undefined,
    // Pilot-light failover worker server-type override. Consumed by
    // Task 10's provisioning step (provisionStandbyCapacity's
    // serverTypeOverride) — null means "use the persisted standbyWorkerSpec".
    serverType: values['server-type'] || null,
    forceUnproven: !!values['force-unproven'],
    forceUnplanned: !!values['force-unplanned'],
    allowDegraded: !!values['allow-degraded'],
    abort: !!values.abort,
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

  // -abort: call off a failover whose journal is set (failover-abort.js). It
  // keeps the old primary, so it runs before the retirement fence and every
  // promote step, behind the same production confirmation as a failover.
  if (parsed.abort) {
    if (!parsed.dryRun && envConfig?.ha?.failoverInFlight) {
      await confirmProdOrExit(envName, {
        actionLabel: 'failover -abort',
        yes: !!parsed.yes,
        confirm: parsed.confirm,
      });
    }
    await runFailoverAbort({ envName, envConfig, projectConfig, parsed });
    return;
  }

  // Re-apply the retirement fence first (R7): a side a past failover retired
  // that has come back must refuse its backups before anything else runs.
  if (!parsed.dryRun) {
    const haTier = haTierOf(envConfig);
    if (haTier) {
      await reconcileRetiredFence({ environment: envName, envConfig, projectConfig, tier: haTier });
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
    await confirmProdOrExit(envName, {
      actionLabel: 'failover',
      yes: !!parsed.yes,
      confirm: parsed.confirm,
    });
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
// waitForPromotedApiServing, promotedProbeArgv,
// preflightPilotFailover, provisionStandbyCapacity, and AbortProvisioningError
// are exported inline at their definitions above.)
export { getReplPasswordFromSecret, reseedStandbyFromPrimary, reseedStandbyOrAbort, SPEC };
