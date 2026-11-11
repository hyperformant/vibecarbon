/**
 * Pulumi-based Infrastructure-as-Code runtime for Vibecarbon.
 *
 * Entry point for Pulumi's Automation API. Programs live under
 * `src/lib/iac/programs/` and are invoked from here. State is stored in
 * the user's Hetzner S3 bucket by default; we fall back to a local file
 * backend when no S3 is configured.
 *
 * Design notes:
 * - We use inline programs (Automation API, no Pulumi.yaml files) so there's
 *   nothing for users to manage on disk. Stack state lives in the backend;
 *   the program code lives in this npm package.
 * - One project name ("vibecarbon"), many stacks (one per environment like
 *   "prod", "staging"). HA deploys use two stacks: "<env>-primary" and
 *   "<env>-standby".
 * - Secrets are resolved from the operator's environment (shell/CI, or the
 *   project's .env.local via bootstrapOperatorEnv) and passed to programs as
 *   plain config. The state's secrets provider is encrypted with the
 *   project's own passphrase (VIBECARBON_STATE_PASSPHRASE, see buildEnv).
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { LocalWorkspace } from '@pulumi/pulumi/automation/index.js';
import { summarizeCommandError } from '../cli/error-line.js';
import { progressLog } from '../cli/progress.js';
import { readOperatorVar } from '../operator-env.js';
import { perfAsync, perfEnabled, perfRecord, perfTimer } from '../perf.js';
import { getProviderClass } from '../providers/index.js';
import {
  ensureStatePassphrase,
  resolveStatePassphrase,
  STATE_PASSPHRASE_KEY,
  statePassphraseGeneratedThisRun,
} from '../state-passphrase.js';
import { createTimeoutError, parseCreateTimeouts } from './create-timeout.js';
import { createResourceTimer } from './resource-timing.js';
import { dropStackResources } from './retired-resources.js';
import { createDropletPlanRecorder, sizeUnavailableError } from './size-unavailable.js';
import { runPastStaleLock, StackHeldError } from './stack-lock.js';
import {
  asStateUndecryptableError,
  classifyStateError,
  failingPulumiCommandVerb,
  HISTORY_WRITE_PATTERN,
  isHistoryWriteOnlyFailure,
  isStackOpenInterrupted,
  isStatePassphraseFailure,
  StateMigrationError,
} from './state-error.js';
import { emitStateTelemetry, recordStateOp, recordStateRetry } from './state-telemetry.js';

// Re-exported so this module stays the iac layer's public surface while the
// verb extractor lives with the classifier that depends on it — one
// implementation, not two copies drifting apart.
export { failingPulumiCommandVerb };

/**
 * The Pulumi PROJECT scopes state keys: the DIY backend stores every checkpoint
 * as `.pulumi/stacks/<project>/<stack>.json`. This used to be the constant
 * 'vibecarbon', which made state keys collide the moment two vibecarbon
 * projects shared one state bucket — exactly what the project-level
 * `stateBucket` pin and the e2e shared bucket introduced. Two projects pinned
 * to one bucket with an env name in common would silently ADOPT each other's
 * live state: select succeeds on the other project's stack file, URNs match
 * (program logical names are constants), and `up` reconciles someone else's
 * servers. (Review finding, 2026-08-15.)
 *
 * So the project name is now the vibecarbon PROJECT'S name, required
 * explicitly: state keys become `.pulumi/stacks/<projectName>/<stack>.json`,
 * distinct per project, and a shared bucket is safe by construction.
 *
 * REQUIRED, never defaulted: a call site that fell back to a constant would
 * read a DIFFERENT key than the one the deploy wrote, see "no stack", and take
 * the create-or-orphan paths — the silent-split failure mode is strictly worse
 * than a loud throw. Pre-release, so no migration shim for state written under
 * the old constant key.
 */
function requirePulumiProject(options) {
  const name = options?.projectName;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(
      'iac: options.projectName is required — Pulumi state keys are scoped per project ' +
        '(.pulumi/stacks/<projectName>/<stack>.json). Pass the vibecarbon projectName from ' +
        'projectConfig; a defaulted name would read a different key than the deploy wrote.',
    );
  }
  return name.trim();
}
const LOCAL_STATE_DIR = join(homedir(), '.vibecarbon', 'pulumi-state');

// Pulumi's file:// backend requires the target directory to exist before
// `stack select` runs, otherwise the first scenario to race for a stack
// fails with `error: unable to open bucket file:///... no such file or
// directory`. Create it at module load so every call path sees it.
mkdirSync(LOCAL_STATE_DIR, { recursive: true });

/**
 * Compute the Pulumi backend URL. Prefers Hetzner S3 when s3Config is
 * provided; otherwise falls back to a local file:// backend under
 * ~/.vibecarbon/pulumi-state. Pulumi Cloud is opt-in via
 * PULUMI_BACKEND_URL env var before invoking vibecarbon.
 *
 * Hetzner S3 uses path-style URLs via the Hetzner-provided endpoint, so we
 * pass both `endpoint` and `s3ForcePathStyle=true` in the query string.
 *
 * State lives in a DEDICATED bucket (`s3Config.stateBucket`), separate from
 * the app storage bucket, so `destroy` deleting the app bucket can never yank
 * the Pulumi backend out from under an in-flight destroy. The `?? bucket`
 * fallback preserves behavior for any un-migrated path (configs persisted
 * before the dedicated-state-bucket change, whose state still lives in the app
 * bucket) — the deploy path always sets `stateBucket`.
 *
 * `provider` is optional and affects ONLY the checksum query parameter below.
 * A caller that omits it gets Pulumi's own default behavior, which is what
 * every provider except Scaleway wants — see
 * BaseProvider.STATE_BACKEND_CHECKSUM_CALCULATION.
 *
 * @param {object} [s3Config]
 * @param {string} [provider] - Provider id, when the caller knows it.
 */
