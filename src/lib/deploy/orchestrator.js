/**
 * Deployment Orchestrator
 * Logic for executing the deployment after configuration is gathered
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import {
  backupStorageConfig,
  backupsRecordOf,
  chooseBackupsBucket,
  settleBackupsBucket,
} from '../backups-bucket.js';
import { formatCommandNote } from '../cli/help.js';
import { progressLog, spinner } from '../cli/progress.js';
import { resolvePrimary } from '../cli/resolve-primary.js';
import { c, link } from '../colors.js';
import { runCommand, runCommandAsync } from '../command.js';
import { loadProjectConfig, registerProject, updateProjectConfig } from '../config.js';
import { writeLogDetail } from '../deploy-logger.js';
import { getDnsProvider, hasAutomatedDns, operatorConfigForDns } from '../dns-provider.js';
import { clearDestroyedRecord } from '../env-identity.js';
import { stateSealRecorded } from '../iac/state-seal.js';
import { localKubeconfigPath } from '../kubeconfig.js';
import { readOperatorVar } from '../operator-env.js';
import { ensureOperatorIpAccess } from '../operator-ip.js';
import { perfAsync, perfTimer } from '../perf.js';
import { runProjectAssignment } from '../project-assignment.js';
import {
  assertRegionSupportedForTier,
  assertTierSupported,
  getObjectStorageProvider,
  providerFor,
  providerIdFor,
} from '../providers/index.js';
import { formatS3SetupFailure, projectStateBucketBase } from '../providers/s3-base.js';
import { readSshVersion } from '../runtime-floors.js';
import { mintAttemptId } from '../services/addon-start.js';
import { sshKeyPathFor } from '../ssh.js';
import { removeTempDir, startStaleSecretSweep } from '../temp-dir.js';
import { createTracker } from '../tracker.js';
import { resolveDeployImageSet } from '../version-channel.js';
import {
  assertDeployRestoreAllowed,
  backupCredentialVars,
  createS3Client,
  listLineages,
  resolveDeployRestorePoint,
  walgPrefixFor,
} from '../walg/restore-base.js';
import {
  finishAppKeyRotation,
  localAppStorageSecrets,
  recordFenceOutcome,
  resolveAppStorageCredential,
  scopingOf,
  syncHetznerFences,
  waitForAppKeyReady,
} from './app-storage-credential.js';
import { backupFenceWarning, recordBackupFence, writeK8sBackupFence } from './backup-fence.js';
import { recordDeployedLineage } from './backup-lineage.js';
import { renderBundle } from './bundle.js';
import { armDeployCompletionGuard, markDeployCompleted } from './completion-guard.js';
import { completionSummaryLines, entryIpFor } from './completion-summary.js';
import { imageBuildRecord } from './compose/app-image.js';
import { assertComposeHaReconvergeReady, planComposeHaReconverge } from './compose/ha-role-swap.js';
import { workingTreeDirty } from './delta.js';
import { resolveDockerHubCreds } from './docker-hub.js';
import { DEGRADED_CAUSE, preserveSafetyFields } from './env-safety-fields.js';
import { assertNoFailoverInFlight, haSeedRecord, readReplicaState } from './failover-guard.js';
import { fenceInfoLines } from './hetzner-app-key-fence.js';
import {
  checkReissueAfterRestore,
  createAcmeIssuanceWatchdog,
  deriveScaleUpList,
  failoverAddonManifests,
  k8sTlsIdentity,
  liveK8sTlsSecretSerial,
  quietKubectl,
  snapshotK8sTlsSecret,
  staleClusterIssuersProblem,
  staleObservabilityTlsProblem,
} from './k8s/index.js';
import { clusterIngressIp } from './k8s/ingress-ip.js';
import { createDeployDropRetired, releaseRetiredReservedIps } from './k8s/retired-reserved-ip.js';
import { checkDeployPrerequisites, operatorCheckEnvs } from './preflight.js';
import { fetchPublicDomain, publicCurlResolveArgs } from './public-domain-probe.js';
import { k8sPsqlRunner } from './replication.js';
import { clearRetiredFence, reconcileRetiredFence, retiredSides } from './retired-fence.js';
import { envS3Record } from './s3-record.js';
import { haStacksFrom } from './standby-types.js';
import { StateTracker } from './state.js';
import { isComposeTier, isHATier, isK8sTier, resolveTier } from './tier-registry.js';
import { probeTlsTrustOnce, TLS_FIRST_LOOK_BUDGET_MS } from './tls-ready.js';
import { caSlug, normalizeSerial, tlsSnapshotS3Prefix } from './tls-snapshot.js';
import {
  assertNoScaleCutoverInFlight,
  assertRolePrimaryWritable,
  liftStrandedWriteFence,
} from './write-fence.js';

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
 * `verifyTls: false` is the ONE verification opt-out, and only the k8s
 * deploy's app phase passes it: that phase asks whether the app answers from
 * the public internet, while the trust verdict is the TLS phase's
 * (verifyK8sTls), which probes with full verification and records a miss as
 * TLS pending. A chain is never silently passed. Everything else (SNI,
 * public DNS) is the same in both phases (publicProbeConnect).
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
  {
    timeoutMs = 60_000,
    intervalMs = 10_000,
    onPoll = null,
    onPollEvery = 6,
    verifyTls = true,
  } = {},
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
  // system resolver may hold a stale entry for the name, worst of all a
  // NEGATIVE one: any query made while the record didn't exist (a prior
  // teardown window, a failure diagnostic's curl) is cached as NXDOMAIN for
  // the zone's SOA minimum TTL (an hour on Hetzner DNS) by systemd-resolved
  // and most home routers, and the probe then ENOTFOUNDs for its whole
  // budget against a healthy deploy (e4 2026-08-28: 118 attempts while
  // 1.1.1.1 served the record the entire time). fetchPublicDomain resolves
  // through public DNS on every attempt (public-domain-probe.js, the one
  // path every probe of the app's domain takes), with SNI pinned to the
  // domain and the shared trust policy.
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
      const res = await fetchPublicDomain(
        url,
        { method: 'GET', signal: AbortSignal.timeout(8_000) },
        { verifyTls },
      );
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
 * The origins one environment's app bucket allows. SECURITY: never a `*`
 * wildcard (setBucketCors refuses it). With a domain that is exactly
 * `https://<domain>`, the single public origin the app serves from. A
 * domainless env has no browser origin to trust yet, so it gets the localhost
 * dev origins.
 *
 * @param {string} [domain]
 * @returns {string[]}
 */
export function envCorsOrigins(domain) {
  return domain ? [`https://${domain}`] : ['http://localhost:3000', 'http://localhost:5173'];
}

/**
 * Set the app bucket's CORS rule to exactly this environment's origins. The
 * bucket belongs to this environment alone, so the rule has one owner and is
 * replaced outright. Runs on EVERY deploy, outside the skippable s3-setup
 * step, so deployments whose rule is missing or was edited out-of-band
 * converge on re-run. One GET, and a PUT only when the rule differs, so a
 * warm redeploy writes nothing. A failed GET just means the rule is unknown,
 * so it PUTs. A failure only costs browser uploads, so it warns and returns.
 * Storage that does not implement CORS (Linode E2 and E3 answer 501) cannot be
 * fixed by a re-run or a console setting, so that warning says what can.
 *
 * @param {object} opts
 * @param {() => Promise<object>} opts.createProvider - builds a provider at the
 *   APP bucket's region (the shared one may point at the state bucket's)
 * @param {string} opts.bucket - app bucket name
 * @param {string} [opts.domain]
 * @param {{ warn: Function }} opts.log
 * @returns {Promise<void>}
 */
export async function applyAppBucketCors({ createProvider, bucket, domain, log }) {
  const origins = envCorsOrigins(domain);
  try {
    if (!domain) {
      log.warn(
        'No domain configured, so bucket CORS only allows localhost dev origins for this environment. Re-run deploy with a domain to allow your production origin.',
      );
    }
    const provider = await createProvider();
    const existing = await provider.getBucketCorsOrigins(bucket).catch(() => null);
    if (existing && sameOrigins(existing, origins)) return;
    await provider.setBucketCors(bucket, origins);
  } catch (corsErr) {
    if (corsErr?.name === 'NotImplemented' || corsErr?.$metadata?.httpStatusCode === 501) {
      log.warn(
        `Browser uploads will not work here: this storage does not support CORS, so ${bucket} cannot allow your origin. Use a storage region that does, then deploy again.`,
      );
      return;
    }
    log.warn(
      `Browser uploads will fail until the bucket allows your origin (${corsErr.message}). Re-run \`vibecarbon deploy\` to apply it again, or set CORS on ${bucket} in your provider console.`,
    );
  }
}

/** Equal as sets, whatever order or duplicates a provider returns. */
function sameOrigins(a, b) {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((o) => right.has(o));
}

/**
 * Start the app-bucket storage work that does not gate provisioning, so it
 * runs beside the IaC step instead of ahead of it (R7): the CORS rule and,
 * only on a provider that fences a pasted app key (`appKeyScoping:
 * 'paste-fence'`), one read of the bucket's creation time, which the fence
 * takes as proof a deploy finished. Its output is held back while IaC prints,
 * and `finish(log)`, awaited just before the success outro, waits for it and
 * reports any warnings. Every other provider costs nothing: no read, and no
 * `bucketCreatedAt` on the result.
 *
 * The CORS step warns instead of throwing, and an unreadable creation time
 * is recorded as unknown (null). A provider class without a declared scoping
 * is a bug the census catches; `finish` warns about it and records nothing,
 * because it runs after IaC succeeded and a throw would skip the final config
 * save.
 *
 * Two security checks run here too (security plan R2, R9), and they DO make
 * `finish` reject, because an app whose own key cannot reach its bucket, or
 * whose fence did not take, is a failed deploy: `createAppProvider` (an
 * isolated or fenced env) polls HeadBucket with the app key inside a fixed
 * budget, and `fence` writes and verifies the Hetzner deny-fence.
 *
 * @param {object} opts
 * @param {string} opts.providerId - the env's provider id, for its app key scoping
 * @param {() => Promise<object>} opts.createProvider
 * @param {string} opts.bucket
 * @param {string} [opts.domain]
 * @param {() => Promise<{ canHeadBucket(bucket: string): Promise<boolean> }>} [opts.createAppProvider]
 *   - a client on the env's own app key; absent on the shared tier
 * @param {() => Promise<{ unverified?: string[], skipped?: string[], gone?: string[], located?: object[] }>} [opts.fence]
 *   - the Hetzner fence sync; its `located` and `gone` print as info lines (fenceInfoLines)
 * @param {(ms: number) => Promise<void>} [opts.sleep] - test seam for the readiness poll
 * @returns {{
 *   done: Promise<void>,
 *   finish: (log: { warn: Function, info: Function }) => Promise<{ bucketCreatedAt?: string|null,
 *     fenceSkipped?: string[], fenceGone?: string[], fenceFound?: string[],
 *     fenceLocated?: { bucket: string, region: string, endpoint: string|null }[] }>,
 * }}
 *   `bucketCreatedAt` (ISO string, or null when unknown) is present only on a
 *   provider that fences a pasted app key. `fenceSkipped`, `fenceGone`,
 *   `fenceFound` and `fenceLocated` are present only when the fence ran, for
 *   recordFenceOutcome.
 */
export function startAppBucketFinalize({
  providerId,
  createProvider,
  bucket,
  domain,
  createAppProvider,
  fence,
  sleep,
}) {
  const warnings = [];
  const heldLog = { warn: (message) => warnings.push(message) };
  // One S3 client for the CORS step and the creation-time read.
  let providerPromise;
  const sharedProvider = () => {
    providerPromise ??= createProvider();
    return providerPromise;
  };
  const done = applyAppBucketCors({
    createProvider: sharedProvider,
    bucket,
    domain,
    log: heldLog,
  });
  const fenceRecord = readFenceBucketRecord({
    providerId,
    createProvider: sharedProvider,
    bucket,
  });
  // The env's own app key (isolated or fenced tier) must reach its bucket
  // before the deploy calls itself done: a new key can take 5 to 10 s to
  // answer (R9). Polled here, beside IaC, never as a serial step before it.
  const appKeyReady = createAppProvider
    ? waitForAppKeyReady({ createAppProvider, bucket, ...(sleep && { sleep }) })
    : Promise.resolve();
  // The Hetzner deny-fence write and its consistency probes (R2), likewise.
  const fenced = fence ? Promise.resolve().then(fence) : Promise.resolve(null);
  // Handled at `finish`; this only keeps an early rejection from counting as
  // unhandled while IaC runs.
  fenceRecord.catch(() => {});
  appKeyReady.catch(() => {});
  fenced.catch(() => {});
  return {
    done,
    async finish(log) {
      await done;
      for (const message of warnings) log.warn(message);
      await appKeyReady;
      const fence = await fenced;
      if (fence?.skipped?.length) {
        log.warn(
          `app key fence NOT set on ${fence.skipped.join(', ')}: the bucket does not exist and no environment finished a deploy into it. A pasted app key could use it once it is created; \`vibecarbon status\` marks it until a deploy fences it.`,
        );
      }
      if (fence?.unverified?.length) {
        log.info(
          `app key fence written on ${fence.unverified.join(', ')}, not probed: no fenced key for it is stored on this machine`,
        );
      }
      for (const line of fenceInfoLines(fence)) log.info(line);
      // Present only when the fence ran, so the caller can persist (or clear)
      // the unfenced marker status shows and the not-found marks.
      const fenceOut = fence
        ? {
            fenceSkipped: fence.skipped ?? [],
            fenceGone: fence.gone ?? [],
            fenceFound: (fence.found ?? []).map((f) => f.bucket),
            fenceLocated: (fence.located ?? []).map(({ bucket, region, endpoint }) => ({
              bucket,
              region,
              endpoint,
            })),
          }
        : {};
      const { recorded, createdAt, warning } = await fenceRecord;
      if (warning) log.warn(warning);
      if (!recorded) return fenceOut;
      return { ...fenceOut, bucketCreatedAt: createdAt ? createdAt.toISOString() : null };
    },
  };
}

