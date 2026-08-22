/**
 * carbon-autoscaler config — load + validate the config contract mounted
 * from the `carbon-autoscaler-config` k8s Secret (key `config.json`), and
 * watch it for changes without requiring a service restart.
 *
 * loadConfig() validates the WHOLE document before throwing, listing every
 * missing/invalid field in one Error rather than stopping at the first —
 * Secret edits are hand-authored (or rendered once at deploy time) and a
 * single throw-per-run feedback loop is a bad experience for fixing a typo.
 *
 * Unknown top-level and per-group keys are tolerated (forward-compat): this
 * module only rejects fields it knows are wrong, never fields it doesn't
 * recognize.
 */

import { readFileSync, statSync } from 'node:fs';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateNodeGroup(name, group, errors) {
  const prefix = `nodeGroups.${name}`;

  if (!isPlainObject(group)) {
    errors.push(`${prefix}: must be an object`);
    return;
  }

  // Static floor + CA-on-top: the deploy pipeline provisions minSize nodes
  // directly (the "floor"), and cluster-autoscaler only ever scales ABOVE
  // that floor. A nonzero minSize here would mean the autoscaler could also
  // scale groups down into territory the floor already owns, so it's a hard
  // contract violation, not a preference.
  if (group.minSize !== 0) {
    errors.push(`${prefix}.minSize: static floor + CA-on-top: minSize must be 0`);
  }

  if (!Number.isInteger(group.maxSize) || group.maxSize < 0) {
    errors.push(`${prefix}.maxSize: must be an integer >= 0`);
  }

  for (const field of ['serverType', 'region', 'image', 'cloudInit']) {
    if (!isNonEmptyString(group[field])) {
      errors.push(`${prefix}.${field}: must be a non-empty string`);
    }
  }

  if (!isPlainObject(group.serverLabels)) {
    errors.push(`${prefix}.serverLabels: must be an object`);
  } else if (group.serverLabels['cluster-autoscaler/node'] !== name) {
    errors.push(
      `${prefix}.serverLabels['cluster-autoscaler/node']: must equal the group name ("${name}")`,
    );
  }

  if (!isPlainObject(group.nodeLabels)) {
    errors.push(`${prefix}.nodeLabels: must be an object`);
  }

  if (!Array.isArray(group.taints)) {
    errors.push(`${prefix}.taints: must be an array`);
  }

  if (!Number.isInteger(group.podsPerNode) || group.podsPerNode <= 0) {
    errors.push(`${prefix}.podsPerNode: must be an integer > 0`);
  }
}

/**
 * Validate a parsed config document. Returns an array of field-path-prefixed
 * problem strings — empty when the document is valid.
 */
export function validateConfig(config) {
  if (!isPlainObject(config)) {
    return ['config: must be a JSON object'];
  }

  const errors = [];

  for (const field of [
    'provider',
    'providerIdPrefix',
    'clusterName',
    'sshKeyName',
    'firewallName',
    'networkName',
  ]) {
    if (!isNonEmptyString(config[field])) {
      errors.push(`${field}: must be a non-empty string`);
    }
  }

  if (!isPlainObject(config.nodeGroups) || Object.keys(config.nodeGroups).length === 0) {
    errors.push('nodeGroups: must be a non-empty object');
  } else {
    for (const [name, group] of Object.entries(config.nodeGroups)) {
      validateNodeGroup(name, group, errors);
    }
  }

  return errors;
}

/**
 * Load, parse, and validate the config document at `path`. Throws ONE Error
 * whose message lists every missing/invalid field (precise field paths, one
 * per line) when validation fails.
 */
export function loadConfig(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`carbon-autoscaler config: cannot read ${path}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`carbon-autoscaler config: invalid JSON in ${path}: ${err.message}`);
  }

  const errors = validateConfig(parsed);
  if (errors.length > 0) {
    const list = errors.map((e) => `  - ${e}`).join('\n');
    throw new Error(`carbon-autoscaler config: ${errors.length} problem(s) in ${path}:\n${list}`);
  }

  return parsed;
}

/**
 * Watches a config file for changes via mtime polling (no fs.watch —
 * k8s Secret volume mounts update via atomic symlink swap, and fs.watch on
 * the mounted path doesn't reliably fire across that swap on all CSI
 * drivers; a cheap statSync().mtimeMs check on every Refresh RPC does).
 *
 * Resilience contract: if a reload fails (malformed JSON, invalid config —
 * e.g. a half-written Secret caught mid-propagation), reloadIfChanged()
 * rejects but the watcher keeps serving the last known-good config via
 * currentSync(). A bad edit must never take the service down; it should
 * just fail to apply until it's fixed.
 */
export class ConfigWatcher {
  constructor(path) {
    this.path = path;
    this._config = loadConfig(path);
    this._mtimeMs = statSync(path).mtimeMs;
  }

  /** Synchronously returns the last successfully loaded config. */
  currentSync() {
    return this._config;
  }

  /**
   * Re-reads the file if its mtime has moved since the last successful
   * load. Returns `{config, changed: false}` when nothing changed, or
   * `{config, changed: true}` with the newly loaded config when it did.
   * Throws (without mutating any state) if the file at the new mtime
   * fails to parse or validate — currentSync() keeps returning the
   * previous good config.
   */
  async reloadIfChanged() {
    const mtimeMs = statSync(this.path).mtimeMs;
    if (mtimeMs === this._mtimeMs) {
      return { config: this._config, changed: false };
    }

    const config = loadConfig(this.path);
    this._config = config;
    this._mtimeMs = mtimeMs;
    return { config, changed: true };
  }
}
