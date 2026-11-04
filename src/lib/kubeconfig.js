/**
 * The operator's kubeconfig: one per cluster, `<project>/.vibecarbon/kubeconfig-<stack>`.
 *
 * fetchKubeconfig (src/lib/deploy/k8s/k3s.js) is its only writer: it copies the master's
 * /etc/rancher/k3s/k3s.yaml and stores it through operatorKubeconfigText.
 * Every reader resolves it through localKubeconfigPath (or, for a path a
 * resumed deploy kept in its state file, upgradeKubeconfig), so a kubeconfig
 * an older CLI wrote is brought up to date before kubectl or helm reads it.
 * tests/unit/deploy/kubectl-no-compression-census.test.ts holds both rules.
 *
 * Every cluster entry carries `disable-compression: true`. Measured against
 * live DO clusters (2026-11-03), `kubectl get --raw /openapi/v2` took 2.25 s
 * gzipped against 0.75 s uncompressed from tor1 and 0.87 s against 0.58 s
 * from sfo3; on an evening path to tor1 the 1.39 MB core OpenAPI document took
 * 12-17 s gzipped against 1.9 s. A cold deploy downloads about 4.7 MB of
 * OpenAPI documents per cluster, and a k8s-ha standby's `apply -k` of about 50
 * objects took 65 s against the primary's 9 s. Request bodies are never
 * compressed, so uploads are unaffected; only large GET/LIST responses grow,
 * and the deploy reads none of any size.
 *
 * kubectl and helm both honor the field (client-go 1.26+, verified with
 * kubectl 1.35 and helm 3.16: neither sends `Accept-Encoding: gzip` with it).
 * The deploy preflight already refuses kubectl older than 1.27
 * (KUBECTL_MIN_VERSION), and an older client ignores the unknown field.
 */
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FIELD = 'disable-compression';

/** Leading spaces of a line. */
const indentOf = (line) => line.length - line.trimStart().length;

/**
 * The kubeconfig text with `disable-compression: true` on every cluster entry
 * of the top-level `clusters:` list, and nothing else changed. A text edit
 * rather than a YAML round trip: the CLI ships no YAML library, and the
 * input is k3s's own block-style output. An explicit `false` becomes `true`.
 *
 * @param {string} text
 * @returns {string}
 */
export function withCompressionDisabled(text) {
  const lines = text.split('\n');
  const out = [];
  let inClusters = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    // A top-level key opens (or closes) the `clusters:` section. k3s writes
    // its list items at column 0 (`- cluster:`), so those are not keys.
    if (/^[^\s#-]/.test(line)) {
      inClusters = /^clusters:\s*$/.test(line);
      continue;
    }
    // A cluster entry's mapping: `- cluster:` or `  cluster:` with its fields
    // on the following, deeper-indented lines.
    if (!inClusters || !/^\s*(- )?cluster:\s*$/.test(line)) continue;
    const owner = indentOf(line) + (line.trimStart().startsWith('- ') ? 2 : 0);
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    if (j >= lines.length || indentOf(lines[j]) <= owner) continue;
    const fieldIndent = indentOf(lines[j]);
    let present = false;
    for (let k = j; k < lines.length; k++) {
      const l = lines[k];
      if (l.trim() === '') continue;
      if (indentOf(l) < fieldIndent) break;
      if (indentOf(l) === fieldIndent && l.trimStart().startsWith(`${FIELD}:`)) {
        lines[k] = `${' '.repeat(fieldIndent)}${FIELD}: true`;
        present = true;
      }
    }
    if (!present) out.push(`${' '.repeat(fieldIndent)}${FIELD}: true`);
  }
  return out.join('\n');
}

/**
 * The master's k3s.yaml as the operator stores it: its server points at the
 * master's public address (k3s writes 127.0.0.1, useless off the box) and
 * response compression is off.
 *
 * @param {string} k3sYaml
 * @param {string} masterIp
 * @returns {string}
 */
export function operatorKubeconfigText(k3sYaml, masterIp) {
  return withCompressionDisabled(
    k3sYaml.replace(/server: https:\/\/127\.0\.0\.1:6443/g, `server: https://${masterIp}:6443`),
  );
}

/**
 * Bring a kubeconfig on disk up to date in place: one an older CLI wrote has
 * no `disable-compression`. A missing file is left missing, and a current one
 * is not rewritten. The rewrite goes through a temp file and a rename, so a
 * concurrent reader never sees a partial file, and keeps the file 0600 (it
 * holds a cluster-admin client key).
 *
 * @param {string} path
 * @returns {string} the same path
 */
export function upgradeKubeconfig(path) {
  if (!path) return path;
  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    // Not deployed yet (or destroyed): the caller decides what a missing file means.
    if (err?.code === 'ENOENT') return path;
    throw err;
  }
  const next = withCompressionDisabled(text);
  if (next === text) return path;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, next, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return path;
}

/**
 * The path of a cluster's operator kubeconfig, upgraded in place when an older
 * CLI wrote it (upgradeKubeconfig). The one place the file is named.
 *
 * @param {string} projectDir
 * @param {string} stack - the environment, or its HA stack (`<env>-primary`, `<env>-standby`)
 * @returns {string}
 */
export function localKubeconfigPath(projectDir, stack) {
  return upgradeKubeconfig(join(projectDir, '.vibecarbon', `kubeconfig-${stack}`));
}

/**
 * Store the master's k3s.yaml, already copied to `path`, as the operator's
 * kubeconfig (operatorKubeconfigText), 0600: it embeds a cluster-admin client
 * cert and key, and scp leaves the operator's umask (0644 makes helm and
 * kubectl warn "Kubernetes configuration file is world-readable" on every
 * invocation).
 *
 * @param {string} path
 * @param {string} masterIp
 */
export function storeOperatorKubeconfig(path, masterIp) {
  writeFileSync(path, operatorKubeconfigText(readFileSync(path, 'utf-8'), masterIp));
  chmodSync(path, 0o600);
}
