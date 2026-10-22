/**
 * k8s-ha deploy effect registry.
 *
 * Each effect is a thin, faithful relocation of the corresponding top-level
 * phase of the (now removed) inlined `deployK8sHA` orchestration — same
 * operations, same order, same args, same parallel fan-out, same perf labels
 * (`deploy.ha.k8s.*`), same console diagnostics, same warn/throw/gate
 * semantics. Effects read from and mutate a shared multi-cluster `ctx`.
 *
 * The heavily-hardened WireGuard replication transport + scale-to-zero reseed
 * live in `setupReplication` (../k8s/ha/index.js) and the k3s single-cluster
 * pipeline lives in `deployK3s` (../k8s/k3s.js) — BOTH are called here as
 * BLACK BOXES (unchanged). This file only expresses deployK8sHA's phase
 * sequence as steps; it touches neither the WireGuard transport (port 51821,
 * subnet 10.99.0.0/30) nor any replication logic.
 *
 * ── ctx contract (multi-cluster) ──
 *   Inputs (set by the orchestrator before runPlan):
 *     options = the deploymentConfig object deployK8sHA consumed (projectName,
 *               environment, region, secondaryRegion, master/database/worker
 *               server types, serverType, min/maxWorkers, apiToken,
 *               dnsToken, dnsZoneId, domain,
 *               s3Config, operatorCidrs, allowDegraded, restore, dnsProvider,
 *               tracker, configPassphrase, imageTag, githubOwner, repoName,
 *               services). Each HA effect reads `ctx.options.*` verbatim.
 *   Filled in by the effects:
 *     s                                        // shared @clack spinner
 *     sharedSshKeyPath, sharedSshPublicKey, sharedSshKeyId
 *     primaryResult, standbyResult             // per-cluster deployK3s returns
 *     transportPrepared                        // early fan-out prep succeeded
 *     standbyImageCopy                         // the image copy, started early once the transport is up
 *     standbyImageDigest                       // the app image digest the standby now holds
 *     standbyImageMissing                      // the copy failed under -allow-degraded
 *     primaryReplicationConfigured             // primary-side repl config applied during fan-out
 *     replicationStatus, replStreaming, replLastState, replError, lastStateHint
 *     allowDegraded
 */
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { spinner } from '../../cli/progress.js';
import { c } from '../../colors.js';
import { DNS_PROVIDERS, getDnsProvider, hasAutomatedDns } from '../../dns-provider.js';
import { summarizePulumiError } from '../../iac/index.js';
import { perfAsync } from '../../perf.js';
import { providerFor } from '../../providers/index.js';
import { createPrefixedTracker } from '../../tracker.js';
import { requireDnsSetup } from '../dns-result.js';
import { copyAppImageToStandby } from '../k8s/ha/image-copy.js';
import {
  configurePrimaryForReplication,
  prepareReplicationTransport,
  setupReplication,
} from '../k8s/ha/index.js';
import { deployK3s } from '../k8s/k3s.js';
import { assertReplicationStreamingOrDegraded } from '../replication.js';
import { StateTracker } from '../state.js';
import { generateSSHKeyPair } from '../utils.js';

/**
 * Generate the shared SSH key for both clusters (avoids Hetzner duplicate
 * fingerprint errors). Creates the shared spinner both later phases reuse and
 * prints the HA deployment banner.
 */
async function haK8sGenerateSshKey(ctx) {
  const options = ctx.options;
  // Prefer the orchestrator's tracker spinner (timing + log file); fall back to
  // the spinner-safe `spinner()` from cli/progress.js when no tracker is passed.
  const s = options.tracker ? options.tracker.spinner() : spinner();
  ctx.s = s;

  p.log.info(`${c.bold('Fullerene HA Multi-Region Deployment')}`);
  p.log.info(`Primary:   ${c.bold(options.region)}`);
  p.log.info(`Secondary: ${c.bold(options.secondaryRegion)}`);
  p.log.info('');

  // Generate shared SSH key for both clusters (avoids Hetzner duplicate fingerprint errors)
  s.start('Generating shared SSH key for HA clusters');
  const sharedSshKeyPath = join(process.cwd(), '.vibecarbon', `deploy_key_${options.environment}`);
  const sharedSshPublicKey = generateSSHKeyPair(sharedSshKeyPath);
  s.stop('Shared SSH key generated');
  ctx.sharedSshKeyPath = sharedSshKeyPath;
  ctx.sharedSshPublicKey = sharedSshPublicKey;
}

