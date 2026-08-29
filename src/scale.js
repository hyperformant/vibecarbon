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
import { requireTTYOrFlags } from './lib/cli/tty-guard.js';
import { c } from './lib/colors.js';
import { runCommand } from './lib/command.js';
import { saveProjectConfig } from './lib/config.js';
import { useDnsChallenge } from './lib/deploy/acme.js';
import { collectComposeBuildArgs } from './lib/deploy/compose/build-args.js';
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
import { resolveDockerHubCreds } from './lib/deploy/docker-hub.js';
import { runPlan } from './lib/deploy/plan/runner.js';
import { planScale } from './lib/deploy/plan/scale-plan.js';
import { buildRemote } from './lib/deploy/remote-build.js';
import { isHATier, resolveTier } from './lib/deploy/tier-registry.js';
import { DEFAULT_WORKER_MAX, DEFAULT_WORKER_MIN } from './lib/deploy/utils.js';
import { waitForDNSPropagation } from './lib/dns-propagation.js';
import {
  DNS_PROVIDERS,
  getDnsProvider,
  hasAutomatedDns,
  resolveDnsToken,
} from './lib/dns-provider.js';
import { convergeClusterInfra } from './lib/iac/converge-cluster.js';
import { requirePaidTier } from './lib/licensing/index.js';
import { ensureOperatorIpAccess } from './lib/operator-ip.js';
import { perfAsync } from './lib/perf.js';
import { runProjectAssignment } from './lib/project-assignment.js';
import { assertInProjectDir } from './lib/project-guard.js';
import { providerFor, providerIdFor, resolveProviderToken } from './lib/providers/index.js';
import { pollUntil } from './lib/retry.js';
import { planK8sScaleChanges } from './lib/scale-plan.js';
import { buildComposeTypeOptions, buildSimpleTypeOptions } from './lib/server-types.js';
import { parseDotenv } from './lib/shell.js';
import { sshRun, sshRunScript } from './lib/ssh.js';

