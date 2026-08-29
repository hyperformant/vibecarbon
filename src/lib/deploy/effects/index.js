/**
 * Effect registry for the step-plan runner. Effects are the ONLY place I/O
 * happens; planners stay pure and reference effects by name. Each effect is a
 * thin, verbatim relocation of the corresponding block from the (now removed)
 * inlined compose-single deploy path — same operations, same order, same args,
 * same state-tracker gating and perf instrumentation. Effects read from and
 * mutate the shared `ctx` (e.g. provision-server sets ctx.serverIp, which the
 * downstream effects read).
 *
 * The compose-ha effects live in ./compose-ha.js (a big fan-out set); the k8s
 * (single-cluster) effect lives in ./k8s.js and the k8s-ha effects in
 * ./k8s-ha.js — all spread into EFFECTS below.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as p from '@clack/prompts';
import { progressLog, spinner } from '../../cli/progress.js';
import { runCommandAsync } from '../../command.js';
import { knownHostsPathForKey, seedKnownHosts } from '../../host-keys.js';
import { perfAsync } from '../../perf.js';
import { providerFor, providerIdFor } from '../../providers/index.js';
import { sideloadCompose } from '../image.js';
import { buildRemote } from '../remote-build.js';
import { generateSSHKeyPair } from '../utils.js';
import { COMPOSE_HA_EFFECTS } from './compose-ha.js';
import { K8S_EFFECTS } from './k8s.js';
import { K8S_HA_EFFECTS } from './k8s-ha.js';

/**
 * Provision one Hetzner VPS via Pulumi, wait for SSH, and seed the trusted
 * host key. Sets ctx.serverIp / providerServerId / providerServerName so the
 * downstream effects (and the orchestrator's return value) can read them.
 * Gated by `when: !ctx.serverIp` — a warm redeploy skips it.
 */
async function provisionServer(ctx) {
  const {
    projectConfig,
    environment,
    region,
    serverType,
    apiToken,
    s3Config,
    sshKeyPath,
    envConfig,
  } = ctx;
  generateSSHKeyPair(sshKeyPath);
  const { upStack } = await import('../../iac/index.js');
  // Resolved once per flow — see providerFor() in lib/providers/index.js.
  const Provider = providerFor(envConfig);
  // CD2 — lazy dispatch through the provider class (no named
  // buildHetznerComposeProgram import) so Phase B providers slot in without
  // editing this file.
  const program = await Provider.getComposeProgram({
    projectName: projectConfig.projectName,
    environment,
    sshPublicKey: readFileSync(`${sshKeyPath}.pub`, 'utf-8').trim(),
    location: region,
    serverType: serverType || Provider.DEFAULT_COMPOSE_TYPE,
    labels: { 'managed-by': 'vibecarbon' },
    allowedSshIps: (projectConfig.operatorCidrs ?? []).map((e) => e.cidr),
  });
  // A spinner over the whole provision: Pulumi upStack (typical 30-90s on
  // Hetzner cx23) followed by the SSH-up wait ran with a dead cursor before —
  // no per-step UI (the plan runner is silent; effects own their own spinners).
  // spinner() registers as active so any retry chatter fired underneath updates
  // the line cleanly instead of corrupting it.
  const s = spinner();
  s.start(`Provisioning VPS in ${region}...`);
  try {
    const result = await perfAsync('deploy.iac.upStack', () =>
      upStack(environment, program, {
        provider: providerIdFor(envConfig),
        providerToken: apiToken,
        s3Config,
        projectName: projectConfig.projectName,
        // Recover stale-EMPTY outputs reads in place (read-only poll inside
        // upStack) — the hard gate below stays as the loud last resort.
        requiredOutputs: ['serverIp'],
      }),
    );
    // Hard gate: a stale S3 state read after a throttled stack-create can
    // return a "successful" up with EMPTY outputs (same family as the
    // stale-CHECKPOINT/stale-stack-select fixes in lib/iac). Without this,
    // undefined cascades into "Waiting for SSH on undefined" and finally a
    // misleading "Command array must contain only strings" from ssh-keyscan
    // (observed: compose e2e restore re-deploy, 2026-08-06). Fail loudly at
    // the source instead — a plain re-run reads fresh state and succeeds.
    if (!result.outputs?.serverIp) {
      throw new Error(
        'provision-server: Pulumi up returned no serverIp output; almost ' +
          'always a stale S3 state-backend read right after stack creation. ' +
          'Re-run the deploy; if it persists, inspect `pulumi stack output` ' +
          `for env '${environment}'.`,
      );
    }
    ctx.serverIp = result.outputs.serverIp;
    ctx.providerServerId = result.outputs.serverId || null;
    ctx.providerServerName = `${projectConfig.projectName}-${environment}`;
    // Both compose programs export firewallId; nothing used to read it, so
    // `vibecarbon scale` built its blue-green replacement with `firewalls: []`
    // and the new server came up with NO cloud firewall while the old
    // (firewalled) one was deleted. Persisting it here is what makes
    // scale-servers able to re-attach — see buildReplacementServerArgs.
    ctx.providerFirewallId = result.outputs.firewallId || null;
    const { waitForSSH } = await import('../compose/index.js');
    s.message(`Waiting for SSH on ${ctx.serverIp}...`);
    await perfAsync('deploy.iac.waitForSSH', () => waitForSSH(ctx.serverIp, sshKeyPath, 30));
  } catch (err) {
    s.stop('Provisioning failed', 1);
    throw err;
  }
  s.stop(`VPS provisioned: ${ctx.serverIp} (${region})`);
  // Trusted host-key seed on fresh provision — captures the new VPS's host
  // key via ssh-keyscan into the per-env known_hosts so the pinned SSH opts
  // (accept-new) become a strict pin. Re-seeding cleanly re-pins a Hetzner-
  // recycled IP (destroy → redeploy). Best-effort: falls back to accept-new.
  await seedKnownHosts(knownHostsPathForKey(sshKeyPath), ctx.serverIp);
}

