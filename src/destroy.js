/**
 * Vibecarbon Destroy Command
 * Safely tears down cloud resources created by deploy command
 *
 * Usage:
 *   vibecarbon destroy              # Interactive destruction
 *   vibecarbon destroy prod         # Destroy specific environment
 *   vibecarbon destroy prod -y      # Skip confirmation
 */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { backupsBucketHolders, backupsTargetOf } from './lib/backups-bucket.js';
import { exitCancelled, exitDeclined } from './lib/cli/exit-guard.js';
import { AmbiguousPrimaryError, resolvePrimary } from './lib/cli/resolve-primary.js';
import { runCommand } from './lib/command.js';

// Handle Ctrl+C — without this, SIGINT is swallowed during subprocess/fetch
// calls and the process continues to the next cleanup step instead of exiting.
process.on('SIGINT', () => {
  p.cancel('Operation cancelled.');
  process.exit(130);
});
process.on('SIGTERM', () => {
  process.exit(143);
});

import { introCommand } from './lib/cli/intro.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { spinner } from './lib/cli/progress.js';
import { requireTTYOrFlags } from './lib/cli/tty-guard.js';
import { c } from './lib/colors.js';
import { loadProjectConfig, updateProjectConfig } from './lib/config.js';
import { captureClusterCsiVolumes, isCsiVolumeName } from './lib/csi-volumes.js';
import {
  appStorageSecretKeys,
  localAppStorageSecrets,
  recordFenceFindings,
  revokeAppStorageCredential,
  syncHetznerFences,
} from './lib/deploy/app-storage-credential.js';
import { fenceInfoLines } from './lib/deploy/hetzner-app-key-fence.js';
import { haSshKeyName as haSshKeyNameFor } from './lib/deploy/k8s/ha-ssh-key.js';
import { planDestroy } from './lib/deploy/plan/destroy-plan.js';
import { runPlan } from './lib/deploy/plan/runner.js';
import {
  isComposeTier,
  isHATier,
  isK8sTier,
  pulumiStackEnvs,
  resolveTier,
} from './lib/deploy/tier-registry.js';
import { fallbackCsiVolumeIds, runCsiDetachStep } from './lib/destroy/csi-detach.js';
import { createLeakLedger, describeResource, formatLeakReport } from './lib/destroy/leak-ledger.js';
import { destroyPreviewBody, readS3SetupCompleted } from './lib/destroy/preview.js';
import { ORPHANS_DESTROY_COMMAND, retryDestroyCommand } from './lib/destroy/retry-command.js';
import { checkS3CredentialMismatch } from './lib/destroy/s3-credential-check.js';
import { sweepEnvironmentServers } from './lib/destroy/server-sweep.js';
import {
  DNS_PROVIDERS,
  dnsRecordsByHandHint,
  dnsRefusedHint,
  findZoneForDomain,
  getDnsProvider,
  hasAutomatedDns,
  resolveDnsToken,
} from './lib/dns-provider.js';
import { envIdentityOf } from './lib/env-identity.js';
import {
  findStatePassphraseError,
  isStatePassphraseFailure,
  passphraseMadeThisRunText,
} from './lib/iac/state-error.js';
import { localKubeconfigPath } from './lib/kubeconfig.js';
import { ensureOperatorIpAccess } from './lib/operator-ip.js';
import { perfAsync } from './lib/perf.js';
import { confirmProdOrExit, requiresProdTypeToConfirm } from './lib/prod-confirm.js';
import { describeCredentialSource } from './lib/project.js';
import { assertInProjectDir } from './lib/project-guard.js';
import {
  getObjectStorageProvider,
  providerFor,
  providerIdFor,
  resolveProviderToken,
} from './lib/providers/index.js';
import { deriveEnvAppBucketName } from './lib/providers/s3-base.js';
import { generateBucketSalt } from './lib/secrets.js';
import { sshKeyPathFor } from './lib/ssh.js';
import {
  findStatePassphraseProblem,
  STATE_PASSPHRASE_KEY,
  statePassphraseProvenance,
} from './lib/state-passphrase.js';
import { createTracker } from './lib/tracker.js';
import { VERSION } from './lib/version.js';
import { recordLeakedVolumes } from './lib/volume-ledger.js';
import { envBackupPrefix as envBackupPrefixFor } from './lib/walg/restore-base.js';

/**
 * Pure planner: derive every teardown target from persisted config, with no
 * network/filesystem access. Returns the canonical tier id plus the derived
 * Pulumi stack envs, cluster names, whether a k8s Pulumi stack exists, and the
 * owned server IPs that gate ownership-filtered DNS deletes.
 *
 * tier dispatch is the ONLY place allowed to look at deployMode/ha, so this
 * delegates to tier-registry (resolveTier / pulumiStackEnvs) rather than
 * re-deriving mode+ha combinations locally.
 *
 * @param {object} envConfig - persisted environment config.
 * @param {object} projectConfig - persisted project config (needs projectName).
 * @param {string} environment - environment name being destroyed.
 * @returns {{ tier: string, stackEnvs: string[], hasPulumiStack: boolean, clusterNames: string[], ownedIps: string[] }}
 */
export function planDestroyTargets(envConfig, projectConfig, environment) {
  // No recorded deployMode = deploy never reached provisioning (the
  // orchestrator's first skeleton save now precedes ALL env-scoped resource
  // creation, S3 included). There is no tier to tear down; plan the
  // local-cleanup-only sequence instead of crashing at resolveTier — a crash
  // here meant teardown never ran AT ALL (DO run 32670715722, "Unknown
  // deployMode: undefined"). A garbled non-empty mode still throws loudly.
  if (envConfig?.deployMode === undefined) {
    return {
      tier: 'unrecorded',
      stackEnvs: [],
      hasPulumiStack: false,
      clusterNames: [],
      ownedIps: [],
    };
  }
  const tier = resolveTier(envConfig);
  const stackEnvs = pulumiStackEnvs(tier, environment);
  const hasPulumiStack = isK8sTier(tier);
  const projectName = projectConfig.projectName;
  // For HA k8s each sub-cluster has its own network/naming prefix
  // (<project>-<env>-primary / -standby); single tiers get one.
  const clusterNames = stackEnvs.map((stackEnv) => `${projectName}-${stackEnv}`);
  // Owned IPs gate every DNS delete — only records pointing at this env's
  // servers are removed. See the ownership-filtered delete docs in the DNS backends.
  //
  // k8s DNS records point at the cluster's ingress IP (clusterIngressIp): its
  // floating/reserved IP on Hetzner and Linode, which is not any server's own
  // IP — without folding it in here, every k8s destroy preserved its own DNS
  // record as "unowned" (M3 Task 9f evidence: both Hetzner and DO k8s
  // destroys left the A record behind, hand-deleted afterwards). Single k8s
  // persists it at `envConfig.ingressIp` (orchestrator.js, before the record
  // points at it); k8s-ha persists one per cluster at
  // `envConfig.ha.primary/standby.ingressIp`. A record made before
  // `ingressIp` existed has only the `floatingIp` keys, still read here, as
  // is a DigitalOcean cluster's retired reserved IP that a deploy could not
  // release (its records may still point at it). Compose tiers have neither,
  // so all six are simply absent there. Each address once: on Hetzner and
  // Linode the ingress IP is the floating IP.
  const ownedIps = [
    ...new Set(
      [
        ...(envConfig.servers || []).map((srv) => srv.ip),
        envConfig.ingressIp,
        envConfig.ha?.primary?.ingressIp,
        envConfig.ha?.standby?.ingressIp,
        envConfig.floatingIp,
        envConfig.ha?.primary?.floatingIp,
        envConfig.ha?.standby?.floatingIp,
      ].filter(Boolean),
    ),
  ];
  return { tier, stackEnvs, hasPulumiStack, clusterNames, ownedIps };
}

// ============================================================================
// CLI ARGUMENT PARSING
// ============================================================================

// ============================================================================
// COMMAND SPEC — single source of truth for argv parsing AND help output.
// ============================================================================

// Static help text (SPEC is built once, at module load, before any argv is
// parsed — no envConfig exists yet to know the target env's provider). Falls
// back to the same sanctioned `?? 'hetzner'` default providerFor() uses
// everywhere else (R9): "Hetzner Cloud" is a deliberate deviation from the
// old literal "Hetzner" wording — pinned in
// tests/unit/cli/provider-neutral-strings.test.ts.
const destroySpecProviderName = providerFor(undefined).NAME;

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, description?: string, examples?: Array<{ command: string, description?: string }> }} */
const SPEC = {
  name: 'destroy',
  summary: 'Tear down a cloud environment',
  description: [
    'WARNING: this is irreversible. The following are deleted:',
    `  • ${destroySpecProviderName} servers and all data on them`,
    `  • ${destroySpecProviderName} volumes (orphaned PVCs from Kubernetes)`,
    `  • ${destroySpecProviderName} firewalls`,
    `  • ${destroySpecProviderName} SSH keys (deployment keys only)`,
    '  • Cloudflare DNS records and health checks',
    '  • GitHub environment secrets',
  ].join('\n'),
  positional: [
    {
      name: 'env',
      optional: true,
      description: 'Environment to destroy (skips the env prompt)',
    },
  ],
  flags: [
    { name: 'h', boolean: true, description: 'Show this help' },
    { name: 'v', boolean: true, description: 'Show version' },
    {
      name: 'y',
      boolean: true,
      description: 'Skip confirmation prompts (does not skip the prod type-to-confirm)',
    },
    { name: 'env', value: '<name>', description: 'Environment seed (alternative to positional)' },
    {
      name: 'orphans',
      boolean: true,
      description: 'Destroy stray Pulumi stacks not tracked in config',
    },
    {
      name: 'purge',
      boolean: true,
      description:
        "Also delete this environment's backups and uploads, and the backup and state buckets once nothing else uses them (default: all kept)",
    },
    {
      name: 'force',
      boolean: true,
      description:
        'Destroy even when the pre-destroy backup fails or is skipped (default: the destroy stops)',
    },
    {
      name: 'confirm',
      value: '<value>',
      description:
        'Production only: supply the type-to-confirm value (project and env joined by a dash, like my-saas-prod) on the command line (scripts / no TTY)',
    },
  ],
  examples: [
    { command: 'vibecarbon destroy', description: 'prompts for env' },
    { command: 'vibecarbon destroy prod', description: 'env seeded' },
    {
      command: 'vibecarbon destroy prod -y',
      description: 'destroy without confirmation (dangerous!)',
    },
    {
      command: 'vibecarbon destroy prod -y -purge',
      description: 'also delete its backups and uploads',
    },
    {
      command: 'vibecarbon destroy prod -y -confirm myapp-prod',
      description: 'scripted production destroy (the typed confirmation as a flag)',
    },
  ],
};

// ============================================================================
// ORPHAN PULUMI STACK DETECTION
// ============================================================================

/**
 * Find Pulumi stacks in the configured backend that aren't tracked in
 * .vibecarbon.json. Pulumi state is authoritative — if a stack exists
 * there but the env isn't in our project config (or its HA sibling), it's
 * an orphan left behind by an interrupted deploy.
 */
async function findOrphanPulumiStacks(projectConfig) {
  const { listStacks } = await import('./lib/iac/index.js');
  const stackNames = await listStacks({
    s3Config: projectConfig?.s3Config,
    // Scopes the listing to THIS project's state keys. In a shared/pinned
    // bucket, an unscoped listing reported OTHER projects' stacks as this
    // project's orphans (review finding, 2026-08-15).
    projectName: projectConfig?.projectName,
  });
  const trackedEnvs = new Set(
    Object.keys(projectConfig?.environments ?? {}).flatMap((env) => [
      env,
      `${env}-primary`,
      `${env}-standby`,
    ]),
  );
  return stackNames
    .filter((name) => !trackedEnvs.has(name))
    .map((name) => ({ name, path: `pulumi:${name}`, stateFile: `pulumi:${name}` }));
}

/**
 * Remove local SSH keys, known_hosts, kubeconfigs, and deploy-state for the
 * given environment. Idempotent — files that don't exist are skipped.
 *
 * Why: the deploy-state file marks `s3-setup` (and other steps) as completed,
 * keyed by an inputs hash. After `destroy` deletes the project's S3 bucket,
 * a subsequent `vibecarbon deploy` (e.g. e2e restore step's re-deploy)
 * computes the same hash, shouldSkip returns true, and Pulumi tries to use
 * the just-deleted bucket — failing with NoSuchBucket on `pulumi stack
 * select`. The deploy-state file is on the cleanup list at the bottom of
 * destroy.js, but the compose and compose-ha branches each `return;` early,
 * bypassing the cleanup. Factor it out and call from each early return —
 * observed in compose restore re-deploys hitting this exact NoSuchBucket
 * error.
 */
/**
 * The server a pre-destroy backup would run on, or null. Destroy is the escape
 * hatch for a misconfigured environment, so roles that name no single primary
 * skip the backup offer with a warning instead of blocking teardown.
 *
 * @param {object} envConfig
 * @param {string} envName
 * @param {(msg: string, err: AmbiguousPrimaryError) => void} [warn]
 * @returns {string|undefined}
 */
export function backupOfferIp(envConfig, envName, warn = (msg) => p.log.warn(msg)) {
  try {
    return resolvePrimary(envConfig, { env: envName })?.ip;
  } catch (err) {
    if (!(err instanceof AmbiguousPrimaryError)) throw err;
    warn(`Skipping the pre-destroy backup offer, the primary is unknown. ${err.message}`, err);
    return undefined;
  }
}

/**
 * Put this operator's IP on the environment's firewall before destroy's first
 * remote step, with the arguments `vibecarbon backup` uses
 * (ensureFirewallAccessIfNeeded in src/backup.js). Without it, an operator
 * whose IP changed since the deploy timed out on the pre-destroy backup and
 * the CSI volume release, and the only override (-force) skipped the backup.
 *
 * A failed check warns and continues: destroy is the escape hatch, and a
 * remote step that then cannot connect stops on its own cause (the backup
 * names -force).
 *
 * @param {{projectConfig: object, envName: string, envConfig: object, apiToken: string, yes: boolean}} o
 * @param {{ensure?: typeof ensureOperatorIpAccess, log?: typeof p.log}} [deps]
 */
export async function ensureDestroyOperatorAccess(
  { projectConfig, envName, envConfig, apiToken, yes },
  deps = {},
) {
  const { ensure = ensureOperatorIpAccess, log = p.log } = deps;
  try {
    const isHA = envConfig?.deployMode === 'compose-ha' || !!envConfig?.ha?.enabled;
    const result = await ensure({
      projectConfig,
      environment: envName,
      isHA,
      apiToken,
      yes,
      onMessage: (msg) => log.info(msg),
    });
    if (result.added) log.success(`Firewall updated: SSH/k8s API now allow ${result.cidr}`);
  } catch (err) {
    log.warn(
      `Operator-IP check failed: ${err instanceof Error ? err.message : String(err)}. ` +
        'Continuing; SSH steps (the pre-destroy backup) may not reach the servers.',
    );
  }
}

/**
 * What destroy hands preDestroyBackup. The key path comes from sshKeyPathFor,
 * the same helper every deploy mode writes through.
 */
export function preDestroyBackupOptions({ envConfig, envName, projectName, cwd, args }) {
  return {
    envConfig,
    envName,
    projectName,
    sshKeyPath: sshKeyPathFor(envName, cwd),
    yes: args.yes,
    purge: args.purgeBackups,
    force: args.force,
  };
}

/**
 * The backup destroy takes before it deletes anything, and what it does with
 * the answer.
 *
 * While backups are kept (no -purge), -y backs up by default and an
 * interactive run asks (default yes). The backup runs on the primary
 * resolvePrimary names (backupOfferIp): compose through backupCompose, k8s
 * through the backup Job. A backup that fails or reports `skipped`, an
 * unknown primary, or a missing deploy key stops the destroy with the reason
 * and the override, unless -force; with -force it warns and goes on. A pushed
 * base whose retention failed counts as backed up (the base is in the bucket).
 * A compose scale cutover journal (ha.writeFence.cutover) stops the destroy
 * before any backup and names the scale that finishes it; -force destroys
 * with no backup.
 *
 * @param {object} o
 * @param {object} o.envConfig
 * @param {string} o.envName
 * @param {string} o.projectName
 * @param {string} o.sshKeyPath
 * @param {boolean} o.yes
 * @param {boolean} o.purge
 * @param {boolean} o.force
 * @param {object} [deps] test seams
 */
export async function preDestroyBackup(
  { envConfig, envName, projectName, sshKeyPath, yes, purge, force },
  deps = {},
) {
  const {
    log = p.log,
    confirm = p.confirm,
    exit = process.exit,
    keyExists = existsSync,
    spinner: makeSpinner = spinner,
    backupCompose = async (...a) => {
      const { backupCompose: run } = await import('./lib/deploy/compose/index.js');
      return run(...a);
    },
    triggerBackupJob = async (...a) => {
      const { triggerBackupJob: run } = await import('./backup.js');
      return run(...a);
    },
  } = deps;

  if (purge) {
    log.info('-purge deletes the backups, so destroy takes no backup first.');
    return;
  }

  // A compose scale killed after its cutover journal was written: the new
  // server may already take writes on the next timeline while the config
  // still names the fenced old one. A base pushed from the old server would
  // become the newest in the lineage, and `restore latest` would lose every
  // write after the flip. No backup from either side is trustworthy until the
  // scale finishes or rolls back.
  const cutover = envConfig?.ha?.writeFence?.cutover;
  if (cutover) {
    const state = `a compose scale stopped mid-cutover (old server ${cutover.oldIp}, new server ${cutover.newIp})`;
    if (force) {
      log.warn(
        `${state}; -force set, so destroy takes NO backup: a base from the old server would ` +
          'sit in the lineage newer than the writes the new server may have taken',
      );
      return;
    }
    log.error(
      [
        `destroy stopped: ${state}. The database may already take writes on the new server, ` +
          'so a backup from the old one would land in the lineage without them.',
        'Finish the scale, or roll it back if DNS never moved, then destroy:',
        `  vibecarbon scale ${envName}`,
        'Or destroy without a backup:',
        `  ${retryDestroyCommand(envName, { purgeBackups: purge }, ['-force'])}`,
      ].join('\n'),
    );
    exit(1);
    return;
  }

  const stop = (what, why) => {
    if (force) {
      log.warn(`backup ${what} (${why}); -force set, destroying anyway`);
      return;
    }
    if (why === 'already-running') {
      // Another backup (the nightly Job) holds the lock: nothing is wrong, the
      // answer is to wait. One command per line, so each copies cleanly.
      log.error(
        [
          `backup ${what} (${why}); destroy stopped: a backup is running; wait for it and rerun`,
          `  ${retryDestroyCommand(envName, { purgeBackups: purge })}`,
          'Or destroy without a backup:',
          `  ${retryDestroyCommand(envName, { purgeBackups: purge }, ['-force'])}`,
        ].join('\n'),
      );
      exit(1);
      return;
    }
    log.error(
      `backup ${what} (${why}); destroy stopped; run \`${retryDestroyCommand(envName, { purgeBackups: purge }, ['-force'])}\` to destroy anyway`,
    );
    exit(1);
  };

  let unknownPrimary;
  const ip = backupOfferIp(envConfig, envName, (_msg, err) => {
    unknownPrimary = err;
  });
  if (unknownPrimary) return stop('skipped', `the primary is unknown: ${unknownPrimary.message}`);
  if (!ip) {
    log.info(`No server is recorded for ${envName}, so there is no database to back up.`);
    return;
  }

  if (!yes) {
    const wanted = await confirm({
      message: 'Create a backup before destroying? (recommended)',
      initialValue: true,
    });
    if (p.isCancel(wanted)) exitCancelled();
    if (!wanted) return;
  }

  if (!keyExists(sshKeyPath)) return stop('failed', `SSH key not found: ${sshKeyPath}`);

  const s = makeSpinner();
  s.start('Backing up the database before destroying...');
  let backup;
  try {
    if (isComposeTier(resolveTier(envConfig))) {
      backup = await backupCompose(ip, sshKeyPath, projectName, {
        retain: envConfig.backup?.retentionDays,
      });
    } else {
      backup = await triggerBackupJob(ip, sshKeyPath);
    }
  } catch (err) {
    s.stop('Backup failed');
    const message = err instanceof Error ? err.message : String(err);
    const [first, ...rest] = message.split('\n');
    if (rest.length > 0) log.message(rest.join('\n'));
    return stop('failed', first);
  }
  if (backup.result !== 'pushed') {
    s.stop('Backup skipped');
    return stop('skipped', backup.reason);
  }
  s.stop(`base backup pushed: ${backup.name}`);
  if (backup.retentionError) {
    log.warn(
      `The base backup is in the bucket, but pruning old backups failed: ${backup.retentionError}`,
    );
  }
}

/**
 * Release all Hetzner CSI volumes via the cluster's own finalizers
 * before Pulumi tears the cluster down, so the underlying volumes
 * don't leak into the post-destroy orphan sweep.
 *
 * Approaches tried:
 *   - `kubectl delete pvc --all --wait=true`. Failed — PVCs have a
 *     kubernetes.io/pvc-protection finalizer that blocks delete while
 *     a Pod is bound, so the wait burned the full 180s while
 *     the db pod still held its PVC. 4 orphans.
 *   - Delete Pods first (--wait=false), then PVCs. Failed for the
 *     same end result — the db is a StatefulSet, so its
 *     controller recreated the deleted Pod within seconds and
 *     re-bound the PVC. Same 4 orphans on the 2026-04-28 rerun.
 *   - Current: delete the entire vibecarbon namespace. The namespace
 *     controller handles dependency ordering automatically —
 *     workload controllers (StatefulSet,
 *     Deployment) get deleted FIRST so they stop recreating Pods,
 *     then Pods drain, then PVCs lose their pvc-protection
 *     finalizers, then PVs trigger the Hetzner CSI controller
 *     (still alive in kube-system; we only touch the vibecarbon
 *     namespace) to delete the underlying volumes via the PV's
 *     reclaim policy.
 *
 * Best-effort: any failure (cluster unreachable, kubectl missing,
 * already-gone resources) is logged and swallowed so the destroy
 * continues to Pulumi destroy + sweep.
 *
 * @param {string} kubeconfigPath
 */
export async function cleanupClusterPVCs(kubeconfigPath) {
  if (!existsSync(kubeconfigPath)) return;
  try {
    runCommand(
      [
        'kubectl',
        '--kubeconfig',
        kubeconfigPath,
        'delete',
        'namespace',
        'vibecarbon',
        '--wait=true',
        '--timeout=240s',
        '--ignore-not-found=true',
      ],
      { silent: true, ignoreError: true, returnOutput: false },
    );
  } catch {
    // best-effort: post-destroy sweep is the safety net
  }
}

function cleanupLocalEnvFiles(cwd, envName) {
  const cleanupPaths = [
    sshKeyPathFor(envName, cwd),
    `${sshKeyPathFor(envName, cwd)}.pub`,
    join(cwd, '.vibecarbon', `known_hosts_${envName}`),
    join(cwd, '.vibecarbon', `known_hosts_${envName}-primary`),
    join(cwd, '.vibecarbon', `known_hosts_${envName}-standby`),
    localKubeconfigPath(cwd, envName),
    localKubeconfigPath(cwd, `${envName}-primary`),
    localKubeconfigPath(cwd, `${envName}-standby`),
    // k8s-HA uses per-cluster StateTrackers, so the deploy-state file
    // splits across `<env>`, `<env>-primary`, `<env>-standby`. All three
    // must be cleaned to prevent the next deploy's shouldSkip from matching
    // a stale hash and reusing a deleted bucket.
    join(cwd, '.vibecarbon', `deploy-state-${envName}.json`),
    join(cwd, '.vibecarbon', `deploy-state-${envName}-primary.json`),
    join(cwd, '.vibecarbon', `deploy-state-${envName}-standby.json`),
  ];
  for (const path of cleanupPaths) {
    try {
      if (existsSync(path)) rmSync(path);
    } catch {
      // best-effort
    }
  }
}

async function destroyOrphanPulumiStack(orphan, { apiToken, s3Config, provider, projectName }) {
  // Destroy the orphan stack via the k8s destroy helper, which runs
  // `pulumi destroy` + `removeStack`. Compose orphans also use the same
  // underlying stack name → this works for both.
  //
  // apiToken + s3Config flow in from the caller (resolveProviderToken +
  // projectConfig). apiToken is resolved via HETZNER_API_TOKEN — populated
  // either by the operator's shell/CI or, for project-scoped tokens, by
  // bootstrapOperatorEnv folding the project's .env.local into process.env
  // at CLI startup — and every other code path in destroy.js resolves it
  // the same way. `provider` is always the sanctioned 'hetzner' default
  // here (see the call site: projectConfig has no `.provider` field).
  const { destroyK8s } = await import('./lib/deploy/k8s/index.js');
  await destroyK8s({
    environment: orphan.name,
    apiToken,
    s3Config,
    provider,
    projectName,
    // Phase B: Provider.DEFAULT_REGION
  });
}

// ============================================================================
// DESTROY-SWEEP CLEANUP (provider-routed policy fns)
// ============================================================================
//
// C10a — the raw-API `hetzner*` teardown PRIMITIVES that used to live here (a
// permanent second Hetzner API client that had drifted from the provider class
// on page size, delete semantics, and error shapes) now live as instance
// methods on each provider class (src/lib/providers/{hetzner,digitalocean}.js).
// The three POLICY functions below stay here and take a provider INSTANCE,
// calling those methods plus the Task 7 field accessors
// (serverNetworkIds/serverLabels/serverVolumeIds/volumeAttachedServerIds/
// volumeRegion/volumeLabels) for every cloud-shaped field read, so the same
// matching logic runs unchanged against Hetzner servers/volumes or
// DigitalOcean droplets/volumes. Load-balancer matching is the one exception
// still reading Hetzner-shaped fields directly (`lb.private_net`, `lb.labels`)
// — DO never creates Load Balancers in this architecture (no LoadBalancer-type
// Service; M3 dossier), so that arm is simply always false for DO and no
// accessor exists for it.

/**
 * Find and delete load balancers created by Hetzner CCM (Kubernetes cloud controller manager).
 * These are provisioned automatically when a LoadBalancer Service is created in k8s,
 * not by the Pulumi program, so they aren't tracked in stack state and need
 * direct API cleanup.
 *
 * @returns {Promise<{ deleted: string[], failed: Array<{ name: string, id: string|number, reason: string }> }>}
 *   `failed` are matched load balancers whose delete refused or threw. They used
 *   to be swallowed by a bare `catch {}`, which is how a matched-but-undeleted
 *   LB (the one thing that keeps a VPC delete refusing) could survive a destroy
 *   that reported success.
 */
async function cleanupLoadBalancers(provider, projectName, envName) {
  const clusterName = `${projectName}-${envName}`;

  // Look up the cluster's private network ID so we can match LBs by network attachment.
  // This is more reliable than label/name matching because Hetzner CCM uses a random UID
  // as the LB name by default (not the cluster name).
  let clusterNetworkId = null;
  try {
    const networks = await provider.listNetworks();
    const clusterNetwork = networks.find((n) => n.name === `${clusterName}-network`);
    clusterNetworkId = clusterNetwork?.id ?? null;
  } catch {
    // Non-fatal; fall back to label/name matching only
  }

  const loadBalancers = await provider.listLoadBalancers();
  const deleted = [];
  const failed = [];

  for (const lb of loadBalancers) {
    const lbName = lb.name || '';
    const lbLabels = lb.labels || {};

    // CCM-created LBs have a label like: kubernetes.io/cluster/<cluster-name> = "owned"
    // or the name contains the cluster identifier. Always match on the full cluster name
    // (projectName + envName) to avoid deleting LBs belonging to other environments.
    const clusterKey = Object.keys(lbLabels).find((k) => k.startsWith('kubernetes.io/cluster/'));
    const matchesCluster = clusterKey?.includes(clusterName);
    const matchesName = lbName.includes(clusterName);
    // Also match by private network attachment — the CCM attaches LBs to the cluster network.
    const matchesNetwork =
      clusterNetworkId !== null && lb.private_net?.some((n) => n.network_id === clusterNetworkId);
    // Traefik service annotation uses {{PROJECT_NAME}}-lb (no envName suffix).
    // Match both the short form and the long form to cover all conventions.
    const matchesStandardName =
      lbName === `${projectName}-lb` || lbName === `${projectName}-${envName}-lb`;

    if (matchesCluster || matchesName || matchesStandardName || matchesNetwork) {
      try {
        const ok = await provider.deleteLoadBalancer(lb.id);
        if (ok) deleted.push(lbName);
        else failed.push({ name: lbName, id: lb.id, reason: 'delete refused by the API' });
      } catch (error) {
        // Continue with other LBs if one fails — but never silently.
        failed.push({ name: lbName, id: lb.id, reason: `delete failed: ${error.message}` });
      }
    }
  }

  return { deleted, failed };
}

/**
 * Sweep cluster-autoscaler-spawned servers BEFORE `pulumi destroy`.
 *
 * CA-spawned servers exist outside Pulumi state. If they remain attached to
 * the cluster network when `pulumi destroy` runs, the network/firewall
 * destroy fails with "still in use". This function removes them via the
 * provider's API directly (no SSH, no Pulumi state).
 *
 * Match strategy (in priority order):
 * 1. Server label `cluster-autoscaler/node: worker-pool` — attached at
 *    server-create time by carbon-autoscaler (the in-repo externalgrpc
 *    backend), which reads it from the rendered carbon-autoscaler-config
 *    Secret's `nodeGroups.worker-pool.serverLabels` (Phase 4; M2 swapped the
 *    backend, the label contract is unchanged).
 * 2. Fallback: server in the cluster network whose labels lack BOTH
 *    `cluster-autoscaler/node` AND `role` (the old role-based heuristic).
 *    Handles the upgrade case where pre-Phase-4 CA workers were spawned
 *    without the explicit label.
 *
 * Static (Pulumi-managed) workers carry `cluster-autoscaler/node: static`
 * (Phase 3) so they're explicitly excluded by both matchers.
 *
 * Per feedback_orphan_auto_destroy_hazard.md: this is in-scope cleanup of
 * an EXPLICIT destroy target (the user invoked `vibecarbon destroy <env>`),
 * NOT orphan destruction across foreign Pulumi stacks. No
 * `-orphans` requirement.
 *
 * Cloud-shaped field reads (network membership, labels, attached volumes) go
 * through the provider's Task 7 accessors (serverNetworkIds/serverLabels/
 * serverVolumeIds) — same matching logic, Hetzner server or DO droplet.
 *
 * @param {import('./lib/providers/base.js').BaseProvider} provider - Provider
 *                               instance (write scope required).
 * @param {string} clusterName - The cluster's Pulumi-naming prefix
 *                               (`<projectName>-<environment>`). Used to
 *                               find the cluster's private network by name
 *                               `<clusterName>-network`.
 * @returns {Promise<{deleted: string[], failed: Array<{name: string, id: string|number, reason: string}>, volumeIds: (string|number)[]}>}
 *   `failed` are matched CA workers whose delete threw. They used to be
 *   swallowed: a surviving CA worker is both a billing leak AND the reason
 *   `pulumi destroy` then fails the network delete with "still in use", so the
 *   silence cost two diagnoses at once.
 */