// ============================================================================
// COMMAND SPEC — single source of truth for argv parsing AND help output.
// ============================================================================

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, description?: string, examples?: Array<{ command: string, description?: string }> }} */
const SPEC = {
  name: 'scale',
  summary: 'Adjust instance types post-deploy',
  description: [
    'What you can change:',
    '  Compose / Compose HA   VPS server type (blue-green; zero downtime)',
    '  Kubernetes             Worker / master / supabase server types (in-place)',
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
        'Server type to scale to (e.g. cx33). Compose: resizes the VPS. K8s: resizes all roles.',
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

  // Get API token
  const apiToken = await Provider.promptApiToken(projectName);
  if (!apiToken) {
    p.log.error('API token required for server scaling');
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
  const currentType = envConfig.serverType || Provider.getRegionDefaults(region).supabaseType;

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
  p.note(`Current ${Provider.NAME} pricing: ${Provider.PRICING_URL}`, 'Cost');

  // Confirmation
  const serverLabel =
    targetServers.length > 1 ? `${targetServers.length} servers (one at a time)` : '1 server';
  p.log.info(
    `This will create a new ${c.bold(newType)} server, migrate data, and destroy the old one.`,
  );
  p.log.info('Your application stays online during the migration (zero downtime).');

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
async function scaleServers(ctx) {
  const {
    tier,
    provider,
    Provider,
    newType,
    region,
    sshKeyId,
    envConfig,
    projectName,
    environment,
    sshKeyPath,
    domain,
    services,
    dnsChallenge,
    dnsProvider,
    apiToken,
    targetServers,
  } = ctx;

  const scaleSingleServer = async (server) => {
    const label = isHATier(tier) ? `${server.role} (${server.ip})` : server.ip;
    const s = spinner();

    // 1. Kick off the wal-g base backup of the OLD server in the BACKGROUND.
    // It pushes straight to S3; step 7's restore on the NEW server fetches
    // `latest`. The backup SSHes the OLD server while every step below
    // provisions the NEW one — different hosts, zero contention — so its ~11s
    // hides entirely behind provisioning instead of blocking the critical path
    // up front. It is awaited just before restoreDb (the step that consumes it);
    // a backup failure still aborts scale there (before any restore/destroy),
    // and the try/catch below still cleans up the new server on that abort.
    p.log.info(`Backing up ${label} in the background (wal-g base backup → S3)`);
    const backupPromise = perfAsync('scale.backupOldServer', async () =>
      backupCompose(server.ip, sshKeyPath, projectName, {
        retain: envConfig.backup?.retentionDays,
      }),
    );
    // Swallow the rejection HERE only to avoid an unhandled-rejection warning if
    // a provisioning step throws before we reach the await; the real await at
    // step 7 still observes the rejection and aborts.
    backupPromise.catch(() => {});

    // 2. Create new server. user_data front-loads ufw + unattended-upgrades
    // during boot so setupServer is a ~2s marker-file probe below (Hetzner)
    // or, for a provider whose base image installs Docker inside cloud-init
    // (DigitalOcean), the materially larger provider-owned budget applied
    // at step 4 below.
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

    // Wrap remaining steps in try/catch — if anything fails after creating the
    // new server, delete it so we don't leave orphaned infrastructure behind.
    let newIp;
    try {
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
      newIp = Provider.getPublicIP(readyServer);
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
      // original deploy seeded (Supabase keys, S3 creds, SMTP, billing,
      // Grafana, n8n encryption key, etc.) propagates to the new server.
      //
      // Why pull the whole file vs. re-deriving from project state:
      //   - The original deploy merges values from many sources — project
      //     `.env` + operator-secret env vars (S3 secret key) +
      //     orchestrator-derived overrides (DOMAIN, ACME_EMAIL, SITE_URL,
      //     SUPABASE_URL, S3_*, S3_BACKUP_BUCKET, PROJECT_NAME, APP_IMAGE).
      //     Reconstructing all of those at scale time would mean re-prompting
      //     for credentials and re-running the same envOverrides logic.
      //   - The old server's `.env` already contains the resolved superset.
      //     Replaying it onto the new server is the smallest patch that
      //     preserves every value, including ones the project's local
      //     `.env`/`.env.local` doesn't even know about.
      //
      // The on-disk form is `KEY='POSIX-single-quoted-value'` (per
      // escapeDotenv); parseDotenv decodes the wrapping quotes so the values
      // we pass to renderBundle as envOverrides are raw strings ready to be
      // re-escaped on write. We then pin APP_IMAGE explicitly because that's
      // the one value scale needs to keep stable across the migration; all
      // other keys flow through transparently.
      // Spinner over the OLD-server .env pull: this SSHes a *different* host
      // (the one being retired) and, if it's slow/unreachable, sits on sshRun's
      // 120s client timeout. Without a spinner that window is a dead cursor
      // between "Docker installed" and "Copying project files" — the exact
      // stalled-spinner symptom flaky links produce.
      let oldEnv = {};
      s.start('Reading current server configuration...');
      try {
        const envText = await sshRun(server.ip, sshKeyPath, ['cat', `/opt/${projectName}/.env`]);
        oldEnv = parseDotenv(envText);
        s.stop('Current server configuration read');
      } catch {
        // Old server may be unreachable; renderBundle will fall back to the
        // project's local `.env`. That path is degraded (missing S3 secrets)
        // but at least surfaces a meaningful error during reconcile rather
        // than crashing scale silently.
        s.stop('Could not read old-server config, falling back to project .env');
      }
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
        }),
      );
      s.stop('Project files copied');

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
        // server's frontend bundle ships empty VITE_SUPABASE_URL/ANON_KEY and
        // the browser throws "Missing Supabase environment variables". Deploy
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

      // 6. Start compose stack on new server
      s.start('Starting services on new server...');
      await perfAsync('scale.composeUp', () =>
        startComposeStack(newIp, sshKeyPath, projectName, services),
      );
      s.stop('Services started');

      // 7. Restore database on new server from S3 via wal-g. The base backup +
      //    WAL were pushed straight to S3 by step 1's backupCompose, so the
      //    restore fetches LATEST directly — no local archive to transfer.
      //    S3 credentials come from the db container's env (sourced from .env)
      //    so no opts are needed; restoreCompose handles its own verify loop
      //    (pg_isready + pg_is_in_recovery() = f) before returning.
      // First make sure the OLD server's base backup finished landing in S3
      // (kicked off in the background at the top of this fn). This await is the
      // ONLY consumer of backupPromise — a backup failure surfaces here and, via
      // the enclosing try/catch, deletes the new server before we restore or
      // destroy anything. On the happy path provisioning already hid its cost.
      s.start('Finalizing old-server backup before restore...');
      await backupPromise;
      s.stop('Database backed up (wal-g base backup pushed to S3)');

      s.start('Restoring database from S3 via wal-g...');
      await perfAsync('scale.restoreDb', async () =>
        restoreCompose(newIp, sshKeyPath, projectName, 'latest'),
      );
      s.stop('Database restored');

      // Remote compose project dir on the new server — used by the ACME reset
      // and the post-restore service recreate below. (Previously declared by a
      // since-removed pre-restore readiness step; restoreCompose now owns that
      // wait, so declare it here.)
      const remoteDir = `/opt/${projectName}`;

      // 9a. Update DNS to the new server. On HTTP-01 this must happen BEFORE
      // recreating services (Traefik challenges the A record on startup; a
      // stale record fails all challenges with a 30+ min retry). On DNS-01 the
      // ordering is irrelevant — lego validates a TXT record, not the A record.
      // Gated to ONE writer: the standby's replacement never touches apex
      // (see shouldUpdateApexDns — the two-writer upsert race, run
      // 31970876667).
      if (domain && shouldUpdateApexDns(server)) {
        s.start('Updating DNS to new server...');
        await perfAsync('scale.updateDNS', () => updateDNS(envConfig, apiToken, domain, newIp));
        s.stop('DNS updated');

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
      }

      // 9b. HTTP-01 only: reset ACME state so Traefik retries challenges with
      // the corrected DNS — step 6's startComposeStack ran before the A record
      // moved, so failed challenges are cached as errors in letsencrypt_data.
      // DNS-01 has no such cached HTTP-01 failure to clear (and wiping acme.json
      // would force a needless re-issue), so skip it.
      // Uses an SCP'd script so quoting/redirection stay intact without local shell.
      if (!dnsChallenge) {
        await sshRunScript(
          newIp,
          sshKeyPath,
          `cd ${remoteDir} && docker compose exec -T traefik sh -c 'echo "{}" > /letsencrypt/acme.json && chmod 600 /letsencrypt/acme.json'`,
          { timeout: 30_000 },
        );
      }

      // 9c. Recreate all services after restore so they reconnect to the restored DB.
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
      const replOverlayFlag =
        "$([ -f docker-compose.replication.yml ] && echo '-f docker-compose.replication.yml')";
      s.start('Recreating all services after restore...');
      await sshRunScript(
        newIp,
        sshKeyPath,
        `cd ${remoteDir} && ` +
          `FLAGS=$(sed -n 's/^docker compose \\(.*\\) \\$(\\[ -f docker-compose.replication.yml.*up -d --remove-orphans$/\\1/p' reconcile.sh | tail -1); ` +
          `[ -n "$FLAGS" ] || FLAGS='-f docker-compose.yml -f docker-compose.prod.yml'; ` +
          `docker compose $FLAGS ${replOverlayFlag} up -d --force-recreate 2>&1`,
        { timeout: 600_000 },
      );
      s.stop('All services running');

      // 11. Re-setup backup cron if configured. wal-g reads its S3 config from
      //     the db container's env (rendered into .env at deploy), so the cron
      //     just runs compose-backup.sh on schedule — no separate S3 plumbing.
      if (envConfig.backup) {
        await setupComposeBackupCron(newIp, sshKeyPath, projectName, envConfig.backup);
        p.log.info('Backup cron restored on new server');
      }

      // 12. Destroy old server
      s.start(`Destroying old server ${server.ip}...`);
      await perfAsync('scale.destroyOldServer', () => provider.deleteServer(server.id));
      s.stop(`Old server destroyed: ${server.ip}`);

      // Rename new server to permanent name
      const permanentName = `${projectName}-${environment}${server.role ? `-${server.role}` : ''}`;
      try {
        await provider.renameServer(newServerId, permanentName);
      } catch {
        // Non-critical — server works fine with the temporary name
      }

      // Update server entry in the config. We spread the original `server`
      // entry first so any field we don't explicitly touch (e.g.
      // `supabaseIp` on shapes that have it) carries over verbatim — then
      // override the fields that actually changed during the migration.
      // We deliberately keep `server.name` (the role label —
      // 'master' / 'primary' / 'standby') because failover.js, diagnose.js,
      // and destroy.js all filter on it (e.g. `s.name === 'master'`). The
      // Hetzner-API name goes into `providerServerName` so destroy's
      // name-fallback can locate the VPS.
      server._replacement = {
        ...server,
        id: newServerId,
        providerServerName: permanentName,
        ip: newIp,
        region: server.region || region,
        serverType: newType,
      };
    } catch (scaleErr) {
      // Clean up the new server so it doesn't become orphaned infrastructure.
      p.log.error(`Scale failed: ${scaleErr.message}`);
      p.log.info(`Cleaning up new server ${newIp || 'unknown'} (id: ${newServerId})...`);
      try {
        await provider.deleteServer(newServerId);
        p.log.info('New server deleted. Old server is still running.');
      } catch (cleanupErr) {
        p.log.error(
          `Failed to delete new server ${newServerId}: ${cleanupErr.message}. Delete it manually.`,
        );
      }
      throw scaleErr;
    }
  };

  const ha = isHATier(tier);
  if (ha && targetServers.length > 1) {
    // Wrap parallel scale in a perfTimer so the wall-clock win is visible
    // in perf_substep alongside the per-server scale.* timings.
    await perfAsync('scale.ha.fan', () => Promise.all(targetServers.map(scaleSingleServer)));
  } else {
    for (const server of targetServers) {
      await scaleSingleServer(server);
    }
  }
}