/**
 * Wait for cloud-init to finish (ufw + unattended-upgrades). For local /
 * direct build modes also wait for dockerd — those modes need the daemon up
 * before they can sideload / build; push mode pulls from GHCR after compose-up.
 * State-gated: a warm redeploy against an unchanged server skips it.
 *
 * The readiness budget is provider-owned (see
 * BaseProvider.CLOUD_INIT_READY_TIMEOUT_MS) — resolved the same way
 * provisionServer resolves its Provider class, via ctx.envConfig — since how
 * long cloud-init takes depends on what the provider's base image already
 * has installed (e.g. DigitalOcean installs docker-ce INSIDE cloud-init,
 * unlike Hetzner's docker-ce image).
 */
async function setupServer(ctx) {
  const { state, serverIp, sshKeyPath, isDirectDeploy, isComposeLocal, envConfig } = ctx;
  const { setupServer: setupServerRemote, waitForDockerReady } = await import(
    '../compose/index.js'
  );
  const Provider = providerFor(envConfig);
  const timeoutMs = Provider.CLOUD_INIT_READY_TIMEOUT_MS;
  const setupInputs = { serverIp };
  if (!state.shouldSkip('compose-setup-server', setupInputs)) {
    state.startStep('compose-setup-server', setupInputs);
    await perfAsync('deploy.compose.cloudInitReady', async () => {
      if (isDirectDeploy || isComposeLocal) {
        await setupServerRemote(serverIp, sshKeyPath, timeoutMs);
        await waitForDockerReady(serverIp, sshKeyPath);
      } else {
        await setupServerRemote(serverIp, sshKeyPath, timeoutMs);
      }
    });
    state.completeStep('compose-setup-server', { serverIp });
  }
}

/**
 * Get the app image onto the server. Local: await the parallel build kicked
 * off during provisioning, then push it to the server's per-server registry
 * over an SSH tunnel (falling back to a full sideload tarball over SSH on any
 * registry-path failure). Direct: build on the server via DOCKER_HOST=ssh://.
 * Gated by `when` to local/direct modes; push mode is a no-op (server pulls
 * from GHCR at compose-up).
 */