/**
 * What the app key fence needs from this deploy: on a provider that fences a
 * pasted key, the bucket's creation time (null when it cannot be read), whose
 * presence in the env's record is the fence's proof that a deploy finished
 * (`fenceTargets`, hetzner-app-key-fence.js). It follows the provider's
 * declared scoping and nothing else, so no other setting can leave a bucket
 * unfenced. An undeclared scoping comes back with a `warning`, never a throw.
 *
 * @param {{ providerId: string, createProvider: () => Promise<object>, bucket: string }} opts
 * @returns {Promise<{ recorded: boolean, createdAt?: Date|null, warning?: string }>}
 */
async function readFenceBucketRecord({ providerId, createProvider, bucket }) {
  let scoping;
  try {
    ({ scoping } = await scopingOf(providerId));
  } catch (err) {
    return {
      recorded: false,
      warning: `App key scoping unknown (${err.message}), so the bucket's creation time is not recorded.`,
    };
  }
  if (scoping !== 'paste-fence') return { recorded: false };
  let createdAt = null;
  try {
    createdAt = await (await createProvider()).bucketCreatedAt(bucket);
  } catch {
    // Recorded as null: the fence reads that the key is there, not its value.
  }
  return { recorded: true, createdAt };
}

/**
 * Refuse to provision against a bucket the provider has not made readable.
 * createBucket's visibility probe (HEAD+LIST+write, 120s) can exhaust its
 * budget: the provider acked the create but no frontend serves the bucket.
 * Every consumer downstream depends on it (storage uploads on the app
 * bucket, wal-g on the backup bucket, Pulumi on the state bucket), and
 * proceeding used to mean building a VPS and failing minutes later with a
 * NoSuchBucket from whichever consumer touched it first (Hetzner e2e
 * 2026-09-21, compose leg: wal-g's audit, five minutes and one server in).
 * Nothing has been provisioned at this point, and bucket creation is
 * idempotent, so a clean refusal plus a re-run is the whole recovery.
 *
 * @param {{ name: string, ready: boolean }} result - createBucket's return value
 * @param {string} role - human label: 'app storage' | 'backup' | 'Pulumi state'
 */
export function assertBucketReady(result, role) {
  if (result.ready) return;
  throw new Error(
    `${role} bucket ${result.name} was created, but the object storage provider did not make it ` +
      'readable within 2 minutes (no frontend answered HEAD, LIST and a write round-trip ' +
      'consistently). Nothing was provisioned. Re-run `vibecarbon deploy` once the bucket is ' +
      'visible in the provider console; bucket creation is idempotent and the existing bucket is reused.',
  );
}

/**
 * Where the SERVING cluster's kubeconfig lives. Exported for unit tests.
 *
 * HA deploys split into kubeconfig-<env>-primary / -standby; standalone uses
 * just kubeconfig-<env>. The cluster that decides whether the domain serves
 * is the one holding the PRIMARY ROLE — and stacks keep their birth names
 * while roles flip at failover (envConfig.ha.primary.stack is the role
 * pointer), so "prefer the -primary FILE" is only right until the first
 * failover. d4 run 7 RCA (2026-08-28): during the post-failover reconverge,
 * the health probe's ACME watchdog keyed off the -primary file and inspected
 * the DEMOTED cluster — all certs Ready, nothing to repair — while the
 * SERVING (`-standby`-named) cluster's invalid Order sat unrepairable for
 * the probe's whole 20-minute budget. Follow the role first; fall back to
 * the old file preference for configs that never recorded one. Returns the
 * standalone path when nothing exists so the caller surfaces a
 * file-not-found rather than a silent skip.
 *
 * @param {string} environment
 * @param {{ha?: {primary?: {stack?: string}}}} [envConfig]
 */
const isHaTier = (tier) => tier === 'compose-ha' || tier === 'k8s-ha';

/**
 * The orchestrator's entry region guard, right after the tier gate: for the
 * k8s tiers the region and standby region must be ones the provider runs
 * Kubernetes in. Throws before any provider API or Pulumi work.
 * @param {typeof import('../providers/base.js').BaseProvider} ProviderClass
 * @param {string} tier
 * @param {{region?: string, secondaryRegion?: string|null}} config
 */
export function assertDeployRegion(ProviderClass, tier, config) {
  assertRegionSupportedForTier(
    ProviderClass,
    tier,
    config.region,
    isHaTier(tier) ? config.secondaryRegion : null,
  );
}

/** The node the persisted roles call primary, as the write-fence marker names it. */
function rolePrimaryOf(_tier, envConfig, environment) {
  return resolvePrimary(envConfig, { env: environment });
}

/**
 * The deployed role primary's address, by tier: the server a deploy-time read
 * of the database (its lineage) goes to.
 */
function deployedPrimaryIp(tier, deployResult) {
  if (tier === 'compose-ha') return deployResult?.primaryIp ?? null;
  if (tier === 'k8s-ha') return deployResult?.primary?.masterIp ?? null;
  return deployResult?.masterIp ?? null;
}

/** psql on the deployed role primary, every tier (compose single included). */
async function deployedPrimaryPsql(tier, environment, projectName, ip) {
  if (isComposeTier(tier)) {
    const { composePsqlRunner } = await import('./compose/ha.js');
    return composePsqlRunner(ip, sshKeyPathFor(environment), `/opt/${projectName}`);
  }
  return k8sPsqlRunner(ip, sshKeyPathFor(environment));
}

/** psql on the role primary over the tier's transport (the write-fence checks). */
async function rolePrimaryPsql(tier, environment, projectName, ip) {
  const key = sshKeyPathFor(environment);
  if (isComposeTier(tier)) {
    const { composePsqlRunner } = await import('./compose/ha.js');
    return composePsqlRunner(ip, key, `/opt/${projectName}`);
  }
  return k8sPsqlRunner(ip, key);
}

/**
 * Deploy's entry lift of a stranded write fence (write-fence.js): a planned
 * failover interrupted between its database write fence and its journal, or a
 * compose scale killed mid-cutover (scale-cutover.js), left the primary
 * read-only with nothing promoted. Lift it before this deploy restarts the app
 * onto it. Every tier that writes the marker: the HA tiers and compose.
 * Unreachable or failing here is a warning: the post-bring-up probe checks
 * again.
 *
 * @param {{ tier: string, environment: string, envConfig: object, projectName: string, deps?: object }} args
 */
export async function liftStrandedFenceAtEntry({
  tier,
  environment,
  envConfig,
  projectName,
  deps = {},
}) {
  const {
    lift = liftStrandedWriteFence,
    psqlFor = rolePrimaryPsql,
    log = (line) => p.log.info(line),
    warn = (line) => p.log.warn(line),
  } = deps;
  if ((isHaTier(tier) || isComposeTier(tier)) && envConfig?.ha?.writeFence) {
    // Inside the try: `vibecarbon deploy` is the remedy an ambiguous-roles
    // error recommends, so that error can never be what stops this deploy.
    try {
      const rolePrimary = rolePrimaryOf(tier, envConfig, environment);
      if (rolePrimary?.ip) {
        await lift({
          environment,
          envConfig,
          rolePrimary,
          exec: await psqlFor(tier, environment, projectName, rolePrimary.ip),
          log,
        });
      }
    } catch (err) {
      warn(
        `${String(err?.message ?? err).split('\n')[0]}; deploy checks the primary again after bring-up`,
      );
    }
  }
}

export function resolveKubeconfigPath(environment, envConfig) {
  const roleStack = envConfig?.ha?.primary?.stack;
  const candidates = [
    ...(roleStack ? [localKubeconfigPath(process.cwd(), roleStack)] : []),
    localKubeconfigPath(process.cwd(), `${environment}-primary`),
    localKubeconfigPath(process.cwd(), environment),
  ];
  return {
    path: candidates.find((c) => existsSync(c)) ?? candidates[candidates.length - 1],
    candidates,
  };
}

/**
 * One-line summary of a failed probePublicHealth run. A watchdog abort wins
 * over the network-level summary: "order errored: 403 orderNotReady ..." is
 * the cause, while "self-signed certificate (118 attempts)" is only the
 * symptom of it.
 *
 * @param {object|null|undefined} probeResult
 * @returns {string}
 */
function probeFailureReason(probeResult) {
  const r = probeResult ?? {};
  if (r.abortReason) return `${r.abortReason}, probe stopped after ${r.attempts} attempts`;
  if (r.lastStatus) {
    return `last HTTP status ${r.lastStatus} after ${r.attempts} attempts over ${Math.round((r.timeoutMs ?? 0) / 1000)}s`;
  }
  if (r.lastErrorClass) {
    return `${r.lastErrorClass}: ${r.lastErrorMessage}${r.lastErrorCause ? ` (cause: ${r.lastErrorCause})` : ''} (${r.attempts} attempts)`;
  }
  return 'never connected';
}

/**
 * The k8s deploy's TLS phase, after the app phase found the app answering:
 * does the domain serve a trusted chain? One first look
 * (TLS_FIRST_LOOK_BUDGET_MS) with full verification and the ACME issuance
 * watchdog, which repairs a terminally-failed Order in place or aborts the
 * look with the ACME problem as the reason (acme-order-recovery.js).
 *
 * THE RULE: a deploy reports its TLS state; it does not wait out a CA. A miss
 * is TLS pending: recorded (the final save persists it as envConfig.tls),
 * one warning, and the deploy still succeeds, while cert-manager keeps
 * retrying in the background (its minimum backoff is CERT_MANAGER_MIN_BACKOFF).
 * A hit is trusted, and the primary cluster's Secret is saved as the env's
 * snapshot now instead of at the next scheduled backup (its public serial is
 * logged). One certificate per name: a trusted domain must serve the very
 * certificate Secret/vibecarbon-tls holds, since that is the one the snapshot
 * and every restore cover; a different served serial is one warning (another
 * certificate for the same name is loaded in Traefik). On a deploy whose
 * restore wrote Secret/vibecarbon-tls (`tlsRestoredAt`), a trusted domain
 * also gets the one-shot re-issue check (tls-reissue-watch.js): a
 * CertificateRequest created after the restore is one warning with
 * cert-manager's reason. Never throws.
 *
 * The snapshot goes to the backups bucket at its own region and endpoint
 * (backupStorageConfig), never through the uploads bucket's host.
 *
 * @param {{ domain: string, environment: string, projectName: string,
 *   kubeconfig: string, s3Config?: object,
 *   backupS3Config?: import('../backups-bucket.js').BackupsTarget | null,
 *   tlsRestoredAt?: string|null, deps?: object }} args
 * @returns {Promise<{ state: 'trusted'|'pending', checkedAt: string, reason?: string, ca: string }>}
 */
export async function verifyK8sTls({
  domain,
  environment,
  projectName,
  kubeconfig,
  s3Config,
  backupS3Config,
  tlsRestoredAt = null,
  deps = {},
}) {
  const probe = deps.probe ?? probePublicHealth;
  const reissueCheck = deps.reissueCheck ?? checkReissueAfterRestore;
  const identity = deps.identity ?? k8sTlsIdentity;
  const kubeconfigExists = deps.kubeconfigExists ?? existsSync;
  const kubectlFor =
    deps.kubectlFor ?? ((path) => quietKubectl({ ...process.env, KUBECONFIG: path }));
  const makeWatchdog =
    deps.makeWatchdog ??
    ((path) =>
      createAcmeIssuanceWatchdog({
        runKubectl: async (argv) =>
          (
            await runCommandAsync(['kubectl', '--kubeconfig', path, ...argv], {
              silent: true,
              timeout: 30_000,
            })
          ).trim(),
        log: (msg) => progressLog(msg),
      }));
  const snapshot = deps.snapshot ?? snapshotK8sTlsSecret;
  const servedSerial =
    deps.servedSerial ?? (async (d) => (await probeTlsTrustOnce(d)).serialNumber ?? null);
  const secretSerial = deps.secretSerial ?? liveK8sTlsSecretSerial;
  const { dnsNames, ca } = identity({ projectDir: process.cwd(), domain });
  const haveKubeconfig = kubeconfigExists(kubeconfig);
  const s = (deps.spinner ?? spinner)({ indicator: 'timer' });
  s.start(`Waiting for ${domain} to serve a trusted TLS certificate`);
  const result = await perfAsync('deploy.tls.ready', () =>
    probe(domain, {
      timeoutMs: TLS_FIRST_LOOK_BUDGET_MS,
      onPoll: haveKubeconfig ? makeWatchdog(kubeconfig) : null,
    }),
  );
  const checkedAt = new Date().toISOString();
  if (!result?.ok) {
    const reason = result?.abortReason ?? probeFailureReason(result);
    s.stop('TLS pending: the domain does not serve a trusted certificate yet');
    p.log.warn(
      `TLS pending: ${domain} does not serve a trusted certificate yet (${reason}). ` +
        'The app is deployed, and cert-manager keeps retrying issuance in the background. ' +
        'Run `vibecarbon status` to follow it.',
    );
    return { state: 'pending', checkedAt, reason, ca };
  }
  s.stop('TLS certificate trusted');
  if (!haveKubeconfig) {
    p.log.warn(
      `TLS certificate snapshot not saved (no kubeconfig at ${kubeconfig}). The deploy still succeeded, and the next scheduled backup saves it.`,
    );
  } else {
    const saved = await perfAsync('deploy.tls.snapshot', () =>
      snapshot({
        s3Config: backupStorageConfig(s3Config, backupS3Config),
        projectName,
        envName: environment,
        ca,
        dnsNames,
        runKubectl: kubectlFor(kubeconfig),
      }),
    );
    if (!saved?.ok) {
      p.log.warn(
        `TLS certificate snapshot not saved (${saved?.reason ?? 'unknown'}). The deploy still succeeded, and the next scheduled backup saves it.`,
      );
    } else if (saved.serial) {
      p.log.info(`TLS certificate snapshot saved (serial ${saved.serial}).`);
    }
    await warnOnServedSerialMismatch({
      domain,
      environment,
      readServed: () => servedSerial(domain),
      readSecret: () => secretSerial(kubectlFor(kubeconfig)),
    });
    if (tlsRestoredAt) {
      await reissueCheck({
        restoredAt: tlsRestoredAt,
        domain,
        environment,
        runKubectl: kubectlFor(kubeconfig),
        warn: (message) => p.log.warn(message),
      });
    }
  }
  return { state: 'trusted', checkedAt, ca };
}

