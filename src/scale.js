/**
 * Vibecarbon Scale Command
 *
 * Adjust instance types post-deploy without re-running the full deploy
 * flow. Interactive-by-default; bare `vibecarbon scale` walks the
 * operator through env → role → server-type prompts. Power users can
 * seed env via `-env <name>` (or positional) and server type via
 * `-type <id>` for fully-scripted scaling.
 *
 * Form rule: vibecarbon uses single-dash flags only — see
 * memory:feedback_cli_single_dash_flags. Worker-bound flags
 * (--min-workers / --max-workers) are gone; the interactive bounds
 * prompt covers that need without tying up two top-level letters.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { getGHCRCredentials } from './lib/build.js';
import { exitCancelled, exitDeclined } from './lib/cli/exit-guard.js';
import { introCommand } from './lib/cli/intro.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { spinner } from './lib/cli/progress.js';
import { primaryEntryServerType, resolvePrimary } from './lib/cli/resolve-primary.js';
import { requireTTYOrFlags } from './lib/cli/tty-guard.js';
import { c, link } from './lib/colors.js';
import { runCommand } from './lib/command.js';
import { updateProjectConfig } from './lib/config.js';
import { useDnsChallenge } from './lib/deploy/acme.js';
import { RECONCILE_FLAGS_SED, STANDBY_SCALE_FLAG } from './lib/deploy/bundle.js';
import { collectComposeBuildArgs } from './lib/deploy/compose/build-args.js';
import { composePsqlRunner, demoteComposeWalgRole } from './lib/deploy/compose/ha.js';
import { composeHaStackOf } from './lib/deploy/compose/ha-role-swap.js';
import {
  backupCompose,
  dockerLoginOnServer,
  isLocalOnlyImageTag,
  pullComposeImages,
  restoreCompose,
  setupComposeBackupCron,
  setupServer,
  setupServerFiles,
  startComposeStack,
  waitForSSH,
} from './lib/deploy/compose/index.js';
import {
  fenceComposePrimary,
  rejoinComposeStandby,
  removeComposeBackupCron,
  rollbackComposeCutover,
  writeComposeReplicationOverlay,
} from './lib/deploy/compose/scale-cutover.js';
import {
  assertComposeScaleKeepsState,
  describeOldServer,
  markPendingServerOldDeleted,
  recordPendingServerState,
  resolveServerStateOptions,
  scaledServerStateEntry,
  serverStateRecovery,
  syncScaledServerState,
} from './lib/deploy/compose/server-state-sync.js';
import {
  readLiveApexCertificate,
  restoreComposeTls,
  tlsRestoreLine,
} from './lib/deploy/compose/tls-restore.js';
import { resolveDockerHubCreds } from './lib/deploy/docker-hub.js';
import { preserveSafetyFields } from './lib/deploy/env-safety-fields.js';
import { assertNoFailoverInFlight } from './lib/deploy/failover-guard.js';
import { runPlan } from './lib/deploy/plan/runner.js';
import { planScale } from './lib/deploy/plan/scale-plan.js';
import { buildRemote } from './lib/deploy/remote-build.js';
import { isRetiredSide } from './lib/deploy/retired-fence.js';
import { haStacksFrom } from './lib/deploy/standby-types.js';
import { isHATier, resolveTier } from './lib/deploy/tier-registry.js';
import { DEFAULT_WORKER_MAX, DEFAULT_WORKER_MIN } from './lib/deploy/utils.js';
import {
  clearScaleCutoverJournal,
  clearWriteFenceMarker,
  markScaleCutoverStep,
  scaleCutoverNextStep,
  writeScaleCutoverJournal,
} from './lib/deploy/write-fence.js';
import { waitForDNSPropagation } from './lib/dns-propagation.js';
import {
  DNS_PROVIDERS,
  getDnsProvider,
  hasAutomatedDns,
  resolveDnsToken,
} from './lib/dns-provider.js';
import { dotenvValueProblem, parseDotenv } from './lib/dotenv.js';
import { convergeClusterInfra } from './lib/iac/converge-cluster.js';
import { ensureOperatorIpAccess } from './lib/operator-ip.js';
import { perfAsync } from './lib/perf.js';
import { repairLegacyEnvQuoting } from './lib/project.js';
import { runProjectAssignment } from './lib/project-assignment.js';
import { assertInProjectDir } from './lib/project-guard.js';
import { providerFor, providerIdFor, resolveProviderToken } from './lib/providers/index.js';
import { pollUntil } from './lib/retry.js';
import { assertPersistedRoleTypes, planK8sScaleChanges } from './lib/scale-plan.js';
import { buildComposeTypeOptions, buildSimpleTypeOptions } from './lib/server-types.js';
import {
  ADDON_JOB_SCRIPT,
  addonJobStartCmd,
  addonJobStopCmd,
  mintAttemptId,
} from './lib/services/addon-start.js';
import { enabledAddonNames } from './lib/services/standby-policy.js';
import { sshRun, sshRunScript } from './lib/ssh.js';
import { pushBaseBackupAfterPromote } from './lib/walg/post-promote-backup.js';
import { buildRecoveryConfig, renderRecoveryConf } from './lib/walg/recovery-config.js';
import {
  backupCredentialVars,
  readEnvBaseBackups,
  resolveS3Config,
} from './lib/walg/restore-base.js';
import { LINEAGE_RE } from './lib/walg/restore-layout.js';
import { assertRestoredPrimaryWritable } from './lib/walg/restore-marker.js';

// ============================================================================
// COMMAND SPEC — single source of truth for argv parsing AND help output.
// ============================================================================

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, description?: string, examples?: Array<{ command: string, description?: string }> }} */
const SPEC = {
  name: 'scale',
  summary: 'Scale worker nodes and instance sizes',
  description: [
    'What you can change:',
    '  Compose / Compose HA   VPS server type (blue-green; the app pauses for the cutover)',
    '  Kubernetes             Worker / master / database server types (in-place)',
    '  Kubernetes             Worker bounds (autoscaler floor + ceiling)',
  ].join('\n'),
  positional: [
    {
      name: 'env',
      optional: true,
      description: 'Environment to scale (skips the env prompt)',
    },
  ],
  flags: [
    { name: 'h', boolean: true, description: 'Show this help' },
    { name: 'v', boolean: true, description: 'Show version' },
    { name: 'y', boolean: true, description: 'Skip confirmations (required with -type)' },
    { name: 'env', value: '<name>', description: 'Environment seed (alternative to positional)' },
    {
      name: 'type',
      value: '<id>',
      description:
        "Server type to scale to, from the environment's own provider catalog (e.g. cx33 on Hetzner, s-4vcpu-8gb on DigitalOcean). Compose: resizes the VPS. K8s: resizes all roles.",
    },
  ],
  examples: [
    { command: 'vibecarbon scale', description: 'prompts for env and changes' },
    { command: 'vibecarbon scale prod', description: 'env seeded; prompts for changes' },
    {
      command: 'vibecarbon scale -env prod -type cx33 -y',
      description: 'scripted: resize all roles to cx33',
    },
  ],
};

// ============================================================================
// HA GATES
// ============================================================================

/**
 * Refuse to scale a side a failover retired that no deploy has rebuilt yet.
 * A resize reboots (or replaces) the node, and a stale ex-primary that boots
 * comes back believing it is the primary until the retirement fence reaches
 * it again. The deploy that rebuilds it as the standby comes first.
 *
 * @param {{ environment: string, envConfig: object, targetIps: string[] }} args
 */
export function assertScaleNotRetired({ environment, envConfig, targetIps }) {
  const retired = targetIps.filter((ip) => isRetiredSide(envConfig, ip));
  if (retired.length === 0) return;
  throw new Error(
    `Refusing to scale "${environment}": a failover retired ${retired.join(', ')} and no deploy ` +
      `has rebuilt it as the standby, so a resize would boot a stale ex-primary. run vibecarbon ` +
      `deploy ${environment} first, then scale`,
  );
}

/** Run an HA gate: its refusal is one error line and exit 1, before any prompt or cloud call. */
function refuseOrContinue(gate) {
  try {
    gate();
  } catch (err) {
    p.log.error(err.message);
    process.exit(1);
  }
}

// ============================================================================
// COMPOSE SCALING
// ============================================================================

async function scaleCompose(environment, envConfig, projectConfig, options = {}) {
  const tier = options.tier || resolveTier(envConfig);
  const servers = envConfig.servers || [];
  const projectName = projectConfig.projectName;
  // Resolved once per flow — see providerFor() in lib/providers/index.js.
  const Provider = providerFor(envConfig);

  // `s.id` is the Hetzner-assigned numeric server id, persisted by the
  // orchestrator on every API-provisioned compose deploy. Servers not
  // provisioned through the Hetzner API (pre-existing VPSes) legitimately
  // have no id and can't be resized through the API — the user has to
  // resize via the provider console.
  //
  // Pre-release scope: there is intentionally no fallback to
  // `providerServerName` lookup or to .vibecarbon.json shapes that predate
  // the id-persistence fix. If you see this message after a fresh
  // `vibecarbon deploy` against an automated provider, your
  // .vibecarbon.json is from before the fix landed — re-deploy to refresh
  // the shape (it's pre-release; re-deploys are cheap).
  const resizableServers = servers.filter((s) => s.id);
  if (resizableServers.length === 0) {
    p.log.info('No servers with a provider id found in .vibecarbon.json.');
    p.log.info(
      'If this server was not provisioned by vibecarbon: resize it through your provider console.',
    );
    p.log.info('If you used automated provisioning: re-run `vibecarbon deploy` to refresh.');
    p.outro('');
    return;
  }

  // Before any prompt or server: the replacement must be one Pulumi state can
  // follow, or the next deploy builds a second server.
  refuseOrContinue(() => assertComposeScaleKeepsState({ environment, envConfig }));

  // Get API token
  const apiToken = await Provider.promptApiToken(projectName);
  if (!apiToken) {
    p.log.error('API token required for server scaling');
    process.exit(1);
  }

  // The Pulumi backend the scale points at the replacement once the old
  // server is gone (server-state-sync.js). Resolved now: missing keys refuse
  // before anything is built, not after the old server is deleted.
  let serverStateOptions;
  try {
    serverStateOptions = await resolveServerStateOptions({
      envConfig,
      projectName,
      Provider,
      apiToken,
    });
  } catch (err) {
    p.log.error(err.message);
    process.exit(1);
  }

  // Ensure operator IP is in the firewall allowlist before any SSH work.
  try {
    const isHA = isHATier(tier);
    const result = await ensureOperatorIpAccess({
      projectConfig,
      environment,
      isHA,
      apiToken,
      yes: !!options.yes,
      onMessage: (msg) => p.log.info(msg),
    });
    if (result.added) {
      p.log.success(`Firewall updated: SSH now allows ${result.cidr}`);
    }
  } catch (err) {
    p.log.error(`Operator-IP check failed: ${err.message}`);
    process.exit(1);
  }

  // A scale that stopped mid-cutover is resumed before anything new: its
  // journal names both servers, and the config may still name the old one.
  if (envConfig.ha?.writeFence?.cutover) {
    const dnsProviderId = envConfig.dnsProvider || envConfig.dns?.provider || null;
    const resumeCtx = {
      tier,
      environment,
      envConfig,
      projectConfig,
      projectName,
      provider: new Provider(apiToken),
      Provider,
      sshKeyPath: join(process.cwd(), '.vibecarbon', `deploy_key_${environment}`),
      domain: envConfig.domain || null,
      dnsChallenge: useDnsChallenge(dnsProviderId),
      apiToken,
      region: envConfig.region,
      services: projectConfig.services || {},
      serverStateOptions,
    };
    const outcome = await resumeComposeCutover(resumeCtx);
    const problems = resumeCtx.resumeProblems ?? [];
    if (outcome === 'finished' && resumeCtx.serverStateProblems?.length) {
      p.outro(
        `${c.warning('Scale finished, but Pulumi state still names the old server.')} ` +
          `The new server serves; ${serverStateRecovery(environment)}.`,
      );
      process.exitCode = 1;
    } else if (outcome === 'finished') {
      p.outro(
        `${c.success('Scale finished.')} The new server serves; rerun scale for another change.`,
      );
    } else if (problems.length === 0) {
      p.outro(
        `${c.success('Scale rolled back.')} The old server serves again; rerun scale to try again.`,
      );
    } else {
      p.outro(
        `${c.warning('Scale rolled back with problems.')} The new server is gone; ` +
          `${problems.length} problem(s) above still need fixing on the old server before it serves.`,
      );
      process.exitCode = 1;
    }
    return;
  }

  // Fetch live server types (drives the per-region type/profile options below)
  const typesSpinner = spinner();
  typesSpinner.start('Fetching available server types...');
  await Provider.fetchServerTypes(apiToken);
  typesSpinner.stop('Server types loaded');

  const region = envConfig.region || 'fsn1';
  // Region-aware rather than a hardcoded SKU: the default region here is fsn1,
  // where `cpx21` (the previous literal) stopped being orderable on 2026-01-01,
  // so it seeded the picker's initialValue with a type the region no longer
  // sells. getRegionDefaults tracks the live catalog and the EU/US split.
  // composeType, never dbType: the k8s db is a 2 GB role, and a default-sized
  // compose box (no persisted serverType) was deployed on composeType. An env
  // deployed before the top-level record keeps its size on the server entry.
  const currentType =
    envConfig.serverType ||
    primaryEntryServerType(envConfig) ||
    Provider.getRegionDefaults(region).composeType;

  // Display current configuration
  const pad = 18;
  const configLines = [
    `${'Environment'.padEnd(pad)} ${c.bold(environment)}`,
    `${'Deploy mode'.padEnd(pad)} ${c.bold(envConfig.deployMode)}`,
    `${'Region'.padEnd(pad)} ${c.bold(region)}`,
    `${'Server type'.padEnd(pad)} ${c.bold(currentType)}`,
  ];
  for (const server of servers) {
    const role = server.role ? ` (${server.role})` : '';
    const id = server.id ? ` [id: ${server.id}]` : ' [no provider id, not scalable]';
    configLines.push(`${'Server'.padEnd(pad)} ${server.ip}${role}${id}`);
  }
  p.note(configLines.join('\n'), 'Current Configuration');

  // For compose-ha: select which server(s) to scale
  let targetServers = resizableServers;
  if (isHATier(tier) && resizableServers.length > 1) {
    const primaryServer = resizableServers.find((s) => s.role === 'primary');
    const standbyServer = resizableServers.find((s) => s.role === 'standby');

    // Non-interactive: default to both servers when -y is set
    let target;
    if (options.yes) {
      target = 'both';
      p.log.info('Scaling both primary and standby servers');
    } else {
      target = await p.select({
        message: 'Which server(s) to scale?',
        options: [
          { value: 'both', label: 'Both primary and standby', hint: 'recommended' },
          ...(primaryServer
            ? [{ value: 'primary', label: `Primary only (${primaryServer.ip})` }]
            : []),
          ...(standbyServer
            ? [{ value: 'standby', label: `Standby only (${standbyServer.ip})` }]
            : []),
        ],
      });
      if (p.isCancel(target)) {
        exitCancelled();
      }
    }

    if (target === 'primary') targetServers = primaryServer ? [primaryServer] : [];
    else if (target === 'standby') targetServers = standbyServer ? [standbyServer] : [];
  }
  if (isHATier(tier)) {
    refuseOrContinue(() =>
      assertScaleNotRetired({
        environment,
        envConfig,
        targetIps: targetServers.map((sv) => sv.ip).filter(Boolean),
      }),
    );
  }

  // Select new server type
  const regionTypes = Provider.getServerTypesForRegion(region);
  const typeOptions = buildComposeTypeOptions(regionTypes, currentType);

  let newType;
  if (options.type) {
    newType = options.type;
    p.log.info(`Using target server type: ${c.bold(newType)}`);
  } else {
    newType = await p.select({
      message: 'New server type:',
      options: typeOptions,
      initialValue: currentType,
    });
    if (p.isCancel(newType)) {
      exitCancelled();
    }
  }

  if (newType === currentType) {
    p.log.info(`Already using ${c.bold(currentType)}, nothing to change.`);
    p.outro('');
    return;
  }

  const services = projectConfig.services || {};
  p.note(`Current ${Provider.NAME} pricing: ${link(Provider.PRICING_URL)}`, 'Cost');

  // Confirmation
  const serverLabel =
    targetServers.length > 1 ? `${targetServers.length} servers (one at a time)` : '1 server';
  p.log.info(
    `This will create a new ${c.bold(newType)} server, migrate data, and destroy the old one.`,
  );
  p.log.info(
    'Your app pauses while its database moves, from the write fence to the DNS flip. Scale prints how long.',
  );

  const confirmed =
    options.yes ||
    (await p.confirm({
      message: `Scale ${serverLabel} from ${currentType} to ${newType}?`,
    }));
  // Ctrl-C/ESC and an explicit "no" are different answers: one is an
  // interrupt, the other a considered refusal. Both stop the run.
  if (p.isCancel(confirmed)) {
    exitCancelled();
  }
  if (!confirmed) {
    exitDeclined();
  }

  // Prepare shared resources
  const provider = new Provider(apiToken);
  const sshKeyPath = join(process.cwd(), '.vibecarbon', `deploy_key_${environment}`);
  const sshPubKeyPath = `${sshKeyPath}.pub`;
  const domain = envConfig.domain || null;
  // Managed-DNS (cloudflare/hetzner) deploys issue certs via ACME DNS-01, so
  // the new/recreated server needs the DNS-01 Traefik override and has no
  // HTTP-01 race to wait on or reset. `manual` keeps HTTP-01.
  const dnsProvider = envConfig.dnsProvider || envConfig.dns?.provider || null;
  const dnsChallenge = useDnsChallenge(dnsProvider);

  // Read the SSH public key here (sync, no side effect); the actual Hetzner
  // registration (network I/O) is the plan's `register-ssh-key` step.
  // Project + environment is already a unique key in Hetzner; no need for
  // an extra `vibecarbon-` prefix. The SSH key here is created by the
  // initial deploy under a Pulumi-named key (`${projectName}-${env}-${region}-key`)
  // and createSSHKey dedups by public-key bytes regardless of the requested
  // name, so the `name` we pass is mostly cosmetic — keep it aligned with
  // the rest of the codebase.
  const sshPubKey = readFileSync(sshPubKeyPath, 'utf-8').trim();
  const sshKeyName = `${projectName}-${environment}-key`;

  // Everything from here on is the tier's scale EXECUTION (register key →
  // blue-green replace every target server → persist config → outro),
  // expressed as a pure step-plan (planScale) run against the SCALE_EFFECTS
  // registry below. ctx carries every value the effects need; `scale-servers`
  // mutates `server._replacement` on the scaled entries of `ctx.servers`
  // (targetServers is a filtered VIEW over the same objects), which
  // `update-project-config` reads back.
  const ctx = {
    tier,
    environment,
    envConfig,
    projectConfig,
    projectName,
    region,
    currentType,
    newType,
    servers,
    targetServers,
    provider,
    Provider,
    sshKeyPath,
    sshPubKey,
    sshKeyName,
    domain,
    dnsProvider,
    dnsChallenge,
    apiToken,
    services,
    serverStateOptions,
    // This scale's attempt id (services/addon-start.js): the new server's
    // add-on job writes it, and the cutover saves it once that job is
    // relaunched on the serving server.
    attemptId: mintAttemptId(),
  };
  await runPlan(planScale(tier, envConfig), ctx, SCALE_EFFECTS);
}