export function resolveBackendUrl(s3Config, provider) {
  const override = readOperatorVar('PULUMI_BACKEND_URL').value;
  if (override) {
    return override;
  }
  if (s3Config?.bucket && s3Config?.endpoint) {
    const stateBucket = s3Config.stateBucket ?? s3Config.bucket;
    // The STATE bucket's own region wins when it differs from the app buckets'
    // (a retained bucket can live where an earlier run created it). Without
    // this, cross-region state buckets 404 at the backend URL — and before
    // 2026-08-15 the createBucket region-flip papered over it by corrupting
    // the app/backup config instead.
    const region = s3Config.stateBucketRegion || s3Config.region || 'nbg1';
    // The HOST is what routes on region-scoped object stores (Hetzner, DO,
    // Linode all serve a bucket only at its own region's hostname; the
    // `region` query param is just the SDK signing region) — so the endpoint
    // must follow the state bucket too. Prefer the explicit stateEndpoint;
    // for configs persisted before it existed, derive by swapping the app
    // region token in the host (all supported stores use `{region}.domain`).
    let endpointHost = (s3Config.stateEndpoint || s3Config.endpoint).replace(/^https?:\/\//, '');
    if (!s3Config.stateEndpoint && s3Config.region && region !== s3Config.region) {
      endpointHost = endpointHost.replace(s3Config.region, region);
    }
    // Pulumi injects `request_checksum_calculation=when_required` into any
    // s3:// URL carrying a custom `endpoint` — ours always do — and its
    // vendored gocloud implements that mode with a literal `UNSIGNED-PAYLOAD`
    // checksum header some stores reject outright. A provider that declares a
    // mode pins it here, which suppresses the injection (Pulumi only defaults
    // the parameter when it is absent).
    const checksumMode = provider
      ? (getProviderClass(provider).STATE_BACKEND_CHECKSUM_CALCULATION ?? '')
      : '';
    const checksumParam = checksumMode ? `&request_checksum_calculation=${checksumMode}` : '';
    return `s3://${stateBucket}?endpoint=${endpointHost}&region=${region}&s3ForcePathStyle=true${checksumParam}`;
  }
  return `file://${LOCAL_STATE_DIR}`;
}

/**
 * Build the env var bag Pulumi needs. The compute provider's CLI reads its
 * own token env var (Hetzner: HCLOUD_TOKEN, via
 * `getProviderClass(provider).CLI_TOKEN_ENV`); S3 backend reads
 * AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY. A plugin setting with no env var
 * travels as the provider's IAC_STACK_CONFIG instead.
 *
 * There is NO default provider here (deliberately — see the DO k8s 401 RCA:
 * a caller that forgot `provider` used to silently get 'hetzner', so a
 * DigitalOcean token was exported as HCLOUD_TOKEN and the Pulumi DO provider
 * ran unauthenticated). A caller that supplies `providerToken` MUST also
 * supply `provider`; every call site resolves it from the options/envConfig
 * it already holds, via `providerIdFor()` (lib/providers/index.js) when a
 * default is appropriate.
 *
 * @param {object} options
 * @param {string} [options.provider] - Provider id (e.g. 'hetzner'). Required
 *   whenever `options.providerToken` is set.
 * @param {string} [options.providerToken] - The provider's API token. Value
 *   for whatever env var name the provider class declares.
 * @param {object} [options.s3Config]
 * @param {string} [options.statePassphrase] - The passphrase getOrCreateStack
 *   already verified; used instead of re-reading the environment.
 * @param {boolean} [options.decrypts=true] - false for a caller that decrypts
 *   nothing (stack ls, whoami, stack rm --force): a malformed
 *   VIBECARBON_STATE_PASSPHRASE then does not stop it.
 * @returns {Record<string, string|undefined>}
 */
export function buildEnv(options) {
  const env = { ...process.env };
  if (options.providerToken) {
    if (!options.provider) {
      throw new Error(
        'buildEnv: options.providerToken was set without options.provider; a token has ' +
          'no env var to write to without knowing which provider it belongs to. This is ' +
          'always a caller bug; pass provider explicitly (e.g. "hetzner", "digitalocean").',
      );
    }
    const ProviderClass = getProviderClass(options.provider);
    // Provider-owned env bag (BaseProvider.buildIacEnv): single-credential
    // providers contribute exactly the CLI_TOKEN_ENV → token pair; multi-cred
    // providers (Scaleway's SCW_* triple) contribute their full set — and
    // throw an actionable error here, at deploy start, when a required
    // companion env var is missing, rather than mid-Pulumi.
    Object.assign(env, ProviderClass.buildIacEnv(options.providerToken));
  }
  // Pulumi gives PULUMI_BACKEND_URL precedence over projectSettings.backend.url
  // inside the child, so a shell-exported value with quotes/whitespace would
  // win there while the CLI's own resolveBackendUrl() saw the clean one.
  // Hand the child the normalized value (or nothing) — same seam as
  // buildIacEnv for the provider credentials.
  const backendUrl = readOperatorVar('PULUMI_BACKEND_URL').value;
  if (backendUrl) env.PULUMI_BACKEND_URL = backendUrl;
  else delete env.PULUMI_BACKEND_URL;
  if (options.s3Config?.accessKey) env.AWS_ACCESS_KEY_ID = options.s3Config.accessKey;
  if (options.s3Config?.secretKey) env.AWS_SECRET_ACCESS_KEY = options.s3Config.secretKey;
  // Disable Pulumi's telemetry for solo-hosted users. No data leaves the box.
  env.PULUMI_SKIP_UPDATE_CHECK = 'true';
  // Stop the DIY backend writing a second, timestamped copy of every
  // checkpoint into `.pulumi/backups/`.
  //
  // Measured against pulumi 3.231.0 on a file:// backend with a zero-resource
  // stack: each `up` writes `.pulumi/stacks/<stack>.json`, its `.bak`, a
  // `.pulumi/backups/<stack>/<ts>.json` copy, and two `.pulumi/history/`
  // entries — five writes before a single resource exists, scaling from there.
  // Dropping the backups copy removes one of the five. That is a fifth of the
  // write traffic against a store whose documented ceiling we have never
  // modelled (Hetzner: 750 requests/s per bucket, 750/s per source IP), and
  // request volume is what the 2026-08-15 evidence points at: 38 of the 40
  // state-backend recovery events in run 31898658781 were throttle, not
  // staleness.
  //
  // Safe because it is not the only copy. The live checkpoint keeps its `.bak`
  // sibling, and `.pulumi/history/<ts>.checkpoint.json` still retains a full
  // checkpoint per update — so state recovery material survives; only the
  // duplicate of it goes.
  //
  // Unknown env vars are ignored by the CLI, so this is inert on a version
  // that predates the flag rather than an error.
  env.PULUMI_DIY_BACKEND_DISABLE_CHECKPOINT_BACKUPS = 'true';
  // The project's state passphrase encrypts the values Pulumi marks secret in
  // the state. It is NOT a blanket seal: a plain output (the k8s programs'
  // `k3sToken`) and user data stay readable until a later change wraps them in
  // pulumi.secret and re-seals existing state. SECURITY: never default to ''
  // (the empty passphrase every legacy stack was made with) and never let an
  // inherited PULUMI_CONFIG_PASSPHRASE or PULUMI_CONFIG_PASSPHRASE_FILE (a
  // shell export for another project) win over the project's own value.
  // Both are set to `undefined`, not deleted: the Automation SDK spawns pulumi
  // with {...process.env, ...envVars}, so a deleted key comes straight back
  // from process.env, while an undefined one overrides it and Node drops it at
  // spawn. With no project passphrase pulumi then sees neither variable and a
  // decrypting call is refused by pulumi; getOrCreateStack awaits
  // ensureStatePassphrase first and hands its verified value in as
  // `options.statePassphrase`, so every decrypting path carries one.
  env.PULUMI_CONFIG_PASSPHRASE = undefined;
  env.PULUMI_CONFIG_PASSPHRASE_FILE = undefined;
  let passphrase = options.statePassphrase ?? null;
  if (!passphrase) {
    try {
      passphrase = resolveStatePassphrase();
    } catch (err) {
      if (options.decrypts !== false) throw err;
    }
  }
  if (passphrase) env.PULUMI_CONFIG_PASSPHRASE = passphrase;
  return env;
}

/**
 * Is this the automation API's "that stack does not exist" answer?
 *
 * ONLY the `no stack named …` signature counts as absence. A checkpoint-load
 * failure or any other read error is a FAILED READ, not evidence of absence,
 * and must never be treated as permission to create.
 *
 * Why this function exists at all — RCA, k8s-ha record attempt 4 (2026-08-06):
 * we used to call `LocalWorkspace.createOrSelectStack`, whose implementation is
 *
 *     this.ready = workspace.selectStack(name).catch((err) => {
 *       if (err instanceof StackNotFoundError) return workspace.createStack(name);
 *       throw err;
 *     });                                        // automation/stack.js
 *
 * The restore step deletes and recreates the state bucket UNDER THE SAME NAME —
 * the strongest read-after-write staleness trigger Ceph/RGW has. `failover` and
 * `destroy` then read the recreated bucket, `stack select` 404'd, and the SDK
 * quietly ran `createStack`, writing an EMPTY checkpoint over the real state.
 * Downstream: failover reported "e4-standby: outputs object empty (fresh
 * stack)" against a live cluster and then failed twice trying to create servers
 * that already existed; final-destroy found e4-primary empty and correctly
 * reported UNVERIFIED. One stale read, two dead steps, and destroyed state.
 *
 * Crucially the `withStateBackendRetry` that already wrapped that call could
 * never have helped: the StackNotFoundError was swallowed INSIDE the SDK, so
 * the wrapper saw a successful call, not a failure to retry. That is why
 * `getOrCreateStack` now drives select and create itself — absence has to be a
 * decision we make on evidence, not one the SDK makes for us.
 */
function isStackNotFoundError(err) {
  return err?.name === 'StackNotFoundError' || /no stack named/i.test(err?.message || '');
}

/**
 * One-line summary of a Pulumi error that is actually about the error.
 *
 * The automation API's `CommandResult.toString()` envelope is
 * `code: N\n stdout: …\n stderr: …\n err?: …`, so the near-universal
 * `err.message.split('\n')[0]` yields the literal string `code: -2` and throws
 * away everything that matters. That is exactly what the failover output showed
 * for both of its `pulumi up` failures ("Provisioning failed (code: -2)"),
 * leaving the 2026-08-06 RCA to be reconstructed from perf timings.
 *
 * Prefers the first top-level `error:` line, then a panic banner, then the
 * first line — and never returns a bare envelope header.
 */
export function summarizePulumiError(err) {
  const msg = (err instanceof Error ? err.message : String(err ?? '')) || '';
  return summarizeCommandError(msg) || String(err ?? '');
}

/**
 * Create or select a stack with the given name + inline program. Returns
 * the Stack instance (caller drives up/destroy/refresh).
 *
 * @param {object} [options.requireExisting] - When true the stack MUST already
 *   exist: a `no stack named` answer is polled through as staleness and, if it
 *   persists, throws (with `.stackNotFound = true`) instead of creating. Every
 *   caller that operates on EXISTING infrastructure must set this — creating a
 *   stack for them silently destroys state. See `isStackNotFoundError`.
 */
export async function getOrCreateStack(stackName, program, options = {}) {
  // The choke point for every decrypting Pulumi call: the project's state
  // passphrase is checked (or made, on a new project) before any workspace
  // exists, and an existing stack's state is read with it (probeStackState)
  // before the stack is handed out. A caller that decrypts nothing (`stack rm
  // --force`) opts out of both with `decrypts: false`.
  let statePassphrase;
  if (options.decrypts !== false) {
    statePassphrase = await ensureStatePassphrase(projectDirOf(options));
  }
  recordStateOp('stack-select');
  const pulumiProject = requirePulumiProject(options);
  const backendUrl = resolveBackendUrl(options.s3Config, options.provider);
  const envVars = buildEnv({ ...options, statePassphrase });
  const stackArgs = { stackName, projectName: pulumiProject, program };
  const stackConfig = options.provider ? getProviderClass(options.provider).IAC_STACK_CONFIG : {};
  const wsOpts = {
    projectSettings: { name: pulumiProject, runtime: 'nodejs', backend: { url: backendUrl } },
    envVars,
    ...(Object.keys(stackConfig).length > 0 && {
      stackSettings: { [stackName]: { config: stackConfig } },
    }),
  };
  const requireExisting = options.requireExisting === true;

  // `pulumi stack select` reads the stack file from the S3 backend. On a
  // freshly-created (or freshly RE-created) state bucket, Hetzner Object
  // Storage throttles or 404s that read until the write propagates across its
  // frontends. Retry the transient spellings — and, when the caller says the
  // stack must already exist, poll through `no stack named` too, because there
  // it can only mean staleness.
  // Band-aid removal 2026-08-16: the staleness poll-throughs that lived on
  // this select are DELETED with their manufactured trigger. Buckets are no
  // longer deleted/recreated (retention), e2e reuses a warm bucket, and the
  // orchestrator's waitForBucketVisible gates HEAD+LIST before any select on a
  // genuinely-fresh first deploy. A 404 here now means what it says and fails
  // loudly with a named cause; only backpressure retries (via
  // classifyStateError).
  let stack;
  let created = false;
  try {
    stack = await withStateBackendRetry(
      () => LocalWorkspace.selectStack(stackArgs, wsOpts),
      `stack-select ${stackName}`,
    );
  } catch (err) {
    if (!isStackNotFoundError(err)) throw err;

    if (requireExisting) {
      // NEVER create here. This is the path `destroy`, `status`, `scale` and
      // `failover` take, and creating an empty stack for them is how real
      // state gets destroyed (see the RCA on `isStackNotFoundError`).
      const notFound = new Error(
        `Pulumi stack "${stackName}" was not found in the configured state backend ` +
          `(${backendUrl.replace(/\?.*$/, '')}). Refusing to create an empty stack in its ` +
          'place: that would overwrite whatever real state the backend holds. Verify the ' +
          'backend and credentials match the ones the deploy used, then retry. ' +
          `Underlying: ${summarizePulumiError(err)}`,
      );
      notFound.stackNotFound = true;
      notFound.cause = err;
      throw notFound;
    }

    // Create-allowed path (first deploy). A `no stack named` here is NOT
    // retried — a genuinely new stack must not pay a backoff ladder — so the
    // absence has to be CORROBORATED by an independent read before we write an
    // empty checkpoint. `stack ls` is a different backend operation (LIST, not
    // GET of one key), so a frontend that 404s the stack file may still list
    // it. If it does, the select was stale and creating would clobber.
    let known = [];
    try {
      known = await listStacks(options);
    } catch {
      /* unknown — fall through to create, as before */
    }
    if (known.includes(stackName)) {
      // The CORROBORATION stays — it is a correctness guard, not a retry
      // (creating an empty stack over listed real state is the disaster class
      // b924bac2 fixed). What changed 2026-08-16: instead of polling the
      // stale read into submission, this now FAILS LOUDLY. The backend
      // contradicting itself (lists the stack, 404s its file) is a store
      // fault the operator must see, not one we paper over.
      throw new Error(
        `Pulumi stack "${stackName}": the backend LISTS this stack but reading its file ` +
          `404'd. Refusing to create an empty stack over what the listing says is real ` +
          'state. This is a state-store consistency fault — retry, and if it persists, ' +
          `inspect the bucket directly. Underlying: ${summarizePulumiError(err)}`,
      );
    }
    stack = await withStateBackendRetry(
      () => LocalWorkspace.createStack(stackArgs, wsOpts),
      `stack-create ${stackName}`,
    );
    created = true;
  }
  if (statePassphrase) {
    const probeKey = `${backendUrl}\n${pulumiProject}\n${stackName}`;
    // A stack this open just created was made with the project's passphrase
    // and holds nothing to migrate, and reading its checkpoint back this
    // soon is a read-after-write the store may not answer yet: it counts as
    // read. The up that follows reads it as it always has.
    if (created) stateProbes.set(probeKey, Promise.resolve());
    else await probeStackState(stack, probeKey, statePassphrase, projectDirOf(options));
  }
  return stack;
}

/**
 * Stacks this process has read with the project's passphrase, by backend URL,
 * project and stack: the settled promise of that first read (or, while it
 * runs, the read itself, so a concurrent open waits for it instead of
 * migrating the same stack twice). A failed read is forgotten.
 * @type {Map<string, Promise<void>>}
 */
const stateProbes = new Map();

/**
 * Stacks (by probe key) whose migration THIS process started and that then
 * stopped the open with an error. The child can finish re-encrypting and still
 * exit non-zero, so the next open in this process may find the state already
 * readable; it says what the failed one could not. A run that never tried
 * stays out of it: only the process that migrated announces. REMOVE AFTER
 * 2027-02-11 with the migration.
 * @type {Set<string>}
 */
const migrationsAttempted = new Set();

const MIGRATED_NOTICE = (name) =>
  `Your Pulumi state for ${name} was stored with an empty passphrase. vibecarbon re-encrypted it with this project's passphrase.`;

/**
 * The deployment a stack's first-open probe exported, kept on the Stack
 * object that open returned, for the up path to read once instead of
 * exporting again (takeProbedDeployment).
 * @type {WeakMap<object, object>}
 */
const probedDeployments = new WeakMap();

/** Test-only: forget which stacks this process already read. */
export function __resetStateProbesForTests() {
  stateProbes.clear();
  migrationsAttempted.clear();
}

/**
 * The deployment `stack`'s probe exported, once: a second call, or any other
 * Stack object, gets null. Only the open that probed has it, and only that
 * open's caller reads it, before anything it does writes the state. A caller
 * that reads the state right after opening it takes this first and exports
 * only on null.
 * @param {object} stack
 * @returns {object|null}
 */
export function takeProbedDeployment(stack) {
  const deployment = probedDeployments.get(stack) ?? null;
  probedDeployments.delete(stack);
  return deployment;
}

/**
 * Read an existing stack's state with the project's passphrase, once per
 * process per stack, before getOrCreateStack hands the stack out:
 *
 *   - it reads: the export is kept for the up path (takeProbedDeployment);
 *   - Pulumi refuses the passphrase: a legacy stack written with the empty
 *     one is migrated (readOrMigrateState), and any other state fails here
 *     with the StateUndecryptableError, at the open, before a refresh, up or
 *     destroy can surface Pulumi's raw text or act on half an answer. That is
 *     also what keeps `destroy` from ruling a legacy state unreadable and
 *     removing its record without reading it;
 *   - anything else fails the open as it is, unremembered, so the next open
 *     reads again.
 *
 * The probe is a full export (`stack export --show-secrets`): `stack output`
 * and a plain export succeed under a wrong passphrase whenever the secrets
 * sit in resources, not stack outputs (E5/E7, 2026-11-11), so neither can
 * tell. The retired-resource surgery's own export reads the same way, but it
 * runs on one provider only and after the open, so it never stands in for
 * this one; it reads this one's export instead.
 *
 * @param {object} stack - the Automation API Stack just selected
 * @param {string} key - backend URL, project and stack
 * @param {string} passphrase - the project's verified passphrase
 * @param {string} projectDir - the project it was verified for
 */
async function probeStackState(stack, key, passphrase, projectDir) {
  const earlier = stateProbes.get(key);
  if (earlier) {
    await earlier;
    return;
  }
  const read = readOrMigrateState(stack, passphrase, key, projectDir);
  const settled = read.then(() => undefined);
  // The failure reaches this caller through `read`; a concurrent opener
  // awaiting `settled` gets it too, and with none, nothing is left unhandled.
  settled.catch(() => {});
  stateProbes.set(key, settled);
  let deployment;
  try {
    deployment = await read;
  } catch (err) {
    if (stateProbes.get(key) === settled) stateProbes.delete(key);
    throw err;
  }
  probedDeployments.set(stack, deployment);
}

/** One full export of `stack`'s state, retried only on backpressure. */
function exportForProbe(stack) {
  return perfAsync('state.passphraseProbe', () =>
    withStateBackendRetry(() => stack.exportStack(), `state probe ${stack.name}`),
  );
}

/**
 * The probe's export, migrating a legacy stack first when the project's
 * passphrase is refused. Throws the StateUndecryptableError only when
 * neither passphrase opens it; the probe's own error for any other read
 * failure, and migrateFromEmptyPassphrase's for a migration that failed for
 * any other reason (a held lock, the store), so a stack '' still reads is
 * never ruled unreadable. A refusal right after a migration that exited 0 is
 * a StateMigrationError too (migratedButRefused).
 *
 * The migration is one-time, not a retry: it runs only on a refusal, once,
 * and its result is checked by reading the state again.
 *
 * @param {object} stack
 * @param {string} passphrase
 * @param {string} key the probe key (see migrationsAttempted)
 * @param {string} projectDir the project the passphrase belongs to
 * @returns {Promise<object>} the exported deployment
 */
async function readOrMigrateState(stack, passphrase, key, projectDir) {
  let refused;
  try {
    const deployment = await exportForProbe(stack);
    // A migration this process started finished after all (its child exited
    // non-zero on the way out): the user was told it stopped, so say it is done.
    if (migrationsAttempted.delete(key)) p.log.info(MIGRATED_NOTICE(stack.name));
    return deployment;
  } catch (err) {
    if (!isStatePassphraseFailure(err)) throw err;
    refused = err;
  }
  // REMOVE AFTER 2027-02-11, with migrateFromEmptyPassphrase: by then every
  // stack written with the empty passphrase has been opened (and so
  // re-encrypted) by a CLI that has this, and a refusal here just throws the
  // typed error below.
  const migration = await perfAsync('state.passphraseMigrate', () =>
    migrateFromEmptyPassphrase(stack, passphrase, key),
  );
  if (!migration.ok) {
    // '' was refused too. Another process may have re-encrypted the stack
    // between this one's read and its migration: then the project's
    // passphrase reads it now and '' no longer does. One more read tells
    // that apart from a state neither opens.
    try {
      const deployment = await exportForProbe(stack);
      // Only when this run's own attempt got as far as the child (it ended
      // non-zero, then the retry found '' refused): the state is the new
      // passphrase's because of this run. A pure race stays silent.
      if (migration.attempted) p.log.info(MIGRATED_NOTICE(stack.name));
      return deployment;
    } catch (err) {
      if (!isStatePassphraseFailure(err)) throw err;
    }
    const typed = passphraseRefusal(refused, stack.name, 'state read', projectDir);
    progressLog(
      `[pulumi] the empty passphrase older vibecarbon versions used doesn't open it either: ${migration.detail}`,
    );
    throw typed;
  }
  let deployment;
  try {
    deployment = await exportForProbe(stack);
  } catch (err) {
    if (isStatePassphraseFailure(err)) throw migratedButRefused(err, stack.name);
    throw err;
  }
  p.log.info(MIGRATED_NOTICE(stack.name));
  return deployment;
}

/**
 * The project's passphrase refused right after a re-encryption that exited
 * 0. That exit proves '' read the state, so it is not lost: the
 * re-encryption just didn't produce this passphrase (on CLI 3.259.0 an
 * empty stdin migrates '' to ''). Never the typed StateUndecryptableError,
 * which destroy removes a record on: a StateMigrationError naming the step,
 * with Pulumi's own line in the log only.
 *
 * @param {unknown} err the refused read
 * @param {string} stackName
 * @returns {StateMigrationError}
 */
function migratedButRefused(err, stackName) {
  const message = err instanceof Error ? err.message : String(err);
  progressLog(
    `[pulumi] state read after re-encrypting ${stackName}: ${summarizeCommandError(message)}`,
  );
  return new StateMigrationError(
    `Stopped after re-encrypting the Pulumi state for ${stackName}: Pulumi finished without an error, but this project's passphrase still can't read the state. ` +
      'The empty passphrase older vibecarbon versions used probably still opens it, so vibecarbon stopped here rather than treat the state as lost. ' +
      "Your Pulumi CLI may take the new passphrase in a way vibecarbon doesn't expect: run `pulumi version` and report it with this message.",
    { cause: err },
  );
}

/**
 * Re-encrypt a legacy stack's state, written with the empty passphrase every
 * stack had before the per-project one, with the project's passphrase:
 * `pulumi stack change-secrets-provider passphrase` in the stack's own
 * workspace (its Pulumi.yaml, backend and credentials). The Automation SDK
 * (3.274.1) has no changeSecretsProvider and its PulumiCommand.run takes no
 * stdin, so this spawns the binary itself. Measured on CLI 3.259.0 (M1,
 * 2026-11-11): about 0.5 s on a file:// backend; the new passphrase reads it
 * and '' no longer does; on a state '' cannot open it exits 1 and leaves the
 * state as it was.
 *
 * Unlike `stack export`, it writes the state, so it takes the stack's lock,
 * and the child's failures are sorted the way every other state write's are
 * (classifyStateError on its whole stderr):
 *
 *   - '' refused: resolves `{ ok: false, detail }` with Pulumi's line, for
 *     the caller to rule on;
 *   - a held lock: runPastStaleLock clears one whose holder is gone and runs
 *     the migration once more, and a live holder is StackHeldError;
 *   - backpressure: withStateBackendRetry's retries;
 *   - anything else, or what is left when those run out: a plain Error that
 *     names this step, never the typed error, so the open fails as it would
 *     for any other state fault and destroy keeps the stack's record.
 *
 * SECURITY: the new passphrase goes on stdin only. argv is readable by every
 * local user in a process listing, so it never carries it, and the child's
 * environment holds only the old one (''): the project's value and an
 * inherited PULUMI_CONFIG_PASSPHRASE_FILE (which would otherwise win) are
 * both dropped.
 *
 * REMOVE AFTER 2027-02-11 (see readOrMigrateState).
 *
 * @param {object} stack
 * @param {string} passphrase
 * @param {string} key the probe key (see migrationsAttempted)
 * @returns {Promise<{ ok: boolean, detail: string, attempted?: boolean }>}
 *   `attempted`: an earlier run of the child in this call ended for a reason
 *   other than the passphrase (so it may have written the state before it
 *   failed). A held or stale lock counts too, which can over-announce in the
 *   rare race where another process also migrated; it never under-announces.
 * @throws {StackHeldError} when a live run holds the stack's lock
 */
async function migrateFromEmptyPassphrase(stack, passphrase, key) {
  const step = `re-encrypting the Pulumi state for ${stack.name}`;
  // An empty stdin makes Pulumi re-encrypt '' with '' (CLI 3.259.0): the
  // state would stay as open as it was, under a migration that "worked".
  // ensureStatePassphrase never returns one; this holds the line anyway,
  // before the child, so nothing is written and nothing counts as attempted.
  if (typeof passphrase !== 'string' || passphrase.trim() === '') {
    throw new StateMigrationError(
      `Stopped before ${step}: this project's state passphrase is empty, and re-encrypting with it would leave the state as open as before. ` +
        "Put the project's passphrase in VIBECARBON_STATE_PASSPHRASE in .env.local, then run this again.",
    );
  }
  let attempted = false;
  try {
    await withStateBackendRetry(
      () =>
        runPastStaleLock(stack, () =>
          changeSecretsProvider(stack, passphrase).catch((err) => {
            if (!isStatePassphraseFailure(err)) attempted = true;
            throw err;
          }),
        ),
      step,
    );
    return { ok: true, detail: '' };
  } catch (err) {
    if (err instanceof StackHeldError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (isStatePassphraseFailure(err)) {
      return { ok: false, detail: summarizeCommandError(message), attempted };
    }
    migrationsAttempted.add(key);
    // Whether the child got as far as the import or not, the next open reads
    // the state with one passphrase or the other: named, so no reader takes
    // it for a passphrase failure or for "no stack".
    throw new StateMigrationError(
      `Stopped while ${step}: ${summarizeCommandError(message).replace(/\.$/, '')}. It may already be re-encrypted with this project's passphrase, so vibecarbon 0.52 and earlier may no longer open it. Running this again is safe.`,
      { cause: err },
    );
  }
}

/**
 * One `change-secrets-provider` run. Rejects with the child's whole stderr
 * as the message, so the classifier and lockHolders read every line, after
 * putting the stack's settings file back (snapshotStackSettings).
 *
 * @param {object} stack
 * @param {string} passphrase
 * @returns {Promise<void>}
 */
async function changeSecretsProvider(stack, passphrase) {
  const { workspace } = stack;
  const restoreSettings = snapshotStackSettings(workspace.workDir, stack.name);
  const result = await new Promise((resolve) => {
    let child;
    try {
      const env = { ...process.env, ...workspace.envVars, PULUMI_CONFIG_PASSPHRASE: '' };
      delete env.PULUMI_CONFIG_PASSPHRASE_FILE;
      delete env[STATE_PASSPHRASE_KEY];
      child = spawn(
        workspace.pulumiCommand.command,
        [
          'stack',
          'change-secrets-provider',
          'passphrase',
          '--stack',
          stack.name,
          '--non-interactive',
        ],
        { cwd: workspace.workDir, env, stdio: ['pipe', 'ignore', 'pipe'] },
      );
    } catch (err) {
      resolve({ error: err });
      return;
    }
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => resolve({ error: err }));
    child.on('close', (code) => resolve({ code, stderr }));
    // A child that exits before reading stdin closes the pipe (EPIPE); its
    // exit code already says what happened.
    child.stdin?.on('error', () => {});
    child.stdin?.end(passphrase);
  });
  if (result.code === 0) return;
  restoreSettings();
  if (result.error) throw result.error;
  throw new Error(result.stderr.trim() || `exited with code ${result.code}`);
}

/**
 * The stack's settings file in its workspace (Pulumi.<stack>.yaml, or the
 * .yml or .json the SDK also reads), and a function that puts it back as it
 * was, absent included.
 *
 * `change-secrets-provider` writes a new `encryptionsalt` there before it
 * touches the state, and a failed run leaves it behind: seen on CLI 3.259.0
 * (2026-11-11) for a held lock and for a refused passphrase alike. The file
 * lives in the workspace's own directory, which the SDK makes per workspace
 * (mkdtemp under the OS temp dir, never removed, never reused by a later
 * workspace) and which every later command on this Stack object runs in:
 * the stale-lock retry, the read after a refusal, and the caller's refresh,
 * up or destroy. A salt left there no longer matches the state; with a
 * secret value in the stack's config (vibecarbon sets none today), a second
 * run in that workspace was refused outright (review, 2026-11-11).
 *
 * @param {string} workDir
 * @param {string} stackName
 * @returns {() => void}
 */
function snapshotStackSettings(workDir, stackName) {
  const name = stackName.split('/').pop();
  const saved = ['.yaml', '.yml', '.json'].map((ext) => {
    const path = join(workDir, `Pulumi.${name}${ext}`);
    try {
      return { path, content: readFileSync(path) };
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      return { path, content: null };
    }
  });
  return () => {
    for (const { path, content } of saved) {
      if (content === null) rmSync(path, { force: true });
      else writeFileSync(path, content);
    }
  };
}

// The throttle recogniser that used to live here
// (STATE_BACKEND_THROTTLE_PATTERN) is gone: withStateBackendRetry's decision
// comes from classifyStateError, and keeping a second, wider pattern exported
// with no src consumer was pure drift surface (review finding, 2026-08-15).
// Its vocabulary lives on split into THROTTLE_PATTERN and
// LOCK_CONTENTION_PATTERN in state-error.js, which is the whole point — the
// old pattern could not tell server overload from our own lock contention.

export async function withStateBackendRetry(fn, desc, options = {}) {
  const attempts = options.attempts ?? 5;
  const baseMs = options.baseMs ?? 2000;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  // No extraPattern escape hatch (deleted 2026-08-16 with its last caller):
  // widening retryability past the classifier per call site is exactly how
  // band-aids accreted. The classifier is the ONLY authority on what retries.
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err?.message || String(err);
      // The retry decision comes from the single classifier: retry-in-place
      // is granted ONLY for backpressure (throttle) and our own recoverable
      // lock contention. Every staleness spelling fails loudly by name.
      // No local predicate here on purpose: the decision belongs to the
      // classifier, and a named boolean in this scope would be a second place
      // that looks like it decides.
      const { cause, recovery } = classifyStateError({ message: msg, operation: desc });
      if (attempt >= attempts || recovery !== 'retry-in-place') {
        throw err;
      }
      recordStateRetry(cause);
      const backoff = Math.min(baseMs * 2 ** (attempt - 1), 30_000);
      // Name the actual cause. Every one of these used to print "throttled"
      // regardless of which of seven signatures matched, so server overload and
      // lock contention we caused ourselves were indistinguishable in our own
      // logs — 38 of the 40 events in run 31898658781 were this one line.
      // Routed through progressLog so a retry updates an active spinner's line
      // instead of corrupting it; falls back to stderr when no spinner runs.
      progressLog(
        `[pulumi] ${desc}: state backend ${cause} (attempt ${attempt}/${attempts}), retrying in ${backoff}ms`,
      );
      await sleep(backoff);
    }
  }
}

