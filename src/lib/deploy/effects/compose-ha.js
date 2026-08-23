/**
 * compose-ha deploy effect registry.
 *
 * Each effect is a thin, faithful relocation of the corresponding block from
 * the (now removed) inlined `deployComposeHA` — same operations, same order,
 * same args, same fan-out parallelism, same perf labels (`deploy.ha.compose.*`
 * / `deploy.ha.replication.setup`), same warn/throw/exit semantics. Effects
 * read from and mutate a shared multi-node `ctx`; the replication/WireGuard
 * transport itself is unchanged — these effects call the SAME exported helpers
 * (`configurePrimaryReplication`, `configureStandbyReplication`,
 * `buildReplicationOverlay`, `openWireguardPort*`) that scale/failover/restore
 * reuse.
 *
 * ── ctx contract (multi-server; reused by the k8s-ha planner in a later task) ──
 *   Inputs (set by the orchestrator before runPlan):
 *     projectConfig{projectName, operatorCidrs}, environment, envConfig, region,
 *     secondaryRegion, serverType, services, domain, dnsProvider, apiToken,
 *     dnsZoneId, dnsToken, backupConfig,
 *     backupS3Config, imageRef, bundlePath, s3Config, dockerHubCreds,
 *     ghcrPullCreds, allowDegraded, isLocalOnlyImage, sshKeyPath, onProgress
 *   Filled in by the effects:
 *     standbyRegion, sharedSshKeyId,
 *     primary{ip, serverId}, standby{ip, serverId},
 *     loadedProjectConfig, pendingEnvConfig,
 *     replActive, replLastState, degraded
 */
import { readFileSync } from 'node:fs';
import * as p from '@clack/prompts';
import { c } from '../../colors.js';
import { loadProjectConfig, registerProject, saveProjectConfig } from '../../config.js';
import { DNS_PROVIDERS, getDnsProvider, hasAutomatedDns } from '../../dns-provider.js';
import { knownHostsPathForKey, seedKnownHosts } from '../../host-keys.js';
import { perfAsync } from '../../perf.js';
import { providerFor, providerIdFor } from '../../providers/index.js';
import { useDnsChallenge } from '../acme.js';
import {
  buildReplicationOverlay,
  configurePrimaryReplication,
  configureStandbyReplication,
  openWireguardPortHetznerFirewall,
  openWireguardPortUfw,
} from '../compose/ha.js';
import {
  createAdminUser,
  dockerLoginOnServer,
  pullComposeImages,
  runMigrations,
  setupComposeBackupCron,
  setupServer,
  setupServerFiles,
  sshRun,
  sshRunAsync,
  startComposeStack,
  waitForDockerReady,
  waitForSSH,
} from '../compose/index.js';
import { assertReplicationStreamingOrDegraded, verifyStreaming } from '../replication.js';
import { generateSSHKeyPair, mergeRemoteDotenv, pinnedSshOptsString } from '../utils.js';
import { WG_PRIMARY_IP, WG_STANDBY_IP } from '../wireguard.js';

/** Shared service-opts object rebuilt from ctx (identical to the inline const). */
const haServiceOpts = (ctx) => {
  const services = ctx.services ?? {};
  return {
    domain: ctx.domain,
    image: ctx.imageRef,
    observability: services.observability,
    n8n: services.n8n,
    metabase: services.metabase,
    redis: services.redis,
    bundlePath: ctx.bundlePath,
  };
};

/**
 * Provision BOTH VPS via two parallel Pulumi stacks (one per cluster). Uploads
 * a single shared Hetzner SSH key (both stacks reference its ID — creating the
 * same public key twice is a 409). Pre-inits the S3 Pulumi backend before the
 * parallel up() so a freshly-created bucket doesn't NoSuchBucket-race. Sets
 * ctx.primary / ctx.standby / ctx.standbyRegion / ctx.sharedSshKeyId.
 */
