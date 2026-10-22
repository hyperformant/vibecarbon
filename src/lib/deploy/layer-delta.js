/**
 * Image delivery by layer delta: send a deploy target only the app image
 * layers it does not already hold, keyed by diffID.
 *
 * The host saves the built image and asks the target which diffIDs it holds
 * (the runtime base it pulled from the registry at datacenter speed, and the
 * previous app image on a redeploy). It sends the manifest, the config, the
 * missing layers and a fill list over one ssh stdin stream. The target
 * (layer-delta-remote.sh) fills every held layer from its own store, loads the
 * complete archive, checks the loaded diffIDs against the manifest, and on k3s
 * pushes the result into the in-cluster registry.
 *
 * Facts this rests on (tests/integration/docker/layer-delta-roundtrip.test.ts):
 *   - a save's manifest.json Layers[i] pairs with its config rootfs.diff_ids[i].
 *     The file name is not the diffID: a containerd-store save or a ctr export
 *     names gzip layers by their compressed digest. Every pairing reads the
 *     archive's own manifest, never a name.
 *   - `docker load` (both stores) and `ctr images import` accept a legacy
 *     manifest.json-only archive whose layer files have any name and mixed
 *     gzip / uncompressed bodies. So the delta carries no OCI index.json: its
 *     manifest blob is not in the delta, and a loader that read it would fail.
 *   - images are compared across hosts by config digest or diffIDs, never by
 *     `.Id` or manifest digest (both differ by store and by compression).
 *
 * The app layers are gzipped on the host before they leave: the uplink carries
 * fewer bytes, and a k3s target's registry keeps them compressed for the
 * k8s-ha standby copy. A delta that sends every layer (a custom Dockerfile, an
 * empty target) is the same algorithm, not a fallback. A failure anywhere is
 * one line, `image delivery failed: <cause>`, and is never retried.
 */

import { spawn } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, constants as zlibConstants } from 'node:zlib';
import { knownHostsPathForKey, SSH_CONNECTION_OPTS } from '../host-keys.js';
import { NODE_RUNTIME_IMAGE } from '../images.js';
import { perfTimer } from '../perf.js';
import { shEscape } from '../shell.js';
import { acquireUplinkLock } from './uplink-lock.js';

/** The target half, shipped inline as `sh -c '<script>'` (nothing is staged). */
export const REMOTE_SCRIPT = readFileSync(
  new URL('./layer-delta-remote.sh', import.meta.url),
  'utf-8',
);

const UNCOMPRESSED_LABEL = /containerd\.io\/uncompressed=(sha256:[0-9a-f]{64})/;
const DIFF_ID = /^sha256:[0-9a-f]{64}$/;

class DeliveryError extends Error {
  constructor(cause) {
    super(`image delivery failed: ${cause}`);
    this.name = 'DeliveryError';
  }
}

/** The first line worth showing: ssh's host-key notice is not the cause. */
function firstLine(text) {
  return (
    String(text ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('Warning: Permanently added')) ?? ''
  );
}

/**
 * The image ref ctr gives an import named by `ref` in RepoTags (docker's
 * reference normalization): a registry host is kept, Docker Hub refs gain
 * `docker.io/` (and `library/` for one-part names), a missing tag is `latest`.
 *
 * @param {string} ref
 * @returns {string}
 */
export function normalizeImageRef(ref) {
  const slash = ref.indexOf('/');
  const first = slash === -1 ? '' : ref.slice(0, slash);
  const hasDomain = first.includes('.') || first.includes(':') || first === 'localhost';
  let out = hasDomain ? ref : `docker.io/${slash === -1 ? `library/${ref}` : ref}`;
  const lastPart = out.slice(out.lastIndexOf('/') + 1);
  if (!lastPart.includes(':') && !lastPart.includes('@')) out += ':latest';
  return out;
}

/**
 * Which layers the target already holds, each mapped to where the target can
 * read it back: an image to `docker save` (docker), or the layer blob's digest
 * in the k8s.io content store (k3s, read with `ctr content get`).
 *
 * docker: every image `docker image ls -a` lists, plus each of `refs` asked
 * for directly (classic Docker 29 does not list an image pulled by digest
 * alone without `-a`; asking for the base ref by name covers it on both
 * stores). Each diffID maps to the image holding the most layers, so the
 * target saves as few images as it can. k3s: the content store labels every
 * unpacked layer blob with its uncompressed digest, which is the diffID.
 *
 * @param {{run: (cmd: string) => Promise<string>, runtime?: 'docker' | 'k3s', refs?: string[]}} args
 * @returns {Promise<Map<string, string>>} diffID -> source
 */
