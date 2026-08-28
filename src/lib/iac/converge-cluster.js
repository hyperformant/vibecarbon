/**
 * Reusable IaC converge seam for the hardened Hetzner-k8s scale path.
 *
 * `convergeClusterInfra` is the DANGER-ZONE block lifted verbatim out of
 * scale.js's `applyScaleChanges`. It drives ONE Pulumi cluster stack from its
 * current shape to a desired shape (server-type resize and/or worker floor),
 * defending etcd at every step. Both `vibecarbon scale` and the pilot-light
 * failover reuse it so a standby stack converges 0→N workers through the exact
 * same guarded path.
 *
 * The behaviors below are load-bearing and MUST stay in order (every input
 * that flows into a Server's sshKeys/firewallIds/labels/userData is a tripwire
 * for a destructive `replace`, and replacing master wipes etcd):
 *
 *   1. SSH-key resolution — HA reads the SHARED key file and re-resolves the
 *      Hetzner SshKey id by name via `Provider.createSSHKey` (byte-identical
 *      inputs to the deploy's `existingSshKeyId`, or Pulumi plans a node
 *      replace); single-cluster reads `.vibecarbon/ssh-<clusterEnv>.pub`.
 *   2. s3Config reconstruction — points Pulumi at the same state backend the
 *      deploy used. Accepts `s3Creds` to skip the interactive prompt.
 *   3. `buildProgramConfig` — assembles byte-identical program inputs, with
 *      `overrides` taking the `newValues` slot.
 *   4. k3sToken probe/replay — reads prior outputs and replays the token so
 *      userData hashes match (in-place resize, not replace).
 *   5. master-replace preview guard — runs a Pulumi preview and refuses to
 *      proceed if ANY role=master resource is scheduled for replacement.
 *   6. `upStack` — applies the change and returns its flattened outputs.
 *
 * LAZINESS (CD2): the Pulumi runtime (`./index.js`, which imports
 * `@pulumi/pulumi`) and `../deploy/k8s/index.js` are reached ONLY through
 * dynamic imports inside the function — importing this module never loads
 * @pulumi. Enforced by tests/unit/iac/converge-cluster-laziness.test.ts.
 *
 * ERRORS THROW (no `process.exit`) — callers own exit behavior. Fatal aborts
 * throw an Error carrying a `logLines` array: the exact sequence of
 * `p.log.error(...)` lines the caller should replay so its console UX is
 * unchanged. scale.js's call site replays each line then `process.exit(1)`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { spinner } from '../cli/progress.js';
import { perfAsync } from '../perf.js';
import { providerIdFor } from '../providers/index.js';
import { buildProgramConfig } from '../scale-plan.js';

/**
 * Build an abort Error whose `logLines` are the exact `p.log.error(...)` lines
 * the caller must reproduce. A plain-message Error is still handled by callers
 * that fall back to `[err.message]`.
 * @param {string[]} lines
 * @returns {Error & { logLines: string[] }}
 */
function abort(lines) {
  const err = /** @type {Error & { logLines: string[] }} */ (
    new Error(lines[0] ?? 'convergeClusterInfra aborted')
  );
  err.logLines = lines;
  return err;
}

/**
 * Converge a single k8s cluster stack via the hardened Pulumi path.
 *
 * @param {object} args
 * @param {object} args.projectConfig            .vibecarbon.json project config.
 * @param {object} args.envConfig                Environment config (s3, worker bounds, server types).
 * @param {any} args.Provider                    Provider CLASS (providerFor result).
 * @param {string} args.apiToken                 Compute-provider API token.
 * @param {string} args.clusterEnv               Pulumi stack name (e.g. 'e4-standby').
 * @param {string} args.clusterRegion            Cluster region.
 * @param {string} args.environment              User-facing env name (shared HA key naming).
 * @param {boolean|string} args.isHA             HA topology (truthy → shared-key path).
 * @param {Record<string, unknown>} [args.overrides]  buildProgramConfig `newValues` slot.
 *   Accepts BOTH the short type keys buildProgramConfig reads
 *   (`masterType`/`supabaseType`/`workerType`) and the long-form persisted spec
 *   keys (`masterServerType`/`supabaseServerType`/`workerServerType`, matching
 *   envConfig.ha.standby.*). Long-form keys are mapped to short when the short
 *   key is absent, so a caller using either vocabulary reaches Pulumi — `scale`
 *   passes short keys, the pilot-light `failover` provisioning passes long keys.
 * @param {{accessKey: string, secretKey: string}|null} [args.s3Creds]  Skip the S3 prompt when set.
 * @param {((event: unknown) => void)|null} [args.onPreviewEvent]  Additive raw-preview-event sink.
 * @param {string} [args.label]                  Cosmetic spinner/log label (defaults to clusterEnv).
 * @param {string} [args.action]                 Operator-facing verb woven into abort wording
 *   (default 'scale'; failover passes 'failover' so a DR operator isn't told
 *   about "scaling"). Defaults keep scale's wording byte-identical.
 * @returns {Promise<{ outputs: Record<string, unknown> }>}  Flattened upStack outputs.
 */
