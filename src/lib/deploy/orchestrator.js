/**
 * Deployment Orchestrator
 * Logic for executing the deployment after configuration is gathered
 */

import dns from 'node:dns';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { progressLog, spinner } from '../cli/progress.js';
import { c } from '../colors.js';
import { runCommand, runCommandAsync } from '../command.js';
import { loadProjectConfig, registerProject, saveProjectConfig } from '../config.js';
import { getDnsProvider, hasAutomatedDns } from '../dns-provider.js';
import { ensureOperatorIpAccess } from '../operator-ip.js';
import { perfAsync, perfTimer } from '../perf.js';
import { runProjectAssignment } from '../project-assignment.js';
import {
  assertTierSupported,
  getObjectStorageProvider,
  providerFor,
  providerIdFor,
} from '../providers/index.js';
import { createTracker } from '../tracker.js';
import { useDnsChallenge } from './acme.js';
import { renderBundle } from './bundle.js';
import { armDeployCompletionGuard, markDeployCompleted } from './completion-guard.js';
import { assertNoComposeHaRoleSwap } from './compose/ha-role-swap.js';
import { workingTreeDirty } from './delta.js';
import { resolveDockerHubCreds } from './docker-hub.js';
import { createAcmeIssuanceWatchdog, deriveScaleUpList } from './k8s/index.js';
import { AMD64_BUILD_HINT, PLATFORM_BUILD_FLAG } from './platform.js';
import { checkDeployPrerequisites } from './preflight.js';
import { StateTracker } from './state.js';
import { isComposeTier, isHATier, isK8sTier, resolveTier } from './tier-registry.js';

/**
 * Probe the public /api/health endpoint to verify the app is reachable
 * over the internet.
 *
 * K8s cold deploys need a generous budget: after the GHA workflow returns,
 * cert-manager may still be finishing cert issuance, DNS may be
 * propagating, and the ingress may be picking up new routes. 10 minutes
 * handles first-deploy cert+DNS tail without false-negatives. Compose
 * already has a faster on-server health gate before we ever get here, so
 * 60s is enough to catch DNS edge cases.
 *
 * When `ACME_CA_SERVER` is set to a Let's Encrypt staging URL (e2e
 * tests, dev envs avoiding LE rate limits), cert-manager issues a cert
 * signed by the LE Staging CA which Node's default trust store does not
 * include — fetch() would reject every probe with "self-signed cert"
 * even though the app is healthy. Detect that case and use an undici
 * dispatcher whose trust store is the system roots PLUS the vendored LE
 * staging roots (src/lib/deploy/staging-ca.js) — verification stays on,
 * so an actually-broken chain still fails the probe. Real-world prod
 * runs are unaffected.
 *
 * Returns `{ ok: true, status }` on first 2xx, or a structured failure
 * descriptor on timeout — never null. Capturing last-status and last-error
 * lets the caller throw with actionable context (e.g. "lastStatus=503 over
 * 120 attempts" tells you ingress is up but app is failing) instead of the
 * old opaque null which made the error message default to whatever stderr
 * tail the runner happened to scrape (the 2026-04-27 morning matrix's k8s
 * timeout surfaced as a CSP header dump because of this exact gap).
 */