// The up-path staleness widenings (UP_STATE_BACKEND_TRANSIENT_PATTERN — the
// lock-blob 404 and NoSuchBucket spellings) are DELETED (band-aid removal,
// 2026-08-16): both were fresh/recreated-bucket read-after-write, a trigger
// the root fixes removed. classifyStateError now fails them loudly by name.

// The history-write recogniser lives in state-error.js; alias for the tests
// that pin it under this module's historical name.
export const HISTORY_WRITE_FAILURE_PATTERN = HISTORY_WRITE_PATTERN;

/**
 * Read state back after a history-write failure to confirm the update landed.
 *
 * Returns the raw outputs when the stack reads clean and non-empty, else null
 * (caller propagates the original error). Non-empty is the bar: a stack whose
 * update just applied always exports outputs, so an empty read means we are
 * not looking at the state we think we are.
 *
 * Read-only, one probe, throttle-retry only (the staleness widenings are gone
 * with the rest of the band-aids, 2026-08-16): a failed verify propagates the
 * ORIGINAL error, which is the safe direction — the update is only reported
 * successful when its state reads back clean.
 */
async function verifyStateAfterHistoryWrite(stack) {
  try {
    const outputs = await withStateBackendRetry(() => stack.outputs(), 'post-update verify');
    if (!outputs || Object.keys(outputs).length === 0) return null;
    return outputs;
  } catch {
    return null;
  }
}