/** compose/compose-ha `register-ssh-key` effect: register (or reuse — Hetzner
 *  dedups by public-key bytes) the SSH key both the new server(s) need. Sets
 *  ctx.sshKeyId for `scale-servers` to read. */
async function scaleRegisterSshKey(ctx) {
  const { provider, Provider, sshKeyName, sshPubKey } = ctx;
  const prep = spinner();
  prep.start(`Registering SSH key with ${Provider.NAME}...`);
  ctx.sshKeyId = await provider.createSSHKey(sshKeyName, sshPubKey);
  prep.stop('SSH key ready');
}

/**
 * Build the `provider.createServer()` args for a compose-tier replacement
 * server — the scale/replacement path's blue-green new-server provision.
 * This path calls `createServer()` directly, bypassing the provider's
 * Pulumi program (`getComposeProgram`) entirely, so image + user-data must
 * be resolved from the Provider class's own `COMPOSE_IMAGE` /
 * `getComposeUserData()` (see base.js's "Compose-tier replacement-server
 * identity" doc block) rather than an implicit, Hetzner-shaped default —
 * omitting `image` here previously relied on HetznerProvider.createServer's
 * own `image || 'docker-ce'` fallback, which sent DigitalOcean's droplet
 * create with NO image field at all (d1 regression: "invalid image for
 * Droplet creation").
 * @param {typeof import('./lib/providers/base.js').BaseProvider} Provider
 * @param {object} args
 * @param {string} args.name
 * @param {string} args.serverType
 * @param {string} args.region
 * @param {string|number} args.sshKeyId
 * @param {string} [args.firewallId]
 * @param {string} args.projectName
 * @param {string} args.environment
 * @returns {Promise<object>} args ready to pass to `provider.createServer()`
 */
export async function buildReplacementServerArgs(
  Provider,
  { name, serverType, region, sshKeyId, firewallId, projectName, environment },
) {
  return {
    name,
    serverType,
    region,
    image: Provider.COMPOSE_IMAGE,
    sshKeys: [sshKeyId],
    firewalls: firewallId ? [firewallId] : [],
    userData: await Provider.getComposeUserData(),
    labels: {
      'managed-by': 'vibecarbon',
      project: projectName,
      environment,
    },
  };
}

/**
 * The subset of an old server's parsed `.env` that `renderBundle` can
 * re-encode. Each dropped key gets one warning naming the key and the reason
 * (never the value) and the command to set it again. `log` is injectable for
 * tests. Pure: returns a new object, never mutates `env`.
 * @param {Record<string, string>} env
 * @param {{ log?: { warn: (m: string) => void } }} [opts]
 * @returns {Record<string, string>}
 */
export function dropUnportableEnv(env, { log = p.log } = {}) {
  const kept = {};
  for (const [key, value] of Object.entries(env)) {
    const problem = dotenvValueProblem(key, value);
    if (problem) {
      log.warn(
        `${key} on the old server cannot be carried over: ${problem}; set it again with \`vibecarbon configure\``,
      );
      continue;
    }
    kept[key] = value;
  }
  return kept;
}

/** What the old server prints instead of app.env when it has none. */
export const NO_APP_ENV_MARKER = '__VC_NO_APP_ENV__';

/**
 * The old server's `app.env`, for the scale replay: it holds the storage pair
 * the old app used, which need not be the `.env`'s (the db's WAL-G pair, and
 * on an isolated or fenced env the app's own key, security plan R2).
 *
 * `null` only when the server answers that it has no app.env (the remote
 * marker): a server deployed before app.env existed gave its app the whole
 * `.env`, so renderBundle carries the pair from the replayed `.env`, which is
 * what that app read. A read that FAILS throws instead: guessing would hand
 * the new app the `.env`'s infra pair, the account-wide key, so the caller
 * aborts that server's scale (its catch deletes the new server).
 * `run` and `log` are injectable for tests.
 * @param {string} ip
 * @param {string} sshKeyPath
 * @param {string} projectName
 * @param {{ run?: typeof sshRun, log?: { warn: (m: string) => void } }} [opts]
 * @returns {Promise<Record<string, string> | null>}
 */
export async function readOldAppEnv(
  ip,
  sshKeyPath,
  projectName,
  { run = sshRun, log = p.log } = {},
) {
  let text;
  try {
    text = await run(ip, sshKeyPath, [
      'sh',
      '-c',
      `if [ -f "$1" ]; then cat "$1"; else printf '%s' ${NO_APP_ENV_MARKER}; fi`,
      'sh',
      `/opt/${projectName}/app.env`,
    ]);
  } catch (err) {
    throw new Error(
      `could not read app.env on the old server ${ip} (${err.message}), so scale stopped rather than give the new app the account-wide storage key. Run scale again once the old server answers.`,
    );
  }
  if (String(text ?? '').trim() === NO_APP_ENV_MARKER) return null;
  return dropUnportableEnv(parseDotenv(String(text ?? '')), { log });
}

/** Stop the add-on job on a server (services/addon-start.js), waiting until it is gone. */
async function stopAddonJob(ip, sshKeyPath, projectName) {
  // sshRun takes an argv array (ssh.js); the command line runs under sh -c.
  await sshRun(ip, sshKeyPath, ['sh', '-c', addonJobStopCmd(projectName)]);
}

/** How long a rolled-back resume waits before it reads DNS once more. */
const DNS_RESETTLE_MS = 15_000;

/** The post-flip steps of a compose cutover, in order, with the words a message uses. */
const CUTOVER_STEPS = [
  ['dns', 'the DNS flip'],
  ['demote', "the old server's demote"],
  ['recreate', 'the service recreate'],
  ['push', 'the first base backup on the new timeline'],
  ['cron', 'the backup cron'],
  ['destroy', "the old server's destroy"],
];

/** The post-flip steps not yet in `done`, as words. */
function remainingCutoverSteps(done) {
  return CUTOVER_STEPS.filter(([step]) => !done.includes(step)).map(([, words]) => words);
}

/**
 * The post-flip tail of a compose primary cutover, shared by the scale and its
 * resume: demote the old server's wal-g write-guard (after the flip, never
 * before: a demoted node drops every WAL segment it completes), recreate the
 * services, push the first base on the new timeline (C8), install the backup
 * cron, destroy the old server, clear its fence record. Each step is recorded
 * in the cutover journal as it lands, and one already in `done` is skipped.
 *
 * `pushBase` is pushBaseBackupAfterPromote, handed in by the caller that
 * holds the restore (post-promote-backup census).
 */
async function finishComposeCutover(ctx, { server, newIp, label, done, pushBase, onServing }) {
  const { provider, projectName, environment, sshKeyPath, dnsChallenge, envConfig } = ctx;
  const s = spinner();
  const remoteDir = `/opt/${projectName}`;
  const step = async (name, run) => {
    if (done.includes(name)) return;
    await run();
    done.push(name);
    markScaleCutoverStep({ environment }, name);
  };

  // 12. Demote the old server's wal-g write-guard so it never archives next
  //     to the new primary (demoteComposeWalgRole recreates its db with
  //     WALG_ROLE=standby).
  await step('demote', async () => {
    s.start(`Demoting ${label} (wal-g write-guard)...`);
    const demoted = await demoteComposeWalgRole({
      oldPrimaryIp: server.ip,
      sshKeyPath,
      projectName,
    });
    if (!demoted) {
      s.stop(`${label} not demoted`, 1);
      throw new Error(
        `could not demote ${label}'s wal-g write-guard, so it could archive next to the new server`,
      );
    }
    s.stop(`${label} demoted`);
  });

  await step('recreate', async () => {
    // 13a. HTTP-01 only: reset ACME state so Traefik retries challenges with
    // the corrected DNS — the new server's stack started before the A record
    // moved, so failed challenges are cached as errors in letsencrypt_data.
    // DNS-01 has no such cached HTTP-01 failure to clear (and wiping acme.json
    // would force a needless re-issue), so skip it.
    // An apex certificate already in acme.json (the restored one) is kept: the
    // server is asked, never this process's memory, so a cutover resumed from
    // its journal decides the same way. A check that cannot answer keeps the
    // file too; the recreate below still restarts Traefik's issuance.
    // Uses an SCP'd script so quoting/redirection stay intact without local shell.
    const apex = ctx.domain ?? envConfig.domain ?? null;
    let live = null;
    if (!dnsChallenge) {
      // No domain: no certificate to keep, so the reset runs as it always has.
      live = apex
        ? await readLiveApexCertificate({
            ip: newIp,
            sshKeyPath,
            projectName,
            domain: apex,
            // The stack is up, so the traefik image is local.
            timeoutMs: 30_000,
          })
        : { state: 'absent' };
    }
    if (live?.state === 'absent') {
      await sshRunScript(
        newIp,
        sshKeyPath,
        `cd ${remoteDir} && docker compose exec -T traefik sh -c 'echo "{}" > /letsencrypt/acme.json && chmod 600 /letsencrypt/acme.json'`,
        { timeout: 30_000 },
      );
    } else if (live?.state === 'present') {
      p.log.info('TLS certificate already on the new server; ACME state kept.');
    } else if (live) {
      p.log.info(`ACME state kept (${live.reason}).`);
    }

    // 13b. Recreate all services after restore so they reconnect to the restored DB.
    // Using --force-recreate (not down+up) avoids a Docker network removal error
    // when feature containers on separate compose files are still holding the
    // network open. depends_on ordering is still respected.
    //
    // THE -f SET IS EXTRACTED FROM reconcile.sh ON THE SERVER, not rebuilt in JS.
    // This was the last surviving JS-side rebuild of the flag set, and it had
    // drifted: it carried docker-compose.redis.yml WITHOUT its .prod.yml half, so
    // with redis installed a force-recreate rendered every service against a set no
    // reconcile ever computes — the next warm deploy / systemd ExecStart / reboot
    // recomputed the hashes and recreated the whole stack again (identical class to
    // the compose-HA overlay-write db bug, d78402e). The extraction keeps this
    // invocation byte-identical to future reconciles by construction; the fallback
    // is bounded (base + prod = at worst one extra recreate churn, never a failure).
    // The replication overlay is appended when present, same runtime conditional as
    // reconcile.sh itself — on single-server compose the file never exists.
    // STANDBY_SCALE_FLAG keeps primary-only add-ons at zero when the node's
    // .env says WALG_ROLE=standby, the same fragment reconcile.sh's up runs.
    const replOverlayFlag =
      "$([ -f docker-compose.replication.yml ] && echo '-f docker-compose.replication.yml')";
    s.start('Recreating all services after restore...');
    await sshRunScript(
      newIp,
      sshKeyPath,
      `cd ${remoteDir} && ` +
        // An add-on job (reconcile.sh started it) must not be mid compose
        // operation while the whole stack is recreated: stop it first.
        `if [ -f ${ADDON_JOB_SCRIPT} ]; then sh ${ADDON_JOB_SCRIPT} stop; fi; ` +
        `FLAGS=$(sed -n '${RECONCILE_FLAGS_SED}' reconcile.sh | tail -1); ` +
        `[ -n "$FLAGS" ] || FLAGS='-f docker-compose.yml -f docker-compose.prod.yml'; ` +
        `docker compose $FLAGS ${replOverlayFlag} up -d --force-recreate ${STANDBY_SCALE_FLAG} 2>&1`,
      { timeout: 600_000 },
    );
    s.stop('All services running');
    // The recreate stopped the add-on job. Start it again, detached, under a
    // FRESH attempt id (never the one the stopped reconcile-time job wrote,
    // whose file must not read as current), saved as the env's lastAttemptId
    // only once the relaunch ran. Promoted: the restored database already
    // holds the one-shot setups' work. Add-ons do not hold a scale: a failed
    // relaunch warns and saves no id, so status reads their containers.
    const attemptId = mintAttemptId();
    try {
      await sshRun(newIp, sshKeyPath, [
        'sh',
        '-c',
        addonJobStartCmd(projectName, attemptId, 'promoted'),
      ]);
      updateProjectConfig((onDisk) => {
        const env = onDisk.environments?.[environment];
        if (env) env.lastAttemptId = attemptId;
      });
    } catch (err) {
      p.log.warn(
        `could not restart the add-on job on ${newIp} (${firstLineOf(err)}); the add-ons keep ` +
          'running, and vibecarbon status reads them from their containers until the next deploy',
      );
    }
  });
  onServing?.();

  // 14. The first base backup on the restored timeline (post-promote-backup.js,
  //     C8): after the flip, before the old server goes. restoreCompose has
  //     retired .vc-prev, so the base holds the restored cluster only. A
  //     failure fails the scale and keeps the old server.
  await step('push', async () => {
    s.start('Pushing the first base backup on the restored timeline...');
    const { name } = await pushBase({
      tier: 'compose',
      ip: newIp,
      sshKeyPath,
      projectName,
      envName: environment,
      retain: envConfig.backup?.retentionDays,
    });
    s.stop(`Base backup ${name} pushed on the restored timeline`);
  });

  // Re-setup backup cron if configured. wal-g reads its S3 config from the db
  // container's env (rendered into .env at deploy), so the cron just runs
  // compose-backup.sh on schedule — no separate S3 plumbing.
  await step('cron', async () => {
    if (envConfig.backup) {
      await setupComposeBackupCron(newIp, sshKeyPath, projectName, envConfig.backup, {
        domain: envConfig.domain,
      });
      p.log.info('Backup cron restored on new server');
    }
  });

  // 15. Destroy the old server: it took no write since the fence, and its
  //     final base is restored on the new one. The Pulumi state sync is
  //     recorded first, so a run killed between the two leaves a record
  //     deploy repairs from (server-state-sync.js).
  const stateEntry = scaledServerStateEntry(ctx, server);
  await step('destroy', async () => {
    recordPendingServerState(environment, stateEntry);
    s.start(`Destroying old server ${server.ip}...`);
    await perfAsync('scale.destroyOldServer', () => provider.deleteServer(server.id));
    markPendingServerOldDeleted(environment, stateEntry.stack);
    s.stop(`Old server destroyed: ${server.ip}`);
  });
  // The fenced server is gone, and its record (marker and journal) with it.
  clearWriteFenceMarker({ environment });
  await renameReplacement(ctx, server._replacement);
  // 16. Pulumi state names the new server (also on a resume past the delete).
  await syncScaledServerState(ctx, stateEntry);
}

