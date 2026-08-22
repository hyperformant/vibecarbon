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
import { exitCancelled, exitDeclined } from './lib/cli/exit-guard.js';
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

import { reapChallengeRecords } from './lib/acme-challenge.js';
import { introCommand } from './lib/cli/intro.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { spinner } from './lib/cli/progress.js';
import { requireTTYOrFlags } from './lib/cli/tty-guard.js';
import { c } from './lib/colors.js';
import { loadProjectConfig, saveProjectConfig } from './lib/config.js';
import { captureClusterCsiVolumes, isCsiVolumeName } from './lib/csi-volumes.js';
import { planDestroy } from './lib/deploy/plan/destroy-plan.js';
import { runPlan } from './lib/deploy/plan/runner.js';
import {
  isComposeTier,
  isK8sTier,
  pulumiStackEnvs,
  resolveTier,
} from './lib/deploy/tier-registry.js';
import { createLeakLedger, describeResource, formatLeakReport } from './lib/destroy/leak-ledger.js';
import { checkS3CredentialMismatch } from './lib/destroy/s3-credential-check.js';
import { sweepEnvironmentServers } from './lib/destroy/server-sweep.js';
import {
  DNS_PROVIDERS,
  findZoneForDomain,
  getDnsProvider,
  hasAutomatedDns,
  resolveDnsToken,
} from './lib/dns-provider.js';
import { perfAsync } from './lib/perf.js';
import { requiresProdTypeToConfirm } from './lib/prod-confirm.js';
import { assertInProjectDir } from './lib/project-guard.js';
import {
  getObjectStorageProvider,
  providerFor,
  providerIdFor,
  resolveProviderToken,
} from './lib/providers/index.js';
import { deriveProjectBucketName } from './lib/providers/s3-base.js';
import { generateBucketSalt } from './lib/secrets.js';
import { createTracker } from './lib/tracker.js';
import { VERSION } from './lib/version.js';
import { recordLeakedVolumes } from './lib/volume-ledger.js';

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
  // k8s DNS records point at the cluster's floating/reserved ingress IP, not
  // any server's own IP — without folding it in here, every k8s destroy
  // preserved its own DNS record as "unowned" (M3 Task 9f evidence: both
  // Hetzner and DO k8s destroys left the A record behind, hand-deleted
  // afterwards). Single k8s persists it at `envConfig.floatingIp`
  // (orchestrator.js); k8s-ha persists one per cluster at
  // `envConfig.ha.primary/standby.floatingIp`. Compose tiers have no
  // floating-IP concept, so both are simply absent there.
  const ownedIps = [
    ...(envConfig.servers || []).map((srv) => srv.ip).filter(Boolean),
    envConfig.floatingIp,
    envConfig.ha?.primary?.floatingIp,
    envConfig.ha?.standby?.floatingIp,
  ].filter(Boolean);
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
    { name: 'y', boolean: true, description: 'Skip confirmation prompts' },
    { name: 'env', value: '<name>', description: 'Environment seed (alternative to positional)' },
    {
      name: 'orphans',
      boolean: true,
      description: 'Destroy stray Pulumi stacks not tracked in config',
    },
    {
      name: 'purge',
      boolean: true,
      description: 'Also delete the backup S3 bucket (default: preserved)',
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
      description: 'also delete the backup bucket',
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
 * Release all Hetzner CSI volumes via the cluster's own finalizers
 * before Pulumi tears the cluster down, so the underlying volumes
 * don't leak into the post-destroy orphan sweep.
 *
 * Approaches tried:
 *   - `kubectl delete pvc --all --wait=true`. Failed — PVCs have a
 *     kubernetes.io/pvc-protection finalizer that blocks delete while
 *     a Pod is bound, so the wait burned the full 180s while
 *     supabase-db-0 still held its PVC. 4 orphans.
 *   - Delete Pods first (--wait=false), then PVCs. Failed for the
 *     same end result — supabase-db is a StatefulSet, so its
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
    join(cwd, '.vibecarbon', `deploy_key_${envName}`),
    join(cwd, '.vibecarbon', `deploy_key_${envName}.pub`),
    join(cwd, '.vibecarbon', `ssh-${envName}`),
    join(cwd, '.vibecarbon', `ssh-${envName}.pub`),
    join(cwd, '.vibecarbon', `known_hosts_${envName}`),
    join(cwd, '.vibecarbon', `known_hosts_${envName}-primary`),
    join(cwd, '.vibecarbon', `known_hosts_${envName}-standby`),
    join(cwd, '.vibecarbon', `kubeconfig-${envName}`),
    join(cwd, '.vibecarbon', `kubeconfig-${envName}-primary`),
    join(cwd, '.vibecarbon', `kubeconfig-${envName}-standby`),
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
async function cleanupAutoscalerWorkers(provider, clusterName) {
  // Find the cluster's private network by name (matches Pulumi resource name).
  const networks = await provider.listNetworks();
  const clusterNetwork = networks.find((n) => n.name === `${clusterName}-network`);
  if (!clusterNetwork) {
    return { deleted: [], failed: [], volumeIds: [] };
  }

  const servers = await provider.listServers();

  // Match strategy: label-primary, in-network-without-role-label fallback.
  // Pulumi-managed roles for compatibility with pre-Phase-3 deploys.
  const PULUMI_ROLES = new Set(['master', 'supabase', 'worker']);
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
      const ok = await provider.deleteServer(server.id, { waitUntilGone: true });
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
    name: volume.name ?? null,
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
    const volumeName = volume.name || '';
    if (volumeName.includes(clusterName)) return 'cluster-name';
    if (provider.volumeLabels(volume)['kubernetes.io/cluster'] === clusterName)
      return 'cluster-label';
    if ((serverNames ?? []).some((s) => s && volumeName.includes(s))) return 'server-name';
    return null;
  };

  /** PROJECT/REGION-SCOPED pattern match — never env-scoped. See the doc above. */
  const heuristicMatch = (volume) => {
    const volumeLabels = provider.volumeLabels(volume);
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
    if (!isCsiVolumeName(volume.name)) return null;
    if (projectName && volumeLabels.project === projectName) return 'project-label';
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
      if (deleted) deletedVolumes.push(volume.name);
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
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ).trim();

    runCommand(['gh', 'api', `repos/${repoInfo}/environments/${envName}`, '-X', 'DELETE'], {
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

/**
 * Handle the backup S3 bucket at the end of destroy. Default behavior is to
 * preserve the bucket for recovery (production users); --purge-backups deletes
 * it (used by e2e tests, which require a clean tear-down).
 */
async function handleBackupBucket(envConfig, projectConfig, args, spinner, leaks) {
  if (!envConfig.backupS3?.bucket) return;
  const bucketName = envConfig.backupS3.bucket;

  // Not a leak: preservation is the DEFAULT and the whole point of the flag.
  // Nothing was asked of us, so nothing survived that shouldn't have.
  if (!args.purgeBackups) {
    p.log.info(`Backup bucket ${c.bold(bucketName)} preserved for recovery`);
    return;
  }

  const region = envConfig.backupS3.region || envConfig.s3?.region || 'fsn1';
  // Resolved once per flow — see providerFor() in lib/providers/index.js.
  const Provider = providerFor(envConfig);
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
        hint: `Export ${(Provider.OBJECT_STORAGE_ENV ?? []).join(' and ') || 'the object-storage credentials'} and re-run, or delete it via the ${Provider.NAME} console — it keeps billing until removed.`,
      });
      return;
    }
    const s3Provider = await getObjectStorageProvider(
      providerIdFor(envConfig),
      s3Creds.accessKey,
      s3Creds.secretKey,
      region,
    );
    try {
      // Bound the purge so a slow/contended S3 endpoint can't consume the whole
      // destroy budget. The Hetzner resources are already freed (Pulumi destroy
      // ran before this), but a single S3 op can hang up to ~9 min under the
      // SDK (maxAttempts 3 × 60s requestTimeout) × _send (maxAttempts 3) retry
      // layers — observed on k8s teardown, where the storage bucket doubles as
      // the Pulumi state backend (slow/contended), blowing the 600s
      // final-destroy timeout and getting the whole step SIGKILLed. On timeout
      // we leave the bucket for the orphan sweep / next destroy rather than hang.
      const PURGE_TIMEOUT_MS = 180_000;
      const result = await Promise.race([
        s3Provider.emptyAndDeleteBucket(bucketName),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `backup bucket purge exceeded ${PURGE_TIMEOUT_MS / 1000}s, left for the orphan sweep / a retried destroy`,
                ),
              ),
            PURGE_TIMEOUT_MS,
          ),
        ),
      ]);
      spinner.stop(
        result.deleted
          ? result.objectsRemoved > 0
            ? `Backup bucket purged (${result.objectsRemoved} objects removed)`
            : 'Backup bucket purged'
          : result.shellDeferred
            ? `Backup bucket emptied (${result.objectsRemoved} objects removed); empty shell left for the orphan sweep; no data or storage cost remains`
            : 'Backup bucket not found',
      );
    } catch (bucketError) {
      if (bucketError.name === 'NoSuchBucket' || bucketError.$metadata?.httpStatusCode === 404) {
        spinner.stop('Backup bucket not found (already deleted or never created)');
      } else {
        throw bucketError;
      }
    }
  } catch (error) {
    spinner.stop(`Backup bucket purge failed: ${error.message}`);
    leaks.leak({
      resourceClass: 'bucket',
      resource: describeResource({ name: bucketName, region }),
      reason: `purge failed: ${error.message}`,
      hint: `Empty it via the ${Provider.NAME} Object Storage console, then DeleteBucket; it keeps billing until removed.`,
    });
  }
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
async function retainStateBucket(envConfig, projectConfig, args, spinner, leaks) {
  const stateBucket = envConfig.s3?.stateBucket;
  // Pre-split environments kept Pulumi state in the app storage bucket, which
  // the normal app-bucket path deletes; there is no separate bucket to keep.
  if (!stateBucket || stateBucket === envConfig.s3?.bucket) return;

  // -purge means "leave nothing behind" — with backups it already deletes the
  // backup bucket, and the state bucket follows the same rule. This is the ONE
  // deletion path for the retained bucket (review finding, 2026-08-15: there
  // was previously none at all), and it is safe where the old always-delete
  // was not: it runs only on explicit request, after stack teardown, and a
  // redeploy after -purge is a fresh project start, not a same-name recreate
  // racing acked writes.
  if (args?.purgeBackups) {
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
          hint: `Export the object-storage credentials and re-run, or delete it via the ${Provider.NAME} console.`,
        });
        return;
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
    } catch (error) {
      spinner.stop(`State bucket purge failed: ${error.message}`);
      leaks.leak({
        resourceClass: 'bucket',
        resource: describeResource({ name: stateBucket, region }),
        reason: `purge failed: ${error.message}`,
        hint: `Empty manually via the ${Provider.NAME} Object Storage console, then DeleteBucket.`,
      });
    }
    return;
  }

  spinner.start('Pulumi state bucket');
  spinner.stop(
    `Pulumi state bucket kept for reuse: ${stateBucket} (next deploy resumes a warm state ` +
      'backend; delete with -purge)',
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
 * Tier divergence is carried on ctx.isK8s: only k8s tiers fall back to the
 * predictable deploy-time bucket name (deleteAppBucketEffect), delete the GitHub
 * environment, and print the summary note — and the k8s-only steps
 * (delete-github-env, print-summary) appear only in the k8s destroy plan.
 */

// 1. Delete the app S3 bucket (created during deploy bootstrap, not part of any
//    Pulumi stack's resource graph). k8s can fall back to the predictable
//    deploy-time name; compose tiers only act on a configured bucket.
async function deleteAppBucketEffect(ctx) {
  const { envConfig, projectConfig, results, spinner, isK8s } = ctx;
  const s3BucketName =
    envConfig.s3?.bucket || (isK8s ? deriveProjectBucketName(projectConfig) : null);
  if (!s3BucketName) return;
  const s3Region = envConfig.s3?.region || 'fsn1';
  // Resolved once per flow — see providerFor() in lib/providers/index.js.
  const Provider = providerFor(envConfig);
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
      try {
        const result = await s3Provider.emptyAndDeleteBucket(s3BucketName);
        if (result.deleted) {
          results.s3Bucket = s3BucketName;
          spinner.stop(
            result.objectsRemoved > 0
              ? `S3 bucket deleted (${result.objectsRemoved} objects removed)`
              : 'S3 bucket deleted',
          );
        } else if (result.shellDeferred) {
          results.s3Bucket = s3BucketName;
          spinner.stop(
            `S3 bucket emptied (${result.objectsRemoved} objects removed); empty shell left for the orphan sweep; no data or storage cost remains`,
          );
        } else {
          spinner.stop('S3 bucket not found');
        }
      } catch (bucketError) {
        // NoSuchBucket means it was already deleted or never created — not an error
        if (bucketError.name === 'NoSuchBucket' || bucketError.$metadata?.httpStatusCode === 404) {
          spinner.stop('S3 bucket not found (already deleted or never created)');
        } else {
          throw bucketError;
        }
      }
    } else {
      spinner.stop('S3 bucket skipped (no credentials available)');
      results.leaks.leak({
        resourceClass: 'bucket',
        resource: describeResource({ name: s3BucketName, region: s3Region }),
        reason: 'not deleted: no object-storage credentials available',
        hint: `Run \`vibecarbon destroy\` again with credentials configured, or delete via the ${Provider.NAME} console.`,
      });
    }
  } catch (error) {
    spinner.stop(`S3 bucket deletion failed: ${error.message}`);
    results.leaks.leak({
      resourceClass: 'bucket',
      resource: describeResource({ name: s3BucketName, region: s3Region }),
      reason: `not deleted: ${error.message}`,
      hint: `Empty manually via the ${Provider.NAME} Object Storage console, then DeleteBucket. Bucket continues to incur storage charges until deleted.`,
    });
  }
}