/** Upload the shared SSH key ONCE and stash its ID for both stacks. */
async function haK8sUploadSshKey(ctx) {
  const options = ctx.options;
  const s = ctx.s;
  // Upload the SSH key ONCE and get the ID. provider.createSSHKey dedups by
  // exact name and by key content across the FULL paginated key list: a
  // partial listing or a substring-name fallback could hand each cluster a
  // different account key.
  const sshKeyName = `${options.projectName}-${options.environment}-ha-key`;
  const Provider = providerFor(options);
  s.start(`Uploading SSH key to ${Provider.NAME}`);
  const provider = new Provider(options.apiToken);
  const sharedSshKeyId = await provider.createSSHKey(sshKeyName, ctx.sharedSshPublicKey);
  s.stop('SSH key uploaded');
  ctx.sharedSshKeyId = sharedSshKeyId;
}

/**
 * Deploy the primary and standby clusters in parallel (deployK3s ×2 — the k8s
 * per-cluster block reused ×2), each with its OWN StateTracker + PrefixedTracker
 * + perfPrefix so the two concurrent deploys stay isolated. The standby takes
 * its app image from the primary: the primary's built ref reaches it as a
 * promise, and the copy into its registry starts once the WireGuard transport
 * is up (here, when the early prep brought it up; else in copy-standby-image).
 * Pre-inits the Pulumi S3 backend before the parallel fan-out. Surfaces
 * per-cluster success/failure distinctly; hard-fails if either cluster failed.
 */