/**
 * Resume a compose scale that stopped mid-cutover (its journal on the
 * write-fence marker, writeScaleCutoverJournal). Where DNS points decides:
 *   - every record still on the old server: the C19 rollback (unfence, the
 *     writers, the cron) and the new server deleted;
 *   - unknown (the records cannot be read): nothing changes, and it refuses
 *     again;
 *   - anything else (or a config that already names the new server, or no
 *     DNS the scale manages): the new server is adopted, DNS is pointed at it
 *     again, and the post-flip steps not yet done run.
 *
 * @returns {Promise<'rolled-back'|'finished'>}
 */
export async function resumeComposeCutover(ctx) {
  const { environment, envConfig, provider, apiToken, domain, projectName, sshKeyPath, tier } = ctx;
  const cutover = envConfig.ha.writeFence.cutover;
  const servers = envConfig.servers ?? [];
  const recorded = servers.find((sv) => sv.id === cutover.newServerId);
  const oldEntry = servers.find((sv) => sv.id === cutover.oldId);
  // The old server as the arm knew it (the config may already name the new one).
  const server = oldEntry ?? { ...recorded, id: cutover.oldId, ip: cutover.oldIp };
  const label = server.role ? `${server.role} (${cutover.oldIp})` : cutover.oldIp;
  const { newServerId, newIp } = cutover;
  p.log.warn(
    `A scale of ${environment} stopped mid-cutover (old server ${cutover.oldIp}, new server ${newIp}); resuming it.`,
  );

  const managesDns = !!domain && shouldUpdateApexDns(server);
  let state = recorded || !managesDns ? 'moved' : null;
  let pending = [];
  if (!state) {
    ({ state, pending } = await readDnsMove(envConfig, apiToken, domain, {
      oldIp: cutover.oldIp,
      newIp,
    }));
  }
  if (state === 'unknown') {
    throw new Error(
      `where ${domain}'s records point is unknown (${pending.join(', ')}), so the cutover is ` +
        `left as it is; ${scaleCutoverNextStep(environment)} once the DNS provider answers.`,
    );
  }
  if (state === 'old') {
    // The new server goes FIRST: a DNS write the provider applies late can
    // then only point at a server that is gone (an outage), never at a second
    // writable primary next to the unfenced old one.
    p.log.info(`DNS never moved: deleting the new server ${newIp}, then rolling ${label} back...`);
    try {
      await provider.deleteServer(newServerId);
    } catch (err) {
      throw new Error(
        `could not delete the new server ${newIp} (id ${newServerId}): ${firstLineOf(err)}; ` +
          `the old server stays write-fenced so two primaries never take writes. ` +
          `Delete it, then ${scaleCutoverNextStep(environment)}.`,
      );
    }
    const back = await rollbackComposeCutover({
      environment,
      ip: cutover.oldIp,
      sshKeyPath,
      projectName,
      stopped: cutover.stopped ?? [],
      cronRemoved: cutover.cronRemoved !== false,
      backupConfig: envConfig.backup,
      domain: envConfig.domain,
    });
    clearScaleCutoverJournal({ environment });
    const problems = [...back.problems];
    // Point DNS at the old server again (a no-op unless a late write moved
    // it), wait a settle, and read once more: anything still off the old
    // server is named, loudly.
    if (managesDns) {
      try {
        await updateDNS(envConfig, apiToken, domain, cutover.oldIp);
        await (ctx.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(DNS_RESETTLE_MS);
        // Read with the roles swapped: `moved` means every record is on the old server.
        const again = await readDnsMove(envConfig, apiToken, domain, {
          oldIp: newIp,
          newIp: cutover.oldIp,
        });
        if (again.state !== 'moved') {
          problems.push(
            `DNS is not all on the old server ${cutover.oldIp} after the rollback: ${again.pending.join(', ')}; point them at it`,
          );
        }
      } catch (err) {
        problems.push(
          `could not point DNS back at the old server ${cutover.oldIp} (${firstLineOf(err)}); check ${domain} and *.${domain}`,
        );
      }
    }
    for (const problem of problems) p.log.error(problem);
    ctx.resumeProblems = problems;
    return 'rolled-back';
  }

  // Adopt the new server.
  const adoptCtx = {
    ...ctx,
    newType: cutover.serverType ?? recorded?.serverType,
    servers: [server],
  };
  server._replacement = recorded ?? replacementEntry(adoptCtx, server, { newServerId, newIp });
  const done = [...(cutover.done ?? [])];
  if (managesDns && !done.includes('dns')) {
    await updateDNS(envConfig, apiToken, domain, newIp);
    done.push('dns');
    markScaleCutoverStep({ environment }, 'dns');
  }
  // Single compose: its one server's type is the env's (on a resume the
  // update-project-config step never runs), which a cold provision's program
  // reads.
  const extra = !isHATier(tier) && adoptCtx.newType ? { serverType: adoptCtx.newType } : {};
  if (!recorded || Object.keys(extra).length > 0) saveScaledServers(adoptCtx, extra);
  await finishComposeCutover(adoptCtx, {
    server,
    newIp,
    label,
    done,
    pushBase: pushBaseBackupAfterPromote,
  });
  // compose-ha: the standby streamed from the old primary.
  if (isHATier(tier)) {
    const standbyEntry = servers.find((sv) => sv.role === 'standby' && sv.id !== cutover.oldId);
    if (standbyEntry?.ip) {
      const replication = await rejoinComposeStandby({
        environment,
        projectName,
        envConfig,
        primary: { ip: newIp, entry: server },
        standby: { ip: standbyEntry.ip, entry: standbyEntry },
        sshKeyPath,
        provider,
      });
      if (replication !== 'streaming') ctx.replicationDegraded = true;
    }
  }
  return 'finished';
}

/**
 * compose/compose-ha `scale-servers` effect: blue-green replace every target
 * server (backup old → create new → wait for SSH → provision → copy files →
 * registry logins → optional remote build → pull images → compose up →
 * restore from S3 → update DNS → reset ACME state → recreate services →
 * backup cron → destroy old server). For compose-ha we run primary + standby
 * in parallel — every per-server step is independent, and the apex DNS
 * update runs on exactly ONE arm (shouldUpdateApexDns): the old "benign
 * last-writer race" both 409'd against Hetzner's non-atomic upsert and could
 * leave apex pointing at the pilot-light standby (run 31970876667). perf
 * data showed compose-ha scale was exactly 2× single-server scale (711s vs
 * ~365s); parallelizing makes it ~max(primary, standby) ≈ 6m off the
 * critical path.
 *
 * This is a faithful relocation of the (now removed) inlined
 * `scaleSingleServer` + its fan-out dispatch from `scaleCompose` — same
 * operations, order, args, and try/catch cleanup (delete the new server on
 * ANY failure). Cracking it into barrier-synchronized steps across servers
 * would change that failure/cleanup semantics, so — mirroring the deployK3s /
 * destroy-tier black-box precedent — it stays ONE effect that owns the whole
 * fan-out.
 */

/**
 * May this arm's replacement server write the apex + wildcard DNS records?
 *
 * Exactly ONE writer (RCA 2026-08-16, run 31970876667 compose-ha scale):
 * both parallel arms used to call upsertApexAndWildcard with THEIR OWN new
 * IP, and Hetzner's upsert is list → delete → create — non-atomic, so the
 * two writers interleaved into `RRSet(s) already exist(s)`. The prior
 * sequential code's last-writer-wins was documented as benign, but it never
 * was: deploy's setupHA points apex at the PRIMARY only and failover is the
 * only legitimate repointer, so a standby arm writing apex→standby-IP
 * strands production traffic on the pilot-light standby. `role` reflects the
 * CURRENT role (failover swaps it), so the primary's replacement — or the
 * single server on non-HA compose, which carries no role — is the one
 * writer.
 *
 * @param {{role?: string}} server
 * @returns {boolean}
 */
export function shouldUpdateApexDns(server) {
  return server?.role !== 'standby';
}

/** `<n>s` (or `<m>m <s>s`) for a measured pause. */
function formatPause(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`;
}

const firstLineOf = (err) => String(err?.message ?? err).split('\n')[0];

/** A promise with its resolve/reject in hand: the standby arm waits on the primary arm. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The standby arm may never await it (it failed first); no unhandled rejection.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/**
 * Create a replacement server for `server` (step 2): user_data front-loads
 * ufw + unattended-upgrades during boot so setupServer below is a ~2s marker
 * probe (Hetzner) or the provider-owned cloud-init budget (DigitalOcean).
 * @returns {Promise<string|number>} the new server's id
 */
async function createReplacementServer(ctx, server, s) {
  const { provider, Provider, newType, region, sshKeyId, projectName, environment } = ctx;
  const newServerName = `${projectName}-${environment}${server.role ? `-${server.role}` : ''}-new`;
  s.start(`Creating new ${c.bold(newType)} server...`);
  const createServerArgs = await buildReplacementServerArgs(Provider, {
    name: newServerName,
    serverType: newType,
    region: server.region || region,
    sshKeyId,
    // Per-SERVER, not per-env: compose-ha gives each node its own firewall
    // (one per Pulumi stack). `envConfig.firewallId` was read here for
    // months and never written by anything, so every replacement server was
    // built with `firewalls: []` — unfirewalled — while the old, firewalled
    // server was deleted underneath it.
    firewallId: server.firewallId,
    projectName,
    environment,
  });
  const { id: newServerId } = await perfAsync('scale.createNewServer', async () =>
    provider.createServer(createServerArgs),
  );
  s.stop(`New server created (id: ${newServerId})`);
  return newServerId;
}

/**
 * Bring a replacement server up to a running stack (steps 3-6): online, Docker
 * ready, the old server's .env and app.env replayed, registry logins, the app
 * image, and compose up. On compose-ha the replication overlay is written
 * first, so the stack starts with the db's 5433 publish and the repl-gateway.
 * Touches the old server only to read its configuration.
 *
 * `backupS3` (the primary arm only, from the preflight) restores the saved TLS
 * certificate into the new server's acme.json before its stack starts, so it
 * serves HTTPS as soon as DNS moves (restoreReplacementTls).
 * @returns {Promise<string>} the new server's public IP
 */
async function prepareReplacementServer(ctx, server, newServerId, s, { backupS3 = null } = {}) {
  const {
    tier,
    provider,
    Provider,
    envConfig,
    projectName,
    environment,
    sshKeyPath,
    domain,
    services,
    dnsChallenge,
    dnsProvider,
    apiToken,
  } = ctx;
  // 3. Wait for the server to come online, THEN resolve its IP off the
  // object waitForServer resolves with — not off createServer's return.
  // Hetzner assigns the IP synchronously at create time, but
  // DigitalOcean assigns it asynchronously (create returns a 202 with an
  // empty `networks` list), so reading it immediately after createServer
  // raced DO's assignment and always produced null. DigitalOcean's
  // waitForServer only resolves once the droplet is active AND has a
  // public IP; Hetzner's only checks status (its IP is already present
  // by then). Reading the IP off whichever object waitForServer
  // resolves with is the correct read point for either shape (costs
  // Hetzner one GET it didn't strictly need, in exchange for one code
  // path instead of a provider branch here).
  s.start('Waiting for server to come online...');
  const readyServer = await perfAsync('scale.waitForServer', () =>
    provider.waitForServer(newServerId),
  );
  const newIp = Provider.getPublicIP(readyServer);
  const sshReady = await perfAsync('scale.waitForSSH', () => waitForSSH(newIp, sshKeyPath, 40));
  if (!sshReady) {
    throw new Error(`SSH did not become available on new server ${newIp}`);
  }
  s.stop(`Server online (${newIp})`);

  // 4. Provision new server. Timeout is provider-owned (see
  // BaseProvider.CLOUD_INIT_READY_TIMEOUT_MS) — a bare call here would
  // silently apply setupServer's Hetzner-calibrated 180s default to
  // every provider, including one (DigitalOcean) whose base image
  // installs Docker inside cloud-init and needs materially longer.
  s.start('Configuring server...');
  await perfAsync('scale.cloudInitReady', () =>
    setupServer(newIp, sshKeyPath, Provider.CLOUD_INIT_READY_TIMEOUT_MS),
  );
  s.stop('Docker installed');

  // Pull the OLD server's full /opt/<project>/.env so every variable the
  // original deploy seeded (auth secret, S3 creds, SMTP, billing,
  // Grafana, n8n encryption key, etc.) propagates to the new server.
  //
  // Why pull the whole file vs. re-deriving from project state:
  //   - The original deploy merges values from many sources — project
  //     `.env` + operator-secret env vars (S3 secret key) +
  //     orchestrator-derived overrides (DOMAIN, ACME_EMAIL, SITE_URL,
  //     S3_*, S3_BACKUP_BUCKET, PROJECT_NAME, APP_IMAGE).
  //     Reconstructing all of those at scale time would mean re-prompting
  //     for credentials and re-running the same envOverrides logic.
  //   - The old server's `.env` already contains the resolved superset.
  //     Replaying it onto the new server is the smallest patch that
  //     preserves every value, including ones the project's local
  //     `.env`/`.env.local` doesn't even know about.
  //
  // The on-disk form is whichever of bare / "…" / '…' the portable
  // grammar (src/lib/dotenv.js) picked; parseDotenv decodes it so the
  // values we pass to renderBundle as envOverrides are raw strings ready
  // to be re-encoded on write. We then pin APP_IMAGE explicitly because that's
  // the one value scale needs to keep stable across the migration; all
  // other keys flow through transparently.
  // Spinner over the OLD-server .env pull: this SSHes a *different* host
  // (the one being retired) and, if it's slow/unreachable, sits on sshRun's
  // 120s client timeout. Without a spinner that window is a dead cursor
  // between "Docker installed" and "Copying project files" — the exact
  // stalled-spinner symptom flaky links produce.
  let oldEnv = {};
  /** @type {Record<string, string> | null} */
  let oldAppEnv = null;
  s.start('Reading current server configuration...');
  try {
    const envText = await sshRun(server.ip, sshKeyPath, ['cat', `/opt/${projectName}/.env`]);
    s.stop('Current server configuration read');
    // renderBundle re-encodes every override and throws on a value the
    // portable grammar refuses (a hand-edited server value with a tab,
    // or `'` beside `"`) — mid-scale, after the new server exists. Drop
    // and warn here instead; the operator re-enters it with configure.
    oldEnv = dropUnportableEnv(parseDotenv(envText));
  } catch (err) {
    // No fallback to the project's local `.env`: it lacks the values the
    // deploy merged in, and its S3_* would be the account-wide pair, not
    // the app's own key (security plan R2). Stop this server's scale; the
    // caller's cleanup deletes the new server.
    s.stop('Could not read old-server config, so this server is not scaled', 1);
    throw new Error(
      `could not read .env on the old server ${server.ip} (${err?.message ?? err}), so scale stopped rather than build the new server from the project .env. Run scale again once the old server answers.`,
    );
  }
  // Only once the .env replay is in hand. A failed app.env read throws
  // here, so the caller deletes the new server instead of guessing a pair.
  oldAppEnv = await readOldAppEnv(server.ip, sshKeyPath, projectName);
  const oldAppImage = oldEnv.APP_IMAGE || '';

  s.start('Copying project files...');
  await perfAsync('scale.setupFiles', () =>
    setupServerFiles(newIp, sshKeyPath, projectName, {
      domain,
      image: oldAppImage || `${projectName}:latest`,
      observability: services.observability,
      n8n: services.n8n,
      metabase: services.metabase,
      redis: services.redis,
      // DNS-01: ship the Traefik override + re-affirm ACME_DNS_PROVIDER.
      // The provider token flows through `envOverrides: oldEnv` (the
      // original deploy baked it into the server .env); the token is
      // passed too so a fresh bundle still works if the old server was
      // unreachable. Same-token rule: native DNS reuses the compute
      // token in hand.
      dnsChallenge,
      dnsProvider,
      dnsToken: hasAutomatedDns(dnsProvider)
        ? resolveDnsToken(dnsProvider, {
            computeProviderId: providerIdFor(envConfig),
            computeToken: apiToken,
          })
        : null,
      // Replay every env var the old server had. renderBundle's existing
      // envOverrides path overlays these onto the project-local `.env`
      // baseline, then re-applies the deploy-time overrides (DOMAIN,
      // SITE_URL, APP_IMAGE, etc.) on top — so the new bundle is a
      // superset of both sources.
      envOverrides: oldEnv,
      appEnvReplay: oldAppEnv,
    }),
  );
  s.stop('Project files copied');

  // compose-ha: the node's replication overlay, before its stack starts
  // (reconcile.sh adds it when present). It binds the tunnel address of the
  // stack the node was born as, which the replacement keeps.
  if (isHATier(tier)) {
    await writeComposeReplicationOverlay({
      ip: newIp,
      sshKeyPath,
      projectName,
      stack: composeHaStackOf(server, projectName, environment) ?? server.role,
    });
  }

  // 4b. Registry auth (optional — avoids rate limits on shared Hetzner IPs).
  // Scale pulls the same ghcr.io/<owner>/<repo>:<tag> the original
  // deploy pushed, so ghcr credentials are required alongside Docker Hub.
  const dockerHubCreds = resolveDockerHubCreds();
  if (dockerHubCreds) {
    s.start('Authenticating with Docker Hub...');
    await perfAsync('scale.dockerLogin', () =>
      dockerLoginOnServer(newIp, sshKeyPath, dockerHubCreds),
    );
    s.stop('Docker Hub authenticated');
  }
  try {
    const ghcrCreds = await getGHCRCredentials();
    if (ghcrCreds?.username && ghcrCreds?.token) {
      s.start('Authenticating with ghcr.io...');
      await perfAsync('scale.ghcrLogin', () =>
        dockerLoginOnServer(newIp, sshKeyPath, {
          username: ghcrCreds.username,
          token: ghcrCreds.token,
          registry: 'ghcr.io',
        }),
      );
      s.stop('ghcr.io authenticated');
    }
  } catch {
    /* non-fatal: image may be public */
  }

  // 4c. Direct-mode image: build on the new server instead of sideloading.
  //
  // Original implementation piped `ssh old docker save | ssh new docker load`
  // from the local shell — every image byte transited the local machine
  // twice across the WAN, causing 16+ min hangs / timeouts on a ~500MB
  // image during matrix runs. compose's `prod.yml` resets
  // `build: !reset null`, so `docker compose up --build` can NOT rebuild
  // it during the reconcile step — the image must already exist in the
  // new server's daemon by the time compose pulls.
  //
  // buildRemote uses DOCKER_HOST=ssh://new and runs the build directly on
  // the new server. BuildKit only ships the build context (~tens of MB
  // of source), not the 500MB built image, so the data path is local →
  // new (one short hop) instead of old → local → new (two long hops).
  // Reuses the same code that does direct-mode deploy builds.
  if (oldAppImage && isLocalOnlyImageTag(oldAppImage)) {
    s.start(`Building image ${oldAppImage} on new server...`);
    // Pass the VITE_* build args (same as deploy/HA). Vite inlines
    // import.meta.env.VITE_* at build time, so without these the new
    // server's frontend bundle ships empty client config (VITE_PUBLIC_URL,
    // feature flags). Deploy
    // (orchestrator.js) and HA (ha.js) already do this — scale did not.
    const scaleBuildArgs = collectComposeBuildArgs(process.cwd(), { projectName, domain });
    // Perf label renamed 2026-08-23: this wrapped buildRemote under the
    // name 'scale.sideloadImage', which made the 08-23 RCA read DO's
    // successful native build as a sideload and manufacture a
    // provider divergence that did not exist. The label now says what
    // runs. (Perf history: entries before this date under
    // scale.sideloadImage on the direct path were builds.)
    const built = await perfAsync('scale.remoteBuildImage', () =>
      buildRemote(newIp, sshKeyPath, oldAppImage, process.cwd(), scaleBuildArgs),
    );
    // buildRemote returns false on failure (after its own retries). The app
    // image is local-only, so if it isn't built on the new server, the
    // `docker compose up` below pulls it and dies ~a minute later with
    // "pull access denied / repository does not exist" — a confusing
    // downstream symptom. Fail loudly here instead; this guard was missing
    // (the HA deploy path has the equivalent check). RCA: e2e loop run #1.
    if (!built) {
      s.stop('Remote image build failed on new server', 1);
      throw new Error(
        `scale: failed to build local app image ${oldAppImage} on new server ${newIp} ` +
          `(buildRemote exhausted its retries), aborting before compose up.`,
      );
    }
    s.stop('Image built on new server');
  }

  // 5. Pull app + base images from ghcr.io / Docker Hub
  // No local build — image was built by CI (see Lever 1).
  s.start('Pulling images on server...');
  await perfAsync('scale.pullImages', () =>
    pullComposeImages(newIp, sshKeyPath, projectName, services),
  );
  s.stop('Docker images ready');

  // 5b. The saved certificate, before Traefik's first start (primary only).
  if (backupS3) await restoreReplacementTls(ctx, newIp, backupS3, s);

  // 6. Start compose stack on new server
  s.start('Starting services on new server...');
  await perfAsync('scale.composeUp', () =>
    startComposeStack(newIp, sshKeyPath, projectName, {
      ...services,
      attemptId: ctx.attemptId,
    }),
  );
  s.stop('Services started');
  return newIp;
}