// 2. State bucket: kept on purpose, so the next deploy reuses a warm bucket
//    instead of recreating one under the same name — see retainStateBucket.
async function retainStateBucketEffect(ctx) {
  const { envConfig, projectConfig, args, spinner, results } = ctx;
  await retainStateBucket(envConfig, projectConfig, args, spinner, results.leaks);
}

// 3. Backup bucket: preserved by default, deleted with -purge.
async function handleBackupBucketEffect(ctx) {
  const { envConfig, projectConfig, args, spinner, results } = ctx;
  await handleBackupBucket(envConfig, projectConfig, args, spinner, results.leaks);
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

// 5. Remove the destroyed environment from project config.
async function updateProjectConfigEffect(ctx) {
  const { projectConfig, environment, spinner, results } = ctx;
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
  if (results.pulumiDestroyFailed) {
    spinner.start('Updating project configuration');
    spinner.stop('Configuration kept (Pulumi destroy was not verified; see the leak report)');
    results.leaks.unverified({
      resourceClass: 'project-config',
      resource: `.vibecarbon.json → environments.${environment}`,
      reason:
        "entry KEPT because this environment's Pulumi destroy could not be verified — retrying needs it",
      hint: `Once you've verified/cleaned up any leftover resources, re-run \`vibecarbon destroy ${environment}\`; it will target this environment normally instead of falling through to orphan-stack handling.`,
    });
    return;
  }
  spinner.start('Updating project configuration');
  const updatedConfig = { ...projectConfig };
  if (updatedConfig.environments) {
    delete updatedConfig.environments[environment];
  }
  // `stateBucketGeneration` is deliberately NOT rotated here any more. It was
  // rotated so the next deploy would derive a FRESH state-bucket name rather
  // than recreate the one this destroy had just deleted — Hetzner Object
  // Storage can ack writes into a just-recreated same-name bucket and lose them
  // (e4 restore->failover, 2026-08-07). We no longer delete the state bucket
  // (see retainStateBucket), so nothing gets recreated and the hazard cannot
  // arise; rotating would now do the opposite of what we want, stranding the
  // warm bucket and sending every redeploy to a brand-new one.
  //
  // `storageBucketGeneration` IS rotated — precisely when this destroy
  // actually DELETED the storage bucket (purge path; results.s3Bucket is the
  // deleted name). The storage bucket cannot be retained across `-purge`
  // (purge means the data is deleted), so the redeploy-side of the hazard is
  // closed by naming instead: the next deploy derives a FRESH bucket name
  // rather than recreating the deleted one and riding Hetzner's
  // delete→same-name-recreate propagation worst case (registry-500 RCA,
  // run 32013980356: NoSuchBucket flapping >10min at the in-cluster
  // registry). No rotation when the bucket survived — that would strand the
  // warm bucket — and legacy projects without the key never gain one here.
  if (ctx.results?.s3Bucket && updatedConfig.storageBucketGeneration) {
    updatedConfig.storageBucketGeneration = generateBucketSalt();
  }
  saveProjectConfig(updatedConfig);
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
      hint: `Set ${row.tokenEnv} and re-run destroy, or remove the apex and wildcard A records by hand; they point at a released IP.`,
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
    const { deletedAny, preservedTargets } = await dns.deleteApexAndWildcard(
      token,
      zoneId,
      envConfig.domain,
      ownedWithSentinel,
    );
    if (deletedAny) results.dns.push(envConfig.domain);
    if (preservedTargets.length > 0) {
      s.stop(`DNS records preserved (unowned target(s): ${preservedTargets.join(', ')})`);
    } else {
      s.stop(deletedAny ? 'DNS records deleted' : 'DNS records not found');
    }
    recordPreservedDnsRecords(results.leaks, preservedTargets, envConfig.domain, row.name);
  } catch (error) {
    s.stop(`DNS deletion failed: ${error.message}`);
    results.leaks.leak({
      resourceClass: 'dns-record',
      resource: `${envConfig.domain} (${row.name} zone ${zoneId})`,
      reason: `delete failed: ${error.message}`,
      hint: 'Remove the apex and wildcard records by hand; they now point at a released IP, and a stale record shadows the next deploy (and its DNS-01 wildcard challenge).',
    });
  }

  // Reap the DNS-01 challenge residue. These are the ACME client's records,
  // not ours, which is exactly why the A-record delete above never touched
  // them and why they accumulated across every destroy (2026-08-10 audit: 12
  // tokens under one `_acme-challenge.e1`). See lib/acme-challenge.js.
  s.start(`Deleting ACME challenge records for ${envConfig.domain}`);
  const challenge = await reapChallengeRecords({ dns, token, zoneId, domain: envConfig.domain });
  if (challenge.error) {
    s.stop(`ACME challenge cleanup failed: ${challenge.error.message}`);
    results.leaks.leak({
      resourceClass: 'dns-record',
      resource: `_acme-challenge.${envConfig.domain} (${row.name} zone ${zoneId})`,
      reason: `challenge-record delete failed: ${challenge.error.message}`,
      hint: 'Delete the `_acme-challenge` TXT record by hand — a stale one shadows the next DNS-01 wildcard challenge for this name.',
    });
  } else {
    results.dns.push(...challenge.names);
    s.stop(
      challenge.deleted > 0
        ? `ACME challenge records deleted (${challenge.deleted} token(s))`
        : 'No ACME challenge records found',
    );
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
        hint: 'Delete it in the Cloudflare dashboard (Traffic → Health Checks); it keeps probing a released IP.',
      });
    }
  }
}