async function haProvisionServers(ctx) {
  const projectName = ctx.projectConfig.projectName;
  const { environment, sshKeyPath, region, apiToken, s3Config, imageRef, envConfig } = ctx;
  if (!imageRef) {
    throw new Error(
      'compose-ha deploy requires ctx.imageRef (ghcr.io/<owner>/<repo>:<tag>), build pipeline changed in Lever 1',
    );
  }
  // Resolved once per flow — see providerFor() in lib/providers/index.js.
  const Provider = providerFor(envConfig);
  // RCA (2026-07-22): this fallback is unreachable in practice — the
  // orchestrator's compose-ha ctx build (deploy/orchestrator.js) already
  // sets ctx.serverType via `serverType || Provider.DEFAULT_COMPOSE_TYPE`
  // before this effect ever runs. Kept as the effect's own defensive
  // default (e.g. direct/test invocation without the orchestrator) and
  // routed through the SAME static as the orchestrator's fallback —
  // DEFAULT_COMPOSE_TYPE, not a separate DEFAULT_COMPOSE_HA_TYPE — so the
  // two can't drift apart again.
  const serverType = ctx.serverType || Provider.DEFAULT_COMPOSE_TYPE;
  ctx.serverType = serverType;
  const provider = new Provider(apiToken);

  // Use the caller-specified secondary region, or the provider's default
  // standby for this primary — a different region on the SAME continent, so
  // an unspecified standby never puts replication on a transatlantic hop
  // (B0: the old COMPOSE_HA_FALLBACK_REGIONS list sent ash/hil to nbg1).
  const standbyRegion = ctx.secondaryRegion || Provider.getDefaultStandbyRegion(region);
  ctx.standbyRegion = standbyRegion;

  // The standby's SKU is resolved FOR ITS OWN REGION, exactly as k8s-ha has
  // always done (effects/k8s-ha.js). An SKU stocked where the primary lives is
  // not necessarily stocked in the standby's region, and plan availability
  // FLUXES — Vultr's per-region plan list moved under us twice in one week
  // (2026-08-08 vs 2026-08-19). Passing the primary's type straight through
  // meant a default compose-HA deploy could provision a primary fine and then
  // fail placing the standby, with an error naming a region the operator never
  // chose (getDefaultStandbyRegion picked it).
  //
  // resolveServerTypeForRegion also carries the ARM->x86 rescue (vibecarbon is
  // amd64-only, see deploy/platform.js), so an environment predating that
  // standardization converges here too.
  const standbyServerType = Provider.resolveServerTypeForRegion(serverType, standbyRegion);
  ctx.standbyServerType = standbyServerType;
  if (standbyServerType !== serverType) {
    p.log.info(
      `Standby server type adjusted for ${standbyRegion}: ${serverType} -> ${standbyServerType}`,
    );
  }

  // Generate SSH key pair
  generateSSHKeyPair(sshKeyPath);
  const publicKey = readFileSync(`${sshKeyPath}.pub`, 'utf-8').trim();

  // Upload SSH key to Hetzner once, then share its ID across both Pulumi stacks.
  const sharedSshKeyName = `${projectName}-${environment}-key`;
  const sharedSshKeyId = String(await provider.createSSHKey(sharedSshKeyName, publicKey));
  ctx.sharedSshKeyId = sharedSshKeyId;

  const { upStack } = await import('../../iac/index.js');
  ctx.onProgress(`Provisioning VPS in ${region} and ${standbyRegion}...`);

  // No backend pre-init here any more. It existed because parallel `stack
  // select` against a just-created bucket raced the backend's own metadata
  // write; the per-bucket state lock (lib/iac/state-lock.js) means the two
  // stack operations below can no longer overlap, so the race it worked around
  // cannot occur. Removing it also drops the `__init` stack create and delete
  // it performed on every HA deploy.
  const allowedSshIps = (ctx.projectConfig.operatorCidrs ?? []).map((e) => e.cidr);
  // CD2 — lazy dispatch through the provider class (no named
  // buildHetznerComposeProgram import) so Phase B providers slot in without
  // editing this file.
  const primaryProgram = await Provider.getComposeProgram({
    projectName,
    environment: `${environment}-primary`,
    sshPublicKey: publicKey,
    existingSshKeyId: sharedSshKeyId,
    location: region,
    serverType,
    labels: { 'managed-by': 'vibecarbon', role: 'primary' },
    allowedSshIps,
  });
  const standbyProgram = await Provider.getComposeProgram({
    projectName,
    environment: `${environment}-standby`,
    sshPublicKey: publicKey,
    existingSshKeyId: sharedSshKeyId,
    location: standbyRegion,
    serverType: standbyServerType,
    labels: { 'managed-by': 'vibecarbon', role: 'standby' },
    allowedSshIps,
  });
  const [primaryResult, standbyResult] = await perfAsync('deploy.ha.compose.iac.upStack.fan', () =>
    Promise.all([
      perfAsync('deploy.ha.compose.iac.upStack.primary', () =>
        upStack(`${environment}-primary`, primaryProgram, {
          provider: providerIdFor(envConfig),
          providerToken: apiToken,
          s3Config,
          projectName,
          // Recover stale-EMPTY outputs reads in place (read-only poll inside
          // upStack); the hard gate below stays the loud last resort. This
          // path is the MOST exposed member of the class: two parallel ups
          // against a possibly-fresh state bucket.
          requiredOutputs: ['serverIp'],
        }),
      ),
      perfAsync('deploy.ha.compose.iac.upStack.standby', () =>
        upStack(`${environment}-standby`, standbyProgram, {
          provider: providerIdFor(envConfig),
          providerToken: apiToken,
          s3Config,
          projectName,
          requiredOutputs: ['serverIp'],
        }),
      ),
    ]),
  );
  // Hard gate, twin of the single-compose one in effects/index.js: a stale S3
  // state read right after stack creation can return a "successful" up with
  // EMPTY outputs. This path is MORE exposed than the single-node one — two
  // upStack calls run in PARALLEL against a state bucket the deploy may have
  // just created — and an undefined ip here cascades into "Primary: undefined",
  // waitForSSH, and a servers[] entry with no address.
  for (const [role, result] of [
    ['primary', primaryResult],
    ['standby', standbyResult],
  ]) {
    if (!result.outputs?.serverIp) {
      throw new Error(
        `provision-ha-servers: Pulumi up returned no serverIp output for the ${role}, ` +
          'almost always a stale S3 state-backend read right after stack creation. ' +
          `Re-run the deploy; if it persists, inspect \`pulumi stack output\` for ` +
          `stack '${environment}-${role}'.`,
      );
    }
  }
  // firewallId is persisted per server so `scale`'s blue-green replacement can
  // re-attach it — each HA node has its OWN firewall (one per stack), so this
  // cannot be an env-level field.
  ctx.primary = {
    ip: primaryResult.outputs.serverIp,
    serverId: primaryResult.outputs.serverId,
    firewallId: primaryResult.outputs.firewallId || null,
  };
  ctx.standby = {
    ip: standbyResult.outputs.serverIp,
    serverId: standbyResult.outputs.serverId,
    firewallId: standbyResult.outputs.firewallId || null,
  };

  p.log.success(`Primary: ${c.info(ctx.primary.ip)} (${region})`);
  p.log.success(`Standby: ${c.info(ctx.standby.ip)} (${standbyRegion})`);
}