/**
 * `vultr:index/firewallRule:FirewallRule` inputs the pre-up refresh poisons.
 *
 * `source` is WRITE-"" / READ-CIDR asymmetric on Vultr. terraform-provider-
 * vultr v2.27.1 declares it `"" | "cloudflare"` — a rule SOURCE TYPE — but
 * the API's READ derives an ADDRESS from subnet/subnet_size and returns it
 * in the same field. `refresh` copies outputs into inputs, so after one
 * refresh the stack's INPUTS hold a value the provider's own schema
 * rejects.
 *
 * Proven on the live v2 rig (2026-08-20) by diffing two stacks of the same
 * deploy — the standby, which had only ever been created, against the
 * primary, which had been refreshed once:
 *
 *   standby (cold only)  inputs.source=''          outputs.source='0.0.0.0/0'
 *   primary (refreshed)  inputs.source='0.0.0.0/0' outputs.source='0.0.0.0/0'
 *
 * Both downstream failures come from that one poisoned input:
 *   - leave it, and `up` diffs it against a program that omits the field.
 *     `source` is ForceNew, so the diff REPLACES the rule; replacement is
 *     create-before-delete, so it POSTs a rule byte-identical to the live
 *     one and Vultr answers `{"error":"This rule is already defined"}`.
 *   - `ignoreChanges: ['source']` is worse, not better: it substitutes the
 *     STATE value for the program's, so `up` fails validation outright with
 *     `expected source to be one of ["" "cloudflare"], got 0.0.0.0/0`.
 * Both were tried live and failed; neither is a fix, because the bad value
 * must not survive the refresh at all.
 *
 * So the repair is to put inputs back the way a cold deploy leaves them.
 * Narrow on purpose — one resource type, one field, and only when the value
 * is outside the schema's own enum, so a legitimate `cloudflare` source
 * (which we never set today) would be left alone rather than clobbered.
 *
 * Remove this when terraform-provider-vultr stops returning an address in a
 * type field; `sourceEnum` below is the check that will start failing loudly
 * if the schema itself changes instead.
 */