async function cleanupAutoscalerWorkers(provider, clusterName, { onLeftover } = {}) {
  // Find the cluster's private network by name (matches Pulumi resource name).
  const networks = await provider.listNetworks();
  const clusterNetwork = networks.find((n) => n.name === `${clusterName}-network`);
  if (!clusterNetwork) {
    return { deleted: [], failed: [], volumeIds: [] };
  }

  const servers = await provider.listServers();

  // Match strategy: label-primary, in-network-without-role-label fallback.
  // Pulumi-managed roles for compatibility with pre-Phase-3 deploys.
  const PULUMI_ROLES = new Set(['master', 'db', 'worker']);
  const caServers = servers.filter((server) => {
    const inClusterNetwork = provider.serverNetworkIds(server).includes(clusterNetwork.id);
    if (!inClusterNetwork) return false;

    const labels = provider.serverLabels(server);
    // PRIMARY: explicit CA-spawned label (Phase 4).
    if (labels['cluster-autoscaler/node'] === 'worker-pool') return true;
    // EXCLUDE: explicit static-worker label (Phase 3).
    if (labels['cluster-autoscaler/node'] === 'static') return false;
    // FALLBACK (upgrade path / missing labels): in-network without a
    // recognized role label is treated as CA-spawned.
    const role = labels.role;
    return !role || !PULUMI_ROLES.has(role);
  });

  if (caServers.length === 0) {
    return { deleted: [], failed: [], volumeIds: [] };
  }

  // Collect attached volume IDs before deletion so the downstream volume
  // sweep can reap dangling CSI PVCs even after the server records are gone.
  const volumeIds = caServers.flatMap((server) => provider.serverVolumeIds(server));

  const deleted = [];
  const failed = [];
  for (const server of caServers) {
    try {
      const ok = await provider.deleteServer(server.id, { waitUntilGone: true, onLeftover });
      if (ok) deleted.push(server.name);
    } catch (error) {
      // Continue with remaining servers — best-effort cleanup. The
      // post-Pulumi orphan sweep is the safety net for stragglers, and the
      // verdict below is what stops a straggler from being invisible.
      failed.push({ name: server.name, id: server.id, reason: `delete failed: ${error.message}` });
    }
  }

  return { deleted, failed, volumeIds };
}

/**
 * Whether a server's decoded labels name this project and one of this
 * environment's clusters. The raw names go through provider.labelValue,
 * because a provider that squeezes long tags (Linode, past 50 characters)
 * stores the squeezed value, not the raw name.
 * @param {{ labelValue: (key: string, value: string) => string }} provider
 * @param {Record<string, string>} labels - provider.serverLabels(server).
 * @param {string} projectName
 * @param {string[]} clusterNames - This environment's cluster names (`<project>-<env>`).
 * @returns {boolean}
 */
export function labelsNameEnvironment(provider, labels, projectName, clusterNames) {
  return (
    labels.project === provider.labelValue('project', projectName) &&
    clusterNames.some(
      (cn) =>
        labels.environment ===
        provider.labelValue('environment', cn.replace(`${projectName}-`, '')),
    )
  );
}

/**
 * Regions that host servers this environment does not own (the layer-2
 * heuristic defers `pvc-*` matches there). A foreign server whose region
 * cannot be read could sit in any of our regions, so it is reported as
 * `unreadable` and the caller blocks every region: unknown occupancy is never
 * "nobody is there". (Hetzner dropped `server.datacenter` on 2026-07-01; a
 * provider field going missing must fail closed, not silently empty this.)
 * @param {{ serverLabels: (s: object) => Record<string, string>, serverRegion: (s: object) => string|null, labelValue: (key: string, value: string) => string }} provider
 * @param {object[]} servers - Every server still in the project.
 * @param {string} projectName
 * @param {string[]} clusterNames - This environment's cluster names (`<project>-<env>`).
 * @returns {{ regions: Set<string>, unreadable: string|null }}
 */
export function foreignServerRegions(provider, servers, projectName, clusterNames) {
  const regions = new Set();
  let unreadable = null;
  for (const sv of servers) {
    if (labelsNameEnvironment(provider, provider.serverLabels(sv), projectName, clusterNames)) {
      continue;
    }
    const region = provider.serverRegion(sv);
    if (region) regions.add(region);
    else unreadable ??= String(sv.name ?? sv.id);
  }
  return { regions, unreadable };
}

/**
 * Every region this environment is configured to occupy, straight from the
 * persisted env config — no API call, so it survives exactly the failures that
 * blank out the live sources (dead cluster, soft-failing listing).
 *
 * k8s-ha spreads across two: `ha.primary.region` / `ha.standby.region`, which
 * can each differ from the top-level `region` the env was created with (the
 * per-side value is what that side ACTUALLY deployed to). Missing keys are
 * simply absent on compose tiers.
 *
 * Exported for unit testing.
 *
 * @param {object} envConfig
 * @returns {string[]}
 */
export function configuredClusterRegions(envConfig) {
  return [
    ...new Set(
      [
        envConfig?.region,
        envConfig?.ha?.primary?.region,
        envConfig?.ha?.standby?.region,
        ...(envConfig?.servers ?? []).map((sv) => sv?.region ?? sv?.location),
      ].filter((r) => typeof r === 'string' && r),
    ),
  ];
}

/** Default budget for the detach re-sweep (see cleanupOrphanedVolumes). */
const VOLUME_DETACH_WAIT_MS = 90_000;
const VOLUME_DETACH_POLL_MS = 5_000;

/**
 * Volume ids reach this file as NUMBERS (Hetzner's `volume.id` and
 * `server.volumes[]` over the wire), as STRINGS (a PV's
 * `spec.csi.volumeHandle`, which hcloud CSI renders with
 * `strconv.FormatInt`), and as UUID strings (DigitalOcean). Every identity
 * comparison goes through this, because `new Set(['100604631']).has(100604631)`
 * is false — which would make layer-1 capture match nothing at all, silently,
 * on the provider it matters most for.
 */
const idKey = (id) => String(id);

/**
 * Find and delete orphaned volumes created by the Kubernetes CSI driver.
 * These volumes are created via PersistentVolumeClaims, live outside every
 * Pulumi stack, and persist after server deletion.
 *
 * TWO TIERS OF MATCH, AND WHY THE DIFFERENCE IS THE WHOLE DESIGN
 * --------------------------------------------------------------
 * IDENTITY matches prove the volume belongs to THIS environment:
 *   - `knownVolumeIds` — captured from the cluster's own PersistentVolumes
 *     before teardown (lib/csi-volumes.js) and from the ids attached to this
 *     cluster's servers during the pre-scan;
 *   - the cluster name / a cluster server's name inside the volume name;
 *   - a `kubernetes.io/cluster=<clusterName>` label.
 * These are deleted whenever detached, and are the only ones the detach
 * re-sweep waits on.
 *
 * HEURISTIC matches only prove the volume looks like SOME vibecarbon cluster's:
 *   - a `pvc-<uuid>` name in one of this cluster's regions,
 *   - a `project=<projectName>` volume label (live since the hcloud CSI driver
 *     was bumped to v2.18.1 — but still only PROJECT-scoped: every environment
 *     of the project stamps the same value, see lib/csi-volumes.js),
 *   - a CSI pvc-namespace label of `vibecarbon`.
 * A parallel rig, a second environment, or a customer's own cluster in the
 * same region can produce every one of these. RCA 2026-07-18 is the receipt:
 * a concurrent CI matrix's sweep deleted another LIVE rig's volumes while they
 * were legitimately detached mid-reseed, because "unattached pvc-*" was the
 * only signal available. So heuristic matches are gated:
 *   - `identityComplete` (layer 1 captured every cluster's PV list) => the
 *     answer is already known and complete; anything the capture did NOT list
 *     is by definition not ours. Defer + report, never delete.
 *   - a `foreignRegions` entry => some server we do not own is still running
 *     in that region, so a live cluster may own this volume. Defer + report.
 * Deferrals are loud and land in the destroy summary with the exact volume
 * names; the standing sweep (which waits for a quiet moment with zero servers)
 * is what eventually collects them.
 *
 * ATTACHMENT ORDERING (2026-07-30 — six detached, unlabeled `pvc-*` volumes
 * survived a fully green Hetzner k8s run's final destroy). A volume that still
 * reports an attachment when a single, un-retried pass scans is skipped
 * forever: both clouds clear the attachment ASYNCHRONOUSLY after the server
 * delete completes, so the volumes are "in use" for the one instant we look
 * and detached seconds later with nothing left to reap them. Hence the bounded
 * re-sweep, restricted to identity matches.
 *
 * Cloud-shaped field reads (attachment, labels, region, creation time) go
 * through the provider's Task 7 accessors, so the same matching logic runs
 * unchanged against Hetzner or DigitalOcean volumes.
 *
 * @param {string[]} knownVolumeIds - Volume ids proven to belong to this
 *   cluster. Compared as strings (see idKey).
 * @param {string[]} clusterLocations - Regions this cluster occupies; bounds
 *   the `pvc-*` heuristic.
 * @param {object} [options]
 * @param {boolean} [options.identityComplete] - True when layer 1 captured the
 *   PersistentVolume list of EVERY cluster in this environment. Switches
 *   heuristic matches from delete to defer.
 * @param {string[]} [options.foreignRegions] - Regions where a server we don't
 *   own is still running. Heuristic matches there are deferred.
 * @param {(line: string) => void} [options.report] - Per-volume loud line sink.
 * @returns {Promise<{ deleted: string[], unresolved: object[], deferred: object[], listingComplete: boolean }>}
 *   `unresolved` are identity volumes we could neither confirm gone nor delete
 *   inside the budget; `deferred` are gated heuristic matches. Both are
 *   surfaced by the caller as destroy issues — and `unresolved` is what gets
 *   written to the leaked-volume ledger for the sweep to finish.
 */
async function cleanupOrphanedVolumes(
  provider,
  projectName,
  envName,
  serverNames,
  knownVolumeIds = [],
  clusterLocations = [],
  {
    detachWaitMs = VOLUME_DETACH_WAIT_MS,
    pollIntervalMs = VOLUME_DETACH_POLL_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    identityComplete = false,
    foreignRegions = [],
    report = (line) => console.log(line),
  } = {},
) {
  const deletedVolumes = [];
  const deferred = [];
  const knownIdSet = new Set((knownVolumeIds ?? []).map(idKey));
  const foreignRegionSet = new Set(foreignRegions ?? []);
  // Always use the full cluster name (projectName + envName) to avoid matching
  // volumes belonging to other environments of the same project.
  const clusterName = `${projectName}-${envName}`;

  const recordFor = (volume) => ({
    id: volume.id,
    name: provider.volumeName(volume) ?? null,
    region: provider.volumeRegion(volume),
    createdAt: provider.volumeCreatedAt(volume),
  });
  const describe = (volume) => {
    const { id, name, region, createdAt } = recordFor(volume);
    return `${name || '(unnamed)'} [id ${id}, ${region ?? 'unknown region'}${
      createdAt ? `, created ${createdAt}` : ''
    }]`;
  };

  /** ENV-SCOPED ownership. Attachment-blind (see the caller loop). */
  const identityMatch = (volume) => {
    if (knownIdSet.has(idKey(volume.id))) return 'captured-id';
    const volumeName = provider.volumeName(volume) || '';
    if (volumeName.includes(clusterName)) return 'cluster-name';
    if (provider.volumeLabels(volume)['kubernetes.io/cluster'] === clusterName)
      return 'cluster-label';
    if ((serverNames ?? []).some((s) => s && volumeName.includes(s))) return 'server-name';
    return null;
  };

  /** PROJECT/REGION-SCOPED pattern match — never env-scoped. See the doc above. */
  const heuristicMatch = (volume) => {
    const volumeLabels = provider.volumeLabels(volume);
    // A volume that names a different project is never ours, whatever its
    // region or name looks like. No project label keeps the old behaviour.
    // The decoded label is compared to labelValue, which is what a provider
    // that squeezes long tags (Linode) stores for this project.
    const ownProject = projectName ? provider.labelValue('project', projectName) : projectName;
    if (projectName && volumeLabels.project && volumeLabels.project !== ownProject) return null;
    // Namespace label, from a CSI driver run with --extra-create-metadata.
    // Both the AWS/GCE-style key and hcloud >= v2.15's own `pvc-namespace`.
    if (
      volumeLabels['kubernetes.io/created-for/pvc/namespace'] === 'vibecarbon' ||
      volumeLabels['pvc-namespace'] === 'vibecarbon'
    )
      return 'csi-namespace-label';
    // Everything below keys off the CSI name convention. Anchored on the full
    // `pvc-<uuid>` form (not a bare `pvc-` prefix) so an operator's hand-named
    // `pvc-backups` volume can never be swept up by a heuristic.
    if (!isCsiVolumeName(provider.volumeName(volume))) return null;
    if (projectName && volumeLabels.project === ownProject) return 'project-label';
    const region = provider.volumeRegion(volume);
    if (region && (clusterLocations ?? []).includes(region)) return 'pvc-in-cluster-region';
    return null;
  };

  /**
   * @returns {{ code: 'identity-complete'|'foreign-region', why: string }|null}
   *   null when the heuristic delete is allowed.
   *
   * The `code` is the discriminator the destroy report needs, and the two
   * cases are NOT the same verdict:
   *   identity-complete — we captured this environment's whole PersistentVolume
   *     list and this volume is not in it, so it is PROVEN not ours. Somebody
   *     else's bill: reported, but it must not fail our exit code.
   *   foreign-region — a server we don't own is live in that region and our own
   *     identity capture was incomplete, so ownership is genuinely UNKNOWN. It
   *     may well be ours: that fails the exit code.
   */
  const heuristicBlockedBecause = (volume) => {
    if (identityComplete) {
      return {
        code: 'identity-complete',
        why: "this environment's own PersistentVolume list was captured in full and does not contain it",
      };
    }
    const region = provider.volumeRegion(volume);
    if (region && foreignRegionSet.has(region)) {
      return {
        code: 'foreign-region',
        why: `a server we do not own is still running in ${region}; it may belong to a live cluster, and our own identity capture was incomplete`,
      };
    }
    return null;
  };

  /** @returns {Promise<boolean>} true when the volume is confirmed gone. */
  const tryDelete = async (volume, reason) => {
    try {
      const deleted = await provider.deleteVolume(volume.id);
      report(
        deleted
          ? `  [volume] DELETED ${describe(volume)}: matched by ${reason}`
          : `  [volume] DELETE REFUSED ${describe(volume)}: matched by ${reason}`,
      );
      if (deleted) deletedVolumes.push(provider.volumeName(volume));
      return deleted;
    } catch (error) {
      report(`  [volume] DELETE FAILED ${describe(volume)}: ${reason}: ${error.message}`);
      return false;
    }
  };

  // Pass 1 — delete every detached volume we can attribute; queue attached
  // identity matches for the detach re-sweep; defer + report gated heuristics.
  // The listing carries its own completeness flag: a soft-failed listing that
  // returns `[]` must NEVER be read as "the account holds nothing".
  const listing = await provider.listVolumesDetailed();
  const listingComplete = listing.complete !== false;
  const pending = new Map();
  const seenInFirstPass = new Set();

  for (const volume of listing.items) {
    seenInFirstPass.add(idKey(volume.id));
    const identity = identityMatch(volume);
    if (provider.volumeAttachedServerIds(volume).length > 0) {
      // Only volumes we can PROVE are ours are waited on — waiting for a
      // heuristic match to detach is how you reap a live cluster's disk.
      if (identity) {
        pending.set(idKey(volume.id), recordFor(volume));
        report(`  [volume] still attached, re-checking ${describe(volume)}: ${identity}`);
      }
      continue;
    }
    if (identity) {
      await tryDelete(volume, identity);
      continue;
    }
    const heuristic = heuristicMatch(volume);
    if (!heuristic) continue;
    const blocked = heuristicBlockedBecause(volume);
    if (blocked) {
      deferred.push({
        ...recordFor(volume),
        match: heuristic,
        blocked: blocked.why,
        blockedBy: blocked.code,
      });
      report(
        `  [volume] DEFERRED ${describe(volume)}, ${heuristic} match, kept because ${blocked.why}`,
      );
      continue;
    }
    await tryDelete(volume, `${heuristic} (backstop)`);
  }

  // A known volume absent from an INCOMPLETE listing proves nothing — we may
  // simply never have received its page. Carry it into the re-sweep so it is
  // retried and, failing that, reported. (Absent from a COMPLETE listing is
  // real evidence: the CSI finalizer already reaped it, which is the normal
  // green-teardown path and must stay silent.)
  if (!listingComplete) {
    for (const id of knownIdSet) {
      if (!seenInFirstPass.has(id) && !pending.has(id)) {
        pending.set(id, { id, name: null, region: null, createdAt: null });
      }
    }
  }

  // Pass 2+ — poll until every identity volume is resolved (detached AND
  // deleted) or the budget runs out. Only known ids are considered here, so
  // this can never widen what gets deleted, only when.
  const deadline = Date.now() + detachWaitMs;
  while (pending.size > 0 && Date.now() < deadline) {
    await sleep(pollIntervalMs);
    const refreshed = await provider.listVolumesDetailed();
    // An INCOMPLETE listing is not evidence of anything. A cloud 5xx window
    // inside the poll would otherwise look identical to "every pending volume
    // was reaped elsewhere" — the pruning below would clear the map and
    // destroy would report a clean teardown over leaked volumes, which is the
    // exact silence this re-sweep exists to break. Treat it as no information
    // and let the deadline decide: a stubborn API costs the remaining budget
    // and one loud false positive, which is the correct direction for a
    // teardown report to fail in.
    if (refreshed.complete === false) continue;
    const seenIds = new Set(refreshed.items.map((v) => idKey(v.id)));
    for (const volume of refreshed.items) {
      const key = idKey(volume.id);
      if (!pending.has(key)) continue;
      if (provider.volumeAttachedServerIds(volume).length > 0) continue;
      // Only drop it once the delete is CONFIRMED. A failed delete (API error,
      // or a TOCTOU re-attach between the listing and the call) keeps the
      // volume pending, so it is retried on the next poll and, failing that,
      // reported — never silently absent from every result list.
      if (await tryDelete(volume, 'captured-id (re-sweep)')) pending.delete(key);
    }
    // A pending volume that vanished from a listing we could actually read was
    // reaped elsewhere (CSI finalizer, provider GC) — stop waiting on it.
    for (const key of [...pending.keys()]) {
      if (!seenIds.has(key)) pending.delete(key);
    }
  }

  for (const record of pending.values()) {
    report(
      `  [volume] UNRESOLVED ${record.name || `(id ${record.id})`}, still billing; recorded for the sweep`,
    );
  }

  return {
    deleted: deletedVolumes,
    unresolved: [...pending.values()],
    deferred,
    listingComplete,
  };
}

// ============================================================================
// GITHUB CLEANUP
// ============================================================================