/**
 * Persist server info immediately (status:'deploying') so `destroy` can clean
 * up if deploy fails later. Loads the on-disk projectConfig ONCE and stashes it
 * (+ the pending env entry) on ctx for the finalize effect to reuse.
 */
async function haPersistPendingConfig(ctx) {
  const projectName = ctx.projectConfig.projectName;
  const {
    environment,
    envConfig,
    region,
    standbyRegion,
    serverType,
    // Set by haProvisionServers, which resolved it for the standby's OWN
    // region. Read from ctx like standbyRegion beside it — the const in that
    // function is not in scope here, and referencing it bare threw
    // `standbyServerType is not defined` at this very step (live CI l2,
    // 2026-08-20), AFTER both servers were already provisioned.
    standbyServerType,
    primary,
    standby,
    domain,
    dnsProvider,
    dnsZoneId,
    s3Config,
    backupS3Config,
    backupConfig,
    services,
  } = ctx;

  const loadedProjectConfig = loadProjectConfig() || { projectName, environments: {} };
  const pendingEnvConfig = {
    ...envConfig,
    status: 'deploying',
    deployMode: 'compose-ha',
    provider: envConfig.provider ?? 'hetzner',
    region,
    secondaryRegion: standbyRegion,
    serverType,
    ha: { enabled: true, failoverRegion: standbyRegion },
    servers: [
      {
        name: `${projectName}-${environment}-primary`,
        id: primary.serverId,
        ip: primary.ip,
        ...(primary.firewallId && { firewallId: primary.firewallId }),
        region,
        serverType,
        role: 'primary',
      },
      {
        name: `${projectName}-${environment}-standby`,
        id: standby.serverId,
        ip: standby.ip,
        ...(standby.firewallId && { firewallId: standby.firewallId }),
        region: standbyRegion,
        // Its OWN resolved type, not the primary's — scale and failover read
        // this back, and recording the primary's SKU here would send a later
        // resize at a type the standby's region may not stock.
        serverType: standbyServerType,
        role: 'standby',
      },
    ],
    domain: domain || null,
    dnsProvider: dnsProvider || null,
    // Registry-driven: ANY automated backend with a zone persists (the
    // pre-convergence nested ternary returned null for unknown providers —
    // hazard H10, which silently disabled failover's flip and destroy's DNS
    // cleanup). Mirror of orchestrator.js's k8s persist.
    dns:
      hasAutomatedDns(dnsProvider) && dnsZoneId
        ? { provider: dnsProvider, zoneId: dnsZoneId }
        : null,
    // s3.accessKey intentionally NOT persisted — the secret scanner gates every
    // deploy against files in cwd, and .vibecarbon.json has no gitignore/local
    // match. prompts.js falls back to Provider.promptObjectStorageCredentials()
    // (C7d) when accessKey is missing, so runtime still resolves.
    ...(s3Config && {
      s3: {
        bucket: s3Config.bucket,
        region: s3Config.region,
        endpoint: s3Config.endpoint,
        stateBucket: s3Config.stateBucket,
      },
    }),
    ...(backupS3Config && { backupS3: backupS3Config }),
    ...(backupConfig && { backup: backupConfig }),
    services,
    lastAttempt: new Date().toISOString(),
  };
  saveProjectConfig({
    ...loadedProjectConfig,
    provider: envConfig.provider ?? 'hetzner',
    environments: {
      ...loadedProjectConfig.environments,
      [environment]: pendingEnvConfig,
    },
  });
  ctx.loadedProjectConfig = loadedProjectConfig;
  ctx.pendingEnvConfig = pendingEnvConfig;
}

/** Wait for SSH on both servers; hard-fail if either times out. */
async function haWaitForSsh(ctx) {
  const { primary, standby, sshKeyPath } = ctx;
  ctx.onProgress('Waiting for servers to become available...');
  const [primaryReady, standbyReady] = await perfAsync('deploy.ha.compose.waitForSSH.both', () =>
    Promise.all([waitForSSH(primary.ip, sshKeyPath, 30), waitForSSH(standby.ip, sshKeyPath, 30)]),
  );
  if (!primaryReady || !standbyReady) {
    throw new Error('Timed out waiting for SSH on one or both servers');
  }
}