/**
 * Warn when `domain` serves another certificate than Secret/vibecarbon-tls
 * holds. Both serials are public. Silent when either cannot be read: an
 * unread serial proves nothing either way. Never throws.
 *
 * @param {{ domain: string, environment: string,
 *   readServed: () => Promise<string|null>, readSecret: () => Promise<string|null> }} args
 */
async function warnOnServedSerialMismatch({ domain, environment, readServed, readSecret }) {
  let served = '';
  let secret = '';
  try {
    [served, secret] = (await Promise.all([readServed(), readSecret()])).map(normalizeSerial);
  } catch {
    return;
  }
  if (!served || !secret || served === secret) return;
  p.log.warn(
    `${domain} serves certificate serial ${served}, but Secret vibecarbon-tls holds serial ${secret}. ` +
      'Traefik has a second certificate for this name, so a restored certificate may not be the one your domain serves. ' +
      `Run \`vibecarbon diagnose ${environment}\` and look for another Certificate or TLS Secret that covers ${domain}.`,
  );
}

/**
 * The env safety fields the deploy's final write decides (env-safety-fields.js);
 * every other one keeps its value on disk. An HA deploy sets its replication
 * state and the standby's proven identifier (or leaves none when it could not
 * prove streaming); every deploy records its backup lineage, which names or
 * clears the unrestored prior one, and its TLS record (finalSaveTls).
 *
 * @param {boolean} isHADeploy
 * @returns {string[]}
 */
export function finalSaveSafetyOwns(isHADeploy) {
  return isHADeploy
    ? [
        'replication',
        'degraded',
        'degradedCause',
        'ha.systemIdentifier',
        'backup.unrestoredPrior',
        'tls',
      ]
    : ['backup.unrestoredPrior', 'tls'];
}

/**
 * The env's TLS record after this deploy: the verdict the tier reported
 * (deployResult.tls, `{ state, checkedAt, reason?, ca }`), else the record
 * on disk. Failover and scale read its `ca` to pick a certificate snapshot,
 * and status shows its state.
 *
 * @param {{ tls?: object }|undefined} deployResult
 * @param {{ tls?: object }|undefined} persistedEnvConfig - the env as it is on disk now
 * @returns {object|undefined}
 */
export function finalSaveTls(deployResult, persistedEnvConfig) {
  return deployResult?.tls ?? persistedEnvConfig?.tls;
}

/**
 * The k8s-ha deployResult's DR verdict from the plan ctx: replication, and
 * whether the standby is missing its app image. Under -allow-degraded either
 * one finishes the deploy degraded (R14).
 *
 * @param {{ replicationStatus?: string, standbyImageMissing?: boolean }} ctx
 * @returns {{ replication: 'streaming'|'degraded', standbyImageMissing: boolean, degraded: boolean }}
 */
export function k8sHaDegradedVerdict(ctx) {
  const streaming = ctx?.replicationStatus === 'streaming';
  const standbyImageMissing = !!ctx?.standbyImageMissing;
  return {
    replication: streaming ? 'streaming' : 'degraded',
    standbyImageMissing,
    degraded: !streaming || standbyImageMissing,
  };
}

/**
 * The DR posture an HA deploy's final save records: the replication verdict,
 * `degraded`, and the named cause when the standby is missing its app image
 * (R14). `degradedCause` is always present so it overrides a cause an earlier
 * deploy left; undefined is dropped when the config is written.
 *
 * @param {{ replication?: 'streaming'|'degraded', degraded?: boolean, standbyImageMissing?: boolean }} deployResult
 * @returns {{ replication: 'streaming'|'degraded', degraded: boolean, degradedCause: string|undefined }}
 */
export function haDegradedRecord(deployResult) {
  return {
    replication: deployResult?.replication ?? (deployResult?.degraded ? 'degraded' : 'streaming'),
    degraded: !!deployResult?.degraded,
    degradedCause: deployResult?.standbyImageMissing
      ? DEGRADED_CAUSE.STANDBY_IMAGE_MISSING
      : undefined,
  };
}

/**
 * The k8s-ha half of "the reconverge is complete": a deploy that stamps
 * deployedAt (no retired fence kept) removes lastFailover and its override
 * from the env it is about to save. Mutates and returns `env`.
 *
 * @param {object} env - the env record of the final save
 * @param {{ reconvergeIncomplete?: boolean }} deployResult
 * @returns {object}
 */
export function finishK8sReconvergeRecord(env, deployResult) {
  if (env && !deployResult?.reconvergeIncomplete) {
    delete env.lastFailover;
    delete env.lastFailoverOverride;
  }
  return env;
}

/**
 * k8s-ha: take the retirement fence off the cluster this deploy just rebuilt
 * as the standby (retired-fence.js). Only when the env was swapped at entry
 * (a retired side existed); a no-op otherwise. Throws when the clear cannot be
 * proven, and the caller runs it before the final save, so a failed clear
 * leaves deployedAt unstamped and the rerun clears it. A rebuilt standby that
 * is not a replica yet (a degraded deploy that did not reseed it) keeps its
 * fence: `kept` is true, the deploy still succeeds, and the caller leaves
 * deployedAt unstamped so the env stays swapped and the next deploy retries.
 *
 * @param {object} args
 * @param {Array<{ ip: string }>} args.retiredAtEntry
 * @param {string|undefined} args.standbyIp - the rebuilt standby's master
 * @param {string} args.projectName
 * @param {string} args.environment
 * @param {typeof clearRetiredFence} [args.clear]
 * @returns {Promise<{ ran: boolean, kept: boolean }>}
 */
export async function finishK8sRetiredFence({
  retiredAtEntry,
  standbyIp,
  projectName,
  environment,
  clear = clearRetiredFence,
}) {
  if (!retiredAtEntry?.length || !standbyIp) return { ran: false, kept: false };
  const { cleared } = await clear({ tier: 'k8s-ha', ip: standbyIp, projectName, environment });
  return { ran: true, kept: !cleared };
}

/**
 * Execute the deployment based on gathered configuration
 */
/**
 * The skeleton save's record of the k8s-ha standby types: master and db under
 * `ha.standby`, the worker under `ha.standbyWorkerSpec.serverType`, each
 * merged onto what the env already has and only when defined.
 *
 * @param {object|undefined} existingHa - the env's `ha` on disk
 * @param {{masterServerType?: string, dbServerType?: string, workerServerType?: string}|undefined} types
 * @returns {object}
 */
function standbyTypesRecord(existingHa, types) {
  if (!types) return {};
  const { masterServerType, dbServerType, workerServerType } = types;
  return {
    ...(masterServerType || dbServerType
      ? {
          standby: {
            ...(existingHa?.standby ?? {}),
            ...(masterServerType ? { masterServerType } : {}),
            ...(dbServerType ? { dbServerType } : {}),
          },
        }
      : {}),
    ...(workerServerType
      ? {
          standbyWorkerSpec: {
            ...(existingHa?.standbyWorkerSpec ?? {}),
            serverType: workerServerType,
          },
        }
      : {}),
  };
}

/**
 * The skeleton save's record of the compose-ha standby type, resolved before
 * the standby server exists: `ha.pendingStandby`, with the location it was
 * resolved for, so a rerun of a deploy that fails before the server is
 * created places the same type (effects/compose-ha.js). Once the server
 * exists its servers[] entry is the record and the pending save drops this.
 *
 * @param {string|null} secondaryRegion
 * @param {{serverType?: string}|undefined} types
 * @returns {object}
 */
function pendingStandbyRecord(secondaryRegion, types) {
  if (!secondaryRegion || !types?.serverType) return {};
  return { pendingStandby: { region: secondaryRegion, serverType: types.serverType } };
}

/**
 * The floating IP a k8s-ha side records: the cluster's own (Hetzner, Linode),
 * else a reserved IP the same stack still has on record (a DigitalOcean
 * cluster made before 2026-11 whose release failed,
 * k8s/retired-reserved-ip.js), so the next deploy or destroy can still
 * release it. Matched by stack, which a failover's role swap carries along,
 * else by role for a side recorded without one.
 */
function sideFloatingIp(result, priorHa) {
  if (result.floatingIp) return result.floatingIp;
  const byStack = [priorHa?.primary, priorHa?.standby].find(
    (side) => side?.stack && side.stack === result.stack,
  );
  if (byStack) return byStack.floatingIp;
  // A record saved before sides carried `.stack` (never swapped, since a
  // failover records it): matched by role, as destroy's backstop does.
  const role = ['primary', 'standby'].find((r) => String(result.stack ?? '').endsWith(`-${r}`));
  const byRole = role ? priorHa?.[role] : undefined;
  return byRole && !byRole.stack ? byRole.floatingIp : undefined;
}

/**
 * The success save's per-side k8s-ha record: each cluster's IPs (`ingressIp`
 * is the address its records point at, clusterIngressIp), region, stack
 * identity and the server types it ACTUALLY deployed with, plus the pilot
 * standby's worker spec. Exported for tests.
 *
 * @param {{primary: object, standby: object}} deployResult - the fan-out's per-side results
 * @param {{region: string, secondaryRegion: string, minWorkers?: number}} fallback
 * @param {object} [priorHa] - the `ha` record on disk before this save
 * @returns {{primary: object, standby: object, standbyWorkerSpec: object}}
 */
export function haSidesRecord(deployResult, { region, secondaryRegion, minWorkers }, priorHa) {
  return {
    primary: {
      masterIp: deployResult.primary.masterIp,
      ingressIp: clusterIngressIp(deployResult.primary),
      floatingIp: sideFloatingIp(deployResult.primary, priorHa),
      dbIp: deployResult.primary.dbIp,
      // The database node's PRIVATE IP — the local WireGuard-relay
      // endpoint the failover/restore re-seed dials (deterministic
      // 10.0.1.2 in the IaC program; persisted so identifyServers
      // can surface it without hardcoding).
      dbPrivateIp: deployResult.primary.dbPrivateIp,
      // The region + server types this side ACTUALLY deployed to,
      // from the fan-out result (fall back to the options value only
      // if absent). A failover/scale converge reads these back for the
      // stack's Pulumi `location` and current server types, so they
      // must reflect the deployed reality, not the (possibly swapped)
      // options-level flags or the shared primary types.
      region: deployResult.primary.region ?? region,
      masterServerType: deployResult.primary.masterServerType,
      dbServerType: deployResult.primary.dbServerType,
      // The standby's worker is recorded in standbyWorkerSpec below; a
      // failover swaps the two worker records with the roles.
      workerServerType: deployResult.primary.workerServerType,
      // Task 6/7: cluster identity (Pulumi stack name). A redeploy
      // reads THIS back as `envConfig.ha.primary.stack` (see the
      // haStacks derivation above, ~line 702) so a post-failover
      // redeploy follows the role↔stack mapping instead of
      // re-birthing the `${environment}-primary` default.
      stack: deployResult.primary.stack,
    },
    standby: {
      masterIp: deployResult.standby.masterIp,
      ingressIp: clusterIngressIp(deployResult.standby),
      floatingIp: sideFloatingIp(deployResult.standby, priorHa),
      dbIp: deployResult.standby.dbIp,
      dbPrivateIp: deployResult.standby.dbPrivateIp,
      region: deployResult.standby.region ?? secondaryRegion,
      // The standby's region-resolved types (may differ from the
      // primary's) — provisionStandbyCapacity pins them so a failover
      // converge never resizes the standby's master/db node.
      masterServerType: deployResult.standby.masterServerType,
      dbServerType: deployResult.standby.dbServerType,
      stack: deployResult.standby.stack,
    },
    // Pilot-light failover config: what `vibecarbon failover` will
    // provision (worker count/type) and bring up (app tier), derived
    // from this deploy's own inputs — never hardcoded in failover.
    standbyWorkerSpec: {
      count: minWorkers ?? 1,
      serverType: deployResult.standby.workerServerType,
    },
  };
}