export async function listTargetLayers({ run, runtime = 'docker', refs = [] }) {
  const layers = new Map();
  if (runtime === 'k3s') {
    // A shell default, not a JS template: `k3s ctr` on a node, VC_CTR in tests.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    const out = await run('${VC_CTR:-k3s ctr} -n k8s.io content ls');
    for (const line of out.split('\n')) {
      const digest = line.split(/\s+/)[0];
      const m = UNCOMPRESSED_LABEL.exec(line);
      if (m && DIFF_ID.test(digest) && !layers.has(m[1])) layers.set(m[1], digest);
    }
    return layers;
  }
  const fmt = shEscape('{{.Id}} {{range .RootFS.Layers}}{{.}} {{end}}');
  const cmd = [
    'set -e',
    'ids=$(docker image ls -a -q --no-trunc | sort -u)',
    `if [ -n "$ids" ]; then docker image inspect --format ${fmt} $ids; fi`,
    ...refs.map((r) => `docker image inspect --format ${fmt} ${shEscape(r)} 2>/dev/null || true`),
  ].join('; ');
  const images = (await run(cmd))
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter(([id]) => id)
    .map(([id, ...diffIds]) => ({ id, diffIds: diffIds.filter((d) => DIFF_ID.test(d)) }))
    .sort((a, b) => b.diffIds.length - a.diffIds.length);
  for (const { id, diffIds } of images) {
    for (const d of diffIds) if (!layers.has(d)) layers.set(d, id);
  }
  return layers;
}

/**
 * The set of diffIDs the target holds (see listTargetLayers).
 *
 * @param {{run: (cmd: string) => Promise<string>, runtime?: 'docker' | 'k3s', refs?: string[]}} args
 * @returns {Promise<Set<string>>}
 */
export async function listTargetDiffIds(args) {
  return new Set((await listTargetLayers(args)).keys());
}

/** manifest.json + config of an extracted `docker save`, paired by index. */
function readArchive(archiveDir) {
  const manifest = JSON.parse(readFileSync(join(archiveDir, 'manifest.json'), 'utf-8'));
  if (!Array.isArray(manifest) || manifest.length !== 1) {
    throw new Error(`the image archive holds ${manifest?.length ?? 0} images, expected 1`);
  }
  const { Config: configPath, Layers: layers } = manifest[0];
  const config = JSON.parse(readFileSync(join(archiveDir, configPath), 'utf-8'));
  const diffIds = config?.rootfs?.diff_ids;
  if (!Array.isArray(layers) || !Array.isArray(diffIds) || layers.length !== diffIds.length) {
    throw new Error(
      `the image archive pairs ${layers?.length ?? 0} layers with ${diffIds?.length ?? 0} diff_ids`,
    );
  }
  return { configPath, layers, diffIds };
}

/**
 * What to send. Pure: reads an extracted `docker save` and the target's
 * diffID set. `sendPaths` (relative to archiveDir) is manifest.json, the
 * config blob and every layer blob whose diffID the target lacks; `keep` lists
 * the layers the target fills itself.
 *
 * @param {{archiveDir: string, have: {has: (diffId: string) => boolean}}} args
 * @returns {{sendPaths: string[], keep: Array<{index: number, diffId: string}>, totalLayers: number}}
 */
export function buildDelta({ archiveDir, have }) {
  const { configPath, layers, diffIds } = readArchive(archiveDir);
  const keep = [];
  const send = new Set();
  layers.forEach((path, index) => {
    const diffId = diffIds[index];
    if (have.has(diffId)) keep.push({ index, diffId });
    else send.add(path);
  });
  return { sendPaths: ['manifest.json', configPath, ...send], keep, totalLayers: layers.length };
}

/**
 * ssh argv for the delivery, built as the compose sideload built it: per-env
 * known_hosts pinned with accept-new, ConnectTimeout=30 ahead of the shared
 * options (OpenSSH keeps the first value per option), then the shared
 * BatchMode / keepalive / multiplexing options. Argv, so nothing is escaped.
 *
 * @param {{sshTarget: string, sshKey?: string}} args
 * @returns {string[]}
 */
export function deliverySshArgs({ sshTarget, sshKey }) {
  const args = [];
  if (sshKey) args.push('-i', sshKey);
  args.push('-o', 'StrictHostKeyChecking=accept-new');
  if (sshKey) {
    args.push('-o', `UserKnownHostsFile=${knownHostsPathForKey(sshKey)}`);
    args.push('-o', 'GlobalKnownHostsFile=/dev/null');
  }
  args.push('-o', 'ConnectTimeout=30', ...SSH_CONNECTION_OPTS, sshTarget);
  return args;
}