/** Seed the per-env known_hosts pin with BOTH servers' real host keys. */
async function haSeedKnownHosts(ctx) {
  const { primary, standby, sshKeyPath } = ctx;
  const haKnownHostsPath = knownHostsPathForKey(sshKeyPath);
  await seedKnownHosts(haKnownHostsPath, primary.ip);
  await seedKnownHosts(haKnownHostsPath, standby.ip);
}

/** cloud-init + firewall + auto-updates on both servers (parallel). */
async function haSetupServers(ctx) {
  const { primary, standby, sshKeyPath } = ctx;
  ctx.onProgress('Configuring servers...');
  await perfAsync('deploy.ha.compose.cloudInitReady.both', () =>
    Promise.all([setupServer(primary.ip, sshKeyPath), setupServer(standby.ip, sshKeyPath)]),
  );
}

/**
 * Wait for the Docker daemon on both servers before any login/pull/build.
 * dockerLoginOnServer can fire before dockerd is listening, silently "succeed",
 * then reconcile.sh hits `unauthorized` — this race bit standby historically.
 */
async function haWaitDockerReady(ctx) {
  const { primary, standby, sshKeyPath } = ctx;
  await perfAsync('deploy.ha.compose.dockerReady.both', () =>
    Promise.all([
      waitForDockerReady(primary.ip, sshKeyPath),
      waitForDockerReady(standby.ip, sshKeyPath),
    ]),
  );
}

/**
 * Build the app image natively on BOTH servers in parallel (over
 * DOCKER_HOST=ssh://) when the image tag is local-only — a cross-region
 * `docker save` pipe hung past the deploy timeout. Gated by
 * `when: ctx.isLocalOnlyImage`.
 */
async function haRemoteBuild(ctx) {
  const projectName = ctx.projectConfig.projectName;
  const { primary, standby, sshKeyPath, imageRef, domain } = ctx;
  const { buildRemote } = await import('../remote-build.js');
  const { collectComposeBuildArgs } = await import('../compose/build-args.js');
  const haBuildArgs = collectComposeBuildArgs(process.cwd(), { projectName, domain });
  ctx.onProgress(
    'Building image natively on primary + standby (parallel; overlapping file upload + image pull)...',
  );
  // F1: start the two-node build fan WITHOUT awaiting so it overlaps the
  // subsequent setupServerFiles → mergeWalgRole → pullImages steps (the build
  // uses the local build context over DOCKER_HOST=ssh and shares no dependency
  // with them). The barrier lives in haStartComposeStack, which awaits
  // ctx.remoteBuildPromise before `docker compose up` — compose references the
  // freshly built app image, so BOTH builds MUST complete by reconcile time
  // (LOAD-BEARING barrier; do not remove).
  ctx.remoteBuildPromise = perfAsync('deploy.ha.compose.remoteBuild.fan', async () => {
    const [primaryOk, standbyOk] = await Promise.all([
      buildRemote(primary.ip, sshKeyPath, imageRef, process.cwd(), haBuildArgs),
      buildRemote(standby.ip, sshKeyPath, imageRef, process.cwd(), haBuildArgs),
    ]);
    if (!primaryOk) throw new Error('Remote build on primary failed');
    if (!standbyOk) throw new Error('Remote build on standby failed');
  });
  // No-op rejection handler so an in-flight build failure doesn't surface as an
  // unhandledRejection before haStartComposeStack attaches its await; the real
  // throw still happens at the barrier (awaiting a rejected promise rethrows).
  ctx.remoteBuildPromise.catch(() => {});
}

/**
 * Fan-out setup: bundle upload + WireGuard firewall opening (UFW + cloud
 * firewall, both directions for post-failover symmetry) + registry
 * logins (Docker Hub / GHCR when creds are present). All independent → one
 * Promise.all under `deploy.ha.compose.setupFan`. The cloud-firewall openers
 * are non-fatal (B0-1) — they warn and resolve, so the bare Promise.all is
 * safe.
 */