const VULTR_FIREWALL_RULE_TYPE = 'vultr:index/firewallRule:FirewallRule';
const VULTR_RULE_SOURCE_VALID = new Set(['', 'cloudflare']);

/**
 * Undo the refresh's poisoning of vultr FirewallRule `source` inputs.
 *
 * No-op on every other provider and on any stack that holds no Vultr
 * firewall rules, and a no-op when the inputs are already clean — the
 * expensive importStack only runs when something actually changed.
 *
 * Never throws: this is a repair on the way to `up`, and `up`'s own error is
 * always a better thing to surface than a failure inside the repair.
 *
 * @param {import('@pulumi/pulumi/automation').Stack} stack
 * @returns {Promise<number>} count of inputs repaired
 */
export async function repairVultrFirewallRuleInputs(stack) {
  try {
    const state = await stack.exportStack();
    const resources = state?.deployment?.resources ?? [];
    let repaired = 0;
    for (const r of resources) {
      if (r?.type !== VULTR_FIREWALL_RULE_TYPE) continue;
      // BOTH sides, and outputs are the load-bearing half: Pulumi asks the
      // provider to diff the program's inputs against the resource's STORED
      // STATE (its outputs), so blanking inputs alone leaves `~source` on
      // the diff and the rule still replaces. Verified live 2026-08-20 —
      // an inputs-only repair logged "repaired 7" and the very same up
      // still failed every rule with "This rule is already defined".
      let touched = false;
      for (const side of ['inputs', 'outputs']) {
        const source = r?.[side]?.source;
        if (source === undefined || VULTR_RULE_SOURCE_VALID.has(source)) continue;
        r[side].source = '';
        touched = true;
      }
      if (touched) repaired++;
    }
    if (repaired > 0) {
      await withStateBackendRetry(() => stack.importStack(state), 'post-refresh state repair');
      progressLog(
        `[pulumi] repaired ${repaired} vultr firewall rule ${
          repaired === 1 ? 'input' : 'inputs'
        }: refresh had written an API-derived CIDR into \`source\`, which the provider rejects as input`,
      );
    }
    return repaired;
  } catch (err) {
    progressLog(`[pulumi] vultr firewall input repair warning: ${summarizePulumiError(err)}`);
    return 0;
  }
}

/**
 * Take the resources the provider's programs no longer declare
 * (`RETIRED_STACK_RESOURCES`) out of the stack's state, so the `up` or preview
 * that follows never deletes them (lib/iac/retired-resources.js says why).
 * Every `up` runs it before its refresh (prepareStackForUp), convergeClusterInfra
 * before its preview, and the deploy before it releases a retired address
 * (lib/deploy/k8s/retired-reserved-ip.js), so deploy, scale and failover all
 * do. A no-op, and no import, when nothing matches: every provider but
 * DigitalOcean, and a DigitalOcean stack already without them.
 *
 * `recordAddresses` gets the addresses taken out, before the import: the
 * stack is their last record, and the deploy and destroy release them only
 * by the address the environment's record keeps.
 *
 * The import takes the stack's lock. A lock whose holder is gone is cleared
 * (runPastStaleLock); one a live run holds stops here with StackHeldError,
 * unchanged, so the caller can tell "in use" from "unreadable".
 *
 * Throws, unlike the Vultr repair above: a stack it could not read or write
 * back may still hold the resources, and the `up` would then delete them.
 * Nothing in the cloud has changed when it throws, so a rerun is safe.
 *
 * @param {import('@pulumi/pulumi/automation').Stack} stack
 * @param {string|undefined} providerId
 * @param {{recordAddresses?: (addresses: string[]) => unknown}} [options]
 * @returns {Promise<{removed: string[], addresses: string[], deployment: object|null}>}
 *   `removed`: the URNs taken out. `deployment`: the stack's state as it now
 *   stands (after the import, or as exported when nothing matched), null
 *   when the provider retires nothing and no export ran.
 */
export async function dropRetiredStackResources(stack, providerId, { recordAddresses } = {}) {
  const retired = providerId ? (getProviderClass(providerId).RETIRED_STACK_RESOURCES ?? []) : [];
  if (retired.length === 0) return { removed: [], addresses: [], deployment: null };
  let result;
  try {
    // The open that returned `stack` has just read its state (the probe in
    // getOrCreateStack): use that read rather than export a second time.
    const state =
      takeProbedDeployment(stack) ??
      (await withStateBackendRetry(() => stack.exportStack(), 'retired-resource export'));
    result = dropStackResources(state, retired);
    if (result.removed.length > 0) {
      if (recordAddresses && result.addresses.length > 0) await recordAddresses(result.addresses);
      await withStateBackendRetry(
        () => runPastStaleLock(stack, () => stack.importStack(result.deployment)),
        'retired-resource import',
      );
    }
  } catch (err) {
    if (err instanceof StackHeldError) throw err;
    throw new Error(
      `Could not take the retired reserved IP out of stack "${stack.name}"'s state, so ` +
        'Pulumi was not run: it would have deleted that address while your domain may still ' +
        `point at it. Nothing changed in the cloud; run the command again. Underlying: ${summarizePulumiError(err)}`,
      { cause: err },
    );
  }
  if (result.removed.length > 0) {
    progressLog(
      `[pulumi] took ${result.removed.map((urn) => urn.split('::').pop()).join(' and ')} out of ` +
        `${stack.name}'s state: the address stays assigned until a deploy releases it`,
    );
  }
  return { removed: result.removed, addresses: result.addresses, deployment: result.deployment };
}

/**
 * Run `pulumi up` and return the raw outputs. Streams Pulumi logs to an
 * optional `onOutput` sink so callers can forward progress to a spinner.
 * `options.recordRetiredAddresses` records the addresses the retired-resource
 * surgery takes out of the stack (dropRetiredStackResources).
 */
async function upStackImpl(stackName, program, options = {}) {
  // `options.perfStem` is the caller's own perf timer name (e.g.
  // `deploy.k3s.iac.upStack`); the markers below hang off it so every arm of
  // a deploy stays distinguishable.
  const prepare = options.perfStem ? perfTimer(`${options.perfStem}.prepare`) : null;
  const stack = await prepareStackForUp(stackName, program, options);
  prepare?.end();
  return runUp(stack, options);
}

/**
 * Select (or create) the stack and bring its state up to date for `up`:
 * refresh a populated stack, repair what the refresh poisons.
 */
async function prepareStackForUp(stackName, program, options) {
  const stack = await getOrCreateStack(stackName, program, options);
  // Before the refresh too: refreshing ReservedIpAssignment drops it from
  // state on its own when the API reports the IP elsewhere, and that is not a
  // decision to leave to a Read.
  const surgery = await dropRetiredStackResources(stack, options.provider, {
    recordAddresses: options.recordRetiredAddresses,
  });
  recordStateOp('refresh');

  // Refresh state before `up` to purge pending operations from a crashed
  // prior run. Without this, Pulumi's `up` with "N pending operations
  // from previous deployment" warnings can trigger a delete-before-replace
  // on resources that don't actually exist in the cloud, hitting provider
  // panics. The Firewall Delete path is the verified example: hcloud-go's
  // `FirewallClient.GetByID` returns `(nil, resp, nil)` on a 404, and
  // terraform-provider-hcloud's `resourceFirewallDelete` then evaluates
  // `len(firewall.AppliedTo)` with no nil check — a nil-pointer dereference
  // whenever the firewall is in state but already gone from the cloud.
  // Re-verified against provider v1.68.0 / hcloud-go v2.47.0, the versions
  // @pulumi/hcloud 1.41.0 bridges, so this is current, not historical.
  // `refresh` reconciles state with live cloud resources and clears the
  // pending-op markers. Idempotent — no-op when state already matches reality.
  //
  // Skip on truly-empty stacks: a freshly-created stack has only the
  // bookkeeping `pulumi:pulumi:Stack` resource (no real cloud resources
  // to reconcile). Refresh still pays plugin spawn + cloud API listing,
  // ~3-8s on cold compose deploys for nothing. exportStack() failure
  // falls through to the safer always-refresh path.
  // Read the state at most once per up: the surgery above already did on a
  // provider that retires resources (DigitalOcean, from the open's probe),
  // and the open's probe did on the first open of this stack in the process.
  let needsRefresh = true;
  try {
    const state = surgery.deployment ?? takeProbedDeployment(stack) ?? (await stack.exportStack());
    const resources = state?.deployment?.resources ?? [];
    needsRefresh = resources.some((r) => r.type !== 'pulumi:pulumi:Stack');
  } catch {
    /* exportStack failed — fall through and refresh as before */
  }
  if (needsRefresh) {
    try {
      await withStateBackendRetry(
        () =>
          runPastStaleLock(stack, () =>
            stack.refresh({ onOutput: options.onOutput, color: 'never' }),
          ),
        'pre-up refresh',
      );
    } catch (err) {
      if (err instanceof StackHeldError) throw err;
      // A passphrase the state refuses here refuses the up the same way:
      // stop with the error that says what still works.
      if (isStatePassphraseFailure(err)) {
        throw passphraseRefusal(err, stackName, 'pre-up refresh', projectDirOf(options));
      }
      // refresh can fail if the state file is completely corrupt or a
      // resource is unreachable. Log and proceed — `up` may still succeed
      // or surface a cleaner error.
      progressLog(`[pulumi] pre-up refresh warning: ${summarizePulumiError(err)}`);
    }
    // The refresh above is what makes this necessary — see the function's
    // own doc. Runs whether or not the refresh threw: a partially-applied
    // refresh poisons state just as thoroughly as a complete one.
    await repairVultrFirewallRuleInputs(stack);
  }
  return stack;
}