async function transferImage(ctx) {
  const {
    serverIp,
    sshKeyPath,
    isComposeLocal,
    isDirectDeploy,
    localImageTag,
    composeLocalBuildPromise,
    projectConfig,
    domain,
  } = ctx;
  // F2: kick the image transfer off WITHOUT awaiting so it streams concurrently
  // with the two registry logins + the bundle upload (setupServerFiles) + DNS.
  // The barrier lives in startComposeStack, which awaits ctx.transferImagePromise
  // before `docker compose up` — compose references the app image, so it MUST be
  // present by reconcile time (LOAD-BEARING barrier; do not remove).
  if (isComposeLocal) {
    ctx.transferImagePromise = (async () => {
      // The local build was kicked off in the orchestrator in parallel with
      // provisioning; it is usually already done by now.
      await composeLocalBuildPromise;
      await perfAsync('deploy.image.transfer', async () => {
        // Registry-first: push only the changed layers to the server's own
        // registry:2 over an SSH tunnel, then have the server pull+retag
        // locally. The server-side retag is the seamlessness trick — it
        // lands the image back under `localImageTag` (`<proj>-app:local`),
        // so compose files, reconcile.sh's `pull --policy missing`, and the
        // sideload fallback below all see the same tag regardless of which
        // path actually delivered the image. Any failure in the registry
        // path (registry create, push, or server pull/retag) falls back to
        // the full-image sideload rather than failing the deploy.
        const { COMPOSE_PUSH_SETTLE_DELAYS_MS, ensureComposeRegistry, REGISTRY_PREFIX } =
          await import('../compose/registry.js');
        const { pushImageOverSshTunnel } = await import('../registry-push.js');
        const { sshRunAsync } = await import('../compose/index.js');
        const registryTag = `${REGISTRY_PREFIX}${localImageTag}`;
        try {
          await ensureComposeRegistry(serverIp, sshKeyPath);
          await runCommandAsync(['docker', 'tag', localImageTag, registryTag], { silent: true });
          await pushImageOverSshTunnel({
            tag: registryTag,
            remotePrefix: REGISTRY_PREFIX,
            serverIp,
            sshKey: sshKeyPath,
            khPath: knownHostsPathForKey(sshKeyPath),
            // Compose's own ladder, NOT the shared helper's k8s default: this
            // registry is filesystem-backed on a single server with one
            // pusher (no S3 throttling, no parallel HA cluster), and the
            // sideload fallback below bounds the cost of giving up early at
            // one full-image transfer. See COMPOSE_PUSH_SETTLE_DELAYS_MS.
            settleDelaysMs: COMPOSE_PUSH_SETTLE_DELAYS_MS,
          });
          await sshRunAsync(
            serverIp,
            sshKeyPath,
            `docker pull ${registryTag} && docker tag ${registryTag} ${localImageTag}`,
          );
        } catch (e) {
          progressLog(`[registry] falling back to sideload: ${e?.message ?? e}`);
          await sideloadCompose({
            tag: localImageTag,
            sshTarget: `root@${serverIp}`,
            sshKey: sshKeyPath,
          });
        }
      });
      // Completion is announced by the barrier spinner in startComposeStack, not
      // here — this promise resolves mid-flight (concurrent with the bundle
      // upload) so logging from inside it would land at an unpredictable spot.
    })();
  } else if (isDirectDeploy) {
    ctx.transferImagePromise = (async () => {
      const { collectComposeBuildArgs } = await import('../compose/build-args.js');
      const directBuildArgs = collectComposeBuildArgs(process.cwd(), {
        projectName: projectConfig.projectName,
        domain,
      });
      const success = await perfAsync('deploy.image.directBuild', () =>
        buildRemote(serverIp, sshKeyPath, localImageTag, process.cwd(), directBuildArgs),
      );
      if (!success) process.exit(1);
    })();
  }
  // Attach a no-op rejection handler so an in-flight failure doesn't surface as
  // an unhandledRejection before the barrier attaches its await; the real throw
  // still happens at the barrier (awaiting an already-rejected promise rethrows).
  ctx.transferImagePromise?.catch(() => {});
}

/**
 * Log the server into Docker Hub so reconcile.sh's `docker compose pull` of the
 * Supabase service images isn't subject to the per-IP unauthenticated pull
 * quota. State-gated on the creds fingerprint; `when` gates on creds present.
 */