export async function convergeClusterInfra({
  projectConfig,
  envConfig,
  Provider,
  apiToken,
  clusterEnv,
  clusterRegion,
  environment,
  isHA,
  overrides = {},
  s3Creds = null,
  onPreviewEvent = null,
  label = clusterEnv,
  action = 'scale',
}) {
  // Apply server type changes via Pulumi. Hetzner server_type is an in-place
  // resize via the provider's update path (~2 min reboot), so a legitimate
  // type-bump shows up as `update`, not `replace`. Any planned `replace` of
  // master is the destructive userData-drift bug — see the master-replace
  // defense block below.
  //
  // Dynamic imports keep @pulumi/* out of this module's static-load graph
  // (CD2). `./index.js` imports @pulumi/pulumi at its top level.
  const {
    upStack,
    getStackOutputs,
    getOrCreateStack,
    classifyK3sTokenProbe,
    summarizePulumiError,
  } = await import('./index.js');
  const { K3S_VERSION } = await import('../deploy/k8s/index.js');

  // SSH key location depends on deploy topology:
  // - Single-cluster k8s: deployK3s' ensureSshKey writes
  //   `.vibecarbon/ssh-<env>` and lets Pulumi manage the SshKey resource.
  // - HA k8s: deployK8sHA generates a SHARED key at
  //   `.vibecarbon/deploy_key_<environment>` (one file, used by both
  //   primary and standby), uploads it ONCE via provider.createSSHKey,
  //   and passes the resulting `existingSshKeyId`
  //   into buildHetznerK8sProgram so neither stack manages the SshKey
  //   resource directly.
  //
  // If we read the wrong path, sshPublicKey resolves to `''` and Pulumi
  // would either replace the managed SshKey (single-cluster) or — for
  // HA — try to *create* a brand-new SshKey resource that the original
  // deploy never managed. The new resource has a different id,
  // master/supabase/worker `sshKeys: [sshKeyId]` diffs against state,
  // and Pulumi plans a destructive replace of every node (etcd loss).
  // The k3sToken probe (further down) is necessary but insufficient
  // for HA — we ALSO need to mirror the deploy's `existingSshKeyId`
  // decision, which means reading the shared key file and re-resolving
  // the Hetzner SshKey id by name.
  let sshPublicKey = '';
  let existingSshKeyId;
  if (isHA) {
    const sharedKeyPath = join(process.cwd(), '.vibecarbon', `deploy_key_${environment}.pub`);
    if (existsSync(sharedKeyPath)) {
      sshPublicKey = readFileSync(sharedKeyPath, 'utf-8').trim();
    } else {
      throw abort([
        `HA shared SSH key not found at ${sharedKeyPath}. ` +
          `Was this environment deployed with the current CLI? Refusing to ` +
          `proceed; a missing key would force Pulumi to recreate every node.`,
      ]);
    }
    // Resolve the existing Hetzner SshKey id by the deploy-time name.
    // Provider.createSSHKey is idempotent: matches first by
    // <name>, then by public-key bytes, and only POSTs when neither
    // exists. Same call the deploy's haK8sUploadSshKey effect makes —
    // must match so Pulumi sees the same `existingSshKeyId` input.
    const provider = new Provider(apiToken);
    const haSshKeyName = `${projectConfig.projectName}-${environment}-ha-key`;
    try {
      const id = await provider.createSSHKey(haSshKeyName, sshPublicKey);
      existingSshKeyId = String(id);
    } catch (err) {
      throw abort([
        `Could not resolve HA SSH key '${haSshKeyName}' in ${Provider.NAME}: ${summarizePulumiError(err)}`,
      ]);
    }
  } else {
    const sshKeyPath = join(process.cwd(), '.vibecarbon', `ssh-${clusterEnv}`);
    sshPublicKey = existsSync(`${sshKeyPath}.pub`)
      ? readFileSync(`${sshKeyPath}.pub`, 'utf-8').trim()
      : '';
  }

  // Reconstruct the s3Config that the original deploy used so pulumi
  // hits the same backend bucket. envConfig persists bucket + region +
  // endpoint under `s3` (not `s3Config` — the typo on this line was
  // silently undefined-ing the config, falling pulumi back to file://
  // backend with empty state, then trying to CREATE every Hetzner
  // resource fresh and 409-ing on "name is already used"). Keys aren't
  // persisted in envConfig (resolved from HETZNER_ACCESS_KEY/HETZNER_SECRET_KEY at
  // read time instead) so we re-fetch them via
  // Provider.promptObjectStorageCredentials — unless
  // the caller supplied `s3Creds` (failover passes them to skip the prompt).
  let s3Config;
  if (envConfig.s3?.bucket) {
    const creds =
      s3Creds ||
      (await Provider.promptObjectStorageCredentials(projectConfig.projectName, {
        save: false,
      }));
    if (!creds) {
      throw abort(['S3 credentials required to access pulumi backend']);
    }
    s3Config = {
      bucket: envConfig.s3.bucket,
      region: envConfig.s3.region,
      endpoint: envConfig.s3.endpoint,
      // Dedicated Pulumi-state bucket. Undefined for envs deployed before
      // the state-bucket split — resolveBackendUrl then falls back to the
      // app bucket, matching where their state actually still lives.
      stateBucket: envConfig.s3.stateBucket,
      stateBucketRegion: envConfig.s3.stateBucketRegion,
      stateEndpoint: envConfig.s3.stateEndpoint,
      accessKey: creds.accessKey,
      secretKey: creds.secretKey,
    };
  }

  // Common program inputs shared by both the probe (read-only outputs())
  // and the real `up` call. They MUST be byte-identical to what deployK3s
  // passed at deploy time — every input that flows into a Server's
  // `sshKeys`, `firewallIds`, `labels`, or `userData` is a tripwire for
  // destructive replace. The k3sToken probe-and-replay (further below)
  // keeps userData stable; HA needed `existingSshKeyId` to also be
  // mirrored or master.sshKeys would still drift and replace etcd.
  // buildProgramConfig (src/lib/scale-plan.js) owns the assembly + the
  // newValues/persisted/default `??` resolution. k3sVersion and labels MUST
  // match deployK3s (both are interpolated into userData / resource labels).
  //
  // `current*Type` are re-derived here from envConfig with the SAME formula
  // scaleK8s uses (envConfig.<role>ServerType || (envConfig.serverType ||
  // Provider.DEFAULT_COMPOSE_TYPE)) so buildProgramConfig's fallback slot is
  // byte-identical to the scale path; `overrides` (the newValues slot) wins
  // via `??` when set. `Provider` is the resolved class passed in by the
  // caller (providerFor(envConfig) at the call site) — see the @param doc above.
  const fallbackType = envConfig.serverType || Provider.DEFAULT_COMPOSE_TYPE;
  const currentMasterType = envConfig.masterServerType || fallbackType;
  const currentSupabaseType = envConfig.supabaseServerType || fallbackType;
  const currentWorkerType = envConfig.workerServerType || fallbackType;
  const allowedCidrs = (projectConfig.operatorCidrs ?? []).map((e) => e.cidr);
  // Normalize long-form server-type override keys to the short keys
  // buildProgramConfig reads. `scale` passes the short keys verbatim; the
  // pilot-light `failover` provisioning passes the persisted long-form spec
  // keys (workerServerType/masterServerType/supabaseServerType, matching
  // envConfig.ha.standby.*). Without this, a `-server-type` override and the
  // persisted standby types are silently dropped and Pulumi plans an in-place
  // resize of the standby's master/db node mid-failover. Map long→short only
  // when the short key is absent (short wins if a caller sets both).
  const normalizedOverrides = { ...overrides };
  if (normalizedOverrides.workerType == null && overrides.workerServerType != null)
    normalizedOverrides.workerType = overrides.workerServerType;
  if (normalizedOverrides.masterType == null && overrides.masterServerType != null)
    normalizedOverrides.masterType = overrides.masterServerType;
  if (normalizedOverrides.supabaseType == null && overrides.supabaseServerType != null)
    normalizedOverrides.supabaseType = overrides.supabaseServerType;
  const programConfig = buildProgramConfig({
    projectName: projectConfig.projectName,
    environment: clusterEnv,
    sshPublicKey,
    allowedCidrs,
    existingSshKeyId,
    location: clusterRegion,
    newValues: normalizedOverrides,
    currentMasterType,
    currentSupabaseType,
    currentWorkerType,
    persistedMinWorkers: envConfig.minWorkers,
    persistedMaxWorkers: envConfig.maxWorkers,
    k3sVersion: K3S_VERSION,
    labels: { 'managed-by': 'vibecarbon', 'os-flavor': 'k3s' },
    apiToken,
  });

  // Probe prior stack outputs for the k3sToken so we can replay it into
  // the real program. classifyK3sTokenProbe normalizes recovered/empty/
  // errored into a tagged result so the visible logging path matches the
  // unit tests for this seam (see tests/unit/iac/probe-classify.test.ts).
  let probeOutputs = null;
  let probeError = null;
  const probeSpinner = spinner();
  probeSpinner.start(`Reading prior cluster state (${label})...`);
  try {
    // CD2 — lazy dispatch through the provider class (no named
    // buildHetznerK8sProgram import) so Phase B providers slot in
    // without editing this file.
    const probeProgram = await Provider.getK8sProgram(programConfig);
    probeOutputs = await perfAsync(`scale.k8s.${clusterEnv}.probeOutputs`, () =>
      getStackOutputs(clusterEnv, probeProgram, {
        provider: providerIdFor(envConfig),
        providerToken: apiToken,
        s3Config,
        projectName: projectConfig.projectName,
      }),
    );
  } catch (err) {
    probeError = err instanceof Error ? err : new Error(String(err));
  }
  probeSpinner.stop(`Prior cluster state read (${label})`);
  const probe = classifyK3sTokenProbe({ outputs: probeOutputs, error: probeError });
  const priorK3sToken = probe.priorK3sToken;
  switch (probe.status) {
    case 'recovered':
      break;
    case 'empty':
      // Legit on a fresh stack; suspicious on an established one. Either
      // way, the master-replace defense below is what protects etcd —
      // we just log loudly so a misbehaving probe is visible in run logs.
      p.log.warn(
        `${label}: ${probe.reason}. Proceeding with newly-minted k3sToken, master-replace defense will block any destructive plan.`,
      );
      break;
    case 'errored':
      // Genuine backend failure (S3 outage, expired creds, corrupt
      // state). Surface as an error so it doesn't blend into routine
      // info noise. The real `up` below will resurface the same problem
      // with a cleaner message.
      p.log.error(
        `${label}: ${probe.reason}. Master-replace defense remains armed; if it doesn't fire, fix the backend before scaling.`,
      );
      break;
    default:
      // Future-proof: classifyK3sTokenProbe is the single source of
      // truth for status values; surface any unhandled status so a
      // silent regression can't flow through.
      p.log.error(`${label}: unexpected probe status '${probe.status}': ${probe.reason}`);
  }

  const program = await Provider.getK8sProgram({
    ...programConfig,
    // Replay the prior token (when available) so userData hashes match
    // and Pulumi plans an in-place server-type change rather than a
    // destructive replace of every node.
    k3sToken: priorK3sToken,
  });

  // Defense in depth: run a Pulumi preview and refuse to proceed if any
  // resource with role=master is scheduled for replacement. The k3sToken
  // probe-and-replay above should make this unreachable, but if any
  // future input drift (cloud-init template change, label rename, etc.)
  // re-introduces userData hash drift, this fails fast instead of
  // silently wiping etcd. Replacements show up under three op codes:
  // "replace", "create-replacement", and "delete-replaced" — Pulumi
  // emits all three for a single replaced resource. Catching any one
  // is sufficient.
  const s = spinner();
  s.start(`Previewing infra changes (${label})...`);
  // perf coverage: scale on k8s/k8s-ha was a black box — cli.scale.total
  // landed at ~470s with only ~9s instrumented (waitForCsiNode +
  // waitForPodsReady at the tail). The dominant cost is the Pulumi
  // preview + up cycle below; wrap each so perf_substep can finally
  // attribute the gap. Tag with clusterEnv (e.g. e4-primary vs
  // e4-standby) so HA primary/standby are distinguishable.
  try {
    const previewStack = await perfAsync(`scale.k8s.${clusterEnv}.previewStack`, () =>
      getOrCreateStack(clusterEnv, program, {
        provider: providerIdFor(envConfig),
        providerToken: apiToken,
        s3Config,
        projectName: projectConfig.projectName,
        // scale/failover converge an EXISTING cluster. Never let a stale state
        // read fabricate an empty stack here — that reads as "fresh cluster"
        // and plans to re-create live infrastructure (2026-08-06 RCA).
        requireExisting: true,
      }),
    );
    const masterReplacements = [];
    await perfAsync(`scale.k8s.${clusterEnv}.preview`, () =>
      previewStack.preview({
        color: 'never',
        onEvent: (event) => {
          const meta = event?.resourcePreEvent?.metadata;
          if (meta) {
            const isReplaceOp =
              meta.op === 'replace' ||
              meta.op === 'create-replacement' ||
              meta.op === 'delete-replaced';
            if (isReplaceOp) {
              // Resource was created with `new hcloud.Server('master', ...)`
              // and labelled `role: 'master'`. Either signal flags it.
              const role = meta.new?.inputs?.labels?.role || meta.old?.inputs?.labels?.role || null;
              const urn = meta.urn || '';
              if (role === 'master' || /::master$/.test(urn)) {
                masterReplacements.push({ op: meta.op, urn });
              }
            }
          }
          // Additive passthrough so a caller (failover) can observe the raw
          // preview stream. The master-replace defense above always runs
          // first and is non-optional. scale passes null → no-op.
          if (onPreviewEvent) onPreviewEvent(event);
        },
      }),
    );
    s.stop(`Preview complete (${label})`);
    if (masterReplacements.length > 0) {
      throw abort([
        `Refusing to ${action}: would replace master node (etcd loss). ` +
          `Inspect with: pulumi preview --stack ${clusterEnv}`,
        ...masterReplacements.map((r) => `  ${r.op}: ${r.urn}`),
      ]);
    }
  } catch (err) {
    // Re-throw an already-shaped abort (master-replace) unchanged so its
    // logLines survive; a raw preview failure becomes a single-line abort
    // mirroring the prior `p.log.error(err.message)` + exit behavior.
    if (err.logLines) throw err;
    s.stop(`Pulumi preview failed (${label})`);
    throw abort([summarizePulumiError(err)]);
  }

  s.start(`Applying infra changes via Pulumi (${label})...`);
  let upResult;
  try {
    upResult = await perfAsync(`scale.k8s.${clusterEnv}.upStack`, () =>
      upStack(clusterEnv, program, {
        provider: providerIdFor(envConfig),
        providerToken: apiToken,
        s3Config,
        projectName: projectConfig.projectName,
        requireExisting: true,
        // Stale-EMPTY outputs recovery (bc94b18 family): every k8s program —
        // primary and pilot-light standby alike — exports masterIp, so an
        // empty read here is always a stale frontend, never a real answer.
        requiredOutputs: ['masterIp'],
      }),
    );
    s.stop(`Infra updated (${label})`);
  } catch (err) {
    s.stop(`Pulumi up failed (${label})`);
    throw abort([summarizePulumiError(err)]);
  }

  return { outputs: upResult?.outputs ?? {} };
}
