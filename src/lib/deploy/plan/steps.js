/**
 * Shared step building-block factories.
 *
 * Each factory returns a PURE step descriptor (via defineStep) that names an
 * effect in the registry and, for conditional operations, a `when(ctx)`
 * predicate the runner evaluates at execution time against the live ctx.
 * Planners (deploy-plan.js, and later scale/restore/destroy) compose these
 * so the ordered sequence of a tier is declared in one readable place while
 * all I/O stays in the effect registry.
 *
 * These mirror, one-for-one, the operations the inlined compose-single path
 * ran — the `when` predicates reproduce its exact conditionals so the
 * step-plan is behavior-identical.
 */
import { hasAutomatedDns } from '../../dns-provider.js';
import { defineStep } from './step.js';

/** Provision a fresh Hetzner VPS — only when no server IP is known yet. */
export const provisionServerStep = () =>
  defineStep({ name: 'provision-server', effect: 'provisionServer', when: (ctx) => !ctx.serverIp });

/** Wait for cloud-init (and, for local/direct modes, dockerd) to be ready. */
export const setupServerStep = () => defineStep({ name: 'setup-server', effect: 'setupServer' });

/** Ship the app image to the server (local sideload or direct remote build). */
export const transferImageStep = () =>
  defineStep({
    name: 'transfer-image',
    effect: 'transferImage',
    when: (ctx) => !!(ctx.isComposeLocal || ctx.isDirectDeploy),
  });

/** Authenticate the server to Docker Hub — only when creds are configured. */
export const dockerhubLoginStep = () =>
  defineStep({
    name: 'dockerhub-login',
    effect: 'dockerhubLogin',
    when: (ctx) => !!ctx.dockerHubCreds,
  });

/** Authenticate the server to GHCR — only when CI produced pull creds. */
export const ghcrLoginStep = () =>
  defineStep({
    name: 'ghcr-login',
    effect: 'ghcrLogin',
    when: (ctx) => !!ctx.ciReady?.ghcrPullCreds,
  });

/** Tar + stream the rendered bundle to the server and install the unit file. */
export const setupServerFilesStep = () =>
  defineStep({ name: 'setup-server-files', effect: 'setupServerFiles' });

/**
 * Write the real DNS A record and (HTTP-01 only) wait for propagation BEFORE
 * compose-up. Managed-DNS providers with a domain only.
 */
export const updateDnsStep = () =>
  defineStep({
    name: 'update-dns',
    effect: 'updateDns',
    when: (ctx) => !!(ctx.domain && hasAutomatedDns(ctx.dnsProvider)),
  });

/** Reconcile the Docker Compose stack (`docker compose pull` + `up -d`). */
export const startComposeStackStep = () =>
  defineStep({ name: 'start-compose-stack', effect: 'startComposeStack' });

/**
 * Apply supabase/migrations/* + the two ground-truth audits (RLS, wal-g
 * backups) + reload PostgREST (shipped-bug guard). Either audit fails the step.
 */
export const runMigrationsStep = () =>
  defineStep({ name: 'run-migrations', effect: 'runMigrations' });

/** Create the production super-admin via GoTrue admin API (shipped-bug guard). */
export const createAdminUserStep = () =>
  defineStep({ name: 'create-admin-user', effect: 'createAdminUser' });

/** Gate deploy success on the app's own /api/health probe. */
export const verifyHealthStep = () => defineStep({ name: 'verify-health', effect: 'verifyHealth' });

/**
 * Gate deploy success on the domain serving a TRUSTED TLS certificate (the
 * ssl_valid contract, enforced at the source). Shared verbatim by the
 * compose-ha plan — the effect reads the primary's identity from either ctx
 * shape. Skipped when the deploy has no domain to probe.
 */
export const verifyTlsReadyStep = () =>
  defineStep({ name: 'verify-tls', effect: 'verifyTlsReady', when: (ctx) => Boolean(ctx.domain) });

/** Install the scheduled wal-g backup cron on the VPS (shipped-bug guard). */
export const setupBackupCronStep = () =>
  defineStep({ name: 'setup-backup-cron', effect: 'setupBackupCron' });

