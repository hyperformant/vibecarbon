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
 * - Pulumi's own secrets provider isn't used — secrets are resolved from
 *   the operator's environment (shell/CI, or the project's .env.local via
 *   bootstrapOperatorEnv); we pass them to programs as plain config.
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LocalWorkspace } from '@pulumi/pulumi/automation/index.js';
import { progressLog } from '../cli/progress.js';
import { getProviderClass } from '../providers/index.js';
import {
  classifyStateError,
  failingPulumiCommandVerb,
  HISTORY_WRITE_PATTERN,
  isHistoryWriteOnlyFailure,
} from './state-error.js';
import { withStateLock } from './state-lock.js';
import { emitStateTelemetry, recordStateRetry } from './state-telemetry.js';

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
  if (process.env.PULUMI_BACKEND_URL) {
    return process.env.PULUMI_BACKEND_URL;
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
 * AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY; our programs read any additional
 * config we pass through `stack.setConfig(...)`.
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
 * @param {string} [options.configPassphrase]
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
  // Inline programs don't need a passphrase — but Pulumi insists on one for
  // the secrets provider. A deterministic empty value keeps the automation
  // API happy without us caring about secrets encryption at the state level
  // (we never store secrets in Pulumi state; they flow in at program time).
  env.PULUMI_CONFIG_PASSPHRASE = options.configPassphrase || '';
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
  const lines = msg.split('\n');
  const errorLine = lines.find((l) => /^\s*error:/i.test(l));
  if (errorLine) return errorLine.trim();
  const panicLine = lines.find((l) => /^\s*panic:/i.test(l));
  if (panicLine) return panicLine.trim();
  const first = (lines[0] ?? '').trim();
  if (!/^code:\s*-?\d+$/i.test(first)) return first || String(err ?? '');
  // Bare envelope — surface the most informative slot we have instead.
  const stderrLine = lines.find((l) => /^\s*stderr:\s*\S/i.test(l));
  return (stderrLine ?? lines.filter(Boolean).join(' ')).trim() || msg.trim();
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
async function getOrCreateStackImpl(stackName, program, options = {}) {
  const pulumiProject = requirePulumiProject(options);
  const backendUrl = resolveBackendUrl(options.s3Config, options.provider);
  const envVars = buildEnv(options);
  const stackArgs = { stackName, projectName: pulumiProject, program };
  const wsOpts = {
    projectSettings: { name: pulumiProject, runtime: 'nodejs', backend: { url: backendUrl } },
    envVars,
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
  // longer deleted/recreated (retention), e2e reuses a warm bucket, the
  // orchestrator's waitForBucketVisible gates HEAD+LIST before any select on a
  // genuinely-fresh first deploy, and the per-bucket lock removed the
  // concurrent load. A 404 here now means what it says and fails loudly with a
  // named cause; only backpressure retries (via classifyStateError).
  try {
    return await withStateBackendRetry(
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
    return await withStateBackendRetry(
      () => LocalWorkspace.createStack(stackArgs, wsOpts),
      `stack-create ${stackName}`,
    );
  }
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
 * Run `pulumi up` and return the raw outputs. Streams Pulumi logs to an
 * optional `onOutput` sink so callers can forward progress to a spinner.
 */
async function upStackImpl(stackName, program, options = {}) {
  const stack = await getOrCreateStack(stackName, program, options);
  // Clear any stale update lock before `up` — when a prior run aborted
  // mid-flight (Ctrl-C, scenario timeout, background-task stop), Pulumi's
  // file backend leaves a `.lock.*` in the bucket and subsequent `up`
  // calls fail with:
  //
  //   error: the stack is currently locked by 1 lock(s). Either wait for
  //   the other process(es) to end or delete the lock file with
  //   `pulumi cancel`.
  //
  // Since e2e runs one scenario per stack at a time, it's always
  // safe to clear. `stack.cancel()` is idempotent (no-op if no lock).
  try {
    await stack.cancel();
  } catch {
    /* no lock — ignore */
  }

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
  let needsRefresh = true;
  try {
    const state = await stack.exportStack();
    const resources = state?.deployment?.resources ?? [];
    needsRefresh = resources.some((r) => r.type !== 'pulumi:pulumi:Stack');
  } catch {
    /* exportStack failed — fall through and refresh as before */
  }
  if (needsRefresh) {
    try {
      await withStateBackendRetry(
        () => stack.refresh({ onOutput: options.onOutput, color: 'never' }),
        'pre-up refresh',
      );
    } catch (err) {
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

  // The up path widens what counts as transient to the two fresh-bucket
  // read-after-write spellings — a 404 of the state bucket itself, and a 404 of
  // the CLI's own just-written lock blob. Both are retried in place here; see
  // UP_STATE_BACKEND_TRANSIENT_PATTERN for the evidence and the safety
  // analysis. Destroy-path ops must still treat these as real.
  let rawOutputs;
  let summary;
  try {
    const result = await withStateBackendRetry(async () => {
      // A `up` that failed on an S3 `SlowDown` (common on a freshly-created
      // dedicated state bucket, especially under the parallel HA primary+standby
      // deploys) may have already acquired the stack lock before erroring. The
      // retry would then fail with "stack is currently locked". Clear the lock
      // before EACH attempt — cancel() is idempotent and per-stack, so it's safe
      // under the parallel HA deploys (primary/standby are separate stacks).
      try {
        await stack.cancel();
      } catch {
        /* no lock — ignore */
      }
      return stack.up({ onOutput: options.onOutput, color: 'never' });
    }, 'up');
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
      // Band-aid removal 2026-08-16: the startup-staleness guarded re-run and
      // the post-up read-only reread that lived here are DELETED with their
      // manufactured trigger (fresh/recreated buckets under our own parallel
      // load — all root-fixed: retention, warm e2e bucket, per-bucket lock,
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
      () => stack.refresh({ onOutput: options.onOutput, color: 'never' }),
      'pre-destroy refresh',
    );
  } catch (err) {
    progressLog(`[pulumi] pre-destroy refresh warning: ${summarizePulumiError(err)}`);
  }

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

  const result = await withStateBackendRetry(
    () => stack.destroy({ onOutput: options.onOutput, color: 'never' }),
    'destroy',
  );

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
 * only invokes this after the out-of-band teardown verified every one of
 * them deleted (clean leak ledger — see removePulumiStackStateEffect in
 * destroy.js, which retains the stack as evidence on any other outcome).
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
    });
  } catch (err) {
    if (err?.stackNotFound || /no stack named/i.test(err.message || '')) {
      return { removed: false };
    }
    throw err;
  }
  await stack.workspace.removeStack(stackName, { force: true });
  return { removed: true };
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
  const raw = await stack.outputs();
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
 * Pure function; the Pulumi state read happens upstream.
 *
 * @param {{ outputs?: Record<string, unknown> | null, error?: Error | null }} probe
 * @returns {{ status: 'recovered' | 'empty' | 'errored', priorK3sToken?: string, reason: string }}
 */
export function classifyK3sTokenProbe({ outputs, error } = {}) {
  if (error) {
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
  const envVars = buildEnv(options);
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
 * Public entry points for the two operations the throttle evidence points at,
 * each serialized per state bucket.
 *
 * Of the 40 state-backend recovery events in run 31898658781's hetzner leg, 38
 * were throttle, and 35 of those came from these two: `up` 11, and
 * `stack-select` 24 across ci3, ci4-primary and ci4-standby — the last two
 * being the k8s-ha pair fanned out under Promise.all against ONE bucket.
 *
 * `destroyStack` and `getStackOutputs` are not wrapped here and do not need to
 * be: each calls `getOrCreateStack`, so their select phase is already covered,
 * and the lock is re-entrant so the nesting is free. Their own pulumi
 * invocations remain unserialized, which is deliberate for now — no observed
 * event came from them, and locking work we have no evidence for would cost
 * wall-clock to no measured end.
 *
 * The key is the backend URL, so distinct buckets never block each other.
 */
export async function getOrCreateStack(stackName, program, options = {}) {
  return withStateLock(
    resolveBackendUrl(options.s3Config, options.provider),
    `stack-select ${stackName}`,
    () => getOrCreateStackImpl(stackName, program, options),
  );
}

export async function upStack(stackName, program, options = {}) {
  try {
    return await withStateLock(
      resolveBackendUrl(options.s3Config, options.provider),
      `up ${stackName}`,
      () => upStackImpl(stackName, program, options),
    );
  } finally {
    // Success AND failure: the failure log is where the budget-vs-consistency
    // question actually gets asked, so the cumulative counts must be there.
    emitStateTelemetry(`up ${stackName}`, options.provider);
  }
}