/**
 * Put the last saved certificate into a replacement primary's acme.json. The
 * CA is the one the last deploy recorded (envConfig.tls.ca): with none,
 * nothing is read and Traefik issues a new certificate. One info line; never
 * throws, so certificates never stop a scale.
 */
async function restoreReplacementTls(ctx, newIp, backupS3, s) {
  const { envConfig, projectName, environment, sshKeyPath } = ctx;
  const domain = ctx.domain ?? envConfig.domain ?? null;
  const ca = envConfig.tls?.ca ?? null;
  s.start('Restoring the saved TLS certificate...');
  const result = ca
    ? await perfAsync('scale.tlsRestore', () =>
        restoreComposeTls({
          ip: newIp,
          sshKeyPath,
          projectName,
          domain,
          envName: environment,
          ca,
          s3Config: backupS3,
        }),
      )
    : { restored: false, reason: 'no recorded CA' };
  s.stop(result.restored ? 'TLS certificate restored' : 'TLS certificate not restored');
  p.log.info(tlsRestoreLine(result, domain));
}

/** The servers[] entry for a replacement: the original entry, with what changed. */
function replacementEntry(ctx, server, { newServerId, newIp }) {
  const { projectName, environment, region, newType } = ctx;
  // We spread the original `server` entry first so any field we don't
  // explicitly touch carries over verbatim. We deliberately keep
  // `server.name` (the role label and stack identity) because failover.js,
  // diagnose.js, destroy.js and the compose-ha stack lookup (wgIpOf) all read
  // it. The provider's name goes into `providerServerName` so destroy's
  // name-fallback can locate the VPS.
  return {
    ...server,
    id: newServerId,
    providerServerName: `${projectName}-${environment}${server.role ? `-${server.role}` : ''}`,
    ip: newIp,
    region: server.region || region,
    serverType: newType,
  };
}

/** Rename the new server to its permanent name (non-critical: it works with the temporary one). */
async function renameReplacement(ctx, entry) {
  try {
    await ctx.provider.renameServer(entry.id, entry.providerServerName);
  } catch {
    // Non-critical — server works fine with the temporary name
  }
}

/** Delete a replacement server that never took over, or say how to. */
async function deleteUnusedReplacement(provider, newServerId, newIp, oldStillRuns) {
  p.log.info(`Cleaning up new server ${newIp || 'unknown'} (id: ${newServerId})...`);
  try {
    await provider.deleteServer(newServerId);
    p.log.info(oldStillRuns);
  } catch (cleanupErr) {
    p.log.error(
      `Failed to delete new server ${newServerId}: ${cleanupErr.message}. Delete it manually.`,
    );
  }
}

/**
 * compose/compose-ha `scale-servers` effect: blue-green replace every target
 * server.
 *
 * The PRIMARY arm (single-server compose, or the compose-ha node resolvePrimary
 * names) moves the database with writes fenced (scale-cutover.js):
 *   provision and start the new server; fence the old one (writers stopped,
 *   database read-only, WAL archived through the fence); push the final base;
 *   restore THAT base on the new server; demote the old server's WALG_ROLE and
 *   drop its backup cron; flip DNS; recreate services; push the first base on
 *   the new timeline (C8: after the flip, before the old server goes); install
 *   the backup cron; destroy the old server.
 * Any failure before the DNS flip rolls the old server back and deletes the
 * new one (C19). After the flip there is no rollback: the command fails and
 * names what is left where.
 *
 * The STANDBY arm (compose-ha) never restores: it provisions the replacement,
 * waits for the primary arm when one runs, and reseeds it from the primary
 * (rejoinComposeStandby). A primary-only scale reseeds the existing standby
 * from the new primary the same way. A reseed that is not proven streaming
 * marks replication degraded.
 *
 * The arms run in parallel (their provisioning overlaps); the apex DNS update
 * runs on exactly ONE arm (shouldUpdateApexDns): the old "benign
 * last-writer race" both 409'd against Hetzner's non-atomic upsert and could
 * leave apex pointing at the pilot-light standby (run 31970876667).
 */