/** Waits for a child; resolves its exit code and captured stderr. */
function settle(child, label) {
  let stderr = '';
  child.stderr?.on('data', (c) => {
    if (stderr.length < 64 * 1024) stderr += c;
  });
  return new Promise((resolve, reject) => {
    child.on('error', (err) => reject(new Error(`${label}: ${err.message}`)));
    child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
  });
}

function sshRunner(sshArgs) {
  return async (cmd) => {
    const child = spawn('ssh', [...sshArgs, cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    const { code, stderr } = await settle(child, 'ssh');
    if (code !== 0) throw new Error(firstLine(stderr) || `ssh exited ${code}`);
    return stdout;
  };
}

function sshSender(sshArgs) {
  return async (cmd, stdin) => {
    const child = spawn('ssh', [...sshArgs, cmd], { stdio: ['pipe', 'ignore', 'pipe'] });
    const done = settle(child, 'ssh');
    // An ssh that dies mid-stream closes its stdin; its exit code and stderr
    // carry the cause, so the EPIPE here is not the error to report.
    const fed = pipeline(stdin, child.stdin).catch(() => {});
    const result = await done;
    await fed;
    return result;
  };
}

/** `docker save <tag> | tar -x -C <dir>` on the host. */
async function saveImageToDir(tag, dir) {
  const save = spawn('docker', ['save', tag], { stdio: ['ignore', 'pipe', 'pipe'] });
  const untar = spawn('tar', ['-x', '-C', dir], { stdio: ['pipe', 'ignore', 'pipe'] });
  const fed = pipeline(save.stdout, untar.stdin).catch(() => {});
  const [s, u] = await Promise.all([settle(save, 'docker save'), settle(untar, 'tar')]);
  await fed;
  if (s.code !== 0) throw new Error(firstLine(s.stderr) || `docker save exited ${s.code}`);
  if (u.code !== 0) throw new Error(firstLine(u.stderr) || `tar exited ${u.code}`);
}

function isGzip(path) {
  const fd = openSync(path, 'r');
  try {
    const b = Buffer.alloc(2);
    return readSync(fd, b, 0, 2, 0) === 2 && b[0] === 0x1f && b[1] === 0x8b;
  } finally {
    closeSync(fd);
  }
}

/**
 * Write the archive the target receives into `stageDir`: manifest.json naming
 * neutral layer files l0..lN-1 and config.json, the sent layers gzipped (a
 * layer already gzip, as a containerd-store host saves it, is sent as is), and
 * fill.txt with `<index> <diffID> <source>` per layer the target fills.
 */
async function stageDelta({ archiveDir, stageDir, tag, keep, layerSources }) {
  const { configPath, layers } = readArchive(archiveDir);
  const kept = new Set(keep.map((k) => k.index));
  copyFileSync(join(archiveDir, configPath), join(stageDir, 'config.json'));
  const names = layers.map((_, i) => `l${i}`);
  writeFileSync(
    join(stageDir, 'manifest.json'),
    JSON.stringify([{ Config: 'config.json', RepoTags: [tag], Layers: names }]),
  );
  writeFileSync(
    join(stageDir, 'fill.txt'),
    keep.map(({ index, diffId }) => `${index} ${diffId} ${layerSources.get(diffId)}\n`).join(''),
  );
  const sent = names.filter((_, i) => !kept.has(i));
  // zlib runs on libuv's threadpool, so the layers compress in parallel.
  await Promise.all(
    layers.map(async (path, i) => {
      if (kept.has(i)) return;
      const src = join(archiveDir, path);
      const dst = join(stageDir, names[i]);
      if (isGzip(src)) copyFileSync(src, dst);
      else {
        await pipeline(
          createReadStream(src),
          createGzip({ level: zlibConstants.Z_BEST_SPEED }),
          createWriteStream(dst),
        );
      }
    }),
  );
  return ['manifest.json', 'config.json', 'fill.txt', ...sent];
}

/**
 * Deliver a locally built image to a deploy target, sending only the layers it
 * lacks. See the file header for the protocol.
 *
 * `basePull`, when given, is the caller's in-flight pull of the runtime base
 * on the target. It is awaited before the target is asked what it holds, so a
 * pull still running cannot make the delta carry the base. It runs alongside
 * the host-side save. A failed pull fails the delivery with its cause rather
 * than quietly sending the whole base.
 *
 * The ssh send holds the host-wide uplink lock (uplink-lock.js), and only the
 * send: two processes' transfers over one operator uplink stall each other.
 *
 * @param {{
 *   tag: string,
 *   sshTarget: string,
 *   sshKey?: string,
 *   runtime: 'docker' | 'k3s',
 *   registryRef?: string,
 *   basePull?: Promise<unknown>,
 *   baseRef?: string,
 *   deps?: {
 *     run?: (cmd: string) => Promise<string>,
 *     send?: (cmd: string, stdin: import('node:stream').Readable) => Promise<{code: number, stderr: string}>,
 *     saveImage?: (tag: string, dir: string) => Promise<void>,
 *     acquireLock?: (opts: {label: string}) => Promise<() => void>,
 *   },
 * }} args
 * @returns {Promise<{bytes: number, layersSent: number, layersReused: number}>}
 */
export async function deliverImage({
  tag,
  sshTarget,
  sshKey,
  runtime,
  registryRef,
  basePull,
  baseRef = NODE_RUNTIME_IMAGE,
  deps = {},
}) {
  if (runtime !== 'docker' && runtime !== 'k3s') {
    throw new Error(`deliverImage: runtime must be docker or k3s, got ${runtime}`);
  }
  if (registryRef && runtime !== 'k3s') {
    throw new Error('deliverImage: registryRef is only for a k3s target');
  }
  const sshArgs = deliverySshArgs({ sshTarget, sshKey });
  const {
    run = sshRunner(sshArgs),
    send = sshSender(sshArgs),
    saveImage = saveImageToDir,
    acquireLock = acquireUplinkLock,
  } = deps;

  const timer = perfTimer('deploy.image.delta');
  const work = mkdtempSync(join(tmpdir(), 'vibecarbon-delta-'));
  const archiveDir = join(work, 'save');
  const stageDir = join(work, 'stage');
  mkdirSync(archiveDir);
  mkdirSync(stageDir);
  try {
    const saved = saveImage(tag, archiveDir).catch((err) => {
      throw new DeliveryError(firstLine(err?.message) || 'docker save failed');
    });
    const pulled = Promise.resolve(basePull).catch((err) => {
      throw new DeliveryError(`base image pull failed: ${firstLine(err?.message ?? err)}`);
    });
    await Promise.all([saved, pulled]);

    const layerSources = await listTargetLayers({
      run,
      runtime,
      refs: runtime === 'docker' && baseRef ? [baseRef] : [],
    }).catch((err) => {
      throw new DeliveryError(firstLine(err?.message) || 'listing the target image layers failed');
    });

    const { keep, totalLayers } = buildDelta({ archiveDir, have: layerSources });
    const members = await stageDelta({ archiveDir, stageDir, tag, keep, layerSources });
    const ref = runtime === 'k3s' ? normalizeImageRef(tag) : tag;
    const cmd = `sh -c ${shEscape(REMOTE_SCRIPT)} layer-delta ${[
      runtime,
      tag,
      ref,
      registryRef ?? '',
    ]
      .map(shEscape)
      .join(' ')}`;

    let bytes = 0;
    const release = await acquireLock({ label: `delta tag=${tag}` });
    let result;
    let tarExit;
    const tar = spawn('tar', ['-c', '-f', '-', '-C', stageDir, ...members], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const tarDone = settle(tar, 'tar');
      const counted = tar.stdout.pipe(
        new Transform({
          transform(chunk, _enc, cb) {
            bytes += chunk.length;
            cb(null, chunk);
          },
        }),
      );
      result = await send(cmd, counted);
      // A target that failed mid-stream stopped reading: close the pipe so a
      // tar still writing exits instead of blocking forever.
      tar.stdout.destroy();
      tarExit = await tarDone;
    } catch (err) {
      tar.kill();
      throw err;
    } finally {
      release();
    }
    if (result.code !== 0) {
      throw new DeliveryError(firstLine(result.stderr) || `the target exited ${result.code}`);
    }
    if (tarExit.code !== 0) {
      throw new DeliveryError(firstLine(tarExit.stderr) || `tar exited ${tarExit.code}`);
    }
    const layersReused = keep.length;
    const layersSent = totalLayers - layersReused;
    timer.end(`bytes=${bytes} sent=${layersSent} reused=${layersReused}`);
    return { bytes, layersSent, layersReused };
  } catch (err) {
    timer.end('(failed)');
    throw err;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