async function haSetupServerFiles(ctx) {
  const projectName = ctx.projectConfig.projectName;
  const { primary, standby, sshKeyPath, apiToken, dockerHubCreds, ghcrPullCreds, environment } =
    ctx;
  // Conditional on purpose: BaseProvider throws on a falsy token, and the
  // opener's contract is to no-op without credentials.
  const provider = apiToken ? new (providerFor(ctx.envConfig))(apiToken) : null;
  ctx.onProgress('Copying project files...');
  const serviceOpts = haServiceOpts(ctx);
  const setupTasks = [
    perfAsync('deploy.ha.compose.setupFiles.primary', () =>
      setupServerFiles(primary.ip, sshKeyPath, projectName, serviceOpts),
    ),
    perfAsync('deploy.ha.compose.setupFiles.standby', () =>
      setupServerFiles(standby.ip, sshKeyPath, projectName, serviceOpts),
    ),
    perfAsync('deploy.ha.compose.openWgPortUfw.primary', () =>
      openWireguardPortUfw(primary.ip, standby.ip, sshKeyPath),
    ),
    perfAsync('deploy.ha.compose.openWgPortUfw.standby', () =>
      openWireguardPortUfw(standby.ip, primary.ip, sshKeyPath),
    ),
    perfAsync('deploy.ha.compose.cloudFirewallWg.primary', () =>
      openWireguardPortHetznerFirewall(
        `${projectName}-${environment}-primary`,
        standby.ip,
        provider,
      ),
    ),
    perfAsync('deploy.ha.compose.cloudFirewallWg.standby', () =>
      openWireguardPortHetznerFirewall(
        `${projectName}-${environment}-standby`,
        primary.ip,
        provider,
      ),
    ),
  ];
  if (dockerHubCreds) {
    setupTasks.push(
      perfAsync('deploy.ha.compose.dockerLogin.primary', () =>
        dockerLoginOnServer(primary.ip, sshKeyPath, dockerHubCreds),
      ),
      perfAsync('deploy.ha.compose.dockerLogin.standby', () =>
        dockerLoginOnServer(standby.ip, sshKeyPath, dockerHubCreds),
      ),
    );
  }
  if (ghcrPullCreds?.owner && ghcrPullCreds?.token) {
    const ghcrLogin = {
      username: ghcrPullCreds.owner,
      token: ghcrPullCreds.token,
      registry: 'ghcr.io',
    };
    setupTasks.push(
      perfAsync('deploy.ha.compose.ghcrLogin.primary', () =>
        dockerLoginOnServer(primary.ip, sshKeyPath, ghcrLogin),
      ),
      perfAsync('deploy.ha.compose.ghcrLogin.standby', () =>
        dockerLoginOnServer(standby.ip, sshKeyPath, ghcrLogin),
      ),
    );
  }
  await perfAsync('deploy.ha.compose.setupFan', () => Promise.all(setupTasks));
}

/**
 * wal-g WRITE-GUARD: write WALG_ROLE into each node's .env. Same canonical S3
 * prefix on both nodes (so the standby can READ the primary's base backups);
 * WALG_ROLE=standby makes wal-archive.sh + compose-backup.sh no-op on the
 * standby so it never WRITES into the shared prefix (split-brain guard).
 */
async function haMergeWalgRole(ctx) {
  const projectName = ctx.projectConfig.projectName;
  const { primary, standby, sshKeyPath } = ctx;
  const haSshOpts = pinnedSshOptsString(sshKeyPath);
  const haRemoteDir = `/opt/${projectName}`;
  await Promise.all([
    mergeRemoteDotenv(primary.ip, haSshOpts, haRemoteDir, { WALG_ROLE: 'primary' }),
    mergeRemoteDotenv(standby.ip, haSshOpts, haRemoteDir, { WALG_ROLE: 'standby' }),
  ]);
}

/** Pull app + base images on both servers in parallel (no remote build). */
async function haPullImages(ctx) {
  const projectName = ctx.projectConfig.projectName;
  const { primary, standby, sshKeyPath } = ctx;
  const serviceOpts = haServiceOpts(ctx);
  ctx.onProgress('Pulling images on both servers...');
  await perfAsync('deploy.ha.compose.pullFan', () =>
    Promise.all([
      perfAsync('deploy.ha.compose.pullImages.primary', () =>
        pullComposeImages(primary.ip, sshKeyPath, projectName, serviceOpts),
      ),
      perfAsync('deploy.ha.compose.pullImages.standby', () =>
        pullComposeImages(standby.ip, sshKeyPath, projectName, serviceOpts),
      ),
    ]),
  );
}

/**
 * Set up managed-DNS HA (Cloudflare health-checks+LB or Hetzner) BEFORE
 * starting services so Traefik ACME challenges resolve immediately; or print
 * manual instructions. HTTP-01 (non-managed, non-manual) then blocks on apex
 * propagation so LE's challenge burst sees the real IP.
 */
async function haUpdateDns(ctx) {
  const projectName = ctx.projectConfig.projectName;
  const {
    primary,
    standby,
    environment,
    domain,
    dnsProvider,
    dnsZoneId,
    dnsToken,
    region,
    standbyRegion,
  } = ctx;
  if (domain && hasAutomatedDns(dnsProvider) && dnsToken && dnsZoneId) {
    const dnsName = DNS_PROVIDERS[dnsProvider].name;
    ctx.onProgress(`Setting up ${dnsName} for HA...`);
    try {
      const { setupHA } = await getDnsProvider(dnsProvider);
      await perfAsync('deploy.ha.compose.dns.setup', () =>
        setupHA(dnsToken, dnsZoneId, domain, [
          { name: `${projectName}-${environment}-primary`, ip: primary.ip, region },
          { name: `${projectName}-${environment}-standby`, ip: standby.ip, region: standbyRegion },
        ]),
      );
    } catch (error) {
      p.log.warn(`${dnsName} HA setup failed: ${error.message}`);
      p.log.info('You can configure DNS manually.');
    }
  } else if (domain && dnsProvider === 'manual') {
    p.log.info(c.bold('Manual DNS Configuration:'));
    p.log.message(`  Point ${c.bold(domain)} to ${c.bold(primary.ip)} (primary)`);
    p.log.message(`  Standby server: ${c.bold(standby.ip)} (for manual failover)`);
  }

  // HTTP-01 only: block compose-up until public resolvers see the apex domain.
  // Managed-DNS HA issues certs via DNS-01, which doesn't gate on A-record
  // propagation. `manual` isn't reached here (excluded by the guard above).
  if (domain && dnsProvider && dnsProvider !== 'manual' && !useDnsChallenge(dnsProvider)) {
    ctx.onProgress(`Waiting for ${domain} to propagate to ${primary.ip}...`);
    const { waitForDNSPropagation } = await import('../../dns-propagation.js');
    await perfAsync('deploy.ha.compose.dns.waitForPropagation', () =>
      waitForDNSPropagation(domain, primary.ip, 120_000),
    );
  }
}