/**
 * Skip-gate fingerprint for a registry token.
 *
 * This was `token.slice(0, 8)`, which carries ZERO entropy for the token
 * formats we actually see: every Docker Hub PAT begins `dckr_pat_`, so the
 * "fingerprint" was the literal constant `dckr_pat` for every token ever
 * issued (GitHub fine-grained PATs reduce to `github_p` the same way). A
 * rotated credential therefore produced an IDENTICAL gate input and the login
 * step skipped — the server kept using the revoked token, and pulls silently
 * degraded to anonymous, hitting the per-IP rate limit that the login exists
 * to avoid.
 *
 * The prefix was also plaintext token material in
 * `.vibecarbon/deploy-state-*.json`, which the comment at the GHCR call site
 * said it was trying to avoid. A real digest fixes both at once.
 *
 * @param {string|undefined} token
 * @returns {string} '' when absent, else a truncated sha256
 */
function tokenFingerprint(token) {
  if (!token) return '';
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

async function dockerhubLogin(ctx) {
  const { state, serverIp, sshKeyPath, dockerHubCreds } = ctx;
  const { dockerLoginOnServer } = await import('../compose/index.js');
  const dhLoginInputs = {
    serverIp,
    registry: 'docker.io',
    user: dockerHubCreds.username,
    tokenFp: tokenFingerprint(dockerHubCreds.token),
  };
  if (!state.shouldSkip('compose-dockerhub-login', dhLoginInputs)) {
    state.startStep('compose-dockerhub-login', dhLoginInputs);
    await dockerLoginOnServer(serverIp, sshKeyPath, dockerHubCreds);
    state.completeStep('compose-dockerhub-login', { serverIp });
  }
}

/** Log the server into GHCR when CI produced pull creds. State-gated. */
async function ghcrLogin(ctx) {
  const { state, serverIp, sshKeyPath, ciReady } = ctx;
  const { dockerLoginOnServer } = await import('../compose/index.js');
  const loginInputs = {
    serverIp,
    registry: 'ghcr.io',
    user: ciReady.ghcrPullCreds.owner,
    tokenFp: tokenFingerprint(ciReady.ghcrPullCreds.token),
  };
  if (!state.shouldSkip('compose-ghcr-login', loginInputs)) {
    state.startStep('compose-ghcr-login', loginInputs);
    await dockerLoginOnServer(serverIp, sshKeyPath, {
      username: ciReady.ghcrPullCreds.owner,
      token: ciReady.ghcrPullCreds.token,
      registry: 'ghcr.io',
    });
    state.completeStep('compose-ghcr-login', { serverIp });
  }
}

/** Tar the rendered bundle locally, stream over SSH, extract on the server. */
async function setupServerFiles(ctx) {
  const { state, serverIp, sshKeyPath, projectConfig, imageRef, domain, services, bundlePath } =
    ctx;
  const { setupServerFiles: setupServerFilesRemote } = await import('../compose/index.js');
  const { digestDir } = await import('../digest.js');
  const bundleInputs = {
    serverIp,
    projectName: projectConfig.projectName,
    imageRef,
    domain,
    services,
    // Content digest of the rendered bundle. Without it the gate is blind to
    // file-content-only changes (e.g. editing docker-compose.observability.yml
    // with imageRef/domain/services unchanged): the stale bundle would never
    // re-upload and reconcile would run `docker compose up` against old server
    // files. Bug confirmed in prod 2026-07-11.
    bundleDigest: digestDir(bundlePath),
  };
  if (!state.shouldSkip('compose-setup-files', bundleInputs)) {
    state.startStep('compose-setup-files', bundleInputs);
    await perfAsync('deploy.bundle.upload', () =>
      setupServerFilesRemote(serverIp, sshKeyPath, projectConfig.projectName, {
        ...services,
        domain,
        image: imageRef,
        bundlePath,
      }),
    );
    state.completeStep('compose-setup-files', { serverIp });
  }
}

/**
 * Write the real DNS A record and (HTTP-01 only) wait for propagation BEFORE
 * compose-up so Traefik's first ACME challenge sees real DNS. DNS-01 (managed
 * providers) skips the propagation wait — lego validates via a TXT record.
 * `when` gates on a domain + a non-manual provider; state-gates the write.
 */
async function updateDns(ctx) {
  const {
    serverIp,
    domain,
    dnsProvider,
    dnsZoneId,
    dnsToken,
    state,
    dnsWarmupPromise,
    dnsChallenge,
  } = ctx;
  await perfAsync('deploy.dns.warm', async () => {
    await dnsWarmupPromise;
  });
  const dnsUpdateInputs = { domain, dnsProvider, serverIp };
  if (!state.shouldSkip('compose-dns-update', dnsUpdateInputs)) {
    state.startStep('compose-dns-update', dnsUpdateInputs);
    const { getDnsProvider } = await import('../../dns-provider.js');
    const { setupSimple: updateDnsIp } = await getDnsProvider(dnsProvider);
    const dnsSpinner = spinner();
    dnsSpinner.start(`Pointing ${domain} → ${serverIp}...`);
    // onProgress suppresses setupSimple's own internal spinner — this caller
    // already owns the "Pointing" spinner, so letting setupSimple start a
    // SECOND one would overlap and garble the line. Route its one progress
    // beat to this spinner's message instead.
    await perfAsync('deploy.dns.create', () =>
      updateDnsIp(dnsToken, dnsZoneId, domain, serverIp, {
        onProgress: (m) => dnsSpinner.message(m),
      }),
    );
    dnsSpinner.stop(`DNS A record set: ${domain} → ${serverIp}`);
    state.completeStep('compose-dns-update', { serverIp });
  }
  // Both challenge types gate on DNS here, but on DIFFERENT facts, because
  // they fail differently.
  //
  // HTTP-01 needs the A record VISIBLE to public resolvers — Let's Encrypt
  // rejects the challenge with "no valid A records found" if its resolver sees
  // stale or absent records.
  //
  // DNS-01 does not care about the A record at all; it needs the zone's own
  // nameservers to ANSWER. Linode publishes a zone to ns1-5.linode.com only
  // once the account holds an active Linode, so a freshly created zone returns
  // REFUSED from every nameserver while its API record reads
  // `"status": "active"`. Starting DNS-01 in that state burns ~20 minutes
  // before ACME gives up. Preflight cannot cover it — preflight runs before the
  // instance exists, which IS the REFUSED state.
  //
  // Both are fail-open: they return false on timeout and the deploy proceeds,
  // since either client still retries on its own and a false abort of a healthy
  // deploy is strictly worse than the wait these avoid.
  if (!dnsChallenge) {
    const { waitForDNSPropagation } = await import('../../dns-propagation.js');
    // Kept on p.spinner (not the progress.js wrapper): the wrapper's spinner()
    // forwards no args, so it would drop `{ indicator: 'timer' }`. See report —
    // making progress.js forward options would let this register as active too.
    const dnsSpinner = spinner({ indicator: 'timer' });
    dnsSpinner.start(`Waiting for ${domain} to resolve to ${serverIp}`);
    const dnsPropagated = await perfAsync('deploy.dns.waitForPropagation', () =>
      waitForDNSPropagation(domain, serverIp, 120_000),
    );
    dnsSpinner.stop(
      dnsPropagated
        ? `DNS resolves: ${domain} → ${serverIp}`
        : `DNS propagation timed out, proceeding anyway`,
    );
  } else {
    const { waitForZoneServed } = await import('../../dns-propagation.js');
    const zoneSpinner = spinner({ indicator: 'timer' });
    zoneSpinner.start(`Waiting for ${domain}'s nameservers to serve the zone`);
    const zone = await perfAsync('deploy.dns.waitForZoneServed', () =>
      waitForZoneServed(domain, {
        timeoutMs: 180_000,
        onProgress: (detail) => zoneSpinner.message(detail),
      }),
    );
    zoneSpinner.stop(
      zone.served
        ? `Nameservers serving ${domain} (${zone.detail})`
        : `Zone not served after ${Math.round(zone.waitedMs / 1000)}s (${zone.detail}), proceeding anyway`,
    );
  }
}

/** Reconcile the Compose stack (`docker compose pull` + `up -d`) on the VPS. */
async function startComposeStack(ctx) {
  const { serverIp, sshKeyPath, projectConfig, services } = ctx;
  // F2 barrier: the app image transfer was kicked off (non-blocking) in
  // transferImage so it overlapped the logins + bundle upload + DNS.
  // `docker compose up` references the app image, so it MUST be on the server
  // first — await the transfer here. LOAD-BEARING: never remove this barrier.
  if (ctx.transferImagePromise) {
    // The transfer/build was kicked off in transferImage and streamed
    // concurrently with the bundle upload + DNS. For compose-local the transfer
    // (registry push, or sideload — docker save | gzip | ssh | docker load, on
    // fallback) runs SILENTLY, and a large image over a slow uplink can take
    // minutes — so show a spinner at the barrier instead of sitting on a dead
    // cursor. Direct deploy's buildRemote drives its own spinner, so don't
    // double up there.
    const s = ctx.isComposeLocal ? spinner() : null;
    s?.start(`Transferring app image to ${serverIp}...`);
    try {
      await perfAsync('deploy.image.transfer.await', () => ctx.transferImagePromise);
      s?.stop('App image transferred to the server');
    } catch (err) {
      s?.stop('App image transfer failed', 1);
      throw err;
    }
  }
  const { startComposeStack: startComposeStackRemote } = await import('../compose/index.js');
  await perfAsync('deploy.reconcile.run', () =>
    startComposeStackRemote(serverIp, sshKeyPath, projectConfig.projectName, services),
  );
}

/**
 * Apply app migrations + reload PostgREST. Shipped-bug guard: the inlined
 * single-compose path once skipped this and shipped an EMPTY app schema.
 * runMigrations waits for supabase_admin, applies each supabase/migrations/*
 * with ON_ERROR_STOP=1 (a real failure aborts the deploy), runs the two
 * ground-truth audits against the live system — RLS (rls-audit.js) and wal-g
 * backups (walg-audit.js), each of which FAILS the deploy — then reloads the
 * PostgREST schema cache.
 */
async function runMigrations(ctx) {
  const { serverIp, sshKeyPath, projectConfig } = ctx;
  const { runMigrations: runMigrationsRemote } = await import('../compose/index.js');
  await perfAsync('deploy.compose.migrations', () =>
    runMigrationsRemote(serverIp, sshKeyPath, projectConfig.projectName),
  );
}

/**
 * Create the production app super-admin via GoTrue's admin API. Shipped-bug
 * guard: the inlined path once skipped it, shipping a prod app the operator
 * couldn't log into. Idempotent (422 = exists). FATAL on failure (fast-follow
 * to M3 Task 9h, mirrors k3s.js#provisionAdminUser): createAdminUserRemote
 * now retries the whole auth-readiness + SSH-tunnel + POST flow under its own
 * budget and throws once exhausted, or throws immediately on missing admin
 * credentials — no soft `{success: false}` return remains to branch on here.
 */
async function createAdminUser(ctx) {
  const { serverIp, sshKeyPath, projectConfig } = ctx;
  const { createAdminUser: createAdminUserRemote } = await import('../compose/index.js');
  const adminResult = await perfAsync('deploy.compose.createAdminUser', () =>
    createAdminUserRemote(serverIp, sshKeyPath, projectConfig.projectName),
  );
  p.log.success(adminResult.message);
}

/**
 * Verifiable success gate: probe the app's own /api/health on the server (via
 * localhost + Host header), bypassing DNS/TLS. A healthy deploy must yield a
 * 2xx here; otherwise fail loudly with container state + log tail.
 */
async function verifyHealth(ctx) {
  const { serverIp, sshKeyPath, projectConfig, domain } = ctx;
  const { verifyAppHealth } = await import('../compose/index.js');
  const healthSpinner = spinner({ indicator: 'timer' });
  healthSpinner.start('Waiting for app to start serving requests');
  let health;
  try {
    health = await perfAsync('deploy.health.probe', () =>
      verifyAppHealth(serverIp, sshKeyPath, projectConfig.projectName, { domain }),
    );
  } catch (err) {
    healthSpinner.stop('App health probe errored', 1);
    throw err;
  }
  if (!health.healthy) {
    healthSpinner.stop(`App not serving requests (status: ${health.status})`, 1);
    p.log.error(
      `Deploy produced an unhealthy app (probe status: ${health.status}):\n${health.details}`,
    );
    process.exit(1);
  }
  healthSpinner.stop(`App is serving requests (HTTP ${health.status})`);
}

/**
 * TLS-ready gate (shared by compose and compose-ha — it reads the primary's
 * identity from either ctx shape): the deploy is not done until the domain
 * serves a certificate the platform trust store accepts. Traefik/lego ACME
 * runs asynchronously from start-compose-stack onward; before this gate the
 * deploy could report success while the apex still served the Traefik
 * self-signed default (or, on compose-ha, an apex-less wildcard) — a
 * browser security warning presented as a successful deploy (DigitalOcean
 * DNS-01 propagation, run 33252884427). On failure the Traefik log tail is
 * fetched into the error so the ACME cause travels with the failure.
 * Manual-DNS deploys degrade to a warning instead: issuance can't complete
 * before the customer points the domain (see tls-ready.js).
 */
async function verifyTlsReady(ctx) {
  const { domain, dnsProvider, sshKeyPath, projectConfig } = ctx;
  const ip = ctx.serverIp ?? ctx.primary?.ip ?? null;
  const managedDns = Boolean(dnsProvider) && dnsProvider !== 'manual';
  const { TLS_READY_MANUAL_BUDGET_MS, assertTlsReadyOrDegraded, waitForTrustedTls } = await import(
    '../tls-ready.js'
  );
  const tlsSpinner = spinner({ indicator: 'timer' });
  tlsSpinner.start(`Waiting for ${domain} to serve a trusted TLS certificate`);
  const result = await perfAsync('deploy.tls.ready', () =>
    waitForTrustedTls(domain, {
      ...(managedDns ? {} : { budgetMs: TLS_READY_MANUAL_BUDGET_MS }),
      onProgress: (msg) => tlsSpinner.message(msg),
    }),
  );
  if (result.trusted) {
    tlsSpinner.stop(
      `TLS certificate trusted (issued within ${Math.round(result.elapsedMs / 1000)}s)`,
    );
    return;
  }
  tlsSpinner.stop('Domain is not serving a trusted TLS certificate', managedDns ? 1 : 0);
  // Name the cause in the failure itself: the ACME error lives in Traefik's
  // log, which was previously nowhere in any failure surface.
  let traefikLogTail = '';
  if (ip && sshKeyPath) {
    const { sshRunAsync } = await import('../compose/index.js');
    traefikLogTail =
      (await sshRunAsync(
        ip,
        sshKeyPath,
        `cd /opt/${projectConfig.projectName} && docker compose logs --tail=60 traefik 2>&1 | tail -40`,
        { timeout: 15_000, ignoreError: true },
      )) || '';
  }
  const { degraded, reason } = assertTlsReadyOrDegraded({
    trusted: false,
    managedDns,
    reason: result.reason,
    served: result.served,
    traefikLogTail,
    fixHint: managedDns
      ? `Check Traefik's ACME DNS-01 solver for ${dnsProvider} (token validity, zone ownership) in the log tail below.`
      : '',
  });
  if (degraded) {
    p.log.warn(
      `TLS is not trusted yet (manual DNS — Traefik finishes issuance once the domain points here): ${reason}`,
    );
  }
}

/**
 * Install the scheduled wal-g backup cron on the VPS. Shipped-bug guard: a
 * fresh compose deploy used to collect backupConfig but never schedule a
 * backup. A cron-install failure must NOT fail an already-healthy deploy —
 * downgrade to a warning.
 */
async function setupBackupCron(ctx) {
  const { serverIp, sshKeyPath, projectConfig, backupConfig } = ctx;
  const { setupComposeBackupCron } = await import('../compose/index.js');
  try {
    await perfAsync('deploy.compose.backupCron', async () =>
      setupComposeBackupCron(serverIp, sshKeyPath, projectConfig.projectName, backupConfig),
    );
  } catch (err) {
    p.log.warn(`Scheduled backup cron install failed (deploy still succeeded): ${err.message}`);
  }
}

export const EFFECTS = {
  noop: async () => {},
  // compose deploy tier
  provisionServer,
  setupServer,
  transferImage,
  dockerhubLogin,
  ghcrLogin,
  setupServerFiles,
  updateDns,
  startComposeStack,
  runMigrations,
  createAdminUser,
  verifyHealth,
  verifyTlsReady,
  setupBackupCron,
  // compose-ha deploy tier (fan-out over primary + standby)
  ...COMPOSE_HA_EFFECTS,
  // k8s deploy tier (single k3s cluster — wraps deployK3s)
  ...K8S_EFFECTS,
  // k8s-ha deploy tier (two k3s clusters + WireGuard replication)
  ...K8S_HA_EFFECTS,
};