/** The `up` itself and its post-mutation recovery. */
async function runUp(stack, options) {
  // The up path widens what counts as transient to the two fresh-bucket
  // read-after-write spellings — a 404 of the state bucket itself, and a 404 of
  // the CLI's own just-written lock blob. Both are retried in place here; see
  // UP_STATE_BACKEND_TRANSIENT_PATTERN for the evidence and the safety
  // analysis. Destroy-path ops must still treat these as real.
  let rawOutputs;
  let summary;
  // Per-resource timing from the engine event stream; only when perf tracing
  // is on and the caller named its timer. The handler cannot throw.
  const resourceTimer =
    options.perfStem && perfEnabled()
      ? createResourceTimer({ stem: options.perfStem, record: perfRecord })
      : null;
  // Size and region each droplet was asked for: a create DO refuses is never
  // written to state, so an out-of-stock message can only name them from here.
  const dropletPlans = createDropletPlanRecorder();
  try {
    // A `up` that failed on an S3 `SlowDown` may have already acquired the stack
    // lock before erroring. Its process has exited by the retry, so the retry
    // gets past that lock the same way it gets past any other dead run's.
    const result = await withStateBackendRetry(
      () =>
        runPastStaleLock(stack, () => {
          resourceTimer?.begin();
          return stack.up({
            onOutput: options.onOutput,
            color: 'never',
            onEvent: (event) => {
              dropletPlans.onEvent(event);
              resourceTimer?.onEvent(event);
            },
          });
        }),
      'up',
    );
    rawOutputs = result.outputs || {};
    summary = result.summary;
  } catch (err) {
    // Anything that reaches here survived the retry wrapper above, so the
    // lock-blob variant of the staleness class never lands in this catch — it
    // is retried in place. Two things do land here, and neither is blindly
    // retryable:
    //
    //  A. a failed `.pulumi/history/` write after a fully applied update —
    //     bookkeeping, not state (see HISTORY_WRITE_FAILURE_PATTERN); and
    //  B. a failed READ of state, which a stale frontend can produce in TWO
    //     windows needing OPPOSITE recoveries.
    //
    // Both need the same first answer — WHICH pulumi command failed (the
    // automation API embeds the argv in the error; see
    // `failingPulumiCommandVerb`) — so resolve it once up front. For (B) the
    // verb IS the discriminator between the two windows:
    //
    //  - PRE-mutation (`pulumi up` itself): the up CLI failed while reading
    //    state, before the engine loads the program or starts a provider
    //    plugin, so nothing was mutated. Three spellings, one window — the
    //    stack-file 404 (2026-07-31, compose e1), the checkpoint-load 404 and
    //    the diy nil-deref panic (both 2026-08-06, k8s-ha e4). A read-only poll
    //    cannot help here — it returns empty on a fresh stack, or the PRIOR
    //    outputs on a populated one — so this window gets ONE guarded re-run
    //    and nothing else.
    //
    //  - POST-mutation (`pulumi stack output`): Stack.up runs the output read
    //    AFTER the update itself succeeds, so a 404 there fails a deploy whose
    //    resources are fully provisioned (observed 2026-07-25 under Hetzner's
    //    standing Object-Storage-timeout advisory). Re-running `up` could read
    //    the same stale 404 as EMPTY state and double-provision — recover with
    //    a read-only outputs poll and never re-run.
    //
    // The "never re-run up" doctrine therefore narrows to: never re-run up when
    // the failure came AFTER mutation. `reRunUpAfterStaleStartup` carries the
    // guards that keep the pre-mutation case honest, and returns null (→ the
    // read-only path below) whenever it cannot prove nothing was provisioned.
    const msg = err?.message || '';
    const isUp = failingPulumiCommandVerb(msg) === 'up';

    if (isUp && isHistoryWriteOnlyFailure(msg)) {
      // A THIRD window, and not a stale read at all: the update fully applied
      // and only its `.pulumi/history/` bookkeeping entry failed to save. See
      // HISTORY_WRITE_FAILURE_PATTERN. Verify state read-only rather than
      // re-running anything; the update is done and history is cosmetic.
      const verified = await verifyStateAfterHistoryWrite(stack);
      if (!verified) throw err;
      // Loud on purpose: this is the one path where we swallow a nonzero exit
      // and report success, so the operator must see both the decision and the
      // error it was made about.
      progressLog(
        '[pulumi] update applied; its history entry could not be saved ' +
          '(transient storage 403), state verified intact, continuing',
      );
      progressLog(
        `[pulumi] swallowed history-write error: ${
          msg.match(/^error:[^\n]*/m)?.[0] ?? '(unavailable)'
        }`,
      );
      rawOutputs = verified;
      // `summary` stays undefined — the up result never came back. No caller
      // reads it (all five upStack call sites take `.outputs` only).
    } else {
      // A refused passphrase gets the typed error, which says what still
      // works; passphraseRefusal logs Pulumi's own line once.
      if (isStatePassphraseFailure(err)) {
        throw passphraseRefusal(err, stack.name, 'up', projectDirOf(options));
      }
      // Band-aid removal 2026-08-16: the startup-staleness guarded re-run and
      // the post-up read-only reread that lived here are DELETED with their
      // manufactured trigger (fresh/recreated buckets under our own parallel
      // load — all root-fixed: retention, warm e2e bucket, a quiet new bucket,
      // project-scoped keys, fewer writes). Every staleness spelling now
      // fails loudly with its cause named by classifyStateError; only the
      // history-write adjudication above survives, because that failure is
      // evidenced EXTERNAL weather on a completed update.
      //
      // Before rethrowing, put the COMPLETE failure text in the deploy log:
      // callers compress to one line for the console (summarizePulumiError),
      // and a resource-level Diagnostics block that reaches no log at all is
      // an un-RCA-able failure (d4 run 1, 2026-08-28: both HA stacks died as
      // bare "error: update failed" while the causal 422 lived only in the
      // discarded message body). Bounded — the interesting lines lead.
      for (const line of (err?.message || String(err)).split('\n').slice(0, 120)) {
        progressLog(`[pulumi:error] ${line}`);
      }
      // A create the provider never finished (2026-10-20: a Hetzner hel1
      // server stuck at progress 0 for 70+ minutes) now fails at the program's
      // customTimeouts.create. Say so in one line that names the provider,
      // resource and location, with what to do next; the full text above is
      // already in the deploy log. The checkpoint read is best-effort: it only
      // adds the provider-side name and the location to the message.
      if (parseCreateTimeouts(msg).length > 0) {
        let resources = [];
        try {
          resources = (await stack.exportStack())?.deployment?.resources ?? [];
        } catch {
          /* unreadable state: the message falls back to the Pulumi name */
        }
        const stalled = createTimeoutError(err, { resources });
        if (stalled) throw stalled;
      }
      // DigitalOcean refused the create because the size went out of stock
      // after the catalog check. A definite answer, so one plain message and
      // no retry (the full text is in the log above).
      const outOfStock = sizeUnavailableError(err, { plans: dropletPlans.plans });
      if (outOfStock) throw outOfStock;
      throw err;
    }
  }
  // Flatten outputs: { foo: { value: 'bar', secret: false } } → { foo: 'bar' }
  const outputs = flattenOutputs(rawOutputs);

  // The requiredOutputs stale-read POLL that lived here is DELETED (band-aid
  // removal 2026-08-16). Callers still pass `requiredOutputs` and still hold
  // their hard gates; a "successful" up that hands back incomplete outputs is
  // now surfaced immediately with a named cause instead of being re-read into
  // silence — post-root-fix, an incomplete read is a store fault or a
  // regression, and either must be seen.
  const required = options.requiredOutputs ?? [];
  const missing = required.filter((k) => outputs[k] == null);
  if (missing.length > 0) {
    throw new Error(
      `Pulumi up for stack "${stack.name}" succeeded but its outputs are missing ` +
        `[${missing.join(', ')}]. The state read after the update is incomplete — a ` +
        'state-store fault or a program regression; not retried. Re-run the deploy.',
    );
  }
  return { outputs, summary };
}

/** Flatten { foo: { value: 'bar' } } → { foo: 'bar' } (null-safe). */
function flattenOutputs(rawOutputs) {
  const outputs = {};
  for (const [key, entry] of Object.entries(rawOutputs ?? {})) {
    outputs[key] = entry?.value;
  }
  return outputs;
}

/**
 * The project dir a stack open checks the passphrase in: the caller's, or the
 * working directory every command runs from (assertInProjectDir).
 * @param {{ projectDir?: string }} [options]
 */
function projectDirOf(options) {
  return options?.projectDir ?? process.cwd();
}

/**
 * The typed error for a passphrase refusal on `stackName` (worded for a
 * passphrase this run made when it did), after logging Pulumi's own one-line
 * text once. The typed error is what the operator acts on; the raw line is
 * what shows a misclassified failure for what it was. Pulumi's output never
 * carries the passphrase (it travels in the workspace environment, never in
 * argv).
 * @param {unknown} err
 * @param {string} stackName
 * @param {string} step
 * @param {string} projectDir
 */
function passphraseRefusal(err, stackName, step, projectDir) {
  progressLog(`[pulumi] ${step} refused the state passphrase: ${summarizePulumiError(err)}`);
  return undecryptable(err, stackName, projectDir);
}

/**
 * asStateUndecryptableError, told whether this process made the passphrase.
 * @param {unknown} err
 * @param {string} stackName
 * @param {string} projectDir
 */
function undecryptable(err, stackName, projectDir) {
  return asStateUndecryptableError(err, stackName, {
    madeThisRun: statePassphraseGeneratedThisRun(projectDir),
  });
}

/**
 * Run `pulumi destroy` and remove the stack. Idempotent — if the stack
 * doesn't exist the function resolves without error.
 *
 * Loud partial detection (M3 Task 9f): two live DO k8s destroys left
 * firewall/VPC/SSH-key/reserved-IP orphans while this function RESOLVED —
 * no thrown error, no per-resource Pulumi output. The Automation API's CLI
 * wrapper (`@pulumi/pulumi/automation/cmd.js`'s `exec()`) already throws on
 * a nonzero `pulumi destroy` exit code, so a hard mid-destroy failure was
 * never the reachable mechanism here — by the time we can inspect a
 * `DestroyResult`, the CLI itself already called the run a success. The
 * mechanism that reproduces the symptom is a stack-select/backend mismatch:
 * `createOrSelectStack` CREATES a fresh, empty stack whenever it can't find
 * the real one (e.g. destroy-time S3 credentials missing from the caller's
 * `s3Config`, silently falling back to the local `file://` backend — a
 * documented failure class, see destroy.js's `destroyS3Config` comment) —
 * `destroy` then runs against that empty stack, "succeeds" in ~1s with
 * nothing to delete, and the real cloud resources are never touched.
 *
 * IMPORTANT: the two checks below do NOT catch that mismatch mechanism.
 * Both compare the SAME stack object's own before/after state, and a
 * freshly-created wrong stack is legitimately empty on both sides of that
 * comparison — there is nothing internally inconsistent about it from this
 * function's point of view. This function has no way to know whether a
 * given stack SHOULD have held resources; only the caller does (via
 * envConfig). The actual fix for the reproduced incident lives at the
 * caller — see `recordPulumiDestroyOutcome` in destroy.js, which treats a
 * `resourceCount: 0` result as suspicious specifically when the calling
 * environment has recorded real infrastructure. What the two checks here DO
 * catch is a different, narrower class: Pulumi itself reporting/recording
 * an inconsistent outcome on a stack whose OWN state disagrees with its own
 * destroy result — worth guarding regardless, but not the incident's
 * mechanism.
 *   1. `result.summary.result` — Pulumi's own verdict for the update.
 *      Defensive (the CLI-exit throw above should already cover this), but
 *      the strongest direct signal if that ever stops holding.
 *   2. Resource-count cross-check — snapshot how many real resources
 *      (excluding the `pulumi:pulumi:Stack` bookkeeping entry) the stack
 *      held BEFORE destroy (same `exportStack()` read `upStack` already
 *      uses for its refresh-skip decision). If the stack held resources but
 *      `resourceChanges` records zero deletes, destroy could not have run
 *      cleanly against that stack's own state — throw rather than claim
 *      success. A genuinely-empty stack (fresh, or already destroyed — the
 *      idempotent re-run case, OR the wrong-stack-created-fresh incident
 *      case) legitimately shows zero-before/zero-deleted from THIS
 *      function's vantage point and is left alone here.
 *
 * On either failure the stack record is deliberately NOT removed, so a
 * retry (or the caller's own name/address backstop sweep) can still find
 * accurate state instead of a wiped one.
 */