async function scaleServers(ctx) {
  const {
    tier,
    provider,
    envConfig,
    projectName,
    environment,
    sshKeyPath,
    domain,
    services,
    dnsChallenge,
    apiToken,
    targetServers,
  } = ctx;
  const ha = isHATier(tier);

  // The live primary, by role (resolvePrimary refuses an ambiguous pair). On
  // single-server compose the one server is the primary arm.
  const primaryEntry = ha ? (resolvePrimary(envConfig, { env: environment })?.entry ?? null) : null;
  const isPrimaryArm = (server) =>
    !ha || server === primaryEntry || (!!primaryEntry?.ip && server.ip === primaryEntry.ip);
  const primaryTarget = targetServers.find(isPrimaryArm);
  const standbyTarget = ha ? targetServers.find((sv) => !isPrimaryArm(sv)) : undefined;
  if (ha && !primaryEntry) {
    throw new Error(`scale could not tell which server is ${environment}'s primary`);
  }

  // PREFLIGHT, before any server is built. The primary's replacement is
  // restored from the base the fenced old primary pushes, which needs the
  // live database's recorded lineage (C7) and the bucket's credentials
  // locally. Both are local facts: refusing late deleted a server just
  // provisioned, set up and started. A standby-only scale restores nothing.
  let backupS3 = null;
  if (primaryTarget) {
    const liveLineage = envConfig.backup?.lineage;
    if (!LINEAGE_RE.test(String(liveLineage ?? ''))) {
      throw new Error(
        `scale restores ${environment}'s database onto the new server from its backup lineage, and none is on record. ` +
          `Run \`vibecarbon deploy ${environment}\` to record it, then rerun.`,
      );
    }
    backupS3 = await resolveS3Config({
      isCompose: true,
      envName: environment,
      projectName,
      envConfig,
      skipPrompts: !process.stdin.isTTY,
    });
    if (!backupS3) {
      throw new Error(
        `scale restores the new server from ${environment}'s backup bucket and needs its credentials: ` +
          `export ${backupCredentialVars(envConfig)}, then rerun.`,
      );
    }
  }

  // The writers the fence stops: the app and the enabled primary-only add-ons.
  const addonNames = enabledAddonNames({
    ...envConfig,
    services: { ...(envConfig.services ?? {}), ...(services ?? {}) },
  });
  // The standby arm waits on this: the new primary, once it serves.
  const primaryReady = primaryTarget && standbyTarget ? deferred() : null;

  const scalePrimaryArm = async (server) => {
    const label = ha ? `${server.role} (${server.ip})` : server.ip;
    const s = spinner();
    const newServerId = await createReplacementServer(ctx, server, s);
    let newIp;
    // What the cutover has done to the old server, for the rollback.
    let cutover = null;
    let cronRemoved = false;
    // Set once the cutover journal is written (just before the DNS flip).
    let journaled = false;
    // Set when DNS state after a failed update is unknown: nothing is rolled
    // back or deleted, the journal holds both servers for the resume.
    let held = false;
    // Set once DNS points at the new server (or may, after a DNS update that
    // failed part way): from here on nothing rolls back.
    let flipped = false;
    // The post-flip steps done, for the resume message.
    const progress = [];
    try {
      newIp = await prepareReplacementServer(ctx, server, newServerId, s, { backupS3 });

      // 7. Fence writes on the old server: writers stopped, database
      //    read-only, WAL switched and archived through the fence. From here
      //    the old server takes no writes, so the base pushed next holds them all.
      s.start(`Pausing writes on ${label} (write fence)...`);
      cutover = await perfAsync('scale.fenceOldPrimary', () =>
        fenceComposePrimary({
          environment,
          node: server.name,
          ip: server.ip,
          sshKeyPath,
          projectName,
          services: addonNames,
        }),
      );
      s.stop(`Writes paused on ${label}; WAL archived through ${cutover.switchWal}`);

      // 8. The final base of the old server. It must report `pushed`: a skip
      //    (no S3 target, another backup holding the lock) took no base.
      s.start(`Taking the final base backup of ${label}...`);
      const retain = envConfig.backup?.retentionDays;
      const finalBackup = await perfAsync('scale.backupOldServer', async () => {
        const backup = await backupCompose(server.ip, sshKeyPath, projectName, { retain });
        if (backup.result !== 'pushed') {
          throw new Error(
            `the final backup of ${label} was skipped (${backup.reason}), so there is no base to restore; scale stopped before anything was restored or destroyed`,
          );
        }
        return backup;
      });
      s.stop(`Database backed up (base backup pushed: ${finalBackup.name})`);
      if (finalBackup.retentionError) {
        p.log.warn(
          `The base backup is in the bucket, but pruning old backups failed: ${finalBackup.retentionError}`,
        );
      }

      // Remote compose project dir on the new server — used by the restore's
      // writable proof, the ACME reset and the post-restore service recreate.
      const remoteDir = `/opt/${projectName}`;

      // 9. The restore fetches the base just pushed, BY NAME. The listing
      //    reads the live database's own lineage (C7), never a resolved one:
      //    an unrestored prior lineage is a restore question, not scale's.
      //    Finding the name in it proves the base landed in that lineage.
      s.start('Finding the pushed base backup in the backup bucket...');
      const listing = await readEnvBaseBackups({
        envName: environment,
        envConfig,
        projectName,
        live: true,
        // Resolved by the preflight, before anything was provisioned.
        s3Config: backupS3,
      });
      if (!listing.s3Config) {
        throw new Error(
          `scale restores the new server from ${environment}'s backup bucket and needs its credentials: ` +
            `export ${backupCredentialVars(envConfig)}, then rerun.`,
        );
      }
      const base = listing.backups.find((b) => b.name === finalBackup.name);
      if (!base) {
        throw new Error(
          `the pushed base ${finalBackup.name} is not in lineage ${listing.lineage} of the backup bucket, so scale stopped before anything was restored`,
        );
      }
      s.stop(`Restoring ${base.name}`);

      // The add-on job reconcile.sh started on the new server must not run
      // under the restore (it would die or misreport mid-restore): stop it.
      // The cutover's recreate starts it again once the restore is done.
      await stopAddonJob(newIp, sshKeyPath, projectName);

      s.start('Restoring database from S3 via wal-g...');
      await perfAsync('scale.restoreDb', async () =>
        restoreCompose(newIp, sshKeyPath, projectName, {
          backup: base.name,
          // The lineage the listing read (the one on record): the new server's
          // own PGDATA names no lineage while the fetch runs.
          lineage: listing.lineage,
          target: 'latest',
          recoveryConf: renderRecoveryConf(
            buildRecoveryConfig({ target: 'latest', lineage: listing.lineage }),
          ),
          requiredBytes: base.uncompressedBytes,
          assertWritable: () =>
            assertRestoredPrimaryWritable({
              environment,
              envConfig,
              exec: composePsqlRunner(newIp, sshKeyPath, remoteDir),
            }),
        }),
      );
      s.stop('Database restored');

      // 10. Drop the old server's backup cron, so no scheduled base lands
      //     from it once the new server is the primary.
      cronRemoved = true;
      await removeComposeBackupCron(server.ip, sshKeyPath);

      // 11. Journal the cutover, then flip DNS. From the journal on, the
      //     database may serve from the new server: a run killed here leaves
      //     a record no deploy lifts, and `vibecarbon scale` resumes it.
      server._replacement = replacementEntry(ctx, server, { newServerId, newIp });
      writeScaleCutoverJournal(
        { environment },
        {
          oldId: server.id,
          oldIp: server.ip,
          newServerId,
          newIp,
          serverType: ctx.newType,
          stopped: cutover.stopped,
          cronRemoved,
        },
      );
      journaled = true;
      // On HTTP-01 the flip must happen BEFORE recreating services (Traefik
      // challenges the A record on startup; a stale record fails all
      // challenges with a 30+ min retry). On DNS-01 the ordering is irrelevant
      // — lego validates a TXT record, not the A record. Gated to ONE writer:
      // the standby's replacement never touches apex (see shouldUpdateApexDns
      // — the two-writer upsert race, run 31970876667).
      if (domain && shouldUpdateApexDns(server)) {
        s.start('Updating DNS to new server...');
        try {
          await perfAsync('scale.updateDNS', () => updateDNS(envConfig, apiToken, domain, newIp));
        } catch (dnsErr) {
          s.stop('DNS update failed', 1);
          // Read the records back: still all on the old server is before the
          // flip (roll back); unknown holds everything for the resume;
          // anything else is past it.
          const move = await readDnsMove(envConfig, apiToken, domain, {
            oldIp: server.ip,
            newIp,
            dnsError: dnsErr,
          });
          if (move.state === 'old') {
            delete server._replacement;
            throw dnsErr;
          }
          if (move.state === 'unknown') {
            // Not recorded: the resume reads DNS again before it adopts.
            delete server._replacement;
            held = true;
            throw new Error(
              `the DNS update failed (${firstLineOf(dnsErr)}) and where the records point now is ` +
                `unknown: ${move.pending.join(', ')}. The old server ${server.ip} stays write-fenced ` +
                `and the new server ${newIp} is kept; ${scaleCutoverNextStep(environment)}.`,
            );
          }
          if (move.state === 'partial') {
            flipped = true;
            saveScaledServers(ctx);
            throw new Error(
              `the DNS update failed part way (${firstLineOf(dnsErr)}); ` +
                `still to point at ${newIp}: ${move.pending.join(', ')}`,
            );
          }
          // `moved`: the update reported an error, but every record reads back
          // on the new server. The flip landed; carry on.
          p.log.warn(
            `The DNS update reported an error (${firstLineOf(dnsErr)}), but every record now points at ${newIp}.`,
          );
        }
        s.stop('DNS updated');
        markScaleCutoverStep({ environment }, 'dns');
        progress.push('dns');

        // HTTP-01 only: poll until public resolvers return the new IP (max
        // 120s) so Traefik's first challenge sees it. DNS-01 doesn't gate on
        // A-record propagation, so skip the wait.
        if (!dnsChallenge) {
          s.start('Waiting for DNS propagation...');
          const dnsOk = await perfAsync('scale.waitForDNS', () =>
            waitForDNSPropagation(domain, newIp, 120_000),
          );
          s.stop(dnsOk ? 'DNS propagated' : 'DNS propagation timed out (proceeding anyway)');
        }
      } else {
        progress.push('dns');
      }
      flipped = true;
      // The new server is the record from here: every later command reaches it.
      saveScaledServers(ctx);
      const pausedMs = Date.now() - cutover.fencedAt.getTime();
      ctx.writePauseMs = pausedMs;
      p.log.info(
        `writes paused from ${cutover.fencedAt.toISOString()} until DNS flip (${formatPause(pausedMs)})`,
      );

      // 12-15. Demote the old server, recreate, the first base on the new
      //        timeline, the backup cron, destroy the old server.
      await finishComposeCutover(ctx, {
        server,
        newIp,
        label,
        done: progress,
        pushBase: pushBaseBackupAfterPromote,
        onServing: () => primaryReady?.resolve({ ip: newIp, entry: server }),
      });
    } catch (scaleErr) {
      // DNS state unknown: the journal holds both servers for the resume.
      if (held) throw scaleErr;
      if (!flipped) {
        p.log.error(`Scale failed: ${scaleErr.message}`);
        // C19: put the old server back the way it served.
        if (cutover) {
          p.log.info(`Rolling ${label} back: it takes writes again...`);
          const back = await rollbackComposeCutover({
            environment,
            ip: server.ip,
            sshKeyPath,
            projectName,
            stopped: cutover.stopped,
            cronRemoved,
            backupConfig: envConfig.backup,
            domain: envConfig.domain,
          });
          if (!back.ok) {
            for (const problem of back.problems) p.log.error(problem);
          }
          // A fence the rollback could not lift keeps its marker for deploy.
          if (journaled) clearScaleCutoverJournal({ environment });
        }
        await deleteUnusedReplacement(
          provider,
          newServerId,
          newIp,
          'New server deleted. Old server is still running.',
        );
        throw scaleErr;
      }
      // Past the flip: nothing rolls back; the journal names what is left.
      throw new Error(
        `scale moved ${label}'s database to the new server ${newIp}, then failed: ` +
          `${firstLineOf(scaleErr)}. The old server ${server.ip} (id ${server.id}) is kept, ` +
          `write-fenced. Still to run: ${remainingCutoverSteps(progress).join(', ')}; ` +
          `${scaleCutoverNextStep(environment)}.`,
      );
    }
  };

  const scaleStandbyArm = async (server) => {
    const s = spinner();
    const newServerId = await createReplacementServer(ctx, server, s);
    let newIp;
    let primary;
    try {
      newIp = await prepareReplacementServer(ctx, server, newServerId, s);
      // The primary it reseeds from: the new one once the primary arm serves,
      // else the live one.
      primary = primaryReady
        ? await primaryReady.promise
        : { ip: primaryEntry.ip, entry: primaryEntry };
      if (envConfig.backup) {
        // compose-backup.sh skips on a standby (WALG_ROLE); the cron is there
        // for when a failover promotes this node.
        await setupComposeBackupCron(newIp, sshKeyPath, projectName, envConfig.backup, {
          domain: envConfig.domain,
        });
      }
    } catch (scaleErr) {
      p.log.error(`Scale of the standby failed: ${scaleErr.message}`);
      await deleteUnusedReplacement(
        provider,
        newServerId,
        newIp,
        'New standby server deleted. The old standby is still running.',
      );
      throw scaleErr;
    }
    server._replacement = replacementEntry(ctx, server, { newServerId, newIp });
    s.start(`Reseeding the new standby ${newIp} from the primary ${primary.ip}...`);
    const replication = await rejoinComposeStandby({
      environment,
      projectName,
      envConfig,
      primary,
      standby: { ip: newIp, entry: server },
      sshKeyPath,
      provider,
    });
    s.stop(
      replication === 'streaming'
        ? 'New standby streaming from the primary'
        : 'New standby not proven streaming',
    );
    if (replication !== 'streaming' && !primaryTarget) {
      // A standby-only scale must not trade a working standby for an unproven
      // one: keep the old standby, delete the new one, and point the tunnel
      // and replication back at the old standby.
      delete server._replacement;
      await deleteUnusedReplacement(
        provider,
        newServerId,
        newIp,
        'New standby server deleted. The old standby is kept.',
      );
      s.start(`Reseeding the old standby ${server.ip} from the primary ${primary.ip}...`);
      const back = await rejoinComposeStandby({
        environment,
        projectName,
        envConfig,
        primary,
        standby: { ip: server.ip, entry: server },
        sshKeyPath,
        provider,
      });
      s.stop(
        back === 'streaming'
          ? 'Old standby streaming from the primary again'
          : 'Old standby not proven streaming',
      );
      throw new Error(
        `the new standby ${newIp} could not be proven streaming, so it was deleted and the old ` +
          `standby ${server.ip} kept; ` +
          (back === 'streaming'
            ? 'it streams from the primary again. Rerun scale once the cause is fixed.'
            : `it is not proven streaming either, replication is degraded: run vibecarbon deploy ${environment} to rebuild it`),
      );
    }
    if (replication !== 'streaming') ctx.replicationDegraded = true;
    const stateEntry = scaledServerStateEntry(ctx, server);
    recordPendingServerState(environment, stateEntry);
    s.start(`Destroying old standby ${server.ip}...`);
    let deleteErr = null;
    try {
      await perfAsync('scale.destroyOldServer', () => provider.deleteServer(server.id));
      markPendingServerOldDeleted(environment, stateEntry.stack);
      s.stop(`Old standby destroyed: ${server.ip}`);
    } catch (err) {
      s.stop(`Old standby not destroyed: ${server.ip}`, 1);
      deleteErr = err;
    }
    // The new standby serves either way: config and Pulumi state name it.
    await renameReplacement(ctx, server._replacement);
    await syncScaledServerState(ctx, stateEntry);
    if (deleteErr) {
      throw new Error(
        `the new standby ${newIp} serves, but deleting ${describeOldServer(stateEntry.old)} failed: ` +
          `${firstLineOf(deleteErr)}. It keeps billing and nothing tracks it any more: ` +
          `delete it in the ${ctx.Provider?.NAME ?? 'provider'} console.`,
      );
    }
  };

  const arms = [
    // A primary arm that fails anywhere releases the standby arm's wait.
    ...(primaryTarget
      ? [
          scalePrimaryArm(primaryTarget).catch((err) => {
            primaryReady?.reject(err);
            throw err;
          }),
        ]
      : []),
    ...(standbyTarget ? [scaleStandbyArm(standbyTarget)] : []),
  ];
  // allSettled: every arm finishes its own cleanup before the effect returns.
  const settled = ha
    ? await perfAsync('scale.ha.fan', () => Promise.allSettled(arms))
    : await Promise.allSettled(arms);
  const failure = settled.find((r) => r.status === 'rejected');

  // The primary moved and the standby was not replaced (a primary-only
  // scale, or a standby arm that stopped): the standby streamed from the old
  // primary. Reseed it from the new one.
  if (ha && primaryTarget?._replacement && !standbyTarget?._replacement) {
    const standbyEntry = (envConfig.servers ?? []).find((sv) => sv.role === 'standby');
    if (standbyEntry?.ip) {
      // Never throws: an unproven reseed marks replication degraded and warns.
      const replication = await rejoinComposeStandby({
        environment,
        projectName,
        envConfig,
        primary: { ip: primaryTarget._replacement.ip, entry: primaryTarget },
        standby: { ip: standbyEntry.ip, entry: standbyEntry },
        sshKeyPath,
        provider,
      });
      if (replication !== 'streaming') ctx.replicationDegraded = true;
    }
  }

  if (failure) {
    // A server that took over is recorded even though the scale failed, so
    // every later command reaches the server that serves.
    if (targetServers.some((sv) => sv._replacement)) saveScaledServers(ctx);
    throw failure.reason;
  }
}

/**
 * Write the scaled servers into the CURRENT .vibecarbon.json, under the
 * config lock: a reseed's proof (ha.systemIdentifier), an unproven one
 * (replication: degraded) and the cutover journal were saved during the
 * scale, and the in-memory env config predates all of them. `extra` lands on
 * the env entry.
 */
function saveScaledServers(ctx, extra = {}) {
  const { environment, envConfig } = ctx;
  const servers = ctx.servers ?? ctx.targetServers;
  const byOldId = new Map(
    servers.filter((sv) => sv._replacement).map((sv) => [sv.id, sv._replacement]),
  );
  updateProjectConfig((fresh) => {
    const freshEnv = fresh.environments?.[environment] ?? envConfig;
    const updatedServers = (freshEnv.servers ?? servers).map((sv) => byOldId.get(sv.id) ?? sv);
    fresh.environments = fresh.environments ?? {};
    fresh.environments[environment] = preserveSafetyFields(fresh.environments[environment], {
      ...freshEnv,
      ...extra,
      servers: updatedServers,
    });
  });
}

/** compose/compose-ha `update-project-config` effect: persist the scaled
 *  server identities (+ unified serverType, when every server was scaled)
 *  into .vibecarbon.json. */
async function scaleUpdateComposeConfig(ctx) {
  const { servers, targetServers, newType } = ctx;
  const allScaled = servers.every((s) => !s.id || targetServers.some((t) => t.id === s.id));
  saveScaledServers(ctx, allScaled ? { serverType: newType } : {});
  for (const server of servers) delete server._replacement;
}

/** compose/compose-ha `finish-outro` effect. */
async function scaleFinishComposeOutro(ctx) {
  const { currentType, newType, provider, projectName, environment, writePauseMs } = ctx;
  const { replicationDegraded } = ctx;
  // Replacement servers are new droplets — re-file them into the dedicated
  // cloud project where the provider needs post-hoc assignment (DO).
  await runProjectAssignment(provider, { projectName, environment });
  const pause = Number.isFinite(writePauseMs)
    ? ` (writes paused ${formatPause(writePauseMs)})`
    : '';
  const degraded = replicationDegraded
    ? `. Replication is degraded: run vibecarbon deploy ${environment} to resync the standby`
    : '';
  // The servers moved, but a stack still names a deleted one: the command
  // fails, and the deploy that repairs state is named (each problem was
  // logged where it happened).
  if (ctx.serverStateProblems?.length) {
    p.outro(
      `${c.warning('Scale complete, but Pulumi state still names the old server.')} ` +
        `${c.bold(currentType)} → ${c.bold(newType)}${pause}; ${serverStateRecovery(environment)}${degraded}`,
    );
    process.exitCode = 1;
    return;
  }
  p.outro(
    `${c.success('Scale complete!')} ${c.bold(currentType)} → ${c.bold(newType)}${pause}${degraded}`,
  );
}

/**
 * Where the apex and wildcard A records point, read back through the DNS
 * provider after an update that failed (or on a resume).
 *   - `old`: every record read, all on the old server alone (DNS never moved);
 *   - `moved`: every record on the new server alone;
 *   - `partial`: anything in between;
 *   - `unknown`: a record could not be read, or the failed update timed out
 *     (the provider may still apply it), where it would otherwise read `old`.
 * `pending` names each record not yet on the new IP.
 *
 * @returns {Promise<{ state: 'old'|'moved'|'partial'|'unknown', pending: string[] }>}
 */
export async function readDnsMove(
  envConfig,
  apiToken,
  domain,
  { oldIp, newIp, dnsError = null },
  deps = {},
) {
  const names = [domain, `*.${domain}`];
  const dnsProvider = envConfig.dnsProvider || envConfig.dns?.provider;
  const zoneId = envConfig.dns?.zoneId;
  const unread = { state: 'unknown', pending: names.map((n) => `${n} (could not read it back)`) };
  if (!hasAutomatedDns(dnsProvider) || !zoneId) return unread;
  const token = resolveDnsToken(dnsProvider, {
    computeProviderId: providerIdFor(envConfig),
    computeToken: apiToken,
  });
  if (!token) return unread;
  let targets;
  try {
    const { getDnsProvider: load = getDnsProvider } = deps;
    const dns = await load(dnsProvider);
    targets = await Promise.all(names.map((n) => dns.readARecord(token, zoneId, n)));
  } catch {
    return unread;
  }
  const pending = names.flatMap((n, i) =>
    targets[i].length === 1 && targets[i][0] === newIp
      ? []
      : [`${n} (now ${targets[i].join(', ') || 'no record'})`],
  );
  const allOld = targets.every((t) => t.length > 0 && t.every((ip) => ip === oldIp));
  const timedOut =
    !!dnsError &&
    (dnsError.timedOut === true ||
      /timed?[\s-]?out|timeout|ETIMEDOUT|ECONNRESET|aborted/i.test(String(dnsError.message ?? '')));
  if (allOld) return { state: timedOut ? 'unknown' : 'old', pending };
  return { state: pending.length === 0 ? 'moved' : 'partial', pending };
}

/**
 * Update DNS A records to point to the new server IP.
 */
async function updateDNS(envConfig, apiToken, domain, newIp) {
  const dnsProvider = envConfig.dnsProvider || envConfig.dns?.provider;
  const zoneId = envConfig.dns?.zoneId;

  if (hasAutomatedDns(dnsProvider) && zoneId) {
    // Same-token rule: native DNS reuses the compute token already in hand;
    // cross-cloud DNS (e.g. Cloudflare) resolves from its own env var.
    const token = resolveDnsToken(dnsProvider, {
      computeProviderId: providerIdFor(envConfig),
      computeToken: apiToken,
    });
    if (token) {
      const dns = await getDnsProvider(dnsProvider);
      await dns.upsertApexAndWildcard({ token, zoneId }, domain, newIp);
      p.log.info(`DNS updated via ${DNS_PROVIDERS[dnsProvider].name}: ${domain} → ${newIp}`);
      return;
    }
    p.log.warn(`Update DNS manually: ${domain} → ${newIp}`);
    return;
  }
  if (domain) {
    p.log.warn(`Update your DNS A record: ${domain} → ${newIp}`);
  }
}

// waitForDNSPropagation now lives in src/lib/dns-propagation.js (imported
// at the top of this file). The compose deploy path needs the same
// utility for the cold-deploy ACME race fix; extracting it lets both
// paths share the implementation.

// ============================================================================
// MAIN
// ============================================================================

// Tier → scale strategy. scaleCompose / scaleK8s are hoisted function
// declarations, so referencing them here at module scope is safe. Compose and
// compose-ha share one strategy (it branches on isHATier internally); likewise
// k8s / k8s-ha.
const SCALE_STRATEGIES = {
  compose: scaleCompose,
  'compose-ha': scaleCompose,
  k8s: scaleK8s,
  'k8s-ha': scaleK8s,
};