// ============================================================================
// compose-ha step factories
//
// These mirror, block-for-block, the operations the (now removed) inlined
// `deployComposeHA` ran over the primary+standby pair, in order. Step NAMES
// reuse the single-compose names where the operation is conceptually shared
// (setup-server-files, start-compose-stack, run-migrations, create-admin-user,
// update-dns, setup-backup-cron) so the read symmetry with the single plan is
// visible; the EFFECTS are HA-specific (`ha*` registry keys) because they
// fan out across two nodes and carry `deploy.ha.compose.*` perf labels — a
// behavior-identity requirement that rules out reusing the single-node
// effects verbatim.
//
// The ctx contract these effects share (documented once here, reused by the
// k8s-ha planner in a later task):
//   ctx.primary  = { ip, serverId }   // filled by ha-provision-servers
//   ctx.standby  = { ip, serverId }
//   ctx.standbyRegion                 // resolved secondary region
//   ctx.sharedSshKeyId                // one Hetzner SSH key shared by both stacks
//   ctx.loadedProjectConfig           // on-disk config loaded once, reused by finalize
//   ctx.pendingEnvConfig              // mid-flight env entry (status:'deploying')
//   ctx.replActive / ctx.degraded     // replication verdict (verify-streaming)
//   ctx.isLocalOnlyImage              // precomputed remote-build gate (pure)
// ============================================================================

/** Provision BOTH VPS (primary + standby) via two parallel Pulumi stacks. */
export const haProvisionServersStep = () =>
  defineStep({ name: 'provision-servers', effect: 'haProvisionServers' });

/** Persist the mid-flight env entry (status:'deploying') so destroy can recover. */
export const haPersistPendingConfigStep = () =>
  defineStep({
    name: 'persist-pending-config',
    effect: 'haPersistPendingConfig',
    required: true,
  });

/** Wait for SSH on both servers; hard-fail if either times out. */
export const haWaitForSshStep = () => defineStep({ name: 'wait-for-ssh', effect: 'haWaitForSsh' });

/** Seed the per-env known_hosts pin with both servers' real host keys. */
export const haSeedKnownHostsStep = () =>
  defineStep({ name: 'seed-known-hosts', effect: 'haSeedKnownHosts' });

/** cloud-init + firewall + auto-updates on both servers (parallel). */
export const haSetupServersStep = () =>
  defineStep({ name: 'setup-servers', effect: 'haSetupServers' });

/** Wait for dockerd on both servers before any login/pull/build. */
export const haWaitDockerReadyStep = () =>
  defineStep({ name: 'wait-docker-ready', effect: 'haWaitDockerReady' });

/** Build the app image natively on both servers — only for a local-only tag. */
export const haRemoteBuildStep = () =>
  defineStep({
    name: 'remote-build',
    effect: 'haRemoteBuild',
    when: (ctx) => !!ctx.isLocalOnlyImage,
  });

/** Fan-out setup: bundle upload + WG firewall (UFW + Cloud) + registry logins. */
export const haSetupServerFilesStep = () =>
  defineStep({ name: 'setup-server-files', effect: 'haSetupServerFiles' });

/** Write WALG_ROLE (primary/standby) into each node's .env (write-guard). */
export const haMergeWalgRoleStep = () =>
  defineStep({ name: 'merge-walg-role', effect: 'haMergeWalgRole' });

/** Pull app + base images on both servers (parallel). */
export const haPullImagesStep = () => defineStep({ name: 'pull-images', effect: 'haPullImages' });

/** Managed-DNS HA (Cloudflare/Hetzner) or manual instructions + HTTP-01 wait. */
export const haUpdateDnsStep = () => defineStep({ name: 'update-dns', effect: 'haUpdateDns' });

/** Reconcile the Compose stack on both servers (parallel). */
export const haStartComposeStackStep = () =>
  defineStep({ name: 'start-compose-stack', effect: 'haStartComposeStack' });

/**
 * Apply app migrations on the PRIMARY only, plus the RLS + wal-g backup audits
 * that ride along inside runMigrations (shipped-bug guard). The standby is
 * deliberately not audited — see src/lib/deploy/walg-audit.js.
 */
export const haRunMigrationsStep = () =>
  defineStep({ name: 'run-migrations', effect: 'haRunMigrations' });

/** Create the production super-admin on the PRIMARY (shipped-bug guard). */
export const haCreateAdminUserStep = () =>
  defineStep({ name: 'create-admin-user', effect: 'haCreateAdminUser' });

/** Poll the primary's Postgres until it accepts connections (pre-replication). */
export const haWaitPrimaryPostgresStep = () =>
  defineStep({ name: 'wait-primary-postgres', effect: 'haWaitPrimaryPostgres' });

/** Write docker-compose.replication.yml to both nodes + recreate the db service. */
export const haWriteReplicationOverlayStep = () =>
  defineStep({ name: 'write-replication-overlay', effect: 'haWriteReplicationOverlay' });

/** Bring up the WireGuard tunnel + configure primary + seed standby (one perf span). */
export const haConfigureReplicationStep = () =>
  defineStep({
    name: 'configure-replication',
    effect: 'haConfigureReplication',
    required: true,
  });