/** compose/compose-ha `update-project-config` effect: persist the scaled
 *  server identities (+ unified serverType, when every server was scaled)
 *  into .vibecarbon.json. */
async function scaleUpdateComposeConfig(ctx) {
  const { environment, envConfig, projectConfig, servers, targetServers, newType } = ctx;
  const updatedServers = servers.map((server) => {
    if (server._replacement) {
      const replacement = { ...server._replacement };
      delete server._replacement;
      return replacement;
    }
    return server;
  });

  const allScaled = servers.every((s) => !s.id || targetServers.some((t) => t.id === s.id));
  const updatedConfig = {
    ...projectConfig,
    environments: {
      ...projectConfig.environments,
      [environment]: {
        ...envConfig,
        ...(allScaled && { serverType: newType }),
        servers: updatedServers,
      },
    },
  };
  saveProjectConfig(updatedConfig);
}

/** compose/compose-ha `finish-outro` effect. */
async function scaleFinishComposeOutro(ctx) {
  const { currentType, newType, provider, projectName, environment } = ctx;
  // Replacement servers are new droplets — re-file them into the dedicated
  // cloud project where the provider needs post-hoc assignment (DO).
  await runProjectAssignment(provider, { projectName, environment });
  p.outro(
    `${c.success('Scale complete!')} ${c.bold(currentType)} → ${c.bold(newType)} (zero downtime)`,
  );
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

  const envs = projectConfig.environments || {};
  const deployedEnvs = Object.entries(envs)
    .filter(([, cfg]) => cfg.status === 'deployed')
    .map(([name]) => name);

  if (deployedEnvs.length === 0) {
    p.log.error('No deployed environments found. Run vibecarbon deploy first.');
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
  const tier = resolveTier(envConfig);

  // Gate immediately once the environment's deploy mode tier is known,
  // before any scale work. Single-server Compose is free; every other
  // mode requires a paid license.
  requirePaidTier('scale', tier);

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
  // supabase/worker types only appear here after a previous `scale` set
  // them. Fall back to envConfig.serverType so we don't send the em-dash
  // placeholder to Pulumi: doing so triggered ~serverType against the
  // already-provisioned `cx23` master/supabase servers and Hetzner replied
  // 'server type — not found'. `Provider` was resolved once above.
  const fallbackType = envConfig.serverType || Provider.DEFAULT_COMPOSE_TYPE;
  const currentMasterType = envConfig.masterServerType || fallbackType;
  const currentSupabaseType = envConfig.supabaseServerType || fallbackType;
  const currentWorkerType = envConfig.workerServerType || fallbackType;

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
    `${'Supabase type'.padEnd(pad)} ${c.bold(currentSupabaseType)}`,
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
  const plan = planK8sScaleChanges(parsed, envConfig);
  if (plan) {
    changes = plan.changes;
    Object.assign(newValues, plan.newValues);
    if (changes.includes('masterType')) {
      p.log.info(
        `Scaling all node roles (master, supabase, worker) to ${c.bold(parsed.type)} ${c.dim('(in-place resize, ~2 min downtime per node)')}`,
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
          value: 'supabaseType',
          label: 'Supabase server type (database restart: back up first)',
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
      } else if (change === 'supabaseType') {
        p.log.warn('Changing Supabase type will restart the database. Back up first!');
        const val = await p.select({
          message: 'New Supabase server type:',
          options: serverTypeOptions,
          initialValue: serverTypeOptions.find((t) => t.value === currentSupabaseType)?.value,
        });
        if (p.isCancel(val)) {
          exitCancelled();
        }
        newValues.supabaseType = val;
      }
    }
  }

  // Server type changes apply via Pulumi up → Hetzner in-place resize per
  // node (~2 min reboot each).
  const infraChanges = changes.filter(
    (c) => c === 'workerType' || c === 'masterType' || c === 'supabaseType',
  );

  // isHATier(tier) is behavior-identical to `envConfig.ha?.enabled` for the k8s
  // tier; the `&& secondaryRegion` conjunct is kept because HA cluster fan-out
  // below also requires a configured standby region (registry predicate alone
  // is NOT equivalent here).
  const isHA = isHATier(parsed.tier) && envConfig.secondaryRegion;
  p.note(`Current ${Provider.NAME} pricing: ${Provider.PRICING_URL}`, 'Cost');

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
    // master/supabase current types are re-derived inside convergeClusterInfra
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
    // seam re-derives master/supabase current types from envConfig.
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

  // Apply to primary (or single) cluster — keeps envConfig's persisted sizing.
  await applyScaleChanges({
    clusterEnv: haRoles.primary.clusterEnv,
    clusterRegion: haRoles.primary.clusterRegion,
    label: isHA ? `primary: ${haRoles.primary.clusterRegion}` : haRoles.primary.clusterRegion,
    overrides: newValues,
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
      overrides: { ...newValues, minWorkers: 0, maxWorkers: 0 },
      caBounds: {
        min: newValues.minWorkers ?? envConfig.minWorkers ?? 1,
        max: newValues.maxWorkers ?? envConfig.maxWorkers ?? DEFAULT_WORKER_MAX,
      },
    });
  }
}