/** Start compose stacks on both servers in parallel. */
async function haStartComposeStack(ctx) {
  const projectName = ctx.projectConfig.projectName;
  const { primary, standby, sshKeyPath } = ctx;
  const serviceOpts = haServiceOpts(ctx);
  // F1 barrier: await the (non-blocking) remote-build fan started in
  // haRemoteBuild so the freshly built app image exists on BOTH nodes before
  // `docker compose up`. LOAD-BEARING — never remove. (undefined when the image
  // is a registry ref: haRemoteBuild's when-gate skipped it and pull fetched it.)
  if (ctx.remoteBuildPromise) {
    ctx.onProgress('Waiting for the native image build to finish...');
    await perfAsync('deploy.ha.compose.remoteBuild.await', () => ctx.remoteBuildPromise);
  }
  ctx.onProgress('Starting services on both servers...');
  await perfAsync('deploy.ha.compose.composeUp.both', () =>
    Promise.all([
      startComposeStack(primary.ip, sshKeyPath, projectName, serviceOpts),
      startComposeStack(standby.ip, sshKeyPath, projectName, serviceOpts),
    ]),
  );
}

/**
 * Run migrations on the PRIMARY only. Let failures propagate — shipping an
 * empty/partial schema is worse than a visibly-failed deploy.
 */
async function haRunMigrations(ctx) {
  const projectName = ctx.projectConfig.projectName;
  const { primary, sshKeyPath } = ctx;
  ctx.onProgress('Running database migrations on primary...');
  await perfAsync('deploy.ha.compose.migrations', () =>
    runMigrations(primary.ip, sshKeyPath, projectName),
  );
}

/**
 * Create the production super-admin on the PRIMARY. Idempotent (422 =
 * exists); FATAL on failure — shares createAdminUser (compose/index.js) with
 * the single-compose effect, so the same fast-follow to M3 Task 9h applies
 * here: a retry-exhaustion or missing-credentials failure throws instead of
 * degrading to a soft warning.
 */
async function haCreateAdminUser(ctx) {
  const projectName = ctx.projectConfig.projectName;
  const { primary, sshKeyPath } = ctx;
  ctx.onProgress('Creating admin user...');
  const adminResult = await perfAsync('deploy.ha.compose.createAdminUser', () =>
    createAdminUser(primary.ip, sshKeyPath, projectName),
  );
  p.log.success(adminResult.message);
}

/**
 * Wait for primary Postgres to accept connections before configuring
 * replication (pg_basebackup needs the socket; not GoTrue/Storage migrations).
 * ~6min budget; proceeds optimistically on timeout with a breadcrumb.
 */
async function haWaitPrimaryPostgres(ctx) {
  const projectName = ctx.projectConfig.projectName;
  const { primary, sshKeyPath } = ctx;
  ctx.onProgress('Waiting for primary Postgres to accept connections...');
  const healthConfirmed = await perfAsync('deploy.ha.compose.primaryHealthProbe', async () => {
    for (let i = 0; i < 30; i++) {
      try {
        const health = await sshRun(
          primary.ip,
          sshKeyPath,
          `cd /opt/${projectName} && docker compose exec -T db pg_isready -h localhost -p 5432 2>/dev/null`,
          { timeout: 10_000 },
        );
        if (health?.includes('accepting connections')) return true;
      } catch {
        // Retry — non-zero exit from pg_isready bubbles up as a thrown error.
      }
      if (i === 29) break;
      const ms = i < 5 ? 1000 : 3000;
      await new Promise((r) => setTimeout(r, ms));
    }
    return false;
  });
  if (!healthConfirmed) {
    console.error(
      `[ha] primary Postgres did not accept connections within ~6min; proceeding optimistically, configurePrimaryReplication is the next failure surface if PG is truly dead`,
    );
  }
}

/**
 * Write docker-compose.replication.yml to both nodes (each with its OWN tunnel
 * IP baked into the socat relay) and recreate the db service so its REPL_PORT
 * mapping is live. The relay is NOT started here — it binds the tunnel IP,
 * which only exists after wg0 comes up in configure-replication.
 *
 * THE `up -d db` MUST RUN WITH RECONCILE'S OWN FLAG SET (extracted from
 * reconcile.sh on the node), not REPL_COMPOSE_FLAGS. The 3-file subset
 * recreated db with a config-hash no full-set reconcile ever computes, so
 * EVERY subsequent warm deploy recreated db again — and auth 502'd through
 * createAdminUser's whole retry budget while db cycled (e2 warm-deploy,
 * 3× on 2026-08-06/07; the .vc-render-first/last diff on the kept rig named
 * the replication overlay as the drifting content). Extracting the baked
 * flags keeps this invocation byte-identical to future reconciles by
 * construction — a JS-side rebuild of the option set would drift the moment
 * an overlay is added to one list and not the other (this bug, exactly).
 */