async function destroyComposeHATier({
  envConfig,
  projectConfig,
  environment,
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
      hint: `Check the ${Provider.NAME} console for surviving servers and firewalls, then re-run \`vibecarbon destroy ${environment}\`.`,
    });
  }

  // Backstop, and the reason this runs even when the helper THREW: the helper
  // deletes by name, and the 2026-08-10 audit found a killed mid-scale run's
  // `-primary-new`/`-standby-new` pair alive after a destroy that reported
  // every listing read in full. resolveHaServers now walks those names too;
  // this sweep is what turns anything either of them still misses into a LEAK
  // or UNVERIFIED line instead of silence.
  if (!providerToken) return;
  const s3 = tracker.spinner();
  s3.start('Checking for surviving environment servers');
  const { deleted: sweptServers, scanned } = await sweepEnvironmentServers({
    provider: new Provider(providerToken),
    leaks: results.leaks,
    projectName: projectConfig.projectName,
    environment,
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
  const serverIp = envConfig.servers?.[0]?.ip;
  const sshKeyPath = join(cwd, '.vibecarbon', `deploy_key_${environment}`);

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
  const serverId = envConfig.servers?.[0]?.id;
  // The `name` field in envConfig.servers is a role label ("master") set by
  // the orchestrator, not the Hetzner-assigned hostname. Pulumi's compose
  // program names the server `${projectName}-${environment}`. The
  // orchestrator persists that under `providerServerName`; configs older
  // than that change only have role-style names, so derive the Pulumi name
  // as a deterministic fallback — looking up "master" in Hetzner never
  // matches and leaks the VPS.
  const providerServerName =
    envConfig.servers?.[0]?.providerServerName || `${projectConfig.projectName}-${environment}`;
  if (serverId && providerToken) {
    s.start(`Deleting VPS (${serverIp})...`);
    try {
      const deleted = await provider.deleteServer(serverId, { waitUntilGone: true });
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
        hint: `Delete it via the ${Provider.NAME} console — it keeps billing, and its name blocks the next deploy with "name is already used (uniqueness_error)".`,
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
        const deleted = await provider.deleteServer(server.id, { waitUntilGone: true });
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
          hint: `Delete it via the ${Provider.NAME} console — a leaked firewall makes the next deploy fail with "name is already used (uniqueness_error)".`,
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
        hint: `Delete it via the ${Provider.NAME} console — a leaked firewall makes the next deploy fail with "name is already used (uniqueness_error)".`,
      });
    }
  }

  // Delete Hetzner SSH key.
  // Pulumi names the key
  //   `${projectName}-${environment}-${location}-key`
  // — the location suffix is what kept the old `vibecarbon-` prefix from
  // ever matching. Same root cause as the firewall above.
  const composeRegion = envConfig.region || envConfig.servers?.[0]?.region;
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
        hint: `Delete it via the ${Provider.NAME} console — a leaked key blocks the next deploy's key registration by name.`,
      });
    }
  }

  // DNS cleanup is ownership-filtered (plan.ownedIps): only records pointing at
  // this env's server IPs are deleted. Shared zones (e.g. parallel e2e
  // scenarios on the same root domain) used to lose neighbours' records here.
  await cleanupDnsRecords({ envConfig, ownedIps, providerToken, s, results });
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
 * (servers and/or a floating/reserved IP persisted at deploy time), a
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
 * @param {object} params.results - the shared destroy `results` accumulator (mutated).
 * @param {string} params.providerName - `Provider.NAME`, for the issue hint.
 * @returns {boolean} true if recorded as a verified success.
 */