export async function run(args) {
  const { values, positional, handled } = parseFlagsOrExit(args, SPEC);
  if (handled) return;

  // Project guard runs before banner so an accidental `vibecarbon
  // scale` from a parent directory emits the canonical message.
  const projectConfig = assertInProjectDir();

  introCommand('scale');

  // Heal pre-2026-09-20 POSIX-quoted lines in the local .env/.env.local
  // before anything reads them: the compose strategy bundles the local .env
  // as the new server's baseline (renderBundle), and the provider token is
  // resolved from .env.local. A truncated read would ship as-is.
  repairLegacyEnvQuoting(process.cwd());

  const envs = projectConfig.environments || {};
  const deployedEnvs = Object.entries(envs)
    .filter(([, cfg]) => cfg.status === 'deployed')
    .map(([name]) => name);

  if (deployedEnvs.length === 0) {
    p.log.error('No deployed environments found. Run `vibecarbon deploy` first.');
    process.exit(1);
  }

  // Build a legacy-shaped `parsed` struct for the orchestration code below.
  // Worker-bound flags are gone in the new flag set — the prompt covers
  // them — so they're nulls here.
  const envSeed =
    /** @type {string|undefined} */ (positional.env) ||
    /** @type {string|null} */ (values.env) ||
    null;
  const parsed = {
    env: envSeed,
    type: /** @type {string|null} */ (values.type),
    yes: !!values.y,
    minWorkers: null,
    maxWorkers: null,
  };

  // TTY guard: env prompt fires if multi-deployed and no seed.
  requireTTYOrFlags({
    requirements: [
      {
        flag: 'env',
        description: 'name an environment to scale',
        satisfied: !!envSeed || deployedEnvs.length <= 1,
      },
    ],
  });

  // Select environment. Filters to deployed envs only — different from
  // selectEnvironment, which lists all envs regardless of status.
  let environment = parsed.env;
  if (!environment) {
    if (deployedEnvs.length === 1) {
      environment = deployedEnvs[0];
      p.log.info(`Using environment: ${c.bold(environment)}`);
    } else {
      environment = await p.select({
        message: 'Which environment to scale?',
        options: deployedEnvs.map((e) => ({ value: e, label: e })),
      });
      if (p.isCancel(environment)) {
        exitCancelled();
      }
    }
  }
  parsed.env = environment;

  const envConfig = envs[environment];
  if (!envConfig) {
    p.log.error(`Environment "${environment}" not found in .vibecarbon.json`);
    process.exit(1);
  }

  // `-type` is raw operator input — it bypasses every option list, so the
  // catalog filtering that keeps ARM out of the prompts does nothing for it.
  // Reject a non-amd64 SKU here, once, for both the compose and k8s strategies
  // (scaleCompose takes options.type verbatim; scaleK8s feeds parsed.type to
  // planK8sScaleChanges). vibecarbon is x86-64 only — see
  // src/lib/deploy/platform.js.
  try {
    providerFor(envConfig).assertAmd64ServerType(parsed.type, '-type');
  } catch (err) {
    p.log.error(err.message);
    process.exit(1);
  }

  // Dispatch to the tier's scale strategy. The 4th arg carries the parsed
  // flags plus the resolved `tier` so each strategy dispatches on tier /
  // isHATier(tier) instead of re-deriving deployMode+ha.
  //
  // No license gate here: operating an existing environment (scale, backup,
  // restore, failover) never consults the license, in every deploy mode.
  // Only `deploy` into a Kubernetes or HA environment does, and it does so
  // on every run, provisioning and redeploy alike (see
  // src/lib/licensing/gate.js).
  const tier = resolveTier(envConfig);
  if (isHATier(tier)) {
    // A failover in flight may be mid-swap: a resize would act on roles that
    // are about to change (or reboot the standby mid-promote).
    refuseOrContinue(() => assertNoFailoverInFlight({ environment, envConfig, action: 'scale' }));
    // k8s-ha scale applies to both clusters, so a retired one refuses it all.
    if (tier === 'k8s-ha') {
      refuseOrContinue(() =>
        assertScaleNotRetired({
          environment,
          envConfig,
          targetIps: [envConfig.ha?.primary?.masterIp, envConfig.ha?.standby?.masterIp].filter(
            Boolean,
          ),
        }),
      );
    }
  }

  await SCALE_STRATEGIES[tier](environment, envConfig, projectConfig, { ...parsed, tier });
}

// ============================================================================
// KUBERNETES SCALING
// ============================================================================

