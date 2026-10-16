/**
 * Pure planning helpers for `vibecarbon scale` (k8s / k8s-ha).
 *
 * These functions carry NO side effects — no clack prompts, no SSH, no fetch,
 * no Pulumi. They translate parsed flags and resolved config into the plain
 * data shapes the orchestration code in src/scale.js consumes, which keeps the
 * two behaviors that matter most testable in isolation:
 *
 *   - the non-interactive `-yes`/`-type`/bounds flag matrix, and
 *   - the Pulumi programConfig assembly, whose output MUST stay byte-identical
 *     to what `deploy` produced or Pulumi plans a destructive replace of every
 *     node (etcd loss). See the extensive comments at the call site.
 */
import { DEFAULT_WORKER_MAX, DEFAULT_WORKER_MIN } from './deploy/utils.js';

/**
 * The per-role server types an existing k8s environment runs, from
 * .vibecarbon.json: each role's own type, else the unified `serverType`, else
 * the provider's default. `scale` and `convergeClusterInfra` both reuse these
 * for every role a run does not override, so the formula lives once here.
 *
 * @param {{ DEFAULT_COMPOSE_TYPE: string }} Provider
 * @param {Record<string, any>} envConfig
 * @returns {{ masterType: string, dbType: string, workerType: string }}
 */
export function currentRoleTypes(Provider, envConfig) {
  const fallbackType = envConfig.serverType || Provider.DEFAULT_COMPOSE_TYPE;
  return {
    masterType: envConfig.masterServerType || fallbackType,
    dbType: envConfig.dbServerType || fallbackType,
    workerType: envConfig.workerServerType || fallbackType,
  };
}

/** Short override key (scale's newValues) → the .vibecarbon.json key it replaces. */
const ROLE_TYPE_KEYS = /** @type {const} */ ([
  ['masterType', 'masterServerType'],
  ['dbType', 'dbServerType'],
  ['workerType', 'workerServerType'],
]);

/**
 * Refuse an ARM type persisted for any role `overrides` does not replace,
 * with the same guard message a flag gets. Persisted types passed the deploy
 * guard, but a hand edit of .vibecarbon.json afterwards would otherwise reach
 * Pulumi unchecked. vibecarbon is x86-64 only; see src/lib/deploy/platform.js.
 * Throws the provider's guard error; callers in an interactive flow print it
 * with p.log.error and exit 1.
 *
 * @param {{ DEFAULT_COMPOSE_TYPE: string, assertAmd64ServerType: (type: string, label: string) => void }} Provider
 * @param {Record<string, any>} envConfig
 * @param {{ masterType?: string|null, dbType?: string|null, workerType?: string|null }} [overrides]
 * @returns {{ masterType: string, dbType: string, workerType: string }} the current types
 */
export function assertPersistedRoleTypes(Provider, envConfig, overrides = {}) {
  const current = currentRoleTypes(Provider, envConfig);
  for (const [short, long] of ROLE_TYPE_KEYS) {
    if (overrides[short] != null) continue;
    Provider.assertAmd64ServerType(
      current[short],
      `.vibecarbon.json ${envConfig[long] ? long : 'serverType'}`,
    );
  }
  return current;
}

/**
 * Resolve the non-interactive scale plan from parsed flags.
 *
 * Returns `{ changes, newValues }` for the two scripted branches:
 *   - `-yes -type X`  → resize every node role to X (plus workerBounds when
 *     --min/--max are also present).
 *   - `-yes` + bounds → cluster-autoscaler bounds only.
 * Returns `null` when neither branch matches, signalling the caller to fall
 * back to the interactive multiselect prompt.
 *
 * `changes[]` elements are the string ids the caller dispatches on:
 * 'masterType' | 'dbType' | 'workerType' | 'workerBounds'.
 *
 * envConfig is accepted for signature parity with the interactive caller; the
 * non-interactive branches are a pure function of `parsed`.
 *
 * @param {{ yes?: boolean, type?: string|null, minWorkers?: number|null, maxWorkers?: number|null }} parsed
 * @param {object} envConfig
 * @returns {{ changes: string[], newValues: Record<string, unknown> } | null}
 */