export async function destroyStack(stackName, program, options = {}) {
  let stack;
  try {
    // requireExisting: destroy must NEVER conjure a stack. A stale select that
    // created an empty one is precisely how a destroy "succeeds" against
    // nothing while the real resources live on (2026-08-06 RCA).
    stack = await getOrCreateStack(stackName, program, { ...options, requireExisting: true });
  } catch (err) {
    // Durably absent — treat as a no-op so destroy is idempotent. Reaching
    // here now means the staleness window was polled through first.
    if (err?.stackNotFound || /no stack named/i.test(err.message || '')) {
      return { destroyed: false };
    }
    throw err;
  }
  // Refresh first so destroy tolerates resources that were already reaped
  // out-of-band (e.g. Hetzner server deleted by a prior partial destroy or
  // by direct API cleanup). Without this, hcloud returns 404 and pulumi
  // treats it as a hard error — surfaced in orphan-stack cleanup as
  // "server not found (not_found, ...)".
  try {
    await withStateBackendRetry(
      () =>
        runPastStaleLock(stack, () =>
          stack.refresh({ onOutput: options.onOutput, color: 'never' }),
        ),
      'pre-destroy refresh',
    );
  } catch (err) {
    if (err instanceof StackHeldError) throw err;
    // A passphrase that cannot open the state refuses every later step the
    // same way (exportStack, destroy, the read-back of what is left), so stop
    // here with the error that says what still works. The stack record stays.
    if (isStatePassphraseFailure(err)) {
      throw passphraseRefusal(err, stackName, 'pre-destroy refresh', projectDirOf(options));
    }
    progressLog(`[pulumi] pre-destroy refresh warning: ${summarizePulumiError(err)}`);
  }
  // DigitalOcean Droplets can list CSI volumes the cluster teardown is still
  // deleting. That is handled before this runs, against the live API, not in
  // state: the provider's Droplet delete re-reads `volume_ids` from DO and
  // ignores what state says (see lib/destroy/csi-detach.js).

  // Pre-destroy resource snapshot — see the loud-partial-detection doc
  // above. Best-effort: if exportStack itself fails, skip the resource-count
  // cross-check below rather than guessing.
  let resourceCountBefore = null;
  try {
    const state = await stack.exportStack();
    const resources = state?.deployment?.resources ?? [];
    resourceCountBefore = resources.filter((r) => r.type !== 'pulumi:pulumi:Stack').length;
  } catch {
    /* unknown — skip the cross-check, still rely on result.summary.result */
  }

  // continueOnError: without it Pulumi stops scheduling deletes at the first
  // resource error, so one failed Droplet strands every unrelated resource
  // in the stack (d4-standby, 2026-10-31: "1 deleted, 2 errored", master,
  // reserved IP, firewall and VPC never attempted). With it, everything that
  // does not depend on the failed resource is still deleted.
  let result;
  try {
    result = await withStateBackendRetry(
      () =>
        runPastStaleLock(stack, () =>
          stack.destroy({ onOutput: options.onOutput, color: 'never', continueOnError: true }),
        ),
      'destroy',
    );
  } catch (err) {
    if (err instanceof StackHeldError) throw err;
    if (isStatePassphraseFailure(err)) {
      throw passphraseRefusal(err, stackName, 'destroy', projectDirOf(options));
    }
    throw await describeDestroyFailure(stack, stackName, err);
  }

  if (result.summary?.result && result.summary.result !== 'succeeded') {
    throw new Error(
      `Pulumi destroy for stack "${stackName}" did not report a clean success ` +
        `(result=${result.summary.result}). Resources may remain: verify directly ` +
        'against the cloud provider before assuming they were destroyed.',
    );
  }
  const deleteCount = result.summary?.resourceChanges?.delete ?? 0;
  if (resourceCountBefore !== null && resourceCountBefore > 0 && deleteCount === 0) {
    throw new Error(
      `Pulumi destroy for stack "${stackName}" reported success but recorded zero ` +
        `deletions against a stack that held ${resourceCountBefore} resource(s): this ` +
        'looks like a state-backend mismatch (destroy ran against an empty stack, not ' +
        'the real one). Verify directly against the cloud provider; do not assume ' +
        'resources were destroyed.',
    );
  }

  await stack.workspace.removeStack(stackName);
  return { destroyed: true, resourceCount: resourceCountBefore ?? deleteCount };
}

/**
 * The provider's own complaint out of a failed `pulumi destroy`'s output.
 *
 * The Automation API error is the whole command envelope, and the generic
 * summarizer picks its first `error:` line, which for a destroy is the
 * stack's `error: update failed`: true, and useless to an operator. The
 * resource diagnostic below it is what says why. Falls back to the first
 * line of anything that is not a Pulumi diagnostic.
 *
 * @param {string} message
 * @returns {string}
 */
export function pulumiDestroyFailureCause(message) {
  const lines = String(message ?? '').split('\n');
  for (const line of lines) {
    const text = diagnosticText(line);
    if (text) return text;
  }
  return lines.find((l) => l.trim())?.trim() ?? '';
}

/**
 * The useful text of one Pulumi error line, or null. Skips the stack's own
 * `update failed` and the engine's `deleting urn:...` wrapper, and strips the
 * terraform-bridge location prefix.
 * @param {string} line
 * @returns {string|null}
 */
function diagnosticText(line) {
  const m = /^\s*(?:\*\s|error:\s)\s*(.+)$/.exec(line);
  if (!m) return null;
  const text = m[1]
    .replace(/^sdk-v2\/\S+:\s*/, '')
    .replace(/^sdk\.helper_schema:\s*/, '')
    .trim();
  if (!text || /^update failed$/i.test(text) || /^deleting urn:/i.test(text)) return null;
  return text;
}

/**
 * Each resource's own error, from the `Diagnostics:` block of a failed
 * `pulumi destroy`. The engine heads every resource's diagnostics with
 * `  <pkg>:<module>:<Type> (<logical name>):`, so the key is
 * `<pkg>:<module>:<Type>::<logical name>` (see `diagnosticKey` for the state
 * side). The stack's own entry is skipped: it only ever says `update failed`.
 *
 * @param {string} message
 * @returns {Map<string, string>}
 */
export function pulumiDiagnosticsByResource(message) {
  const map = new Map();
  const lines = String(message ?? '').split('\n');
  const start = lines.findIndex((l) => /^\s*Diagnostics:\s*$/.test(l));
  if (start < 0) return map;
  let key = null;
  for (const line of lines.slice(start + 1)) {
    const head = /^\s*([\w-]+:[\w/-]+:\w+) \((.+)\):\s*$/.exec(line);
    if (head) {
      key = head[1].startsWith('pulumi:pulumi:') ? null : `${head[1]}::${head[2]}`;
      continue;
    }
    if (!key || map.has(key)) continue;
    const text = diagnosticText(line);
    if (text) map.set(key, text);
  }
  return map;
}

/**
 * State type `digitalocean:index/droplet:Droplet` plus logical name `db` to
 * the diagnostics key `digitalocean:index:Droplet::db`.
 * @param {string} type
 * @param {string} logicalName
 */
function diagnosticKey(type, logicalName) {
  return `${String(type).replace(/^([^:]+):([^/:]+)\/[^:]+:(\w+)$/, '$1:$2:$3')}::${logicalName}`;
}

/**
 * Turn a failed destroy into an error that names what is left: every
 * resource still in the stack's state (read back after the failure), and
 * the provider's actual complaint. The original error rides along as
 * `cause` for the log. Reading the state back is best-effort: an
 * unreadable state yields `remainingResources: null`, which the caller
 * reports as "the whole stack is unverified".
 *
 * @param {import('@pulumi/pulumi/automation').Stack} stack
 * @param {string} stackName
 * @param {unknown} err
 * @returns {Promise<Error & { remainingResources: Array<{type: string, logicalName: string, name: string|null, id: string|null, error: string|null}>|null }>}
 */
async function describeDestroyFailure(stack, stackName, err) {
  const original = err instanceof Error ? err : new Error(String(err));
  let remainingResources = null;
  try {
    const state = await stack.exportStack();
    const diagnostics = pulumiDiagnosticsByResource(original.message);
    remainingResources = (state?.deployment?.resources ?? [])
      .filter((r) => r?.type && r.type !== 'pulumi:pulumi:Stack' && !r.type.startsWith('pulumi:'))
      .map((r) => {
        const logicalName = String(r.urn ?? '')
          .split('::')
          .pop();
        return {
          type: r.type,
          logicalName,
          name: r.outputs?.name ?? null,
          id: r.id ?? null,
          // Its own diagnostic, or null when it failed on nothing itself
          // (blocked behind a dependency, or never attempted).
          error: diagnostics.get(diagnosticKey(r.type, logicalName)) ?? null,
        };
      });
  } catch {
    /* state unreadable: the caller treats the whole stack as unverified */
  }
  const cause = pulumiDestroyFailureCause(original.message);
  const left =
    remainingResources === null
      ? 'its remaining resources could not be read back'
      : `${remainingResources.length} resource(s) remain in its state`;
  const error = new Error(`pulumi destroy for stack "${stackName}" failed, ${left}: ${cause}`, {
    cause: original,
  });
  error.remainingResources = remainingResources;
  return error;
}