async function scaleK8s(environment, envConfig, projectConfig, parsed) {
  // Resolved once per flow — see providerFor() in lib/providers/index.js.
  const Provider = providerFor(envConfig);
  const region = envConfig.region || 'fsn1'; // Phase B: Provider.DEFAULT_REGION

  // Pre-fetch live server types (non-blocking, uses saved credentials if available)
  {
    const token = resolveProviderToken(providerIdFor(envConfig));
    if (token) await Provider.fetchServerTypes(token);
  }

  // Per-role types are optional in the deploy. The orchestrator saves only
  // `serverType` (the unified default) to .vibecarbon.json — the master/
  // database/worker types only appear here after a previous `scale` set
  // them. Fall back to envConfig.serverType so we don't send the em-dash
  // placeholder to Pulumi: doing so triggered ~serverType against the
  // already-provisioned `cx23` master/database servers and Hetzner replied
  // 'server type — not found'. `Provider` was resolved once above.
  //
  // Every role the scripted plan does not resize keeps its persisted type,
  // which converge and the CA worker-pool re-patch reuse. Refuse an ARM one
  // here, before any prompt, with the same message `-type` gets: with no
  // scripted plan (no `-y`, or `-type` without `-y`) that is every role.
  // (`-type` itself already passed the guard in scale(); convergeClusterInfra
  // re-checks whichever roles a run leaves un-overridden.)
  const plan = planK8sScaleChanges(parsed, envConfig);
  let currentMasterType, currentDbType, currentWorkerType;
  try {
    ({
      masterType: currentMasterType,
      dbType: currentDbType,
      workerType: currentWorkerType,
    } = assertPersistedRoleTypes(Provider, envConfig, plan?.newValues));
  } catch (err) {
    p.log.error(err.message);
    process.exit(1);
  }
  // k8s-ha: the serving primary's own record, not the top level, which
  // describes the side that was primary at the first deploy.
  if (envConfig.ha?.enabled) {
    const primary = haStacksFrom(envConfig)?.primary;
    currentMasterType = primary?.masterServerType || currentMasterType;
    currentDbType = primary?.dbServerType || currentDbType;
    currentWorkerType = primary?.workerServerType || currentWorkerType;
  }

  // 3. Display current config
  const pad = 18;
  const configLines = [`${'Environment'.padEnd(pad)} ${c.bold(environment)}`];
  if (envConfig.ha?.enabled && envConfig.secondaryRegion) {
    configLines.push(`${'Primary region'.padEnd(pad)} ${c.bold(region)}`);
    configLines.push(
      `${'Standby region'.padEnd(pad)} ${c.bold(envConfig.secondaryRegion)}  ${c.dim('(will be scaled identically)')}`,
    );
  } else {
    configLines.push(`${'Region'.padEnd(pad)} ${c.bold(region)}`);
  }
  configLines.push(
    `${'Master type'.padEnd(pad)} ${c.bold(currentMasterType)}`,
    `${'Database type'.padEnd(pad)} ${c.bold(currentDbType)}`,
    `${'Worker type'.padEnd(pad)} ${c.bold(currentWorkerType)}`,
  );
  p.note(configLines.join('\n'), 'Current Configuration');

  // 4. Select what to change
  // 5. Collect new values
  const newValues = {};
  const regionTypes = Provider.getServerTypesForRegion(region);
  const serverTypeOptions = buildSimpleTypeOptions(regionTypes, { filterSharedCpu: false });

  // Non-interactive plan (pure): `-yes -type` resizes every role; `-yes` +
  // bounds touches autoscaler bounds only. `null` means no scripted plan matched —
  // fall through to the interactive multiselect. See src/lib/scale-plan.js for
  // the branch rationale (in-place resize vs. master-replace guard, phase-8
  // bounds TODO). The user-facing logging stays here (side-effectful).
  let changes;
  if (plan) {
    changes = plan.changes;
    Object.assign(newValues, plan.newValues);
    if (changes.includes('masterType')) {
      p.log.info(
        `Scaling all node roles (master, database, worker) to ${c.bold(parsed.type)} ${c.dim('(in-place resize, ~2 min downtime per node)')}`,
      );
    } else {
      p.log.info(
        `Updating cluster-autoscaler bounds: ${c.bold(
          `min=${newValues.minWorkers ?? envConfig.minWorkers ?? DEFAULT_WORKER_MIN}`,
        )} ${c.bold(`max=${newValues.maxWorkers ?? envConfig.maxWorkers ?? DEFAULT_WORKER_MAX}`)}`,
      );
    }
  } else {
    changes = await p.multiselect({
      message: 'What would you like to change?',
      options: [
        { value: 'workerType', label: 'Worker server type (replace)' },
        {
          value: 'masterType',
          label: 'Master server type (~2 min control-plane downtime)',
        },
        {
          value: 'dbType',
          label: 'Database server type (database restart: back up first)',
        },
      ],
      required: true,
    });
    if (p.isCancel(changes)) {
      exitCancelled();
    }

    for (const change of changes) {
      if (change === 'workerType') {
        const val = await p.select({
          message: 'New worker server type:',
          options: serverTypeOptions,
          initialValue: serverTypeOptions.find((t) => t.value === currentWorkerType)?.value,
        });
        if (p.isCancel(val)) {
          exitCancelled();
        }
        newValues.workerType = val;
      } else if (change === 'masterType') {
        p.log.warn('Changing master type will cause ~2 minutes of control-plane downtime.');
        const val = await p.select({
          message: 'New master server type:',
          options: serverTypeOptions,
          initialValue: serverTypeOptions.find((t) => t.value === currentMasterType)?.value,
        });
        if (p.isCancel(val)) {
          exitCancelled();
        }
        newValues.masterType = val;
      } else if (change === 'dbType') {
        p.log.warn('Changing the database server type restarts the database, so back up first.');
        const val = await p.select({
          message: 'New database server type:',
          options: serverTypeOptions,
          initialValue: serverTypeOptions.find((t) => t.value === currentDbType)?.value,
        });
        if (p.isCancel(val)) {
          exitCancelled();
        }
        newValues.dbType = val;
      }
    }
  }

  // Server type changes apply via Pulumi up → Hetzner in-place resize per
  // node (~2 min reboot each).
  const infraChanges = changes.filter(
    (c) => c === 'workerType' || c === 'masterType' || c === 'dbType',
  );

  // isHATier(tier) is behavior-identical to `envConfig.ha?.enabled` for the k8s
  // tier; the `&& secondaryRegion` conjunct is kept because HA cluster fan-out
  // below also requires a configured standby region (registry predicate alone
  // is NOT equivalent here).
  const isHA = isHATier(parsed.tier) && envConfig.secondaryRegion;

  // The new types resize the cluster, and on k8s-ha the standby cluster too.
  // With the live catalog loaded, refuse a type a cluster's location does not
  // sell before any Pulumi run (offline there is nothing to check against).
  if (Provider._locationTypes) {
    const primaryRegion = (isHA && envConfig.ha?.primary?.region) || region;
    const standbyRegion = isHA
      ? (envConfig.ha?.standby?.region ?? envConfig.secondaryRegion)
      : null;
    const sides = [
      [isHA ? 'primary' : 'cluster', primaryRegion],
      ...(standbyRegion ? [['standby', standbyRegion]] : []),
    ];
    const newTypes = [newValues.masterType, newValues.dbType, newValues.workerType].filter(Boolean);
    for (const [side, location] of sides) {
      const sold = Provider._locationTypes[location] ?? new Set();
      const unsold = newTypes.find((type) => !sold.has(type));
      if (!unsold) continue;
      p.log.error(
        `the ${side}'s location ${location} does not sell ${unsold}, so the ${side} cannot be scaled to it`,
      );
      p.log.info(
        `${standbyRegion ? `pick a type both ${primaryRegion} and ${standbyRegion} sell` : `pick a type ${primaryRegion} sells`}:\n  vibecarbon scale ${environment} -type <type>`,
      );
      process.exit(1);
    }
  }
  p.note(`Current ${Provider.NAME} pricing: ${link(Provider.PRICING_URL)}`, 'Cost');

  // 6. Require API token if infra changes (server type swap) needed
  let apiToken = null;
  if (infraChanges.length > 0) {
    apiToken = await Provider.promptApiToken(projectConfig.projectName);
    if (!apiToken) {
      p.log.error('API token required for server type changes');
      process.exit(1);
    }
  }

  // Ensure operator IP is in the firewall allowlist before any SSH or k8s
  // API work. Skip when there's no apiToken (no infra changes and no SSH —
  // a no-op scale that just returns) since both paths below require token.
  if (apiToken) {
    try {
      // Firewall allowlist gate uses ha-vs-not only (no secondaryRegion
      // conjunct) — isHATier(tier) === `!!envConfig.ha?.enabled` for k8s.
      const result = await ensureOperatorIpAccess({
        projectConfig,
        environment,
        isHA: isHATier(parsed.tier),
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

  // 7+8. Apply changes — for HA environments, apply to both clusters
  const secondaryRegion = envConfig.secondaryRegion;

  // Everything from here on is the tier's scale EXECUTION (apply Pulumi +
  // cluster-autoscaler changes to every cluster → wait for the cluster(s) to
  // settle → persist sizing inputs → outro), expressed as a pure step-plan
  // (planScale) run against the SCALE_EFFECTS registry below. ctx carries
  // every value the effects need.
  const ctx = {
    environment,
    envConfig,
    projectConfig,
    region,
    secondaryRegion,
    isHA,
    changes,
    newValues,
    // currentWorkerType is still consumed by the CA re-patch below;
    // master/database current types are re-derived inside convergeClusterInfra
    // from envConfig, so they no longer need to ride in ctx.
    currentWorkerType,
    apiToken,
    infraChanges,
    Provider,
  };
  await runPlan(planScale(parsed.tier, envConfig), ctx, SCALE_EFFECTS);
}

/**
 * Resolve the ACTING primary/standby cluster identities for a k8s/k8s-ha
 * scale run from the persisted role↔stack mapping (Task 6/7:
 * `envConfig.ha.{primary,standby}.stack` — stacks are cluster IDENTITIES
 * named at birth, roles flip at failover). Falls back to the stack-birth
 * defaults `${environment}-primary` / `${environment}-standby` for a
 * pre-Task-7 (or first-ever) env that has no `.stack` persisted yet — same
 * `??` fallback shape as `haK8sProvisionClusters` in
 * lib/deploy/effects/k8s-ha.js.
 *
 * Each returned entry carries an explicit `role` so callers key gating
 * behavior (e.g. "skip the standby's app-tier pod-Ready wait") off the ROLE
 * directly, instead of re-deriving it by sniffing the resolved `clusterEnv`
 * string — after a failover the acting standby's stack can literally be
 * named `${environment}-primary` (or vice versa), so a suffix check would
 * misidentify it.
 *
 * @param {{ environment: string, envConfig: object, region: string, secondaryRegion?: string, isHA: boolean|string }} args
 * @returns {{ primary: { clusterEnv: string, clusterRegion: string, role: 'primary' }, standby?: { clusterEnv: string, clusterRegion: string, role: 'standby' } }}
 */
function resolveHaClusterRoles({ environment, envConfig, region, secondaryRegion, isHA }) {
  if (!isHA) {
    return { primary: { clusterEnv: environment, clusterRegion: region, role: 'primary' } };
  }
  return {
    primary: {
      clusterEnv: envConfig.ha?.primary?.stack ?? `${environment}-primary`,
      clusterRegion: envConfig.ha?.primary?.region ?? region,
      role: 'primary',
    },
    standby: {
      clusterEnv: envConfig.ha?.standby?.stack ?? `${environment}-standby`,
      clusterRegion: envConfig.ha?.standby?.region ?? secondaryRegion,
      role: 'standby',
    },
  };
}

/**
 * Mutate a carbon-autoscaler config Secret's `config.json` for a scale
 * bounds/type re-patch: adjust `nodeGroups['worker-pool']`'s `maxSize`
 * (headroom above the Pulumi-static floor) and, when a new server type is
 * given and differs from the current one, its `serverType`. Every other
 * field — cloudInit, sshKeyName, serverLabels, etc. — is left byte-untouched.
 *
 * Pure function (parse → mutate → stringify, no I/O) so the re-patch's
 * mutate step is testable without a live cluster; `scaleApplyK8sChanges`
 * below wraps it with the actual `kubectl get secret` / `apply -f -` I/O.
 *
 * `maxSize = Math.max(0, newMax - newMin)` mirrors the EXACT arithmetic
 * `renderCarbonAutoscalerConfig` uses at deploy time (same bounds-pair-in,
 * headroom-out contract) — the deploy-time render and this re-patch must
 * never diverge on what "headroom" means for the same (min, max) pair.
 *
 * Throws if `nodeGroups['worker-pool']` is missing — the only pool this repo
 * ever provisions; its absence means the Secret was hand-edited or corrupted,
 * and a silent no-op mutate would leave the operator's scale request applied
 * nowhere.
 *
 * @param {string} configJson  Current `config.json` Secret value (parseable JSON).
 * @param {{newMin: number, newMax: number, newType?: string}} bounds
 * @returns {string} JSON.stringify'd (2-space indent) mutated config
 */
export function applyCaBoundsToConfig(configJson, { newMin, newMax, newType }) {
  const config = JSON.parse(configJson);
  const group = config?.nodeGroups?.['worker-pool'];
  if (!group) {
    throw new Error(
      "applyCaBoundsToConfig: carbon-autoscaler-config Secret has no nodeGroups['worker-pool'] " +
        '(the only pool this repo provisions), was the Secret hand-edited?',
    );
  }
  group.maxSize = Math.max(0, newMax - newMin);
  if (newType !== undefined && newType !== group.serverType) {
    group.serverType = newType;
  }
  return JSON.stringify(config, null, 2);
}

/**
 * k8s/k8s-ha `apply-scale-changes` effect: apply server-type changes via
 * Pulumi (in-place resize per node, ~2 min reboot) to the primary (or single)
 * cluster, then — when HA — to the standby cluster, each gated by the
 * master-replace defense (refuses to proceed if the Pulumi preview would
 * replace the master node) and followed by a cluster-autoscaler config
 * re-patch when worker type/bounds changed.
 *
 * This is a faithful relocation of the (now removed) inlined
 * `applyScaleChanges` + its primary/standby invocation from `scaleK8s` — same
 * operations, order, args, probe-and-replay semantics, and fail-fast/warn
 * behavior. It is a single cohesive, per-cluster routine (Pulumi program
 * build → k3sToken probe → preview + master-replace guard → upStack → CA
 * re-patch) reused verbatim for both clusters — mirroring the deployK3s
 * black-box precedent — so it stays ONE effect that owns the whole fan-out.
 */
async function scaleApplyK8sChanges(ctx) {
  const {
    environment,
    envConfig,
    projectConfig,
    region,
    secondaryRegion,
    isHA,
    changes,
    newValues,
    // Only currentWorkerType is still read here (CA re-patch). The converge
    // seam re-derives master/database current types from envConfig.
    currentWorkerType,
    apiToken,
    infraChanges,
    Provider,
  } = ctx;

  async function applyScaleChanges({ clusterEnv, clusterRegion, label, overrides, caBounds }) {
    // Apply server type changes to this cluster via the hardened, reusable
    // converge seam (src/lib/iac/converge-cluster.js) — the SAME Pulumi path
    // the pilot-light failover uses to bring a standby's workers 0→N. The seam
    // owns the danger zone (HA shared-key re-resolve, s3Config reconstruction,
    // k3sToken probe/replay, master-replace preview guard, upStack) and THROWS
    // on any fatal condition instead of calling process.exit — callers own exit
    // behavior. We reproduce scale's exact prior UX here: a thrown abort
    // carries `logLines` (the p.log.error sequence the block used to emit
    // inline); replay each line, then process.exit(1).
    if (infraChanges.length > 0) {
      try {
        await convergeClusterInfra({
          projectConfig,
          envConfig,
          Provider,
          apiToken,
          clusterEnv,
          clusterRegion,
          environment,
          isHA,
          // overrides fills buildProgramConfig's `newValues` slot. Callers
          // pass `newValues` verbatim for the primary/single invocation, and
          // `{ ...newValues, minWorkers: 0, maxWorkers: 0 }` for the standby
          // invocation — a scale must never re-warm the pilot-light cluster.
          overrides,
          // s3Creds null → the module owns the prompt, so scale's observable
          // prompt order/count is byte-identical (prompt fires inside the
          // converge sequence, once per applyScaleChanges call — HA prompts
          // twice, exactly as before this extraction).
          s3Creds: null,
          label,
        });
      } catch (err) {
        const lines = Array.isArray(err.logLines) ? err.logLines : [err.message];
        for (const line of lines) p.log.error(line);
        process.exit(1);
      }
    }

    // Phase 8: re-patch the carbon-autoscaler-config Secret's `config.json`
    // whenever bounds or worker type changed. `nodeGroups['worker-pool']`
    // carries `maxSize` (the CA headroom above the Pulumi-static floor) and
    // `serverType` (what CA spawns for new nodes) — bumping the type without
    // re-patching this Secret leaves CA spawning the OLD type for any new
    // nodes. Bumping bounds without a type change still requires a re-patch.
    // See `applyCaBoundsToConfig` (above) for the pure mutate step.
    //
    // When --type is passed alongside bounds (or vs Pulumi already
    // resized workers), CA-spawned workers should also be drained so CA
    // re-spawns them at the new type. That drain step is deferred to a
    // follow-up — for now we surface a 1-line warning.
    const needsCaRepatch = changes.includes('workerType') || changes.includes('workerBounds');
    if (needsCaRepatch) {
      const kubeconfigPath = join(process.cwd(), '.vibecarbon', `kubeconfig-${clusterEnv}`);
      if (!existsSync(kubeconfigPath)) {
        p.log.warn(`kubeconfig missing at ${kubeconfigPath} (${label}); skipping CA re-patch`);
      } else {
        // The pilot-light standby is a special case: Pulumi's static worker
        // floor stays 0/0 (see `overrides` above), but the cluster-autoscaler
        // config's `maxSize` must keep the DORMANT bounds a failover relies on
        // — deploy renders the standby's CA with min=caBoundsMin (the primary's
        // floor) and max=the primary's max, so a failover only flips CA's
        // replica count 0→1 and NEVER re-renders its config. Rendering the
        // standby CA from its 0/0 overrides would destroy those bounds.
        // `caBounds` carries the dormant floor/max explicitly for the
        // standby invocation; primary/single keep deriving from
        // overrides→envConfig.
        const newMin = caBounds
          ? caBounds.min
          : (overrides.minWorkers ?? envConfig.minWorkers ?? DEFAULT_WORKER_MIN);
        const newMax = caBounds
          ? caBounds.max
          : (overrides.maxWorkers ?? envConfig.maxWorkers ?? DEFAULT_WORKER_MAX);
        const newType = overrides.workerType ?? currentWorkerType;
        // Re-patch the carbon-autoscaler-config Secret's config.json in
        // place: read both keys (config.json + token) off the live Secret,
        // mutate ONLY the worker-pool node group's maxSize/serverType via
        // the pure applyCaBoundsToConfig helper, and re-apply via the same
        // stdin `kubectl apply -f -` pattern applyK3sManifests uses to
        // create this Secret (src/lib/deploy/k8s/k3s.js) — secrets never
        // touch argv. A rollout restart repoints both CA containers at the
        // fresh mount; the sidecar also hot-reloads on its own
        // mtime-watched Refresh, but the restart keeps `scale`'s completion
        // deterministic instead of polling for the sidecar to notice.
        const caSpinner = spinner();
        caSpinner.start(`Re-patching cluster-autoscaler config (${label})`);
        try {
          // .data values in a kubectl-returned Secret are ALWAYS base64 (k8s
          // stores stringData as base64 under the hood too) — decode both
          // keys before treating them as plain text/JSON. runCommand returns
          // the captured stdout string when `silent: true`.
          const configB64Raw = runCommand(
            [
              'kubectl',
              '--kubeconfig',
              kubeconfigPath,
              '-n',
              'kube-system',
              'get',
              'secret',
              'carbon-autoscaler-config',
              '-o',
              'jsonpath={.data.config\\.json}',
            ],
            { silent: true },
          );
          const tokenB64Raw = runCommand(
            [
              'kubectl',
              '--kubeconfig',
              kubeconfigPath,
              '-n',
              'kube-system',
              'get',
              'secret',
              'carbon-autoscaler-config',
              '-o',
              'jsonpath={.data.token}',
            ],
            { silent: true },
          );
          const configJson = Buffer.from(
            typeof configB64Raw === 'string' ? configB64Raw.trim() : '',
            'base64',
          ).toString('utf8');
          const token = Buffer.from(
            typeof tokenB64Raw === 'string' ? tokenB64Raw.trim() : '',
            'base64',
          ).toString('utf8');
          const mutatedConfigJson = applyCaBoundsToConfig(configJson, { newMin, newMax, newType });
          // Mirrors renderCarbonAutoscalerConfig's Secret YAML shape in
          // applyK3sManifests (k3s.js) exactly: stringData keeps both the
          // token and the JSON off argv, piped via stdin.
          const caSecretYaml = [
            'apiVersion: v1',
            'kind: Secret',
            'metadata:',
            '  name: carbon-autoscaler-config',
            '  namespace: kube-system',
            'type: Opaque',
            'stringData:',
            `  token: ${JSON.stringify(token)}`,
            `  config.json: ${JSON.stringify(mutatedConfigJson)}`,
            '',
          ].join('\n');
          runCommand(['kubectl', '--kubeconfig', kubeconfigPath, 'apply', '-f', '-'], {
            silent: true,
            input: caSecretYaml,
          });
          runCommand(
            [
              'kubectl',
              '--kubeconfig',
              kubeconfigPath,
              '-n',
              'kube-system',
              'rollout',
              'restart',
              'deploy/cluster-autoscaler',
            ],
            { silent: true },
          );
          const maxSize = Math.max(0, newMax - newMin);
          caSpinner.stop(
            `cluster-autoscaler re-patched (${label}): worker-pool 0:${maxSize}:${newType}`,
          );
          if (changes.includes('workerType')) {
            p.log.warn(
              `CA-spawned workers (if any) are still on the old type. ` +
                `Drain them with kubectl drain so CA respawns at the new type.`,
            );
          }
        } catch (err) {
          caSpinner.stop(`CA re-patch failed (${label})`);
          p.log.warn(
            `Could not re-patch cluster-autoscaler: ${err.message?.split('\n')[0] || err}`,
          );
        }
      }
    }
  }

  // Resolve the ACTING cluster identities from the persisted role↔stack
  // mapping — after a failover, roles are swapped and a scale must target
  // whichever physical stack is CURRENTLY playing each role, not the
  // stack-birth `${environment}-primary`/`-standby` names.
  const haRoles = resolveHaClusterRoles({ environment, envConfig, region, secondaryRegion, isHA });

  // k8s-ha: each cluster keeps its OWN recorded types for every role this
  // scale does not change. The top-level types describe the side that was
  // primary at the first deploy; the two sides may run different types (the
  // standby's location may not sell the primary's), and a failover swaps
  // them. Seeding each cluster's overrides from its own record keeps Pulumi
  // from resizing an unchanged role to a type its location does not sell,
  // and the CA re-patch on that cluster's own worker type. The new values
  // win. Plain k8s keeps the new values alone.
  const sides = isHA ? haStacksFrom(envConfig) : null;
  const ownTypes = (side) => {
    const recorded = {
      masterType: side?.masterServerType,
      dbType: side?.dbServerType,
      workerType: side?.workerServerType,
    };
    return Object.fromEntries(
      Object.entries(recorded).filter(([key, type]) => type && newValues[key] == null),
    );
  };

  // Apply to primary (or single) cluster — keeps envConfig's persisted sizing.
  await applyScaleChanges({
    clusterEnv: haRoles.primary.clusterEnv,
    clusterRegion: haRoles.primary.clusterRegion,
    label: isHA ? `primary: ${haRoles.primary.clusterRegion}` : haRoles.primary.clusterRegion,
    overrides: isHA ? { ...ownTypes(sides?.primary), ...newValues } : newValues,
  });

  // Apply to standby cluster if HA — Pulumi's static worker floor forced to
  // 0/0 (the pilot-light standby must never be re-warmed by a routine scale;
  // only `failover` converges it 0→N). The carbon-autoscaler config Secret's
  // node-group bounds, however, keep the DORMANT bounds a failover relies
  // on: min = the primary's floor (matching deploy's caBoundsMin = minWorkers
  // ?? 1), max = the scale's effective primary max. Rendering it from 0/0
  // would delete those bounds and a failover (which only scales CA 0→1)
  // could never spawn workers.
  if (isHA) {
    p.log.step(`Applying same changes to standby cluster (${haRoles.standby.clusterRegion})...`);
    await applyScaleChanges({
      clusterEnv: haRoles.standby.clusterEnv,
      clusterRegion: haRoles.standby.clusterRegion,
      label: `standby: ${haRoles.standby.clusterRegion}`,
      overrides: { ...ownTypes(sides?.standby), ...newValues, minWorkers: 0, maxWorkers: 0 },
      caBounds: {
        min: newValues.minWorkers ?? envConfig.minWorkers ?? 1,
        max: newValues.maxWorkers ?? envConfig.maxWorkers ?? DEFAULT_WORKER_MAX,
      },
    });
  }
}

/**
 * k8s-ha `re-establish-ha-tunnel` effect (item I-1): after a resize rebooted
 * the database node(s), the imperative host `wg0` is gone, the hostNetwork
 * repl-gateway Pod crash-loops (can't bind its tunnel IP), and the primary's
 * post-resize pods-Ready wait (below) would then time out for 10 min and fail
 * scale. Recreate wg0 (also retrofits the boot-persistence systemd unit) and
 * bounce the gateway on both clusters BEFORE that wait.
 *
 * Gated at the plan level to HA (`when: ctx.isHA`); here we further no-op
 * unless the DATABASE node type actually changed — only a database-node resize
 * reboots the node that owns wg0, so on a master/worker-only resize the tunnel
 * survives and we must NOT needlessly tear down a healthy wg0. Best-effort: a
 * failure warns (the operator can `vibecarbon deploy` to fully restore) and the
 * verify-ready diag below still fires if the gateway stays down.
 */
async function scaleReestablishHaTunnel(ctx) {
  const { environment, envConfig, projectConfig, isHA, infraChanges } = ctx;
  if (!isHA) return; // single-cluster k8s has no replication tunnel
  if (!infraChanges?.includes('dbType')) {
    // Master/worker-only resize: the database node (owner of wg0) never
    // rebooted, so the tunnel is intact — leave the healthy wg0 alone.
    p.log.info(
      'Database node type unchanged, skipping WireGuard tunnel re-establish (wg0 not disrupted).',
    );
    return;
  }

  const { identifyServers } = await import('./failover.js');
  const { reestablishReplicationTransport } = await import('./lib/deploy/k8s/index.js');
  const servers = identifyServers(environment, envConfig, projectConfig);
  if (!servers?.primary?.dbIp || !servers?.standby?.dbIp) {
    p.log.warn(
      'Could not resolve HA database node IPs from config, skipping post-resize WireGuard ' +
        're-establish. If replication is down, run `vibecarbon deploy` to restore it.',
    );
    return;
  }
  const sshKeyPath = join(process.cwd(), '.vibecarbon', `deploy_key_${environment}`);
  const s = spinner();
  s.start('Re-establishing WireGuard replication tunnel after database-node resize');
  try {
    await reestablishReplicationTransport({
      primaryIp: servers.primary.ip,
      standbyIp: servers.standby.ip,
      primaryDbIp: servers.primary.dbIp,
      standbyDbIp: servers.standby.dbIp,
      primaryDbPrivateIp: servers.primary.dbPrivateIp,
      standbyDbPrivateIp: servers.standby.dbPrivateIp,
      sshKeyPath,
    });
    s.stop('WireGuard tunnel re-established (wg0 recreated, repl-gateway restarted)');
  } catch (err) {
    s.stop('WireGuard tunnel re-establish failed, continuing to readiness wait', 1);
    p.log.warn(
      `Could not re-establish the replication tunnel after resize: ${err.message?.split('\n')[0] || err}. ` +
        'Run `vibecarbon deploy` to fully restore replication.',
    );
  }
}

/**
 * k8s/k8s-ha `verify-ready` effect: wait for every resized cluster to settle
 * before returning — API server healthz, then the hcloud-csi-node DaemonSet
 * rollout, then (primary/single only — the standby's replica-mode app tier
 * is not expected to Ready until failover) all vibecarbon pods Ready. A
 * faithful relocation of the (now removed) inlined `clustersToVerify` loop
 * from `scaleK8s` — same order, budgets, and diag-dump-on-timeout behavior.
 */
async function scaleVerifyK8sReady(ctx) {
  const { environment, envConfig, region, secondaryRegion, isHA, Provider } = ctx;

  // Hetzner in-place server_type changes are ~2 min reboots per node.
  // Pulumi's upStack returns when the VM is back up + k3s reports
  // ready, but stateful workloads inside the cluster (notably
  // the db StatefulSet's Postgres) need additional time to finish
  // their own init / WAL replay before they accept connections. If
  // the next caller (e.g. e2e backup step) runs against a
  // still-recovering cluster, pg_dump gets "connection refused" and
  // the work fails for what looks like a backup bug but is actually
  // a "scale didn't wait for the cluster to settle" problem. Observed
  // 2026-04-28 e2e — every backup-step failure across three
  // reruns had this same root cause.
  //
  // Wait for all pods in the vibecarbon namespace to reach
  // Ready=True. The db StatefulSet's readiness probe is a TCP
  // pg_isready on 5432 (k8s/base/db/statefulset.yaml), so once that pod
  // is Ready the connection-refused window has closed.
  //
  // clusterEnv is resolved from the persisted role↔stack mapping (same
  // resolveHaClusterRoles helper scaleApplyK8sChanges uses) so this verifies
  // the ACTING clusters post-failover, not the stack-birth names. Each entry
  // carries its role explicitly (`isStandby`) — see the gate below, which
  // keys off this instead of sniffing clusterEnv's suffix.
  const haRoles = resolveHaClusterRoles({ environment, envConfig, region, secondaryRegion, isHA });
  const clustersToVerify = isHA
    ? [
        {
          env: haRoles.primary.clusterEnv,
          label: `primary: ${haRoles.primary.clusterRegion}`,
          isStandby: false,
        },
        {
          env: haRoles.standby.clusterEnv,
          label: `standby: ${haRoles.standby.clusterRegion}`,
          isStandby: true,
        },
      ]
    : [{ env: environment, label: region, isStandby: false }];
  // 10 min is the floor that holds for HA (k8s-ha rerun 2026-04-28: standby
  // timed out 12/12 pods at 5 min — the db pod alone needs ~60-90s to
  // start postgres after a node reboot, then the rest of the tier
  // dependency-chains off it, then app pulls images that may not be cached
  // on the freshly-rebooted node). Single-cluster k8s only used ~70s of
  // its old 300s budget, so the bump costs nothing on the happy path.
  const WAIT_TIMEOUT_SEC = 600;
  for (const { env: clusterEnv, label, isStandby } of clustersToVerify) {
    const kubeconfigPath = join(process.cwd(), '.vibecarbon', `kubeconfig-${clusterEnv}`);
    if (!existsSync(kubeconfigPath)) {
      p.log.warn(
        `kubeconfig missing at ${kubeconfigPath} (${label}); skipping post-resize Ready wait`,
      );
      continue;
    }
    // Wait for the API server to be reachable BEFORE running any kubectl
    // commands. RCA from k8s scale failure 2026-05-07 (e2e run
    // bt5zvlw7n): Pulumi's upStack returns when the Hetzner VM is back up
    // and k3s reports ready inside the master, but the floating IP that
    // kubeconfig points at re-attaches asynchronously — there's a 30-90s
    // window where `kubectl --kubeconfig ...` returns
    // `ServiceUnavailable: the server is currently unable to handle the
    // request`. The next call (`kubectl rollout status` for hcloud-csi-node)
    // exits in <1s with that error, then `kubectl wait --for=Ready pods`
    // does the same, and scale fails for what looks like "pods didn't
    // settle" but is actually "API server wasn't reachable yet". Poll
    // `--raw=/healthz` until we see ok before continuing — k3s's healthz
    // returns "ok" only when the apiserver + scheduler + controller-manager
    // are all alive, so a single success here means the cluster control
    // plane has truly stabilized post-resize.
    const apiSpinner = spinner();
    apiSpinner.start(`Waiting for API server to be reachable (${label})`);
    const API_READY_BUDGET_MS = 300_000;
    // Fixed 5s interval (backoffFactor: 1) under a 300s budget — the probe
    // throws while the floating IP is re-attaching (runCommand rejects on
    // nonzero exit when silent), and pollUntil retries a throwing probe.
    // Timeout still throws (preserving the old fail-fast); we re-wrap so the
    // operator-facing message and last-error detail are unchanged.
    try {
      await pollUntil(
        () => {
          runCommand(['kubectl', '--kubeconfig', kubeconfigPath, 'get', '--raw=/healthz'], {
            silent: true,
            timeout: 10_000,
          });
          return true;
        },
        {
          budgetMs: API_READY_BUDGET_MS,
          initialDelayMs: 5000,
          backoffFactor: 1,
          description: 'k8s API healthy after resize',
        },
      );
      apiSpinner.stop(`API server reachable (${label})`);
    } catch (err) {
      apiSpinner.stop(`API server (${label}) not reachable within 5 min`);
      const cause = err.cause;
      const lastApiErr = cause
        ? cause.message?.split('\n')[0]?.slice(0, 120) || String(cause).slice(0, 120)
        : '';
      throw new Error(
        `Kube API server for ${label} never returned /healthz=ok within 5 min after Pulumi resize. ` +
          `Last error: ${lastApiErr}`,
      );
    }
    // Wait for the Hetzner CSI driver DaemonSet to register on every
    // node BEFORE checking pod-Ready. RCA from k8s-ha standby failure
    // 2026-04-28 (live cluster repro under triple-node-reboot):
    // kubelet can flip the database node Ready before hcloud-csi-node
    // pod registers; the db pod then tries to mount its PVC and
    // hits "MountVolume.MountDevice failed... driver name
    // csi.hetzner.cloud not found in the list of registered CSI
    // drivers". The pod sandbox gets killed + recreated in a tight
    // loop, eventually enters CrashLoopBackOff with a 5-min backoff
    // timer that the pod-Ready wait then can't outrun. Waiting for
    // the DS rollout first eliminates the race entirely.
    // Display name derived from the same Provider.K8S_ASSETS value the
    // kubectl call below uses (was hardcoded to Hetzner's "hcloud-csi-node"
    // regardless of provider); stripping the "daemonset/" kind-prefix keeps
    // Hetzner's spinner text byte-identical to before.
    const csiDaemonSetName = Provider.K8S_ASSETS.csiNodeDaemonSet.replace(/^daemonset\//, '');
    const csiSpinner = spinner();
    csiSpinner.start(`Waiting for ${csiDaemonSetName} DaemonSet rollout (${label})`);
    try {
      await perfAsync('scale.waitForCsiNode', async () =>
        runCommand(
          [
            'kubectl',
            '--kubeconfig',
            kubeconfigPath,
            '-n',
            'kube-system',
            'rollout',
            'status',
            Provider.K8S_ASSETS.csiNodeDaemonSet,
            '--timeout=300s',
          ],
          { silent: true },
        ),
      );
      csiSpinner.stop(`${csiDaemonSetName} Ready on all nodes (${label})`);
    } catch {
      csiSpinner.stop(`${csiDaemonSetName} rollout did not complete in 5 min (${label})`);
      // Continue anyway — the pod-Ready wait below will surface any
      // real persistent issue via the diag dump.
    }
    // (Live debug 2026-04-28 found that bouncing pods to break a
    // CrashLoopBackOff cycle leaves the underlying CSI VolumeAttachment
    // stuck in "deletionTimestamp set, finalizer external-attacher/
    // csi-hetzner-cloud held" state — the db pod then sits in
    // Init:0/1 for 10+ min waiting for the new VolumeAttachment to
    // bind. Solution: do not bounce. Rely on the csi-node rollout
    // wait above eliminating the race in the first place; a pod that
    // entered BackOff before CSI registered will exit BackOff cleanly
    // once kubelet's next retry tick fires (5-min cap).)
    //
    // HA standby exception: skip the pod-Ready wait entirely when this
    // is the standby cluster. The standby's DB is supposed to be a
    // streaming replica (read-only), and the app-tier pods currently
    // can't satisfy their readiness probes against a read-only DB —
    // their probes call /api/health/ready (or similar) which times out
    // upstream and returns 503. `kubectl wait --all` then blocks until
    // its 10-min budget runs out and the scale step fails for what
    // looks like "scale didn't settle" but is actually "standby's app
    // tier is not designed to Ready before failover". Surfaced
    // 2026-04-29 in k8s-ha e2e run 674f03c3-8b7a after the
    // earlier deploy-step issues were fixed — scale was the first
    // step doing `wait --all` against the standby kubeconfig.
    //
    // The CSI rollout above already verifies node-level health
    // post-resize; pod-level readiness on standby is validated end-
    // to-end by the failover step (which promotes the DB and re-
    // probes the app pods). Until HA replication is properly wired
    // up — see memory: project_replication_broken.md ("K8s HA
    // replication never worked") — pod-Ready against standby is a
    // known false-failure mode.
    //
    // Gated on the cluster's ROLE (`isStandby`, carried on each
    // clustersToVerify entry from resolveHaClusterRoles above), NOT a
    // suffix sniff over clusterEnv — after a failover the acting standby's
    // stack can literally be named `${environment}-primary` (roles swap,
    // stack identities don't), so a name-based check would gate the wrong
    // cluster.
    if (isStandby) {
      p.log.info(
        `Skipping pod-Ready wait on standby (${label}): replica-mode app tier ` +
          `is not expected to Ready until failover; CSI rollout above already ` +
          `verified node-level health.`,
      );
      continue;
    }
    const podSpinner = spinner();
    podSpinner.start(`Waiting for vibecarbon pods to be Ready (${label})`);
    try {
      await perfAsync('scale.waitForPodsReady', async () =>
        runCommand(
          [
            'kubectl',
            '--kubeconfig',
            kubeconfigPath,
            '-n',
            'vibecarbon',
            'wait',
            '--for=condition=Ready',
            'pods',
            '--all',
            // Completed CronJob pods (the in-cluster backup job) never
            // report Ready, and `wait --all` blocks on them for the whole
            // budget — a time-of-day flake that fires only when a run
            // crosses the backup schedule during scale (e4 2026-08-29:
            // every pod 1/1 Running, one backup-* 0/1 Completed, 10-min
            // timeout). Terminal-phase pods are done, not not-ready.
            // phase!=Succeeded/Failed rather than phase=Running so Pending
            // pods still coming up are correctly waited on.
            '--field-selector=status.phase!=Succeeded,status.phase!=Failed',
            `--timeout=${WAIT_TIMEOUT_SEC}s`,
          ],
          { silent: true },
        ),
      );
      podSpinner.stop(`Pods Ready (${label})`);
    } catch (err) {
      podSpinner.stop(
        `Pods did not all become Ready within ${WAIT_TIMEOUT_SEC / 60} min (${label})`,
      );
      // On timeout, dump pod state + describe + logs of any non-Ready
      // pods so the next debug session knows *which* pods didn't
      // recover and *why* (CrashLoopBackOff/ImagePullBackOff/post-reboot
      // postgres init failure). Without this the failure attribution is
      // just "kubectl wait timed out" with no signal as to which
      // controller is wedged.
      try {
        runCommand(
          [
            'kubectl',
            '--kubeconfig',
            kubeconfigPath,
            '-n',
            'vibecarbon',
            'get',
            'pods',
            '-o',
            'wide',
          ],
          { silent: false, ignoreError: true },
        );
        runCommand(
          [
            'kubectl',
            '--kubeconfig',
            kubeconfigPath,
            '-n',
            'vibecarbon',
            'get',
            'events',
            '--sort-by=.lastTimestamp',
          ],
          { silent: false, ignoreError: true },
        );
        // Per-non-Ready-pod describe + previous-container logs. We
        // shell-pipe through bash because kubectl doesn't have a native
        // way to "describe + logs everything that isn't Ready". Pre-Ready
        // pods have no `--previous` so we attempt both with-and-without.
        // Container name is left out so kubectl picks the main container
        // (works for single-container pods; multi-container pods get a
        // generic dump which still tells us *something*).
        runCommand(
          [
            'bash',
            '-c',
            `KCFG="${kubeconfigPath}"; for pod in $(kubectl --kubeconfig "$KCFG" -n vibecarbon get pods --no-headers 2>/dev/null | awk '$2 !~ /^([0-9]+)\\/\\1$/ {print $1}'); do
  echo "=== describe $pod ===";
  kubectl --kubeconfig "$KCFG" -n vibecarbon describe pod "$pod" 2>&1 | head -n 80;
  echo "=== logs $pod (current) ===";
  kubectl --kubeconfig "$KCFG" -n vibecarbon logs "$pod" --tail=80 --all-containers 2>&1 | head -n 200;
  echo "=== logs $pod (previous) ===";
  kubectl --kubeconfig "$KCFG" -n vibecarbon logs "$pod" --tail=80 --all-containers --previous 2>&1 | head -n 200;
done`,
          ],
          { silent: false, ignoreError: true },
        );
      } catch {
        /* best-effort diag */
      }
      throw err;
    }
  }
}

/**
 * k8s/k8s-ha `update-project-config` effect: persist the new sizing inputs
 * (worker/master/database serverType + cluster-autoscaler bounds) into
 * .vibecarbon.json. Hetzner server_type changes are in-place resizes (not
 * replaces) per the master-replace guard's design comment above — the public
 * IP survives the type bump, so the persisted `servers[]` block still points
 * at the right hosts after scale; only the sizing inputs need updating.
 */
async function scaleUpdateK8sConfig(ctx) {
  const { environment, newValues, isHA } = ctx;
  // Patched onto the env as it is on disk now, under the config lock: the
  // in-memory envConfig predates everything this scale saved.
  updateProjectConfig((config) => {
    const envConfig = config.environments?.[environment] ?? ctx.envConfig;
    const updatedEnvFields = {
      ...(newValues.workerType && {
        workerServerType: newValues.workerType,
        serverType: newValues.workerType,
      }),
      ...(newValues.masterType && { masterServerType: newValues.masterType }),
      ...(newValues.dbType && { dbServerType: newValues.dbType }),
      // Phase 8: persist CA bounds so subsequent `vibecarbon deploy` and
      // `vibecarbon scale` runs replay the operator's most recent choice
      // rather than falling back to defaults.
      ...(newValues.minWorkers != null && { minWorkers: newValues.minWorkers }),
      ...(newValues.maxWorkers != null && { maxWorkers: newValues.maxWorkers }),
      // Task 11: a worker-type scale must also update the PILOT standby's
      // provisioning spec — `preflightPilotFailover` (src/failover.js) reads
      // `ha.standbyWorkerSpec.serverType` to decide what hardware to bring up
      // when it converges the standby 0→N. Without this, the NEXT failover
      // would still provision the OLD worker type even after an operator
      // scaled the live cluster to the new one. Spread envConfig.ha first so
      // the role↔stack mapping (primary/standby/.stack) and scaleUpList stay
      // untouched — only the worker spec and each side's types change.
      // Each side's own record (ha.{primary,standby}.*ServerType) takes the
      // new types too: scaleApplyK8sChanges resized both clusters, and a
      // redeploy builds each side from its record, so a stale one would undo
      // this scale (and, after a failover, resize the live primary back).
      ...(isHA &&
        envConfig.ha &&
        (newValues.workerType || newValues.masterType || newValues.dbType) && {
          ha: {
            ...envConfig.ha,
            ...(envConfig.ha.primary && {
              primary: {
                ...envConfig.ha.primary,
                ...(newValues.masterType && { masterServerType: newValues.masterType }),
                ...(newValues.dbType && { dbServerType: newValues.dbType }),
                ...(newValues.workerType && { workerServerType: newValues.workerType }),
              },
            }),
            ...(envConfig.ha.standby &&
              (newValues.masterType || newValues.dbType) && {
                standby: {
                  ...envConfig.ha.standby,
                  ...(newValues.masterType && { masterServerType: newValues.masterType }),
                  ...(newValues.dbType && { dbServerType: newValues.dbType }),
                },
              }),
            ...(newValues.workerType && {
              standbyWorkerSpec: {
                ...envConfig.ha.standbyWorkerSpec,
                serverType: newValues.workerType,
              },
            }),
          },
        }),
    };

    config.environments = config.environments ?? {};
    config.environments[environment] = preserveSafetyFields(config.environments[environment], {
      ...envConfig,
      ...updatedEnvFields,
    });
  });
}

/** k8s/k8s-ha `finish-outro` effect. */
async function scaleFinishK8sOutro(ctx) {
  // Cluster convergence may have created replacement/new droplets — re-file
  // them into the dedicated cloud project where the provider needs post-hoc
  // assignment (DO). The k8s ctx carries no provider instance, so build one.
  const K8sProvider = ctx.Provider ?? providerFor(ctx.envConfig);
  await runProjectAssignment(new K8sProvider(ctx.apiToken), {
    projectName: ctx.projectConfig.projectName,
    environment: ctx.environment,
  });
  p.outro(`${c.success('Scale complete!')} Configuration updated in .vibecarbon.json`);
}

// ============================================================================
// SCALE EFFECT REGISTRY
// ============================================================================
//
// The scale step-plan runner (runPlan) executes planScale(tier)'s steps
// (src/lib/deploy/plan/scale-plan.js) against this registry. Each effect is a
// thin, faithful relocation of the corresponding block from the (now removed)
// inlined `scaleCompose` / `scaleK8s` — same operations, order, args, fan-out
// parallelism, and warn/throw/exit semantics. compose and compose-ha share
// the SAME compose effects (the primary/standby fan-out is driven by
// ctx.targetServers, exactly as the removed SCALE_STRATEGIES table shared
// scaleCompose across both tiers); likewise k8s and k8s-ha share the k8s
// effects (the standby cluster fan-out is driven by ctx.isHA).
//
// This registry lives here (not in lib/deploy/effects/index.js): scale.js
// registers no module-load process handlers (unlike destroy.js's
// SIGINT/SIGTERM handlers), so either location would work, but keeping the
// per-server blue-green pipeline physically in this file keeps
// tests/integration/cli/scale/scale.test.ts — which greps src/scale.js for
// the exact VITE build-arg wiring — meaningful without a rewrite.
export const SCALE_EFFECTS = {
  // compose / compose-ha scale tier
  scaleRegisterSshKey,
  scaleServers,
  scaleUpdateComposeConfig,
  scaleFinishComposeOutro,
  // k8s / k8s-ha scale tier
  scaleApplyK8sChanges,
  scaleReestablishHaTunnel,
  scaleVerifyK8sReady,
  scaleUpdateK8sConfig,
  scaleFinishK8sOutro,
};

// Exported for tests.
export { SPEC };