export function planK8sScaleChanges(parsed, _envConfig) {
  const newValues = {};

  if (parsed.yes && parsed.type) {
    // `--type X` means "scale every node role to X" for parity with compose's
    // `--type X` (which resizes the one VPS).
    const changes = ['masterType', 'dbType', 'workerType'];
    newValues.masterType = parsed.type;
    newValues.dbType = parsed.type;
    newValues.workerType = parsed.type;
    // Allow --type and bounds to be combined in one invocation.
    if (parsed.minWorkers != null || parsed.maxWorkers != null) {
      changes.push('workerBounds');
      if (parsed.minWorkers != null) newValues.minWorkers = parsed.minWorkers;
      if (parsed.maxWorkers != null) newValues.maxWorkers = parsed.maxWorkers;
    }
    return { changes, newValues };
  }

  if (parsed.yes && (parsed.minWorkers != null || parsed.maxWorkers != null)) {
    // Bounds-only path: --min-workers and/or --max-workers without --type.
    const changes = ['workerBounds'];
    if (parsed.minWorkers != null) newValues.minWorkers = parsed.minWorkers;
    if (parsed.maxWorkers != null) newValues.maxWorkers = parsed.maxWorkers;
    return { changes, newValues };
  }

  return null;
}

/**
 * Assemble the Hetzner-k8s Pulumi programConfig. Its output MUST be
 * byte-identical to what deployK3s passed at deploy time — every field that
 * flows into a Server's `sshKeys`, `firewallIds`, `labels`, or `userData` is a
 * tripwire for a destructive replace, and replacing master wipes etcd.
 *
 * @param {object} inputs
 * @param {string} inputs.projectName
 * @param {string} inputs.environment          Cluster env (e.g. `prod`, `prod-primary`).
 * @param {string} inputs.sshPublicKey
 * @param {string[]} inputs.allowedCidrs        Operator CIDRs (SSH + k8s API).
 * @param {string|undefined} inputs.existingSshKeyId
 * @param {string} inputs.location              Cluster region.
 * @param {Record<string, unknown>} inputs.newValues   Plan output; may set *Type/*Workers.
 * @param {string} inputs.currentMasterType
 * @param {string} inputs.currentDbType
 * @param {string} inputs.currentWorkerType
 * @param {number|undefined} inputs.persistedMinWorkers   envConfig.minWorkers
 * @param {number|undefined} inputs.persistedMaxWorkers   envConfig.maxWorkers
 * @param {string} inputs.k3sVersion
 * @param {Record<string, string>} inputs.labels
 * @param {string} inputs.apiToken
 * @returns {object}
 */
export function buildProgramConfig({
  projectName,
  environment,
  sshPublicKey,
  allowedCidrs,
  existingSshKeyId,
  location,
  newValues,
  currentMasterType,
  currentDbType,
  currentWorkerType,
  persistedMinWorkers,
  persistedMaxWorkers,
  k3sVersion,
  labels,
  apiToken,
}) {
  return {
    projectName,
    environment,
    sshPublicKey,
    allowedSshIps: allowedCidrs,
    allowedK8sApiIps: allowedCidrs,
    // HA deploys share one Hetzner SshKey across primary + standby and pass
    // `existingSshKeyId` so neither stack manages the resource. Single-cluster
    // lets Pulumi own the SshKey (existingSshKeyId = undefined).
    existingSshKeyId,
    location,
    masterServerType: newValues.masterType ?? currentMasterType,
    dbServerType: newValues.dbType ?? currentDbType,
    workerServerType: newValues.workerType ?? currentWorkerType,
    // minWorkers is Pulumi's static worker floor; maxWorkers flows to the CA
    // patch (not consumed by Pulumi). Replay persisted values when the operator
    // didn't override, keeping Pulumi's worker-pool plan a no-op.
    minWorkers: newValues.minWorkers ?? persistedMinWorkers ?? DEFAULT_WORKER_MIN,
    maxWorkers: newValues.maxWorkers ?? persistedMaxWorkers ?? DEFAULT_WORKER_MAX,
    k3sVersion,
    labels,
    apiToken,
  };
}