async function haWriteReplicationOverlay(ctx) {
  const projectName = ctx.projectConfig.projectName;
  const { primary, standby, sshKeyPath } = ctx;
  await Promise.all(
    [
      [primary.ip, WG_PRIMARY_IP],
      [standby.ip, WG_STANDBY_IP],
    ].map(async ([ip, selfWgIp]) => {
      await sshRunAsync(
        ip,
        sshKeyPath,
        `cat > /opt/${projectName}/docker-compose.replication.yml << 'REPL'\n${buildReplicationOverlay(selfWgIp)}REPL`,
        { timeout: 10_000 },
      );
      // Materialize the db image EXPLICITLY before recreating the service.
      //
      // On the standby this can be the FIRST time the db image exists: the
      // deploy's compose-up does not necessarily start db there, and db is
      // `pull_policy: build` (never pulled). Before 2026-08-23 the `up -d db`
      // below did this implicitly — a full build including the base-image
      // pull, racing the step's 60s ssh timeout. Hetzner's bandwidth won that
      // race; vultr's lost it (runs 32614839037/32620567017), dying as an
      // opaque timeout with the build half-done. Explicit build = its own
      // command, a pull-scale 600s budget, and the builder's stderr naming
      // any real failure. Warm nodes no-op in seconds (cache hit).
      await sshRunAsync(
        ip,
        sshKeyPath,
        `cd /opt/${projectName} || exit 1; ` +
          `FLAGS=$(sed -n 's/^docker compose \\(.*\\) \\$(\\[ -f docker-compose.replication.yml.*up -d --remove-orphans$/\\1/p' reconcile.sh | tail -1); ` +
          `[ -n "$FLAGS" ] || FLAGS='${REPL_COMPOSE_FLAGS_BASE}'; ` +
          `docker compose $FLAGS -f docker-compose.replication.yml build db 2>&1`,
        { timeout: 600_000 },
      );
      // Pull reconcile.sh's own ${composeFlags} (the text before the runtime
      // replication-overlay conditional on its `up` line) and append the
      // overlay explicitly — the file was just written, so this renders the
      // same config the next reconcile will hash.
      await sshRunAsync(
        ip,
        sshKeyPath,
        `cd /opt/${projectName} || exit 1; ` +
          `FLAGS=$(sed -n 's/^docker compose \\(.*\\) \\$(\\[ -f docker-compose.replication.yml.*up -d --remove-orphans$/\\1/p' reconcile.sh | tail -1); ` +
          `[ -n "$FLAGS" ] || FLAGS='${REPL_COMPOSE_FLAGS_BASE}'; ` +
          `docker compose $FLAGS -f docker-compose.replication.yml up -d --no-build db 2>&1`,
        { timeout: 60_000 },
      );
    }),
  );
}

// Fallback flag set for the db recreate above if reconcile.sh's up line ever
// changes shape and the sed extraction comes back empty: the pre-fix behavior
// (base + prod), which at worst reintroduces one bounded warm-recreate churn
// rather than failing the deploy.
const REPL_COMPOSE_FLAGS_BASE = '-f docker-compose.yml -f docker-compose.prod.yml';

/**
 * Configure PostgreSQL streaming replication: bring up the WireGuard tunnel +
 * repl-gateways, configure the primary, then seed the standby. Wrapped in one
 * `deploy.ha.replication.setup` perf span. A standby-seed failure is downgraded
 * to a warning here (the hard-gate lives in verify-streaming) — replication has
 * been chronically fragile and hard-failing every deploy would block iteration.
 */
async function haConfigureReplication(ctx) {
  const projectName = ctx.projectConfig.projectName;
  const { primary, standby, sshKeyPath } = ctx;
  await perfAsync('deploy.ha.replication.setup', async () => {
    ctx.onProgress('Configuring PostgreSQL replication on primary...');
    await configurePrimaryReplication(primary.ip, standby.ip, sshKeyPath, projectName);

    ctx.onProgress('Configuring standby as hot replica...');
    let replicationOk = false;
    try {
      replicationOk = await configureStandbyReplication(
        standby.ip,
        primary.ip,
        sshKeyPath,
        projectName,
      );
    } catch (err) {
      p.log.warn(`Replication setup error (continuing with warning): ${err.message}`);
    }
    if (!replicationOk) {
      p.log.warn('Replication setup may not have completed: verify manually');
    }
  });
}

/**
 * Verify streaming on the primary via pg_stat_replication. Hard-gate by default
 * (throws when not streaming) unless the operator opted into a warm/degraded
 * standby with -allow-degraded. Sets ctx.replActive / ctx.degraded /
 * ctx.replLastState for the finalize summary + persisted DR posture.
 */
