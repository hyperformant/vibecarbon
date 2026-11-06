/**
 * The operator's kubeconfig: one per cluster, `<project>/.vibecarbon/kubeconfig-<stack>`.
 *
 * Only the deploy writes it: fetchKubeconfig (src/lib/deploy/k8s/k3s.js)
 * copies the master's /etc/rancher/k3s/k3s.yaml and installs it through
 * installOperatorKubeconfig, and a resumed deploy brings its stored copy up to
 * date through upgradeKubeconfig; both replace the file atomically. Every
 * reader resolves the path through localKubeconfigPath and uses the file as it
 * is. tests/unit/deploy/kubectl-no-compression-census.test.ts holds the rules.
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
 * An older client ignores the unknown field (run on kubectl 1.23 to 1.25) and
 * just downloads more.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

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
 * The path of a cluster's operator kubeconfig. The one place the file is
 * named, and nothing more: every reader (shell, diagnose, scale, destroy,
 * configure, the post-deploy checks) uses the file exactly as it is. A
 * reader that rewrote it would race the deploy writing it: read the old copy,
 * lose the race to the deploy's rename, then rename its stale copy over the
 * new one (the old cluster's CA and address after a re-provision), or save a
 * partial copy for good. A kubeconfig an older CLI wrote just misses the
 * speedup until the next deploy fetches it again.
 *
 * @param {string} projectDir
 * @param {string} stack - the environment, or its HA stack (`<env>-primary`, `<env>-standby`)
 * @returns {string}
 */
export function localKubeconfigPath(projectDir, stack) {
  return join(projectDir, '.vibecarbon', `kubeconfig-${stack}`);
}

/**
 * Replace `path` with what `fill(tmp)` leaves in a temp file beside it, by a
 * rename, so a reader sees the old file or the new one, never a partial one.
 * The temp is created 0600 before anything is written into it (the content
 * is a cluster-admin client key) and is removed on every way out: a failed
 * fill leaves the old file as it was and nothing else behind.
 *
 * @param {string} path
 * @param {(tmp: string) => unknown | Promise<unknown>} fill
 */
async function replaceAtomically(path, fill) {
  const tmp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(tmp, '', { mode: 0o600, flag: 'wx' });
    await fill(tmp);
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Install the master's k3s.yaml as the operator's kubeconfig at `path`
 * (operatorKubeconfigText: the master's address, compression off), 0600.
 * `copyTo(tmp)` copies the master's file into a temp beside `path`; only a
 * complete copy is renamed into place. fetchKubeconfig is its only caller.
 *
 * @param {string} path
 * @param {string} masterIp
 * @param {(tmp: string) => Promise<unknown>} copyTo
 */
export async function installOperatorKubeconfig(path, masterIp, copyTo) {
  await replaceAtomically(path, async (tmp) => {
    await copyTo(tmp);
    writeFileSync(tmp, operatorKubeconfigText(readFileSync(tmp, 'utf-8'), masterIp));
  });
}

/**
 * A resumed deploy's own kubeconfig, brought up to date: the copy its last run
 * fetched (state's `k3s-kubeconfig` result), which an older CLI may have
 * written without `disable-compression`. Only the deploy calls it, since the
 * deploy is the file's writer; readers never do (localKubeconfigPath). A
 * missing file is left missing, and a current one is not rewritten.
 *
 * @param {string} path
 * @returns {Promise<string>} the same path
 */
export async function upgradeKubeconfig(path) {
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
  await replaceAtomically(path, (tmp) => writeFileSync(tmp, next));
  return path;
}