/** Verify streaming on the primary; hard-gate unless -allow-degraded. */
export const haVerifyStreamingStep = () =>
  defineStep({ name: 'verify-streaming', effect: 'haVerifyStreaming', required: true });

/** Install the scheduled wal-g backup cron on BOTH nodes (allSettled + warn). */
export const haSetupBackupCronStep = () =>
  defineStep({ name: 'setup-backup-cron', effect: 'haSetupBackupCron' });

/** Promote pending → deployed, register the project, print the summary. */
export const haFinalizeConfigStep = () =>
  defineStep({ name: 'finalize-config', effect: 'haFinalizeConfig', required: true });

// ============================================================================
// k8s (single-cluster) step factory
//
// deployK3s is a cohesive, internally state-gated pipeline (Pulumi up →
// wait-ready → kubeconfig → build → sideload → applyK3sManifests) that k8s-ha
// reuses VERBATIM, running two copies in parallel with per-cluster isolation.
// Cracking it into separate effects would break that isolation and risk drift
// on a hardened path, so — per the Task 5 brief's "wrap the existing function
// rather than inlining it" — the single-cluster deploy is ONE step wrapping
// deployK3s as a black box (perf span `deploy.k3s.full`). This same per-cluster
// block is what the k8s-ha planner fans out ×2.
// ============================================================================

/** Provision + deploy a single k3s cluster (wraps deployK3s as a black box). */
export const k8sDeployClusterStep = () =>
  defineStep({ name: 'deploy-cluster', effect: 'k8sDeployCluster' });

// ============================================================================
// k8s-ha step factories
//
// These mirror, block-for-block, the top-level phases the (now removed) inlined
// `deployK8sHA` ran, in order. Step NAMES reuse compose-ha's where the operation
// is conceptually shared (configure-replication, verify-streaming, update-dns)
// so the cross-tier read symmetry is visible; the EFFECTS are k8s-ha-specific
// (`ha K8s*` registry keys, kubectl-over-ssh fan-out, `deploy.ha.k8s.*` perf
// labels) because they operate on TWO k3s clusters — a behavior-identity
// requirement that rules out reusing the compose-ha effects.
//
// The heavily-hardened WireGuard replication transport + scale-to-zero reseed
// (setupReplication) and the k3s per-cluster pipeline (deployK3s) are called by
// these effects as BLACK BOXES — this plan only expresses their sequence.
//
// The multi-cluster ctx contract these effects share:
//   ctx.options              // the deploymentConfig deployK8sHA consumed
//   ctx.primaryResult        // deployK3s return for the primary cluster
//   ctx.standbyResult        // deployK3s return for the standby cluster
//   ctx.replicationStatus / ctx.replStreaming / ctx.degraded  // repl verdict
// ============================================================================

/** Generate the shared HA SSH key + print the deployment banner. */
export const haK8sGenerateSshKeyStep = () =>
  defineStep({ name: 'generate-ssh-key', effect: 'haK8sGenerateSshKey' });

/** Upload the shared SSH key to Hetzner once (both stacks reference its ID). */
export const haK8sUploadSshKeyStep = () =>
  defineStep({ name: 'upload-ssh-key', effect: 'haK8sUploadSshKey' });

/** Deploy the primary + standby clusters in parallel (deployK3s ×2). */
export const haK8sProvisionClustersStep = () =>
  defineStep({ name: 'provision-clusters', effect: 'haK8sProvisionClusters' });

/** Open the WireGuard tunnel port (UDP 51821) in both clusters' firewalls. */
export const haK8sOpenReplicationFirewallStep = () =>
  defineStep({ name: 'open-replication-firewall', effect: 'haK8sOpenReplicationFirewall' });

/** Configure PostgreSQL replication (setupReplication — hardened WG transport). */
export const haK8sConfigureReplicationStep = () =>
  defineStep({
    name: 'configure-replication',
    effect: 'haK8sConfigureReplication',
    required: true,
  });

/** Hard-gate the deploy on streaming replication (unless -allow-degraded). */
export const haK8sVerifyStreamingStep = () =>
  defineStep({ name: 'verify-streaming', effect: 'haK8sVerifyStreaming', required: true });

/** Configure managed-DNS HA (Cloudflare/Hetzner) for failover. */
export const haK8sUpdateDnsStep = () =>
  defineStep({ name: 'update-dns', effect: 'haK8sUpdateDns' });

/** Print the Fullerene HA deploy summary + failover-command notes. */
export const haK8sFinalizeStep = () =>
  defineStep({ name: 'finalize', effect: 'haK8sFinalize', required: true });