/**
 * Remove a stack's state record WITHOUT running `pulumi destroy` — the
 * compose-side twin of the removal destroyStack performs for the k8s tiers.
 *
 * The compose tiers reap their cloud resources via direct provider APIs
 * (destroyComposeTier / destroyComposeHA match Pulumi's literal resource
 * names), so `pulumi destroy` never runs for them — and with the state
 * bucket retained across destroys (717d49e7), the stack file survives a
 * verified teardown still describing the deleted resources. The next deploy
 * of the same environment then selects that stale stack, and on providers
 * whose refresh cannot prune a deleted resource (terraform-provider-vultr
 * v2.27.1 errors instead of reporting not-found on a deleted firewall rule)
 * `pulumi up` tries to delete the stale resources against the live API and
 * fails on 404 — e2e run 32309395314's vultr compose restore, 2026-08-19.
 * State must be reconciled by the thing that deleted the resources, not
 * left for the next deploy's pre-up refresh to repair.
 *
 * `force: true` on the remove is deliberate: the state record still LISTS
 * resources (a non-forced remove refuses a non-empty stack), but the caller
 * only invokes this after every stack-resident resource is verified deleted:
 * removePulumiStackStateEffect in destroy.js removes the stack exactly when
 * the environment's entry goes (entryKeptReason, ENTRY_KEEP_BY_CLASS). A
 * leak a re-run cannot act on, such as a DNS record or a health check,
 * keeps neither; any line a re-run can act on keeps both.
 *
 * Idempotent: a durably-absent stack resolves `{ removed: false }`. Any
 * other select failure (backend/credential errors) propagates — silently
 * "succeeding" there would leave the stale stack in place with no signal.
 */
export async function removeStackState(stackName, options = {}) {
  let stack;
  try {
    // requireExisting: removal must NEVER conjure a stack — creating an empty
    // one here would itself be a state write against the real backend.
    stack = await getOrCreateStack(stackName, async () => ({}), {
      ...options,
      requireExisting: true,
      // Removing a stack decrypts nothing, so a lost passphrase must not
      // block tearing the state down.
      decrypts: false,
    });
  } catch (err) {
    if (err?.stackNotFound || /no stack named/i.test(err.message || '')) {
      return { removed: false };
    }
    if (await stateBucketConfirmedMissing(err, options)) {
      return { removed: false, stateBucketMissing: true };
    }
    throw err;
  }
  // A deploy that died mid-update leaves its lock, and a locked stack refuses
  // removal. Linode compose-ha, run 42261394446: the primary failed, the CLI
  // exited with the standby's `up` still running, and destroy reported its
  // state as a leak.
  await runPastStaleLock(stack, () => stack.workspace.removeStack(stackName, { force: true }));
  return { removed: true };
}

/**
 * True only when a stack-select failure says the state BUCKET does not exist
 * AND an independent check finds that bucket in no region of the store.
 *
 * A deploy that fails before the state bucket is created (excitingai,
 * 2026-10-16: wrong S3 keys, so no bucket was ever made) leaves an env whose
 * backend URL names a bucket that never existed. `pulumi stack select` then
 * fails with NoSuchBucket, and destroy recorded that as an UNVERIFIED
 * pulumi-stack and exited 2, though there is no state to remove.
 *
 * The error text alone is not enough: region-scoped stores answer a bucket
 * that lives in a different region with the same 404, so a wrong endpoint
 * would read as "absent" and hide real state. locateBucket asks every
 * region these keys can address (all of them on Hetzner, DigitalOcean and
 * Scaleway; the one cluster Vultr and Linode keys work on) and only returns
 * null when each one answered "not found"; any other answer (or no answer)
 * keeps the original error.
 * @param {Error} err
 * @param {{provider?: string, s3Config?: {stateBucket?: string, bucket?: string, accessKey?: string, secretKey?: string, stateBucketRegion?: string, region?: string}}} options
 * @returns {Promise<boolean>}
 */
async function stateBucketConfirmedMissing(err, options) {
  if (!/NoSuchBucket/.test(err?.message || '')) return false;
  const s3 = options.s3Config;
  const bucket = s3?.stateBucket ?? s3?.bucket;
  if (!bucket || !s3?.accessKey || !s3?.secretKey || !options.provider) return false;
  try {
    const { getObjectStorageProvider } = await import('../providers/index.js');
    const store = await getObjectStorageProvider(
      options.provider,
      s3.accessKey,
      s3.secretKey,
      s3.stateBucketRegion || s3.region,
    );
    return (await store.locateBucket(bucket)) === null;
  } catch {
    return false;
  }
}

/**
 * Read the current outputs of a stack without running an update. Used by
 * commands like `status`, `scale`, `failover` that need infra identifiers
 * (IPs, IDs) but shouldn't drift the state.
 */
export async function getStackOutputs(stackName, program, options = {}) {
  // requireExisting: `status`, `scale` and `failover` read this to learn what
  // is already deployed. A fabricated empty stack here reads as "fresh
  // cluster", which is how failover minted a new k3sToken and planned to
  // re-create a live standby (2026-08-06 RCA).
  const stack = await getOrCreateStack(stackName, program, { ...options, requireExisting: true });
  let raw;
  try {
    raw = await stack.outputs();
  } catch (err) {
    throw undecryptable(err, stackName, projectDirOf(options));
  }
  const outputs = {};
  for (const [key, { value }] of Object.entries(raw)) {
    outputs[key] = value;
  }
  return outputs;
}

/**
 * Classify a prior-outputs probe for the k3sToken probe-and-replay path.
 *
 * `scale.js` reads the prior stack outputs before constructing the real
 * Pulumi program so it can replay the deploy-time `k3sToken` and avoid
 * destructive userData drift (see the master-replace defense). The probe
 * has three observable outcomes:
 *
 *   - `recovered`: outputs has a non-empty k3sToken — replay it
 *   - `empty`:     outputs object exists but k3sToken is missing or empty —
 *                  legitimate when the stack is fresh (no prior `up`), but
 *                  also what we'd see if the deploy somehow skipped the
 *                  output declaration. Caller must not silently mint a
 *                  fresh token; the master-replace defense catches the
 *                  destructive case.
 *   - `errored`:   the probe call itself threw — backend unreachable,
 *                  expired creds, etc. Caller should surface loudly.
 *
 * Three failures are none of the three: they are rethrown. Each leaves a
 * state that still holds the cluster's token unread, and each can clear on a
 * later open in the same run, so treating it as "no token" would have the
 * caller mint one that the up (which opens the stack again) then carries
 * onto a live cluster whose new nodes cannot join:
 *
 *   - a passphrase failure (isStatePassphraseFailure): the one-time legacy
 *     migration re-encrypts a legacy stack on its first open;
 *   - a StateMigrationError: that migration stopped, and the child may have
 *     re-encrypted the state before it exited non-zero;
 *   - a StackHeldError: another run held the lock the migration needs, and
 *     may have finished (or migrated the stack itself) by the up's open.
 *
 * No I/O; the Pulumi state read happens upstream.
 *
 * @param {{ outputs?: Record<string, unknown> | null, error?: Error | null }} probe
 * @returns {{ status: 'recovered' | 'empty' | 'errored', priorK3sToken?: string, reason: string }}
 * @throws the probe's own error when it is one of those three
 */
export function classifyK3sTokenProbe({ outputs, error } = {}) {
  if (error) {
    if (isStatePassphraseFailure(error) || isStackOpenInterrupted(error)) throw error;
    // The probe reads Pulumi state, so its failures carry the same
    // `code: N\nstdout:…` envelope — first-line-only would report `code: -2`
    // as the reason a k3s-token recovery was refused.
    return { status: 'errored', reason: `probe threw: ${summarizePulumiError(error)}` };
  }
  if (!outputs || typeof outputs !== 'object') {
    return { status: 'empty', reason: 'no outputs returned' };
  }
  const token = outputs.k3sToken;
  if (typeof token === 'string' && token.length > 0) {
    return { status: 'recovered', priorK3sToken: token, reason: 'k3sToken present' };
  }
  const keys = Object.keys(outputs);
  return {
    status: 'empty',
    reason:
      keys.length === 0
        ? 'outputs object empty (fresh stack)'
        : `outputs missing k3sToken (keys=${keys.join(',')})`,
  };
}

/**
 * List stack names that exist in the configured backend for this project.
 * Used by `destroy` to surface orphans (stacks without a matching envConfig).
 * Returns an empty list if no backend is reachable yet.
 */
export async function listStacks(options = {}) {
  const pulumiProject = requirePulumiProject(options);
  const backendUrl = resolveBackendUrl(options.s3Config, options.provider);
  const envVars = buildEnv({ ...options, decrypts: false });
  try {
    const workspace = await LocalWorkspace.create({
      projectSettings: {
        name: pulumiProject,
        runtime: 'nodejs',
        backend: { url: backendUrl },
      },
      envVars,
    });
    const stacks = await workspace.listStacks();
    return stacks.map((s) => s.name);
  } catch {
    // No backend yet (fresh install) — no orphans possible.
    return [];
  }
}

/**
 * Open the state backend, which writes `.pulumi/meta.yaml` on a new bucket. An
 * HA deploy does this once before its two engines start, so they never both
 * initialize one backend: that race failed a k8s-ha deploy with `could not list
 * bucket: blob (code=NotFound): NoSuchKey` (2026-04-28), a failure nothing
 * retries.
 *
 * `pulumi whoami` is the cheapest operation that does it. On a new bucket, on
 * all five providers (2026-11-06): GET meta.yaml, LIST, PUT meta.yaml, LIST, in
 * 0.5 to 1.8 s, one request fewer than `pulumi stack ls`.
 *
 * Throws, unlike `listStacks`: nothing is provisioned yet, and a backend that
 * will not open now would only fail the pair later.
 *
 * @param {{ provider: string, s3Config: object, projectName: string }} options
 * @returns {Promise<void>}
 */
export async function openStateBackend(options) {
  recordStateOp('backend-open');
  const workspace = await LocalWorkspace.create({
    projectSettings: {
      name: requirePulumiProject(options),
      runtime: 'nodejs',
      backend: { url: resolveBackendUrl(options.s3Config, options.provider) },
    },
    envVars: buildEnv({ ...options, decrypts: false }),
  });
  await workspace.whoAmI();
}

/**
 * Two stacks' `upStack`s on one state bucket run side by side from the first
 * request, select and refresh included (state-lock.js header says why).
 */
export async function upStack(stackName, program, options = {}) {
  try {
    recordStateOp('up');
    return await upStackImpl(stackName, program, options);
  } finally {
    // Success AND failure: the failure log is where the budget-vs-consistency
    // question actually gets asked, so the cumulative counts must be there.
    emitStateTelemetry(`up ${stackName}`, options.provider);
  }
}