async function probePublicHealth(
  domain,
  { timeoutMs = 60_000, intervalMs = 10_000, onPoll = null, onPollEvery = 6 } = {},
) {
  const url = `https://${domain}/api/health`;
  const deadline = Date.now() + timeoutMs;
  let abortReason = null;
  let firstAttempt = true;
  let attempts = 0;
  let lastStatus = null;
  let lastErrorClass = null;
  let lastErrorMessage = null;
  let lastErrorCause = null;
  // The probe runs IMMEDIATELY after we (re)write the DNS record, so the
  // system resolver may still have a cached NXDOMAIN or a prior placeholder
  // IP. Fetch then fails for the entire probe budget while curl (run once
  // in the diagnostic dump much later) gets a fresh getaddrinfo and
  // succeeds — the symptom that surfaced as "TypeError: fetch failed (121
  // attempts)" while the diagnostic curl returned `{"status":"ok"}` in
  // matrix #3 (k8s + k8s-ha). Pin the resolver to public DNS for the
  // probe so we always see the freshest record. setServers is per-process
  // and doesn't affect anything else in this orchestrator instance.
  try {
    dns.setDefaultResultOrder('verbatim');
    dns.setServers(['1.1.1.1', '8.8.8.8']);
  } catch {
    // setServers can throw if called with an empty list or invalid IPs;
    // both are caller errors, not runtime concerns. Fall through and use
    // whatever resolver is currently configured.
  }
  // Lazy-load undici only when we need a custom-trust dispatcher — keeps the
  // happy path zero-cost and avoids a hard dep on undici internals.
  //
  // CRITICAL: when we use undici's Agent we MUST also use undici's `fetch`,
  // not Node 24's `globalThis.fetch`. Node 24 ships its own bundled undici;
  // its built-in fetch's dispatcher protocol is incompatible with the npm
  // undici package's Agent (different `onRequestStart` signature). Mixing
  // them produces `InvalidArgumentError: invalid onRequestStart method` on
  // every probe call, with the misleading wrapper "TypeError: fetch failed"
  // — which is what dominated every k8s + k8s-ha matrix failure for weeks.
  // Always pair Agent + fetch from the same undici instance.
  //
  // Staging runs get FULL verification against system roots + the vendored
  // LE staging roots (src/lib/deploy/staging-ca.js) — never a verification
  // opt-out, which would also wave through self-signed/expired/wrong-host
  // chains, the exact misconfigurations this probe exists to catch.
  let dispatcher = null;
  let fetchFn = fetch;
  if ((process.env.ACME_CA_SERVER || '').includes('staging')) {
    const undici = await import('undici');
    const { stagingProbeCa } = await import('./staging-ca.js');
    dispatcher = new undici.Agent({ connect: { ca: stagingProbeCa() } });
    fetchFn = undici.fetch;
  }
  // Periodic progress logging: every 5 attempts, write a one-line summary
  // of the most recent failure class + lastStatus to stderr. Without this,
  // the only signal we get from a 5-min probe is the FINAL outcome — which
  // tells us nothing about whether the early failures were DNS-related,
  // TCP-refused, or app-side 5xx. iter-perfwave2 analysis: k8s-ha probe
  // hits exactly 300s = 30 × 10s (DNS TTL match suspicious), but with no
  // per-attempt visibility we can't distinguish "DNS cached for 300s" from
  // "ACME issuance pending for 300s" from "app slow to converge".
  const startTime = Date.now();
  const logProgress = () => {
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    const lastSig = lastStatus
      ? `lastStatus=${lastStatus}`
      : lastErrorCause
        ? `lastError=${lastErrorClass}/${lastErrorCause}`
        : lastErrorClass
          ? `lastError=${lastErrorClass}`
          : 'no-response-yet';
    // Route through progressLog: the caller wraps probePublicHealth in an active
    // spinner ("Probing https://…/api/health"), and this every-5-attempts line
    // would otherwise shred that spinner's cursor line. progressLog updates the
    // spinner message when one is up, else falls back to console.error verbatim.
    progressLog(`[probe] ${url} attempt=${attempts} elapsed=${elapsedSec}s ${lastSig}`);
  };
  while (Date.now() < deadline) {
    if (!firstAttempt) await new Promise((r) => setTimeout(r, intervalMs));
    firstAttempt = false;
    attempts++;
    try {
      const res = await fetchFn(url, {
        method: 'GET',
        signal: AbortSignal.timeout(8_000),
        ...(dispatcher && { dispatcher }),
      });
      lastStatus = res.status;
      if (res.ok) return { ok: true, status: String(res.status), attempts };
    } catch (err) {
      // Capture failure class + short message so the eventual throw can
      // say *why* the probe never reached 2xx. Common patterns:
      //   - TimeoutError → ingress not routing or pod hung
      //   - TypeError "fetch failed" → DNS or TCP refused
      //   - Error "self-signed certificate" → the served chain validates
      //     against NEITHER the system roots nor the pinned LE staging
      //     roots: genuinely bad cert, or ACME issuance hasn't replaced the
      //     ingress default self-signed cert yet (retry usually clears it)
      // Undici nests the actual reason in err.cause (e.g. ENOTFOUND,
      // ECONNREFUSED, EAI_AGAIN, UND_ERR_SOCKET). The wrapper "fetch
      // failed" is useless without it — capture the cause's name+message
      // so we can distinguish DNS failure from TCP refused from TLS
      // handshake failure without re-running the matrix.
      lastErrorClass = err?.name ?? 'Unknown';
      lastErrorMessage = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      const cause = err && typeof err === 'object' && 'cause' in err ? err.cause : null;
      if (cause) {
        const causeName = cause?.name ?? cause?.code ?? 'UnknownCause';
        const causeMsg = (cause instanceof Error ? cause.message : String(cause)).slice(0, 200);
        lastErrorCause = `${causeName}: ${causeMsg}`;
      }
    }
    if (attempts % 5 === 0) logProgress();
    // Watchdog hook. The probe can only ever observe "the URL still doesn't
    // serve" — it cannot tell a slow cold start apart from an issuance that
    // is dead and will never complete. `onPoll` looks at the cluster
    // resources behind the URL and can repair a terminally-failed ACME
    // order, or tell us to stop waiting. It fails open by contract, so a
    // watchdog problem can never be the reason a deploy fails.
    // The watchdog fails open internally too, but the probe does not take
    // that on trust: a throw from anything reached through `onPoll` must
    // cost this probe nothing but the current tick.
    if (onPoll && attempts % onPollEvery === 0) {
      try {
        const verdict = await onPoll(attempts);
        if (verdict?.action === 'abort') {
          abortReason = verdict.reason;
          break;
        }
      } catch (err) {
        progressLog(
          `[probe] watchdog poll threw, continuing: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
  return {
    ok: false,
    attempts,
    timeoutMs,
    lastStatus,
    lastErrorClass,
    lastErrorMessage,
    lastErrorCause,
    abortReason,
    url,
  };
}

/**
 * Where this environment's kubeconfig lives.
 *
 * HA deploys split into kubeconfig-<env>-primary / -standby; standalone uses
 * just kubeconfig-<env>. Prefer primary — the user-facing cluster, whose
 * Traefik and cert-manager state is the one that decides whether the domain
 * serves. Returns the standalone path when neither exists so the caller
 * surfaces a file-not-found rather than a silent skip.
 */
function resolveKubeconfigPath(environment) {
  const candidates = [
    join(process.cwd(), '.vibecarbon', `kubeconfig-${environment}-primary`),
    join(process.cwd(), '.vibecarbon', `kubeconfig-${environment}`),
  ];
  return { path: candidates.find((c) => existsSync(c)) ?? candidates[1], candidates };
}

/**
 * Execute the deployment based on gathered configuration
 */
export async function executeDeployment(args, gatheredConfig) {
  // Arm the silent-success guard FIRST. If this function's awaited work never
  // settles (2026-07-07 k8s-ha RCA: a standby deployK3s promise dangled and Node
  // drained the event loop, exiting 0 with the DR gate + config-persist never
  // reached), the process 'exit' handler forces a non-zero code. markDeployCompleted()
  // is only reached after the terminal saveProjectConfig at the end of this fn.
  armDeployCompletionGuard();
  const {
    projectConfig,
    envConfig,
    environment,
    config,
    apiToken,
    region,
    secondaryRegion,
    serverType,
    masterServerType,
    supabaseServerType,
    workerServerType,
    minWorkers,
    maxWorkers,
    domain,
    dnsProvider,
    // Unified DNS credentials (prompts resolves them registry-driven: for an
    // automated dnsProvider, dnsToken is non-null — same-token rule or
    // guided setup — and dnsZoneId names the discovered zone; for manual,
    // both are null).
    dnsZoneId,
    dnsToken,
    s3Config,
    backupS3Config,
    backupConfig,
    services,
  } = gatheredConfig;

  const { deployMode } = config;
  const tier = resolveTier({ deployMode, ha: config.ha });
  // DATA-LOSS REFUSAL, first thing after the tier is known and BEFORE any
  // mutation (the operator-firewall patch below, the S3 buckets, the image
  // push, the DNS warm-up, the plan itself). `envConfig` here is the
  // environment's persisted config as it stood before this invocation, so it
  // still carries the roles a failover flipped — the one and only place the
  // swap is recorded. See compose/ha-role-swap.js for why compose-HA (unlike
  // k8s-HA) cannot converge a swapped environment.
  assertNoComposeHaRoleSwap({ projectName: projectConfig.projectName, environment, envConfig });
  // Fail fast with install guidance if host-side tools (pulumi, ssh) are
  // missing — before any Pulumi/SSH work would otherwise ENOENT mid-deploy.
  // Provider passed so the pulumi VERSION assertion can fire: a CLI too old
  // for this provider's state-backend options fails as totally as a missing
  // one, with a bucket error that names neither pulumi nor a version.
  checkDeployPrerequisites(tier, { ProviderClass: providerFor(config) });
  assertTierSupported(providerFor(config), tier);

  // Operator-IP access: detect + persist + (when env already deployed) patch
  // the live Hetzner firewall. On a fresh first deploy this just appends to
  // projectConfig.operatorCidrs in memory and on disk — the firewall itself
  // is created later in this function with the correct source_ips because
  // every program-builder call site reads projectConfig.operatorCidrs.
  // Spinner: detectOperatorIp is an external HTTP round-trip and the firewall
  // patch is a Hetzner API call — on a slow uplink this phase is seconds of
  // dead air right after the credential lines, and the deploy looks hung.
  // onMessage routes through progressLog so mid-phase info updates the spinner
  // line instead of shredding it.
  const accessSpinner = spinner();
  accessSpinner.start('Checking operator IP access');
  let accessResult;
  try {
    accessResult = await ensureOperatorIpAccess({
      projectConfig,
      environment,
      isHA: isHATier(tier),
      apiToken,
      yes: !!args.yes,
      onMessage: (msg) => progressLog(msg),
    });
  } catch (err) {
    accessSpinner.stop('Operator IP access check failed', 1);
    throw err;
  }
  accessSpinner.stop(
    accessResult.added
      ? `Operator access list updated (${accessResult.cidr})`
      : 'Operator IP access verified',
  );
  if (accessResult.added && accessResult.fromEnv) {
    p.log.info(`Bootstrapped operator CIDRs from ALLOWED_SSH_IPS env var: ${accessResult.cidr}`);
  }

  // Initialize state tracker for granular resume
  const state = new StateTracker(projectConfig.projectName, environment);

  // Clear state if --full is passed
  if (args.full) {
    state.clear();
  }

  const s3Spinner = spinner();
  const { resolveStateBucketName } = await import('../providers/hetzner-s3.js');
  const s3Provider = await getObjectStorageProvider(
    providerIdFor(envConfig),
    s3Config.accessKey,
    s3Config.secretKey,
    s3Config.region,
  );

  // Dedicated Pulumi-state bucket, resolved in three steps:
  //
  //   1. The environment's PERSISTED name, so an env that has deployed keeps
  //      the exact bucket it has been using.
  //   2. A project-level `stateBucket` PIN, for operators who want one named
  //      bucket to hold their Pulumi state rather than a derived name. Pulumi's
  //      DIY layout keys state as `.pulumi/stacks/<project>/<stack>.json` and
  //      our Pulumi project name is constant, so distinct stack names coexist
  //      in one bucket safely — which is also what lets the e2e harness point
  //      every scenario at a single long-lived bucket instead of creating a
  //      brand-new one per run.
  //   3. Derivation from the app bucket, for everyone else.
  //
  // `stateBucketGeneration` is still embedded by the derivation but is no
  // longer rotated on destroy: destroy KEEPS the state bucket now
  // (retainStateBucket), so nothing is ever recreated under a name that just
  // got deleted — the acked-write-loss hazard that rotation existed for (e4
  // restore->failover 2026-08-07) cannot arise.
  //
  // Both HA stacks share this ONE bucket.
  const stateBucket = resolveStateBucketName({
    envStateBucket: s3Config.stateBucket,
    projectPin: projectConfig.stateBucket,
    appBucket: s3Config.bucket,
    generation: projectConfig.stateBucketGeneration,
  });

  // --- STEP 1: S3 Setup (Idempotent) ---
  // `stateBucket` is part of the inputs hash so an upgraded CLI (whose prior
  // deploy-state predates the dedicated state bucket) re-runs this step once to
  // create + migrate the state bucket. Combined with the StateTracker version
  // bump, no stale hash can skip the migration.
  const s3Inputs = {
    bucket: s3Config.bucket,
    backupBucket: backupS3Config.bucket,
    stateBucket,
    region: s3Config.region,
  };
  // Verify hook: even on a matching hash, re-run s3-setup if any of the buckets
  // were deleted out-of-band (e.g. by a prior `destroy`). Without this, a
  // resumed deploy skips bucket creation then fails downstream on NoSuchBucket
  // (the exact resume hazard called out in Finding 2). Other steps that would
  // benefit from a similar probe — `compose-setup-server` (server may be gone)
  // and `dns-setup` — are left on the plain hash check to keep this change
  // focused; s3-setup is the highest-value one because the state backend lives
  // here.
  const verifyBucketsExist = async () => {
    const [app, backup, stateB] = await Promise.all([
      s3Provider.bucketExists(s3Config.bucket),
      backupS3Config?.bucket
        ? s3Provider.bucketExists(backupS3Config.bucket)
        : Promise.resolve(true),
      s3Provider.bucketExists(stateBucket),
    ]);
    return app && backup && stateB;
  };
  // Spinner: on a resumed deploy the three bucketExists HEAD probes are the
  // only work here, but they're still network round-trips — cover them so the
  // resume path doesn't sit on a bare cursor.
  const saveSkeletonEnv = () => {
    const existingEnv = projectConfig.environments?.[environment] ?? {};
    const skeletonEnv = {
      ...existingEnv,
      envName: environment,
      status: 'deploying',
      deployMode,
      provider: config.provider,
      region,
      ...(secondaryRegion ? { secondaryRegion } : {}),
      ...(domain ? { domain } : {}),
      ...(dnsProvider ? { dnsProvider } : {}),
      s3: {
        bucket: s3Config.bucket,
        region: s3Config.region,
        endpoint: s3Config.endpoint,
        stateBucket: s3Config.stateBucket,
      },
      backupS3: backupS3Config?.bucket
        ? {
            bucket: backupS3Config.bucket,
            region: backupS3Config.region,
            endpoint: backupS3Config.endpoint,
          }
        : existingEnv.backupS3,
      ...(deployMode === 'compose-ha' || (deployMode === 'kubernetes' && secondaryRegion)
        ? {
            ha: {
              ...(existingEnv.ha ?? {}),
              enabled: true,
              ...(secondaryRegion ? { failoverRegion: secondaryRegion } : {}),
            },
          }
        : {}),
      lastAttempt: new Date().toISOString(),
    };
    projectConfig.environments = projectConfig.environments ?? {};
    projectConfig.environments[environment] = skeletonEnv;
    saveProjectConfig(projectConfig);
  };
  // FIRST skeleton save BEFORE any S3 work: bucket creation itself mutates
  // provider state (and can partially succeed), and a failure inside s3-setup
  // used to exit before the post-s3 skeleton save ever ran — leaving an env
  // entry with NO deployMode, which crashed `vibecarbon destroy` at planning
  // ("Unknown deployMode: undefined", DO run 32670715722) so teardown never
  // ran at all. Region/endpoint fields may still be provisional here; the
  // post-s3 call re-persists the corrected values.
  saveSkeletonEnv();

  s3Spinner.start('Verifying S3 buckets');
  const skipS3Setup = await state.shouldSkipWithVerify('s3-setup', s3Inputs, verifyBucketsExist);
  s3Spinner.stop(skipS3Setup ? 'S3 buckets ready' : 'S3 setup needed');
  if (!skipS3Setup) {
    state.startStep('s3-setup', s3Inputs);
    try {
      s3Spinner.start(`Creating S3 bucket: ${s3Config.bucket}`);
      const bucket = await s3Provider.createBucket(s3Config.bucket);
      s3Spinner.stop(
        bucket.created
          ? `S3 bucket created: ${s3Config.bucket}`
          : `S3 bucket exists: ${s3Config.bucket}`,
      );

      try {
        s3Spinner.start('Configuring bucket CORS');
        // SECURITY: never fall back to a `*` wildcard — that would let any
        // origin issue credentialed browser requests against the storage
        // bucket. When a domain is configured we scope to its https origins
        // (apex + api/app subdomains the app actually serves from); a
        // domainless deploy has no browser origin to trust yet, so we scope
        // to localhost dev origins and warn. The operator re-runs deploy once
        // a domain is set to widen CORS to the real origin.
        let corsOrigins;
        if (domain) {
          // Single public origin — Supabase/storage is served on the apex.
          corsOrigins = [`https://${domain}`];
        } else {
          corsOrigins = ['http://localhost:3000', 'http://localhost:5173'];
          p.log.warn(
            'No domain configured — scoping bucket CORS to localhost dev origins instead of `*`. Re-run deploy with a domain to allow your production origin.',
          );
        }
        await s3Provider.configureCORS(s3Config.bucket, corsOrigins);
        s3Spinner.stop('CORS configured');
      } catch {
        s3Spinner.stop('CORS configuration skipped (not supported by provider)');
      }

      s3Spinner.start(`Creating backup bucket: ${backupS3Config.bucket}`);
      try {
        const backupBucket = await s3Provider.createBucket(backupS3Config.bucket);
        s3Spinner.stop(
          backupBucket.created
            ? `Backup bucket created: ${backupS3Config.bucket}`
            : `Backup bucket exists: ${backupS3Config.bucket}`,
        );
      } catch (backupBucketError) {
        s3Spinner.stop(`Backup bucket creation failed: ${backupBucketError.message}`);
      }

      // Capture the region/endpoint the APP and BACKUP buckets were actually
      // created under, BEFORE the state-bucket create below. createBucket's
      // exists-elsewhere recovery can flip s3Provider.region/endpoint to
      // wherever a retained state bucket already lives — and the persist block
      // at the bottom of this step used to read the flipped values and record
      // the app/backup buckets under a region where they do not exist, so the
      // deployed storage config and wal-g both 404'd (review finding,
      // 2026-08-15). The state bucket may legitimately live in a different
      // region; the app/backup config must never follow it there.
      const appBucketRegion = s3Provider.region;
      const appBucketEndpoint = s3Provider.getEndpoint();

      // Dedicated Pulumi-state bucket. Created imperatively (like the app +
      // backup buckets) BEFORE any Pulumi stack op. NOT
      // web-facing: no CORS, not public.
      s3Spinner.start(`Creating Pulumi state bucket: ${stateBucket}`);
      const stateBucketResult = await s3Provider.createBucket(stateBucket);
      s3Spinner.stop(
        stateBucketResult.created
          ? `Pulumi state bucket created: ${stateBucket}`
          : `Pulumi state bucket exists: ${stateBucket}`,
      );

      // SECURITY/SAFETY: migrate legacy Pulumi state out of the app storage
      // bucket. If the state bucket has no `.pulumi/` objects but the OLD app
      // bucket does, this is an env deployed before the dedicated state bucket
      // existed — copy the state prefix over so we resolve to real state, not
      // empty state. Re-initializing an EMPTY state backend against live infra
      // would make Pulumi believe nothing exists and either duplicate or orphan
      // the running servers. So if the copy fails, we DO NOT proceed silently:
      // abort loudly and tell the operator to migrate manually or
      // destroy+redeploy. Fresh deploys hit neither branch (both buckets empty).
      // Scoped to THIS project's stack keys, not bare `.pulumi/`: in a shared
      // or pinned state bucket, ANY other project's state used to satisfy the
      // seeded check, silently skipping the legacy migration/abort guard for a
      // pre-split env — the empty-checkpoint-over-live-infra outcome that
      // guard exists to prevent (review finding, 2026-08-15). State keys are
      // `.pulumi/stacks/<pulumi project>/<stack>.json` and the Pulumi project
      // is this vibecarbon project's name.
      const PULUMI_STATE_PREFIX = `.pulumi/stacks/${projectConfig.projectName}/`;
      // Legacy state in the OLD app bucket predates project scoping and lives
      // under the historical constant project name.
      const LEGACY_STATE_PREFIX = '.pulumi/';
      // Determine whether there is GENUINE legacy state to migrate. The check
      // lists the just-created state bucket, which can race S3 list-after-create
      // consistency and throw — that is NOT the orphan-risk case (a fresh deploy
      // has no legacy state), so a check failure must NOT hard-abort. Only a
      // CONFIRMED legacy-state copy failure aborts (below). Retry the checks a
      // few times so a transient blip doesn't misfire either way.
      let legacyState = false;
      let checkOk = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const stateSeeded = await s3Provider.hasObjectsWithPrefix(
            stateBucket,
            PULUMI_STATE_PREFIX,
          );
          legacyState = stateSeeded
            ? false
            : await s3Provider.hasObjectsWithPrefix(s3Config.bucket, LEGACY_STATE_PREFIX);
          checkOk = true;
          break;
        } catch (checkError) {
          if (attempt === 3) {
            // Couldn't determine migration need after retries (e.g. list-after-
            // create consistency on the fresh state bucket). A fresh deploy — the
            // overwhelming common case — has nothing to migrate, so proceed with
            // a loud warning rather than blocking every deploy on a transient S3
            // blip. (Pulumi then uses the dedicated state bucket normally.)
            p.log.warn(
              `Could not verify legacy Pulumi state after ${attempt} attempts, proceeding ` +
                `(a fresh deploy has none to migrate): ${checkError.message}`,
            );
          } else {
            await new Promise((r) => setTimeout(r, 1500 * attempt));
          }
        }
      }
      if (checkOk && legacyState) {
        // CONFIRMED legacy state in the app bucket — migrate it. If THIS copy
        // fails we DO NOT proceed silently: re-initializing an EMPTY state
        // backend against live infra would orphan the running servers.
        try {
          s3Spinner.start(`Migrating Pulumi state ${s3Config.bucket} → ${stateBucket}`);
          const { copied } = await s3Provider.copyPrefix(
            s3Config.bucket,
            stateBucket,
            PULUMI_STATE_PREFIX,
          );
          s3Spinner.stop(`Migrated ${copied} Pulumi state object(s) to ${stateBucket}`);
        } catch (copyError) {
          s3Spinner.stop(`Pulumi state migration FAILED: ${copyError.message}`);
          p.log.error(
            [
              'Could not migrate existing Pulumi state from the app storage bucket to the',
              `dedicated state bucket (${stateBucket}). Proceeding would re-initialize an`,
              'EMPTY state backend against your live infrastructure, which would orphan the',
              'running servers (Pulumi would no longer track them).',
              '',
              'Aborting to protect your infrastructure. To recover, either:',
              `  • Copy the ".pulumi/" prefix from ${s3Config.bucket} to ${stateBucket} manually`,
              '    (e.g. via `aws s3 sync ... --endpoint-url <endpoint>`), then re-run deploy; or',
              '  • Destroy this environment and redeploy from scratch.',
            ].join('\n'),
          );
          process.exit(1);
        }
      }

      const result = {
        // Deliberately the PRE-state-bucket capture, not the provider's current
        // values — see the comment above appBucketRegion.
        region: appBucketRegion,
        endpoint: appBucketEndpoint,
        stateBucket,
        // Where the STATE bucket actually lives — the provider's post-create
        // region, which createBucket's exists-elsewhere recovery may have
        // flipped. The Pulumi backend URL must follow the state bucket even
        // when it differs from the app buckets' region; that redirect was the
        // one legitimate job the old flip-through-persist was doing.
        stateBucketRegion: s3Provider.region,
      };
      if (s3Provider.region !== appBucketRegion) {
        p.log.warn(
          `Pulumi state bucket ${stateBucket} lives in ${s3Provider.region}; app/backup ` +
            `buckets stay in ${appBucketRegion}. State ops will target ${s3Provider.region}.`,
        );
      }
      state.completeStep('s3-setup', result);
    } catch (error) {
      const errMsg =
        error.message ||
        error.Code ||
        error.name ||
        `HTTP ${error.$metadata?.httpStatusCode || 'unknown'}`;
      s3Spinner.stop(`S3 setup failed: ${errMsg}`);
      process.exit(1);
    }
  }

  // Apply resolved S3 values from state
  const s3Result = state.getStepResult('s3-setup');
  if (s3Result) {
    s3Config.region = s3Result.region;
    s3Config.endpoint = s3Result.endpoint;
    // May differ from region when a retained state bucket lives elsewhere;
    // resolveBackendUrl prefers it for the Pulumi backend URL only.
    s3Config.stateBucketRegion = s3Result.stateBucketRegion ?? s3Result.region;
    backupS3Config.region = s3Config.region;
    backupS3Config.endpoint = s3Config.endpoint;
  }
  // Always resolve stateBucket (deterministic derivation) so the Pulumi
  // backend targets the dedicated bucket, whether s3-setup ran or was skipped.
  // Every downstream iac call reads it via s3Config, and it's persisted into
  // .vibecarbon.json so scale / failover / destroy resolve the same backend.
  s3Config.stateBucket = s3Result?.stateBucket || stateBucket;

  // SKELETON SAVE: persist the minimum env entry that `vibecarbon destroy`
  // needs to recover, BEFORE any `pulumi up` runs. Without this, a crash
  // during k3s install / cloud-init / health probe leaves Pulumi state in
  // S3 + real Hetzner infra alive while .vibecarbon.json has no entry —
  // destroy reads the empty config, finds nothing, exits cleanly, and the
  // PG/network/firewall/FIP outlive the test until the sweep catches them
  // (or, worse, blocks the next deploy with a quota error). Observed in
  // matrix #3 (3 PGs + 3 networks + 1 firewall leaked from k8s/k8s-ha
  // health-probe failures). Fields: deployMode + region + s3 give k8s
  // destroy the Pulumi backend; secondaryRegion + ha.enabled give k8s-ha
  // destroy the `-primary` / `-standby` stack enumeration; the compose
  // destroy path already falls back to the deterministic Pulumi name
  // `${projectName}-${envName}` when servers[] is empty (see
  // src/destroy.js:1067-1093), so the skeleton is sufficient there too.
  // Subsequent saves (mid-flight from compose/ha.js + k8s/ha, plus the
  // final save at the end of executeDeployment) merge with on-disk state,
  // so the skeleton is non-destructive — they layer on top of it.
  saveSkeletonEnv();

  const tracker = createTracker('deploy', {
    environment: config.environment,
    provider: config.provider,
    region,
  });

  // --- STEP 2: Image Resolve ---
  // resolveBuildMode (ci-setup.js) returns one of — see also transferImage
  // in effects/index.js, which must stay in sync with these descriptions:
  //   'local'  — build the app image on the operator's machine, then sideload
  //              it to the server (docker save | gzip | ssh | docker load) —
  //              the FULL image crosses the wire each deploy. The compose
  //              default when local docker is present (the build runs in
  //              parallel behind VPS provisioning); also the k8s/k3s path
  //              (deployK3s builds + sideloads + applies manifests inline).
  //   'direct' — build ON the server via DOCKER_HOST=ssh:// (buildRemote);
  //              only the build context (source) transfers, no image. Compose
  //              fallback when local docker is ABSENT, or forced with -direct.
  //   'push'   — image is pushed to GHCR (built in CI/GHA) and the server
  //              pulls it at compose-up; no operator-side image transfer.
  //              Auto-selected when CI/CD is configured, or forced with -push.
  const { ensureCIImageReady, buildImageRef, resolveBuildMode, waitForGhcrManifest } = await import(
    '../ci-setup.js'
  );
  const imageResolveTimer = perfTimer('deploy.image.resolve');
  const buildMode = resolveBuildMode(args, process.cwd(), deployMode);
  const isDirectDeploy = buildMode === 'direct';
  const isComposeLocal = buildMode === 'local' && isComposeTier(tier);
  let imageReadyPromise;
  // For compose-local: kicked off here in parallel with iac.upStack below.
  // The build is awaited later (just before sideload). Other modes leave
  // this null and use the existing remote-build / push paths.
  let composeLocalBuildPromise = null;

  const localImageTag = `${projectConfig.projectName}-app:local`;

  if (isComposeLocal) {
    // Build the app image locally NOW, in parallel with iac.upStack which
    // starts ~immediately below. The tag is fixed (no serverIp dependency)
    // and matches what bundle.js stamps into APP_IMAGE in the rendered
    // .env, so docker-compose.prod.yml's `image: ${APP_IMAGE}` resolves to
    // the sideloaded image. iac.upStack typically runs ~109s; a warm
    // operator-side build runs ~15-30s, so the build finishes well inside
    // the upStack window — net saving is the full build duration off the
    // critical path. State-tracker stepId 'compose-localbuild' is distinct
    // from 'compose-upstack' so concurrent state writes don't collide
    // (state.js uses last-writer-wins per stepId).
    // silent: true so BuildKit progress doesn't interleave with the
    // spinner output from upStack (which is running concurrently). On
    // failure runCommandAsync includes captured stdout/stderr in the
    // thrown error — operator still sees what went wrong.
    // Plumb VITE_* build args through to docker build so the browser bundle
    // ships with real values for VITE_SUPABASE_URL etc. Without these the
    // Dockerfile's ARG VITE_* defaults to empty strings and Vite inlines
    // empty values, causing the client-side supabase init to throw at
    // page load. Mirrors what docker-compose.yml's build.args block does
    // for local-dev `docker compose up --build`. See
    // src/lib/deploy/compose/build-args.js for the rationale.
    const { collectComposeBuildArgs, buildArgFlags } = await import('./compose/build-args.js');
    const localBuildArgs = collectComposeBuildArgs(process.cwd(), {
      projectName: projectConfig.projectName,
      domain,
    });
    // PLATFORM_BUILD_FLAG: this build runs on the OPERATOR's machine, so
    // without it the image inherits the operator's architecture (an Apple
    // Silicon operator shipped arm64 to an amd64 VPS). vibecarbon is x86-64
    // only — see platform.js. The pin can turn a previously-"succeeding"
    // (wrong-arch) build into a hard failure on a host with no amd64
    // emulation, which is the intended trade; the catch below makes that
    // failure legible instead of a bare BuildKit "exec format error".
    composeLocalBuildPromise = perfAsync('deploy.image.localBuild', async () => {
      try {
        return await runCommandAsync(
          [
            'docker',
            'build',
            PLATFORM_BUILD_FLAG,
            ...buildArgFlags(localBuildArgs),
            '-t',
            localImageTag,
            process.cwd(),
          ],
          { silent: true },
        );
      } catch (err) {
        const detail = `${err.stderr || ''}${err.stdout || ''}`.trim();
        const wrapped = new Error(
          `docker build failed for ${localImageTag}. ${AMD64_BUILD_HINT}` +
            (detail ? `\n${detail.split('\n').slice(-40).join('\n')}` : ''),
        );
        wrapped.cause = err;
        throw wrapped;
      }
    });
    imageReadyPromise = Promise.resolve({
      imageTag: localImageTag,
      githubOwner: 'noop',
      repoName: projectConfig.projectName,
      ghcrPullCreds: null,
      isLocal: true,
    });
  } else if (buildMode === 'local') {
    // K8s 'local' build mode: deployK3s handles the build + sideload +
    // manifest apply inline. No CI image to wait for; stub the
    // image-ready contract so downstream code sees a deterministic shape.
    imageReadyPromise = Promise.resolve({
      imageTag: localImageTag,
      githubOwner: 'noop',
      repoName: projectConfig.projectName,
      ghcrPullCreds: null,
      isLocal: true,
    });
  } else if (buildMode === 'direct') {
    imageReadyPromise = Promise.resolve({ imageTag: localImageTag, isLocal: true });
  } else {
    // CI path: ensureCIImageReady performs the workflow dispatch + GHA-build
    // wait. On a cold push deploy this is the dominant cost (~10 min).
    // Pass the VITE_* build args so ensureCIImageReady can seed them as repo
    // variables — the CI image bakes them at build time (Vite inlines them).
    // Without this the GHCR image ships empty VITE_SUPABASE_* and the SPA
    // crashes at page load. Mirrors the compose-local build-args path above.
    const { collectComposeBuildArgs } = await import('./compose/build-args.js');
    const ciBuildArgs = collectComposeBuildArgs(process.cwd(), {
      projectName: projectConfig.projectName,
      domain,
    });
    imageReadyPromise = perfAsync('deploy.image.ciWait', () =>
      ensureCIImageReady({ yes: args.yes, tracker, buildArgs: ciBuildArgs }),
    );
  }

  const ciReady = await imageReadyPromise;
  if (!ciReady.isLocal) {
    p.log.info(
      `Deploying image: ${c.bold(buildImageRef(ciReady.githubOwner, ciReady.repoName, ciReady.imageTag))}`,
    );
    // Bridge the race between the GitHub packages API (ghcrTagExists) and
    // the OCI manifests endpoint that kubelet/docker actually pull from.
    // HEAD-probe the manifest URL with short polling instead of a blanket
    // 30s sleep — typical hit is <5s, worst observed ~15s.
    const s = spinner();
    s.start('Waiting for GHCR manifest to propagate...');
    const manifestReady = await perfAsync('deploy.image.manifestPropagate', () =>
      waitForGhcrManifest(ciReady.githubOwner, ciReady.repoName, ciReady.imageTag),
    );
    s.stop(manifestReady ? 'Manifest propagated' : 'Manifest probe timed out (proceeding anyway)');
  }
  imageResolveTimer.end();
  const imageRef = ciReady.isLocal
    ? ciReady.imageTag
    : buildImageRef(ciReady.githubOwner, ciReady.repoName, ciReady.imageTag);

  // --- STEP 3: Local Bundle Rendering (Unified) ---
  // renderBundle is sync (cp + writeFile fan-out); perfTimer captures total
  // wall-clock time for the staging-dir build. Typical ~50-300ms.
  const bundleRenderTimer = perfTimer('deploy.bundle.pack');
  // verbose=false: per-file `[bundle] Copying X` lines bypass the clack
  // gutter and print flush-left, breaking the visual flow. Bundle content
  // is reproducible from the project tree; debug it by re-running with
  // VIBECARBON_PERF=1 + VIBECARBON_BUNDLE_VERBOSE=1 if needed.
  // Managed-DNS compose deploys (cloudflare/hetzner) solve ACME via DNS-01 —
  // Traefik writes a TXT record through the provider API, so there is no
  // HTTP-01 race against A-record propagation and no need for the
  // DNS-propagation poll or the Traefik cert self-heal below. `manual` keeps
  // HTTP-01. Scoped to compose: k8s issues certs via cert-manager and ignores
  // this Traefik override entirely.
  const dnsChallenge = isComposeTier(tier) && useDnsChallenge(dnsProvider);
  const bundlePath = renderBundle(projectConfig.projectName, {
    domain,
    image: imageRef,
    observability: services.observability,
    n8n: services.n8n,
    metabase: services.metabase,
    redis: services.redis,
    s3: s3Config,
    backupS3: backupS3Config,
    dnsChallenge,
    dnsProvider,
    dnsToken,
    verbose: process.env.VIBECARBON_BUNDLE_VERBOSE === '1',
  });
  bundleRenderTimer.end();

  // --- STEP 4: DNS Warm-up (parallel with VM provisioning) ---
  // Kick off the placeholder-DNS write in the background so TTL starts
  // draining while we spin up the VM. The real-IP update below awaits the
  // warm-up handle to avoid racing two writes on the same record.
  const dnsInputs = { domain, dnsProvider, dnsZoneId };
  const dnsWarmupPromise =
    domain && hasAutomatedDns(dnsProvider) && !state.shouldSkip('dns-setup', dnsInputs)
      ? (async () => {
          state.startStep('dns-setup', dnsInputs);
          try {
            const { setupSimple: updateDnsIp } = await getDnsProvider(dnsProvider);
            if (!dnsZoneId) {
              p.log.info('DNS warm-up skipped (Zone ID not found)');
              return null;
            }
            // onProgress suppresses setupSimple's internal spinner: this warm-up
            // runs in the BACKGROUND, concurrently with the foreground
            // "Provisioning VPS" spinner (STEP 5). Two animating clack spinners
            // fight over the one TTY line and garble it. The warm-up's own
            // completion is logged below; no competing animation.
            const result = await updateDnsIp(dnsToken, dnsZoneId, domain, '0.0.0.0', {
              onProgress: () => {},
            });
            state.completeStep('dns-setup', result);
            p.log.info('DNS records warmed up');
            return result;
          } catch (error) {
            p.log.warn(`Initial DNS setup failed: ${error.message}`);
            return null;
          }
        })()
      : Promise.resolve(null);

  // --- STEP 5: Architecture Dispatch ---
  // One entry per tier, keyed by the registry. deploymentConfig is a cheap,
  // pure object literal built unconditionally above the table; its k8s-only
  // fields are simply unused on the compose paths.
  //
  // Role↔stack mapping (Task 6): `envConfig` here is the environment's
  // persisted project config AS IT STOOD before this deploy invocation
  // (gatheredConfig read it off disk during config-gathering, upstream of
  // executeDeployment) — exactly the mapping a post-failover redeploy needs
  // to follow. Task 7 is what makes `ha.primary.stack` / `ha.standby.stack`
  // actually present (a pre-Task-7 or first-ever deploy has no `.stack`, so
  // this is null and haK8sProvisionClusters falls back to the
  // `${environment}-primary` / `${environment}-standby` stack-birth
  // defaults). This intentionally reads `envConfig`, NOT the `persistedConfig`
  // /`persistedEnvConfig` re-read further down (~line 1290) — that re-read
  // exists to pick up THIS deploy's own mid-flight saves and must not be
  // pulled forward, or a fresh deploy could see its own in-progress writes.
  const haStacks =
    envConfig?.ha?.primary?.stack && envConfig?.ha?.standby?.stack
      ? {
          primary: { stack: envConfig.ha.primary.stack, region: envConfig.ha.primary?.region },
          standby: { stack: envConfig.ha.standby.stack, region: envConfig.ha.standby?.region },
        }
      : null;
  const deploymentConfig = {
    projectName: projectConfig.projectName,
    environment: config.environment,
    provider: config.provider,
    region,
    secondaryRegion,
    masterServerType,
    supabaseServerType,
    workerServerType,
    serverType,
    minWorkers,
    maxWorkers,
    domain,
    ha: config.ha,
    haStacks,
    observability: config.observability,
    services,
    apiToken,
    dnsZoneId,
    dnsToken,
    dnsProvider,
    s3Config,
    backupConfig,
    backupBucketName: backupS3Config?.bucket || null,
    // DR: when set (`deploy -restore latest|<ts>`), the db pod's init
    // container seeds PGDATA from S3 via wal-g and applyMigrations is
    // skipped (the restored DB is authoritative).
    restore: args.restore || null,
    // Finding #1: hard-gate k8s-HA replication unless the operator opts into a
    // warm/degraded standby via `deploy -allow-degraded`.
    allowDegraded: !!args.allowDegraded,
    operatorCidrs: projectConfig.operatorCidrs ?? [],
    imageReadyPromise,
    tracker,
    state,
  };

  const deployCtx = {
    projectConfig,
    environment,
    envConfig,
    region,
    serverType,
    services,
    domain,
    dnsProvider,
    apiToken,
    dnsZoneId,
    dnsToken,
    backupConfig,
    imageRef,
    bundlePath,
    ciReady,
    s3Config,
    state,
    dnsChallenge,
    dnsWarmupPromise,
    isDirectDeploy,
    isComposeLocal,
    localImageTag,
    composeLocalBuildPromise,
  };

  // All four tiers are now plan-driven: planDeploy(tier) → runPlan → EFFECTS.
  // The former TIER_DEPLOYERS dispatch table (k8s / k8s-ha calling deployK3s /
  // deployK8sHA directly) is gone — each branch below assembles the tier's ctx
  // and runs its pure plan against the shared effect registry. The per-tier
  // ctx assembly + deployResult extraction genuinely differ (compose ctx keys
  // vs k8s's `{ options: deploymentConfig }` vs the HA result shapes below), so
  // this dispatch is kept intentionally (Task 9 dead-code sweep inspected it
  // and left it as legitimate config-shaping, not dead dispatch).
  const { planDeploy } = await import('./plan/deploy-plan.js');
  const { runPlan } = await import('./plan/runner.js');
  const { EFFECTS } = await import('./effects/index.js');

  let deployResult;
  if (tier === 'compose') {
    // Compose (single, non-HA) runs through the pure step-plan + effect
    // registry (planDeploy → runPlan → EFFECTS), which REPLACES the former
    // inlined deployComposeSingle block. The plan's steps carry the exact
    // operations, order, args, state-gating and conditionals the inline path
    // ran; ctx threads the mutable server identity the effects fill in
    // (serverIp / providerServerId / providerServerName) and the orchestrator
    // reads back into the single-server deployResult shape below.
    const sshKeyPath = join(process.cwd(), '.vibecarbon', `deploy_key_${environment}`);
    const composeCtx = {
      ...deployCtx,
      sshKeyPath,
      // Seed the mutable server identity from any prior deploy so the warm
      // path (`when: !ctx.serverIp`) skips provisioning. provisionServer sets
      // these on a fresh deploy.
      serverIp: envConfig.servers?.[0]?.ip || null,
      providerServerId: envConfig.servers?.[0]?.id || null,
      providerServerName: envConfig.servers?.[0]?.providerServerName || null,
      providerFirewallId: envConfig.servers?.[0]?.firewallId || null,
      // Docker Hub creds gate + drive the dockerhub-login step. Loaded here so
      // the step's when-predicate stays pure (mirrors the compose-ha path,
      // which also loads dockerHub creds in the orchestrator).
      dockerHubCreds: resolveDockerHubCreds(),
    };
    await runPlan(planDeploy('compose', config), composeCtx, EFFECTS);
    deployResult = {
      masterIp: composeCtx.serverIp,
      serverId: composeCtx.providerServerId || 'manual',
      serverName: composeCtx.providerServerName,
      firewallId: composeCtx.providerFirewallId,
    };
  } else if (tier === 'compose-ha') {
    // Compose-HA runs through the same pure step-plan + effect registry as
    // single compose (planDeploy → runPlan → EFFECTS), REPLACING the former
    // deployComposeHA orchestration. The plan's steps carry the exact
    // operations, order, args, fan-out, perf labels and warn/throw semantics
    // deployComposeHA ran over the primary+standby pair; ctx threads the
    // mutable two-node identity the effects fill in (primary/standby/degraded)
    // and the orchestrator reads back into the HA deployResult shape below.
    const { isLocalOnlyImageTag } = await import('./compose/index.js');
    const sshKeyPath = join(process.cwd(), '.vibecarbon', `deploy_key_${environment}`);
    const s = tracker.spinner();
    s.start('Starting HA deployment...');
    const composeHaCtx = {
      ...deployCtx,
      sshKeyPath,
      // Preserve the exact default the removed deployComposeHA call applied at
      // its call site (`serverType || <literal>`) — deployCtx.serverType is the
      // raw gatheredConfig value, which may be undefined. RCA (2026-07-22):
      // this assignment runs BEFORE the compose-ha effect, so effects/compose-ha.js's
      // own `ctx.serverType || Provider.DEFAULT_COMPOSE_HA_TYPE` fallback was
      // dead code — ctx.serverType was always already set by the time the
      // effect read it. Routed through Provider so the literal lives in ONE
      // place — deliberately not restated here, because the last copy of it
      // said 'cx23' long after that SKU stopped being placeable in the EU.
      serverType: serverType || providerFor(envConfig).DEFAULT_COMPOSE_TYPE,
      secondaryRegion: secondaryRegion || undefined,
      backupS3Config,
      // Docker Hub + GHCR creds gate the HA login fan-out; loaded here so the
      // effects stay pure of credential I/O (mirrors the single-compose ctx).
      dockerHubCreds: resolveDockerHubCreds(),
      ghcrPullCreds: ciReady.ghcrPullCreds,
      // Finding #1: hard-gate replication unless the operator opts into a
      // warm/degraded standby via `deploy -allow-degraded`.
      allowDegraded: !!args.allowDegraded,
      // Pure gate for the remote-build step (local-only image ⇒ build on-node).
      isLocalOnlyImage: isLocalOnlyImageTag(imageRef),
      onProgress: (msg) => s.message(msg),
    };
    // Wrap the entire pipeline so the perf trace shows the headline cost
    // (which contains the deploy.ha.compose.* sub-stages from the effects).
    await perfAsync('deploy.ha.compose.full', () =>
      runPlan(planDeploy('compose-ha', config), composeHaCtx, EFFECTS),
    );
    s.stop('Compose HA deployment complete');
    deployResult = {
      success: true,
      primaryIp: composeHaCtx.primary.ip,
      standbyIp: composeHaCtx.standby.ip,
      domain,
      deployMode: 'compose-ha',
      degraded: composeHaCtx.degraded,
      replication: composeHaCtx.degraded ? 'degraded' : 'streaming',
    };
  } else if (tier === 'k8s') {
    // Single-cluster k3s runs through the plan as a single black-box step that
    // wraps deployK3s (preserving its `deploy.k3s.full` perf span). ctx carries
    // the deploymentConfig deployK3s consumes UNCHANGED under ctx.options; the
    // effect fills ctx.clusterResult, which is deployK3s's return read back into
    // the single-cluster deployResult the post-dispatch k8s block expects.
    const k8sCtx = { options: deploymentConfig };
    await runPlan(planDeploy('k8s', config), k8sCtx, EFFECTS);
    deployResult = k8sCtx.clusterResult;
  } else {
    // k8s-ha: two clusters (primary + standby) deployed in parallel + the
    // WireGuard replication transport, run through the plan (planDeploy →
    // runPlan → EFFECTS), REPLACING the former deployK8sHA orchestration. ctx
    // carries the deploymentConfig UNCHANGED under ctx.options; the effects fill
    // ctx.primaryResult / standbyResult / replicationStatus, read back into the
    // HA deployResult the post-dispatch block + config-persist expect. The
    // headline `deploy.ha.k8s.full` perf span (which contains the effects'
    // deploy.ha.k8s.* sub-stages) wraps the whole pipeline, as before.
    const k8sHaCtx = { options: deploymentConfig };
    await perfAsync('deploy.ha.k8s.full', () =>
      runPlan(planDeploy('k8s-ha', config), k8sHaCtx, EFFECTS),
    );
    deployResult = {
      primary: k8sHaCtx.primaryResult,
      standby: k8sHaCtx.standbyResult,
      domain,
      replicationStatus: k8sHaCtx.replicationStatus,
      degraded: k8sHaCtx.replicationStatus !== 'streaming',
    };
  }

  if (isK8sTier(tier)) {
    {
      const kubeconfigPath = join(process.cwd(), '.vibecarbon', `kubeconfig-${environment}`);
      const masterIp = deployResult.primary?.masterIp || deployResult.masterIp;
      p.log.success('Local-first deploy complete. App is sideloaded + running on the cluster.');
      p.note(
        [
          `Kubeconfig:  ${kubeconfigPath}`,
          `Master IP:   ${masterIp ?? '(unknown: check Pulumi output)'}`,
          '',
          'Next steps:',
          `  vibecarbon shell ${environment}    # bash with KUBECONFIG set`,
          `  vibecarbon diagnose ${environment} # full cluster state dump`,
          `  vibecarbon destroy ${environment}  # tear down when done`,
          '',
          `To layer in Flux + GitHub Actions: vibecarbon configure cicd ${environment}`,
        ].join('\n'),
        'Cluster + app ready',
      );
      // Fall through to Step 6 so .vibecarbon.json persists the serverlist —
      // without it, `vibecarbon destroy` can't find the master/supabase IPs
      // and the cluster leaks.
    }

    // --- Post-deploy DNS update ---
    // The dnsWarmupPromise (started in Step 4) created records pointing at
    // 0.0.0.0 so Cloudflare's edge has the zone record cached before traffic
    // hits. Now we know the cluster's actual floating IP and need to update
    // the records to point at it — without this, the verify-app-health probe
    // below resolves to 0.0.0.0 and times out.
    //
    // Compose does the equivalent in its own branch above (line ~436).
    // Local-first k3s manages DNS records inline here rather than via
    // Flux annotations + external-dns.
    {
      const k8sFloatingIp =
        deployResult.primary?.floatingIp ||
        deployResult.floatingIp ||
        deployResult.primary?.masterIp ||
        deployResult.masterIp;
      if (domain && hasAutomatedDns(dnsProvider) && k8sFloatingIp) {
        await perfAsync('deploy.dns.warm', async () => {
          await dnsWarmupPromise;
        });
        const dnsUpdateInputs = { domain, dnsProvider, serverIp: k8sFloatingIp };
        if (!state.shouldSkip('k8s-dns-update', dnsUpdateInputs)) {
          state.startStep('k8s-dns-update', dnsUpdateInputs);
          const { setupSimple: updateDnsIp } = await getDnsProvider(dnsProvider);
          await perfAsync('deploy.dns.create', () =>
            updateDnsIp(dnsToken, dnsZoneId, domain, k8sFloatingIp),
          );
          state.completeStep('k8s-dns-update', { serverIp: k8sFloatingIp });
        }
      }
    }

    // --- Verifiable success gate for k8s ---
    // The GHA deploy workflow already waits for Flux reconciliation; this
    // extra probe confirms the app is reachable from the public internet
    // (not just healthy inside the cluster). DNS propagation, cert issuance,
    // and ingress routing all need to land before a user can actually load
    // the URL — any of those failing mid-deploy would leave us exiting 0
    // while the URL returns 5xx.
    //
    // K8s first-deploy timing on a cold cluster:
    //   - DNS warmup record (0.0.0.0) → real IP swap propagates through
    //     Cloudflare's edge in 1-3 min (TTL=auto = 5 min worst case).
    //   - cert-manager HTTP-01 challenge: needs DNS to resolve to origin,
    //     then LE issues. Typical 1-3 min once DNS is correct, but
    //     orange-cloud + CF redirect quirks can push it to 8-12 min.
    //   - Traefik picks up the new cert: ~30s.
    // Old 10-min budget tripped on the cold tail (observed 2026-04-25 batch
    // run #1 — k8s standalone, k8s-ha both failed at the probe). 20 min
    // covers the p99 cold path; warm rollouts still finish in <60s.
    if (domain) {
      const s = spinner();
      s.start(`Probing https://${domain}/api/health ...`);
      // ACME issuance watchdog. Until this existed, a terminally-failed
      // cert-manager Order (2026-08-11 e3 restore: 403 orderNotReady
      // "Order was already processing" after both DNS-01 challenges had
      // validated) made the probe below unwinnable: cert-manager's own
      // reissue backoff starts at an hour, so the cert could not land
      // inside any budget we hold, and the probe spent 20 minutes
      // reporting "self-signed certificate" — the Traefik default cert —
      // with the actual ACME error visible only in a post-mortem dump.
      // The watchdog repairs the failure in-place (bounded), and if it
      // can't, aborts the probe with the ACME problem as the reason.
      // See src/lib/deploy/k8s/acme-order-recovery.js.
      const { path: probeKubeconfig } = resolveKubeconfigPath(environment);
      const acmeWatchdog = existsSync(probeKubeconfig)
        ? createAcmeIssuanceWatchdog({
            runKubectl: async (argv) =>
              (
                await runCommandAsync(['kubectl', '--kubeconfig', probeKubeconfig, ...argv], {
                  silent: true,
                  timeout: 30_000,
                })
              ).trim(),
            log: (msg) => progressLog(msg),
          })
        : null;
      // Public health probe — DNS propagation + cert issuance + ingress
      // routing all roll up here. p99 cold k8s-ha = 8-12 min; warm <60s.
      const probeResult = await perfAsync('deploy.health.probe', () =>
        probePublicHealth(domain, { timeoutMs: 1_200_000, onPoll: acmeWatchdog }),
      );
      if (probeResult?.ok) {
        s.stop(`App is serving requests (HTTP ${probeResult.status})`);
      } else {
        // Build a concise one-line failure summary as the spinner stop text
        // AND as the first line of the diagnostic dump below. The runner
        // captures the stderr tail as the step's error message; if this
        // line is the most recent error-level emission, the runner's
        // failure attribution will say WHAT went wrong (last status, last
        // network error class) instead of just dumping curl HEAD response
        // headers — which was the 2026-04-27 morning matrix's "[unknown]
        // CSP header dump" failure mode.
        const r = probeResult ?? {};
        // A watchdog abort wins over the network-level summary: "order
        // errored: 403 orderNotReady ..." is the cause, while "self-signed
        // certificate (118 attempts)" is only the symptom of it.
        const reason = r.abortReason
          ? `${r.abortReason}, probe stopped after ${r.attempts} attempts`
          : r.lastStatus
            ? `last HTTP status ${r.lastStatus} after ${r.attempts} attempts over ${Math.round((r.timeoutMs ?? 0) / 1000)}s`
            : r.lastErrorClass
              ? `${r.lastErrorClass}: ${r.lastErrorMessage}${r.lastErrorCause ? ` (cause: ${r.lastErrorCause})` : ''} (${r.attempts} attempts)`
              : 'never connected';
        s.stop(`Public health probe failed against https://${domain}/api/health; ${reason}`);
        // Capture diagnostics inline so a CI run failure surfaces the
        // root cause without requiring a follow-up `vibecarbon diagnose`.
        // The cluster is about to be destroyed by the test runner; once
        // it's gone, kubectl probes return nothing. We spawn each tool via
        // runCommandAsync (array argv, no shell) — domain and environment come
        // from validated config, but we still avoid shell-string interp.
        try {
          const { path: kubeconfig, candidates: kubeconfigCandidates } =
            resolveKubeconfigPath(environment);
          // Run each tool via runCommandAsync. Capture stderr alongside stdout
          // (kubectl prints errors to stderr; without merging we get the
          // useless first line of err.message — observed 2026-04-26 run #5
          // where every kubectl probe surfaced as "(kubectl failed: Command
          // failed: kubectl ...)" with no actual diagnostic).
          const safeRun = async (cmd, argv) => {
            try {
              const output = await runCommandAsync([cmd, ...argv], {
                silent: true,
                timeout: 30_000,
              });
              return output.trim();
            } catch (err) {
              const stdout = err?.stdout?.toString?.()?.trim() ?? '';
              const stderr = err?.stderr?.toString?.()?.trim() ?? '';
              const tail = [stdout, stderr].filter(Boolean).join('\n').slice(0, 2000);
              return `(${cmd} failed exit=${err?.status ?? '?'}):\n${tail || (err instanceof Error ? err.message : String(err))}`;
            }
          };
          const dig = await safeRun('dig', ['+short', domain, '@1.1.1.1']);
          const kcExists = existsSync(kubeconfig);
          // ALL namespaces, not just `vibecarbon`: the observability add-on
          // issues its own grafana-tls Certificate in
          // vibecarbon-observability against the same ClusterIssuer, and a
          // vibecarbon-only dump cannot show whether two Certificates were
          // racing the same ACME order — exactly the ambiguity that made
          // the 2026-08-11 e3 post-mortem harder than it needed to be.
          const certs = kcExists
            ? await safeRun('kubectl', [
                '--kubeconfig',
                kubeconfig,
                'get',
                'certificate,certificaterequest,order,challenge',
                '--all-namespaces',
                '-o',
                'wide',
              ])
            : `(kubeconfig not present at ${kubeconfig} — checked ${kubeconfigCandidates.join(', ')})`;
          const events = kcExists
            ? await safeRun('kubectl', [
                '--kubeconfig',
                kubeconfig,
                'get',
                'events',
                '-n',
                'vibecarbon',
                '--sort-by=.lastTimestamp',
              ])
            : '(skipped: no kubeconfig)';
          // Trim events to the most recent 30 lines.
          const recentEvents = events.split('\n').slice(-30).join('\n');
          // Direct curl probes — surface the actual TLS/HTTP error from the
          // public side (cert-manager not yet issued, traefik not routing,
          // kong 503, etc.). curl exits non-zero on connect/TLS errors so we
          // route through safeRun. -k skips cert validation — we want the
          // body even if origin's cert is staging or self-signed.
          const curlVerbose = await safeRun('curl', [
            '-skvI',
            '--max-time',
            '10',
            `https://${domain}/api/health`,
          ]);
          const curlPodIp = await safeRun('curl', [
            '-skv',
            '--max-time',
            '10',
            '--http1.1',
            `https://${domain}/api/health`,
          ]);
          // Pods + endpoints + app logs. When traefik returns a 19-byte
          // "404 page not found" but everything in cert-manager is green,
          // the cause is almost always "service `app` has zero endpoints
          // because all app pods are NotReady". Capturing pod state +
          // endpoints + the app pod's stdout (where the readiness probe
          // failure logs live — `Readiness check failed: { error: ... }`)
          // turns "deploy probe got 404" from a riddle into a directly
          // actionable error.
          const pods = kcExists
            ? await safeRun('kubectl', [
                '--kubeconfig',
                kubeconfig,
                'get',
                'pods',
                '-n',
                'vibecarbon',
                '-o',
                'wide',
              ])
            : '(skipped: no kubeconfig)';
          const endpoints = kcExists
            ? await safeRun('kubectl', [
                '--kubeconfig',
                kubeconfig,
                'get',
                'endpoints',
                '-n',
                'vibecarbon',
              ])
            : '(skipped: no kubeconfig)';
          // App pod logs (last 100 lines). If multiple replicas, this picks
          // by deployment selector — same as `kubectl logs deploy/app`.
          const appLogs = kcExists
            ? await safeRun('kubectl', [
                '--kubeconfig',
                kubeconfig,
                'logs',
                'deployment/app',
                '-n',
                'vibecarbon',
                '--tail=100',
                '--all-containers',
              ])
            : '(skipped: no kubeconfig)';
          p.log.error(
            `Deploy completed but the app is not serving traffic.\n` +
              `\n--- DNS (dig +short ${domain}) ---\n${dig || '(empty)'}\n` +
              `\n--- cert-manager state (all namespaces) ---\n${certs}\n` +
              `\n--- Pods (vibecarbon ns) ---\n${pods}\n` +
              `\n--- Service endpoints (vibecarbon ns) ---\n${endpoints}\n` +
              `\n--- App pod logs (last 100) ---\n${appLogs}\n` +
              `\n--- Recent events (last 30) ---\n${recentEvents}\n` +
              `\n--- curl -kvI https://${domain}/api/health (HEAD) ---\n${curlVerbose}\n` +
              `\n--- curl -kv https://${domain}/api/health (GET) ---\n${curlPodIp}\n`,
          );
        } catch (diagErr) {
          p.log.error(
            `Deploy completed but the app is not serving traffic. Check:\n` +
              `  - DNS: dig +short ${domain}\n` +
              `  - Pods: kubectl --kubeconfig ~/.vibecarbon/kubeconfig-${environment} get pods -A\n` +
              `  - Certs: kubectl --kubeconfig ~/.vibecarbon/kubeconfig-${environment} get certificate -n vibecarbon\n` +
              `(Auto-diagnostic capture failed: ${diagErr instanceof Error ? diagErr.message : String(diagErr)})`,
          );
        }
        // Emit the structured probe reason as the VERY LAST line on BOTH
        // stdout and stderr so the e2e runner's failure-tail capture
        // grabs it regardless of which stream wins. An earlier version
        // wrote it to stderr only, but the runner's `detail = stdoutClean
        // || stderrClean` prefers stdout — where @clack's p.log.error
        // wrote a CSP header dump from the curl -kvI diagnostic, masking
        // the structured reason in matrix attributions. Writing to both
        // streams costs nothing and guarantees the runner sees it as the
        // last line.
        const failLine = `\nFAIL: public health probe never reached 2xx; ${reason}\n`;
        console.error(failLine);
        console.log(failLine);
        // Throw rather than process.exit(1): process.exit aborts before
        // the deploy-logger's stream flushes, so the entire diagnostic
        // dump above is silently lost from the .vibecarbon/logs/ file.
        // (RCA from k8s-ha probe failure 2026-04-30: detail log ended
        // mid-spinner with no diagnostic preserved.) withDeployLog's
        // catch path writes the error trace, awaits the file close, then
        // re-throws — so the deploy still exits non-zero, but with a
        // self-contained log.
        throw new Error(`Public health probe failed: ${reason}`);
      }
    }
  }

  // --- STEP 6: Finalize Config (Consolidated) ---
  // Persist supabaseIp alongside masterIp for k8s deploys. The failover flow
  // in src/failover.js needs the supabase node IP (where the postgres pod
  // runs) to pg_basebackup-reseed standby from primary — without it, the
  // failover uses whatever (potentially stale) state standby has. Compose
  // deploys only have a single masterIp so supabaseIp is omitted there.
  const servers = [];
  if (deployResult.primary) {
    // k8s-HA shape: { primary: { masterIp, supabaseIp }, standby: {...} }
    servers.push(
      {
        name: 'primary',
        ip: deployResult.primary.masterIp,
        supabaseIp: deployResult.primary.supabaseIp,
        region,
      },
      {
        name: 'standby',
        ip: deployResult.standby.masterIp,
        supabaseIp: deployResult.standby.supabaseIp,
        region: secondaryRegion,
      },
    );
  } else if (deployResult.primaryIp && deployResult.standbyIp) {
    // compose-HA shape: { primaryIp, standbyIp } — no supabaseIp because
    // compose-HA runs Supabase on the same VM as the app.
    servers.push(
      { name: 'primary', ip: deployResult.primaryIp, region, serverType },
      { name: 'standby', ip: deployResult.standbyIp, region: secondaryRegion, serverType },
    );
  } else if (deployResult.masterIp) {
    // Single-server fall-through: hit by compose (one VPS) and k8s
    // (master + supabase + worker[s]) deploys.
    //
    // Compose: persist the Hetzner-assigned `id` + literal name (e.g.
    // `${projectName}-${environment}`) so `vibecarbon destroy` can locate
    // the VPS via the API and `vibecarbon scale` can run its blue-green
    // migration through the Hetzner provider. The role-style
    // `name: 'master'` is kept because existing call-sites filter on it
    // (failover, etc.). Without `providerServerName`, destroy's name-fallback
    // searches Hetzner for the literal "master" — never matches — and the
    // next deploy collides on the unique server name. Without `id`, scale
    // treats the server as "deployed via --ssh, can't resize through the
    // API" and silently no-ops. scaleCompose replays the old server's full
    // `.env` into the new bundle as `envOverrides`, so the migration path
    // works end-to-end across both fields.
    //
    // K8s: in addition to the master entry, persist one entry per node
    // role (supabase + worker-N) so post-deploy commands (scale, destroy,
    // e2e verify-scale) can enumerate every IP without having to
    // re-derive worker IPs from Pulumi outputs. Master stays at index 0 —
    // a handful of compose-only paths read `envConfig.servers?.[0]`, and
    // preserving that contract is cheap. `supabaseIp` is also kept on the
    // master entry so failover.js can read `servers[0].supabaseIp` without
    // first iterating to find the supabase entry — redundant with the
    // dedicated supabase entry below, but keeps the existing failover
    // path working.
    servers.push({
      name: 'master',
      ...(deployResult.serverId &&
        deployResult.serverId !== 'manual' && { id: deployResult.serverId }),
      ...(deployResult.serverName && { providerServerName: deployResult.serverName }),
      // Compose only: `scale` re-attaches the blue-green replacement to this
      // firewall. K8s never sets it — its nodes are covered by the cluster
      // firewall (Hetzner: applied by the Pulumi program; DO: attached by tag).
      ...(deployResult.firewallId && { firewallId: deployResult.firewallId }),
      ip: deployResult.masterIp,
      supabaseIp: deployResult.supabaseIp,
      region,
      serverType,
      ...(isComposeTier(tier) ? {} : { role: 'master' }),
    });
    // K8s only — compose has neither a separate supabase node nor worker
    // pool. Compose deploys leave servers as a single-element array.
    if (isK8sTier(tier)) {
      if (deployResult.supabaseIp) {
        servers.push({
          name: 'supabase',
          ip: deployResult.supabaseIp,
          region,
          serverType,
          role: 'supabase',
        });
      }
      const workerIps = Array.isArray(deployResult.workerIps) ? deployResult.workerIps : [];
      workerIps.forEach((wIp, idx) => {
        if (!wIp) return;
        servers.push({
          name: `worker-${idx + 1}`,
          ip: wIp,
          region,
          serverType,
          role: 'worker',
        });
      });
    }
  }

  let deployedCommit = null;
  try {
    deployedCommit = runCommand(['git', 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      silent: true,
      cleanEnv: true,
    }).trim();
  } catch {}
  // Whether uncommitted edits were part of this build — read back by the next
  // deploy's Changes summary so "same commit as live" can be qualified.
  const deployedDirty = workingTreeDirty();

  // Persist backupS3 alongside the storage-s3 block. The backup + restore
  // commands both read it via loadBackupS3Config() from .vibecarbon.json
  // — without it here, `vibecarbon restore` against a destroyed-then-redeployed
  // environment falls through to server-side `ls /opt/*/backups/*` on a
  // fresh VM with no files, so DR from a populated backup bucket is broken.
  // Keep the shape in sync with loadBackupS3Config (bucket/region/endpoint,
  // no credentials — those are resolved from HETZNER_ACCESS_KEY/HETZNER_SECRET_KEY
  // at read time, never persisted to .vibecarbon.json).
  const backupS3Persist = backupS3Config
    ? {
        bucket: backupS3Config.bucket,
        region: backupS3Config.region,
        endpoint: backupS3Config.endpoint,
      }
    : null;

  // Persist HA flags + secondaryRegion so post-deploy commands can tell
  // a k8s-HA env (`deployMode='kubernetes' + ha.enabled + secondaryRegion`)
  // apart from a single-region k8s env (`deployMode='kubernetes'` only).
  // scale.js relies on this distinction to route Pulumi up against the
  // per-cluster `${env}-primary` / `${env}-standby` stacks instead of a
  // bare `${env}` stack that has no Pulumi state. Without these fields,
  // k8s-HA scale would try to create a fresh stack and Hetzner would
  // reject the duplicate SshKey post.
  const isHADeploy = !!config.ha && !!secondaryRegion;

  // Re-read the on-disk project config before merging. Inner deploy paths
  // (compose/ha.js, k8s/ha/index.js) call saveProjectConfig themselves
  // mid-flight to persist server IDs / per-cluster details that this
  // outer save cannot reconstruct from `deployResult` alone (the
  // orchestrator's `servers` array drops `id`, for example). If we spread
  // the in-memory `projectConfig` (captured at function entry), we'd
  // silently overwrite those mid-flight saves — observed in compose-HA
  // matrix runs where destroyComposeHA found servers with no `id` and
  // skipped the VPS delete entirely, leaving Hetzner state to collide
  // on restore re-deploy.
  const persistedConfig = loadProjectConfig() || projectConfig;
  const persistedEnvConfig = persistedConfig.environments?.[environment] || envConfig;
  const finalConfig = {
    ...persistedConfig,
    environments: {
      ...persistedConfig.environments,
      [environment]: {
        ...persistedEnvConfig,
        status: 'deployed',
        deployMode,
        // Persist the region each side ACTUALLY deployed to (from the fan-out's
        // per-side result), not the options-level `region`/`secondaryRegion`.
        // After a failover swap, a redeploy passing the ORIGINAL flags deploys
        // correctly (the fan-out follows haStacks), but persisting the flags
        // un-swapped would feed later converges (scale/failover/deploy) the
        // wrong Pulumi `location` for a stack — planning a full node+volume
        // replacement of the serving cluster. Top-level region must equal
        // ha.primary.region (status/scale read both). Non-HA/compose keep
        // today's value (deployResult.primary is undefined there).
        region: deployResult?.primary?.region ?? region,
        ...(isHADeploy && {
          secondaryRegion: deployResult?.standby?.region ?? secondaryRegion,
          // Finding #1: persist DR posture. A default (gated) HA deploy that
          // reaches this point is streaming; only `-allow-degraded` finalizes a
          // warm/degraded standby, which the inner deploy flags on deployResult.
          replication: deployResult?.degraded ? 'degraded' : 'streaming',
          degraded: !!deployResult?.degraded,
          // Persist per-cluster floatingIp + supabaseIp under ha.primary /
          // ha.standby so failover.identifyServers takes the structured
          // path that surfaces floatingIp. Without these, identifyServers
          // falls through to the flat `servers[]` lookup which has only
          // `ip` — failover then targets the standby's master IP for the
          // DNS A record instead of the floating IP, bypassing the
          // FIP-based design.
          ha: {
            enabled: true,
            failoverRegion: secondaryRegion,
            ...(deployResult.primary && {
              primary: {
                masterIp: deployResult.primary.masterIp,
                floatingIp: deployResult.primary.floatingIp,
                supabaseIp: deployResult.primary.supabaseIp,
                // The supabase node's PRIVATE IP — the local WireGuard-relay
                // endpoint the failover/restore re-seed dials (deterministic
                // 10.0.1.2 in the IaC program; persisted so identifyServers
                // can surface it without hardcoding).
                supabasePrivateIp: deployResult.primary.supabasePrivateIp,
                // The region + server types this side ACTUALLY deployed to,
                // from the fan-out result (fall back to the options value only
                // if absent). A failover/scale converge reads these back for the
                // stack's Pulumi `location` and current server types, so they
                // must reflect the deployed reality, not the (possibly swapped)
                // options-level flags or the shared primary types.
                region: deployResult.primary.region ?? region,
                masterServerType: deployResult.primary.masterServerType,
                supabaseServerType: deployResult.primary.supabaseServerType,
                // Task 6/7: cluster identity (Pulumi stack name). A redeploy
                // reads THIS back as `envConfig.ha.primary.stack` (see the
                // haStacks derivation above, ~line 702) so a post-failover
                // redeploy follows the role↔stack mapping instead of
                // re-birthing the `${environment}-primary` default.
                stack: deployResult.primary.stack,
              },
              standby: {
                masterIp: deployResult.standby.masterIp,
                floatingIp: deployResult.standby.floatingIp,
                supabaseIp: deployResult.standby.supabaseIp,
                supabasePrivateIp: deployResult.standby.supabasePrivateIp,
                region: deployResult.standby.region ?? secondaryRegion,
                // The standby's region-resolved types (may differ from the
                // primary's) — provisionStandbyCapacity pins them so a failover
                // converge never resizes the standby's master/db node.
                masterServerType: deployResult.standby.masterServerType,
                supabaseServerType: deployResult.standby.supabaseServerType,
                stack: deployResult.standby.stack,
              },
              // Pilot-light failover config: what `vibecarbon failover` will
              // provision (worker count/type) and bring up (app tier), derived
              // from this deploy's own inputs — never hardcoded in failover.
              standbyWorkerSpec: {
                count: minWorkers ?? 1,
                serverType: deployResult.standby.workerServerType,
              },
              scaleUpList: deriveScaleUpList({
                overlayText: readFileSync(
                  join(process.cwd(), 'k8s/values/supabase.standby.values.yaml'),
                  'utf-8',
                ),
                sharedValuesText: readFileSync(
                  join(process.cwd(), 'k8s/values/supabase.values.yaml'),
                  'utf-8',
                ),
                appManifestText: readFileSync(
                  join(process.cwd(), 'k8s/base/app/deployment.yaml'),
                  'utf-8',
                ),
              }),
            }),
          },
        }),
        domain,
        dnsProvider,
        // Persist the nested `dns: { provider, zoneId }` shape too.
        // failover.detectScenario reads `envConfig.dns?.provider` (NOT the
        // flat `dnsProvider`) — without this, failover falls through to
        // ha_manual, prints "Update DNS yourself" instead of calling the
        // provider API, and the public health probe in verify-failover never
        // points at the standby. Registry-driven: ANY automated backend with
        // a zone persists; the pre-convergence nested ternary returned null
        // for unknown providers, which silently disabled failover's flip AND
        // destroy's DNS cleanup (hazard H10 in the 2026-08-08 seam audit).
        // Mirror of the shape compose-ha persists in deploy/compose/ha.js.
        dns:
          hasAutomatedDns(dnsProvider) && dnsZoneId
            ? { provider: dnsProvider, zoneId: dnsZoneId }
            : null,
        // Prefer the inner deploy's richer `servers` (with `id`) when it
        // already wrote one. Compose-HA persists
        //   [{ name, id, ip, region, serverType, role }, ...]
        // The outer `servers` we'd build here drops `id` (deployResult
        // for compose-HA only carries primaryIp/standbyIp). Falling back
        // to the inner save preserves the IDs that destroyComposeHA needs.
        servers:
          Array.isArray(persistedEnvConfig.servers) &&
          persistedEnvConfig.servers.length > 0 &&
          persistedEnvConfig.servers.some((s) => s.id != null)
            ? persistedEnvConfig.servers
            : servers,
        // Persist k8s sizing inputs so post-deploy `vibecarbon scale` can
        // rebuild the same Pulumi inputs without falling back to defaults.
        // Without `minWorkers/maxWorkers` here, scale.js would read
        // `envConfig.minWorkers/maxWorkers` as `undefined` and fall back to
        // built-in defaults — which on a clean type-bump made Pulumi plan a
        // delete of `worker-1`, replacing master+supabase along the way
        // (etcd loss). Master/supabase/worker types are also persisted so
        // the per-role split survives across deploy → scale.
        ...(deployMode === 'kubernetes' && {
          masterServerType,
          supabaseServerType,
          workerServerType,
          // Single (non-HA) k8s's floating/reserved ingress IP (M3 Task 9f).
          // `status.js` has read `envConfig.floatingIp` for a long time, but
          // nothing ever wrote it — deployResult.floatingIp comes straight
          // back from deployK3s/Pulumi outputs (same key both hetzner-k8s.js
          // and digitalocean-k8s.js export) and was only ever used in-memory
          // for the DNS warm-up above. Without persisting it, `destroy`
          // can't attribute the k8s DNS A record to this env (it points at
          // the floating IP, not any server's own IP) and, on DO, can't
          // backstop-delete the Reserved IP by address either — both leaked
          // silently. HA persists its own per-cluster floatingIp under
          // `ha.primary/standby` above instead; this key is absent there
          // since `deployResult.floatingIp` is undefined for an HA result
          // shape.
          ...(deployResult.floatingIp && { floatingIp: deployResult.floatingIp }),
          minWorkers,
          maxWorkers,
        }),
        deployedAt: new Date().toISOString(),
        deployedCommit,
        ...(deployedDirty !== null && { deployedDirty }),
        s3: {
          bucket: s3Config.bucket,
          region: s3Config.region,
          endpoint: s3Config.endpoint,
          stateBucket: s3Config.stateBucket,
        },
        ...(backupS3Persist && { backupS3: backupS3Persist }),
        backup: backupConfig,
        services,
      },
    },
  };
  saveProjectConfig(finalConfig);
  registerProject(projectConfig.projectName, process.cwd());

  // File this environment's resources into the dedicated cloud project on
  // providers whose project model needs post-hoc assignment (DigitalOcean);
  // a no-op elsewhere. Best-effort by contract — never fails the deploy.
  const AssignProvider = providerFor(envConfig);
  await runProjectAssignment(new AssignProvider(apiToken), {
    projectName: projectConfig.projectName,
    environment,
  });

  const { formatted: timeStr } = tracker.finish();
  p.log.success(`Deployment to ${c.bold(environment)} complete! ${c.dim(`(${timeStr})`)}`);
  if (domain) p.log.info(`URL: ${c.info(`https://${domain}`)}`);

  // Terminal state reached: config persisted, DR gate cleared. Disarm the
  // silent-success guard so a clean exit-0 is accepted as a real success.
  markDeployCompleted();
}