/**
 * k8s-ha `re-establish-ha-tunnel` effect (item I-1): after a resize rebooted
 * the supabase node(s), the imperative host `wg0` is gone, the hostNetwork
 * repl-gateway Pod crash-loops (can't bind its tunnel IP), and the primary's
 * post-resize pods-Ready wait (below) would then time out for 10 min and fail
 * scale. Recreate wg0 (also retrofits the boot-persistence systemd unit) and
 * bounce the gateway on both clusters BEFORE that wait.
 *
 * Gated at the plan level to HA (`when: ctx.isHA`); here we further no-op
 * unless the SUPABASE node type actually changed — only a supabase-node resize
 * reboots the node that owns wg0, so on a master/worker-only resize the tunnel
 * survives and we must NOT needlessly tear down a healthy wg0. Best-effort: a
 * failure warns (the operator can `vibecarbon deploy` to fully restore) and the
 * verify-ready diag below still fires if the gateway stays down.
 */
async function scaleReestablishHaTunnel(ctx) {
  const { environment, envConfig, projectConfig, isHA, infraChanges } = ctx;
  if (!isHA) return; // single-cluster k8s has no replication tunnel
  if (!infraChanges?.includes('supabaseType')) {
    // Master/worker-only resize: the supabase node (owner of wg0) never
    // rebooted, so the tunnel is intact — leave the healthy wg0 alone.
    p.log.info(
      'Supabase node type unchanged, skipping WireGuard tunnel re-establish (wg0 not disrupted).',
    );
    return;
  }

  const { identifyServers } = await import('./failover.js');
  const { reestablishReplicationTransport } = await import('./lib/deploy/k8s/index.js');
  const servers = identifyServers(environment, envConfig, projectConfig);
  if (!servers?.primary?.supabaseIp || !servers?.standby?.supabaseIp) {
    p.log.warn(
      'Could not resolve HA supabase node IPs from config, skipping post-resize WireGuard ' +
        're-establish. If replication is down, run `vibecarbon deploy` to restore it.',
    );
    return;
  }
  const sshKeyPath = join(process.cwd(), '.vibecarbon', `deploy_key_${environment}`);
  const s = spinner();
  s.start('Re-establishing WireGuard replication tunnel after supabase-node resize');
  try {
    await reestablishReplicationTransport({
      primaryIp: servers.primary.ip,
      standbyIp: servers.standby.ip,
      primarySupabaseIp: servers.primary.supabaseIp,
      standbySupabaseIp: servers.standby.supabaseIp,
      primarySupabasePrivateIp: servers.primary.supabasePrivateIp,
      standbySupabasePrivateIp: servers.standby.supabasePrivateIp,
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
  // supabase-supabase-db Postgres) need additional time to finish
  // their own init / WAL replay before they accept connections. If
  // the next caller (e.g. e2e backup step) runs against a
  // still-recovering cluster, pg_dump gets "connection refused" and
  // the work fails for what looks like a backup bug but is actually
  // a "scale didn't wait for the cluster to settle" problem. Observed
  // 2026-04-28 e2e — every backup-step failure across three
  // reruns had this same root cause.
  //
  // Wait for all pods in the vibecarbon namespace to reach
  // Ready=True. The supabase chart's readiness probe on
  // supabase-supabase-db is TCP-based on 5432, so once that pod is
  // Ready the connection-refused window has closed.
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
  // timed out 12/12 pods at 5 min — supabase-db-0 alone needs ~60-90s to
  // start postgres after a node reboot, then auth/kong/realtime/etc.
  // dependency-chain off it, then app pulls images that may not be cached
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
    // kubelet can flip the supabase node Ready before hcloud-csi-node
    // pod registers; supabase-db-0 then tries to mount its PVC and
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
    // csi-hetzner-cloud held" state — supabase-db-0 then sits in
    // Init:0/1 for 10+ min waiting for the new VolumeAttachment to
    // bind. Solution: do not bounce. Rely on the csi-node rollout
    // wait above eliminating the race in the first place; a pod that
    // entered BackOff before CSI registered will exit BackOff cleanly
    // once kubelet's next retry tick fires (5-min cap).)
    //
    // HA standby exception: skip the pod-Ready wait entirely when this
    // is the standby cluster. The standby's DB is supposed to be a
    // streaming replica (read-only), and the supabase chart's
    // app-tier pods (app/kong/rest/auth/realtime/storage) currently
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
 * (worker/master/supabase serverType + cluster-autoscaler bounds) into
 * .vibecarbon.json. Hetzner server_type changes are in-place resizes (not
 * replaces) per the master-replace guard's design comment above — the public
 * IP survives the type bump, so the persisted `servers[]` block still points
 * at the right hosts after scale; only the sizing inputs need updating.
 */
async function scaleUpdateK8sConfig(ctx) {
  const { environment, envConfig, projectConfig, newValues, isHA } = ctx;
  const updatedEnvFields = {
    ...(newValues.workerType && {
      workerServerType: newValues.workerType,
      serverType: newValues.workerType,
    }),
    ...(newValues.masterType && { masterServerType: newValues.masterType }),
    ...(newValues.supabaseType && { supabaseServerType: newValues.supabaseType }),
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
    // untouched — only standbyWorkerSpec.serverType changes.
    ...(isHA &&
      newValues.workerType &&
      envConfig.ha && {
        ha: {
          ...envConfig.ha,
          standbyWorkerSpec: {
            ...envConfig.ha.standbyWorkerSpec,
            serverType: newValues.workerType,
          },
        },
      }),
  };

  const updatedConfig = {
    ...projectConfig,
    environments: {
      ...projectConfig.environments,
      [environment]: { ...envConfig, ...updatedEnvFields },
    },
  };
  saveProjectConfig(updatedConfig);
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