async function haK8sProvisionClusters(ctx) {
  const options = ctx.options;
  const { sharedSshKeyPath, sharedSshPublicKey, sharedSshKeyId } = ctx;

  // Role↔stack mapping: stacks are cluster IDENTITIES ("e4-primary" named at
  // birth); roles flip at failover. failover persists the swap under
  // envConfig.ha.{primary,standby}.stack — deploy is the role reconciler and
  // must follow it, or a post-failover redeploy would re-warm the pilot
  // cluster and zero the serving one.
  const primaryEnv = options.haStacks?.primary?.stack ?? `${options.environment}-primary`;
  const standbyEnv = options.haStacks?.standby?.stack ?? `${options.environment}-standby`;
  const primaryRegion = options.haStacks?.primary?.region ?? options.region;
  const standbyRegion = options.haStacks?.standby?.region ?? options.secondaryRegion;

  // 1 & 2. Deploy primary and standby clusters in parallel.
  // Each cluster gets a PrefixedTracker that logs with [region] prefixes instead of
  // real @clack spinners — two concurrent spinners corrupt each other's terminal output.
  p.log.step('Deploying primary and standby clusters in parallel');
  const primaryTracker = createPrefixedTracker(primaryRegion, { parent: options.tracker });
  const standbyTracker = createPrefixedTracker(standbyRegion, {
    parent: options.tracker,
  });

  // Resolved once per flow — see providerFor() in lib/providers/index.js.
  const Provider = providerFor(options);
  // Resolve equivalent server types for the standby region — an SKU stocked in
  // the primary's region isn't necessarily stocked in the standby's. Always
  // returns an x86 type (vibecarbon is amd64-only; see lib/deploy/platform.js),
  // including the ARM→x86 rescue for an environment that predates that
  // standardization.
  const resolve = (type) => Provider.resolveServerTypeForRegion(type, standbyRegion);
  const standbyMasterType = resolve(options.masterServerType || options.serverType);
  const standbyDbType = resolve(options.dbServerType || options.serverType);
  const standbyWorkerType = resolve(options.workerServerType || options.serverType);

  if (
    standbyMasterType !== options.masterServerType ||
    standbyDbType !== options.dbServerType ||
    standbyWorkerType !== options.workerServerType
  ) {
    p.log.info(
      `Standby server types adjusted for ${standbyRegion}: ` +
        `master=${standbyMasterType}, db=${standbyDbType}, worker=${standbyWorkerType}`,
    );
  }

  // Diagnostic: confirm image tag and services config reach BOTH clusters.
  // Helps attribute per-cluster failures to input config vs runtime issues.
  console.error(
    `[k8s-ha] dispatch: primary=${primaryEnv} (${primaryRegion}) standby=${standbyEnv} (${standbyRegion}) imageTag=${options.imageTag || '(unset)'} githubOwner=${options.githubOwner || '(unset)'} repoName=${options.repoName || '(unset)'} services.cicd=${Boolean(options.services?.cicd)} projectName=${options.projectName}`,
  );

  // Each cluster gets its OWN StateTracker keyed by per-cluster environment
  // name. Without this, both deployK3s calls share `options.state` (the
  // orchestrator's tracker for the user-facing env) and write to the same
  // deploy-state-<env>.json. When standby completes `k3s-apply` first
  // (typical — standby builds nothing), primary's
  // `state.shouldSkip('k3s-apply', { imageTag })` then matches the stored
  // hash and SKIPS manifest install on primary. cert-manager + the db
  // never land on primary → public probe to e<env>.<domain> (which DNS
  // resolves to primary's floating IP) returns nothing → deploy fails with
  // "Deploy completed but the app is not serving traffic" (caught in
  // k8s-ha matrix runs).
  const primaryState = new StateTracker(options.projectName, primaryEnv);
  const standbyState = new StateTracker(options.projectName, standbyEnv);

  // The Pulumi backend pre-init that used to sit here is gone. RCA from k8s-ha
  // 2026-04-28: both deployK3s threads raced a freshly-created S3 bucket and
  // `pulumi stack select` failed with `could not list bucket: blob
  // (code=NotFound): NoSuchKey`, killing the deploy in under 20s. The fix was a
  // sequential no-op stack that forced `.pulumi/meta.yaml` to be written first.
  // The per-bucket state lock (lib/iac/state-lock.js) serializes every stack
  // select and pre-up refresh in every scope (the two ups themselves overlap
  // once the state bucket is past its settle window), so the first select
  // initializes the backend and the second cannot race it — the workaround has
  // nothing left to prevent, and its `__init` stack create plus delete leave
  // with it.

  // Pilot-light sizing: primary gets full sizing (role: 'primary',
  // minWorkers/maxWorkers as configured); standby is a dormant DR target, not
  // a live mirror of primary's capacity — it deploys with minWorkers: 0 (no
  // Pulumi-provisioned worker nodes, just master + database) and its
  // cluster-autoscaler zeroed in applyK3sManifests. `caBoundsMin` carries
  // primary's minWorkers through anyway so the bounds pre-rendered into the
  // carbon-autoscaler-config Secret are ALREADY sized for the day standby is
  // promoted — a failover only has to flip CA's Deployment replicas 0→1,
  // never re-render the Secret. maxWorkers stays shared across both sides so
  // CA's headroom (maxWorkers - caBoundsMin) matches what primary would have
  // once the standby is promoted.
  // Wrap each per-cluster deploy in perfAsync so the parallel fan-out is
  // visible in perf_substep — without this, k8s-ha emits only
  // deploy.ha.k8s.full and we can't tell which cluster dominated the
  // wall-clock or how unbalanced the fan-out is.
  // Deferred infra signals fed by each cluster's onInfraReady hook (fires
  // once nodes exist + k3s answers — minutes before the cluster deploy
  // finishes). Also resolved from the deploy's own settlement (result or
  // null) so the early-prep task below can never deadlock on a cluster that
  // failed before its infra came up.
  const deferInfra = () => {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const primaryInfra = deferInfra();
  const standbyInfra = deferInfra();
  // The `vibecarbon` namespace, signalled by each cluster's onNamespaceReady
  // (right after applyVibecarbonSecrets creates it). The transport's gateways
  // are applied into it, so early prep starts once both have fired. Settled
  // by the deploy's own settlement too, like the infra signals.
  const namespaceReady = { primary: deferInfra(), standby: deferInfra() };
  // The primary's built image ref, handed to the standby's deployK3s, which
  // waits for it and runs that image from its own registry. Rejected when the
  // primary deploy fails, so the standby never waits on an image that will not
  // come; the standby's own rejection is then reported beside the primary's.
  const primaryImage = deferValue();

  const primaryPromise = perfAsync('deploy.ha.k8s.primary', () =>
    deployK3s({
      ...options,
      region: primaryRegion,
      environment: primaryEnv,
      state: primaryState,
      sharedSshKeyPath,
      sharedSshPublicKey,
      sharedSshKeyId,
      tracker: primaryTracker,
      quietSuccess: true,
      role: 'primary',
      minWorkers: options.minWorkers,
      maxWorkers: options.maxWorkers,
      onInfraReady: primaryInfra.resolve,
      onNamespaceReady: () => namespaceReady.primary.resolve(true),
      onImageBuilt: primaryImage.resolve,
      // Tag every internal sub-stage perf marker with .primary so
      // perf_substep can attribute primary vs standby — without this
      // both clusters write to identical names and we can't see which
      // dominated (RCA: iter-reliab3 perf analysis revealed standby
      // ran 140s longer than primary in restore but the opposite in
      // deploy with no way to localize the asymmetry).
      perfPrefix: 'k3s.primary',
    }),
  );
  const standbyPromise = perfAsync('deploy.ha.k8s.standby', () =>
    deployK3s({
      ...options,
      region: standbyRegion,
      environment: standbyEnv,
      state: standbyState,
      masterServerType: standbyMasterType,
      dbServerType: standbyDbType,
      workerServerType: standbyWorkerType,
      serverType: standbyWorkerType,
      sharedSshKeyPath,
      sharedSshPublicKey,
      sharedSshKeyId,
      tracker: standbyTracker,
      quietSuccess: true,
      role: 'standby',
      // Pilot-light: no Pulumi-provisioned worker nodes on standby until a
      // failover promotes it.
      minWorkers: 0,
      maxWorkers: options.maxWorkers,
      // Dormant CA bounds: render the standby's carbon-autoscaler-config
      // Secret bounds against the PRIMARY's minWorkers (its own static floor
      // is 0), so promotion only has to flip CA's replica count, not
      // re-render the Secret.
      caBoundsMin: options.minWorkers ?? 1,
      onInfraReady: standbyInfra.resolve,
      onNamespaceReady: () => namespaceReady.standby.resolve(true),
      peerImageRef: primaryImage.promise,
      perfPrefix: 'k3s.standby',
      // DR restore seeds the PRIMARY only. The standby re-syncs from the
      // promoted primary via replication — running wal-g backup-fetch here
      // too would create a divergent timeline. Force off regardless of the
      // top-level -restore flag.
      restore: null,
    }),
  );
  // Settlement fallbacks: a warm redeploy may resolve without a fresh
  // onInfraReady (the deferred is already resolved — resolve is idempotent);
  // a failed cluster resolves null so the prep task bails instead of hanging.
  // The primary's settlement also settles its image ref, so the standby never
  // waits on a primary that finished without reporting one (each is a no-op
  // once onImageBuilt has resolved it).
  // A failed cluster settles its namespace signal false, so early prep ends
  // instead of waiting on a namespace that will not come.
  primaryPromise.then(
    (r) => {
      primaryInfra.resolve(r);
      namespaceReady.primary.resolve(true);
      if (r?.imageTag) primaryImage.resolve(r.imageTag);
      else primaryImage.reject(new Error('primary image unavailable: primary reported no image'));
    },
    () => {
      primaryInfra.resolve(null);
      namespaceReady.primary.resolve(false);
      primaryImage.reject(new Error('primary image unavailable: primary deploy failed'));
    },
  );
  standbyPromise.then(
    (r) => {
      standbyInfra.resolve(r);
      namespaceReady.standby.resolve(true);
    },
    () => {
      standbyInfra.resolve(null);
      namespaceReady.standby.resolve(false);
    },
  );

  // Early replication prep — firewall (UDP 51821 peer rules) + gateway pods +
  // WireGuard tunnel — runs WHILE the clusters finish manifests/helm, hiding
  // its cost inside the fan-out instead of paying it serially afterwards. It
  // starts on signals, never on a timed poll: both clusters' infra and both
  // namespaces. Opportunistic: any failure logs and returns false, and
  // setupReplication then brings up the transport on the serial path.
  ctx.primaryReplicationConfigured = false;
  const transportPrep = (async () => {
    const [pInfra, sInfra, pNs, sNs] = await Promise.all([
      primaryInfra.promise,
      standbyInfra.promise,
      namespaceReady.primary.promise,
      namespaceReady.standby.promise,
    ]);
    if (!pInfra?.masterIp || !sInfra?.masterIp || !pNs || !sNs) return false;
    // One marker over the firewall and the transport, so a throw from either
    // records `(failed)`, which the e2e budget reads.
    await perfAsync('deploy.ha.replication.transportEarly', async () => {
      // Firewall first — WireGuard's handshake needs UDP 51821 admitted for
      // the peer before the tunnel can come up. Conditional construction on
      // purpose: BaseProvider throws on a falsy token, the opener no-ops.
      await openReplicationFirewallForPeers({
        provider: options.apiToken ? new Provider(options.apiToken) : null,
        projectName: options.projectName,
        environment: options.environment,
        primaryDbIp: pInfra.dbIp,
        standbyDbIp: sInfra.dbIp,
      });
      await prepareReplicationTransport({
        primaryIp: pInfra.masterIp,
        standbyIp: sInfra.masterIp,
        primaryDbIp: pInfra.dbIp,
        standbyDbIp: sInfra.dbIp,
        primaryDbPrivateIp: pInfra.dbPrivateIp,
        standbyDbPrivateIp: sInfra.dbPrivateIp,
        sshKeyPath: sharedSshKeyPath,
      });
    });
    console.error('[k8s-ha] replication transport prepared during the cluster fan-out');
    return true;
  })().catch((err) => {
    console.error(
      `[k8s-ha] early transport prep did not complete (the serial path will bring it up): ${err?.message || err}`,
    );
    return false;
  });

  // With the transport up, make the PRIMARY replication-ready the moment its
  // whole deploy completes, never earlier: the hostPort patch recreates the
  // primary db pod, which must not overlap the primary's own migrations,
  // audits and backup verification (ruling R6). It overlaps the standby arm
  // whenever the primary finishes first. Same opportunistic contract: false
  // leaves it to setupReplication's serial path.
  const primaryConfig = transportPrep
    .then(async (prepared) => {
      if (!prepared) return false;
      const primaryResult = await primaryPromise; // rejection → .catch → false
      await configurePrimaryForReplication({
        primaryIp: primaryResult.masterIp,
        sshKeyPath: sharedSshKeyPath,
      });
      console.error('[k8s-ha] primary replication config applied during the cluster fan-out');
      return true;
    })
    .catch((err) => {
      console.error(
        `[k8s-ha] early primary replication config did not complete (the serial path will apply it): ${err?.message || err}`,
      );
      return false;
    });

  const settled = await Promise.allSettled([primaryPromise, standbyPromise]);
  // Surface per-cluster success/failure distinctly. Without this, a standby
  // failure in Promise.all would reject the whole thing but we'd have no way
  // to tell which cluster from the error message alone.
  const [primarySettled, standbySettled] = settled;
  if (primarySettled.status === 'rejected') {
    // summarizePulumiError, not `.message`: the automation API's CommandError
    // envelope STARTS with `code: N`, so the raw message reported
    // "primary: code: -2" and discarded the actual reason — which is exactly
    // what left the 2026-08-06 k8s-ha record attempt un-RCA-able.
    console.error(`[k8s-ha] primary deploy FAILED: ${summarizePulumiError(primarySettled.reason)}`);
  } else {
    console.error(
      `[k8s-ha] primary deploy OK: masterIp=${primarySettled.value.masterIp} floatingIp=${primarySettled.value.floatingIp} kubeconfig=${primarySettled.value.kubeconfig}`,
    );
  }
  if (standbySettled.status === 'rejected') {
    console.error(`[k8s-ha] standby deploy FAILED: ${summarizePulumiError(standbySettled.reason)}`);
  } else {
    console.error(
      `[k8s-ha] standby deploy OK: masterIp=${standbySettled.value.masterIp} floatingIp=${standbySettled.value.floatingIp} kubeconfig=${standbySettled.value.kubeconfig}`,
    );
  }
  if (primarySettled.status === 'rejected' || standbySettled.status === 'rejected') {
    const failures = [];
    if (primarySettled.status === 'rejected')
      failures.push(`primary: ${summarizePulumiError(primarySettled.reason)}`);
    if (standbySettled.status === 'rejected')
      failures.push(`standby: ${summarizePulumiError(standbySettled.reason)}`);
    throw new Error(`HA deploy failed — ${failures.join(' | ')}`);
  }
  const primaryResult = primarySettled.value;
  const standbyResult = standbySettled.value;
  p.log.success('Both clusters deployed');

  // Task 7 persists these under envConfig.ha.{primary,standby}.stack — the
  // role-mapped identity a post-failover redeploy reads back via
  // options.haStacks (see the mapping block above). `region` and the per-side
  // server types are the ACTUAL values each side deployed to, threaded here so
  // the orchestrator's config-persist records the deployed reality rather than
  // the options-level `region`/`secondaryRegion` (which cross-wire after a
  // failover swap) or the primary's types. The standby's types are the
  // region-resolved ones (may differ from the primary's when its region doesn't
  // stock the same SKU); a failover converge reads them back so it never plans
  // an in-place resize of the standby's master/db node.
  ctx.primaryResult = {
    ...primaryResult,
    stack: primaryEnv,
    region: primaryRegion,
    masterServerType:
      options.masterServerType || options.serverType || Provider.DEFAULT_K8S_NODE_TYPE,
    dbServerType: options.dbServerType || options.serverType || Provider.DEFAULT_K8S_NODE_TYPE,
    workerServerType:
      options.workerServerType || options.serverType || Provider.DEFAULT_K8S_NODE_TYPE,
  };
  ctx.standbyResult = {
    ...standbyResult,
    stack: standbyEnv,
    region: standbyRegion,
    masterServerType: standbyMasterType || Provider.DEFAULT_K8S_NODE_TYPE,
    dbServerType: standbyDbType || Provider.DEFAULT_K8S_NODE_TYPE,
    workerServerType: standbyWorkerType || Provider.DEFAULT_K8S_NODE_TYPE,
  };
  // Both clusters have settled, so every signal prep waits on has fired; on
  // the unhappy path the catch above resolves false. Await AFTER the
  // hard-fail check so a cluster failure surfaces immediately.
  ctx.transportPrepared = await transportPrep;
  if (ctx.transportPrepared) {
    p.log.info('Replication transport prepared in parallel with the cluster deploys');
    // wg0 is up: start the image copy now, beside the primary's replication
    // config and the replication setup. The copy-standby-image step settles
    // it; the catch only keeps a failure that lands before then from reading
    // as an unhandled rejection.
    ctx.standbyImageCopy = startStandbyImageCopy(ctx);
    ctx.standbyImageCopy.catch(() => {});
  }
  ctx.primaryReplicationConfigured = await primaryConfig;
}

/** A promise with its resolve and reject, for a value another task produces. */
function deferValue() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nobody may be waiting yet when it rejects; the awaiting side still sees it.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/**
 * Copy the app image from the role primary's registry into the role
 * standby's, over wg0 (copyAppImageToStandby). primaryResult/standbyResult
 * are role-mapped, so a reconverge copies the new primary into the new
 * standby. The tunnel must be up.
 */
function startStandbyImageCopy(ctx) {
  const { primaryResult, standbyResult } = ctx;
  return perfAsync('deploy.ha.image.copyToStandby', () =>
    copyAppImageToStandby({
      primaryRef: primaryResult.imageTag,
      primaryIp: primaryResult.masterIp,
      standbyIp: standbyResult.masterIp,
      primaryMasterPrivateIp: primaryResult.masterPrivateIp,
      standbyMasterPrivateIp: standbyResult.masterPrivateIp,
      standbyDbIp: standbyResult.dbIp,
      sshKeyPath: ctx.sharedSshKeyPath,
    }),
  );
}

/**
 * Open the WireGuard tunnel port (UDP 51821) in BOTH clusters' cloud
 * firewalls (provider-routed: findFirewallByName →
 * buildReplicationFirewallRules → setFirewallRules, implemented by every HA
 * provider), each admitting its PEER database node's PUBLIC IP — the
 * WG endpoints are the database nodes' public IPs, and the firewall's default
 * udp rule only admits the private range. Symmetric on both clusters: the
 * standby streams from the primary at deploy time, and the post-failover
 * reverse re-seed dials the promoted standby (neither failover.js nor
 * restore.js touches firewalls, so deploy must set up both directions). The
 * per-cluster firewall (`<project>-<env>-<role>-firewall`) is attached to all
 * that cluster's nodes incl. the database/WG node. provider.buildReplicationFirewallRules
 * emits the udp/51821 rule (Hetzner also scrubs stale TCP 5432/5433/30432
 * rules from the retired public-IP TLS transport — see HetznerProvider's
 * implementation). Non-fatal per cluster (manual firewall config may
 * suffice). Shared by the early fan-out prep and the post-provision effect;
 * idempotent — no set_rules PUT when the rules already match.
 */
async function openReplicationFirewallForPeers({
  provider,
  projectName,
  environment,
  primaryDbIp,
  standbyDbIp,
}) {
  if (!provider) return;
  for (const [clusterRole, peerDbIp] of [
    ['primary', standbyDbIp],
    ['standby', primaryDbIp],
  ]) {
    if (!peerDbIp) continue;
    const firewallName = `${projectName}-${environment}-${clusterRole}-firewall`;
    try {
      const firewall = await provider.findFirewallByName(firewallName);
      if (!firewall) {
        // findFirewallByName soft-fails to null on a non-ok response, so this
        // is "absent OR unreadable" — either way the peer rule is not open.
        p.log.warn(
          `Could not resolve firewall ${firewallName}, WireGuard UDP 51821 may not be ` +
            "open to the peer, and HA replication won't work until it is.",
        );
        continue;
      }
      const updatedRules = provider.buildReplicationFirewallRules(firewall, peerDbIp);
      if (updatedRules) {
        await provider.setFirewallRules(firewall.id, updatedRules);
      }
    } catch (err) {
      // Stays non-fatal (manual firewall config may suffice), but it must SAY
      // so. This was a bare `catch {}` with no log line at all — its compose
      // twin in compose/ha.js has warned all along, and a swallowed failure
      // here reproduces the replication-blocker chain from the 2026-07-05 RCA,
      // where our own network policy was the invisible cause.
      p.log.warn(
        `Failed to open the replication firewall for the ${clusterRole} cluster ` +
          `(${firewallName}): ${err.message}. HA replication will not work until UDP ` +
          '51821 is open to the peer.',
      );
    }
  }
}

/**
 * Post-provision firewall effect. When the fan-out's early prep already ran
 * (ctx.transportPrepared) this re-check is a cheap no-op belt — the rules
 * builder returns falsy when nothing changed, so no PUT is issued.
 */
async function haK8sOpenReplicationFirewall(ctx) {
  const options = ctx.options;
  const { primaryResult, standbyResult } = ctx;
  const Provider = providerFor(options);
  await openReplicationFirewallForPeers({
    provider: options.apiToken ? new Provider(options.apiToken) : null,
    projectName: options.projectName,
    environment: options.environment,
    primaryDbIp: primaryResult.dbIp,
    standbyDbIp: standbyResult.dbIp,
  });
}

/**
 * Configure PostgreSQL replication (must run after both clusters finish —
 * replication restarts postgres pods). Calls setupReplication (the hardened WG
 * transport + scale-to-zero reseed) as a black box and records its verdict +
 * a folded last-state hint for the shared hard-gate in verify-streaming.
 */
async function haK8sConfigureReplication(ctx) {
  const options = ctx.options;
  const s = ctx.s;
  const { primaryResult, standbyResult, sharedSshKeyPath } = ctx;
  // 4. Configure PostgreSQL replication (must run after both clusters finish —
  // replication restarts postgres pods, which would break concurrent tail work).
  //
  // An HA deploy whose standby isn't verifiably streaming FAILS by default.
  // Warm-standby / degraded DR is not silently accepted — a deploy that
  // reports `deployed` must have a real replica. `vibecarbon deploy
  // -allow-degraded` (options.allowDegraded) opts into finalizing the env in a
  // DEGRADED (warm-standby) state instead. k8s-HA replication is
  // fragility-prone (memory: project_replication_broken), so this gate can
  // fail deploys that would otherwise look fine — that is the intended safety
  // behavior; the failure message below is actionable (why + last observed
  // state + the -allow-degraded escape hatch).
  const allowDegraded = !!options.allowDegraded;
  s.start('Configuring PostgreSQL replication');
  const replicationStatus = 'not configured';
  let replStreaming = false;
  let replLastState = '';
  let replError = null;
  try {
    const replResult = await setupReplication({
      primaryIp: primaryResult.masterIp,
      standbyIp: standbyResult.masterIp,
      primaryDbIp: primaryResult.dbIp,
      standbyDbIp: standbyResult.dbIp,
      primaryDbPrivateIp: primaryResult.dbPrivateIp,
      standbyDbPrivateIp: standbyResult.dbPrivateIp,
      sshKeyPath: sharedSshKeyPath,
      transportPrepared: ctx.transportPrepared === true,
      primaryConfigured: ctx.primaryReplicationConfigured === true,
    });
    replStreaming = replResult.streaming;
    replLastState = replResult.lastState || '';
    // Set only on verified streaming; the deploy persists it as
    // ha.systemIdentifier for failover's replica proof.
    ctx.systemIdentifier = replResult.systemIdentifier ?? null;
  } catch (error) {
    replError = error;
    // The fold below keeps only the last line for the gate message; the full
    // error (which names the exact failing command) must reach the log or
    // repeated live-rig RCA has nothing to work from.
    console.error(`[k8s-ha] setupReplication failed:\n${error?.stack || error?.message || error}`);
  }

  // If setupReplication threw, fold its message into the last-state hint so the
  // shared gate surfaces the real cause (e.g. a cross-cluster connectivity error)
  // rather than a generic "no replica connected". Prefer the FIRST line of a
  // runCommandAsync error ("Command failed ...: <argv>") — it names the failing
  // command; the last line is usually kubectl's generic "command terminated".
  let lastStateHint = replLastState;
  if (replError && !lastStateHint) {
    const msg = replError.message || String(replError);
    const lines = msg.split('\n').filter((l) => l.trim() && !l.includes('Warning: Permanently'));
    const bestLine = (
      lines.find((l) => l.includes('Command failed')) ||
      lines[lines.length - 1] ||
      msg
    ).trim();
    lastStateHint = bestLine.length > 220 ? `${bestLine.slice(0, 220)}…` : bestLine;
  }

  ctx.replicationStatus = replicationStatus;
  ctx.replStreaming = replStreaming;
  ctx.replLastState = replLastState;
  ctx.replError = replError;
  ctx.lastStateHint = lastStateHint;
  ctx.allowDegraded = allowDegraded;
}

/**
 * Hard-gate the deploy on streaming replication (finding #1): throws by default
 * when not streaming; with -allow-degraded finalizes a warm/degraded standby.
 * Sets ctx.replicationStatus for the finalize summary + persisted DR posture.
 */
async function haK8sVerifyStreaming(ctx) {
  const s = ctx.s;
  const { replStreaming, lastStateHint, allowDegraded } = ctx;
  // Shared hard-gate (finding #1): throws by default when not streaming; with
  // -allow-degraded it returns { degraded: true }. k8s-HA replication has a
  // documented history of fragility (memory: project_replication_broken), so
  // this gate MAY turn previously green deploys red — that is the intended
  // safety behavior.
  try {
    assertReplicationStreamingOrDegraded({
      streaming: replStreaming,
      lastState: lastStateHint,
      allowDegraded,
      fixHint: 'Fix the replication issue (see the k8s-ha replication notes).',
    });
  } catch (gateErr) {
    s.stop('Replication verification failed, aborting HA deploy');
    throw gateErr;
  }

  let replicationStatus;
  if (replStreaming) {
    s.stop('PostgreSQL replication configured, streaming');
    replicationStatus = 'streaming';
  } else {
    s.stop('Replication DEGRADED, continuing (-allow-degraded)');
    replicationStatus = 'DEGRADED (warm standby: NOT streaming)';
    p.log.warn(
      'DEGRADED HA: the standby is not streaming from the primary. Disaster recovery ' +
        'is NOT guaranteed; the standby is a warm/cold spare that may be missing recent ' +
        'writes. You proceeded with -allow-degraded; resync with `vibecarbon deploy` (no ' +
        '-allow-degraded) once the replication issue is resolved.',
    );
  }
  ctx.replicationStatus = replicationStatus;
}

/**
 * Settle the standby's image copy: await the one provision-clusters started,
 * or start it now (the transport is up after configure-replication). A failure
 * fails the deploy; under -allow-degraded the standby is recorded without its
 * image instead (R14), and failover refuses it until a deploy copies it.
 */
async function haK8sCopyStandbyImage(ctx) {
  const s = ctx.s;
  ctx.standbyImageMissing = false;
  s.start('Copying the app image to the standby');
  try {
    const { digest } = await (ctx.standbyImageCopy ?? startStandbyImageCopy(ctx));
    ctx.standbyImageDigest = digest;
    s.stop(`Standby has the app image (${digest})`);
  } catch (err) {
    if (!ctx.options.allowDegraded) {
      s.stop('Standby image copy failed, aborting HA deploy');
      throw err;
    }
    ctx.standbyImageMissing = true;
    s.stop('Standby image MISSING, continuing (-allow-degraded)');
    p.log.warn(
      `DEGRADED HA: ${/[.?!]$/.test(err.message) ? err.message : `${err.message}.`} The standby cannot start the app, so failover refuses ` +
        'it. You proceeded with -allow-degraded; rerun `vibecarbon deploy` to copy the image.',
    );
  }
}

/** Configure managed-DNS HA for failover — registry-driven over DNS_PROVIDERS. */
async function haK8sUpdateDns(ctx) {
  const options = ctx.options;
  const { primaryResult, standbyResult } = ctx;
  // Explicit provider-id gate (the pre-convergence arms keyed on which
  // token/zone HAPPENED to be present, which is how a mis-threaded cred
  // could route DNS to the wrong cloud silently).
  if (!options.domain || !hasAutomatedDns(options.dnsProvider)) return;
  if (!options.dnsToken || !options.dnsZoneId) {
    p.log.warn(
      `${DNS_PROVIDERS[options.dnsProvider].name} HA DNS skipped (missing token or zone id): configure DNS manually`,
    );
    return;
  }
  const dnsName = DNS_PROVIDERS[options.dnsProvider].name;
  const { setupHA } = await getDnsProvider(options.dnsProvider);
  const haResult = await setupHA(options.dnsToken, options.dnsZoneId, options.domain, [
    { name: `${options.projectName}-${options.region}`, ip: primaryResult.floatingIp },
    {
      name: `${options.projectName}-${options.secondaryRegion}`,
      ip: standbyResult.floatingIp,
    },
  ]);
  // A refused record write fails the deploy; "configure DNS manually" over a
  // half-written zone is how a deploy reports success with the site unreachable.
  requireDnsSetup(haResult, `${dnsName} HA DNS records for ${options.domain}`);
  p.log.info('DNS configured — use `vibecarbon failover` to switch regions');
}

/** Print the Fullerene HA deploy summary + failover-command notes. */
async function haK8sFinalize(ctx) {
  const options = ctx.options;
  const { primaryResult, standbyResult, replicationStatus } = ctx;
  // Success message
  p.log.success(`${c.success('Fullerene HA deployment complete!')}`);

  if (options.domain) {
    p.log.info(`\n  ${c.bold(c.success(`🌐 https://${options.domain}`))}\n`);
  }

  p.note(
    [
      `Primary (${options.region}):   ${c.bold(primaryResult.floatingIp)} ${c.dim(`(master: ${primaryResult.masterIp})`)}`,
      `Standby (${options.secondaryRegion}):   ${c.bold(standbyResult.floatingIp)} ${c.dim(`(master: ${standbyResult.masterIp})`)}`,
      '',
      `Replication:           ${replicationStatus === 'streaming' ? c.success(replicationStatus) : c.warning(replicationStatus.length > 60 ? `${replicationStatus.slice(0, 60)}…` : replicationStatus)}`,
      ...(ctx.standbyImageMissing
        ? [
            `Standby image:         ${c.warning('MISSING (failover refuses until a deploy copies it)')}`,
          ]
        : []),
      '',
      `Kubeconfig (primary):  ${c.dim(primaryResult.kubeconfig)}`,
      `Kubeconfig (standby):  ${c.dim(standbyResult.kubeconfig)}`,
    ].join('\n'),
    'Cluster Information',
  );

  p.note(
    [`${c.dim('vibecarbon failover <env>')}`, `${c.dim('vibecarbon failover <env> -dry')}`].join(
      '\n',
    ),
    'Failover Commands',
  );
}

export const K8S_HA_EFFECTS = {
  haK8sGenerateSshKey,
  haK8sUploadSshKey,
  haK8sProvisionClusters,
  haK8sOpenReplicationFirewall,
  haK8sConfigureReplication,
  haK8sVerifyStreaming,
  haK8sCopyStandbyImage,
  haK8sUpdateDns,
  haK8sFinalize,
};