async function haVerifyStreaming(ctx) {
  const projectName = ctx.projectConfig.projectName;
  const { primary, sshKeyPath, allowDegraded } = ctx;
  ctx.onProgress('Verifying replication...');
  const { streaming: replActive, lastState: replLastState } = await verifyStreaming({
    readState: async () => {
      const state = await sshRun(
        primary.ip,
        sshKeyPath,
        `cd /opt/${projectName} && docker compose exec -T db psql -U supabase_admin -d postgres -tAc "SELECT state FROM pg_stat_replication ORDER BY (state = 'streaming') DESC LIMIT 1"`,
        { timeout: 10_000 },
      );
      return typeof state === 'string' ? state.trim() : '';
    },
    attempts: 10,
    delaysMs: [250, 500, 1000, 2000, 3000],
  });

  const { degraded } = assertReplicationStreamingOrDegraded({
    streaming: replActive,
    lastState: replLastState,
    allowDegraded,
    fixHint:
      'Verify the WireGuard tunnel port (UDP 51821) is open between the two regions, wg0 ' +
      'is up on both nodes, and the standby completed pg_basebackup.',
  });
  ctx.replActive = replActive;
  ctx.replLastState = replLastState;
  ctx.degraded = degraded;
  if (replActive) {
    p.log.success('Streaming replication active');
  } else {
    p.log.warn(
      'DEGRADED HA (-allow-degraded): streaming replication NOT detected ' +
        `(last pg_stat_replication.state=${
          replLastState ? JSON.stringify(replLastState) : 'no replica connected'
        }). The standby is a warm/cold spare and may be missing recent writes — ` +
        'disaster recovery is NOT guaranteed. Resync with `vibecarbon deploy` (no ' +
        '-allow-degraded) once the replication issue is resolved.',
    );
  }
}

/**
 * Install the scheduled wal-g backup cron on BOTH nodes. The standby's cron is
 * a guarded no-op until promoted; installing on both means the survivor keeps
 * backing up after a failover. allSettled + per-node warn — a cron hiccup must
 * not fail an already-serving HA deploy.
 */
async function haSetupBackupCron(ctx) {
  const projectName = ctx.projectConfig.projectName;
  const { primary, standby, sshKeyPath, backupConfig } = ctx;
  ctx.onProgress('Installing backup cron on both servers...');
  const cronResults = await perfAsync('deploy.ha.compose.backupCron.both', () =>
    Promise.allSettled([
      perfAsync('deploy.ha.compose.backupCron.primary', async () =>
        setupComposeBackupCron(primary.ip, sshKeyPath, projectName, backupConfig),
      ),
      perfAsync('deploy.ha.compose.backupCron.standby', async () =>
        setupComposeBackupCron(standby.ip, sshKeyPath, projectName, backupConfig),
      ),
    ]),
  );
  for (const [i, result] of cronResults.entries()) {
    if (result.status === 'rejected') {
      const node = i === 0 ? `primary (${primary.ip})` : `standby (${standby.ip})`;
      p.log.warn(
        `Scheduled backup cron install failed on ${node} (deploy still succeeded): ${result.reason?.message ?? result.reason}`,
      );
    }
  }
}

/**
 * Promote pending → deployed, persist DR posture, register the project, and
 * print the deploy summary. Reuses the projectConfig + pendingEnvConfig loaded
 * in haPersistPendingConfig so the servers[] (with Hetzner ids) is preserved.
 */
async function haFinalizeConfig(ctx) {
  const projectName = ctx.projectConfig.projectName;
  const {
    environment,
    envConfig,
    region,
    standbyRegion,
    primary,
    standby,
    domain,
    loadedProjectConfig,
    pendingEnvConfig,
    replActive,
    degraded,
  } = ctx;

  saveProjectConfig({
    ...loadedProjectConfig,
    provider: envConfig.provider ?? 'hetzner',
    environments: {
      ...loadedProjectConfig.environments,
      [environment]: {
        ...pendingEnvConfig,
        status: 'deployed',
        replication: degraded ? 'degraded' : 'streaming',
        degraded,
        deployedAt: new Date().toISOString(),
        lastAttempt: undefined,
      },
    },
  });
  registerProject(projectName, process.cwd());

  p.log.success('');
  if (domain) {
    p.log.message(`  ${c.dim('URL')}            ${c.info(`https://${domain}`)}`);
  }
  p.log.message(`  ${c.dim('Primary')}        ${c.info(primary.ip)} (${region})`);
  p.log.message(`  ${c.dim('Standby')}        ${c.info(standby.ip)} (${standbyRegion})`);
  p.log.message(`  ${c.dim('Deploy method')}  Docker Compose HA`);
  if (replActive) {
    p.log.message(`  ${c.dim('Replication')}    ${c.success('PostgreSQL streaming')}`);
  } else {
    p.log.message(
      `  ${c.dim('Replication')}    ${c.warning('DEGRADED (warm standby), NOT streaming; DR is not guaranteed')}`,
    );
  }
  p.log.message('');
}

export const COMPOSE_HA_EFFECTS = {
  haProvisionServers,
  haPersistPendingConfig,
  haWaitForSsh,
  haSeedKnownHosts,
  haSetupServers,
  haWaitDockerReady,
  haRemoteBuild,
  haSetupServerFiles,
  haMergeWalgRole,
  haPullImages,
  haUpdateDns,
  haStartComposeStack,
  haRunMigrations,
  haCreateAdminUser,
  haWaitPrimaryPostgres,
  haWriteReplicationOverlay,
  haConfigureReplication,
  haVerifyStreaming,
  haSetupBackupCron,
  haFinalizeConfig,
};
