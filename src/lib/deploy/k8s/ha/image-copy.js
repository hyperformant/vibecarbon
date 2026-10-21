/**
 * k8s-ha: copy the app image from the primary cluster's registry into the
 * standby's, server to server over wg0. The operator uploads it only once.
 *
 * The copy runs on the standby DATABASE node, the only standby node on wg0
 * (10.99.0.2, the one source the registry relay admits), and only after the
 * tunnel is up. It reads the primary registry through the relay (GET/HEAD
 * only) and pushes into the standby master's registry over the standby
 * private network, then proves the two manifest digests match.
 */

import { progressLog } from '../../../cli/progress.js';
import { sshRun } from '../../../ssh.js';
import { MANIFEST_DIGEST_SH, parseLocalRegistryRef, standbyImageRef } from '../image-delivery.js';
import { REGISTRY_RELAY_SOURCE_HOST, withRegistryRelay } from './index.js';

const COPY_NAMESPACE = 'vibecarbon-imgcopy';

// host[:port]/repo[/repo]:tag, every character shell-safe, because the refs
// are written into the script unquoted.
const SAFE_REF = /^([A-Za-z0-9.-]+:[0-9]+)\/([a-z0-9._-]+(?:\/[a-z0-9._-]+)*):([A-Za-z0-9._-]+)$/;

function splitRef(ref) {
  const m = SAFE_REF.exec(String(ref ?? ''));
  if (!m) throw new Error(`not an image ref: ${ref}`);
  const [, host, repo, tag] = m;
  return { host, repo, tag, repoTag: `${repo}:${tag}` };
}

/**
 * The POSIX sh script the standby db node runs. Prints SRC_DIGEST=, DST_DIGEST=
 * and SKIPPED=1 or COPIED=1 on stdout; a failure prints `ERR=<cause>` on stderr
 * (exit 3: the primary has no such tag; exit 4: digest mismatch after the push).
 *
 * @param {object} o
 * @param {string} o.srcRef - the primary image, through the relay
 * @param {string} o.dstRef - the same repo:tag in the standby master's registry
 * @returns {string}
 */
export function buildImageCopyScript({ srcRef, dstRef }) {
  const src = splitRef(srcRef);
  const dst = splitRef(dstRef);
  const ctr = `k3s ctr -n ${COPY_NAMESPACE}`;
  return `set -eu
${MANIFEST_DIGEST_SH}
S=$(digest ${src.host} ${src.repo} ${src.tag})
if [ -z "$S" ]; then echo "ERR=primary registry has no ${src.repoTag}" >&2; exit 3; fi
echo "SRC_DIGEST=$S"
D=$(digest ${dst.host} ${dst.repo} ${dst.tag})
echo "DST_DIGEST=$D"
if [ "$D" = "$S" ]; then echo "SKIPPED=1"; exit 0; fi
trap '${ctr} images rm ${srcRef} >/dev/null 2>&1 || true' EXIT
${ctr} images pull --plain-http --all-platforms ${srcRef}
${ctr} images push --plain-http ${dstRef} ${srcRef}
D=$(digest ${dst.host} ${dst.repo} ${dst.tag})
if [ "$D" != "$S" ]; then echo "ERR=digest mismatch: primary $S, standby $D" >&2; exit 4; fi
echo "COPIED=1"
`;
}

/**
 * The one-line cause of a rejected sshRun: the script's `ERR=` payload, else
 * the first non-empty stderr line that is not an ssh `Warning:`, else the first
 * line of the message. Never the `Command failed: ssh …` argv when stderr has
 * something better.
 */
export function firstCauseLine(err) {
  const lines = String(err?.stderr ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const errLine = lines.find((l) => l.startsWith('ERR='));
  if (errLine) return errLine.slice('ERR='.length);
  const real = lines.find((l) => !l.startsWith('Warning:'));
  if (real) return real;
  return String(err?.message ?? err)
    .split('\n')[0]
    .trim();
}

function parseCopyOutput(out) {
  const kv = {};
  for (const line of String(out ?? '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return kv;
}

/**
 * Copy the primary's app image into the standby's registry. wg0 must be up.
 * The script runs exactly once; a failure throws one line,
 * `standby image copy failed: <cause>`.
 *
 * @param {object} o
 * @param {string} o.primaryRef - `<primaryMasterPrivateIp>:5000/<repo>:<tag>`
 * @param {string} o.primaryIp - primary master public IP
 * @param {string} o.standbyIp - standby master public IP
 * @param {string} o.primaryMasterPrivateIp
 * @param {string} o.standbyMasterPrivateIp
 * @param {string} o.standbyDbIp - standby database node public IP (runs the copy)
 * @param {string} o.sshKeyPath
 * @param {(script: string) => Promise<string>} [o.run] - test seam
 * @param {typeof withRegistryRelay} [o.relay] - test seam
 * @returns {Promise<{ digest: string, skipped: boolean }>}
 */
export async function copyAppImageToStandby({
  primaryRef,
  primaryIp,
  standbyIp,
  primaryMasterPrivateIp,
  standbyMasterPrivateIp,
  standbyDbIp,
  sshKeyPath,
  run,
  relay = withRegistryRelay,
}) {
  if (!standbyDbIp) throw new Error('copyAppImageToStandby: standbyDbIp is required');
  const { repoTag } = parseLocalRegistryRef(primaryRef);
  const script = buildImageCopyScript({
    srcRef: `${REGISTRY_RELAY_SOURCE_HOST}/${repoTag}`,
    dstRef: standbyImageRef({ primaryRef, standbyMasterPrivateIp }),
  });
  const exec =
    run ?? ((s) => sshRun(standbyDbIp, sshKeyPath, ['sh', '-s'], { input: s, timeout: 600_000 }));

  let out;
  try {
    out = await relay({ primaryIp, standbyIp, primaryMasterPrivateIp, sshKeyPath }, () =>
      exec(script),
    );
  } catch (err) {
    // A relay failure carries its pod phase and log on later lines; keep the
    // error one line and still show why.
    if (!err?.stderr) {
      const rest = String(err?.message ?? '')
        .split('\n')
        .slice(1)
        .join('\n')
        .trim();
      if (rest) progressLog(`[image-copy] ${rest}`);
    }
    throw new Error(`standby image copy failed: ${firstCauseLine(err)}`, { cause: err });
  }

  const kv = parseCopyOutput(out);
  const digest = kv.SRC_DIGEST;
  if (!digest || (kv.SKIPPED !== '1' && kv.COPIED !== '1')) {
    throw new Error(
      'standby image copy failed: the copy script reported neither SKIPPED nor COPIED',
    );
  }
  const skipped = kv.SKIPPED === '1';
  progressLog(
    skipped
      ? `[image-copy] standby already has ${digest}`
      : `[image-copy] copied ${repoTag} (${digest})`,
  );
  return { digest, skipped };
}