export function recordPulumiDestroyOutcome({
  destroyResult,
  envConfig,
  stackEnv,
  dirLabel,
  results,
  providerName,
}) {
  const hasRecordedInfra =
    (envConfig.servers || []).length > 0 ||
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
        'SSH key, reserved/floating IP), then re-run `vibecarbon destroy` to retry against ' +
        'the same Pulumi state.',
    });
    return false;
  }

  results.servers.push('(all via Pulumi)');
  results.firewalls.push('(all via Pulumi)');
  results.sshKeys.push('(all via Pulumi)');
  return true;
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
 * k8s / k8s-ha: Cloudflare + Hetzner DNS, then Pulumi-managed infra teardown
 * (volume pre-scan, CCM LB cleanup, CSI release, CA-worker sweep, `pulumi
 * destroy` per stack, orphan sweep, HA shared-key delete), then orphaned CSI
 * volume cleanup. plan.stackEnvs already differs for k8s vs k8s-ha, so a single
 * function serves both.
 */
async function destroyK8sTier({
  plan,
  envConfig,
  projectConfig,
  environment,
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

  // Volume IDs collected from ALL cluster servers (master, supabase, workers)
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

  // 1. Delete DNS resources first (while servers still exist for reference) —
  // registry-driven, ownership-filtered, incl. provider health checks.
  await cleanupDnsRecords({ envConfig, ownedIps, providerToken, s, results });

  // 2. Delete Pulumi-managed cloud resources
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
      const kubeconfigPath = join(cwd, '.vibecarbon', `kubeconfig-${stackEnv}`);
      const dirLabel = isHAK8s ? ` (${stackEnv})` : '';
      const capture = captureClusterCsiVolumes(kubeconfigPath, { timeoutSeconds: 20 });
      if (capture.ok) {
        allClusterVolumeIds.push(...capture.volumeIds);
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
      const failed = captures.filter(({ capture }) => !capture.ok);
      results.leaks.unverified({
        resourceClass: 'volume',
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
            allClusterVolumeIds.push(...provider.serverVolumeIds(server));
            // clusterLocations feeds cleanupOrphanedVolumes's
            // isPvcInClusterLocation fallback — the ONLY thing that catches a
            // CSI volume already DETACHED before destroy runs (pod scaled
            // down, node gone from a partial teardown): DO CSI volumes carry
            // no tags (see volumeLabels' doc) and their pvc-<uuid> names
            // contain no cluster/server name, so without this a detached DO
            // volume is caught by nothing and leaks. serverRegion (Task 7 fix
            // round 1) reads the provider-native region/location field —
            // Hetzner's `datacenter.location.name`, DO's `region.slug`.
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
          resourceClass: 'volume',
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
        const kubeconfigPath = join(cwd, '.vibecarbon', `kubeconfig-${stackEnv}`);
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
          const caResult = await cleanupAutoscalerWorkers(provider, caClusterName);
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

    const { destroyK8s: destroyK8sStack } = await import('./lib/deploy/k8s/index.js');
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
            results,
            providerName: Provider.NAME,
          });
          console.log(
            verified
              ? `  Pulumi infrastructure destroyed${dirLabel}`
              : `  Pulumi destroy for "${stackEnv}"${dirLabel} looks unverified — see the destroy summary's issues`,
          );
        } catch (error) {
          results.pulumiDestroyFailed = true;
          console.log(`  Pulumi destroy failed${dirLabel}: ${error.message}`);
          p.log.warn(
            `You may need to manually clean up resources${dirLabel} in the ${Provider.NAME} console.`,
          );
          results.leaks.unverified({
            resourceClass: 'pulumi-stack',
            resource: `${stackEnv}${dirLabel}`,
            reason: `pulumi destroy failed: ${error.message}, every Pulumi-managed resource in this stack (servers, firewall, network, SSH key, floating IP) is unverified`,
            hint: `Check for leftover resources in the ${Provider.NAME} console, then re-run \`vibecarbon destroy\` to retry, Pulumi state was preserved for this stack.`,
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
          labels.project === projectConfig.projectName &&
          clusterNames.some(
            (cn) => labels.environment === cn.replace(`${projectConfig.projectName}-`, ''),
          )
        );
      });
      if (orphanedServers.length > 0) {
        s.stop(`Found ${orphanedServers.length} orphaned server(s)`);
        for (const sv of orphanedServers) {
          s.start(`Deleting orphaned server: ${sv.name} (${Provider.getPublicIP(sv) || sv.id})`);
          try {
            await provider.deleteServer(sv.id, { waitUntilGone: true });
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
              hint: `Delete it via the ${Provider.NAME} console; it is outside Pulumi state, so no destroy retry will reach it.`,
            });
          }
        }
      } else if (!complete) {
        s.stop('Orphaned-server check inconclusive, server listing was incomplete');
        results.leaks.unverified({
          resourceClass: 'server',
          resource: `orphaned-server scan: ${clusterNames.join(', ')}`,
          reason:
            'the server listing came back incomplete, so "no orphaned servers" could not be established',
          hint: `Check the ${Provider.NAME} console for servers labelled project=${projectConfig.projectName} in this environment.`,
        });
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

    // DO-only name/address backstop (M3 Task 9f). Two live DO k8s destroys
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
    // never been observed to leak these, so it gets none of this — only the
    // ownedIps fix above (its k8s DNS record was the actual gap there).
    // k8s-ha is Hetzner-only (assertTierSupported), so `environment` here
    // is always the single DO cluster's own stack name — no HA fan-out.
    if (providerIdFor(envConfig) === 'digitalocean' && providerToken) {
      const doClusterName = `${projectConfig.projectName}-${environment}`;

      // Firewall — literal name from digitalocean-k8s.js: `${clusterName}-firewall`.
      const doFwName = `${doClusterName}-firewall`;
      s.start(`Verifying DO firewall is gone: ${doFwName}`);
      try {
        const result = await provider.deleteFirewallByName(doFwName);
        if (result.deleted) {
          results.firewalls.push(doFwName);
          s.stop('Firewall deleted (backstop)');
        } else if (result.apiError) {
          s.stop(`Firewall backstop failed: ${result.apiError.message}`);
          results.leaks.leak({
            resourceClass: 'firewall',
            resource: doFwName,
            reason: `backstop delete did not complete: ${result.apiError.message}`,
            hint: `Delete it via the ${Provider.NAME} console — a leaked firewall makes the next deploy fail with "name is already used (uniqueness_error)".`,
          });
        } else {
          s.stop('Firewall already gone (Pulumi)');
        }
      } catch (error) {
        s.stop(`Firewall backstop check failed: ${error.message}`);
        results.leaks.unverified({
          resourceClass: 'firewall',
          resource: doFwName,
          reason: `backstop check threw: ${error.message}, could not confirm it is gone`,
          hint: `Delete it via the ${Provider.NAME} console — a leaked firewall makes the next deploy fail with "name is already used (uniqueness_error)".`,
        });
      }

      // SSH key — literal name from digitalocean-k8s.js:
      // `${clusterName}-${config.location}-key` (config.location === envConfig.region).
      const doSshKeyName = envConfig.region ? `${doClusterName}-${envConfig.region}-key` : null;
      if (doSshKeyName) {
        s.start(`Verifying DO SSH key is gone: ${doSshKeyName}`);
        try {
          const deleted = await provider.deleteSSHKeyByName(doSshKeyName);
          if (deleted) results.sshKeys.push(doSshKeyName);
          s.stop(deleted ? 'SSH key deleted (backstop)' : 'SSH key already gone (Pulumi)');
        } catch (error) {
          s.stop(`SSH key backstop check failed: ${error.message}`);
          results.leaks.unverified({
            resourceClass: 'ssh-key',
            resource: doSshKeyName,
            reason: `backstop check threw: ${error.message}, could not confirm it is gone`,
            hint: `Delete it via the ${Provider.NAME} console — a leaked key blocks the next deploy's key registration by name.`,
          });
        }
      }

      // Reserved IP — unnamed on DO; attribution is the address persisted
      // into envConfig.floatingIp at deploy time (orchestrator.js). Also
      // feeds plan.ownedIps above so the DNS record finally matches.
      //
      // This backstop is not belt-and-braces here, it is THE mechanism: the
      // reserved IP is the one resource `pulumi destroy` has been observed to
      // leave behind every time. The upstream provider defects that explain it
      // (a Delete that never unassigns + an assignment resource that deletes
      // itself from state on refresh) are written up at the
      // `digitalocean.ReservedIp` construction site in
      // src/lib/iac/programs/digitalocean-k8s.js. By the time this runs the
      // droplets are gone, so the IP is unassigned and a plain DELETE works.
      if (envConfig.floatingIp) {
        s.start(`Verifying DO reserved IP is gone: ${envConfig.floatingIp}`);
        try {
          const deleted = await provider.deleteReservedIpByAddress(envConfig.floatingIp);
          s.stop(deleted ? 'Reserved IP released (backstop)' : 'Reserved IP backstop failed');
          if (!deleted) {
            results.leaks.leak({
              resourceClass: 'reserved-ip',
              resource: envConfig.floatingIp,
              reason: 'backstop delete did not release it',
              hint: `Delete it via the ${Provider.NAME} console (Networking → Reserved IPs); it continues to incur a small charge until released.`,
            });
          }
        } catch (error) {
          s.stop(`Reserved IP backstop check failed: ${error.message}`);
          results.leaks.unverified({
            resourceClass: 'reserved-ip',
            resource: envConfig.floatingIp,
            reason: `backstop check threw: ${error.message}, could not confirm it is released`,
            hint: `Delete it via the ${Provider.NAME} console (Networking → Reserved IPs); it continues to incur a small charge until released.`,
          });
        }
      }

      // VPC LAST — DO refuses to delete a non-empty VPC (still-attached
      // droplets/load balancers/etc respond non-2xx). By this point Pulumi
      // + every sweep above should have cleared every member; a refusal
      // here is therefore a genuine ordering bug elsewhere, not a
      // not-found — surface it loudly rather than swallow it.
      const doNetworkName = `${doClusterName}-network`;
      s.start(`Verifying DO VPC is gone: ${doNetworkName}`);
      try {
        const result = await provider.deleteNetworkByName(doNetworkName);
        if (result.deleted) {
          s.stop('VPC deleted (backstop)');
        } else if (result.apiError) {
          s.stop(`VPC backstop failed: ${result.apiError.message}`);
          results.leaks.leak({
            resourceClass: 'network',
            resource: doNetworkName,
            reason: `delete refused (likely still has members): ${result.apiError.message}`,
            hint: `Check the ${Provider.NAME} console for leftover droplets/load balancers/database clusters in this VPC, delete them, then delete the VPC manually.`,
          });
        } else {
          s.stop('VPC already gone (Pulumi)');
        }
      } catch (error) {
        s.stop(`VPC backstop check failed: ${error.message}`);
        results.leaks.unverified({
          resourceClass: 'network',
          resource: doNetworkName,
          reason: `backstop check threw: ${error.message}, could not confirm it is gone`,
          hint: `Check the ${Provider.NAME} console for a surviving VPC and any droplets/load balancers still inside it.`,
        });
      }
    }

    // HA k8s: delete the shared SSH key created OUTSIDE Pulumi by
    // src/lib/deploy/k8s/ha/index.js (named `${project}-${env}-ha-key`).
    // Both Pulumi stacks reference it via `existingSshKeyId`, so neither
    // stack's destroy removes it — without this manual cleanup it leaks
    // on every HA destroy and the next preflight scan blocks the matrix
    // (RCA from k8s-ha 2026-04-30: post-destroy sweep flagged the same
    // key as REGRESSION every run).
    if (isHAK8s && providerToken) {
      const haSshKeyName = `${projectConfig.projectName}-${environment}-ha-key`;
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
  }

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
        for (const sv of remaining) {
          const labels = provider.serverLabels(sv);
          const isOurs =
            labels.project === projectConfig.projectName &&
            clusterNames.some(
              (cn) => labels.environment === cn.replace(`${projectConfig.projectName}-`, ''),
            );
          if (isOurs) continue;
          const region = provider.serverRegion(sv);
          if (region) foreignRegions.add(region);
        }
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
    // unknown and may be ours (unverified — exit-failing).
    for (const volume of deferred) {
      const entry = {
        resourceClass: 'volume',
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
        hint: `Check the ${Provider.NAME} console (Volumes) for unattached pvc-* volumes in this environment's region(s), or re-run the destroy once the API settles.`,
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
 *   - leak/unverified in the ledger → the stack state is the only record of
 *     what may still be deployed; keep the evidence (same principle that
 *     retains the state bucket). foreign/risk do NOT retain — our own
 *     teardown is verified clean (mirrors destroyExitCode's policy).
 *   - recorded s3 backend but unresolvable credentials → removing would run
 *     against the file:// fallback, "succeed" against the wrong backend,
 *     and leave the real stale stack alive. Skip loudly instead.
 *
 * Per-stack failures land as `unverified pulumi-stack` ledger entries (a
 * retained stale stack fails the next re-deploy on the vultr class), and
 * the loop continues so compose-ha's second stack still gets reconciled.
 */
async function removePulumiStackStateEffect(ctx) {
  const { plan, envConfig, projectConfig, environment, results, spinner: s } = ctx;

  const counts = results.leaks.counts();
  if (counts.leak + counts.unverified > 0) {
    p.log.warn(
      `Pulumi stack state retained for ${plan.stackEnvs.join(', ')}: the teardown recorded ` +
        `${counts.leak} leak(s) / ${counts.unverified} unverified — the state file is the ` +
        'record of what may still be deployed. It is removed by the next clean destroy.',
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
    },
  );
  if (envConfig.s3 && !s3Config) {
    s.start('Pulumi stack state');
    s.stop(
      'Pulumi stack state retained: state-backend credentials could not be resolved, and ' +
        'removing against the local fallback backend would miss the real stack. Re-run ' +
        `\`vibecarbon destroy ${environment}\` with object-storage credentials available.`,
    );
    return;
  }

  const { removeStackState } = await import('./lib/iac/index.js');
  for (const stackEnv of plan.stackEnvs) {
    s.start(`Removing Pulumi stack state: ${stackEnv}`);
    try {
      const { removed } = await removeStackState(stackEnv, {
        projectName: projectConfig.projectName,
        provider: providerIdFor(envConfig),
        s3Config,
      });
      s.stop(
        removed
          ? `Pulumi stack state removed: ${stackEnv}`
          : `Pulumi stack state already absent: ${stackEnv}`,
      );
    } catch (error) {
      s.stop(`Failed to remove Pulumi stack state: ${error.message}`);
      results.leaks.unverified({
        resourceClass: 'pulumi-stack',
        resource: stackEnv,
        reason: `stack-state removal failed: ${error.message}`,
        hint:
          'The retained stack still describes deleted resources; the next deploy of this ' +
          'environment may fail deleting them (provider 404s). Re-run ' +
          `\`vibecarbon destroy ${environment}\` to reconcile.`,
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
 */
function finishThenReport(stepLabel, effect) {
  return async (ctx, args) => {
    try {
      await effect(ctx, args);
    } catch (error) {
      p.log.error(`Destroy step "${stepLabel}" failed: ${error.message}`);
      ctx.results.leaks.unverified({
        resourceClass: 'destroy-step',
        resource: stepLabel,
        reason: `step threw: ${error.message}, anything it had not yet deleted is unaccounted for`,
        hint: `Re-run \`vibecarbon destroy ${ctx.environment}\` once the cause is addressed; the remaining teardown steps still ran.`,
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
        }
      }

      p.outro('Orphan cleanup complete');
      process.exit(0);
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

  // Show what will be deleted
  const serverList =
    envConfig.servers?.map((s) => `    ${c.error('•')} ${s.name} (${s.ip})`).join('\n') ||
    '    None';

  // SSH-key line below: the old string was `vibecarbon-${projectName}-${envName}`,
  // which never matched anything created (same-shaped fixes above for the
  // firewall/SSH-key deletion logic, and compose/ha.js — SANCTIONED
  // DEVIATION #2). The exact suffix is tier-dependent (`-key`, `-ha-key`,
  // `-${location}-key`), but every tier's real name starts with this
  // `${projectName}-${envName}` slug — same shape as confirmSlug below.
  p.note(
    `
${c.danger('This will permanently delete:')}

${c.bold('Servers:')}
${serverList}

${c.bold('Firewalls:')}
${envConfig.servers?.map((s) => `    ${c.error('•')} ${s.name}-fw`).join('\n') || '    None'}

${c.bold('SSH Keys:')}
    ${c.error('•')} ${projectConfig.projectName}-${envName}

${
  hasAutomatedDns(envConfig.dns?.provider)
    ? `${c.bold(`${DNS_PROVIDERS[envConfig.dns.provider].name} Resources:`)}
    ${c.error('•')} DNS records: ${envConfig.domain} (apex + wildcard)
    ${DNS_PROVIDERS[envConfig.dns.provider].healthChecks ? `${c.error('•')} Health checks` : ''}
`
    : ''
}
${
  envConfig.s3?.bucket
    ? `${c.bold('S3 Storage:')}
    ${c.error('•')} Bucket: ${envConfig.s3.bucket} (all objects will be deleted)
`
    : ''
}${
  envConfig.backupS3?.bucket
    ? `${c.bold('S3 Backups:')}
    ${args.purgeBackups ? `${c.error('•')} Bucket: ${envConfig.backupS3.bucket} (WILL BE DELETED — --purge-backups)` : `${c.success('•')} Bucket: ${envConfig.backupS3.bucket} (PRESERVED for recovery)`}
`
    : ''
}
${c.bold('GitHub:')}
    ${c.error('•')} Environment: ${envName}

${c.danger('WARNING: All data on these servers will be permanently lost!')}
  `,
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
    if (args.yes && needsProdConfirm) {
      p.log.warn(
        `Destroying a production environment still requires type-to-confirm, even with -y.`,
      );
    }
    const doubleConfirm = await p.text({
      message: `Type "${confirmSlug}" to confirm:`,
      validate: (v) => (v !== confirmSlug ? `Please type "${confirmSlug}" to confirm` : undefined),
    });
    if (p.isCancel(doubleConfirm)) {
      exitCancelled();
    }
  }

  // Offer to create a backup before destroying
  const serverIp = envConfig.servers?.[0]?.ip;
  const sshKeyPath = join(cwd, '.vibecarbon', `deploy_key_${envName}`);
  if (serverIp && existsSync(sshKeyPath) && !args.yes) {
    const offerBackup = await p.confirm({
      message: 'Create a backup before destroying? (recommended)',
      initialValue: true,
    });

    if (!p.isCancel(offerBackup) && offerBackup) {
      const backupSpinner = spinner();
      backupSpinner.start('Creating backup...');
      try {
        if (isComposeTier(resolveTier(envConfig))) {
          const { backupCompose } = await import('./lib/deploy/compose/index.js');
          await backupCompose(serverIp, sshKeyPath, projectConfig.projectName, {
            retain: envConfig.backup?.retentionDays,
          });
          backupSpinner.stop('wal-g base backup pushed to S3');
        }
      } catch (backupError) {
        backupSpinner.stop(`Backup failed: ${backupError.message}`);
        p.log.warn('Continuing with destroy...');
      }
    }
  }

  // Get API tokens (env var → interactive prompt)
  // Resolved once per flow — see providerFor() in lib/providers/index.js.
  const Provider = providerFor(envConfig);
  const providerToken = await Provider.promptApiToken(projectConfig.projectName);
  if (!providerToken) {
    p.log.error(`${Provider.NAME} API token is required`);
    process.exit(1);
  }

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
      p.log.info(`✓ Using ${dnsRow.name} API token from ${dnsRow.tokenEnv} environment variable`);
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
  };

  // ========== PRE-TEARDOWN: S3-CONFIG / KEYS MISMATCH ==========
  // Runs BEFORE anything is deleted, which is the whole point: if the config
  // records a bucket and the environment has no object-storage credentials,
  // the operator can export the keys (or Ctrl-C) while it is still cheap,
  // instead of finding the stranded bucket in the leak report afterwards. The
  // entries are leak-RISK — reported, not exit-failing; each bucket's ACTUAL
  // outcome is recorded by its own delete effect later (see leak-ledger.js's
  // destroyExitCode for the full reasoning).
  for (const risk of checkS3CredentialMismatch({
    envConfig,
    envKeys: Provider.OBJECT_STORAGE_ENV,
    purgeBackups: args.purgeBackups,
    canPrompt: !!process.stdin.isTTY,
  })) {
    p.log.warn(`Object storage: ${risk.reason}`);
    p.log.message(`  ${c.dim(risk.hint)}`);
    results.leaks.risk(risk);
  }

  // ========== TIER DISPATCH (step-plan) ==========
  // planDestroyTargets derives every teardown target from persisted config
  // (ownership-aware; HA → both stack envs). planDestroy(tier) yields the pure,
  // ordered teardown step sequence (tier teardown → buckets-last tail); runPlan
  // executes those steps against the destroy effect registry. The plan targets,
  // the isK8s tail flag, and every credential/tracker/results handle ride on
  // ctx so the effects (thin wrappers over the hardened tier helpers) read them.
  const plan = planDestroyTargets(envConfig, projectConfig, envName);
  const isK8s = isK8sTier(plan.tier);

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
  retainStateBucket,
  SPEC,
  saveProjectConfig,
  VERSION,
};