function deleteGitHubEnvironment(envName) {
  try {
    const repoInfo = runCommand(
      ['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
      { cleanEnv: true, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();

    runCommand(['gh', 'api', `repos/${repoInfo}/environments/${envName}`, '-X', 'DELETE'], {
      cleanEnv: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// BACKUP BUCKET CLEANUP
// ============================================================================

/** True when an S3 error says the bucket does not exist. */
function isNoSuchBucket(err) {
  return (
    err?.name === 'NoSuchBucket' ||
    err?.Code === 'NoSuchBucket' ||
    err?.$metadata?.httpStatusCode === 404
  );
}

/**
 * Run `op` on a bucket at its recorded region, and when that region says the
 * bucket does not exist, look for it in every region these keys can address
 * before concluding anything (locateBucket; keys made for one cluster, as on
 * Vultr and Linode, address only that one). A record can name the wrong
 * region: an environment that hit the old bug and was not deployed since, or
 * a deploy that died before its final save. A store asked in the wrong region
 * answers "no such bucket" for a bucket full of data, so that answer alone
 * never means gone where the keys reach other regions.
 *
 * Returns where `op` ran, or `{ gone: true, searched }` only when every
 * region asked said not found (`searched`, how many were asked, words the
 * line). A region that answers anything else throws (locateBucket names the
 * bucket and the region), and so does a store that says NoSuchBucket where the
 * search then finds the bucket: the caller keeps it and records why.
 * `ran.region` is where `op` is running, set before each run starts, so a
 * caller whose op fails or times out at a found region reports that region.
 * @template T
 * @param {{ forRegion: (region: string) => any, locateBucket: (bucket: string) => Promise<string|null>, addressableRegions: () => string[] }} store
 *   the client at `region`
 * @param {string} bucket
 * @param {string} region - where the record says the bucket is
 * @param {(store: any) => Promise<T>} op
 * @param {{ region?: string }} [ran] - written: where `op` runs
 * @returns {Promise<{ result: T, region: string, gone?: false } | { gone: true, searched: number }>}
 */
async function atBucketRegion(store, bucket, region, op, ran = {}) {
  ran.region = region;
  try {
    return { result: await op(store), region };
  } catch (err) {
    if (!isNoSuchBucket(err)) throw err;
    const found = await store.locateBucket(bucket);
    if (found === null) return { gone: true, searched: store.addressableRegions().length };
    if (found === region) {
      throw new Error(
        `${bucket} answered NoSuchBucket in ${region}, but a HeadBucket there finds it: the store is answering two ways, so it was left in place; look at it in the Object Storage console before deleting anything by hand`,
      );
    }
    ran.region = found;
    return { result: await op(store.forRegion(found)), region: found };
  }
}

/** ` in fsn1, not nbg1 as its record said` when the bucket was found elsewhere. */
const foundElsewhere = (ran, recorded) =>
  ran && ran !== recorded ? ` in ${ran}, not ${recorded} as its record said` : '';

/**
 * The line for a bucket that no region these keys reach has. "In any region"
 * only when more than one was asked: keys for one cluster asked just that
 * one, and the line reads as it always did there.
 * @param {string} what - "Backup bucket" or "S3 bucket"
 * @param {number} searched - how many regions were asked
 */
const notFoundLine = (what, searched) =>
  `${what} not found${searched > 1 ? ' in any region' : ''} (already deleted or never created)`;

/**
 * Handle the backup S3 bucket at the end of destroy. Default behavior is to
 * preserve the bucket for recovery (production users); --purge-backups deletes
 * this environment's backups (used by e2e tests, which require a clean tear-down);
 * the bucket itself goes only when no other environment keeps backups in it.
 */
async function handleBackupBucket(
  envConfig,
  projectConfig,
  environment,
  args,
  spinner,
  leaks,
  entryKept = null,
) {
  // The bucket, its region and its endpoint, as every reader takes them.
  const target = backupsTargetOf(envConfig);
  if (!target) return { purged: false };
  const bucketName = target.bucket;

  // Not a leak: preservation is the DEFAULT and the whole point of the flag.
  // Nothing was asked of us, so nothing survived that shouldn't have.
  if (!args.purgeBackups) {
    p.log.info(`Backup bucket ${c.bold(bucketName)} preserved for recovery`);
    return { purged: false };
  }

  // Every environment archives under its own backups/<project>/<env>/ prefix
  // in its storage region's backups bucket (one per project and region), so
  // -purge removes this environment's backups, and the bucket itself only
  // when no other environment keeps backups in it: live, destroyed with its
  // backups kept, or deployed by an older CLI with no record
  // (backupsBucketHolders).
  const envBackupPrefix = envBackupPrefixFor(projectConfig.projectName, environment);
  const holders = backupsBucketHolders(projectConfig, { bucket: bucketName, except: environment });
  const deleteBucket = holders.length === 0;
  // A destroy that keeps the environment's entry (entryKeptReason) leaves
  // the environment live for the rerun, and a live environment keeps its
  // backups: it still holds the bucket (backupsHoldings), and another
  // environment's fenced deploy looks for every live record's buckets and
  // stops when one is gone. So -purge keeps them this time, as
  // retainStateBucket keeps the state bucket. The keep rule is final by now:
  // the steps after this one add only lines that keep nothing. The next
  // clean -purge deletes them and records backupsPurged.
  if (entryKept) {
    spinner.start('Backup bucket');
    spinner.stop(
      `Backups kept: ${envBackupPrefix} in ${bucketName}. This destroy keeps ${environment}'s ` +
        `entry because ${entryKept.because}, and a kept environment keeps its backups; a clean ` +
        `\`${retryDestroyCommand(environment, args)}\` deletes them then.`,
    );
    return { purged: false };
  }
  // Resolved once per flow — see providerFor() in lib/providers/index.js.
  const Provider = providerFor(envConfig);
  // A record with no region, beside uploads with none either, names no store
  // to ask. The bucket is never guessed into a region: a store asked in the
  // wrong one answers "no such bucket", and the purge would say it is gone.
  if (!target.region) {
    leaks.leak({
      resourceClass: 'bucket',
      resource: describeResource({ name: bucketName }),
      reason:
        'purge requested (-purge) but the backups bucket has no region on record, so destroy cannot tell which store holds it',
      hint: `Delete ${envBackupPrefix} in ${bucketName} via the ${Provider.NAME} Object Storage console, and the bucket once no other environment keeps backups there; it keeps billing until removed.`,
    });
    return { purged: false };
  }
  const region = target.region;
  // Where the purge is running: the recorded region, or where the bucket was
  // found. A failure is reported there, the region whose console holds it.
  const ran = { region };
  spinner.start(`Purging backup bucket: ${bucketName}`);
  try {
    const s3Creds = await Provider.promptObjectStorageCredentials(projectConfig.projectName, {
      save: false,
      // Off-TTY, missing credentials must resolve to null instead of reaching
      // clack's prompt (which has no isTTY/stdin-close handling and hangs) —
      // same guard, same reason, as resolveDestroyS3Config's.
      skipPrompts: !process.stdin.isTTY,
    });
    if (!s3Creds) {
      spinner.stop('Backup bucket purge skipped (no credentials available)');
      // `-purge` was requested and we did not purge: the bucket survives.
      leaks.leak({
        resourceClass: 'bucket',
        resource: describeResource({ name: bucketName, region }),
        reason: 'purge requested (-purge) but no object-storage credentials were available',
        hint: backupsLeakHint(Provider.NAME, { bucketName, envBackupPrefix, holders }),
      });
      return { purged: false };
    }
    const s3Provider = await getObjectStorageProvider(
      providerIdFor(envConfig),
      s3Creds.accessKey,
      s3Creds.secretKey,
      region,
    );
    // Bound the purge so a slow/contended S3 endpoint can't consume the whole
    // destroy budget. The Hetzner resources are already freed (Pulumi destroy
    // ran before this), but a single S3 op can hang up to ~9 min under the
    // SDK (maxAttempts 3 × 60s socketTimeout) × _send (maxAttempts 3) retry
    // layers — observed on k8s teardown, where the storage bucket doubles as
    // the Pulumi state backend (slow/contended), blowing the 600s
    // final-destroy timeout and getting the whole step SIGKILLed. On timeout
    // the bucket is left in place, as a leak whose hint gives the console
    // steps: never a destroy rerun, which finds nothing once the environment
    // has moved to destroyedEnvironments.
    const PURGE_TIMEOUT_MS = 180_000;
    const purgeAt = async (store) => {
      const { objectsRemoved } = await store.deletePrefix(bucketName, envBackupPrefix);
      if (!deleteBucket) return { kept: true, objectsRemoved };
      return store.emptyAndDeleteBucket(bucketName);
    };
    // Where the record says, else wherever the bucket really is: a wrong
    // region on record must never read as "purged" while the folder stays.
    const outcome = await Promise.race([
      atBucketRegion(s3Provider, bucketName, region, purgeAt, ran),
      new Promise((_, reject) => {
        // Detach the timer from the event loop so a fast purge win doesn't
        // leave it holding the process open — handle-probe evidence
        // (2026-08-23 matrix) showed every destroy lingering ~175s past its
        // completion banner on exactly this handle. A detached timer still
        // fires if the purge genuinely hangs; it just stops blocking exit.
        const t = setTimeout(
          () =>
            reject(
              new Error(
                `backup bucket purge exceeded ${PURGE_TIMEOUT_MS / 1000}s, so it was left in place`,
              ),
            ),
          PURGE_TIMEOUT_MS,
        );
        if (typeof t?.unref === 'function') t.unref();
      }),
    ]);
    if (outcome.gone) {
      spinner.stop(notFoundLine('Backup bucket', outcome.searched));
      return { purged: true };
    }
    const { result } = outcome;
    const where = foundElsewhere(outcome.region, region);
    spinner.stop(
      result.kept
        ? `Backups under ${envBackupPrefix} purged${where} (${result.objectsRemoved} objects removed); bucket kept for ${holders.join(', ')}, which ${holders.length === 1 ? 'keeps' : 'keep'} backups there`
        : result.deleted
          ? result.objectsRemoved > 0
            ? `Backup bucket purged${where} (${result.objectsRemoved} objects removed)`
            : `Backup bucket purged${where}`
          : result.shellDeferred
            ? `Backup bucket emptied${where} (${result.objectsRemoved} objects removed); empty shell left for the orphan sweep; no data or storage cost remains`
            : 'Backup bucket not found',
    );
    return { purged: true };
  } catch (error) {
    spinner.stop(`Backup bucket purge failed: ${error.message}`);
    leaks.leak({
      resourceClass: 'bucket',
      resource: describeResource({ name: bucketName, region: ran.region }),
      reason: `purge failed: ${error.message}`,
      hint: backupsLeakHint(Provider.NAME, { bucketName, envBackupPrefix, holders }),
    });
    return { purged: false };
  }
}

/**
 * What to do by hand about a backups bucket -purge left behind. Only this
 * environment's folder is ours to remove while another environment keeps
 * backups in the bucket; the bucket itself goes only with its last holder.
 * It points to the console, never to a destroy rerun: a bucket leak still
 * moves the environment to destroyedEnvironments, so `destroy <env>`
 * afterwards finds nothing to run against.
 *
 * @param {string} providerName
 * @param {{ bucketName: string, envBackupPrefix: string, holders: string[] }} o
 */
function backupsLeakHint(providerName, { bucketName, envBackupPrefix, holders }) {
  if (holders.length === 0) {
    return `Empty it via the ${providerName} Object Storage console, then DeleteBucket; it keeps billing until removed.`;
  }
  return `Delete ${envBackupPrefix} in ${bucketName} via the ${providerName} Object Storage console, and leave the bucket: ${holders.join(', ')} ${holders.length === 1 ? 'keeps' : 'keep'} backups there.`;
}

/**
 * What to do by hand about a derived Pulumi state bucket a last-environment
 * -purge could not delete. Every environment of the project keeps its Pulumi
 * stacks under `.pulumi/stacks/` in this one bucket, so that is the check
 * before deleting it. It points to the console, never to a destroy rerun:
 * the environment has already moved to destroyedEnvironments. Deleting it by
 * hand is safe because the purge still rotates stateBucketGeneration
 * (`abandoned`), so the next deploy derives a fresh name instead of
 * recreating this one.
 *
 * @param {string} providerName
 */
function stateBucketLeakHint(providerName) {
  return `Once .pulumi/stacks/ in it holds no stack (each environment of this project keeps its Pulumi state there), empty it via the ${providerName} Object Storage console, then DeleteBucket; it keeps billing until removed.`;
}

/**
 * Keep the dedicated Pulumi state bucket. Deliberately NOT deleted.
 *
 * Deleting it and letting the next deploy recreate a bucket of the same name is
 * how acked writes were lost on 2026-08-07 (e4 restore->failover: the standby's
 * `up` succeeded and served traffic, and its state was simply absent from the
 * recreated bucket 45+ minutes later). The workaround was to rotate the bucket
 * NAME on every verified destroy, which guaranteed that every redeploy landed
 * on a brand-new bucket — the worst window for this whole failure class, since
 * a freshly-created bucket is when the store is least consistent and most
 * likely to throttle.
 *
 * Keeping the bucket collapses all of that: no delete means no recreate, no
 * recreate means the write-loss hazard cannot occur, and with the hazard gone
 * the name rotation has nothing left to protect. The next deploy of this
 * environment reuses a warm bucket instead of paying cold-start cost.
 *
 * It also makes a partial destroy recoverable. The state bucket holds the only
 * record of what is actually still deployed, and deleting it in the same run
 * that failed to verify a teardown destroyed the evidence alongside the
 * failure — which is why the k8s plan used to gate this step on
 * `pulumiDestroyFailed`. That gate is gone with the deletion it guarded.
 *
 * Reported as plain output, NOT through the leak ledger: this is an intended
 * outcome, and `leak`/`unverified` both count toward `survivors`, so routing it
 * there would make every clean destroy look like it left something behind.
 *
 * Cost is a near-empty bucket — the stack file is removed by `pulumi destroy` +
 * `removeStack` before this runs, leaving backend metadata and history. On
 * Hetzner, object storage bills per ACCOUNT rather than per bucket, so an extra
 * empty bucket is close to free.
 */
async function retainStateBucket(
  envConfig,
  projectConfig,
  args,
  spinner,
  leaks,
  environment,
  entryKept = null,
) {
  const stateBucket = envConfig.s3?.stateBucket;
  // Pre-split environments kept Pulumi state in the app storage bucket, which
  // the normal app-bucket path deletes; there is no separate bucket to keep.
  if (!stateBucket || stateBucket === envConfig.s3?.bucket) return;

  // A PINNED state bucket (project-level `stateBucket` in .vibecarbon.json)
  // is by definition shareable — one named bucket serving several
  // environments, projects, or operators. `-purge` on ONE environment must
  // not delete state the others still depend on, and re-creating a pinned
  // bucket minutes later puts every subsequent deploy in the fresh-bucket
  // read-after-write window the pin exists to avoid (e4 2026-08-29: a purge
  // deleted the shared pin, the next run's concurrent HA stack-ups hit a
  // minutes-old recreation, and the primary's post-up state read came back
  // without outputs). Purge keeps its "leave nothing behind" meaning for the
  // per-project DERIVED bucket below; a pin is kept and named.
  if (projectConfig.stateBucket && projectConfig.stateBucket === stateBucket) {
    spinner.start('Pulumi state bucket');
    spinner.stop(
      `Pulumi state bucket kept (pinned): ${stateBucket} — a pinned bucket may serve other ` +
        'environments or projects; delete it manually if nothing uses it anymore.',
    );
    return;
  }

  // The derived name is project-level (project storage base + stateBucketGeneration),
  // so every environment of the project keeps its Pulumi stacks in this one
  // bucket. -purge on one environment while others are live keeps it: its
  // own stack file is already gone (pulumi destroy + removeStack ran before
  // this), and the other environments' state must survive.
  const others = otherEnvironmentNames(projectConfig, environment);
  if (args?.purgeBackups && others.length > 0) {
    spinner.start('Pulumi state bucket');
    spinner.stop(
      `Pulumi state bucket kept for ${others.length} other environment(s): ${stateBucket}`,
    );
    return { purged: false };
  }

  // A destroy that keeps the environment's entry (entryKeptReason) left
  // something the next `vibecarbon destroy` of this environment retries from
  // that entry, and the retry opens its stacks in this bucket. So -purge
  // keeps it this time, without rotating the generation or forgetting the
  // retained name: the retry must resolve this same bucket. The next clean
  // destroy -purge deletes it. Plain output, like every kept bucket here.
  if (args?.purgeBackups && entryKept) {
    spinner.start('Pulumi state bucket');
    spinner.stop(
      `Pulumi state bucket kept: ${stateBucket}. This destroy keeps ${environment}'s entry ` +
        `because ${entryKept.because}, and your next \`${retryDestroyCommand(environment, args)}\` ` +
        'needs this bucket to retry, and deletes it once it runs clean.',
    );
    return { purged: false };
  }

  // -purge of the last environment means "leave nothing behind": it already
  // deletes the backups bucket once no environment keeps backups there, and
  // the state bucket follows the same rule. This is the ONE deletion path for the retained bucket (review
  // finding, 2026-08-15: there was previously none at all), and it is safe
  // where the old always-delete was not: it runs only on explicit request,
  // after stack teardown, and a successful delete returns `purged`, which
  // makes updateProjectConfig rotate stateBucketGeneration. A purge it could
  // not finish returns `abandoned`, which rotates it too, since its hint
  // tells you to delete the bucket by hand. The next deploy then derives a
  // fresh name instead of recreating this one, which is the same-name
  // recreate that lost acked writes on 2026-08-07.
  if (args?.purgeBackups) {
    // A purge carries nothing forward: drop any retained name whether or not
    // the delete below succeeds, so the next deploy never resolves to a
    // bucket that is gone (or about to be) and derives a fresh one instead.
    delete projectConfig.retainedStateBucket;
    const region = envConfig.s3?.stateBucketRegion || envConfig.s3?.region || 'fsn1';
    const Provider = providerFor(envConfig);
    spinner.start(`Purging Pulumi state bucket: ${stateBucket}`);
    try {
      const s3Creds = await Provider.promptObjectStorageCredentials(projectConfig.projectName, {
        save: false,
        skipPrompts: !process.stdin.isTTY,
      });
      if (!s3Creds) {
        spinner.stop('State bucket purge skipped (no credentials available)');
        leaks.leak({
          resourceClass: 'bucket',
          resource: describeResource({ name: stateBucket, region }),
          reason: 'purge requested (-purge) but no object-storage credentials were available',
          hint: stateBucketLeakHint(Provider.NAME),
        });
        return { purged: false, abandoned: true };
      }
      const s3Provider = await getObjectStorageProvider(
        providerIdFor(envConfig),
        s3Creds.accessKey,
        s3Creds.secretKey,
        region,
      );
      const result = await s3Provider.emptyAndDeleteBucket(stateBucket);
      spinner.stop(
        result.deleted
          ? `Pulumi state bucket purged (${result.objectsRemoved} objects removed)`
          : 'Pulumi state bucket not found',
      );
      return { purged: !!result.deleted };
    } catch (error) {
      spinner.stop(`State bucket purge failed: ${error.message}`);
      leaks.leak({
        resourceClass: 'bucket',
        resource: describeResource({ name: stateBucket, region }),
        reason: `purge failed: ${error.message}`,
        hint: stateBucketLeakHint(Provider.NAME),
      });
      return { purged: false, abandoned: true };
    }
  }

  // Keeping the bucket is only useful if the next deploy finds it. The
  // derived name is stable across a plain destroy→deploy (stateBucketGeneration
  // rotates only when -purge deletes the bucket), and recording the kept name
  // also covers a bucket derived under an older scheme, so a redeploy finds
  // this bucket again instead of orphaning it (vibecarbon-web 2026-09-15).
  // resolveStateBucketName reads it ahead of derivation; the
  // update-project-config step writes it (results.retainedStateBucket).
  projectConfig.retainedStateBucket = stateBucket;
  spinner.start('Pulumi state bucket');
  spinner.stop(
    `Pulumi state bucket kept for reuse: ${stateBucket} (recorded as retainedStateBucket; ` +
      'the next deploy resumes this warm state backend). ' +
      keptStateBucketNext(environment, entryKept, others),
  );
  // Deliberately NOT a ledger entry. All four severities mean something this
  // is not: leak/unverified feed `survivors` and fail the exit code, `foreign`
  // asserts it is not ours, and `risk` predicts a leak. A bucket kept by
  // design is none of those — AGENTS.md's destroy contract names this
  // retention explicitly as the sanctioned fifth outcome.
}

/**
 * Final outro for the destroy flow: the LEAK REPORT.
 *
 * Every teardown class reports its verdicts into `results.leaks` (the ledger
 * in lib/destroy/leak-ledger.js) as it goes. This prints one line per
 * surviving resource — class, identity, and why it survived — then a summary
 * count, and sets the exit code from the accumulated verdict.
 *
 * Before this existed, destroy printed `Environment "X" destroyed.` and exited
 * 0 whenever it reached the end, regardless of what it had failed to delete.
 * On 2026-07-22 (the prod re-home) that meant a "successful" destroy over a
 * still-running server and two live firewalls.
 *
 * A clean destroy still gets a single line — an all-clear that says what was
 * actually verified, so the absence of a leak report can't be confused with a
 * destroy that never checked.
 */
/** Print a non-clean leak report's verdict lines, hints and summary. */
function printLeakReportLines(report) {
  const paint = {
    leak: c.error,
    unverified: c.error,
    foreign: c.warning,
    risk: c.warning,
  };
  for (const line of report.lines) {
    p.log.message(`  ${(paint[line.severity] ?? ((s) => s))(line.text)}`);
    if (line.hint) p.log.message(`    ${c.dim(`↳ ${line.hint}`)}`);
  }
  p.log.message(`  ${c.bold(report.summary)}`);
}

export function destroyOutro(envName, timeStr, results) {
  const ledger = results.leaks;
  const report = formatLeakReport(ledger, { environment: envName });

  if (report.clean) {
    p.log.success(`Environment "${envName}" destroyed.`);
    p.log.message(`  ${c.success('✓')} ${report.summary}`);
    p.outro(`Done ${c.dim(`(${timeStr})`)}`);
    process.exitCode = report.exitCode;
    return;
  }

  const counts = ledger.counts();
  const survivors = counts.leak + counts.unverified;
  if (survivors > 0) {
    p.log.error(
      `Environment "${envName}" was NOT fully torn down — ${survivors} resource(s) survived or could not be verified:`,
    );
  } else {
    // Only foreign/at-risk lines: our own teardown was clean, but there is
    // still something the operator needs to see.
    p.log.warn(`Environment "${envName}" destroyed — with observations:`);
  }

  printLeakReportLines(report);
  p.outro(
    survivors > 0 ? `Done with leaks ${c.dim(`(${timeStr})`)}` : `Done ${c.dim(`(${timeStr})`)}`,
  );
  process.exitCode = report.exitCode;
}

// ============================================================================
// SHARED TEARDOWN TAIL
// ============================================================================

/**
 * Shared teardown-tail effects, decomposed from the former `finishDestroy`
 * monolith into one effect per block so the buckets-last ordering (app bucket →
 * state bucket → backup bucket, all AFTER the tier teardown) is a first-class,
 * plan-visible property. Each effect is a verbatim relocation of a finishDestroy
 * block — same operations, same order, same results/issues bookkeeping — reading
 * from and mutating the shared destroy `ctx` (envConfig, projectConfig,
 * environment, args, results, spinner, tracker, cwd, isK8s).
 *
 * Tier divergence is carried on ctx.isK8s: only k8s tiers delete the GitHub
 * environment and print the summary note — and the k8s-only steps
 * (delete-github-env, print-summary) appear only in the k8s destroy plan.
 */

/** Names of the project's environments other than the one being destroyed. */
function otherEnvironmentNames(projectConfig, environment) {
  return Object.keys(projectConfig.environments ?? {}).filter((name) => name !== environment);
}

/**
 * What deletes the app bucket a plain destroy keeps. The keep rule is final
 * when the bucket steps run (entryKeptReason), so the line knows whether the
 * environment stays listed. While it does, a clean -purge of it deletes the
 * bucket. Once this destroy moves it to destroyedEnvironments, `destroy <env>`
 * stops at "not found", and no command deletes a destroyed environment's
 * bucket (-orphans removes Pulumi stacks only): a redeploy reuses it, and the
 * console deletes it.
 *
 * @param {string} environment
 * @param {{ because: string } | null} entryKept - entryKeptReason's verdict
 * @param {string} providerName
 */
function keptAppBucketNext(environment, entryKept, providerName) {
  if (entryKept) {
    return (
      `This destroy keeps ${environment}'s entry because ${entryKept.because}, so a clean ` +
      `\`${retryDestroyCommand(environment, { purgeBackups: true })}\` deletes it.`
    );
  }
  return (
    `A redeploy of ${environment} reuses it. This destroy moves ${environment} out of your ` +
    'environments, so no later destroy reaches the bucket: to delete it, empty it via the ' +
    `${providerName} Object Storage console, then DeleteBucket; it keeps billing until removed.`
  );
}

/**
 * What deletes the derived Pulumi state bucket a plain destroy keeps. Every
 * environment of the project keeps its stacks in it, and only a -purge of
 * the project's last environment deletes it (retainStateBucket). While this
 * environment stays listed and is the only one, that is a clean -purge of it.
 * With no environment left, nothing is there to destroy until a deploy
 * resumes the bucket. The line never sends you to the console: a plain
 * destroy records the name (retainedStateBucket) without rotating
 * stateBucketGeneration, so the next deploy would recreate a bucket you just
 * deleted, the same-name recreate that lost acked writes on 2026-08-07.
 *
 * @param {string} environment
 * @param {{ because: string } | null} entryKept - entryKeptReason's verdict
 * @param {string[]} others - the project's other live environments
 */
function keptStateBucketNext(environment, entryKept, others) {
  if (others.length > 0) {
    return (
      `${others.join(', ')} still ${others.length === 1 ? 'uses' : 'use'} it, so a -purge ` +
      "destroy of the project's last environment deletes it."
    );
  }
  if (entryKept) {
    return (
      `This destroy keeps ${environment}'s entry because ${entryKept.because}, so a clean ` +
      `\`${retryDestroyCommand(environment, { purgeBackups: true })}\` deletes it.`
    );
  }
  return (
    'No environment is left to destroy, so it waits for your next deploy; a -purge destroy ' +
    "of the project's last environment deletes it then."
  );
}

/**
 * Is the environment's recorded app bucket its OWN: the per-environment name
 * deriveEnvAppBucketName gives it, and not pinned? Only such a bucket is this
 * environment's alone. An env still on an older CLI's per-project bucket
 * (`<project>-<salt>-storage`, or `...-storage-<gen>`, never pinned) shares
 * it with every other environment of the project, and a pinned bucket may be
 * that same bucket, so -purge deletes neither.
 */
function ownsAppBucket(envConfig, projectConfig, environment) {
  const bucket = envConfig?.s3?.bucket;
  if (!bucket || envConfig.s3.bucketPin) return false;
  try {
    return bucket === deriveEnvAppBucketName(projectConfig, environment);
  } catch {
    // An env name too long to derive from never deployed one of its own.
    return false;
  }
}

/**
 * What the destroy preview needs to know about the buckets, decided by the
 * same rules the teardown applies (deleteAppBucketEffect, handleBackupBucket),
 * so the preview never promises a deletion the destroy will not do.
 * `backupBucketHolders` names the environments that keep backups in this
 * environment's backups bucket (backupsBucketHolders), so -purge keeps it.
 *
 * @returns {{ appBucketOwned: boolean, backupBucketHeld: boolean, backupBucketHolders: string[] }}
 */
export function destroyPreviewBucketFacts(projectConfig, environment) {
  const envConfig = projectConfig.environments?.[environment] ?? {};
  const backups = backupsTargetOf(envConfig);
  const holders = backups
    ? backupsBucketHolders(projectConfig, { bucket: backups.bucket, except: environment })
    : [];
  return {
    appBucketOwned: ownsAppBucket(envConfig, projectConfig, environment),
    backupBucketHeld: holders.length > 0,
    backupBucketHolders: holders,
  };
}

// 1. The env's own app S3 bucket (created during deploy bootstrap, not part
//    of any Pulumi stack's resource graph). Plain destroy keeps it and its
//    uploads, the same way it keeps this env's backups, and the destroyed
//    env's seed names it so a redeploy lands on it again. -purge empties and
//    deletes it only when it is this env's own (ownsAppBucket): never a
//    pinned bucket, never a legacy per-project bucket other envs share, and
//    not while this destroy keeps the env's entry (entryKeptReason).
async function deleteAppBucketEffect(ctx) {
  const { envConfig, projectConfig, environment, args, results, spinner } = ctx;
  const s3BucketName = envConfig.s3?.bucket;
  if (!s3BucketName) return;
  // A PINNED bucket (envConfig.s3.bucketPin, the E6 escape hatch) may be the
  // old per-project bucket that several environments pin, so -purge on one
  // of them must not delete the others' uploads. Kept always, like a pinned
  // state bucket in retainStateBucket, and the line says so on a plain
  // destroy too: no -purge deletes it.
  if (envConfig.s3?.bucketPin) {
    spinner.start('S3 bucket');
    spinner.stop(
      `S3 bucket kept (pinned): ${s3BucketName}. A pinned bucket may serve other environments; delete it manually if nothing uses it anymore.`,
    );
    return;
  }
  if (!ownsAppBucket(envConfig, projectConfig, environment)) {
    spinner.start('S3 bucket');
    spinner.stop(
      `S3 bucket kept: ${s3BucketName}. It is the legacy per-project bucket, which other environments may still use; delete it manually if nothing uses it anymore.`,
    );
    return;
  }
  // A destroy that keeps the environment's entry (entryKeptReason) leaves
  // the environment live for the rerun, and a live record's bucket must
  // stay: another environment's fenced deploy looks for it and stops when it
  // is gone. So -purge keeps it this time, as retainStateBucket keeps the
  // state bucket. The keep rule is final by now: the teardown, the key
  // revoke and the stack state ran first, and the steps after this one add
  // only lines that keep nothing. The next clean -purge deletes it and
  // records appBucketPurged. A plain destroy keeps it either way, and the
  // same verdict tells its line what can delete it (keptAppBucketNext).
  const entryKept = entryKeptReason(results, envConfig);
  if (!args?.purgeBackups) {
    // Kept by design, so not a ledger entry (see retainStateBucket).
    spinner.start('S3 bucket');
    spinner.stop(
      `S3 bucket kept with its uploads: ${s3BucketName}. ` +
        keptAppBucketNext(environment, entryKept, providerFor(envConfig).NAME),
    );
    return;
  }
  if (entryKept) {
    spinner.start('S3 bucket');
    spinner.stop(
      `S3 bucket kept with its uploads: ${s3BucketName}. This destroy keeps ${environment}'s ` +
        `entry because ${entryKept.because}, and a kept environment keeps its uploads; a clean ` +
        `\`${retryDestroyCommand(environment, args)}\` deletes it then.`,
    );
    return;
  }
  const s3Region = envConfig.s3?.region || 'fsn1';
  // Resolved once per flow — see providerFor() in lib/providers/index.js.
  const Provider = providerFor(envConfig);
  // Where the delete is running: a failure is reported in that region.
  const ran = { region: s3Region };
  spinner.start(`Deleting S3 bucket: ${s3BucketName}`);
  try {
    const s3Creds = await Provider.promptObjectStorageCredentials(projectConfig.projectName, {
      save: false,
      skipPrompts: !process.stdin.isTTY,
    });
    if (s3Creds) {
      const s3Provider = await getObjectStorageProvider(
        providerIdFor(envConfig),
        s3Creds.accessKey,
        s3Creds.secretKey,
        s3Region,
      );
      // Where the record says, else wherever the bucket really is: an
      // environment that hit the old bug records its uploads under the wrong
      // region until its next deploy, and its uploads are still there.
      const outcome = await atBucketRegion(
        s3Provider,
        s3BucketName,
        s3Region,
        (store) => store.emptyAndDeleteBucket(s3BucketName),
        ran,
      );
      if (outcome.gone) {
        spinner.stop(notFoundLine('S3 bucket', outcome.searched));
        return;
      }
      const result = outcome.result;
      const where = foundElsewhere(outcome.region, s3Region);
      if (result.deleted) {
        results.s3Bucket = s3BucketName;
        // The destroyed record says so, and the app key fence never asks
        // about this bucket again. Only a delete confirmed here counts:
        // "not found" anywhere is not a delete, and an emptied shell still
        // exists, so the fence keeps both.
        results.appBucketPurged = true;
        spinner.stop(
          result.objectsRemoved > 0
            ? `S3 bucket deleted${where} (${result.objectsRemoved} objects removed)`
            : `S3 bucket deleted${where}`,
        );
      } else if (result.shellDeferred) {
        results.s3Bucket = s3BucketName;
        spinner.stop(
          `S3 bucket emptied${where} (${result.objectsRemoved} objects removed); empty shell left for the orphan sweep; no data or storage cost remains`,
        );
      } else {
        spinner.stop('S3 bucket not found');
      }
    } else {
      spinner.stop('S3 bucket skipped (no credentials available)');
      results.leaks.leak({
        resourceClass: 'bucket',
        resource: describeResource({ name: s3BucketName, region: s3Region }),
        reason: 'purge requested (-purge) but no object-storage credentials were available',
        // The environment has moved to destroyedEnvironments, so a destroy
        // rerun finds nothing; and only this environment's own bucket gets
        // here (ownsAppBucket), so deleting it by hand is safe.
        hint: `Empty it via the ${Provider.NAME} Object Storage console, then DeleteBucket; it keeps billing until removed.`,
      });
    }
  } catch (error) {
    spinner.stop(`S3 deletion failed: ${error.message}`);
    results.leaks.leak({
      resourceClass: 'bucket',
      resource: describeResource({ name: s3BucketName, region: ran.region }),
      reason: `not deleted: ${error.message}`,
      hint: `Empty manually via the ${Provider.NAME} Object Storage console, then DeleteBucket. Bucket continues to incur storage charges until deleted.`,
    });
  }
}

// 0. The env's own app storage key (security plan R9), before the buckets:
//    no server uses it once the servers are gone, and a redeploy mints a
//    fresh one. Plain destroy and -purge alike. A minted key (Linode,
//    DigitalOcean) is revoked over the API; one that could not be is a leak.
//    A pasted Hetzner key cannot be revoked by the CLI: destroy retires it
//    (projectConfig.retiredAppKeys, still denied in every fence) and prints
//    the console step plus the `configure storage -forget` step.
async function revokeAppStorageKeyEffect(ctx) {
  const { envConfig, projectConfig, environment, results, spinner, cwd } = ctx;
  const record = envConfig.s3?.appKey;
  if (!record?.id) return;
  const Provider = providerFor(envConfig);
  const providerId = providerIdFor(envConfig);
  const secrets = localAppStorageSecrets(cwd);
  const names = appStorageSecretKeys(environment);
  const forget = () => {
    if (secrets.get(names.accessKey)) secrets.set(names.accessKey, '');
    if (secrets.get(names.secretKey)) secrets.set(names.secretKey, '');
  };
  if (record.scoping === 'mint') {
    spinner.start(`Revoking app storage key ${record.id}`);
    const outcome = await revokeAppStorageCredential({
      provider: providerId,
      envConfig,
      apiToken: ctx.providerToken,
    });
    if (outcome.revoked) {
      forget();
      spinner.stop(`App storage key revoked: ${record.id}`);
      return;
    }
    spinner.stop(`App storage key not revoked: ${record.id}`);
    results.leaks.leak({
      resourceClass: 'storage-key',
      resource: record.id,
      reason: outcome.leak ?? 'not revoked',
      hint: `Delete it in the ${Provider.NAME} console under the object storage access keys. It can reach bucket ${record.bucket ?? envConfig.s3?.bucket}.`,
    });
    return;
  }
  if (record.scoping !== 'paste-fence') return;
  // Retire the key before anything else: it stays denied in every fence
  // until the operator deletes it in the console and forgets it.
  const retire = (keys) => [...new Set([...(keys ?? []), record.id])];
  projectConfig.retiredAppKeys = retire(projectConfig.retiredAppKeys);
  updateProjectConfig((config) => {
    config.retiredAppKeys = retire(config.retiredAppKeys);
  });
  spinner.start('App storage key fence');
  try {
    const s3Creds = await Provider.promptObjectStorageCredentials(projectConfig.projectName, {
      save: false,
      skipPrompts: !process.stdin.isTTY,
    });
    if (s3Creds) {
      const s3Region = envConfig.s3?.region || 'fsn1';
      const s3 = await getObjectStorageProvider(
        providerId,
        s3Creds.accessKey,
        s3Creds.secretKey,
        s3Region,
      );
      const fenced = await syncHetznerFences({
        projectConfig,
        environment,
        leaving: true,
        s3,
        secrets,
        createProbe: (accessKey, secretKey) =>
          getObjectStorageProvider(providerId, accessKey, secretKey, s3Region),
      });
      spinner.stop(`App storage key ${record.id} retired; it stays denied in every bucket fence`);
      for (const line of fenceInfoLines(fenced)) p.log.info(line);
      // Marked (or cleared) in this destroy's config write, so the line
      // prints once.
      results.fenceGone = fenced.gone ?? [];
      results.fenceFound = (fenced.found ?? []).map((f) => f.bucket);
      results.fenceLocated = (fenced.located ?? []).map(({ bucket, region, endpoint }) => ({
        bucket,
        region,
        endpoint,
      }));
    } else {
      spinner.stop(
        `App storage key ${record.id} retired; the bucket fences were not updated (no object storage keys here), and they still deny it`,
      );
    }
  } catch (err) {
    spinner.stop(
      `App storage key ${record.id} retired; the bucket fences were not updated (${err.message}), and they still deny it`,
    );
  }
  forget();
  p.log.warn(
    `Delete the pasted app storage key ${record.id} in the ${Provider.NAME} console (Security, S3 credentials); vibecarbon cannot revoke a key it did not make. It stays denied in every bucket fence until you run \`vibecarbon configure storage -forget ${record.id}\` after deleting it.`,
  );
}

// 2. State bucket: kept on purpose, so the next deploy reuses a warm bucket
//    instead of recreating one under the same name — see retainStateBucket.
async function retainStateBucketEffect(ctx) {
  const { envConfig, projectConfig, environment, args, spinner, results } = ctx;
  const before = projectConfig.retainedStateBucket;
  const outcome = await retainStateBucket(
    envConfig,
    projectConfig,
    args,
    spinner,
    results.leaks,
    environment,
    entryKeptReason(results, envConfig),
  );
  if (outcome?.purged) results.stateBucketPurged = true;
  // A purge it could not finish leaves the bucket for you to delete by hand
  // (stateBucketLeakHint); the generation rotates all the same, so the next
  // deploy never recreates a name you may have just deleted.
  if (outcome?.abandoned) results.stateBucketAbandoned = true;
  // What this destroy decided about retainedStateBucket, for the config write
  // (which patches the file as it is then, not this in-memory copy).
  if (projectConfig.retainedStateBucket !== before) {
    results.retainedStateBucket = { value: projectConfig.retainedStateBucket };
  }
}

// 3. Backup bucket: preserved by default; -purge deletes this environment's
//    backups, and the bucket with its last holder (backupsBucketHolders),
//    unless this destroy keeps the environment's entry (entryKeptReason).
async function handleBackupBucketEffect(ctx) {
  const { envConfig, projectConfig, environment, args, spinner, results } = ctx;
  const outcome = await handleBackupBucket(
    envConfig,
    projectConfig,
    environment,
    args,
    spinner,
    results.leaks,
    entryKeptReason(results, envConfig),
  );
  if (outcome?.purged) results.backupsPurged = true;
}

// 4. GitHub environment (k8s only — this step is absent from the compose plans).
//
// Deliberately NOT tallied. `deleteGitHubEnvironment` returns false for both
// "no such environment" and "gh has no access to this repo" — indistinguishable
// from here — and neither outcome is a cloud resource that bills or blocks the
// next deploy. Reporting it as a leak would make every destroy run outside a
// GitHub-connected checkout exit non-zero.
async function deleteGithubEnvEffect(ctx) {
  const { environment, results, spinner } = ctx;
  spinner.start(`Deleting GitHub environment: ${environment}`);
  try {
    results.github = deleteGitHubEnvironment(environment);
    spinner.stop(
      results.github ? 'GitHub environment deleted' : 'GitHub environment not found (or no access)',
    );
  } catch (error) {
    spinner.stop(`Failed to delete GitHub environment: ${error.message}`);
  }
}

/**
 * Distinct addresses for one line: "X", "X and Y", "X, Y and Z".
 * @param {string[]} addresses - each once
 * @returns {string}
 */
function joinAddresses(addresses) {
  if (addresses.length <= 1) return addresses.join('');
  return `${addresses.slice(0, -1).join(', ')} and ${addresses.at(-1)}`;
}

/**
 * Does a LEAK or UNVERIFIED line of this class keep the environment's entry
 * in .vibecarbon.json? Yes exactly when a re-run of `vibecarbon destroy <env>`
 * can still find and remove what the line names, because the entry is the
 * only way to run that destroy again. Everything that keeps the entry keeps
 * the state the re-run opens with it (entryKeptReason's readers): the compose
 * tiers' Pulumi stack state, and the state bucket under -purge.
 *
 * FOREIGN and AT-RISK lines never keep it: our own teardown left nothing
 * there (destroyExitCode's policy). A class with no row keeps it, and so does
 * a destroy step with no row (keepsEntry): an entry kept by mistake costs one
 * more destroy, and one removed by mistake strands whatever a re-run would
 * have found, with no CLI path back to it.
 *
 * Every class a ledger call in src/ can emit has a row
 * (tests/unit/destroy/entry-keep-class-table.test.ts walks src/ for them).
 * `keeps` is a boolean, or, for `destroy-step`, one verdict per plan step:
 * the step that threw names what it had not finished. A step that keeps
 * nothing says what to finish by hand (`byHand`).
 *
 * The compose plans remove the stack state after the last step that can add
 * a line that keeps the entry (destroy-plan.js composeTail), so the stack
 * state stays exactly when the entry does. The bucket steps come later in
 * every plan, so under -purge they keep their buckets exactly when it does.
 */
export const ENTRY_KEEP_BY_CLASS = Object.freeze({
  server: {
    keeps: true,
    why: 'the re-run deletes it by id or name, and its server sweeps list the account again',
  },
  firewall: { keeps: true, why: 'the re-run deletes it by its name' },
  'ssh-key': { keeps: true, why: 'the re-run deletes it by its name' },
  network: { keeps: true, why: "the re-run's k8s backstop deletes the VPC by its name" },
  'load-balancer': {
    keeps: true,
    why: "the re-run's load-balancer cleanup finds it by the cluster's name and labels",
  },
  'reserved-ip': {
    keeps: true,
    why:
      'the re-run releases it by its recorded address or its labels (keepUnreleased and ' +
      'unsweptReservedIpScopes name it on the kept-config line)',
  },
  'floating-ip': {
    keeps: true,
    why: "a resource still in a stack whose Pulumi destroy failed: the re-run's Pulumi destroy deletes it",
  },
  volume: {
    keeps: true,
    why:
      'a CSI volume of ours not confirmed deleted, or a volume listing or sweep that did not ' +
      "finish: the re-run lists the region's volumes again",
  },
  'volume-identity': {
    keeps: false,
    why:
      "the cluster's PersistentVolume capture or server pre-scan failed; this destroy tears the " +
      'cluster down, so a re-run has nothing left to capture and would keep the entry forever. ' +
      'The volume lines name what is left',
  },
  'volume-deferred': {
    keeps: false,
    why:
      'a pvc-* volume that only looks like ours, left because its owner cannot be proven; a ' +
      're-run cannot prove it either while another server runs in that region, so keeping the ' +
      'entry would keep it for as long as that server lives',
  },
  'detached-volume': {
    keeps: false,
    why:
      "a block volume a server's delete left behind and could not delete (Scaleway SBS): the " +
      're-run finds the server gone and reads no volumes, so nothing it does reaches it; the ' +
      'hint names the console delete',
  },
  'pulumi-stack': {
    keeps: true,
    why: 'the stack record in the state bucket, which the re-run destroys or removes',
  },
  'unreadable-stack': {
    keeps: false,
    why:
      'a k8s stack whose state no value this project has can decrypt, its record removed ' +
      'unread once the API sweeps ran in place of `pulumi destroy` (settleUnreadableStacks): a ' +
      're-run finds no record, and what the sweeps left is on lines of its own; the hint names ' +
      'the console delete',
  },
  'compose-ha teardown': { keeps: true, why: 'the re-run runs the whole HA teardown again' },
  'storage-key': {
    keeps: true,
    why:
      'its id is recorded only in this entry; the re-run revokes it, and a key already ' +
      'deleted by hand counts as revoked',
  },
  'dns-record': {
    keeps: false,
    why:
      'DNS records live outside the Pulumi stack, and keeping the entry for one would keep a ' +
      'stack whose resources are gone, which the next deploy of the name picks up (e2e run ' +
      '32309395314); the hint names the by-hand delete',
  },
  'health-check': {
    keeps: false,
    why: 'outside the Pulumi stack like a DNS record; the hint names the by-hand delete',
  },
  bucket: {
    keeps: false,
    why:
      'buckets live outside the Pulumi stack and go only under -purge; a bucket leak still ' +
      'records the environment under destroyedEnvironments, and the hints name the console',
  },
  'project-config': {
    keeps: true,
    why: "written only when the entry is kept: it is that keep's own line",
  },
  resource: {
    keeps: true,
    why: "the ledger's stand-in for a line that names no class: nothing says a re-run cannot act on it",
  },
  'destroy-step': {
    why: 'a step that threw left undone whatever it had not reached; the step says what that is',
    keeps: {
      'destroy-compose-services': true,
      'destroy-compose-ha': true,
      'destroy-k8s-infra': true,
      'remove-stack-state': true,
      'revoke-app-storage-key': true,
      'delete-app-bucket': {
        byHand: () =>
          "If you asked for -purge, empty and delete the environment's app bucket in your " +
          "provider's object storage console; it keeps billing until removed.",
      },
      'retain-state-bucket': {
        byHand: () =>
          'If you asked for -purge and no other environment is left, empty and delete the ' +
          "Pulumi state bucket in your provider's object storage console.",
      },
      'handle-backup-bucket': {
        byHand: () =>
          "If you asked for -purge, delete this environment's backups in your provider's " +
          'object storage console; they keep billing until removed.',
      },
      'delete-github-env': {
        byHand: (env) =>
          `Delete the GitHub environment ${env} in the repository's settings if it is still there.`,
      },
      'update-project-config': {
        byHand: (env, args) =>
          `If .vibecarbon.json still lists ${env}, run \`${retryDestroyCommand(env, args)}\` ` +
          'again to remove it.',
      },
      'cleanup-local-files': {
        byHand: (env) =>
          `Delete ${env}'s SSH keys, kubeconfigs and deploy-state files under .vibecarbon/ by hand.`,
      },
      'print-summary': {
        byHand: () => 'Nothing is left to do in the cloud: only the summary failed to print.',
      },
      'finish-outro': {
        byHand: () => 'Nothing is left to do in the cloud: only the report failed to print.',
      },
    },
  },
});

/**
 * The verdict ENTRY_KEEP_BY_CLASS gives one ledger line: `true` when it keeps
 * the environment's entry, or the by-hand step when it does not.
 * @param {{severity: string, resourceClass: string, resource: string}} entry
 * @returns {true | {byHand: (env: string, args?: {purgeBackups?: boolean}) => string} | false}
 */
function entryVerdict({ severity, resourceClass, resource }) {
  if (severity !== 'leak' && severity !== 'unverified') return false;
  if (!Object.hasOwn(ENTRY_KEEP_BY_CLASS, resourceClass)) return true;
  const { keeps } = ENTRY_KEEP_BY_CLASS[resourceClass];
  if (typeof keeps === 'boolean') return keeps;
  if (!Object.hasOwn(keeps, resource)) return true;
  return keeps[resource] === true ? true : keeps[resource];
}

/**
 * Does this ledger line keep the environment's entry (ENTRY_KEEP_BY_CLASS)?
 * Unknown classes and unknown steps do: fail closed.
 * @param {{severity: string, resourceClass: string, resource: string}} entry
 * @returns {boolean}
 */
export function keepsEntry(entry) {
  return entryVerdict(entry) === true;
}

/**
 * Why this destroy keeps the environment's entry in .vibecarbon.json, or null
 * when it removes it. The one predicate every reader shares: the config step
 * keeps the entry (updateProjectConfigEffect), the compose tiers keep their
 * Pulumi stack state (removePulumiStackStateEffect), the state-bucket step
 * keeps the bucket the retry opens (retainStateBucket), and under -purge the
 * app and backups bucket steps keep theirs (deleteAppBucketEffect,
 * handleBackupBucket), so none of them can disagree.
 *
 *   - `unverified`: the Pulumi destroy could not be verified
 *     (recordPulumiDestroyOutcome, or destroyK8sTier's catch).
 *   - `unreleased`: a reserved IP of ours the backstop could not prove
 *     released (keepUnreleased), each address once: on k8s-ha both side
 *     stacks can name one environment-level address.
 *   - `unswept`: the stacks whose label listing could not be read
 *     (sweepTaggedReservedIps), so an IP no record names may be left. The
 *     entry is what lets `vibecarbon destroy <env>` run that sweep again.
 *   - `rerunnable`: the classes of the leak and unverified lines a re-run can
 *     still find and remove (keepsEntry, ENTRY_KEEP_BY_CLASS), each once.
 *
 * `because` names the IPs in the provider's own word (`RESERVED_IP_NAME`:
 * Floating IP on Hetzner, flexible IP on Scaleway, reserved IP elsewhere).
 *
 * Exported for unit testing.
 *
 * @param {{pulumiDestroyFailed?: boolean, unreleasedReservedIps?: string[], unsweptReservedIpScopes?: string[], leaks?: {entries: Array<{severity: string, resourceClass: string, resource: string}>}}} results
 * @param {object} envConfig - the environment, for its provider's word
 * @returns {{unverified: true, because: string} | {unreleased: string[], unswept: string[], rerunnable: string[], because: string} | null}
 */
export function entryKeptReason(results, envConfig) {
  if (results.pulumiDestroyFailed) {
    return { unverified: true, because: 'its Pulumi destroy was not verified' };
  }
  const unreleased = [...new Set(results.unreleasedReservedIps ?? [])];
  const unswept = [...new Set(results.unsweptReservedIpScopes ?? [])];
  const rerunnable = [
    ...new Set(
      (results.leaks?.entries ?? []).filter(keepsEntry).map((entry) => entry.resourceClass),
    ),
  ];
  if (unreleased.length === 0 && unswept.length === 0 && rerunnable.length === 0) return null;
  const reasons = [];
  if (unreleased.length > 0 || unswept.length > 0) {
    const noun = providerFor(envConfig).RESERVED_IP_NAME ?? 'reserved IP';
    if (unreleased.length === 1) reasons.push(`the ${noun} ${unreleased[0]} is not released yet`);
    if (unreleased.length > 1) {
      reasons.push(`the ${noun}s ${joinAddresses(unreleased)} are not released yet`);
    }
    if (unswept.length > 0) {
      reasons.push(`the ${noun}s labelled for ${joinAddresses(unswept)} could not be listed`);
    }
  }
  // The IP reasons above already name every reserved-ip line they come with.
  const named = reasons.length > 0 ? rerunnable.filter((c) => c !== 'reserved-ip') : rerunnable;
  if (named.length > 0) {
    reasons.push(
      `the leak report lists what a re-run can still find and remove (${named.join(', ')})`,
    );
  }
  return { unreleased, unswept, rerunnable, because: reasons.join(', and ') };
}

/**
 * The project-level fields this destroy decided, written whether or not the
 * environment's entry is removed: the retained state-bucket name
 * (retainStateBucket); after a -purge deleted the state bucket, or left it
 * for you to delete by hand, a fresh stateBucketGeneration; and what the app
 * key fence found about destroyed environments' buckets (recordFenceFindings).
 * A kept entry must not lose them: a -purge of the last environment deletes
 * the state bucket whether or not the entry stays, and the next deploy or
 * destroy must then derive a fresh name rather than recreate the deleted one
 * (the same-name recreate that lost acked writes on 2026-08-07); and the
 * fence's findings are about other environments' records, which a kept entry
 * does not change.
 * @param {object} updatedConfig - the file as it is now
 * @param {object} results
 */
function writeProjectLevelFields(updatedConfig, results) {
  if (results.retainedStateBucket) {
    if (results.retainedStateBucket.value === undefined) delete updatedConfig.retainedStateBucket;
    else updatedConfig.retainedStateBucket = results.retainedStateBucket.value;
  }
  // `stateBucketGeneration` rotates ONLY when this destroy's -purge deleted
  // the derived state bucket (the last live environment), or meant to and
  // left it for you to delete by hand (stateBucketAbandoned). The next
  // deploy then derives a FRESH state-bucket name rather than recreating the
  // one just deleted: Hetzner Object Storage can ack writes into a
  // just-recreated same-name bucket and lose them (e4 restore->failover,
  // 2026-08-07). Every other destroy keeps the state bucket (see
  // retainStateBucket), and rotating then would strand the warm bucket.
  //
  // The app bucket name stays stable; it is not rotated here.
  if (results.stateBucketPurged || results.stateBucketAbandoned) {
    updatedConfig.stateBucketGeneration = generateBucketSalt();
  }
  // What the fence found about destroyed environments' buckets: one in no
  // region is marked not found, one read again is cleared, and one found
  // in another region has it written into the record (recordFenceFindings).
  // Never appBucketPurged: that is only for a delete this destroy
  // confirmed, when the entry moves (updateProjectConfigEffect).
  recordFenceFindings(updatedConfig, {
    gone: results.fenceGone ?? [],
    found: results.fenceFound ?? [],
    located: results.fenceLocated ?? [],
  });
}

/**
 * Did this destroy decide any project-level field (writeProjectLevelFields)?
 * A kept entry writes the file only then.
 * @param {object} results
 * @returns {boolean}
 */
function decidedProjectLevelFields(results) {
  return Boolean(
    results.retainedStateBucket ||
      results.stateBucketPurged ||
      results.stateBucketAbandoned ||
      results.fenceGone?.length ||
      results.fenceFound?.length ||
      results.fenceLocated?.length,
  );
}

// 5. Remove the destroyed environment from project config.
async function updateProjectConfigEffect(ctx) {
  const { projectConfig, environment, args, spinner, results } = ctx;
  // Both keep branches below keep the environment's entry, and still write
  // the project-level fields (writeProjectLevelFields): the purge of the
  // last environment runs before this step whether or not the entry stays.
  const writeProjectLevelOnly = () => {
    if (!decidedProjectLevelFields(results)) return;
    updateProjectConfig((updatedConfig) => writeProjectLevelFields(updatedConfig, results));
  };
  // M3 Task 9f fix round 2: keep the environment's config entry when its
  // Pulumi destroy couldn't be verified (recordPulumiDestroyOutcome /
  // destroyK8sTier's catch both set results.pulumiDestroyFailed — the same
  // flag delete-state-bucket's `when` gate reads). Deleting the entry here
  // would drop this env out of `vibecarbon destroy <env>`'s normal target
  // list, so a retry falls through to orphan-stack handling instead — and
  // worse, a SECOND destroy attempt's recordPulumiDestroyOutcome would then
  // see NO recorded infra for this env (envConfig gone) and wave a
  // still-broken destroy through as a quiet "(all via Pulumi)" success,
  // right past the state bucket the round-1 fix just preserved. Never runs
  // for compose tiers — they don't touch Pulumi in destroy.js's sense, so
  // this flag is never set there.
  const kept = entryKeptReason(results, ctx.envConfig);
  if (kept?.unverified) {
    spinner.start('Updating project configuration');
    writeProjectLevelOnly();
    spinner.stop('Configuration kept (Pulumi destroy was not verified; see the leak report)');
    results.leaks.unverified({
      resourceClass: 'project-config',
      resource: `.vibecarbon.json → environments.${environment}`,
      reason:
        "entry KEPT because this environment's Pulumi destroy could not be verified — retrying needs it",
      hint: `Once you've verified/cleaned up any leftover resources, re-run \`${retryDestroyCommand(environment, args)}\`; it will target this environment normally instead of falling through to orphan-stack handling.`,
    });
    return;
  }
  // A reserved IP of ours that the backstop could not prove released
  // (sweepK8sBackstopTargets, sweepTaggedReservedIps) is named nowhere but
  // this entry, a label listing that could not be read is retried only
  // through it, and so is every other line a re-run can still act on
  // (ENTRY_KEEP_BY_CLASS): kept, as above, so the next destroy retries.
  // Each of those lines is in the leak report already; this adds none.
  if (kept) {
    spinner.start('Updating project configuration');
    writeProjectLevelOnly();
    spinner.stop(
      `Configuration kept: ${kept.because}, ` +
        `so the next \`${retryDestroyCommand(environment, args)}\` can retry`,
    );
    return;
  }
  spinner.start('Updating project configuration');
  // One locked write onto the file as it is now: the in-memory projectConfig
  // was loaded when this destroy started, and a failover journal or another
  // environment's record saved since must survive.
  updateProjectConfig((updatedConfig) => {
    writeProjectLevelFields(updatedConfig, results);
    if (updatedConfig.environments) {
      // Keep what the environment WAS (placement, domain, DNS, backup bucket,
      // sizing) under a sibling key `deploy` reads when this name is deployed
      // again — a destroy→deploy move no longer needs a hand-typed block. A
      // sibling key rather than a stub in `environments`: every other command
      // treats presence there as "deployed" (see lib/env-identity.js).
      const identity = envIdentityOf(
        updatedConfig.environments[environment] ?? projectConfig.environments?.[environment],
      );
      if (Object.keys(identity).length > 0) {
        updatedConfig.destroyedEnvironments = {
          ...(updatedConfig.destroyedEnvironments ?? {}),
          [environment]: {
            ...identity,
            // This env's backup folder is gone, so it no longer holds the
            // backup bucket (backupsHoldings), and a rebuild's seed carries
            // no backups record (resolveEnvSeed).
            ...(results.backupsPurged && { backupsPurged: true }),
            // This env's app bucket is deleted, as this destroy's -purge
            // confirmed: nothing left there for the app key fence to guard.
            ...(results.appBucketPurged && { appBucketPurged: true }),
            destroyedAt: new Date().toISOString(),
          },
        };
      }
      delete updatedConfig.environments[environment];
    }
  });
  spinner.stop('Configuration updated');
}

// 6. Local env-file cleanup (idempotent — keys, kubeconfigs, deploy-state).
async function cleanupLocalFilesEffect(ctx) {
  cleanupLocalEnvFiles(ctx.cwd, ctx.environment);
}

// 7. Summary note (k8s only — this step is absent from the compose plans).
async function printSummaryEffect(ctx) {
  const { environment, results } = ctx;
  const deletedCount =
    results.servers.length +
    results.volumes.length +
    results.firewalls.length +
    results.sshKeys.length +
    results.dns.length +
    results.healthChecks.length +
    results.loadBalancers.length +
    (results.s3Bucket ? 1 : 0) +
    (results.github ? 1 : 0);

  p.note(
    `
${c.success('Deleted resources:')}
    Servers:        ${results.servers.length > 0 ? results.servers.join(', ') : 'None'}
    Volumes:        ${results.volumes.length > 0 ? results.volumes.join(', ') : 'None'}
    Firewalls:      ${results.firewalls.length > 0 ? results.firewalls.join(', ') : 'None'}
    SSH Keys:       ${results.sshKeys.length > 0 ? results.sshKeys.join(', ') : 'None'}
    DNS Records:    ${results.dns.length > 0 ? results.dns.join(', ') : 'None'}
    Health Checks:  ${results.healthChecks.length > 0 ? results.healthChecks.join(', ') : 'None'}
    Load Balancers: ${results.loadBalancers.length > 0 ? results.loadBalancers.join(', ') : 'None'}
    S3 Bucket:      ${results.s3Bucket || 'None'}
    GitHub Env:     ${results.github ? environment : 'None'}

${c.dim(`Total: ${deletedCount} resources deleted`)}
  `,
    'Destruction Complete',
  );
}

// 8. Final outro: surfaces left-behind state as issues + sets a non-zero exit
//    code, then prints the closing line.
async function finishOutroEffect(ctx) {
  const { formatted: timeStr } = ctx.tracker.finish();
  destroyOutro(ctx.environment, timeStr, ctx.results);
}

// ============================================================================
// PER-TIER DESTROY STRATEGIES
// ============================================================================

/**
 * DNS records that survived because the ownership filter refused them: they
 * point at an IP this environment never owned (a neighbour scenario on the same
 * root domain, a hand-created record). They ARE surviving records, so they
 * belong in the report — but as `foreign`, not as our leak: preserving them is
 * the ownership gate working exactly as designed, and failing the exit code for
 * a record we are specifically forbidden to delete would make every destroy on
 * a shared zone red.
 *
 * @param {ReturnType<typeof createLeakLedger>} leaks
 * @param {string[]} preservedTargets - the unowned IPs each record pointed at.
 * @param {string} domain
 * @param {string} dnsProviderName
 */
function recordPreservedDnsRecords(leaks, preservedTargets, domain, dnsProviderName) {
  for (const target of preservedTargets ?? []) {
    leaks.foreign({
      resourceClass: 'dns-record',
      resource: `${domain} → ${target} (${dnsProviderName})`,
      reason: 'preserved by the ownership filter; it points at an IP this environment never owned',
    });
  }
}

/**
 * DNS records whose delete the API refused: each still points at an address
 * this environment no longer uses, so each is our leak, named by record. A
 * 404 never lands here (the backends read it as already gone). A DNS line
 * never keeps the environment's entry (ENTRY_KEEP_BY_CLASS), so the hint is
 * the by-hand delete.
 *
 * @param {ReturnType<typeof createLeakLedger>} leaks
 * @param {Array<{name: string, target: string, reason: string}>} failed
 * @param {string} dnsProviderName
 * @param {string} zoneId
 */
function recordFailedDnsDeletes(leaks, failed, dnsProviderName, zoneId) {
  for (const { name, target, reason } of failed) {
    leaks.leak({
      resourceClass: 'dns-record',
      resource: `${name} → ${target} (${dnsProviderName} zone ${zoneId})`,
      reason: `delete refused: ${reason}`,
      hint: dnsRefusedHint(name, dnsProviderName),
    });
  }
}

/**
 * compose-ha: hand the whole teardown (both nodes, firewalls, DNS) to the
 * compose HA helper. The shared tail handles buckets/config afterwards.
 */
/**
 * Registry-driven DNS teardown shared by the compose and k8s tier destroys
 * (compose/ha.js's destroyComposeHA keeps its own thin copy — importing
 * destroy.js from ha.js would double-register destroy's process-level
 * signal handlers, the same constraint that shaped deleteApexAndWildcard).
 *
 * Ownership-filtered: only records pointing at this env's own IPs are
 * deleted; shared zones (parallel e2e scenarios on one root domain) keep
 * their other tenants' records intact. Also reaps the provider's
 * deploy-created health checks when the backend supports them (Cloudflare
 * today) — before convergence only the k8s tier and compose-ha did this,
 * so cloudflare-DNS compose destroys leaked the `<domain>-health` check.
 *
 * Token resolution is env-first under the same-token rule (native DNS on
 * the matching compute cloud reuses `providerToken`); a missing token is a
 * LEAK-LEDGER entry, never a silent skip.
 *
 * Two provisions for deploys that died BEFORE the end-of-deploy persist
 * (observed live 2026-08-08, d1 vs the DO droplet-creation outage — the
 * warm-up had written placeholder records but destroy had no `dns` block
 * to key on and printed nothing):
 *  - When the nested `dns: { provider, zoneId }` is absent, fall back to
 *    the pre-deploy flat `dnsProvider` binding and DISCOVER the zone by
 *    domain (label-boundary match — bare endsWith would let
 *    `d1.evilappcarbon.dev` reach into the `appcarbon.dev` zone).
 *  - The 0.0.0.0 warm-up sentinel is always ours to reap: it is never a
 *    legitimate serving target, so it joins the ownership filter —
 *    otherwise a pre-provision failure leaves records no server ever
 *    existed to "own".
 *
 * Exported for tests/unit/destroy/dns-cleanup-fallback.test.ts.
 */
export async function cleanupDnsRecords({ envConfig, ownedIps, providerToken, s, results }) {
  const dnsProvider = envConfig.dns?.provider ?? envConfig.dnsProvider;
  if (!hasAutomatedDns(dnsProvider) || !envConfig.domain) return;
  const row = DNS_PROVIDERS[dnsProvider];
  const token = resolveDnsToken(dnsProvider, {
    computeProviderId: providerIdFor(envConfig),
    computeToken: providerToken,
  });
  if (!token) {
    results.leaks.leak({
      resourceClass: 'dns-record',
      resource: `${envConfig.domain} (${row.name})`,
      reason: `no ${row.tokenEnv} available for DNS cleanup`,
      hint: dnsRecordsByHandHint(envConfig.domain, row.name),
    });
    return;
  }

  const dns = await getDnsProvider(dnsProvider);

  let zoneId = envConfig.dns?.zoneId ?? null;
  if (!zoneId) {
    // Pre-persist failure: discover the zone the deploy would have used
    // (label-boundary + most-specific — see findZoneForDomain). Silent
    // return when nothing matches — with no persisted zone AND no
    // discoverable one, there are no records we can even name.
    try {
      const zone = findZoneForDomain(await dns.getZones(token), envConfig.domain);
      zoneId = zone ? String(zone.id) : null;
    } catch {
      zoneId = null;
    }
    if (!zoneId) return;
  }

  // Ownership filter + the warm-up sentinel (see the doc block above).
  const ownedWithSentinel = [...(ownedIps || []), '0.0.0.0'];

  s.start(`Deleting DNS records: ${envConfig.domain}`);
  try {
    const { deletedAny, preservedTargets, failed } = await dns.deleteApexAndWildcard(
      token,
      zoneId,
      envConfig.domain,
      ownedWithSentinel,
    );
    if (deletedAny) results.dns.push(envConfig.domain);
    // A refused delete leaves the record in place: say so first, never
    // "not found" (the backends count it in `failed`, a 404 excluded).
    const outcome = [
      failed.length > 0 &&
        `DNS record delete refused: ${failed.map((f) => `${f.name} (${f.reason})`).join(', ')}`,
      preservedTargets.length > 0 &&
        `DNS records preserved (unowned target(s): ${preservedTargets.join(', ')})`,
    ].filter(Boolean);
    if (outcome.length > 0) s.stop(outcome.join('; '));
    else s.stop(deletedAny ? 'DNS records deleted' : 'DNS records not found');
    recordFailedDnsDeletes(results.leaks, failed, row.name, zoneId);
    recordPreservedDnsRecords(results.leaks, preservedTargets, envConfig.domain, row.name);
  } catch (error) {
    s.stop(`DNS deletion failed: ${error.message}`);
    results.leaks.leak({
      resourceClass: 'dns-record',
      resource: `${envConfig.domain} (${row.name} zone ${zoneId})`,
      reason: `delete failed: ${error.message}`,
      hint: dnsRecordsByHandHint(envConfig.domain, row.name),
    });
  }

  // Provider-specific extra: deploy-created health checks (Cloudflare's
  // setupSimple/setupHA create them; other backends have none).
  if (typeof dns.deleteHealthCheck !== 'function') return;
  const healthCheckNames = [
    ...(envConfig.servers || []).map((server) => `${server.name}-health`),
    `${envConfig.domain}-health`,
  ];
  for (const healthCheckName of healthCheckNames) {
    s.start(`Deleting health check: ${healthCheckName}`);
    try {
      const deleted = await dns.deleteHealthCheck(token, zoneId, healthCheckName);
      if (deleted) results.healthChecks.push(healthCheckName);
      s.stop(deleted ? 'Health check deleted' : 'Health check not found');
    } catch (error) {
      s.stop(`Health check deletion failed: ${error.message}`);
      results.leaks.leak({
        resourceClass: 'health-check',
        resource: `${healthCheckName} (${row.name} zone ${zoneId})`,
        reason: `delete failed: ${error.message}`,
        hint: 'Delete it in the Cloudflare dashboard (Traffic → Health Checks); it keeps probing an address this environment no longer uses.',
      });
    }
  }
}

async function destroyComposeHATier({
  envConfig,
  projectConfig,
  environment,
  args,
  providerToken,
  results,
  tracker,
}) {
  const { destroyComposeHA } = await import('./lib/deploy/compose/ha.js');
  const Provider = providerFor(envConfig);

  const s2 = tracker.spinner();
  s2.start('Destroying Compose HA environment...');
  let handledServerIds = [];
  try {
    // destroyComposeHA runs every delete under Promise.allSettled (both nodes,
    // three firewall names, the shared key, DNS) — deliberately, so one refusal
    // can't strand the rest. It returns the per-resource verdicts of that fan-out
    // instead of dropping them on the floor, so a partial failure can't be
    // reported as a clean destroy.
    const { leaks = [], handledServerIds: handled = [] } =
      (await destroyComposeHA({
        projectName: projectConfig.projectName,
        environment,
        envConfig,
        providerToken,
        onProgress: (msg) => s2.message(msg),
      })) ?? {};
    handledServerIds = handled;
    s2.stop(
      leaks.length > 0
        ? `Compose HA teardown finished with ${leaks.length} unresolved resource(s)`
        : 'Compose HA environment destroyed',
    );
    for (const leak of leaks) {
      results.leaks.leak({
        resourceClass: leak.resourceClass,
        resource: leak.resource,
        reason: leak.reason,
        hint: leak.hint ?? `Delete it via the ${Provider.NAME} console.`,
      });
    }
  } catch (error) {
    s2.stop(`Compose HA destruction failed: ${error.message}`);
    // The helper is the ONLY thing that touches compose-ha's servers,
    // firewalls, SSH key and DNS. If it threw, none of those have a verdict.
    results.leaks.unverified({
      resourceClass: 'compose-ha teardown',
      resource: `${projectConfig.projectName}-${environment}`,
      reason: `teardown threw before completing: ${error.message}, servers/firewalls/SSH key/DNS have no verdict`,
      hint: `Check the ${Provider.NAME} console for surviving servers and firewalls, then re-run \`${retryDestroyCommand(environment, args)}\`.`,
    });
  }

  // Backstop, and the reason this runs even when the helper THREW: the helper
  // deletes by name, and the 2026-08-10 audit found a killed mid-scale run's
  // `-primary-new`/`-standby-new` pair alive after a destroy that reported
  // every listing read in full. resolveHaServers now walks those names too;
  // this sweep is what turns anything either of them still misses into a LEAK
  // or UNVERIFIED line instead of silence.
  if (!providerToken) return;
  const provider = new Provider(providerToken);
  const s3 = tracker.spinner();
  s3.start('Checking for surviving environment servers');
  const { deleted: sweptServers, scanned } = await sweepEnvironmentServers({
    provider,
    leaks: results.leaks,
    projectName: projectConfig.projectName,
    environment,
    args,
    deployMode: 'compose-ha',
    roles: (envConfig.servers || []).map((sv) => sv.role),
    alreadyHandledIds: handledServerIds,
    providerName: Provider.NAME,
    onProgress: (message) => s3.message(message),
  });
  results.servers.push(...sweptServers);
  s3.stop(
    sweptServers.length > 0
      ? `Deleted ${sweptServers.length} surviving server(s): ${sweptServers.join(', ')}`
      : scanned
        ? 'No surviving environment servers'
        : 'Surviving-server check inconclusive (see the leak report)',
  );

  // A flexible IP either side's compose program made before its server
  // (Scaleway, COMPOSE_FLOATING_IP): each side is its own stack
  // (`<env>-primary`, `<env>-standby`, effects/compose-ha.js) and labels its
  // IP with that stack's environment. The servers are deleted by API, which
  // frees only an IP attached to one, and remove-stack-state then drops the
  // stack, the IP's last record; so one a failed or killed deploy left
  // attached to nothing is found here by each side's labels, after the
  // server deletes above.
  if (
    Provider.COMPOSE_FLOATING_IP === true &&
    projectConfig.projectName &&
    typeof provider.deleteReservedIpsByLabels === 'function'
  ) {
    for (const side of ['primary', 'standby']) {
      await sweepTaggedReservedIps({
        provider,
        projectName: projectConfig.projectName,
        stackEnv: `${environment}-${side}`,
        results,
        s: tracker.spinner(),
        environment,
        args,
      });
    }
  }
}

/**
 * compose (single VPS): stop the stack, then reap the VPS, firewall, SSH key
 * and DNS via the Hetzner/Cloudflare APIs directly (no Pulumi teardown).
 */
async function destroyComposeTier({
  plan,
  envConfig,
  projectConfig,
  environment,
  args,
  providerToken,
  results,
  spinner: s,
  cwd,
}) {
  const { ownedIps } = plan;
  // The teardown primitives are provider instance methods (C10a); DNS still
  // takes the raw token. providerToken is guaranteed truthy here (main() exits
  // if the token can't be resolved), so construction never throws.
  // Resolved once per flow — see providerFor() in lib/providers/index.js.
  const Provider = providerFor(envConfig);
  const provider = new Provider(providerToken);
  // Compose single-node: its one server, found through the resolver.
  const composeServer = resolvePrimary(envConfig, { env: environment })?.entry;
  const serverIp = composeServer?.ip;
  const sshKeyPath = sshKeyPathFor(environment, cwd);

  if (serverIp && existsSync(sshKeyPath)) {
    // Stop and remove Docker Compose services
    s.start('Stopping Docker Compose services...');
    try {
      const { destroyCompose } = await import('./lib/deploy/compose/index.js');
      await destroyCompose(serverIp, sshKeyPath, projectConfig.projectName);
      s.stop('Docker Compose services removed');
      results.servers.push(`vps-${serverIp}`);
    } catch (error) {
      // NOT a leak verdict: the VPS this stack runs on is deleted a few lines
      // below, and a deleted server strands nothing. The verdict that matters
      // is that delete's, not this one's.
      s.stop(`Failed to stop services: ${error.message}`);
    }
  }

  // Delete Hetzner VPS if auto-provisioned (has server ID in config)
  const serverId = composeServer?.id;
  // The `name` field in envConfig.servers is a role label ("master") set by
  // the orchestrator, not the Hetzner-assigned hostname. Pulumi's compose
  // program names the server `${projectName}-${environment}`. The
  // orchestrator persists that under `providerServerName`; configs older
  // than that change only have role-style names, so derive the Pulumi name
  // as a deterministic fallback — looking up "master" in Hetzner never
  // matches and leaks the VPS.
  const providerServerName =
    composeServer?.providerServerName || `${projectConfig.projectName}-${environment}`;
  if (serverId && providerToken) {
    s.start(`Deleting VPS (${serverIp})...`);
    try {
      const deleted = await provider.deleteServer(serverId, {
        waitUntilGone: true,
        onLeftover: (line) => results.leaks.leak(line),
      });
      s.stop(deleted ? 'VPS deleted' : 'VPS not found');
    } catch (error) {
      // THE 2026-07-22 INCIDENT, exactly here: the throw was swallowed, the
      // spinner printed one red line, and destroy went on to exit 0 with the
      // server still running.
      s.stop(`Failed to delete VPS: ${error.message}`);
      results.leaks.leak({
        resourceClass: 'server',
        resource: describeResource({ name: providerServerName, id: serverId }),
        reason: `delete failed: ${error.message}`,
        hint: `Delete it via the ${Provider.NAME} console, because it keeps billing and its name blocks the next deploy.`,
      });
    }
  } else if (!serverId && providerToken && providerServerName) {
    // Fallback: find server by name if ID wasn't saved (older deploys
    // or runs where Pulumi didn't propagate serverId). Exact-name server
    // filter (B0-3) — also immune to >50-server list truncation.
    s.start(`Looking up VPS by name: ${providerServerName}...`);
    try {
      const [server] = await provider.findServersByName(providerServerName);
      if (server) {
        const deleted = await provider.deleteServer(server.id, {
          waitUntilGone: true,
          onLeftover: (line) => results.leaks.leak(line),
        });
        s.stop(deleted ? 'VPS deleted' : 'VPS not found');
      } else {
        s.stop('VPS not found');
      }
    } catch (error) {
      s.stop(`Failed to delete VPS: ${error.message}`);
      // Covers both halves: the lookup itself failing (we don't know whether a
      // server exists) and the delete failing (we know one does).
      results.leaks.unverified({
        resourceClass: 'server',
        resource: describeResource({ name: providerServerName }),
        reason: `lookup/delete by name failed: ${error.message}`,
        hint: `Check the ${Provider.NAME} console for a server named ${providerServerName}; it keeps billing, and its name blocks the next deploy.`,
      });
    }
  }

  // Backstop: account for every server this environment still has standing.
  // The two paths above look up ONE name; `scale` can leave a second server
  // behind under its temporary `-new` name, outside Pulumi state, which no
  // by-name lookup here was ever asked for (see lib/destroy/server-sweep.js).
  // Runs BEFORE the firewall delete so a straggler isn't holding it attached.
  if (providerToken) {
    s.start('Checking for surviving environment servers');
    const { deleted: sweptServers, scanned } = await sweepEnvironmentServers({
      provider,
      leaks: results.leaks,
      projectName: projectConfig.projectName,
      environment,
      args,
      deployMode: envConfig.deployMode,
      roles: (envConfig.servers || []).map((sv) => sv.role),
      alreadyHandledIds: (envConfig.servers || []).map((sv) => sv.id).filter(Boolean),
      providerName: Provider.NAME,
      onProgress: (message) => s.message(message),
    });
    results.servers.push(...sweptServers);
    s.stop(
      sweptServers.length > 0
        ? `Deleted ${sweptServers.length} surviving server(s): ${sweptServers.join(', ')}`
        : scanned
          ? 'No surviving environment servers'
          : 'Surviving-server check inconclusive (see the leak report)',
    );
  }

  // A flexible IP the compose program made before its server (Scaleway,
  // COMPOSE_FLOATING_IP): deleteServer above frees only an IP attached to the
  // server, so one a deploy killed in between left attached to nothing is
  // found by the environment's labels.
  if (
    providerToken &&
    Provider.COMPOSE_FLOATING_IP === true &&
    projectConfig.projectName &&
    typeof provider.deleteReservedIpsByLabels === 'function'
  ) {
    await sweepTaggedReservedIps({
      provider,
      projectName: projectConfig.projectName,
      stackEnv: environment,
      results,
      s,
      environment,
      args,
    });
  }

  // Delete Hetzner firewall.
  // Pulumi (src/lib/iac/programs/hetzner-compose.js) names the firewall
  //   `${projectName}-${environment}-firewall`
  // Earlier this used `vibecarbon-${projectName}-${envName}` which never
  // matched anything Pulumi created — the firewall always leaked, and
  // the next compose restore re-deploy hit "name is already used
  // (uniqueness_error)" on Pulumi up. Match the actual Pulumi naming
  // convention (the equivalent fix exists in destroyComposeHA).
  const fwName = `${projectConfig.projectName}-${environment}-firewall`;
  if (providerToken) {
    s.start(`Deleting firewall: ${fwName}`);
    try {
      const result = await provider.deleteFirewallByName(fwName);
      if (result.deleted) {
        results.firewalls.push(fwName);
        s.stop('Firewall deleted');
      } else if (result.apiError) {
        // Delete never confirmed within budget (persistent API error or a
        // firewall that stayed attached) — a probable LEAK, not a not-found.
        // A leaked firewall fails the NEXT deploy with uniqueness_error, so
        // surface it instead of the misleading "not found".
        s.stop(`Failed to delete firewall: ${result.apiError.message}`);
        results.leaks.leak({
          resourceClass: 'firewall',
          resource: fwName,
          reason: `delete did not complete: ${result.apiError.message}`,
          hint: `Delete it via the ${Provider.NAME} console, because a leaked firewall makes the next deploy fail with a name-already-in-use error.`,
        });
      } else {
        s.stop('Firewall not found');
      }
    } catch (error) {
      s.stop(`Failed to delete firewall: ${error.message}`);
      results.leaks.leak({
        resourceClass: 'firewall',
        resource: fwName,
        reason: `delete threw: ${error.message}`,
        hint: `Delete it via the ${Provider.NAME} console, because a leaked firewall makes the next deploy fail with a name-already-in-use error.`,
      });
    }
  }

  // Delete Hetzner SSH key.
  // Pulumi names the key
  //   `${projectName}-${environment}-${location}-key`
  // — the location suffix is what kept the old `vibecarbon-` prefix from
  // ever matching. Same root cause as the firewall above.
  const composeRegion = envConfig.region || composeServer?.region;
  const hetznerSshKeyName = composeRegion
    ? `${projectConfig.projectName}-${environment}-${composeRegion}-key`
    : null;
  if (providerToken && hetznerSshKeyName) {
    s.start(`Deleting SSH key: ${hetznerSshKeyName}`);
    try {
      const deleted = await provider.deleteSSHKeyByName(hetznerSshKeyName);
      if (deleted) results.sshKeys.push(hetznerSshKeyName);
      s.stop(deleted ? 'SSH key deleted' : 'SSH key not found');
    } catch (error) {
      s.stop(`Failed to delete SSH key: ${error.message}`);
      results.leaks.leak({
        resourceClass: 'ssh-key',
        resource: hetznerSshKeyName,
        reason: `delete failed: ${error.message}`,
        hint: `Delete it via the ${Provider.NAME} console, because a leaked key blocks the next deploy's key registration by name.`,
      });
    }
  }

  // DNS cleanup is ownership-filtered (plan.ownedIps): only records pointing at
  // this env's server IPs are deleted. Shared zones (e.g. parallel e2e
  // scenarios on the same root domain) used to lose neighbours' records here.
  await cleanupDnsRecords({ envConfig, ownedIps, providerToken, s, results });
}

/**
 * Leak-report class for a Pulumi resource type left in a stack's state.
 * Unknown types report under their own Pulumi type token, so a new resource
 * class still shows up by name instead of disappearing.
 */
const PULUMI_TYPE_RESOURCE_CLASS = [
  [/\/(droplet:Droplet|server:Server)$/, 'server'],
  [/\/firewall:Firewall$/, 'firewall'],
  [/\/(vpc:Vpc|network:Network|networkSubnet:NetworkSubnet)$/, 'network'],
  [/\/(reservedIp|reservedIpAssignment|floatingIp|floatingIpAssignment):\w+$/, 'floating-ip'],
  [/\/sshKey:SshKey$/, 'ssh-key'],
  [/\/volume:Volume$/, 'volume'],
];

function pulumiResourceClass(type) {
  for (const [re, cls] of PULUMI_TYPE_RESOURCE_CLASS) if (re.test(type)) return cls;
  return String(type).split(':').pop() || 'pulumi-resource';
}

/**
 * Record a failed `pulumi destroy` (destroyStack's thrown error) in the leak
 * ledger so the report names what is left. destroyStack reads the stack's
 * state back after the failure and attaches it as `remainingResources`: one
 * UNVERIFIED line per resource, each carrying its own Pulumi diagnostic (or
 * saying it has none) and the command that finishes the teardown. When the state could not be read
 * back, the whole stack is the unit, as before.
 *
 * UNVERIFIED, not LEAK: the DO name/address backstop that runs after this
 * may still delete some of them, but the Pulumi state keeps listing them
 * until a destroy completes against it, and only that re-run proves it.
 *
 * Exported for unit testing (destroyK8sTier itself is not).
 *
 * @param {object} params
 * @param {Error & { remainingResources?: Array<{type: string, logicalName: string, name: string|null, id: string|null}>|null }} params.error
 * @param {string} params.stackEnv
 * @param {string} params.dirLabel - HA's " (stackEnv)" suffix, or '' for single k8s.
 * @param {string} params.environment - the user-facing environment name.
 * @param {{purgeBackups?: boolean}} [params.args] - this destroy's flags, for
 *   the default finish command (retryDestroyCommand).
 * @param {string} [params.finishCommand] - the command that finishes the
 *   teardown; defaults to retryDestroyCommand(environment, args).
 * @param {object} params.results - the shared destroy `results` accumulator (mutated).
 * @param {string} params.providerName - `Provider.NAME`, for the hint.
 */
export function recordPulumiDestroyFailure({
  error,
  stackEnv,
  dirLabel,
  environment,
  args,
  finishCommand,
  results,
  providerName,
}) {
  results.pulumiDestroyFailed = true;
  const finish = finishCommand ?? retryDestroyCommand(environment, args);
  const hint = `Run \`${finish}\` again to finish; it refreshes the stack and deletes what is left. If it fails the same way, delete it in the ${providerName} console, then run it once more.`;
  const remaining = Array.isArray(error?.remainingResources) ? error.remainingResources : null;
  if (remaining && remaining.length > 0) {
    for (const r of remaining) {
      results.leaks.unverified({
        resourceClass: pulumiResourceClass(r.type),
        resource: describeResource({ name: r.name || r.logicalName, id: r.id }),
        reason: r.error
          ? `still in Pulumi stack ${stackEnv}, its delete failed: ${r.error}`
          : `still in Pulumi stack ${stackEnv}, no error of its own: it waits on a resource that failed, or was never attempted`,
        hint,
      });
    }
    // Every line above is honest about its own resource; when none of them
    // carries the cause, it is stated once, here, rather than on each.
    if (!remaining.some((r) => r.error)) {
      results.leaks.unverified({
        resourceClass: 'pulumi-stack',
        resource: `${stackEnv}${dirLabel}`,
        reason: error.message,
        hint,
      });
    }
    return;
  }
  results.leaks.unverified({
    resourceClass: 'pulumi-stack',
    resource: `${stackEnv}${dirLabel}`,
    reason: `pulumi destroy failed: ${error?.message}, every Pulumi-managed resource in this stack (servers, firewall, network, SSH key, floating IP) is unverified`,
    hint: `Check for leftover resources in the ${providerName} console, then run \`${finish}\` again to finish. Pulumi state was preserved for this stack.`,
  });
}

/**
 * Why this project's passphrase cannot open a stack's state, as a short
 * clause. A StatePassphraseError (refused before Pulumi ran) anywhere in the
 * cause chain names its own reason; anything else is Pulumi refusing the
 * passphrase it was given.
 * @param {unknown} error
 * @returns {string}
 */
export function unreadableStateReason(error) {
  switch (findStatePassphraseError(error)?.reason) {
    case 'missing':
      return `${STATE_PASSPHRASE_KEY} isn't set`;
    case 'mismatch':
      return `your ${STATE_PASSPHRASE_KEY} doesn't match the fingerprint in .vibecarbon.json`;
    case 'invalid':
      return `your ${STATE_PASSPHRASE_KEY} is too weak to be this project's`;
    default:
      return "this project's passphrase doesn't decrypt it";
  }
}

/**
 * What to do about a passphrase refused before Pulumi ran
 * (StatePassphraseError), per reason and per store the value came from: a
 * shell value wins over .env.local, so fixing the file alone changes
 * nothing. Ends with the way out when the right value is gone for good.
 *
 * Exported for unit testing.
 *
 * @param {{ reason?: string, source?: string }} error
 * @param {string} environment
 * @returns {string}
 */
export function passphraseRecoveryHint(error, environment) {
  const again = `run \`vibecarbon destroy ${environment}\` again`;
  const then = `then ${again}: Pulumi then removes whatever is left of this stack`;
  const inShell = error?.source === 'shell';
  const entry = 'the `stateEncryption` entry from .vibecarbon.json';
  // What to clear when the right value is gone for good. A value still in
  // the shell would be adopted as this project's passphrase by the next run
  // (and lives nowhere else), and a weak one is refused whatever is recorded,
  // so those go too, from where they live.
  const unsetShell = `unset ${STATE_PASSPHRASE_KEY} in your shell and delete ${entry}`;
  let fix;
  let lost = `delete ${entry}`;
  if (error?.reason === 'mismatch') {
    fix = inShell
      ? `The ${STATE_PASSPHRASE_KEY} in your shell environment wins over .env.local and isn't this project's. Unset it so vibecarbon reads .env.local, or set it to this project's value, ${then}.`
      : `The ${STATE_PASSPHRASE_KEY} in .env.local isn't this project's. Replace it with the value you saved for this project, ${then}.`;
    if (inShell) lost = unsetShell;
  } else if (error?.reason === 'invalid') {
    fix = inShell
      ? `The ${STATE_PASSPHRASE_KEY} in your shell environment is too weak to be this project's. Unset it so vibecarbon reads .env.local, or set it to the value you saved for this project, ${then}.`
      : `The ${STATE_PASSPHRASE_KEY} in .env.local is too weak to be this project's. Replace it with the value you saved for this project, ${then}.`;
    lost = inShell
      ? unsetShell
      : `delete the ${STATE_PASSPHRASE_KEY} line from .env.local and ${entry}`;
  } else {
    fix = `Copy this project's ${STATE_PASSPHRASE_KEY} into .env.local from where you saved it, ${then}.`;
  }
  return `${fix} If it's lost for good, ${lost}, then ${again}, and once more if it asks: this state can't be read without the old passphrase, so destroy removes the record.`;
}

/**
 * What to do when Pulumi refused a passphrase this clone made
 * (statePassphraseProvenance): the project's real passphrase most likely
 * exists, just not in this clone, so the record was kept.
 *
 *   - this run made it (ensure found neither a value nor a fingerprint):
 *     deploy's StateUndecryptableError says the same (passphraseMadeThisRunText);
 *   - an earlier run made it, and git's HEAD doesn't record its fingerprint;
 *   - git couldn't say.
 *
 * The way out when the passphrase that wrote the state is gone: in a git
 * checkout, commit .vibecarbon.json so the fingerprint is the project's, then
 * destroy again; outside one, the next run no longer counts as making it,
 * so a plain rerun removes the record. When no commit holds the file at all
 * (`untracked`: .gitignore lists it, or it was never added), the hint says
 * to take it out of .gitignore and commit it: the team relies on it.
 *
 * Exported for unit testing.
 *
 * @param {string} environment
 * @param {import('./lib/state-passphrase.js').StatePassphraseProvenance} provenance
 * @returns {string}
 */
export function passphraseMadeThisRunHint(environment, provenance) {
  const again = `run \`vibecarbon destroy ${environment}\` again`;
  const removes = 'that run removes the record.';
  const teammate = `If a teammate deployed this project, pull the latest .vibecarbon.json and copy their ${STATE_PASSPHRASE_KEY} into .env.local, then ${again}.`;
  if (provenance.thisRun) {
    const commit = provenance.untracked
      ? "take .vibecarbon.json out of .gitignore if it's listed there and commit it"
      : 'commit .vibecarbon.json';
    const lost =
      provenance.head === 'no-git'
        ? `If it's lost for good, ${again} as it is: ${removes}`
        : `If it's lost for good, ${commit}, then ${again}: ${removes}`;
    return `${passphraseMadeThisRunText('this state', again)} ${lost}`;
  }
  if (provenance.head === 'unknown') {
    return (
      `vibecarbon couldn't check with git whether this clone's .vibecarbon.json fingerprint is committed (git said: ${provenance.detail}), so it kept the record: the passphrase that reads it may be a teammate's. ` +
      `${teammate} ` +
      `If the passphrase that wrote this state is lost for good, fix what git reports and commit .vibecarbon.json, then ${again}: ${removes}`
    );
  }
  const lost = `If the passphrase that wrote this state is lost for good, commit .vibecarbon.json, then ${again}: ${removes}`;
  if (provenance.untracked) {
    // No commit holds the file at all, so a commit can never make the
    // fingerprint the project's until the file is tracked.
    return (
      "This clone's .vibecarbon.json isn't in any commit (.gitignore lists it, or it was never added), so the state passphrase fingerprint it records counts as made here, and that passphrase can't read this state. " +
      `${teammate} ` +
      'Your team relies on .vibecarbon.json: if .gitignore lists it, take it out, and commit the file once it records the passphrase your team uses. ' +
      lost
    );
  }
  return (
    "This clone's .vibecarbon.json records a state passphrase fingerprint that isn't committed, so the passphrase was most likely made here, and it can't read this state. " +
    `${teammate} ${lost}`
  );
}

/**
 * Why the record stayed, for a passphrase this clone made.
 * @param {import('./lib/state-passphrase.js').StatePassphraseProvenance} provenance
 */
function madeHereReason(provenance) {
  if (provenance.thisRun) return "the passphrase this run made doesn't decrypt it";
  if (provenance.head === 'unknown') {
    return "this project's passphrase doesn't decrypt it, and git couldn't say whether this clone made it";
  }
  return "the passphrase this clone made, whose fingerprint isn't committed, doesn't decrypt it";
}

/** No sign this clone made the passphrase (the default for a caller that can't tell). */
const NOT_MADE_HERE = Object.freeze({ madeHere: false, thisRun: false, head: 'no-git' });

/**
 * The sentence for a record left alone because the environment's
 * object-storage credentials did not resolve.
 * @param {string} environment
 * @returns {string}
 */
function stateCredentialsHint(environment) {
  return `This environment's object-storage credentials couldn't be resolved, so the record was left where it is; have them available when you run \`vibecarbon destroy ${environment}\` again.`;
}

/**
 * Warn, before the sweeps run, that a k8s stack's state can't be read and
 * what removes its servers instead. The stack itself is settled after the
 * sweeps, by settleUnreadableStacks.
 *
 * Exported for unit testing.
 *
 * @param {{ error: unknown, stackEnv: string, providerName: string, backstop: boolean }} params
 */
export function warnUnreadableStackState({ error, stackEnv, providerName, backstop }) {
  const byName = backstop
    ? ", and the stack's firewall, network, SSH key and reserved IP by name"
    : '';
  p.log.warn(
    `vibecarbon can't read the Pulumi state for ${stackEnv} (${unreadableStateReason(error)}), so Pulumi can't remove that stack. ` +
      `Your servers are still removed through the ${providerName} API${byName}.`,
  );
}

/**
 * Settle the k8s stacks whose Pulumi state this project's passphrase cannot
 * open (isStatePassphraseFailure), once destroyK8sTier's API sweeps have run
 * in place of `pulumi destroy`. A stack's record is removed (`stack rm
 * --force`, which reads nothing) when it holds nothing usable:
 *
 *   (a) Pulumi refused a passphrase that passed vibecarbon's own check: no
 *       value this project has can read that state, so no destroy will ever
 *       reach what it lists. Removed on every provider, so the next deploy
 *       starts clean; what the sweeps could not cover is reported.
 *   (b) Refused before Pulumi ran (a StatePassphraseError anywhere in the
 *       cause chain: missing, mismatched or invalid), or refused by Pulumi
 *       when this clone made the passphrase (statePassphraseProvenance: this
 *       run made it, or, in a git checkout, HEAD doesn't record its
 *       fingerprint, or git can't tell; the real one likely exists in a
 *       teammate's clone). The right value may come back, and the record is
 *       what Pulumi would then destroy. Removed only when a
 *       K8S_DESTROY_BACKSTOP provider's by-name sweeps cover the stack and
 *       the ledger is clean; otherwise kept, with how to get the value back.
 *
 * A kept record keeps the environment entry (`pulumiDestroyFailed`, and its
 * `pulumi-stack` line): it is what a destroy with the right value opens. A
 * removed record keeps nothing itself (its line is `unreadable-stack`, which
 * ENTRY_KEEP_BY_CLASS says a re-run cannot act on); what the sweeps left
 * keeps the entry or not by its own lines' classes, as on any destroy, and a
 * retry that the entry allows re-runs them (it finds no record, which
 * destroyStack answers with `{destroyed: false}`). Leftovers stay in the
 * ledger either way, so the exit code says something was left whenever it was.
 *
 * Exported for unit testing.
 *
 * @param {object} params
 * @param {Array<{ stackEnv: string, dirLabel: string, error: unknown }>} params.stacks
 * @param {string} params.environment - the user-facing environment name.
 * @param {string} params.projectName
 * @param {object} params.results - the shared destroy `results` accumulator (mutated).
 * @param {string} params.providerName - `Provider.NAME`.
 * @param {boolean} params.backstop - the provider's by-name sweeps ran for these stacks.
 * @param {boolean} [params.reservedIpsSwept] - sweepK8sBackstopTargets released
 *   the reserved IPs labelled for these stacks (its label sweep ran).
 * @param {string} [params.reservedIpName] - the provider's word for them
 *   (`RESERVED_IP_NAME`).
 * @param {boolean} params.backendResolved - false when the environment has an S3
 *   backend whose credentials could not be resolved: a removal would reach the
 *   local fallback backend and miss the real stack.
 * @param {import('./lib/state-passphrase.js').StatePassphraseProvenance} [params.passphraseProvenance]
 *   statePassphraseProvenance for the project; absent, nothing says this
 *   clone made it.
 * @param {(stackEnv: string) => Promise<unknown>} params.removeRecord
 * @param {{ start: Function, stop: Function }} params.s
 */
export async function settleUnreadableStacks({
  stacks,
  environment,
  projectName,
  results,
  providerName,
  backstop,
  reservedIpsSwept = false,
  reservedIpName = 'reserved IP',
  backendResolved,
  passphraseProvenance = NOT_MADE_HERE,
  removeRecord,
  s,
}) {
  // Judged once, before any line below is added, so both stacks of a
  // k8s-ha pair are judged against the same sweeps.
  const counts = results.leaks.counts();
  const sweptClean = counts.leak + counts.unverified === 0;
  for (const { stackEnv, dirLabel, error } of stacks) {
    const resource = `${stackEnv}${dirLabel}`;
    const precheck = findStatePassphraseError(error);
    const madeNow = !precheck && passphraseProvenance.madeHere === true;
    const why = madeNow ? madeHereReason(passphraseProvenance) : unreadableStateReason(error);
    if (!backendResolved || ((precheck || madeNow) && !(backstop && sweptClean))) {
      results.pulumiDestroyFailed = true;
      const hints = [];
      if (precheck) hints.push(passphraseRecoveryHint(precheck, environment));
      else if (madeNow) hints.push(passphraseMadeThisRunHint(environment, passphraseProvenance));
      if (!backendResolved) hints.push(stateCredentialsHint(environment));
      results.leaks.unverified({
        resourceClass: 'pulumi-stack',
        resource,
        reason: `its Pulumi state can't be read (${why}), so \`pulumi destroy\` did not run and its stack record was kept; the ${providerName} API sweeps ran in its place`,
        hint: hints.join(' '),
      });
      continue;
    }
    s.start(`Removing the Pulumi stack record for ${stackEnv} without reading it`);
    try {
      await removeRecord(stackEnv);
    } catch (err) {
      s.stop(`Failed to remove the Pulumi stack record for ${stackEnv}: ${err.message}`);
      results.pulumiDestroyFailed = true;
      results.leaks.unverified({
        resourceClass: 'pulumi-stack',
        resource,
        reason: `its Pulumi state can't be read (${why}), and removing its stack record failed: ${err.message}`,
        hint: `Run \`vibecarbon destroy ${environment}\` again: it removes the record without reading it.`,
      });
      continue;
    }
    s.stop(`Pulumi stack record removed: ${stackEnv}`);
    // What the sweeps left keeps the environment entry through its own lines
    // (ENTRY_KEEP_BY_CLASS); this record, gone now, keeps nothing.
    // The label and by-name sweeps cover what this provider's k8s program
    // makes that bills or blocks a redeploy (DigitalOcean's Tag does neither:
    // it is free and creating it again is a no-op, so nothing sweeps it), and
    // they left nothing behind.
    if (backstop && sweptClean) continue;
    // The label sweep released the stack's labelled IPs, and named any it
    // could not; only what no sweep reaches is left to the console.
    const consoleList = reservedIpsSwept
      ? 'firewall, network, SSH key and placement group'
      : `firewall, network, ${reservedIpName}, SSH key and placement group`;
    const swept = reservedIpsSwept
      ? ` Its ${reservedIpName}s labelled for this stack were released, and any that weren't are listed in this report.`
      : '';
    results.leaks.unverified({
      resourceClass: 'unreadable-stack',
      resource,
      reason: `its Pulumi state can't be read (${why}), so \`pulumi destroy\` did not run; its stack record was removed without being read`,
      hint: backstop
        ? `Nothing can reach what that state listed through Pulumi any more. Anything the ${providerName} API sweeps could not remove is listed in this report; delete it in the ${providerName} console.`
        : `Nothing can reach what that state listed through Pulumi any more. Delete the stack's ${consoleList} in the ${providerName} console; their names start with ${projectName}-${stackEnv}.${swept}`,
    });
  }
}

/**
 * Decide what one stackEnv's `destroyK8s` (Pulumi) result means and record
 * it into `results` — either the "(all via Pulumi)" success shorthand, or a
 * loud, non-zero-exit issue (M3 Task 9f fix round 1).
 *
 * Why this needs a caller-side decision at all: `destroyStack`
 * (lib/iac/index.js) can legitimately resolve with `resourceCount: 0` for
 * two very different reasons it has NO way to tell apart on its own —
 * (a) the stack was already destroyed, or never deployed (a genuine
 * idempotent no-op — fine), or (b) `createOrSelectStack` silently created a
 * FRESH, EMPTY stack because it couldn't find the real one (a destroy-time
 * state-backend mismatch — the exact mechanism behind the two live DO
 * incidents this task was opened for), and `destroy` then "succeeded"
 * against nothing. destroyStack's own loud-partial-detection checks (the
 * pre/post-destroy resource-count cross-check, the `summary.result` check)
 * do NOT catch case (b): they compare the stack's OWN before/after state,
 * and a freshly-created wrong stack is legitimately empty on both sides of
 * that comparison — there is nothing internally inconsistent about it.
 * Only the CALLER can tell (a) from (b), because only the caller holds
 * `envConfig`: if this environment has recorded real infrastructure
 * (servers and/or an ingress or floating/reserved IP persisted at deploy time), a
 * resourceCount of 0 is case (b), not (a).
 *
 * Sets `results.pulumiDestroyFailed` on an unverified outcome — the k8s
 * destroy plan's `delete-state-bucket` step (destroy-plan.js) reads that
 * flag and skips itself, because that bucket holds the ONLY evidence a
 * retry (or an operator, by hand) can use to find out what's actually still
 * deployed; deleting it here would destroy the evidence in the same run
 * that failed to verify the destroy.
 *
 * Exported for unit testing — `destroyK8sTier` itself is not, but this is
 * the one piece of it with a decision worth pinning in isolation.
 *
 * @param {object} params
 * @param {{resourceCount?: number}|null|undefined} params.destroyResult - destroyK8s's return value.
 * @param {object} params.envConfig
 * @param {string} params.stackEnv
 * @param {string} params.dirLabel - HA's " (stackEnv)" suffix, or '' for single k8s.
 * @param {string} [params.environment] - the user-facing environment name, for
 *   the retry command; the stack's own name when absent.
 * @param {{purgeBackups?: boolean}} [params.args] - this destroy's flags.
 * @param {object} params.results - the shared destroy `results` accumulator (mutated).
 * @param {string} params.providerName - `Provider.NAME`, for the issue hint.
 * @returns {boolean} true if recorded as a verified success.
 */
export function recordPulumiDestroyOutcome({
  destroyResult,
  envConfig,
  stackEnv,
  dirLabel,
  environment = stackEnv,
  args,
  results,
  providerName,
}) {
  const hasRecordedInfra =
    (envConfig.servers || []).length > 0 ||
    !!envConfig.ingressIp ||
    !!envConfig.ha?.primary?.ingressIp ||
    !!envConfig.ha?.standby?.ingressIp ||
    !!envConfig.floatingIp ||
    !!envConfig.ha?.primary?.floatingIp ||
    !!envConfig.ha?.standby?.floatingIp;

  if (destroyResult?.resourceCount === 0 && hasRecordedInfra) {
    results.pulumiDestroyFailed = true;
    results.leaks.unverified({
      resourceClass: 'pulumi-stack',
      resource: `${stackEnv}${dirLabel}`,
      reason:
        'destroy ran against an EMPTY stack while this environment has recorded infrastructure ' +
        '(servers/floating IP), every Pulumi-managed resource is UNVERIFIED; looks like a ' +
        'state-backend mismatch (the wrong, empty stack was found). Pulumi state was preserved.',
      hint:
        `Verify directly in the ${providerName} console (servers, firewall, VPC/network, ` +
        `SSH key, reserved/floating IP), then re-run \`${retryDestroyCommand(environment, args)}\` ` +
        'to retry against the same Pulumi state.',
    });
    return false;
  }

  results.servers.push('(all via Pulumi)');
  results.firewalls.push('(all via Pulumi)');
  results.sshKeys.push('(all via Pulumi)');
  return true;
}

/**
 * The line naming which DNS-cleanup token destroy will use and where it came
 * from (the project's .env.local or the shell), the same way the provider
 * API token lines do. It used to say "environment variable" for both.
 * Exported for unit testing.
 * @param {{name: string, tokenEnv: string}} dnsRow
 * @returns {string}
 */
export function dnsTokenSourceLine(dnsRow) {
  const { where } = describeCredentialSource([dnsRow.tokenEnv]);
  return `✓ Using ${dnsRow.name} API token (${dnsRow.tokenEnv}) from ${where}`;
}

/**
 * Resolve credentials for the Pulumi state backend, provider-aware — the fix
 * for M3 Task 9g. A raw `process.env.HETZNER_ACCESS_KEY`/`HETZNER_SECRET_KEY` read
 * here (the pre-9g shape) always resolved Hetzner's Object Storage keys
 * regardless of provider. On a DigitalOcean environment those keys 403
 * against the Spaces endpoint recorded in `s3Fields` — pre-Task-9f that 403
 * was laundered into `createOrSelectStack` silently creating a fresh, empty
 * stack and a fake destroy success (the confirmed trigger for both earlier
 * orphan incidents); with Task 9f's loud partial detection in place it now
 * fails hard at `pulumi stack select` instead (the live d3 run 5 failure
 * that surfaced this bug).
 *
 * Reuses the SAME resolver the working bucket-deletion effects use
 * (`Provider.promptObjectStorageCredentials` — see deleteAppBucketEffect /
 * handleBackupBucket above): Hetzner reads
 * HETZNER_ACCESS_KEY/HETZNER_SECRET_KEY, DigitalOcean reads DIGITALOCEAN_ACCESS_KEY/
 * DIGITALOCEAN_SECRET_KEY (see hetzner-guided-setup.js's /
 * digitalocean-guided-setup.js's getS3Credentials). `save: false` — a
 * destroy path never writes credentials back to .env.local.
 *
 * TTY-gated (M3 Task 9g fix round 1): off a TTY, missing env credentials
 * must NEVER reach the interactive prompt. clack's prompt primitives attach
 * to stdin with no isTTY check and no stdin-close handling of their own (see
 * lib/cli/tty-guard.js's doc comment — the same reason that guard exists),
 * so on non-TTY stdin with no data the prompt promise never resolves. This
 * is live-reachable: the e2e harness's teardown runs `destroy <env> -y
 * -orphans` with stdio `['ignore', 'pipe', 'pipe']` specifically to clean up
 * deploys that failed before creds were fully persisted — exactly the
 * config-recorded-but-creds-absent window this function's null-credentials
 * branch exists for. We pass `skipPrompts: !stdin.isTTY` through to
 * `getS3Credentials`, which short-circuits to `null` instead of prompting
 * when set. On a real TTY the prompt still fires (sibling-effect parity with
 * deleteAppBucketEffect / handleBackupBucket).
 *
 * Returns null when `s3Fields` is missing, when off-TTY credentials aren't
 * in the environment, or when an interactive resolution comes back empty.
 * Callers pass that straight through as `s3Config` to
 * `destroyK8s`/`destroyOrphanPulumiStack`: a null/undefined s3Config makes
 * `resolveBackendUrl` (lib/iac/index.js) fall back to the local file://
 * backend, `destroyStack` then runs against a fresh empty stack, and — for
 * the tracked-environment call site — `recordPulumiDestroyOutcome` flags
 * that loudly whenever the environment has recorded infrastructure. This
 * function does not paper over that outcome; it only declines to resolve.
 *
 * Exported for unit testing (M3 Task 9g) — pinned directly here, and the
 * orphan-stack path is additionally exercised end-to-end through the real
 * `run()` entry point in tests/unit/destroy/orphan-gate.test.ts.
 *
 * @param {typeof import('./lib/providers/base.js').BaseProvider} Provider - resolved via providerFor(envConfig) / providerFor(projectConfig).
 * @param {string} projectName
 * @param {{bucket?: string, region?: string, endpoint?: string, stateBucket?: string}|null|undefined} s3Fields - base backend fields (no credentials); falsy short-circuits to null without prompting.
 * @param {{stdin?: {isTTY?: boolean}}} [options] - `stdin` is injectable for testing (mirrors tty-guard.js's pattern); defaults to `process.stdin`.
 * @returns {Promise<({bucket?: string, region?: string, endpoint?: string, stateBucket?: string, accessKey: string, secretKey: string})|null>}
 */
export async function resolveDestroyS3Config(Provider, projectName, s3Fields, options = {}) {
  if (!s3Fields) return null;
  const { stdin = process.stdin } = options;
  const creds = await Provider.promptObjectStorageCredentials(projectName, {
    save: false,
    skipPrompts: !stdin.isTTY,
  });
  if (!creds) return null;
  return { ...s3Fields, accessKey: creds.accessKey, secretKey: creds.secretKey };
}

/**
 * The k8s backstop's per-stack target list. Exported for unit testing.
 *
 * One entry per Pulumi stack (single k8s: the environment itself; k8s-ha:
 * `<env>-primary` + `<env>-standby`), carrying the literal resource names the
 * DO and Linode k8s programs create for that stack (digitalocean-k8s.js:
 * `${clusterName}-firewall` / `${clusterName}-network` /
 * `${clusterName}-${region}-key`) plus the reserved-IP addresses recorded for
 * that stack. Deriving these from the USER-FACING environment instead (the
 * pre-d4 shape) named a cluster that never existed on k8s-ha — both real
 * per-stack firewalls/VPCs and BOTH reserved IPs leaked every HA destroy.
 *
 * - `reservedIps` are recorded floating/reserved IPs only (`floatingIp`,
 *   never `ingressIp`), so the backstop never releases a master's own
 *   address. A DigitalOcean cluster made since 2026-11 has none
 *   (K8S_FLOATING_IP false; its domain points at the master); one made before
 *   still has its reserved IP recorded until a deploy releases it
 *   (lib/deploy/k8s/retired-reserved-ip.js), and this releases it if that
 *   deploy never ran or its release failed.
 * - `sshKeyName` is null on HA: both clusters share one key created OUTSIDE
 *   Pulumi (`${project}-${env}-ha-key`), swept by its own block.
 * - A k8s-ha side's address follows the STACK identity: failover swaps roles
 *   under `envConfig.ha.{primary,standby}.stack`, so match by `.stack` first
 *   and fall back to the role suffix for pre-swap configs that never
 *   persisted it.
 * - On k8s-ha an environment-level `floatingIp` is read too, as either
 *   side's, the way the deploy's release reads it (retiredReservedIpStacks):
 *   the address is any stack's that may hold it (`stacks`, its owner check
 *   accepts each), and it is released once, by the first.
 *
 * @param {{plan: {tier: string, stackEnvs: string[]}, envConfig: object, projectConfig: {projectName: string}}} args
 * @returns {Array<{stackEnv: string, firewallName: string, sshKeyName: string|null, reservedIps: Array<{address: string, stacks: string[]}>, networkName: string}>}
 */
export function planK8sBackstopTargets({ plan, envConfig, projectConfig }) {
  const isHA = isHATier(plan.tier);
  const haEntries = [envConfig.ha?.primary, envConfig.ha?.standby].filter(Boolean);
  /** address -> the stacks it may be, the first the one that releases it */
  const stacksOf = new Map();
  const add = (address, stackEnv) => {
    if (!address) return;
    const stacks = stacksOf.get(address) ?? [];
    if (!stacks.includes(stackEnv)) stacks.push(stackEnv);
    stacksOf.set(address, stacks);
  };
  for (const stackEnv of plan.stackEnvs) {
    if (!isHA) {
      add(envConfig.floatingIp, stackEnv);
      continue;
    }
    const byStack = haEntries.find((e) => e.stack === stackEnv);
    const byRoleSuffix = stackEnv.endsWith('-primary')
      ? envConfig.ha?.primary
      : stackEnv.endsWith('-standby')
        ? envConfig.ha?.standby
        : null;
    add(byStack?.floatingIp ?? byRoleSuffix?.floatingIp, stackEnv);
  }
  if (isHA && envConfig.floatingIp && !stacksOf.has(envConfig.floatingIp)) {
    for (const stackEnv of plan.stackEnvs) add(envConfig.floatingIp, stackEnv);
  }
  return plan.stackEnvs.map((stackEnv) => {
    const clusterName = `${projectConfig.projectName}-${stackEnv}`;
    return {
      stackEnv,
      firewallName: `${clusterName}-firewall`,
      sshKeyName: !isHA && envConfig.region ? `${clusterName}-${envConfig.region}-key` : null,
      reservedIps: [...stacksOf]
        .filter(([, stacks]) => stacks[0] === stackEnv)
        .map(([address, stacks]) => ({ address, stacks })),
      networkName: `${clusterName}-network`,
    };
  });
}

/**
 * Whether the reserved IP at an address saved at deploy time is still this
 * cluster's. Linode reissues a released address within minutes, so by
 * destroy time the saved address can be another project's. A provider whose
 * reserved IPs carry tags (Linode: `reservedIpLabelMatch`) is asked, and only
 * an IP carrying this project's tags and those of one of `stackEnvs` (the
 * labels the k8s program stamps) counts as ours. One of ours that is still
 * assigned (to a Linode, or any entity) is `held`: this runs after the
 * teardown, so whatever holds it is something the teardown did not delete,
 * and an address is never taken off a running server.
 *
 * DigitalOcean reserved IPs carry no tags, so DO is asked where the address
 * is assigned (`reservedIpAssignment`). This runs after the teardown, so
 * this cluster's droplets are deleted: an unassigned address is ours, one
 * assigned to a droplet that carries neither this project's tags nor those
 * of one of `stackEnvs` was reissued and is someone else's (`assigned`), and
 * one still assigned to a droplet that does carry them is ours, held by a
 * droplet the teardown did not delete (`held`). Neither assigned verdict is
 * ever deleted.
 *
 * @param {object} provider
 * @param {string} address
 * @param {string|undefined} projectName
 * @param {string[]} stackEnvs - the stacks the address may be (two for a k8s-ha environment-level one)
 * @returns {Promise<{verdict: 'ours'} | {verdict: 'released'} | {verdict: 'foreign', tags: string[]}
 *   | {verdict: 'assigned', droplet: {id: number, name: string}} | {verdict: 'held', holder: string}>}
 *   `holder` names what still holds an address of ours, as a phrase
 * @throws when the address cannot be read, or there is no project name to check tags against
 */
async function savedReservedIpOwner(provider, address, projectName, stackEnvs) {
  const labelsFor = (stackEnv) =>
    projectName ? { project: projectName, environment: stackEnv } : {};
  if (typeof provider.reservedIpAssignment === 'function') {
    let droplet = null;
    for (const stackEnv of stackEnvs) {
      const read = await provider.reservedIpAssignment(address, labelsFor(stackEnv));
      if (!read.found) return { verdict: 'released' };
      if (!read.droplet) return { verdict: 'ours' };
      if (!projectName) {
        throw new Error(
          `it is assigned to droplet ${read.droplet.name}, and there is no project name to check its tags against`,
        );
      }
      if (read.matches) {
        return {
          verdict: 'held',
          holder: `this cluster's droplet ${read.droplet.name} (${read.droplet.id})`,
        };
      }
      droplet = read.droplet;
    }
    return { verdict: 'assigned', droplet };
  }
  if (typeof provider.reservedIpLabelMatch !== 'function') return { verdict: 'ours' };
  if (!projectName) throw new Error('no project name to check its tags against');
  let tags = [];
  for (const stackEnv of stackEnvs) {
    const match = await provider.reservedIpLabelMatch(address, labelsFor(stackEnv));
    if (!match.found) return { verdict: 'released' };
    if (match.matches) {
      return match.holder ? { verdict: 'held', holder: match.holder } : { verdict: 'ours' };
    }
    tags = match.tags;
  }
  return { verdict: 'foreign', tags };
}

/**
 * Keep an address of ours that is not proven released on record:
 * updateProjectConfigEffect keeps the environment's entry while any is
 * listed, so the next destroy retries it. Tolerates a results object built
 * without the list, as updateProjectConfigEffect does.
 * @param {{unreleasedReservedIps?: string[]}} results
 * @param {string} address
 */
function keepUnreleased(results, address) {
  results.unreleasedReservedIps ??= [];
  results.unreleasedReservedIps.push(address);
}

/**
 * The retry line every reserved IP of ours that is not released carries.
 * @param {string} environment - as the operator names it
 * @param {{purgeBackups?: boolean} | undefined} args - this destroy's flags
 * @param {{NAME: string, RESERVED_IP_NAME?: string}} Provider
 */
function reservedIpRetryHint(environment, args, Provider) {
  const noun = Provider.RESERVED_IP_NAME ?? 'reserved IP';
  return (
    `Run \`${retryDestroyCommand(environment, args)}\` again to retry it: the environment ` +
    'stays in .vibecarbon.json until it is released. Or release it in the ' +
    `${Provider.NAME} console, where it is listed with your ${noun}s.`
  );
}

/**
 * Release one reserved IP the environment's record names (the address
 * path). Every provider is asked first whether the saved address is still
 * this cluster's (savedReservedIpOwner): Linode by the IP's own tags, and
 * DigitalOcean by the droplet it is assigned to. An assigned address is never
 * deleted. An address of ours that is not proven released keeps the
 * environment's record (keepUnreleased): the record is the only place it is
 * named, so the next destroy retries it.
 *
 * @param {{provider: object, address: string, stacks: string[], projectName?: string, results: object, s: {start: Function, stop: Function}, retry: string}} args
 */
async function releaseRecordedReservedIp({
  provider,
  address,
  stacks,
  projectName,
  results,
  s,
  retry,
}) {
  const Provider = provider.constructor;
  const stackNames = stacks.join(' or ');
  s.start(`Verifying ${Provider.NAME} reserved IP is gone: ${address}`);
  try {
    const owner = await savedReservedIpOwner(provider, address, projectName, stacks);
    if (owner.verdict === 'released') {
      s.stop('Reserved IP already released');
    } else if (owner.verdict === 'foreign') {
      s.stop(`Reserved IP ${address} left alone: it is no longer this cluster's`);
      results.leaks.foreign({
        resourceClass: 'reserved-ip',
        resource: address,
        reason:
          `not released: it carries ${owner.tags.length ? owner.tags.join(', ') : 'no tags'}, ` +
          `not project ${projectName} and stack ${stackNames}, so the address was likely reissued`,
        hint: `If it is this cluster's after all, release it in the ${Provider.NAME} console under reserved IPs.`,
      });
    } else if (owner.verdict === 'assigned') {
      // This cluster's droplets are deleted by now, so a droplet holding
      // the address is someone else's: never delete it out from under it.
      const droplet = `${owner.droplet.name} (${owner.droplet.id})`;
      s.stop(`Reserved IP ${address} left alone: it is assigned to droplet ${droplet}`);
      results.leaks.foreign({
        resourceClass: 'reserved-ip',
        resource: address,
        reason:
          `not released: it is assigned to droplet ${droplet}, which is not project ` +
          `${projectName} and stack ${stackNames}'s, so the address was likely reissued`,
        hint: `If it is this cluster's after all, release it in the ${Provider.NAME} console under reserved IPs.`,
      });
    } else if (owner.verdict === 'held') {
      // Ours, and still assigned to something the teardown did not delete
      // (its own line above says so). It stays on record, but is never
      // deleted out from under a running server.
      s.stop(`Reserved IP ${address} left alone: ${owner.holder} still holds it`);
      keepUnreleased(results, address);
      results.leaks.leak({
        resourceClass: 'reserved-ip',
        resource: address,
        reason: `not released: it is still assigned to ${owner.holder}, which was not deleted`,
        hint: retry,
      });
    } else {
      const outcome = await provider.deleteReservedIpByAddress(address);
      if (outcome.released) {
        s.stop('Reserved IP released (backstop)');
      } else {
        s.stop(`Reserved IP ${address} is not released: ${outcome.reason}`);
        keepUnreleased(results, address);
        const entry = {
          resourceClass: 'reserved-ip',
          resource: describeResource({ name: address, region: outcome.region }),
          hint: retry,
        };
        if (outcome.held) {
          results.leaks.leak({
            ...entry,
            reason: `${outcome.reason}, so it is not released and keeps billing on your ${Provider.NAME} account`,
          });
        } else {
          results.leaks.unverified({
            ...entry,
            reason: `${outcome.reason}, so vibecarbon cannot tell whether ${Provider.NAME} released it; if not, it keeps billing`,
          });
        }
      }
    }
  } catch (error) {
    s.stop(`Reserved IP backstop check failed: ${error.message}`);
    keepUnreleased(results, address);
    results.leaks.unverified({
      resourceClass: 'reserved-ip',
      resource: address,
      reason: `backstop check threw: ${error.message}, could not confirm it is released; if it is not, it keeps billing`,
      hint: retry,
    });
  }
}

/**
 * Release every floating or reserved IP the provider still holds with this
 * project's and this stack's labels (`deleteReservedIpsByLabels`), the
 * labels the provider's Pulumi programs stamp on it. It is how destroy finds
 * one no record names: a deploy killed while Pulumi was creating the IP
 * leaves it out of the stack's state (the pre-destroy refresh drops a
 * pending create) and out of .vibecarbon.json, and it bills until released.
 *
 * Scoped to exactly this project and this stack, never the project alone:
 * another environment's IP, or another project's, is never touched.
 * `except` names addresses the record already names, which the address path
 * (releaseRecordedReservedIp) handles. One found here that is not released is
 * kept on record like any other of ours, so the next destroy retries it.
 * Exported for unit testing.
 *
 * @param {{provider: object, projectName: string, stackEnv: string, except?: string[], results: object, s: {start: Function, stop: Function}, environment: string, args?: {purgeBackups?: boolean}}} params
 *   `stackEnv`: the stack's environment label (k8s-ha: `<env>-primary` or
 *   `<env>-standby`; compose and single k8s: the environment).
 *   `environment`: as the operator names it, and `args`, this destroy's
 *   flags, for the retry line (retryDestroyCommand).
 */
export async function sweepTaggedReservedIps({
  provider,
  projectName,
  stackEnv,
  except = [],
  results,
  s,
  environment,
  args,
}) {
  const Provider = provider.constructor;
  const noun = Provider.RESERVED_IP_NAME ?? 'reserved IP';
  const scope = `project ${projectName}, environment ${stackEnv}`;
  s.start(`Looking for ${Provider.NAME} ${noun}s labelled ${scope}`);
  try {
    const swept = await provider.deleteReservedIpsByLabels(
      { project: projectName, environment: stackEnv },
      { except },
    );
    s.stop(
      swept.deleted.length > 0
        ? `Released by label (backstop): ${swept.deleted.join(', ')}`
        : swept.failed.length > 0
          ? `Found by label and not released: ${swept.failed.map((f) => f.address).join(', ')}`
          : `No ${noun} labelled ${scope} left`,
    );
    for (const failure of swept.failed) {
      keepUnreleased(results, failure.address);
      const entry = {
        resourceClass: 'reserved-ip',
        resource: failure.address,
        hint: failure.serverTerminating
          ? `Run \`${retryDestroyCommand(environment, args)}\` again once the server is gone: the ` +
            'environment stays in .vibecarbon.json, and that destroy releases it. Or release it ' +
            `in the ${Provider.NAME} console after the server is deleted.`
          : reservedIpRetryHint(environment, args, Provider),
      };
      if (failure.held) {
        results.leaks.leak({
          ...entry,
          reason: `${noun} labelled ${scope} not released: ${failure.reason}, so it keeps billing on your ${Provider.NAME} account`,
        });
      } else {
        results.leaks.unverified({
          ...entry,
          reason: `${noun} labelled ${scope}: ${failure.reason}, so vibecarbon cannot tell whether ${Provider.NAME} released it; if not, it keeps billing`,
        });
      }
    }
  } catch (error) {
    s.stop(`${noun} label check failed: ${error.message}`);
    // Kept on record by stack (entryKeptReason): the entry is the only way
    // the next `vibecarbon destroy` can run this sweep again.
    results.unsweptReservedIpScopes ??= [];
    results.unsweptReservedIpScopes.push(stackEnv);
    results.leaks.unverified({
      resourceClass: 'reserved-ip',
      resource: `${noun}s labelled ${scope}`,
      reason: `the listing failed: ${error.message}, so vibecarbon could not confirm none is left`,
      hint:
        `Run \`${retryDestroyCommand(environment, args)}\` again to retry the check: the environment ` +
        `stays in .vibecarbon.json until it runs clean. Or look in the ${Provider.NAME} console ` +
        `for a ${noun} labelled ${scope}; it keeps billing until it is released.`,
    });
  }
}

/**
 * The k8s destroy backstop, per stack, after `pulumi destroy`. Every delete
 * goes by name, address or label, never through the cluster, so a deploy
 * that died before the cluster was ready (no kubeconfig) is swept just the
 * same.
 *
 * - On a provider with `K8S_DESTROY_BACKSTOP` (DigitalOcean, Linode), whose
 *   `pulumi destroy` has been seen to skip them: the firewall and SSH key by
 *   name, each recorded reserved IP by address (releaseRecordedReservedIp),
 *   then the VPC last.
 * - On every provider whose reserved IPs carry the program's labels
 *   (`deleteReservedIpsByLabels`: Hetzner, Linode): the IPs labelled for the
 *   stack that no record names (sweepTaggedReservedIps), before the VPC.
 *
 * Exported for unit testing (destroyK8sTier itself is not).
 *
 * @param {{provider: object, targets: ReturnType<typeof planK8sBackstopTargets>, results: object, s: {start: Function, stop: Function}, projectName?: string, environment: string, args?: {purgeBackups?: boolean}}} params
 *   `environment`: the environment as the operator names it, and `args`,
 *   this destroy's flags, for the retry line (retryDestroyCommand).
 */
export async function sweepK8sBackstopTargets({
  provider,
  targets,
  results,
  s,
  projectName,
  environment,
  args,
}) {
  const Provider = provider.constructor;
  const byName = Provider.K8S_DESTROY_BACKSTOP === true;
  const byLabel = Boolean(projectName) && typeof provider.deleteReservedIpsByLabels === 'function';
  // The address path handles every recorded address, on whichever stack's
  // pass it falls; the label sweep leaves them all to it, so none is handled
  // (or reported) twice.
  const recorded = byName ? targets.flatMap((t) => t.reservedIps.map((r) => r.address)) : [];
  for (const target of targets) {
    if (byName) {
      await sweepByName({ provider, target, results, s, projectName, environment, args });
    }
    if (byLabel) {
      await sweepTaggedReservedIps({
        provider,
        projectName,
        stackEnv: target.stackEnv,
        except: recorded,
        results,
        s,
        environment,
        args,
      });
    }
    if (byName) await deleteBackstopNetwork({ provider, target, results, s });
  }
}

/**
 * The name and address half of the backstop for one stack: firewall, SSH
 * key, then each recorded reserved IP.
 * @param {{provider: object, target: ReturnType<typeof planK8sBackstopTargets>[number], results: object, s: {start: Function, stop: Function}, projectName?: string, environment: string, args?: {purgeBackups?: boolean}}} params
 */
async function sweepByName({ provider, target, results, s, projectName, environment, args }) {
  const Provider = provider.constructor;
  // Firewall — literal name from digitalocean-k8s.js: `${clusterName}-firewall`.
  const firewallName = target.firewallName;
  s.start(`Verifying ${Provider.NAME} firewall is gone: ${firewallName}`);
  try {
    const result = await provider.deleteFirewallByName(firewallName);
    if (result.deleted) {
      results.firewalls.push(firewallName);
      s.stop('Firewall deleted (backstop)');
    } else if (result.apiError) {
      s.stop(`Firewall backstop failed: ${result.apiError.message}`);
      results.leaks.leak({
        resourceClass: 'firewall',
        resource: firewallName,
        reason: `backstop delete did not complete: ${result.apiError.message}`,
        hint: `Delete it via the ${Provider.NAME} console, because a leaked firewall makes the next deploy fail with a name-already-in-use error.`,
      });
    } else {
      s.stop('Firewall already gone (Pulumi)');
    }
  } catch (error) {
    s.stop(`Firewall backstop check failed: ${error.message}`);
    results.leaks.unverified({
      resourceClass: 'firewall',
      resource: firewallName,
      reason: `backstop check threw: ${error.message}, could not confirm it is gone`,
      hint: `Delete it via the ${Provider.NAME} console, because a leaked firewall makes the next deploy fail with a name-already-in-use error.`,
    });
  }

  // SSH key — literal name from digitalocean-k8s.js:
  // `${clusterName}-${config.location}-key` (config.location ===
  // envConfig.region). Null on HA: both clusters share one key created
  // OUTSIDE Pulumi, swept by the dedicated block below.
  const sshKeyName = target.sshKeyName;
  if (sshKeyName) {
    s.start(`Verifying ${Provider.NAME} SSH key is gone: ${sshKeyName}`);
    try {
      const deleted = await provider.deleteSSHKeyByName(sshKeyName);
      if (deleted) results.sshKeys.push(sshKeyName);
      s.stop(deleted ? 'SSH key deleted (backstop)' : 'SSH key already gone (Pulumi)');
    } catch (error) {
      s.stop(`SSH key backstop check failed: ${error.message}`);
      results.leaks.unverified({
        resourceClass: 'ssh-key',
        resource: sshKeyName,
        reason: `backstop check threw: ${error.message}, could not confirm it is gone`,
        hint: `Delete it via the ${Provider.NAME} console, because a leaked key blocks the next deploy's key registration by name.`,
      });
    }
  }

  // Reserved IPs — unnamed on DO; attribution is the address persisted at
  // deploy time (orchestrator.js): envConfig.floatingIp for single k8s,
  // envConfig.ha.{primary,standby}.floatingIp per stack for HA, and an
  // environment-level one on HA as either side's (planK8sBackstopTargets).
  // Also feeds plan.ownedIps above so the DNS record finally matches.
  //
  // On DigitalOcean only clusters made before 2026-11 have one (today's
  // program makes none), and this backstop is not belt-and-braces there,
  // it is THE mechanism: the reserved IP is the one resource `pulumi
  // destroy` was observed to leave behind every time. The upstream provider
  // defects that explained it (a Delete that never unassigns + an
  // assignment resource that deletes itself from state on refresh) were
  // written up at the former `digitalocean.ReservedIp` construction site in
  // src/lib/iac/programs/digitalocean-k8s.js (git history). By the time
  // this runs the droplets are gone, so the IP should be unassigned.
  // DigitalOcean's delete counts it released only once the read by address
  // answers 404 (DigitalOceanProvider.deleteReservedIpByAddress): DO has
  // answered a DELETE with success and kept the IP.
  const retry = reservedIpRetryHint(environment, args, Provider);
  for (const { address, stacks } of target.reservedIps) {
    await releaseRecordedReservedIp({ provider, address, stacks, projectName, results, s, retry });
  }
}

/**
 * The backstop's VPC delete, LAST for its stack: DO refuses to delete a
 * non-empty VPC (still-attached servers/load balancers/etc respond non-2xx).
 * By this point Pulumi + every sweep above should have cleared every member;
 * a refusal here is therefore a genuine ordering bug elsewhere, not a
 * not-found, so it is surfaced loudly rather than swallowed.
 * @param {{provider: object, target: ReturnType<typeof planK8sBackstopTargets>[number], results: object, s: {start: Function, stop: Function}}} args
 */
async function deleteBackstopNetwork({ provider, target, results, s }) {
  const Provider = provider.constructor;
  const networkName = target.networkName;
  s.start(`Verifying ${Provider.NAME} VPC is gone: ${networkName}`);
  try {
    const result = await provider.deleteNetworkByName(networkName);
    if (result.deleted) {
      s.stop('VPC deleted (backstop)');
    } else if (result.apiError) {
      s.stop(`VPC backstop failed: ${result.apiError.message}`);
      results.leaks.leak({
        resourceClass: 'network',
        resource: networkName,
        reason: `delete refused (likely still has members): ${result.apiError.message}`,
        hint: `Check the ${Provider.NAME} console for leftover servers, load balancers or managed databases in this VPC, delete them, then delete the VPC manually.`,
      });
    } else {
      s.stop('VPC already gone (Pulumi)');
    }
  } catch (error) {
    s.stop(`VPC backstop check failed: ${error.message}`);
    results.leaks.unverified({
      resourceClass: 'network',
      resource: networkName,
      reason: `backstop check threw: ${error.message}, could not confirm it is gone`,
      hint: `Check the ${Provider.NAME} console for a surviving VPC and any servers or load balancers still inside it.`,
    });
  }
}

/**
 * k8s / k8s-ha: Pulumi-managed infra teardown (volume pre-scan, CCM LB
 * cleanup, CSI release, CA-worker sweep, `pulumi destroy` per stack, orphan
 * sweep, HA shared-key delete), then DNS records (last, once nothing can still
 * validate them), then orphaned CSI volume cleanup. plan.stackEnvs already differs for k8s vs k8s-ha, so a single
 * function serves both.
 */
async function destroyK8sTier({
  plan,
  envConfig,
  projectConfig,
  environment,
  args,
  providerToken,
  results,
  spinner: s,
  cwd,
}) {
  const { stackEnvs, clusterNames, hasPulumiStack, ownedIps } = plan;
  const isHAK8s = plan.tier === 'k8s-ha';
  // Teardown primitives are provider instance methods (C10a); the policy
  // sweeps below take this instance. DNS + the Pulumi k8s-stack destroy still
  // take the raw token. providerToken is guaranteed truthy here (main() exits
  // otherwise), so construction never throws.
  // Resolved once per flow — see providerFor() in lib/providers/index.js.
  const Provider = providerFor(envConfig);
  const provider = new Provider(providerToken);

  // Volume IDs collected from ALL cluster servers (master, database, workers)
  // AND from each cluster's own PersistentVolumes. Both providers' CSI drivers
  // name volumes pvc-<uuid> — not the cluster name — and the labels the bumped
  // Hetzner driver stamps are project-scoped, not environment-scoped (DO stamps
  // nothing at all; see lib/csi-volumes.js). So ENVIRONMENT identity still has
  // to be collected while the cluster and its servers exist; afterwards there
  // is nothing left that distinguishes this env's volumes from its sibling's.
  const allClusterVolumeIds = [];
  // Datacenter location names for all servers in the cluster (e.g. "fsn1").
  // Used to find pvc-* volumes created by CSI that were detached before destroy.
  const clusterLocations = new Set();
  // True only when EVERY cluster's PersistentVolume list was captured. Gates
  // the heuristic backstop in cleanupOrphanedVolumes: with a complete capture
  // the identity list is the whole answer, so a `pvc-*` volume we did not
  // capture is somebody else's and must not be deleted.
  let identityComplete = false;
  // The volumes the pre-destroy CSI detach may touch: the PersistentVolume
  // capture, or when that failed, the pvc-<uuid> volumes on this env's cluster
  // servers. Nothing else.
  const capturedCsiVolumeIds = [];
  // Droplets/servers on the cluster network(s), and the volumes attached to
  // them, from the pre-scan.
  const clusterServerIds = [];
  const prescanVolumeIds = [];

  // 1. Delete Pulumi-managed cloud resources. DNS is deleted LAST (step 2):
  // while any cluster is alive its cert-manager may still be validating, and a
  // lookup in the gap after the records vanish caches the name as NXDOMAIN for
  // the next deploy on it (2026-11-04).
  if (hasPulumiStack) {
    // Pulumi owns the servers, firewalls, SSH keys, and networks — `pulumi
    // destroy` tears them all down in one pass.

    // LAYER 1 — identity capture from the cluster itself, BEFORE anything is
    // torn down. Every CSI volume a cluster owns has a PersistentVolume whose
    // `spec.csi.volumeHandle` is the provider volume id — attached or not.
    // This is the only source that sees a volume which is already DETACHED at
    // destroy time (pilot-light standby, scale-from-zero worker pool, a node
    // lost to a partial teardown); the server pre-scan below sees only what is
    // attached right now, which is why detached CSI volumes kept surviving
    // green destroys (2026-07-29 / 07-31 / 08-05, 14 volumes hand-deleted).
    // Best-effort per cluster: a dead cluster falls through to the gated
    // heuristic backstop, loudly.
    // Sequential on purpose: captureClusterCsiVolumes shells out with the
    // SYNCHRONOUS runCommand, so a Promise.all here would buy nothing but a
    // misleading log line. The per-request timeout bounds the dead-cluster
    // case (2 clusters × 20s worst case on the HA path).
    console.log(`Capturing CSI volume identities from ${stackEnvs.length} cluster(s)...`);
    const captures = [];
    for (const stackEnv of stackEnvs) {
      const kubeconfigPath = localKubeconfigPath(cwd, stackEnv);
      const dirLabel = isHAK8s ? ` (${stackEnv})` : '';
      const capture = captureClusterCsiVolumes(kubeconfigPath, { timeoutSeconds: 20 });
      if (capture.ok) {
        allClusterVolumeIds.push(...capture.volumeIds);
        capturedCsiVolumeIds.push(...capture.volumeIds);
        for (const region of capture.regions) clusterLocations.add(region);
        console.log(
          `  Captured ${capture.volumeIds.length} CSI volume id(s) from PersistentVolumes${dirLabel}`,
        );
        if (capture.skippedDrivers.length > 0) {
          console.log(
            `  Ignoring PersistentVolumes from unrecognised CSI driver(s)${dirLabel}: ${capture.skippedDrivers.join(', ')} — delete their storage manually`,
          );
        }
      } else {
        console.log(
          `  CSI volume capture unavailable${dirLabel}: ${capture.reason}, falling back to the detached-pvc backstop`,
        );
      }
      captures.push({ stackEnv, capture });
    }
    identityComplete = captures.length > 0 && captures.every(({ capture }) => capture.ok);
    if (!identityComplete) {
      // Loud, and in the summary: without a capture, destroy can no longer
      // PROVE which volumes were this environment's, and the backstop that
      // replaces it is deliberately conservative. Silence here is exactly how
      // "No orphaned volumes found" got printed over five stranded volumes.
      // `volume-identity` keeps nothing: every re-run fails this capture
      // once the cluster is gone (ENTRY_KEEP_BY_CLASS).
      const failed = captures.filter(({ capture }) => !capture.ok);
      results.leaks.unverified({
        resourceClass: 'volume-identity',
        resource: `PersistentVolume capture: ${failed.map(({ stackEnv }) => stackEnv).join(', ')}`,
        reason: `CSI volume identity capture failed for ${failed.length} cluster(s): ${failed
          .map(({ stackEnv, capture }) => `${stackEnv} (${capture.reason})`)
          .join('; ')} — ownership of any surviving pvc-* volume cannot be proven`,
        hint: `Check the ${Provider.NAME} console (Volumes) for unattached pvc-* volumes in this environment's region(s) — they bill until deleted.`,
      });
    }

    // Pre-scan: collect volume IDs from ALL servers in the cluster network(s)
    // before deletion. Complements the PV capture above: it still catches a
    // volume attached to a cluster server whose PV object has already been
    // removed from the API (PVC deleted with the CSI delete left unfinished).
    s.start('Scanning cluster servers for attached volumes');
    try {
      const networks = await provider.listNetworks();
      const clusterNetworks = networks.filter((n) =>
        clusterNames.some((cn) => n.name === `${cn}-network`),
      );
      if (clusterNetworks.length > 0) {
        const clusterNetworkIds = new Set(clusterNetworks.map((n) => n.id));
        const allServers = await provider.listServers();
        for (const server of allServers) {
          const inCluster = provider
            .serverNetworkIds(server)
            .some((id) => clusterNetworkIds.has(id));
          if (inCluster) {
            clusterServerIds.push(server.id);
            prescanVolumeIds.push(...provider.serverVolumeIds(server));
            allClusterVolumeIds.push(...provider.serverVolumeIds(server));
            // clusterLocations feeds cleanupOrphanedVolumes's
            // isPvcInClusterLocation fallback — the ONLY thing that catches a
            // CSI volume already DETACHED before destroy runs (pod scaled
            // down, node gone from a partial teardown): DO CSI volumes carry
            // no tags (see volumeLabels' doc) and their pvc-<uuid> names
            // contain no cluster/server name, so without this a detached DO
            // volume is caught by nothing and leaks. serverRegion (Task 7 fix
            // round 1) reads the provider-native region/location field —
            // Hetzner's `location.name`, DO's `region.slug`.
            const region = provider.serverRegion(server);
            if (region) clusterLocations.add(region);
          }
        }
      }
      s.stop(
        allClusterVolumeIds.length > 0
          ? `Found ${allClusterVolumeIds.length} volume(s) to clean up`
          : 'No volumes attached to cluster servers',
      );
    } catch (error) {
      // Label matching cannot substitute for this: the bumped Hetzner driver
      // stamps `project=<name>`, which is shared by every environment of the
      // project, and DO's driver stamps nothing (lib/csi-volumes.js) — neither
      // identifies THIS environment. What actually remains is the PV capture
      // above and, failing that, the project-label / region-bounded `pvc-*`
      // heuristics, which are gated. Say which, and only claim the heuristic is
      // armed when the pre-scan actually seeded a region.
      s.stop(
        `Volume pre-scan failed: ${error.message} — ${
          identityComplete
            ? 'relying on the captured PersistentVolume identities'
            : 'no identity source left for this environment'
        }`,
      );
      if (!identityComplete) {
        results.leaks.unverified({
          resourceClass: 'volume-identity',
          resource: `cluster volume pre-scan: ${clusterNames.join(', ')}`,
          reason: `pre-scan failed (${error.message}) and no PersistentVolume capture was available; this environment has no identity source left`,
          hint: `Check the ${Provider.NAME} console (Volumes) for unattached pvc-* volumes; they bill until deleted.`,
        });
      }
    }

    // Regions from PERSISTED CONFIG, folded in unconditionally. Both live
    // sources above can come back empty on a bad day — a dead cluster kills the
    // capture and a soft-failing listing kills the pre-scan (both return `[]`
    // rather than throwing) — and an empty `clusterLocations` silently disarms
    // the region-bounded backstop, which is how a destroy printed "No orphaned
    // volumes found" over five stranded volumes on 2026-08-05. The env's own
    // config needs no API call and cannot go blank, and these are by definition
    // this cluster's regions, so this narrows nothing and can only widen what
    // the backstop is able to see.
    for (const region of configuredClusterRegions(envConfig)) clusterLocations.add(region);

    // Clean up CCM-created load balancers before Pulumi destroys the network.
    // The cluster network still exists at this point, so matchesNetwork is
    // reliable. Once the network is gone, matchesNetwork always returns false.
    // HA: fan out across primary + standby — clusters are isolated.
    if (clusterNames.length > 0) {
      console.log(`Cleaning up load balancers across ${clusterNames.length} cluster(s)...`);
      await Promise.allSettled(
        clusterNames.map(async (clusterName) => {
          try {
            const subEnv = clusterName.replace(`${projectConfig.projectName}-`, '');
            const { deleted: deletedLBs, failed: failedLBs } = await cleanupLoadBalancers(
              provider,
              projectConfig.projectName,
              subEnv,
            );
            results.loadBalancers.push(...deletedLBs);
            console.log(
              deletedLBs.length > 0
                ? `  [${clusterName}] Deleted ${deletedLBs.length} load balancer(s)`
                : `  [${clusterName}] No CCM load balancers found`,
            );
            for (const lb of failedLBs) {
              results.leaks.leak({
                resourceClass: 'load-balancer',
                resource: describeResource({ name: lb.name, id: lb.id }),
                reason: lb.reason,
                hint: `Delete it via the ${Provider.NAME} console; a surviving LB also keeps the cluster network/VPC delete refusing.`,
              });
            }
          } catch (error) {
            console.log(`  [${clusterName}] Load balancer cleanup failed: ${error.message}`);
            results.leaks.unverified({
              resourceClass: 'load-balancer',
              resource: `${clusterName} (CCM load balancers)`,
              reason: `cleanup failed before it could enumerate them: ${error.message}`,
              hint: `Check the ${Provider.NAME} console (Load Balancers) for anything attached to ${clusterName}-network.`,
            });
          }
        }),
      );
    }

    // No PersistentVolume capture, but the CSI release below still runs if the
    // API answers: fall back to the pvc-<uuid> volumes on this env's cluster
    // servers for the pre-destroy detach. Named now, while they still exist.
    if (typeof provider.detachVolume === 'function' && !identityComplete) {
      const known = new Set(capturedCsiVolumeIds);
      for (const id of await fallbackCsiVolumeIds(provider, prescanVolumeIds)) {
        if (!known.has(id)) capturedCsiVolumeIds.push(id);
      }
    }

    // Pre-Pulumi: release Hetzner CSI volumes via the cluster's own
    // finalizers while the CSI controller is still up. Pulumi destroy
    // yanks the cluster before the controller can react, so without
    // this step the underlying volumes survive each PVC. Iterate over
    // every cluster (single = 1, HA = primary + standby) using the
    // matching kubeconfig file. Helper is best-effort; the post-destroy
    // sweep below catches anything left over.
    // HA: release CSI volumes on primary + standby in parallel — each
    // cluster's controller is independent.
    console.log(
      `Releasing CSI volumes via cluster finalizers across ${stackEnvs.length} cluster(s)...`,
    );
    await Promise.allSettled(
      stackEnvs.map(async (stackEnv) => {
        const kubeconfigPath = localKubeconfigPath(cwd, stackEnv);
        const dirLabel = isHAK8s ? ` (${stackEnv})` : '';
        try {
          await cleanupClusterPVCs(kubeconfigPath);
          console.log(`  CSI volume release attempted${dirLabel}`);
        } catch (error) {
          console.log(`  CSI volume release failed${dirLabel}: ${error.message}`);
        }
      }),
    );

    // Destroy via Pulumi. Each stack lives in the backend we configured at
    // deploy time (Hetzner S3 or DigitalOcean Spaces) — `pulumi destroy`
    // removes the cloud resources, then `removeStack` cleans the state
    // record. The orchestrator persists envConfig.s3 = { bucket, region,
    // endpoint, stateBucket } (NOT envConfig.s3Config — that field never
    // exists); credentials are resolved provider-aware via
    // resolveDestroyS3Config (M3 Task 9g — see its doc comment above for why
    // this must never go back to a raw process.env.HETZNER_ACCESS_KEY read).
    // Without merging both sources here, resolveBackendUrl falls back to the
    // local file:// backend, Pulumi destroys an empty stack in ~1s, and
    // Pulumi-managed resources (FloatingIps/reserved IPs, Networks/VPCs, ...)
    // silently leak (observed 2026-04-26 matrix runs #4 + #5, independent of
    // the destroyK8s argument-passing bug that was fixed around the same
    // time; the provider-routing regression this exact code enabled is the
    // Task 9g defect).
    const destroyS3Config = await resolveDestroyS3Config(
      Provider,
      projectConfig.projectName,
      envConfig.s3 && {
        bucket: envConfig.s3.bucket,
        region: envConfig.s3.region,
        endpoint: envConfig.s3.endpoint,
        // Resolve the Pulumi backend to the dedicated state bucket. Falls
        // back (via resolveBackendUrl's `?? bucket`) to the app bucket for
        // envs deployed before the state-bucket split.
        stateBucket: envConfig.s3.stateBucket,
        stateBucketRegion: envConfig.s3.stateBucketRegion,
        stateEndpoint: envConfig.s3.stateEndpoint,
      },
    );
    // Pre-Pulumi sweep: reap cluster-autoscaler-spawned workers BEFORE
    // Pulumi tries to destroy the cluster network/firewall. CA-spawned
    // servers exist outside Pulumi state — leaving them attached fails
    // Pulumi's network destroy with "still in use".
    // For HA, sweep both primary and standby cluster networks.
    // HA: sweep CA-spawned workers on primary + standby in parallel — each
    // cluster's CA tags its workers with a distinct cluster name.
    console.log(`Sweeping cluster-autoscaler workers across ${stackEnvs.length} cluster(s)...`);
    await Promise.allSettled(
      stackEnvs.map(async (stackEnv) => {
        const dirLabel = isHAK8s ? ` (${stackEnv})` : '';
        const caClusterName = `${projectConfig.projectName}-${stackEnv}`;
        try {
          const caResult = await cleanupAutoscalerWorkers(provider, caClusterName, {
            onLeftover: (line) => results.leaks.leak(line),
          });
          if (caResult.deleted.length > 0) {
            console.log(
              `  Deleted ${caResult.deleted.length} CA-spawned worker(s)${dirLabel}: ${caResult.deleted.join(', ')}`,
            );
            results.servers.push(...caResult.deleted);
            if (caResult.volumeIds.length > 0) {
              allClusterVolumeIds.push(...caResult.volumeIds);
            }
          } else {
            console.log(`  No CA-spawned workers found${dirLabel}`);
          }
          for (const worker of caResult.failed) {
            results.leaks.leak({
              resourceClass: 'server',
              resource: describeResource({ name: worker.name, id: worker.id }),
              reason: `cluster-autoscaler worker ${worker.reason}`,
              hint: `Delete it via the ${Provider.NAME} console; it is outside Pulumi state, so no retry of \`pulumi destroy\` will remove it, and it keeps the cluster network delete refusing.`,
            });
          }
        } catch (err) {
          console.log(`  CA worker sweep failed${dirLabel}: ${err.message}`);
          // Pulumi destroy will also fail noisily if any CA-spawned servers
          // remain attached — but only if it gets that far, so record the
          // unknown here rather than relying on a later step to notice.
          results.leaks.unverified({
            resourceClass: 'server',
            resource: `${caClusterName} (cluster-autoscaler workers)`,
            reason: `sweep failed: ${err.message}, CA-spawned workers are outside Pulumi state and may survive`,
            hint: `Check the ${Provider.NAME} console for servers in ${caClusterName}-network labelled cluster-autoscaler/node=worker-pool.`,
          });
        }
      }),
    );

    // DigitalOcean: the provider's Droplet delete detaches every volume DO
    // lists on the droplet at that moment, and a volume the CSI release has
    // just deleted can still be listed, so its detach 404s and the droplet
    // (and everything that depends on it) survives. Detach the captured CSI
    // volumes here and wait for DO to agree; see lib/destroy/csi-detach.js.
    if (typeof provider.detachVolume === 'function') {
      await runCsiDetachStep(provider, {
        serverIds: clusterServerIds,
        csiVolumeIds: capturedCsiVolumeIds,
        spinner: s,
        warn: (msg) => p.log.warn(msg),
        log: (line) => console.log(`  ${line}`),
      });
    }

    const { destroyK8s: destroyK8sStack } = await import('./lib/deploy/k8s/index.js');
    // Whether the by-name backstop below runs for these stacks, and whether
    // its label sweep releases their labelled reserved IPs
    // (sweepK8sBackstopTargets' byName and byLabel).
    const backstop = Provider.K8S_DESTROY_BACKSTOP === true && !!providerToken;
    const reservedIpsSwept =
      !!providerToken &&
      Boolean(projectConfig.projectName) &&
      typeof provider.deleteReservedIpsByLabels === 'function';
    // Stacks whose state this project's passphrase cannot open: Pulumi never
    // ran a destroy for them, so the sweeps below are their teardown, and
    // settleUnreadableStacks decides about their records once those ran.
    const unreadableStacks = [];
    // HA: tear down primary + standby Pulumi stacks in parallel. Each stack
    // owns disjoint Hetzner resources (different network, different servers)
    // so there's no shared state to race on. Saves ~200s on k8s-ha critical
    // path (Pulumi destroy is ~100s/stack and was strictly sequential).
    console.log(
      `Destroying infrastructure via Pulumi across ${stackEnvs.length} stack(s); this may take a few minutes...`,
    );
    await Promise.allSettled(
      stackEnvs.map(async (stackEnv) => {
        const dirLabel = isHAK8s ? ` (${stackEnv})` : '';
        try {
          const destroyResult = await perfAsync(`destroy.pulumi.${stackEnv}`, async () =>
            destroyK8sStack({
              projectName: projectConfig.projectName,
              environment: stackEnv,
              provider: providerIdFor(envConfig),
              apiToken: providerToken,
              region: envConfig.region || 'nbg1',
              s3Config: destroyS3Config,
            }),
          );
          // recordPulumiDestroyOutcome is the ONLY place that can tell a
          // legitimately-empty destroy (already gone / never deployed) apart
          // from a suspicious one (this env has recorded infra, so an empty
          // stack means destroy almost certainly hit the WRONG, freshly-
          // created stack) — see its own doc for the mechanism.
          const verified = recordPulumiDestroyOutcome({
            destroyResult,
            envConfig,
            stackEnv,
            dirLabel,
            environment,
            args,
            results,
            providerName: Provider.NAME,
          });
          console.log(
            verified
              ? `  Pulumi infrastructure destroyed${dirLabel}`
              : `  Pulumi destroy for "${stackEnv}"${dirLabel} looks unverified — see the destroy summary's issues`,
          );
        } catch (error) {
          // The passphrase cannot open this stack's state: Pulumi never ran a
          // destroy, and the server sweep and backstop below are what remove
          // it. Said now; settled after the sweeps.
          if (isStatePassphraseFailure(error)) {
            warnUnreadableStackState({ error, stackEnv, providerName: Provider.NAME, backstop });
            unreadableStacks.push({ stackEnv, dirLabel, error });
            return;
          }
          console.log(`  Pulumi destroy failed${dirLabel}: ${error.message}`);
          p.log.warn(
            `You may need to manually clean up resources${dirLabel} in the ${Provider.NAME} console.`,
          );
          recordPulumiDestroyFailure({
            error,
            stackEnv,
            dirLabel,
            environment,
            args,
            results,
            providerName: Provider.NAME,
          });
        }
      }),
    );

    // Sweep for orphaned servers not in the Pulumi stack's resource graph.
    // This catches servers created by a partially-failed `pulumi up` that
    // never made it into the persisted state.
    s.start('Checking for orphaned servers');
    try {
      // listServersDetailed, NOT listServers: the latter soft-fails to `[]`,
      // which renders as the reassuring "No orphaned servers found" over a
      // listing we never actually read — the same silence #236 removed from
      // the volume path. An incomplete listing is no evidence at all here.
      const { items: allServers, complete } = await provider.listServersDetailed();
      const orphanedServers = allServers.filter((sv) => {
        const labels = provider.serverLabels(sv);
        return (
          labels['managed-by'] === 'vibecarbon' &&
          labelsNameEnvironment(provider, labels, projectConfig.projectName, clusterNames)
        );
      });
      // An incomplete listing proves nothing about the pages it never read,
      // whether or not it found servers on the ones it did. settleUnreadableStacks
      // reads a clean ledger as "the sweeps covered this stack", so a
      // truncated listing must leave this line even after deleting what it found.
      const recordInconclusiveScan = () =>
        results.leaks.unverified({
          resourceClass: 'server',
          resource: `orphaned-server scan: ${clusterNames.join(', ')}`,
          reason:
            'the server listing came back incomplete, so "no orphaned servers" could not be established',
          hint: `Check the ${Provider.NAME} console for servers labelled project=${projectConfig.projectName} in this environment.`,
        });
      if (orphanedServers.length > 0) {
        s.stop(
          complete
            ? `Found ${orphanedServers.length} orphaned server(s)`
            : `Found ${orphanedServers.length} orphaned server(s) in an incomplete server listing`,
        );
        for (const sv of orphanedServers) {
          s.start(`Deleting orphaned server: ${sv.name} (${Provider.getPublicIP(sv) || sv.id})`);
          try {
            await provider.deleteServer(sv.id, {
              waitUntilGone: true,
              onLeftover: (line) => results.leaks.leak(line),
            });
            results.servers.push(sv.name);
            s.stop(`Deleted ${sv.name}`);
          } catch (error) {
            s.stop(`Failed to delete ${sv.name}: ${error.message}`);
            results.leaks.leak({
              resourceClass: 'server',
              resource: describeResource({
                name: sv.name,
                id: sv.id,
                region: provider.serverRegion(sv),
              }),
              reason: `orphaned server delete failed: ${error.message}`,
              hint: `Run \`${retryDestroyCommand(environment, args)}\` again to retry: the environment stays in .vibecarbon.json, and the re-run's orphaned-server sweep finds it by its labels. Or delete it via the ${Provider.NAME} console; it is outside Pulumi state.`,
            });
          }
        }
        if (!complete) recordInconclusiveScan();
      } else if (!complete) {
        s.stop('Orphaned-server check inconclusive, server listing was incomplete');
        recordInconclusiveScan();
      } else {
        s.stop('No orphaned servers found');
      }
    } catch (error) {
      s.stop(`Orphan server check failed: ${error.message}`);
      results.leaks.unverified({
        resourceClass: 'server',
        resource: `orphaned-server scan: ${clusterNames.join(', ')}`,
        reason: `scan failed: ${error.message}, servers left behind by a partial \`pulumi up\` cannot be ruled out`,
        hint: `Check the ${Provider.NAME} console for servers labelled project=${projectConfig.projectName} in this environment.`,
      });
    }

    // Name/address backstop for providers with K8S_DESTROY_BACKSTOP (M3 Task 9f;
    // DigitalOcean first, Linode too). Two live DO k8s destroys
    // left the firewall/VPC/SSH-key/reserved-IP behind even though Pulumi
    // reported success. The loud-partial-detection this task also added
    // (destroyStack's internal checks in lib/iac/index.js, PLUS the
    // caller-side recordPulumiDestroyOutcome() above, which is the piece
    // that actually catches the empty-stack/state-backend-mismatch
    // mechanism behind those two incidents — destroyStack's own checks
    // compare a stack's before/after state and can't see that it was the
    // WRONG stack) makes that failure LOUD instead of silent, but loud is
    // not the same as fixed: these sweeps are the hard guarantee — idempotent
    // name/address deletes that don't depend on trusting Pulumi's own report
    // at all, so leftover resources get cleaned up regardless of whether the
    // Pulumi step above was verified or not. Hetzner's k8s Pulumi destroy has
    // never been observed to leak these, so it opts out of the name sweeps
    // and only gets the ownedIps fix above (its k8s DNS record was the actual
    // gap there).
    // Every provider whose reserved IPs carry the program's labels (Hetzner,
    // Linode) also gets the label sweep: a deploy killed while Pulumi was
    // creating the floating IP leaves it in no state and no record, and the
    // pre-destroy refresh drops the pending create, so `pulumi destroy`
    // cannot see it either (sweepTaggedReservedIps).
    // One pass per Pulumi STACK: k8s-ha is two stacks (`<env>-primary` /
    // `<env>-standby`), each with its own firewall/VPC (and reserved IP, on
    // Linode or a DigitalOcean cluster made before 2026-11) — deriving
    // one cluster name from the user-facing environment here (the pre-d4
    // shape) named a cluster that never existed on HA and leaked all of them.
    // Target list + naming is planK8sBackstopTargets (exported, unit-pinned);
    // single k8s stays byte-identical to the old single-target behavior.
    if (providerToken) {
      await sweepK8sBackstopTargets({
        provider,
        targets: planK8sBackstopTargets({ plan, envConfig, projectConfig }),
        results,
        s,
        projectName: projectConfig.projectName,
        environment,
        args,
      });
    }

    // HA k8s: delete the shared SSH key created OUTSIDE Pulumi by
    // src/lib/deploy/k8s/ha/index.js (named `${project}-${env}-ha-key`).
    // Both Pulumi stacks reference it via `existingSshKeyId`, so neither
    // stack's destroy removes it — without this manual cleanup it leaks
    // on every HA destroy and the next preflight scan blocks the matrix
    // (RCA from k8s-ha 2026-04-30: post-destroy sweep flagged the same
    // key as REGRESSION every run).
    if (isHAK8s && providerToken) {
      const haSshKeyName = haSshKeyNameFor(projectConfig.projectName, environment);
      s.start(`Deleting shared HA SSH key: ${haSshKeyName}`);
      try {
        const deleted = await provider.deleteSSHKeyByName(haSshKeyName);
        if (deleted) results.sshKeys.push(haSshKeyName);
        s.stop(deleted ? 'HA SSH key deleted' : 'HA SSH key not found');
      } catch (error) {
        s.stop(`Failed to delete HA SSH key: ${error.message}`);
        results.leaks.leak({
          resourceClass: 'ssh-key',
          resource: haSshKeyName,
          reason: `delete failed: ${error.message}`,
          hint: `Delete it via the ${Provider.NAME} console — this key is created OUTSIDE Pulumi, so no destroy retry's \`pulumi destroy\` will remove it, and the next preflight scan flags it every run.`,
        });
      }
    }

    // Every sweep that stands in for `pulumi destroy` has run: settle the
    // stacks Pulumi could not read, against what the sweeps left.
    if (unreadableStacks.length > 0) {
      const { removeStackState } = await import('./lib/iac/index.js');
      await settleUnreadableStacks({
        stacks: unreadableStacks,
        environment,
        projectName: projectConfig.projectName,
        results,
        providerName: Provider.NAME,
        backstop,
        reservedIpsSwept,
        reservedIpName: Provider.RESERVED_IP_NAME ?? 'reserved IP',
        backendResolved: !(envConfig.s3 && !destroyS3Config),
        // The project dir getOrCreateStack checked the passphrase in. Asks
        // git, so only here, once a stack has been refused.
        passphraseProvenance: statePassphraseProvenance(process.cwd()),
        removeRecord: (stackEnv) =>
          removeStackState(stackEnv, {
            projectName: projectConfig.projectName,
            provider: providerIdFor(envConfig),
            s3Config: destroyS3Config,
          }),
        s,
      });
    }
  }

  // 2. Delete DNS resources now that nothing that could validate or serve them
  // is alive. Registry-driven, ownership-filtered, incl. provider health
  // checks. A failure here reports through the leak list (no retry).
  await cleanupDnsRecords({ envConfig, ownedIps, providerToken, s, results });

  // Clean up Kubernetes-managed resources (created by CCM/CSI at runtime,
  // not by the Pulumi program). These aren't in any stack's resource graph.
  //
  // LAYER 2 gate — which regions still host servers we do NOT own. Computed
  // here, after the orphaned-server sweep above, so this environment's own
  // leftovers never count. A heuristic (`pvc-*` in one of our regions) match in
  // one of these regions is deferred rather than deleted: a live cluster there
  // can legitimately hold a DETACHED CSI volume (scale-from-zero worker pool,
  // a db scaled down mid-reseed) and deleting it destroys its data. That exact
  // thing happened on 2026-07-18 when a concurrent CI sweep reaped another live
  // rig's volumes. Failing to read the server list is treated as "foreign
  // servers everywhere" — see the catch.
  const foreignRegions = new Set();
  if (hasPulumiStack && !identityComplete) {
    /** Unknown occupancy is not "nobody is there" — block every region we
     * might touch. Deferring costs a leaked volume the sweep collects later;
     * guessing costs somebody's data. */
    const blockEverything = (why) => {
      for (const region of clusterLocations) foreignRegions.add(region);
      console.log(`  ${why}, heuristic volume cleanup disabled for this destroy`);
    };
    try {
      // listServersDetailed, NOT listServers: the latter soft-fails to `[]`,
      // which reads as "the project is quiet" — the exact condition that
      // unlocks deleting volumes on a name pattern.
      const { items: remaining, complete } = await provider.listServersDetailed();
      if (!complete) {
        blockEverything('Server listing was incomplete');
      } else {
        const { regions, unreadable } = foreignServerRegions(
          provider,
          remaining,
          projectConfig.projectName,
          clusterNames,
        );
        for (const region of regions) foreignRegions.add(region);
        if (unreadable) blockEverything(`Could not read the region of server ${unreadable}`);
      }
    } catch (error) {
      blockEverything(`Could not check for foreign servers (${error.message})`);
    }
  }

  s.start('Cleaning up orphaned volumes');
  try {
    const serverNames = (envConfig.servers || []).map((sv) => sv.name);
    const knownVolumeIds = [...new Set(allClusterVolumeIds.map(idKey))];
    const { deleted, unresolved, deferred, listingComplete } = await cleanupOrphanedVolumes(
      provider,
      projectConfig.projectName,
      environment,
      serverNames,
      knownVolumeIds,
      [...clusterLocations],
      { identityComplete, foreignRegions: [...foreignRegions] },
    );
    results.volumes = deleted;
    s.stop(
      deleted.length > 0
        ? `Deleted ${deleted.length} orphaned volume(s)`
        : listingComplete
          ? identityComplete
            ? 'No orphaned volumes found'
            : 'No orphaned volumes matched (identity capture was unavailable; see the leak report)'
          : 'Volume listing was incomplete, could not verify (see the leak report)',
    );

    // An identity volume we could neither confirm gone nor delete is a real
    // leak (it bills until deleted). Say so instead of reporting a clean
    // teardown, AND write it to the ledger so the standing sweep can finish
    // the job by id — the sweep's own `pvc-*` pass defers whenever any server
    // exists, which during a back-to-back e2e matrix is always.
    if (unresolved.length > 0) {
      recordLeakedVolumes(
        unresolved.map((v) => ({
          provider: providerIdFor(envConfig),
          id: v.id,
          name: v.name,
          region: v.region,
          createdAt: v.createdAt,
          project: projectConfig.projectName,
          environment,
        })),
      );
      for (const volume of unresolved) {
        results.leaks.leak({
          resourceClass: 'volume',
          resource: describeResource({ name: volume.name, id: volume.id, region: volume.region }),
          reason:
            'could not be confirmed deleted (still attached, delete failed, or unverifiable), recorded in the leaked-volume ledger',
          hint: `~/.vibecarbon/leaked-volumes.json; the next sweep deletes it by id. To do it now, remove it via the ${Provider.NAME} console (Volumes); it keeps billing until removed.`,
        });
      }
    }

    // Deferred heuristic matches were left in place ON PURPOSE. Which verdict
    // they get depends on WHY (see heuristicBlockedBecause): a volume absent
    // from a COMPLETE capture of our own PersistentVolumes is proven not ours
    // (foreign — reported, exit-neutral), while one blocked only by a live
    // foreign server in the region, with our capture incomplete, is genuinely
    // unknown and may be ours (unverified — exit-failing). Their own class,
    // `volume-deferred`, keeps nothing: a re-run cannot prove the owner
    // either while that server lives (ENTRY_KEEP_BY_CLASS).
    for (const volume of deferred) {
      const entry = {
        resourceClass: 'volume-deferred',
        resource: describeResource({ name: volume.name, id: volume.id, region: volume.region }),
        reason: `left in place (${volume.match} match only): ${volume.blocked}`,
        hint: `Confirm no live cluster owns it, then delete via the ${Provider.NAME} console (Volumes) or run scripts/sweep-hetzner.js once the project is quiet.`,
      };
      if (volume.blockedBy === 'identity-complete') results.leaks.foreign(entry);
      else results.leaks.unverified(entry);
    }

    // #236 made listing completeness a first-class signal; this is the missing
    // consumer. An incomplete volume listing means the pass above scanned a
    // page set we know was partial: "no orphaned volumes" is then a statement
    // about what we managed to read, not about the account.
    if (!listingComplete) {
      results.leaks.unverified({
        resourceClass: 'volume',
        resource: `volume listing (${[...clusterLocations].join(', ') || 'all regions'})`,
        reason:
          'the provider volume listing came back incomplete, surviving pvc-* volumes cannot be ruled out',
        hint: `Check the ${Provider.NAME} console (Volumes) for unattached pvc-* volumes in this environment's region(s), or run \`${retryDestroyCommand(environment, args)}\` again once the API settles.`,
      });
    }
  } catch (error) {
    s.stop(`Volume cleanup failed: ${error.message}`);
    results.leaks.unverified({
      resourceClass: 'volume',
      resource: `orphaned-volume sweep: ${clusterNames.join(', ')}`,
      reason: `cleanup did not complete: ${error.message}`,
      hint: `Check the ${Provider.NAME} console (Volumes) for unattached pvc-* volumes; they bill until deleted.`,
    });
  }
}

// ============================================================================
// DESTROY EFFECT REGISTRY
// ============================================================================
//
// The destroy step-plan runner (runPlan) executes planDestroy(tier)'s steps
// against this registry. The tier-teardown effects are THIN WRAPPERS over the
// hardened per-tier helpers above (destroyComposeTier / destroyComposeHATier /
// destroyK8sTier) — the Pulumi-literal resource-name matching, ownership-aware
// DNS deletes, and HA both-cluster fan-out (via ctx.plan.stackEnvs) all live
// inside those helpers, unchanged. k8s and k8s-ha share destroyK8sInfra exactly
// as the removed DESTROY_STRATEGIES table shared destroyK8sTier.
//
// This registry lives here (not in lib/deploy/effects/index.js) on purpose:
// destroy.js registers process-level SIGINT/SIGTERM handlers at module load, so
// pulling it into the shared deploy effects barrel would fire those handlers on
// every deploy. runPlan takes the registry as an argument, so a destroy-local
// registry is fully supported.

/** compose: stop the stack + reap VPS/firewall/SSH-key/DNS via direct APIs. */
async function destroyComposeServicesEffect(ctx) {
  await destroyComposeTier({
    plan: ctx.plan,
    envConfig: ctx.envConfig,
    projectConfig: ctx.projectConfig,
    environment: ctx.environment,
    args: ctx.args,
    providerToken: ctx.providerToken,
    results: ctx.results,
    spinner: ctx.spinner,
    cwd: ctx.cwd,
  });
}

/**
 * compose + compose-ha: remove the Pulumi stack record(s) after the
 * out-of-band teardown — the compose-side twin of the `removeStack` that
 * destroyStack already performs for the k8s tiers.
 *
 * Why this step exists (e2e run 32309395314, vultr compose restore,
 * 2026-08-19): the compose tiers reap servers/firewalls/keys via direct
 * provider APIs, so `pulumi destroy` never runs for them — and with the
 * state bucket retained (717d49e7), the stack file survived a VERIFIED
 * teardown still describing the deleted resources. That commit's "the stack
 * file is removed by `pulumi destroy` + `removeStack` before this runs"
 * premise is true only for the k8s tiers. The next deploy of the same
 * environment (the e2e restore re-deploy) selected the stale stack, and on
 * providers whose refresh cannot prune a deleted resource
 * (terraform-provider-vultr v2.27.1 surfaces a deleted firewall rule's 404
 * as an ERROR, not not-found) `pulumi up` tried to delete the stale rules
 * against the live API and died on the same 404. Hetzner/DO survived only
 * because their providers prune on refresh — the pre-up refresh is a
 * tripwire, not the repair; state is reconciled HERE, by the step that
 * deleted the resources.
 *
 * Two retention gates, both deliberate:
 *   - the environment's entry is kept (entryKeptReason, the one predicate)
 *     → keep the stack state with it: it is the record of what may still be
 *     deployed, and the re-run the entry allows removes it once the teardown
 *     runs clean. Removed exactly when the entry is, so the next deploy of
 *     the name never selects a stack whose entry is gone (I1, 2026-11-11: a
 *     refused DNS delete kept the stack and removed the entry). Lines a re-run
 *     cannot act on (a DNS record, a FOREIGN volume) keep neither.
 *   - recorded s3 backend but unresolvable credentials → removing would run
 *     against the file:// fallback, "succeed" against the wrong backend,
 *     and leave the real stale stack alive. Kept, as an `unverified
 *     pulumi-stack` line, which keeps the entry so the re-run can remove it.
 *
 * Per-stack failures land as `unverified pulumi-stack` ledger entries (a
 * retained stale stack fails the next re-deploy on the vultr class), and
 * the loop continues so compose-ha's second stack still gets reconciled.
 */
async function removePulumiStackStateEffect(ctx) {
  const { plan, envConfig, projectConfig, environment, args, results, spinner: s } = ctx;

  const kept = entryKeptReason(results, envConfig);
  if (kept) {
    p.log.warn(
      `Pulumi stack state kept for ${plan.stackEnvs.join(', ')}: this destroy keeps the ` +
        `environment's entry because ${kept.because}. The state records what may still be ` +
        `deployed, and the next \`${retryDestroyCommand(environment, args)}\` that runs clean removes it.`,
    );
    return;
  }

  const Provider = providerFor(envConfig);
  const s3Config = await resolveDestroyS3Config(
    Provider,
    projectConfig.projectName,
    envConfig.s3 && {
      bucket: envConfig.s3.bucket,
      region: envConfig.s3.region,
      endpoint: envConfig.s3.endpoint,
      stateBucket: envConfig.s3.stateBucket,
      stateBucketRegion: envConfig.s3.stateBucketRegion,
      stateEndpoint: envConfig.s3.stateEndpoint,
    },
  );
  if (envConfig.s3 && !s3Config) {
    const keys =
      (Provider.OBJECT_STORAGE_ENV ?? []).join(' and ') || 'the object-storage credentials';
    s.start('Pulumi stack state');
    s.stop(
      'Pulumi stack state kept: the state-backend credentials could not be resolved, and ' +
        'removing it against the local fallback backend would miss the real stack.',
    );
    for (const stackEnv of plan.stackEnvs) {
      results.leaks.unverified({
        resourceClass: 'pulumi-stack',
        resource: stackEnv,
        reason:
          'stack-state removal skipped: no object-storage credentials for its state backend, ' +
          'so the stack still describes the deleted resources',
        hint:
          `Set ${keys}, then run \`${retryDestroyCommand(environment, args)}\` again to remove it: the ` +
          'environment stays in .vibecarbon.json until its stack state is removed.',
      });
    }
    return;
  }

  // Removing the record decrypts nothing (`stack rm --force`, with
  // removeStackState's `decrypts: false`), so a passphrase that cannot open
  // the state does not stop it. Said once, so the operator knows why the
  // destroy went around the state and that their next deploy will need it.
  const passphraseProblem = findStatePassphraseProblem(ctx.cwd ?? process.cwd());
  if (passphraseProblem) {
    p.log.warn(
      `vibecarbon can't read the Pulumi state for ${plan.stackEnvs.join(', ')} ` +
        `(${unreadableStateReason(passphraseProblem)}). This destroy doesn't need to: your ` +
        `servers were removed through the ${Provider.NAME} API, and the stack record is ` +
        'removed without being read.',
    );
  }

  const { removeStackState } = await import('./lib/iac/index.js');
  for (const stackEnv of plan.stackEnvs) {
    s.start(`Removing Pulumi stack state: ${stackEnv}`);
    try {
      const { removed, stateBucketMissing } = await removeStackState(stackEnv, {
        projectName: projectConfig.projectName,
        provider: providerIdFor(envConfig),
        s3Config,
      });
      s.stop(
        removed
          ? `Pulumi stack state removed: ${stackEnv}`
          : stateBucketMissing
            ? `Pulumi stack state already absent: ${stackEnv} (its state bucket was never created, so there was nothing to remove)`
            : `Pulumi stack state already absent: ${stackEnv}`,
      );
    } catch (error) {
      s.stop(`Failed to remove Pulumi stack state: ${error.message}`);
      results.leaks.unverified({
        resourceClass: 'pulumi-stack',
        resource: stackEnv,
        reason: `stack-state removal failed: ${error.message}`,
        hint:
          `Run \`${retryDestroyCommand(environment, args)}\` again to remove it: the environment stays ` +
          'in .vibecarbon.json until its stack state is removed. The kept stack still describes ' +
          'deleted resources, and a deploy of this environment that selects it may fail ' +
          'deleting them (provider 404s).',
      });
    }
  }
}

/** compose-ha: hand the whole two-node teardown to the compose HA helper. */
async function destroyComposeHaEffect(ctx) {
  await destroyComposeHATier({
    envConfig: ctx.envConfig,
    projectConfig: ctx.projectConfig,
    environment: ctx.environment,
    args: ctx.args,
    providerToken: ctx.providerToken,
    results: ctx.results,
    tracker: ctx.tracker,
  });
}

/** k8s / k8s-ha: DNS + Pulumi-managed teardown (both stacks for HA) + CSI sweep. */
async function destroyK8sInfraEffect(ctx) {
  await destroyK8sTier({
    plan: ctx.plan,
    envConfig: ctx.envConfig,
    projectConfig: ctx.projectConfig,
    environment: ctx.environment,
    args: ctx.args,
    providerToken: ctx.providerToken,
    results: ctx.results,
    spinner: ctx.spinner,
    cwd: ctx.cwd,
  });
}

/**
 * FINISH-THEN-REPORT wrapper. Best-effort is a per-RESOURCE property inside the
 * effects; this makes it a per-STEP property too.
 *
 * runPlan re-throws whatever an effect throws, which aborts the rest of the
 * plan. On a destroy that is the wrong shape: an exception escaping the k8s
 * teardown (or the app-bucket delete, or the config update) would skip every
 * remaining step INCLUDING finish-outro, so the run would end with no leak
 * report at all — the operator loses the accounting for everything that DID
 * happen, precisely when they need it most.
 *
 * So each step is wrapped: the throw is recorded as an `unverified` verdict
 * naming the step (everything it had not yet deleted is genuinely unaccounted
 * for), and the plan continues to the next step. The exit code still goes
 * non-zero, via the ledger, at the end.
 *
 * `finishOutro` is deliberately NOT wrapped: it is the reporter, it runs last,
 * and swallowing its failure would leave a silent exit 0 — the exact defect
 * this whole change removes. A throw there propagates to cli.js's catch → 1.
 *
 * Whether the line keeps the environment's entry depends on the step
 * (ENTRY_KEEP_BY_CLASS's `destroy-step` row), and the hint follows it: a re-run
 * only when the entry stays for one, the by-hand step otherwise.
 */
function finishThenReport(stepLabel, effect) {
  return async (ctx, args) => {
    try {
      await effect(ctx, args);
    } catch (error) {
      p.log.error(`Destroy step "${stepLabel}" failed: ${error.message}`);
      const entry = {
        resourceClass: 'destroy-step',
        resource: stepLabel,
        reason: `step threw: ${error.message}, anything it had not yet deleted is unaccounted for`,
      };
      const verdict = entryVerdict({ ...entry, severity: 'unverified' });
      ctx.results.leaks.unverified({
        ...entry,
        hint:
          verdict === true
            ? `Run \`${retryDestroyCommand(ctx.environment, ctx.args)}\` again once the cause is addressed: ` +
              'the environment stays in .vibecarbon.json, and the re-run runs this step again ' +
              'to finish what it left. The remaining steps still ran.'
            : ['The remaining steps still ran.', verdict?.byHand?.(ctx.environment, ctx.args)]
                .filter(Boolean)
                .join(' '),
      });
    }
  };
}

/**
 * Destroy effect registry — keys match the `effect` names emitted by
 * planDestroy (src/lib/deploy/plan/destroy-plan.js). Exported for the plan
 * regression test (asserts every planned step resolves to an effect here).
 */
export const DESTROY_EFFECTS = {
  // tier teardown (one black-box wrapper per tier; k8s tiers share)
  destroyComposeServices: finishThenReport(
    'destroy-compose-services',
    destroyComposeServicesEffect,
  ),
  destroyComposeHa: finishThenReport('destroy-compose-ha', destroyComposeHaEffect),
  removePulumiStackState: finishThenReport('remove-stack-state', removePulumiStackStateEffect),
  destroyK8sInfra: finishThenReport('destroy-k8s-infra', destroyK8sInfraEffect),
  // shared teardown tail (buckets-last ordering)
  revokeAppStorageKey: finishThenReport('revoke-app-storage-key', revokeAppStorageKeyEffect),
  deleteAppBucket: finishThenReport('delete-app-bucket', deleteAppBucketEffect),
  retainStateBucket: finishThenReport('retain-state-bucket', retainStateBucketEffect),
  handleBackupBucket: finishThenReport('handle-backup-bucket', handleBackupBucketEffect),
  deleteGithubEnv: finishThenReport('delete-github-env', deleteGithubEnvEffect),
  updateProjectConfig: finishThenReport('update-project-config', updateProjectConfigEffect),
  cleanupLocalFiles: finishThenReport('cleanup-local-files', cleanupLocalFilesEffect),
  printSummary: finishThenReport('print-summary', printSummaryEffect),
  // NOT wrapped — see finishThenReport's doc.
  finishOutro: finishOutroEffect,
};

// ============================================================================
// MAIN DESTRUCTION FLOW
// ============================================================================

async function main(argv = []) {
  const { values, positional, handled } = parseFlagsOrExit(argv, SPEC);
  if (handled) return;

  // Build the legacy `args` struct that the orchestration code below
  // reads (env / yes / destroyOrphans / purgeBackups). Field renames
  // happen at the boundary so the orchestration stays untouched —
  // each downstream branch is hundreds of lines and well-tested.
  const envSeed =
    /** @type {string|undefined} */ (positional.env) ||
    /** @type {string|null} */ (values.env) ||
    null;
  const args = {
    env: envSeed,
    yes: !!values.y,
    destroyOrphans: !!values.orphans,
    purgeBackups: !!values.purge,
    force: !!values.force,
    confirm: values.confirm ?? undefined,
  };

  // Check if current working directory exists
  let cwd;
  try {
    cwd = process.cwd();
  } catch {
    console.error(`\n${c.error('Error:')} Current working directory does not exist.`);
    console.error(
      `This can happen if the project directory was deleted while this command was running.`,
    );
    console.error(`\nPlease navigate to a valid directory and try again.`);
    process.exit(1);
  }

  // Project guard runs before banner so an accidental `vibecarbon
  // destroy` from a parent directory emits the canonical message.
  assertInProjectDir(cwd);

  console.clear();
  introCommand('destroy');

  const projectConfig = loadProjectConfig(cwd);

  // TTY guard: if the operator seeded an env, no env prompt fires;
  // otherwise we'd open a picker that hangs off-TTY.
  const envCount = Object.keys(projectConfig?.environments || {}).length;
  requireTTYOrFlags({
    requirements: [
      {
        flag: 'env',
        description: 'name an environment to destroy',
        satisfied: !!envSeed || envCount <= 1,
      },
    ],
  });

  if (!projectConfig.environments || Object.keys(projectConfig.environments).length === 0) {
    // Check for orphan Pulumi stacks (deployment interrupted before config save)
    const orphanScan = spinner();
    orphanScan.start('Scanning for orphan Pulumi stacks...');
    const orphans = await findOrphanPulumiStacks(projectConfig);
    orphanScan.stop(
      orphans.length > 0 ? `Found ${orphans.length} orphan stack(s)` : 'No orphan stacks found',
    );

    if (orphans.length > 0) {
      p.log.warn('No environments found in .vibecarbon.json');
      p.log.info(
        `Found ${orphans.length} orphan Pulumi stack(s), likely from interrupted deployments:`,
      );
      for (const orphan of orphans) {
        p.log.info(`  • ${c.bold(orphan.name)}`);
      }

      // Auto-destroying orphans is dangerous: when projectConfig.s3Config is
      // null (e.g., a typo in the saved config), listStacks falls back to
      // the local file:// backend at ~/.vibecarbon/pulumi-state/, which is
      // GLOBAL across projects/scenarios. A scenario's -y destroy then
      // nukes other scenarios' stacks (observed 2026-04-26 batch run #5:
      // compose's final-destroy destroyed compose-ha's e2-primary/e2-standby
      // mid-deploy because compose's empty config let the orphan path fire).
      //
      // The auto-destroy used to honor -y, but cross-scenario blast is
      // worse than leaving local state around. Require an explicit flag now.
      // For interactive use, prompt as before.
      p.log.info('');
      if (!args.destroyOrphans) {
        p.log.warn('Skipping orphan cleanup. Re-run with -orphans to remove these stacks.');
        p.outro('Done (orphans not destroyed)');
        process.exit(0);
      }
      const shouldDestroy = args.yes
        ? true
        : await p.confirm({
            message: `Destroy these ${orphans.length} orphan stack(s)?`,
            initialValue: false, // Default to NO for safety
          });

      // Ctrl-C/ESC and an explicit "no" are different answers: one is an
      // interrupt, the other a considered refusal. Both stop the run.
      if (p.isCancel(shouldDestroy)) {
        exitCancelled();
      }
      if (!shouldDestroy) {
        exitDeclined();
      }

      // Load the HCLOUD token + S3 backend config the same way the
      // main destroy path does. Pulumi's hcloud provider needs a valid
      // token to delete resources; an empty token surfaces as
      // "Missing Hetzner Cloud API token" mid-destroy. The s3Config
      // must match the one findOrphanPulumiStacks used to discover
      // these stacks, otherwise resolveBackendUrl picks a different
      // backend and the destroy can't find them.
      // projectConfig has no `.provider` field (provider is environment-
      // scoped) — providerIdFor/providerFor always resolve the sanctioned
      // 'hetzner' default here (see access.js's single-provider-per-project
      // assumption), so this never throws on an unregistered provider id.
      const orphanProvider = providerFor(projectConfig);
      const orphanApiToken = resolveProviderToken(providerIdFor(projectConfig)) || '';

      // Fast-fail BEFORE resolving S3 backend credentials (M3 Task 9g fix
      // round 1): resolveDestroyS3Config below is an async call that can
      // reach an interactive prompt on a real TTY. This guard must stay
      // ahead of it — pre-9g there was no await here at all, so a missing
      // token always exited immediately; keep that ordering rather than
      // burning a credentials prompt right before failing anyway.
      if (!orphanApiToken) {
        p.log.error(
          `No ${orphanProvider.NAME} API token found. Set ${orphanProvider.TOKEN_ENV} in your shell or the project's .env.local — cannot destroy orphan stacks.`,
        );
        process.exit(1);
      }

      // Credentials resolved provider-aware via resolveDestroyS3Config (M3
      // Task 9g) — same fix, same resolver, as the tracked-environment
      // destroy path above. A raw process.env.HETZNER_ACCESS_KEY/HETZNER_SECRET_KEY
      // read here has the identical DO-403 failure mode.
      const orphanS3Config = await resolveDestroyS3Config(
        orphanProvider,
        projectConfig.projectName,
        projectConfig?.s3Config,
      );

      // Same ledger and exit policy as an environment destroy: a failed
      // orphan stack is a leak the scripted caller must see, not a spinner
      // line under an exit 0.
      const orphanResults = { leaks: createLeakLedger(), pulumiDestroyFailed: false };
      const orphanSpinner = spinner();
      for (const orphan of orphans) {
        orphanSpinner.start(`Destroying orphan stack ${c.bold(orphan.name)} (pulumi destroy)...`);
        try {
          await destroyOrphanPulumiStack(orphan, {
            apiToken: orphanApiToken,
            s3Config: orphanS3Config,
            provider: providerIdFor(projectConfig),
            projectName: projectConfig.projectName,
          });
          orphanSpinner.stop(`Destroyed: ${orphan.name}`);
        } catch (error) {
          orphanSpinner.error(`Failed to destroy ${orphan.name}: ${error.message}`);
          recordPulumiDestroyFailure({
            error,
            stackEnv: orphan.name,
            dirLabel: '',
            environment: orphan.name,
            finishCommand: ORPHANS_DESTROY_COMMAND,
            results: orphanResults,
            providerName: orphanProvider.NAME,
          });
        }
      }

      const report = formatLeakReport(orphanResults.leaks);
      if (report.clean) {
        p.outro('Orphan cleanup complete');
      } else {
        p.log.error('Orphan cleanup did NOT finish. These survived or could not be verified:');
        printLeakReportLines(report);
        p.outro('Orphan cleanup done with leaks');
      }
      process.exit(report.exitCode);
    }

    p.log.error('No environments found in .vibecarbon.json');
    p.log.info('Nothing to destroy.');
    process.exit(1);
  }

  p.log.info(`Project: ${c.bold(projectConfig.projectName)}`);

  // Select environment to destroy
  const envNames = Object.keys(projectConfig.environments);
  let envName = args.env;

  if (!envName) {
    if (envNames.length === 1) {
      envName = envNames[0];
    } else {
      envName = await p.select({
        message: 'Which environment do you want to destroy?',
        options: envNames.map((name) => ({
          value: name,
          label: name,
          hint: projectConfig.environments[name].servers?.map((s) => s.ip).join(', '),
        })),
      });
    }
  }

  if (p.isCancel(envName)) {
    exitCancelled();
  }

  const envConfig = projectConfig.environments[envName];
  if (!envConfig) {
    p.log.error(`Environment '${envName}' not found`);
    p.log.info(`Available environments: ${envNames.join(', ')}`);
    process.exit(1);
  }

  // Show what will be deleted. Built from local evidence, with anything a
  // stopped deploy only recorded marked "may not exist" (see preview.js).
  p.note(
    destroyPreviewBody({
      envConfig,
      projectName: projectConfig.projectName,
      envName,
      purgeBackups: args.purgeBackups,
      s3SetupCompleted: readS3SetupCompleted(cwd, envName),
      ...destroyPreviewBucketFacts(projectConfig, envName),
    }),
    `Destroying: ${envName}`,
  );

  const needsProdConfirm = requiresProdTypeToConfirm(envName);

  // First prompt: only when not -y.
  if (!args.yes) {
    const confirmed = await p.confirm({
      message: `Are you sure you want to destroy the ${c.bold(envName)} environment?`,
      initialValue: false,
    });
    // Ctrl-C/ESC and an explicit "no" are different answers: one is an
    // interrupt, the other a considered refusal. Both stop the run.
    if (p.isCancel(confirmed)) {
      exitCancelled();
    }
    if (!confirmed) {
      exitDeclined();
    }
  }

  // Type-to-confirm: runs whenever NOT -y, OR the env is prod/production
  // (even with -y). Protects against `destroy prod -y` typos in CI/scripts.
  if (!args.yes || needsProdConfirm) {
    const confirmSlug = `${projectConfig.projectName}-${envName}`;
    if (needsProdConfirm) {
      // Shared helper: owns the -y warning, the `-confirm <slug>` escape
      // hatch for scripts, and the off-TTY fail-fast (a prompt with no stdin
      // used to hang here — vibecarbon-web prod move, 2026-09-15).
      await confirmProdOrExit(envName, {
        confirmValue: confirmSlug,
        actionLabel: 'destroy',
        yes: args.yes,
        confirm: args.confirm,
      });
    } else {
      // Non-production, interactive (-y skips this branch entirely).
      const doubleConfirm = await p.text({
        message: `Type "${confirmSlug}" to confirm:`,
        validate: (v) =>
          v !== confirmSlug ? `Please type "${confirmSlug}" to confirm` : undefined,
      });
      if (p.isCancel(doubleConfirm)) {
        exitCancelled();
      }
    }
  }

  // Get API tokens (env var → interactive prompt)
  // Resolved once per flow — see providerFor() in lib/providers/index.js.
  // Resolved BEFORE the first remote step: the operator-IP refresh below
  // needs it to update the firewall.
  const Provider = providerFor(envConfig);
  const providerToken = await Provider.promptApiToken(projectConfig.projectName);
  if (!providerToken) {
    p.log.error(`${Provider.NAME} API token is required`);
    process.exit(1);
  }

  // Every SSH/kubectl step below (the pre-destroy backup, the CSI volume
  // release) needs this operator's IP on the firewall.
  await ensureDestroyOperatorAccess({
    projectConfig,
    envName,
    envConfig,
    apiToken: providerToken,
    yes: args.yes,
  });

  // Back up before deleting anything; a failed or skipped backup stops here
  // unless -force (see preDestroyBackup).
  await preDestroyBackup(
    preDestroyBackupOptions({
      envConfig,
      envName,
      projectName: projectConfig.projectName,
      cwd,
      args,
    }),
  );

  // DNS cleanup credential: resolve up-front so the teardown never stalls on
  // a mid-flow prompt. Under the same-token rule, native DNS on the deploy's
  // own cloud reuses providerToken — zero extra credentials; only a
  // cross-cloud DNS provider (e.g. Cloudflare) can need its own token here.
  if (hasAutomatedDns(envConfig.dns?.provider) && envConfig.dns?.zoneId) {
    const dnsRow = DNS_PROVIDERS[envConfig.dns.provider];
    const resolved = resolveDnsToken(envConfig.dns.provider, {
      computeProviderId: providerIdFor(envConfig),
      computeToken: providerToken,
    });
    if (resolved && resolved !== providerToken) {
      p.log.info(dnsTokenSourceLine(dnsRow));
    } else if (!resolved) {
      const entered = await p.password({
        message: `Enter ${dnsRow.name} API token (for DNS cleanup)`,
        validate: (v) => (v.length < 10 ? 'API token is required' : undefined),
      });
      if (p.isCancel(entered)) {
        exitCancelled();
      }
      // In-process coherence (A2): make the freshly-entered token visible
      // to the env-first resolution inside cleanupDnsRecords later in this
      // same destroy run.
      process.env[dnsRow.tokenEnv] = entered;
    }
  }

  // ========== DESTRUCTION ==========

  const tracker = createTracker('destroy', { environment: envName });
  const s = tracker.spinner();
  const results = {
    servers: [],
    volumes: [],
    firewalls: [],
    sshKeys: [],
    dns: [],
    healthChecks: [],
    loadBalancers: [],
    s3Bucket: null,
    github: false,
    // THE LEAK ACCOUNTING. Every teardown class records its verdicts here as it
    // goes — failed deletes, deferred/gated survivors, incomplete listings,
    // steps that threw. destroyOutro renders it as the end-of-destroy leak
    // report and derives the exit code from it (lib/destroy/leak-ledger.js).
    // Before this, the same failures were spinner lines that scrolled past and
    // a process that exited 0 regardless (2026-07-22 prod re-home).
    leaks: createLeakLedger(),
    // M3 Task 9f fix round 1: set true when any k8s stack's Pulumi destroy
    // couldn't be verified (threw, or resolved against a suspiciously-empty
    // stack — see recordPulumiDestroyOutcome). Read by the k8s destroy
    // plan's delete-state-bucket `when` gate (destroy-plan.js) — the state
    // bucket holds the ONLY evidence a retry can use, so it must survive an
    // unverified destroy.
    pulumiDestroyFailed: false,
    // Recorded reserved IPs of ours the k8s backstop could not prove released
    // (sweepK8sBackstopTargets). updateProjectConfigEffect keeps the
    // environment's entry while any is listed, so the next destroy retries.
    unreleasedReservedIps: [],
  };

  // ========== TIER DISPATCH (step-plan) ==========
  // planDestroyTargets derives every teardown target from persisted config
  // (ownership-aware; HA → both stack envs). planDestroy(tier) yields the pure,
  // ordered teardown step sequence (tier teardown → buckets-last tail); runPlan
  // executes those steps against the destroy effect registry. The plan targets,
  // the isK8s tail flag, and every credential/tracker/results handle ride on
  // ctx so the effects (thin wrappers over the hardened tier helpers) read them.
  const plan = planDestroyTargets(envConfig, projectConfig, envName);
  const isK8s = isK8sTier(plan.tier);

  // ========== PRE-TEARDOWN: S3-CONFIG / KEYS MISMATCH ==========
  // Runs BEFORE anything is deleted, which is the whole point: if the config
  // records object storage this destroy reaches (the stack state of
  // plan.stackEnvs on every destroy, the buckets under -purge) and the
  // environment has no object-storage credentials, the operator can export
  // the keys (or Ctrl-C) while it is still cheap, instead of finding the kept
  // environment or the stranded bucket in the leak report afterwards. The
  // entries are leak-RISK — reported, not exit-failing; each ACTUAL outcome
  // is recorded by its own effect later (see leak-ledger.js's
  // destroyExitCode for the full reasoning).
  for (const risk of checkS3CredentialMismatch({
    envConfig,
    envKeys: Provider.OBJECT_STORAGE_ENV,
    environment: envName,
    stackEnvs: plan.stackEnvs,
    purgeBackups: args.purgeBackups,
    appBucketOwned: ownsAppBucket(envConfig, projectConfig, envName),
    // The rule handleBackupBucket deletes by: only this environment's folder
    // while another environment keeps backups in the bucket.
    backupsHolders: destroyPreviewBucketFacts(projectConfig, envName).backupBucketHolders,
    backupsPrefix: envBackupPrefixFor(projectConfig.projectName, envName),
    canPrompt: !!process.stdin.isTTY,
  })) {
    p.log.warn(`Object storage: ${risk.reason}`);
    p.log.message(`  ${c.dim(risk.hint)}`);
    results.leaks.risk(risk);
  }

  if (plan.tier === 'unrecorded') {
    p.log.warn(
      `No deployment is recorded for "${envName}" — its deploy never reached provisioning. ` +
        'Removing the local environment entry only. If a partial deploy may have created ' +
        'cloud resources, verify in the provider console (nothing env-scoped is created ' +
        'before the deploy record exists).',
    );
  }

  const ctx = {
    plan,
    envConfig,
    projectConfig,
    environment: envName,
    args,
    results,
    providerToken,
    cwd,
    spinner: s,
    tracker,
    // k8s tiers alone fall back to the deploy-time bucket name, delete the
    // GitHub environment, and print the summary note.
    isK8s,
  };

  await runPlan(planDestroy(plan.tier), ctx, DESTROY_EFFECTS);
}

// ============================================================================
// RUN FUNCTION (called by CLI entry point)
// ============================================================================

export async function run(args) {
  await main(args);
}

// ============================================================================
// EXPORTS FOR TESTING
// ============================================================================

export {
  cleanupAutoscalerWorkers,
  cleanupOrphanedVolumes,
  loadProjectConfig,
  main,
  PULUMI_TYPE_RESOURCE_CLASS,
  retainStateBucket,
  SPEC,
  VERSION,
};