export async function executeDeployment(args, gatheredConfig) {
  // Arm the silent-success guard FIRST. If this function's awaited work never
  // settles (2026-07-07 k8s-ha RCA: a standby deployK3s promise dangled and Node
  // drained the event loop, exiting 0 with the DR gate + config-persist never
  // reached), the process 'exit' handler forces a non-zero code. markDeployCompleted()
  // is only reached after the terminal config write at the end of this fn.
  armDeployCompletionGuard();
  // The whole deploy, start to success outro: the e2e cold-deploy budgets
  // (tests/e2e/checks/deploy-budget.ts) read it, minus the TLS first look.
  const deployTotalTimer = perfTimer('deploy.total');
  // Deploy bundles and other temp dirs and files with secrets in them that
  // earlier runs left in the OS temp dir: removed in the background
  // (temp-dir.js), so the deploy never waits on them. Its one line, when it
  // removed some, waits for a quiet point (flushed before the outro), so it
  // never breaks a spinner's line.
  const staleSecretSweep = startStaleSecretSweep();
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
    dbServerType,
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
    backupConfig,
    services,
  } = gatheredConfig;
  // The backups bucket this deploy settled on, `{ bucket, region, endpoint }`:
  // chosen and created in s3-setup below (src/lib/backups-bucket.js), never
  // gathered, so a name this deploy chose is recorded only once its bucket
  // exists.
  /** @type {import('../backups-bucket.js').BackupsTarget | null} */
  let backupS3Config = null;

  const { deployMode } = config;
  const tier = resolveTier({ deployMode, ha: config.ha });
  // A failover journal means the roles may be mid-swap, and this deploy's final
  // save rebuilds `ha` and would drop the journal its rerun resumes from. Every
  // HA tier refuses, before any work, and names the command that finishes it.
  if (isHaTier(tier)) assertNoFailoverInFlight({ environment, envConfig });
  // COMPOSE-HA RECONVERGE (R12), classified first thing after the tier is
  // known and BEFORE any mutation. `envConfig` here is the environment's
  // persisted config as it stood before this invocation, so it still carries
  // the roles a failover flipped, the one and only place the swap is recorded.
  // A swapped pair deploys by role (compose/ha-role-swap.js): the promoted node
  // stays the primary and the retired one is rebuilt as the standby. The journal
  // refusal is pure and fires here; the readiness reads (promoted node out of
  // recovery, DNS on it) need SSH, so they run right after the operator-IP
  // firewall check below, still ahead of every SSH write and Pulumi.
  const composeHaReconverge = planComposeHaReconverge({
    projectName: projectConfig.projectName,
    environment,
    envConfig,
  });
  // A planned failover interrupted between its database write fence and its
  // journal, or a compose scale killed mid-cutover, left the primary read-only:
  // lift it before this deploy restarts the app onto it.
  // A compose scale stopped mid-cutover: the config may still name the old
  // server while DNS and the database moved. Only the scale resumes it.
  assertNoScaleCutoverInFlight({ environment, envConfig, action: 'deploy' });
  await liftStrandedFenceAtEntry({
    tier,
    environment,
    envConfig,
    projectName: projectConfig.projectName,
  });
  // Fail fast with install guidance if host-side tools (pulumi, ssh) are
  // missing — before any Pulumi/SSH work would otherwise ENOENT mid-deploy.
  // Provider passed so the pulumi VERSION assertion can fire: a CLI too old
  // for this provider's state-backend options fails as totally as a missing
  // one, with a bucket error that names neither pulumi nor a version.
  //
  // The operator-config scopes/keys (config-registry.js) THIS deploy
  // touches, gathered before checkDeployPrerequisites so a malformed value
  // in any of them is refused in the same breath as a missing host tool —
  // always the resolved compute provider plus access/tls/state (their keys
  // are all optional, so they only fail on an actually-malformed value);
  // DNS via the shared operatorConfigForDns (mirrors resolveDnsToken's own
  // same-token comparison — see its doc for the same-cloud/no-sibling/
  // cross-cloud three-way split); registry only when the deploy will
  // actually attempt the dockerhub-login step (mirrors plan/steps.js's own
  // `when: (ctx) => !!ctx.dockerHubCreds` gate) — absent creds fall back to
  // an anonymous pull and never touch this scope.
  //
  // `env: operatorCheckEnvs(process.cwd())` — `where: '.env'` keys
  // (ACME_CA_SERVER, ALLOWED_SSH_IPS) are checked on the project file first
  // (it is what the bundle ships) and the shell; `where: '.env.local'` keys
  // (the provider tokens) on their effective shell-over-file value. See
  // preflight.js.
  const operatorScopes = ['access', 'tls', 'state', `provider:${providerIdFor(config)}`];
  const dnsOperatorConfig = operatorConfigForDns(dnsProvider, providerIdFor(config));
  operatorScopes.push(...dnsOperatorConfig.scopes);
  if (resolveDockerHubCreds()) {
    operatorScopes.push('registry');
  }
  checkDeployPrerequisites(tier, {
    ProviderClass: providerFor(config),
    sshVersion: readSshVersion,
    operatorScopes,
    operatorKeys: dnsOperatorConfig.keys,
    env: operatorCheckEnvs(process.cwd()),
  });
  assertTierSupported(providerFor(config), tier);
  assertDeployRegion(providerFor(config), tier, config);
  // One certificate per name: an observability add-on copied into the
  // project before the change still issues grafana-tls for the app domain
  // until `vibecarbon upgrade` refreshes it. Refused here, the last stop
  // before anything is provisioned (k8s/one-certificate.js).
  if (isK8sTier(tier)) {
    const staleObservabilityTls = staleObservabilityTlsProblem(process.cwd());
    if (staleObservabilityTls) throw new Error(staleObservabilityTls);
    // The same refusal for the ClusterIssuers: a project copied before
    // HTTP-01 certificates has no `letsencrypt-prod` for the Certificate.
    const staleClusterIssuers = staleClusterIssuersProblem(process.cwd());
    if (staleClusterIssuers) throw new Error(staleClusterIssuers);
  }

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
    accessResult = await perfAsync('deploy.preamble.operatorIpAccess', () =>
      ensureOperatorIpAccess({
        projectConfig,
        environment,
        isHA: isHATier(tier),
        apiToken,
        yes: !!args.yes,
        onMessage: (msg) => progressLog(msg),
      }),
    );
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

  // The retirement fence (R7), first thing once SSH is let in: a side a past
  // failover retired that has come back refuses its backups and serves nothing
  // before this deploy touches anything. Idempotent; an unreachable side is a
  // warning (the rebuild below reaches it, or the next command does).
  const retiredAtEntry = isHaTier(tier) ? retiredSides({ envConfig, tier }) : [];
  if (retiredAtEntry.length > 0) {
    await reconcileRetiredFence({ environment, envConfig, projectConfig, tier });
  }

  // The reconverge readiness reads (R12): after the operator-IP check, so an
  // operator whose IP changed is let back in before the first SSH read, and
  // before every SSH write and Pulumi call.
  if (composeHaReconverge) {
    const { composePsqlRunner, flipComposeDnsWith } = await import('./compose/ha.js');
    const haKey = sshKeyPathFor(environment);
    const managedDns = !!(domain && hasAutomatedDns(dnsProvider) && dnsToken && dnsZoneId);
    const ready = await assertComposeHaReconvergeReady({
      plan: composeHaReconverge,
      environment,
      domain,
      readState: (ip) =>
        readReplicaState({
          exec: composePsqlRunner(ip, haKey, `/opt/${projectConfig.projectName}`),
        }),
      resolveA: async (hostname) => {
        const { resolvePublicA } = await import('./public-dns-lookup.js');
        return resolvePublicA(hostname);
      },
      // A failover whose DNS flip failed: the deploy repoints the records
      // itself (managed DNS), before the reseed it gates.
      repointDns: managedDns
        ? (ip) =>
            flipComposeDnsWith({ dnsProvider, token: dnsToken, zoneId: dnsZoneId, domain, ip })
        : null,
    });
    composeHaReconverge.dnsAnswer = ready.dnsAnswer;
    p.log.info(
      `a failover swapped this environment's roles: ${composeHaReconverge.promoted.ip} stays ` +
        `the primary and ${composeHaReconverge.retired.ip} is rebuilt as the standby`,
    );
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
  //   2b. The bucket the last destroy KEPT (`retainedStateBucket`). destroy
  //      retains the state bucket and the state name stays stable; this
  //      records the kept name so the redeploy resumes it.
  //   3. Derivation from the project base (projectStateBucketBase), for
  //      everyone else. Not s3Config.bucket: the app bucket is per env, the
  //      state bucket per project.
  //
  // `stateBucketGeneration` is embedded by the derivation. A plain destroy
  // KEEPS the state bucket (retainStateBucket) and leaves the generation
  // alone; only a last-environment -purge rotates it, whether it deleted the
  // bucket or left it for you to delete by hand, so nothing is ever recreated
  // under a name that just got deleted (the
  // acked-write-loss hazard, e4 restore->failover 2026-08-07).
  //
  // Both HA stacks share this ONE bucket.
  const stateBucket = resolveStateBucketName({
    envStateBucket: s3Config.stateBucket,
    projectPin: projectConfig.stateBucket,
    retained: projectConfig.retainedStateBucket,
    projectBase: projectStateBucketBase(projectConfig),
    generation: projectConfig.stateBucketGeneration,
  });

  // The backups bucket for this storage region (one per project and region).
  // A fresh read of the file: an environment another deploy recorded since
  // this run started counts as a sibling.
  const backupsPlan = chooseBackupsBucket({
    environment,
    envConfig,
    projectConfig: loadProjectConfig() ?? projectConfig,
    region: s3Config.region,
  });

  // --- STEP 1: S3 Setup (Idempotent) ---
  // `stateBucket` is part of the inputs hash so an upgraded CLI (whose prior
  // deploy-state predates the dedicated state bucket) re-runs this step once to
  // create + migrate the state bucket. Combined with the StateTracker version
  // bump, no stale hash can skip the migration.
  // `backupsBucket` (was `backupBucket`) is renamed on purpose: every env's
  // hash changes once, so each env re-runs this step once after upgrading and
  // its step result gains the settled backups target the apply below reads.
  // That run creates no bucket: each one already exists and is found.
  // The hash names the PLAN's bucket and the record the SETTLED one, so an env
  // whose settle switched or re-chose also re-runs this step once on its next
  // deploy (its plan is then `recorded`), harmlessly, for the same reason.
  const s3Inputs = {
    bucket: s3Config.bucket,
    backupsBucket: backupsPlan.bucket,
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
  // Each bucket is asked in the region the step recorded for it: HeadBucket
  // answers 404 for a bucket that lives in another region, so asking all
  // three at the requested region re-ran this step on every deploy of an env
  // whose backups or state bucket lives elsewhere. No recorded result (or one
  // without a region or a backups target) means nothing to check against:
  // run the step. The backups bucket is the one the step settled on.
  const verifyBucketsExist = async () => {
    const r = state.getStepResult('s3-setup');
    if (!r?.region || !r.backups?.bucket) return false;
    const at = (region) => s3Provider.forRegion(region);
    const [app, backup, stateB] = await Promise.all([
      at(r.region).bucketExists(s3Config.bucket),
      at(r.backups.region).bucketExists(r.backups.bucket),
      at(r.stateBucketRegion ?? r.region).bucketExists(stateBucket),
    ]);
    return app && backup && stateB;
  };
  // Spinner: on a resumed deploy the three bucketExists HEAD probes are the
  // only work here, but they're still network round-trips — cover them so the
  // resume path doesn't sit on a bare cursor.
  // A pasted app key this deploy replaced (set below): the skeleton save adds
  // it to the project's retiredAppKeys.
  let retiredAppKey = null;
  // This deploy's attempt id (services/addon-start.js): saved with the
  // skeleton, never cleared, and handed to reconcile.sh's environment so the
  // add-on job's status file names it.
  const attemptId = mintAttemptId();
  // The one version set this deploy runs: read from the channel here, once,
  // before anything renders a ref, so both sides of an HA pair get it. Saved
  // with the skeleton: restore, failover and scale run what this recorded, and
  // an existing cluster keeps its Kubernetes set on the next deploy. Never
  // blocks or fails the deploy (src/lib/version-channel.js).
  const imageSet = await resolveDeployImageSet({
    envConfig,
    k8s: isK8sTier(tier),
    note: (line) => p.log.info(line),
  });
  const saveSkeletonEnv = () => {
    const written = updateProjectConfig((onDisk) => {
      const existingEnv = onDisk.environments?.[environment] ?? {};
      const skeletonEnv = {
        ...existingEnv,
        envName: environment,
        status: 'deploying',
        deployMode,
        provider: config.provider,
        region,
        ...(secondaryRegion ? { secondaryRegion } : {}),
        // The sizes this deploy picked, recorded before any remote work so a
        // rerun of a deploy that fails later builds the same servers instead
        // of re-picking from a catalog whose prices may have moved (the
        // prompts take a recorded type over the role default). Compose is one
        // host (`serverType`); k8s records each role, as the final save does.
        ...(deployMode === 'kubernetes'
          ? {
              ...(masterServerType ? { masterServerType } : {}),
              ...(dbServerType ? { dbServerType } : {}),
              ...(workerServerType ? { workerServerType } : {}),
            }
          : serverType
            ? { serverType }
            : {}),
        ...(domain ? { domain } : {}),
        ...(dnsProvider ? { dnsProvider } : {}),
        s3: envS3Record(s3Config, existingEnv.s3),
        // The settled backups target once s3-setup ran. Before that, the
        // environment's own record: the one on disk, else the one this deploy
        // was seeded with (a rebuild of a destroyed environment, whose live
        // entry does not exist yet). Without the seed's, a run that dies in
        // s3-setup leaves a live skeleton with no record, the retry's seed is
        // that skeleton, and the chooser (which never counts the env's own
        // destroyed record) picks a new bucket where restore finds nothing.
        // Carried as written (backupsRecordOf), so an old record's stand-in
        // region stays a stand-in. None for a new environment.
        backupS3: backupS3Config
          ? {
              bucket: backupS3Config.bucket,
              region: backupS3Config.region,
              endpoint: backupS3Config.endpoint,
            }
          : (backupsRecordOf(existingEnv) ?? backupsRecordOf(envConfig) ?? undefined),
        ...(deployMode === 'compose-ha' || (deployMode === 'kubernetes' && secondaryRegion)
          ? {
              ha: {
                ...(existingEnv.ha ?? {}),
                enabled: true,
                ...(secondaryRegion ? { failoverRegion: secondaryRegion } : {}),
                // k8s-ha: the standby's resolved types, so a rerun of a deploy
                // that fails later places the same standby (the fan-out keeps
                // a recorded type). A worker with nothing stocked is not
                // recorded; the fan-out falls back and says so.
                ...(deployMode === 'compose-ha'
                  ? pendingStandbyRecord(secondaryRegion, gatheredConfig.standbyServerTypes)
                  : standbyTypesRecord(existingEnv.ha, gatheredConfig.standbyServerTypes)),
              },
            }
          : {}),
        imageSet,
        lastAttempt: new Date().toISOString(),
        lastAttemptId: attemptId,
      };
      onDisk.environments = onDisk.environments ?? {};
      onDisk.environments[environment] = preserveSafetyFields(existingEnv, skeletonEnv);
      if (retiredAppKey) {
        onDisk.retiredAppKeys = [...new Set([...(onDisk.retiredAppKeys ?? []), retiredAppKey])];
      }
    });
    // The rest of this run reads the in-memory copy: keep it on what was written.
    projectConfig.environments = projectConfig.environments ?? {};
    projectConfig.environments[environment] = written.environments[environment];
    if (written.retiredAppKeys) projectConfig.retiredAppKeys = written.retiredAppKeys;
  };
  // FIRST skeleton save BEFORE any S3 work: bucket creation itself mutates
  // provider state (and can partially succeed), and a failure inside s3-setup
  // used to exit before the post-s3 skeleton save ever ran — leaving an env
  // entry with NO deployMode, which crashed `vibecarbon destroy` at planning
  // ("Unknown deployMode: undefined", DO run 32670715722) so teardown never
  // ran at all. Region/endpoint fields may still be provisional here; the
  // post-s3 call re-persists the corrected values.
  //
  // Before it: the `deploy -restore` refusals that need nothing remote (k8s
  // tiers only; a completed deploy on record means a database already runs).
  // The base itself is resolved after s3-setup, below.
  try {
    assertDeployRestoreAllowed({
      restore: args.restore,
      k8s: isK8sTier(tier),
      environment,
      deployedAt: envConfig?.deployedAt ?? null,
    });
  } catch (err) {
    p.log.error(`deploy -restore: ${err.message}`);
    process.exit(1);
  }
  saveSkeletonEnv();

  const s3SetupTimer = perfTimer('deploy.preamble.s3Setup');
  s3Spinner.start('Verifying S3 buckets');
  const skipS3Setup = await state.shouldSkipWithVerify('s3-setup', s3Inputs, verifyBucketsExist);
  // Read from this run's CreateBucket, never from the step ledger: a warm
  // deploy restores that ledger and must not count as a new bucket.
  let stateBucketCreated = false;
  s3Spinner.stop(skipS3Setup ? 'S3 buckets ready' : 'S3 setup needed');
  if (!skipS3Setup) {
    state.startStep('s3-setup', s3Inputs);
    try {
      s3Spinner.start(`Creating S3 bucket: ${s3Config.bucket}`);
      // The rule goes on before anything reads the new bucket (createBucket says
      // why), so this writes without looking: a new bucket has no rule to
      // compare. A failure here stays quiet: the finalize step below reads the
      // rule, writes it if it is missing, and reports what still fails.
      const beforeFirstRead = () =>
        s3Provider
          .setBucketCors(s3Config.bucket, envCorsOrigins(domain), { untilVisibleMs: 15_000 })
          .catch(() => {});
      const app = await s3Provider.createBucket(s3Config.bucket, { beforeFirstRead });
      assertBucketReady(app, 'App storage');
      s3Spinner.stop(
        app.created
          ? `S3 bucket created: ${s3Config.bucket}`
          : `S3 bucket exists: ${s3Config.bucket}`,
      );
      // Each bucket's region comes from its own create, never from the shared
      // client, which never moves (S3CompatibleProvider.forRegion).
      if (app.region !== s3Config.region) {
        // An env an older CLI recorded under another bucket's region is
        // repaired here: its uploads follow where its bucket really is.
        p.log.info(
          `${s3Config.bucket} lives in ${app.region}, not ${s3Config.region}, so ${environment} now records ${app.region} for its uploads`,
        );
      }

      // No try/catch here: a backup bucket that failed to create used to be
      // logged and skipped, and the deploy then died at wal-g's audit after
      // the VPS existed. The step's catch below reports and exits before
      // anything is provisioned.
      // Each create runs under its own spinner lines, naming the bucket it
      // creates, so the settle's one line (a switch to the region's own name)
      // never lands on a running spinner.
      const settled = await settleBackupsBucket({
        plan: backupsPlan,
        appRegion: app.region,
        environment,
        projectConfig: loadProjectConfig() ?? projectConfig,
        rechoose: (region) =>
          chooseBackupsBucket({
            environment,
            envConfig,
            projectConfig: loadProjectConfig() ?? projectConfig,
            region,
          }),
        create: async (bucket, region) => {
          s3Spinner.start(`Creating backup bucket: ${bucket}`);
          const res = await s3Provider.forRegion(region).createBucket(bucket);
          assertBucketReady(res, 'Backup');
          s3Spinner.stop(
            res.created ? `Backup bucket created: ${bucket}` : `Backup bucket exists: ${bucket}`,
          );
          return res;
        },
        log: (line) => p.log.info(line),
      });
      if (settled.created && settled.source === 'region') {
        p.log.info(
          `${environment} is the first environment with storage in ${settled.target.region}, so its backups get their own bucket there: ${settled.target.bucket}`,
        );
      }
      // Only the environment's own record can put earlier backups in another
      // region than its uploads; any other bucket answering from elsewhere has
      // none of this environment's backups yet, so the line would be untrue.
      if (settled.source === 'recorded' && settled.target.region !== app.region) {
        p.log.info(
          `${environment}'s backups stay in ${settled.target.bucket} (${settled.target.region}), where its earlier backups are; its uploads are in ${app.region}`,
        );
      }
      // Said once: from this deploy on, the bucket is on record.
      if (settled.source === 'adopted') {
        p.log.info(
          `${environment} has no backups record from an older vibecarbon, so its backups stay in ${settled.target.bucket} (${settled.target.region}), where its earlier backups are, and this deploy records it`,
        );
      }

      // Dedicated Pulumi-state bucket. Created imperatively (like the app +
      // backup buckets) BEFORE any Pulumi stack op. NOT
      // web-facing: no CORS, not public.
      // A state bucket the environment has on record is asked in the region
      // recorded for it, so a redeploy finds it with one HEAD there instead of
      // a CreateBucket from the requested region (answered BucketAlreadyExists,
      // then a search). A new one is created at the requested region, through
      // the same client as always (forRegion of its own region is itself).
      const recordedS3 = envConfig.s3;
      const stateRegion =
        recordedS3?.stateBucket === stateBucket && recordedS3?.stateBucketRegion
          ? recordedS3.stateBucketRegion
          : s3Config.region;
      s3Spinner.start(`Creating Pulumi state bucket: ${stateBucket}`);
      const stateBucketResult = await s3Provider.forRegion(stateRegion).createBucket(stateBucket);
      assertBucketReady(stateBucketResult, 'Pulumi state');
      stateBucketCreated = stateBucketResult.created;
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
      // Each bucket is read in its own region: a LIST of a bucket from another
      // region answers NoSuchBucket, which reads as "no state" and would send
      // a seeded state bucket down the migration below.
      const stateStore = s3Provider.forRegion(stateBucketResult.region);
      const appStore = s3Provider.forRegion(app.region);
      // Determine whether there is GENUINE legacy state to migrate. The check
      // lists the just-created state bucket, which can race S3 list-after-create
      // consistency and throw — that is NOT the orphan-risk case (a fresh deploy
      // has no legacy state), so a check failure must NOT hard-abort. Only a
      // CONFIRMED legacy-state copy failure aborts (below). Retry the checks a
      // few times so a transient blip doesn't misfire either way.
      // Nested inside deploy.preamble.s3Setup (not a serial marker of its own).
      const stateSeedTimer = perfTimer('deploy.preamble.s3Setup.stateSeed');
      let legacyState = false;
      let checkOk = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const stateSeeded = await stateStore.hasObjectsWithPrefix(
            stateBucket,
            PULUMI_STATE_PREFIX,
          );
          legacyState = stateSeeded
            ? false
            : await appStore.hasObjectsWithPrefix(s3Config.bucket, LEGACY_STATE_PREFIX);
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
          const { copied } = await stateStore.copyPrefix(
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
      stateSeedTimer.end();

      const result = {
        // Where the app (uploads) bucket lives, from its own create.
        region: app.region,
        endpoint: app.endpoint,
        stateBucket,
        // Where the STATE bucket lives, from its own create: a retained state
        // bucket can live in another region, and the Pulumi backend URL must
        // follow it there.
        stateBucketRegion: stateBucketResult.region,
        // The matching HOST — region-scoped stores only serve a bucket at
        // its own region's endpoint, so the backend URL needs this, not
        // just the region param (2026-08-28: cross-region e4 404'd on it).
        stateEndpoint: stateBucketResult.endpoint,
        // The backups bucket this step settled on, its region and endpoint
        // from its own create: a recorded backups bucket can live in another
        // region than the uploads bucket.
        backups: settled.target,
      };
      if (stateBucketResult.region !== app.region) {
        p.log.warn(
          `Pulumi state bucket ${stateBucket} lives in ${stateBucketResult.region}; the app ` +
            `bucket stays in ${app.region}. State ops will target ${stateBucketResult.region}.`,
        );
      }
      state.completeStep('s3-setup', result);
    } catch (error) {
      // One readable line on the terminal (cause, endpoint, key source); the
      // full error goes to the deploy log only. The log is written
      // synchronously, so the process.exit below cannot drop this line.
      s3Spinner.stop(
        formatS3SetupFailure(error, {
          endpoint: s3Provider.getEndpoint(),
          source: gatheredConfig.s3CredentialSource,
        }),
        1,
      );
      writeLogDetail(`# s3-setup error detail: ${error?.stack || error}`);
      process.exit(1);
    }
  }
  s3SetupTimer.end();

  // Apply resolved S3 values from state
  const s3Result = state.getStepResult('s3-setup');
  if (s3Result) {
    s3Config.region = s3Result.region;
    s3Config.endpoint = s3Result.endpoint;
    // May differ from region when a retained state bucket lives elsewhere;
    // resolveBackendUrl prefers it for the Pulumi backend URL only.
    s3Config.stateBucketRegion = s3Result.stateBucketRegion ?? s3Result.region;
    // Absent on step-state cached before the field existed — resolveBackendUrl
    // then derives the host from stateBucketRegion.
    s3Config.stateEndpoint = s3Result.stateEndpoint;
    // The backups bucket the step settled on. Always present: the inputs
    // key rename re-runs the step for a result recorded without it, and the
    // verify probe refuses to skip one.
    backupS3Config = s3Result.backups ?? null;
  }
  // Always resolve stateBucket (deterministic derivation) so the Pulumi
  // backend targets the dedicated bucket, whether s3-setup ran or was skipped.
  // Every downstream iac call reads it via s3Config, and it's persisted into
  // .vibecarbon.json so scale / failover / destroy resolve the same backend.
  s3Config.stateBucket = s3Result?.stateBucket || stateBucket;
  // Record the settled buckets now, before anything below can exit (the
  // `deploy -restore` resolution, the app key mint): the backups record then
  // names a bucket that exists, and the next deploy keeps it.
  saveSkeletonEnv();
  // The HA plans open a backend this run brought into being, once, before the
  // pair starts (open-state-backend). Any other deploy has nothing to open.
  const newStateBackend = stateBucketCreated
    ? {
        provider: providerIdFor(envConfig),
        s3Config,
        projectName: projectConfig.projectName,
      }
    : null;

  // DR (`deploy -restore latest|<base>|<ISO-8601>`, k8s tiers): resolve the
  // exact base backup now, from the stop sentinels in the bucket and prefix
  // the db pod's wal-g reads, before anything is minted or provisioned. No
  // base satisfying the point stops the deploy here (C5: one resolver; the
  // deploy only checks the object it is handed).
  let restorePoint = null;
  try {
    restorePoint = await perfAsync('deploy.preamble.restorePoint', () =>
      resolveDeployRestorePoint({
        restore: args.restore,
        k8s: isK8sTier(tier),
        // The lineage the base comes from: -lineage, or the record the destroyed
        // environment left (envConfig.backup survives a destroy).
        envConfig,
        lineage: args.lineage,
        // The settled backups bucket, at its own region and endpoint.
        backup: backupStorageConfig(s3Config, backupS3Config),
        credentialVars: backupCredentialVars(envConfig),
      }),
    );
  } catch (err) {
    p.log.error(`deploy -restore: ${err.message}`);
    writeLogDetail(`# deploy -restore error detail: ${err?.stack || err}`);
    process.exit(1);
  }
  if (restorePoint) {
    p.log.info(
      `restoring ${restorePoint.backup} (${restorePoint.target === 'latest' ? 'all WAL' : `to ${restorePoint.target}`}) into the new database`,
    );
  }

  // The app's own object-storage key (security plan R2, R9), resolved once
  // the env bucket is ensured, on EVERY deploy (the s3-setup step above is
  // skipped on a warm redeploy, but a missing local secret still needs a
  // mint). The infra pair stays in s3Config for the buckets, CORS, Pulumi and
  // WAL-G; the app gets `appCredential`. A failed mint fails here, before
  // anything is provisioned, and never falls back to the infra key.
  const storageProviderId = providerIdFor(envConfig);
  let appStorage;
  try {
    appStorage = await perfAsync('deploy.preamble.appStorageCredential', () =>
      resolveAppStorageCredential({
        provider: storageProviderId,
        environment,
        envConfig,
        projectConfig,
        bucket: s3Config.bucket,
        infraCredential: {
          accessKey: s3Config.accessKey,
          secretKey: s3Config.secretKey,
          endpoint: s3Config.endpoint,
        },
        secrets: localAppStorageSecrets(),
        apiToken,
      }),
    );
  } catch (err) {
    p.log.error(`App storage key: ${err.message}`);
    writeLogDetail(`# app storage key error detail: ${err?.stack || err}`);
    process.exit(1);
  }
  s3Config.appCredential = { accessKey: appStorage.accessKey, secretKey: appStorage.secretKey };
  s3Config.appKey = appStorage.record;
  // A replaced pasted key stays denied in every fence until the operator
  // forgets it (the CLI cannot revoke a key it did not make).
  if (appStorage.retire) {
    retiredAppKey = appStorage.retire;
    projectConfig.retiredAppKeys = [
      ...new Set([...(projectConfig.retiredAppKeys ?? []), appStorage.retire]),
    ];
  }
  p.log.info(`storage access: ${appStorage.tier} (${appStorage.reason})`);
  if (appStorage.tier === 'shared' && appStorage.scoping === 'paste-fence') {
    p.log.info(
      `the app shares the deploy key; give it its own with \`vibecarbon configure storage ${environment}\``,
    );
  }
  // Record the key right away: destroy revokes what is recorded.
  saveSkeletonEnv();
  const priorAppKey = envConfig.s3?.appKey;
  const fenceNeeded =
    appStorage.record?.scoping === 'paste-fence' ||
    priorAppKey?.scoping === 'paste-fence' ||
    (projectConfig.retiredAppKeys ?? []).length > 0 ||
    Object.values(projectConfig.environments ?? {}).some(
      (e) => e?.s3?.appKey?.scoping === 'paste-fence',
    );
  const appStorageClient = (accessKey, secretKey) =>
    getObjectStorageProvider(storageProviderId, accessKey, secretKey, s3Config.region);

  // Browser uploads need CORS on the app bucket. Outside the s3-setup step on
  // purpose: that step is skipped on re-run, and existing deployments must
  // still pick the rule up. Started here, not awaited: provisioning does not
  // depend on it, so it runs beside IaC and is awaited before the outro (R7).
  const appBucketFinalize = startAppBucketFinalize({
    providerId: providerIdFor(envConfig),
    createProvider: () =>
      getObjectStorageProvider(
        providerIdFor(envConfig),
        s3Config.accessKey,
        s3Config.secretKey,
        s3Config.region,
      ),
    bucket: s3Config.bucket,
    domain,
    ...(appStorage.record && {
      createAppProvider: () =>
        appStorageClient(s3Config.appCredential.accessKey, s3Config.appCredential.secretKey),
    }),
    ...(fenceNeeded && {
      fence: () =>
        syncHetznerFences({
          projectConfig,
          environment,
          s3: s3Provider,
          secrets: localAppStorageSecrets(),
          createProbe: appStorageClient,
        }),
    }),
  });

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

  // A killed earlier run leaves its host-side delta work dir (a full image
  // save) in the temp dir: clear those before this run makes its own.
  const { sweepStaleDeltaDirs } = await import('./layer-delta.js');
  sweepStaleDeltaDirs();

  // --- STEP 2: Image Resolve ---
  // resolveBuildMode (ci-setup.js) returns one of — see also transferImage
  // in effects/index.js, which must stay in sync with these descriptions:
  //   'local'  — build the app image on the operator's machine. Compose
  //              sends it by layer delta (deliverImage): the server pulls the
  //              runtime base itself and only the app's own layers cross the
  //              wire. The compose default when local docker is present (the
  //              build runs in parallel behind VPS provisioning); also the
  //              k8s/k3s path (deployK3s builds, delivers the delta to the
  //              master's registry and applies manifests inline).
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
    // The build (compose/app-image.js) is silent so BuildKit progress doesn't
    // interleave with the upStack spinner; a failure carries docker's last
    // lines. It passes the VITE_* build args (Vite inlines them into the
    // browser bundle) and pins amd64 (an Apple Silicon operator once shipped
    // arm64 to an amd64 VPS; vibecarbon is x86-64 only, see platform.js).
    // compose delivers it to its server, compose-ha to both, by layer delta.
    const { buildComposeAppImage } = await import('./compose/app-image.js');
    composeLocalBuildPromise = perfAsync('deploy.image.localBuild', () =>
      buildComposeAppImage({ tag: localImageTag, projectName: projectConfig.projectName, domain }),
    );
    // Awaited by the image transfer; this keeps a build that fails while
    // provisioning still runs from being an unhandled rejection first.
    composeLocalBuildPromise.catch(() => {});
    imageReadyPromise = Promise.resolve({
      imageTag: localImageTag,
      githubOwner: 'noop',
      repoName: projectConfig.projectName,
      ghcrPullCreds: null,
      isLocal: true,
    });
  } else if (buildMode === 'local') {
    // K8s 'local' build mode: deployK3s handles the build + delivery +
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
    // Without this the GHCR image ships empty client config (VITE_PUBLIC_URL,
    // feature flags). Mirrors the compose-local build-args path above.
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

  // --- STEP 3: The deploy bundle (compose tiers) ---
  // What a compose server gets (bundle.js): the compose files and scripts, and
  // the .env and app.env with every secret the app runs on. Rendered here,
  // before the DNS warm-up (STEP 4) and the pending-server repair, so a render
  // that fails (a full /tmp, an unreadable project file, a value no .env can
  // hold) stops the deploy before anything outside this machine changes. Its
  // one reader is the compose plan's setup-server-files step, and k8s never
  // reads it, so the k8s tiers render none. The try below owns it: removed
  // once the dispatch settles, whatever the outcome (a Ctrl-C leaves it to the
  // exit sweep, temp-dir.js). renderBundle is sync, typically ~50-300 ms.
  // verbose=false: per-file `[bundle] Copying X` lines bypass the clack
  // gutter and print flush-left, breaking the visual flow. Bundle content
  // is reproducible from the project tree; debug it by re-running with
  // VIBECARBON_PERF=1 + VIBECARBON_BUNDLE_VERBOSE=1 if needed.
  const bundleOptions = {
    domain,
    environment,
    image: imageRef,
    observability: services.observability,
    n8n: services.n8n,
    metabase: services.metabase,
    redis: services.redis,
    s3: s3Config,
    // wal-g and the TLS snapshot on the server reach the backups bucket at
    // its own region and endpoint (the bundle's `.env`); the app keeps the
    // uploads bucket's (`app.env`).
    backupTarget: backupS3Config,
    // Where the server saves its TLS certificate after every base backup
    // (backup/tls-snapshot.sh): the env backup folder, per CA, the same CA
    // verifyTlsReady records. No backup bucket: no snapshot.
    tlsSnapshotPrefix: backupS3Config?.bucket
      ? tlsSnapshotS3Prefix({
          backupBucket: backupS3Config.bucket,
          projectName: projectConfig.projectName,
          envName: environment,
          ca: caSlug(readOperatorVar('ACME_CA_SERVER').value ?? ''),
        })
      : '',
    verbose: process.env.VIBECARBON_BUNDLE_VERBOSE === '1',
  };
  let bundlePath = null;
  if (isComposeTier(tier)) {
    const bundleRenderTimer = perfTimer('deploy.bundle.pack');
    bundlePath = renderBundle(projectConfig.projectName, bundleOptions);
    bundleRenderTimer.end();
  }

  let deployResult;
  // Where this run's managed-DNS writer has the domain's records and since
  // when ({target, changedAt}, k8s tiers): read by the release of a retired
  // DigitalOcean reserved IP below. Null when the records are kept by hand.
  let dnsWrite = null;
  // Single k8s's A record writer (set in the dispatch below, finished after it).
  let k8sDns = null;
  try {
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
              if (result?.success === false) {
                // Best-effort: the real-IP write below is the one that must land.
                p.log.warn(`Initial DNS setup failed: ${result.error}`);
                return null;
              }
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
    //
    // Each side also carries its recorded master/db types (and the standby its
    // worker, from ha.standbyWorkerSpec), with or without a stack: the fan-out
    // keeps them, so a redeploy never resizes or refuses an existing env
    // (src/lib/deploy/standby-types.js haStacksFrom).
    const haStacks = haStacksFrom(envConfig);
    const deploymentConfig = {
      projectName: projectConfig.projectName,
      environment: config.environment,
      provider: config.provider,
      region,
      secondaryRegion,
      masterServerType,
      dbServerType,
      workerServerType,
      serverType,
      minWorkers,
      maxWorkers,
      domain,
      ha: config.ha,
      haStacks,
      // `deploy -server-type` given: new sizes for both clusters, so the
      // standby's recorded types give way (k8s-ha fan-out).
      serverTypeRequested: !!args.serverType,
      // A first-deploy rerun with a different -standby-region: the standby's
      // recorded types were resolved for the old location and give way too.
      standbyRetargeted: !!gatheredConfig.standbyRetargeted,
      observability: config.observability,
      services,
      apiToken,
      dnsZoneId,
      dnsToken,
      dnsProvider,
      s3Config,
      backupConfig,
      // The backups bucket with its region and endpoint: wal-g's prefix,
      // endpoint and region in the db StatefulSet, the infra Secret's bucket,
      // the TLS restore's read. Both k8s-ha clusters take it from these options.
      backupTarget: backupS3Config,
      // DR: the resolved restore point (above), or null. deployK3s writes its
      // marker before the db applies, so the db pod's walg-restore init fetches
      // that backup; the restored DB carries its migration ledger, so the app's
      // migrate init container applies only what the backup lacks.
      restore: restorePoint,
      // The environment as the operator names it: HA clusters deploy under their
      // stack names, and the commands an error prints must use this one.
      operatorEnv: environment,
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
      // The backups bucket: compose-ha's replication and both compose tiers'
      // restore-tls / snapshot-tls read it.
      backupS3Config,
      imageRef,
      bundlePath,
      ciReady,
      s3Config,
      state,
      dnsWarmupPromise,
      isDirectDeploy,
      isComposeLocal,
      localImageTag,
      composeLocalBuildPromise,
      newStateBackend,
      attemptId,
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

    // A compose scale replaced a server outside Pulumi and could not point the
    // stack at the new one (or was killed before it did): repair that state
    // before any Pulumi `up`, whose refresh would otherwise drop the deleted
    // server and build a second one. Refuses the deploy when it cannot.
    if (isComposeTier(tier) && envConfig?.pendingServerState?.length) {
      const { repairPendingServerState } = await import('./compose/server-state-sync.js');
      await repairPendingServerState({
        environment,
        envConfig,
        options: {
          provider: providerIdFor(envConfig),
          providerToken: apiToken,
          s3Config,
          projectName: projectConfig.projectName,
        },
      });
    }

    // Single k8s's A record (k8s/dns-record.js): started from deployK3s's
    // onInfraReady, finished by the post-deploy block below. Single k8s only.
    // A k8s-ha deploy's records have one writer, its plan's update-dns step
    // (effects/k8s-ha.js, the provider's setupHA), and a second, single-cluster
    // write after it would replace the HA records with setupSimple's while the
    // first certificate may still be issuing. Compose never touches the k8s engine.
    k8sDns =
      tier === 'k8s'
        ? (await import('./k8s/index.js')).createK8sDnsWriter({
            domain,
            dnsProvider,
            dnsToken,
            dnsZoneId,
            state,
            dnsWarmupPromise,
            getDnsProvider,
            // Single k8s: the record's target is on disk before the record points
            // at it, so destroy owns it if the deploy fails (the final save
            // writes the same ingressIp). The cluster's floating IP, where it
            // has one, is recorded beside it, never a master's own address:
            // destroy releases a recorded floatingIp by address. k8s-ha
            // persists per cluster instead.
            persistOwnedIp:
              tier === 'k8s'
                ? ({ ingressIp, floatingIp }) =>
                    updateProjectConfig((onDisk) => {
                      const env = onDisk.environments?.[environment];
                      if (!env) return;
                      env.ingressIp = ingressIp;
                      if (floatingIp) env.floatingIp = floatingIp;
                    })
                : null,
          })
        : null;

    if (tier === 'compose') {
      // Compose (single, non-HA) runs through the pure step-plan + effect
      // registry (planDeploy → runPlan → EFFECTS), which REPLACES the former
      // inlined deployComposeSingle block. The plan's steps carry the exact
      // operations, order, args, state-gating and conditionals the inline path
      // ran; ctx threads the mutable server identity the effects fill in
      // (serverIp / providerServerId / providerServerName) and the orchestrator
      // reads back into the single-server deployResult shape below.
      const sshKeyPath = sshKeyPathFor(environment);
      // Single-node compose: its one server, whichever record resolvePrimary names.
      const composeServer = resolvePrimary(envConfig, { env: environment })?.entry;
      const composeCtx = {
        ...deployCtx,
        sshKeyPath,
        // Seed the mutable server identity from any prior deploy so the warm
        // path (`when: !ctx.serverIp || !ctx.stateSealed`) skips provisioning.
        // provisionServer sets these on a fresh deploy.
        serverIp: composeServer?.ip || null,
        // Whether the ledger marks the stack sealed; until it does, the warm
        // path runs the up once more for the seal (lib/iac/state-seal.js).
        stateSealed: stateSealRecorded(state, environment),
        providerServerId: composeServer?.id || null,
        providerServerName: composeServer?.providerServerName || null,
        providerFirewallId: composeServer?.firewallId || null,
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
        // The verify-tls verdict (trusted or pending), persisted as envConfig.tls.
        ...(composeCtx.tlsState && { tls: composeCtx.tlsState }),
      };
    } else if (tier === 'compose-ha') {
      // Compose-HA runs through the same pure step-plan + effect registry as
      // single compose (planDeploy → runPlan → EFFECTS), REPLACING the former
      // deployComposeHA orchestration. The plan's steps carry the exact
      // operations, order, args, fan-out, perf labels and warn/throw semantics
      // deployComposeHA ran over the primary+standby pair; ctx threads the
      // mutable two-node identity the effects fill in (primary/standby/degraded)
      // and the orchestrator reads back into the HA deployResult shape below.
      const sshKeyPath = sshKeyPathFor(environment);
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
        // `deploy -server-type` given: that type applies to both stacks; without
        // it each keeps its server's recorded type (a scale may have changed one).
        serverTypeRequested: !!args.serverType,
        secondaryRegion: secondaryRegion || undefined,
        // Docker Hub + GHCR creds gate the HA login fan-out; loaded here so the
        // effects stay pure of credential I/O (mirrors the single-compose ctx).
        dockerHubCreds: resolveDockerHubCreds(),
        ghcrPullCreds: ciReady.ghcrPullCreds,
        // Finding #1: hard-gate replication unless the operator opts into a
        // warm/degraded standby via `deploy -allow-degraded`.
        allowDegraded: !!args.allowDegraded,
        // Role mapping on a failed-over pair (null otherwise): the effects resolve
        // ctx.primary / ctx.standby by role and keep each node's stack.
        reconverge: composeHaReconverge,
        onProgress: (msg) => s.message(msg),
      };
      // Wrap the entire pipeline so the perf trace shows the headline cost
      // (which contains the deploy.ha.compose.* sub-stages from the effects).
      // The bundle is removed after the dispatch (the finally below): the setup
      // fan uploads it to both nodes and settles only after both uploads have
      // (haSetupServerFiles), so no upload still reads it then.
      await perfAsync('deploy.ha.compose.full', () =>
        runPlan(planDeploy('compose-ha', config), composeHaCtx, EFFECTS),
      );
      s.stop('Compose HA deployment complete');
      // A reconverge that did not verify streaming and record the identifier
      // stays degraded and keeps its last deployedAt (haFinalizeConfig), so the
      // next deploy resumes it.
      const reconvergeIncomplete = !!composeHaCtx.reconverge && !composeHaCtx.reconvergeComplete;
      const haDegraded = !!composeHaCtx.degraded || reconvergeIncomplete;
      deployResult = {
        success: true,
        primaryIp: composeHaCtx.primary.ip,
        standbyIp: composeHaCtx.standby.ip,
        domain,
        deployMode: 'compose-ha',
        degraded: haDegraded,
        replication: haDegraded ? 'degraded' : 'streaming',
        // haSeedRecord persists the identifier only when streaming was verified.
        replicationStatus: composeHaCtx.replActive && !haDegraded ? 'streaming' : 'degraded',
        systemIdentifier: composeHaCtx.systemIdentifier ?? null,
        reconvergeIncomplete,
        ...(composeHaCtx.tlsState && { tls: composeHaCtx.tlsState }),
      };
    } else if (tier === 'k8s') {
      // Single-cluster k3s runs through the plan as a single black-box step that
      // wraps deployK3s (preserving its `deploy.k3s.full` perf span). ctx carries
      // the deploymentConfig deployK3s consumes UNCHANGED under ctx.options; the
      // effect fills ctx.clusterResult, which is deployK3s's return read back into
      // the single-cluster deployResult the post-dispatch k8s block expects.
      // One addition: onInfraReady starts the domain's A record write the moment
      // the cluster's addresses exist (k8s/dns-record.js), so it overlaps the
      // image delivery and manifest apply. k8s-ha's fan-out owns its own hook.
      const k8sCtx = { options: { ...deploymentConfig, onInfraReady: k8sDns.onInfraReady } };
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
      // dnsWarmupPromise: the early HA DNS write (haK8sProvisionClusters) must
      // not race the 0.0.0.0 warm-up write of the same apex record.
      const k8sHaCtx = { options: deploymentConfig, dnsWarmupPromise, newStateBackend };
      await perfAsync('deploy.ha.k8s.full', () =>
        runPlan(planDeploy('k8s-ha', config), k8sHaCtx, EFFECTS),
      );
      dnsWrite = k8sHaCtx.dnsWrite ?? null;
      // The retired cluster is the standby this deploy just rebuilt and gated on
      // streaming (or finalized degraded under -allow-degraded): this deploy
      // stamps deployedAt, so the fence comes off here, before that save. A
      // marker left behind would make it refuse its own backups once a later
      // failover promotes it, so a failed clear fails the deploy (the env stays
      // swapped and the rerun clears it).
      const retiredFence = await finishK8sRetiredFence({
        retiredAtEntry,
        standbyIp: k8sHaCtx.standbyResult?.masterIp,
        projectName: projectConfig.projectName,
        environment,
      });
      // The backup-prefix fence follows the role primary (backup-fence.js): a
      // reconverge, an aborted failover or a recreated database moves it along.
      const fencePrimaryIp = k8sHaCtx.primaryResult?.masterIp;
      if (fencePrimaryIp) {
        const fence = await writeK8sBackupFence({
          ip: fencePrimaryIp,
          sshKeyPath: sshKeyPathFor(environment),
        });
        if (!fence.ok) p.log.warn(backupFenceWarning(fencePrimaryIp, fence.reason));
        recordBackupFence({ environment }, fence);
      }
      deployResult = {
        primary: k8sHaCtx.primaryResult,
        standby: k8sHaCtx.standbyResult,
        domain,
        replicationStatus: k8sHaCtx.replicationStatus,
        ...k8sHaDegradedVerdict(k8sHaCtx),
        systemIdentifier: k8sHaCtx.systemIdentifier ?? null,
        // A retired side that is not a replica yet keeps its fence: deployedAt
        // stays unstamped, so the env stays swapped and the next deploy retries.
        reconvergeIncomplete: retiredFence.kept,
      };
    }
  } finally {
    // Every reader of the bundle ran in the compose plans above.
    if (bundlePath) removeTempDir(bundlePath);
  }

  // Defence in depth (write-fence.js): after bring-up the role primary must take
  // writes. Fenced with no failover in flight is lifted with a warning; with a
  // journal, the failover is mid-flight and this deploy refuses.
  if (isHaTier(tier) || isComposeTier(tier)) {
    const primaryIp = deployedPrimaryIp(tier, deployResult);
    if (primaryIp) {
      const writable = await assertRolePrimaryWritable({
        environment,
        envConfig: loadProjectConfig()?.environments?.[environment] ?? envConfig,
        exec: await rolePrimaryPsql(tier, environment, projectConfig.projectName, primaryIp),
        warn: (line) => p.log.warn(line),
      });
      if (writable === 'unknown') {
        p.log.warn(
          `could not read the primary's write-fence setting (${primaryIp}); ` +
            'vibecarbon status shows it once the database answers',
        );
      }
    }
  }

  if (isK8sTier(tier)) {
    {
      const kubeconfigPath = localKubeconfigPath(process.cwd(), environment);
      const masterIp = deployResult.primary?.masterIp || deployResult.masterIp;
      p.log.success('Local-first deploy complete. App is delivered + running on the cluster.');
      p.note(
        formatCommandNote([
          `Kubeconfig:  ${kubeconfigPath}`,
          `Master IP:   ${masterIp ?? '(unknown: check Pulumi output)'}`,
          '',
          'Next steps:',
          `  vibecarbon shell ${environment}    # bash with KUBECONFIG set`,
          `  vibecarbon diagnose ${environment} # full cluster state dump`,
          `  vibecarbon destroy ${environment}  # tear down when done`,
          '',
          '# To layer in Flux + GitHub Actions:',
          `  vibecarbon configure cicd ${environment}`,
        ]),
        'Cluster + app ready',
      );
      // Fall through to Step 6 so .vibecarbon.json persists the serverlist —
      // without it, `vibecarbon destroy` can't find the master/database IPs
      // and the cluster leaks.
    }

    // --- Post-deploy DNS barrier (single k8s) ---
    // The dnsWarmupPromise (started in Step 4) created records pointing at
    // 0.0.0.0; the probe below needs them at the cluster's real IP, or it
    // resolves to 0.0.0.0 and times out. Single k8s started that write at
    // infra-ready: finish() awaits it (a refusal fails the deploy here) and is
    // then a gated no-op, writing only when nothing did or the IP moved.
    //
    // k8s-ha has no writer here (k8sDns is null): its plan's update-dns step
    // wrote the records through setupHA, at the serving primary, and settled
    // before the plan returned. Compose writes in its own plans. Local-first
    // k3s manages DNS records here rather than via Flux annotations +
    // external-dns.
    if (k8sDns && domain && hasAutomatedDns(dnsProvider)) {
      // The cluster's ingress IP (clusterIngressIp): its floating IP, or on
      // DigitalOcean its master's own address, so a master this run replaced
      // has its record at the new address before the probe below (the early
      // write already set it, or this call does).
      dnsWrite = await k8sDns.finish(deployResult);
    }

    // --- Verifiable success gate for k8s ---
    // The GHA deploy workflow already waits for Flux reconciliation; this
    // extra probe confirms the app is reachable from the public internet
    // (not just healthy inside the cluster). DNS propagation and ingress
    // routing need to land before a user can actually load the URL, and
    // either one failing mid-deploy would leave us exiting 0 while the URL
    // returns 5xx. Certificate issuance is judged separately (the TLS phase
    // below) and never fails the deploy.
    //
    // K8s first-deploy timing on a cold cluster: the DNS warmup record
    // (0.0.0.0) → real IP swap propagates through Cloudflare's edge in 1-3
    // min (TTL=auto = 5 min worst case). Old 10-min budget tripped on the
    // cold tail (observed 2026-04-25 batch run #1, k8s standalone and k8s-ha
    // both failed at the probe). 20 min covers the p99 cold path; warm
    // rollouts still finish in <60s.
    if (domain) {
      const s = spinner();
      s.start(`Probing ${link(`https://${domain}/api/health`)} ...`);
      // Two phases. The APP phase (here) asks whether the app answers from
      // the public internet: DNS propagation and ingress routing roll up
      // here, with TLS verification off so a certificate still being issued
      // cannot hold it (p99 cold k8s-ha = 8-12 min; warm <60s). Its failure
      // is the hard one. The TLS phase (verifyK8sTls, below) then gives the
      // CA one first look with full verification and the ACME watchdog: a
      // miss finishes the deploy with TLS pending instead of failing it.
      const { path: probeKubeconfig } = resolveKubeconfigPath(environment, envConfig);
      const probeResult = await perfAsync('deploy.health.probe', () =>
        probePublicHealth(domain, { timeoutMs: 1_200_000, verifyTls: false }),
      );
      if (probeResult?.ok) {
        s.stop(`App is serving requests (HTTP ${probeResult.status})`);
        deployResult.tls = await verifyK8sTls({
          domain,
          environment,
          projectName: projectConfig.projectName,
          kubeconfig: probeKubeconfig,
          s3Config,
          backupS3Config,
          // k8s: deployK3s's own result; k8s-ha: the primary's (the issuing
          // cluster, whose kubeconfig this phase reads).
          tlsRestoredAt:
            deployResult?.tlsRestoredAt ?? deployResult?.primary?.tlsRestoredAt ?? null,
        });
      } else {
        // Build a concise one-line failure summary as the spinner stop text
        // AND as the first line of the diagnostic dump below. The runner
        // captures the stderr tail as the step's error message; if this
        // line is the most recent error-level emission, the runner's
        // failure attribution will say WHAT went wrong (last status, last
        // network error class) instead of just dumping curl HEAD response
        // headers — which was the 2026-04-27 morning matrix's "[unknown]
        // CSP header dump" failure mode.
        const reason = probeFailureReason(probeResult);
        s.stop(
          `Public health probe failed against ${link(`https://${domain}/api/health`)}; ${reason}`,
        );
        // Capture diagnostics inline so a CI run failure surfaces the
        // root cause without requiring a follow-up `vibecarbon diagnose`.
        // The cluster is about to be destroyed by the test runner; once
        // it's gone, kubectl probes return nothing. We spawn each tool via
        // runCommandAsync (array argv, no shell) — domain and environment come
        // from validated config, but we still avoid shell-string interp.
        try {
          const { path: kubeconfig, candidates: kubeconfigCandidates } = resolveKubeconfigPath(
            environment,
            envConfig,
          );
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
          // ALL namespaces, not just `vibecarbon`: a vibecarbon-only dump
          // cannot show a Certificate elsewhere (a leftover or a user's own)
          // racing ours for the same ACME order, exactly the ambiguity that
          // made the 2026-08-11 e3 post-mortem harder than it needed to be.
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
          // app 503, etc.). curl exits non-zero on connect/TLS errors so we
          // route through safeRun. -k skips cert validation — we want the
          // body even if origin's cert is staging or self-signed. Pinned to
          // the public answer (--resolve), like every probe of the domain:
          // an unpinned curl asks the system resolver, which may hold a stale
          // NXDOMAIN, and caches one more if the record is not there yet.
          const curlPin = await publicCurlResolveArgs(domain);
          const curlVerbose = await safeRun('curl', [
            '-skvI',
            '--max-time',
            '10',
            ...curlPin,
            `https://${domain}/api/health`,
          ]);
          const curlPodIp = await safeRun('curl', [
            '-skv',
            '--max-time',
            '10',
            '--http1.1',
            ...curlPin,
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

  // A DigitalOcean k8s cluster made before 2026-11 still has its reserved IP
  // on record, assigned to the master (every up takes it out of the stack's
  // state, lib/iac/retired-resources.js). Release it by address once the
  // domain's own nameservers no longer answer with it, no A record in a
  // managed zone has it, and the record's TTL has passed since DNS moved,
  // else keep it for a later deploy; with DNS kept by hand, say where to
  // point the records (k8s/retired-reserved-ip.js). After the public probe,
  // which throws on failure; before the save below, which reads the record
  // fresh and so keeps only an address that stayed. A no-op on Hetzner and
  // Linode.
  if (isK8sTier(tier)) {
    const IngressProvider = providerFor(envConfig);
    const ingressProviderId = providerIdFor(envConfig);
    // A warm redeploy skips the up, so the stack can still list the address:
    // the release takes it out first, as every up would, or destroy would
    // fail on an address already gone. Every address the surgery takes out
    // that the stack's record lacks is recorded (createDeployDropRetired).
    const dropRetired = createDeployDropRetired({
      environment,
      providerId: ingressProviderId,
      providerToken: apiToken,
      s3Config,
      projectName: projectConfig.projectName,
    });
    // Managed DNS: every A record in the zone at the address, through the
    // same backend and token that wrote the records.
    const zoneRecordsAt =
      hasAutomatedDns(dnsProvider) && dnsToken && dnsZoneId
        ? async (address) =>
            (await getDnsProvider(dnsProvider)).findARecordsAt(dnsToken, dnsZoneId, address)
        : null;
    await releaseRetiredReservedIps({
      environment,
      Provider: IngressProvider,
      provider: new IngressProvider(apiToken),
      log: p.log,
      domain,
      dnsWrite,
      newAddress: clusterIngressIp(deployResult.primary ?? deployResult),
      dropRetired,
      zoneRecordsAt,
    });
  }

  // --- STEP 6: Finalize Config (Consolidated) ---
  // Persist dbIp alongside masterIp for k8s deploys. The failover flow
  // in src/failover.js needs the database node IP (where the postgres pod
  // runs) to pg_basebackup-reseed standby from primary — without it, the
  // failover uses whatever (potentially stale) state standby has. Compose
  // deploys only have a single masterIp so dbIp is omitted there.
  const servers = [];
  if (deployResult.primary) {
    // k8s-HA shape: { primary: { masterIp, dbIp }, standby: {...} }
    servers.push(
      {
        name: 'primary',
        role: 'primary',
        ip: deployResult.primary.masterIp,
        dbIp: deployResult.primary.dbIp,
        region,
      },
      {
        name: 'standby',
        role: 'standby',
        ip: deployResult.standby.masterIp,
        dbIp: deployResult.standby.dbIp,
        region: secondaryRegion,
      },
    );
  } else if (deployResult.primaryIp && deployResult.standbyIp) {
    // compose-HA shape: { primaryIp, standbyIp } — no dbIp because
    // compose-HA runs the database on the same VM as the app.
    servers.push(
      { name: 'primary', role: 'primary', ip: deployResult.primaryIp, region, serverType },
      {
        name: 'standby',
        role: 'standby',
        ip: deployResult.standbyIp,
        region: secondaryRegion,
        serverType,
      },
    );
  } else if (deployResult.masterIp) {
    // Single-server fall-through: hit by compose (one VPS) and k8s
    // (master + database + worker[s]) deploys.
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
    // role (db + worker-N) so post-deploy commands (scale, destroy,
    // e2e verify-scale) can enumerate every IP without having to
    // re-derive worker IPs from Pulumi outputs. The master entry is found
    // by its role through resolvePrimary, never by position. `dbIp` is also
    // kept on the master entry so a reader of that entry needs no second
    // lookup for the db node; it duplicates the dedicated db entry below.
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
      dbIp: deployResult.dbIp,
      region,
      serverType,
      ...(isComposeTier(tier) ? {} : { role: 'master' }),
    });
    // K8s only — compose has neither a separate database node nor worker
    // pool. Compose deploys leave servers as a single-element array.
    if (isK8sTier(tier)) {
      if (deployResult.dbIp) {
        servers.push({
          name: 'db',
          ip: deployResult.dbIp,
          region,
          serverType,
          role: 'db',
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

  // Persist backupS3 alongside the storage-s3 block. restore, backup, status,
  // destroy, failover and scale all read it through backupsTargetOf from
  // .vibecarbon.json — without it here, `vibecarbon restore` against a
  // destroyed-then-redeployed environment falls through to server-side
  // `ls /opt/*/backups/*` on a fresh VM with no files, so DR from a populated
  // backup bucket is broken. Keep the shape backupsTargetOf reads
  // (bucket/region/endpoint, no credentials — those are resolved from the
  // provider's object-storage env vars at read time, never persisted to
  // .vibecarbon.json).
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

  // The app-bucket finalize started after s3-setup ran beside IaC; wait for
  // it here, before the final save and the outro, and report its warnings.
  let appBucketFinal;
  try {
    appBucketFinal = await perfAsync('deploy.storage.finish', () =>
      appBucketFinalize.finish(p.log),
    );
  } catch (err) {
    p.log.error(`App storage key: ${err.message}`);
    writeLogDetail(`# app storage finalize error detail: ${err?.stack || err}`);
    process.exit(1);
  }
  // The deploy succeeded with the new key in place: only now revoke the keys
  // a re-mint replaced (R9). A failure is a warn line, and the id stays
  // recorded so the next deploy or destroy revokes it.
  // A fence target the sync skipped (an absent bucket of an env that never
  // finished a deploy) is marked on that env, for `status`; a sync that
  // fenced everything clears the marks. A destroyed environment's app or
  // kept backups bucket no region has is marked not found, so its line prints
  // once, and the mark is cleared when the fence reads the bucket again; one
  // found in another region has that region written into the destroyed
  // record (recordFenceOutcome). The fence keeps looking for it either way.
  if (appBucketFinal.fenceSkipped) {
    updateProjectConfig((onDisk) => {
      recordFenceOutcome(onDisk, appBucketFinal);
    });
  }
  s3Config.appKey = await finishAppKeyRotation({
    provider: storageProviderId,
    record: s3Config.appKey,
    apiToken,
    log: p.log,
  });

  // The database lineage this deploy leaves on record (B8): the role primary's
  // system identifier, the name of its archive folder. A new one (a destroyed
  // and redeployed environment) moves the old one to backup.priorLineages and
  // names the restore of every earlier lineage that holds base backups.
  // Unreadable fails the deploy before the final save, so the rerun records it.
  let backupLineage;
  {
    const primaryIp = deployedPrimaryIp(tier, deployResult);
    // The backups bucket at its own region and endpoint; the uploads bucket
    // only for an environment with no backups target (the legacy path,
    // where wal-g archives into the uploads bucket).
    const lineageStore = backupStorageConfig(s3Config, backupS3Config) ?? s3Config;
    try {
      if (!primaryIp) throw new Error('no primary address in the deploy result');
      backupLineage = await recordDeployedLineage({
        environment,
        backup: envConfig.backup,
        // deploy -restore chose its lineage: nothing is left unrestored.
        restored: !!restorePoint,
        where: primaryIp,
        exec: await deployedPrimaryPsql(tier, environment, projectConfig.projectName, primaryIp),
        listLineages:
          lineageStore?.bucket && lineageStore.accessKey && lineageStore.secretKey
            ? async () =>
                listLineages({
                  s3: await createS3Client(lineageStore),
                  bucket: lineageStore.bucket,
                  base: walgPrefixFor(projectConfig.projectName, environment),
                })
            : null,
        log: p.log,
      });
    } catch (err) {
      p.log.error(`Backup lineage: ${err.message}`);
      writeLogDetail(`# backup lineage error detail: ${err?.stack || err}`);
      process.exit(1);
    }
  }

  // Merge onto the on-disk project config, under the config lock. Inner
  // deploy paths (compose/ha.js, k8s/ha/index.js) write it themselves
  // mid-flight to persist server IDs / per-cluster details that this
  // outer save cannot reconstruct from `deployResult` alone (the
  // orchestrator's `servers` array drops `id`, for example). If we spread
  // the in-memory `projectConfig` (captured at function entry), we'd
  // silently overwrite those mid-flight saves — observed in compose-HA
  // matrix runs where destroyComposeHA found servers with no `id` and
  // skipped the VPS delete entirely, leaving Hetzner state to collide
  // on restore re-deploy.
  updateProjectConfig((persistedConfig) => {
    const persistedEnvConfig = persistedConfig.environments?.[environment] || envConfig;
    const nextEnv = {
      ...persistedEnvConfig,
      status: 'deployed',
      deployMode,
      // How the app image was made, so a compose scale makes it the same way.
      ...imageBuildRecord(tier, buildMode),
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
        // reaches this point is streaming with a standby that holds the app
        // image; only `-allow-degraded` finalizes a warm/degraded standby,
        // which the inner deploy flags on deployResult.
        ...haDegradedRecord(deployResult),
        // Persist per-cluster ingressIp (+ floatingIp where the cluster
        // has one) and dbIp under ha.primary / ha.standby so
        // failover.identifyServers takes the structured path that
        // surfaces each cluster's ingress address. Without these,
        // identifyServers falls through to the flat `servers[]` lookup
        // which has only `ip` — failover then targets the standby's
        // master IP for the DNS A record even where the cluster takes
        // traffic at a floating IP.
        ha: {
          enabled: true,
          failoverRegion: secondaryRegion,
          // The backup-prefix fence write's record (backup-fence.js), saved
          // mid-deploy by the tier: this save rebuilds `ha`, so carry it.
          ...(persistedEnvConfig.ha?.backupFence && {
            backupFence: persistedEnvConfig.ha.backupFence,
          }),
          // The seeded standby's system identifier, set only when this deploy
          // verified streaming. failover's replica proof (R1) compares the
          // standby against it; a deploy that could not prove streaming
          // leaves it unset, so an unplanned failover refuses until one does.
          ...haSeedRecord(deployResult),
          ...(deployResult.primary && {
            ...haSidesRecord(
              deployResult,
              { region, secondaryRegion, minWorkers },
              persistedEnvConfig.ha,
            ),
            scaleUpList: deriveScaleUpList({
              appManifestText: readFileSync(
                join(process.cwd(), 'k8s/base/app/deployment.yaml'),
                'utf-8',
              ),
              // The pilot standby zeroes every declared add-on; failover
              // brings back the ones in the app namespace.
              addons: failoverAddonManifests(process.cwd()),
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
      // delete of `worker-1`, replacing master+database along the way
      // (etcd loss). Master/database/worker types are also persisted so
      // the per-role split survives across deploy → scale.
      ...(deployMode === 'kubernetes' && {
        masterServerType,
        dbServerType,
        workerServerType,
        // Single (non-HA) k8s's floating ingress IP (M3 Task 9f), on the
        // providers whose clusters have one (Hetzner, Linode). `status.js`
        // has read `envConfig.floatingIp` for a long time, but nothing ever
        // wrote it — deployResult.floatingIp comes straight back from
        // deployK3s/Pulumi outputs and was only ever used in-memory for the
        // DNS warm-up above. Without persisting it, `destroy` can't
        // attribute the k8s DNS A record to this env (it points at the
        // floating IP, not any server's own IP) and, on Linode, can't
        // backstop-release the reserved IP by address either — both leaked
        // silently. A DigitalOcean cluster has none: a reserved IP the env
        // still records here is one the release above could not free, and
        // the spread of persistedEnvConfig keeps it for the next deploy or
        // destroy. HA persists its own per-cluster floatingIp under
        // `ha.primary/standby` above instead; this key is absent there
        // since `deployResult.floatingIp` is undefined for an HA result
        // shape.
        ...(deployResult.floatingIp && { floatingIp: deployResult.floatingIp }),
        // The address the domain's records point at (clusterIngressIp): the
        // floating IP, or on DigitalOcean the master's own. destroy
        // attributes the records by it; an HA result has none at the top
        // level (each side records its own under `ha`).
        ...(clusterIngressIp(deployResult) && { ingressIp: clusterIngressIp(deployResult) }),
        minWorkers,
        maxWorkers,
      }),
      deployedAt: deployResult.reconvergeIncomplete
        ? persistedEnvConfig.deployedAt
        : new Date().toISOString(),
      deployedCommit,
      ...(deployedDirty !== null && { deployedDirty }),
      // bucketCreatedAt only on a provider that fences a pasted key (the fence
      // reads it as proof a deploy finished); the fence marks the sync above
      // wrote to disk; the app key's record (R9, no secret) so destroy can
      // revoke it.
      s3: envS3Record(s3Config, {
        unfencedBuckets: persistedEnvConfig.s3?.unfencedBuckets,
        ...(Object.hasOwn(appBucketFinal, 'bucketCreatedAt') && {
          bucketCreatedAt: appBucketFinal.bucketCreatedAt,
        }),
      }),
      ...(backupS3Persist && { backupS3: backupS3Persist }),
      backup: { ...backupConfig, ...backupLineage },
      services,
    };
    // The TLS verdict this deploy reported, else the one on disk (none: no key).
    const tls = finalSaveTls(deployResult, persistedEnvConfig);
    if (tls) nextEnv.tls = tls;
    else delete nextEnv.tls;
    const finalConfig = {
      ...persistedConfig,
      environments: {
        ...persistedConfig.environments,
        // The HA `ha` rebuild above keeps an allowlist: the safety records
        // (a stranded write fence, the journals, a pending state sync) come
        // from disk unless this deploy decided them.
        [environment]: preserveSafetyFields(persistedConfig.environments?.[environment], nextEnv, {
          owns: finalSaveSafetyOwns(isHADeploy),
        }),
      },
    };
    // The environment is live again: drop the identity `destroy` recorded for
    // this name (if any) so it never outlives the rebuild it was kept for.
    // A k8s-ha deploy that stamps deployedAt has reconverged a failed-over pair:
    // drop the failover stamp, as the compose reconverge does, so "swapped"
    // never hangs on the order of two clocks (the failover's and the deploy's
    // machine). A reconverge that kept the retired fence keeps it.
    if (tier === 'k8s-ha')
      finishK8sReconvergeRecord(finalConfig.environments[environment], deployResult);
    return clearDestroyedRecord(finalConfig, environment);
  });
  registerProject(projectConfig.projectName, process.cwd());

  // File this environment's resources into the dedicated cloud project on
  // providers whose project model needs post-hoc assignment (DigitalOcean);
  // a no-op elsewhere. Best-effort by contract — never fails the deploy.
  const AssignProvider = providerFor(envConfig);
  await perfAsync('deploy.finish.fileResources', () =>
    runProjectAssignment(new AssignProvider(apiToken), {
      projectName: projectConfig.projectName,
      environment,
    }),
  );

  await staleSecretSweep.flush((line) => p.log.info(line));
  const { formatted: timeStr } = tracker.finish();
  deployTotalTimer.end();
  p.log.success(`Deployment to ${c.bold(environment)} complete! ${c.dim(`(${timeStr})`)}`);
  p.note(
    formatCommandNote(
      completionSummaryLines({
        environment,
        domain,
        dnsProvider,
        entryIp: entryIpFor(deployResult),
        servers,
      }),
    ),
    'Your app is live',
  );

  // Terminal state reached: config persisted, DR gate cleared. Disarm the
  // silent-success guard so a clean exit-0 is accepted as a real success.
  markDeployCompleted();
}
