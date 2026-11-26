#!/usr/bin/env node
/**
 * The planning step of .github/workflows/version-channel.yml: read what is
 * published, read upstream, and say what the next list is and what has to be
 * copied into ghcr first. It writes nothing outside its own output, and
 * publishes nothing: the workflow mirrors, smoke-tests and only then publishes.
 *
 * WHAT MOVES: patches only. An installed CLI takes a channel version only on
 * the major and minor it bundles (src/lib/version-channel.js), so the list
 * holds every key on the minor this revision bundles, at its newest patch. A
 * new minor or major stays out and is reported, so the job can open one issue:
 * moving one is an edit of src/lib/images.js and a CLI release, because that
 * release is what tests the templates with it. A list on a minor no CLI built
 * here takes would also hold back that key's patches from every one of them.
 *
 * Kubernetes moves as a set, on its minor. The candidates are k3s `stable`
 * when it is on the current minor, else that minor's own channel, then the
 * current release, and the first complete one wins. Complete means: every CCM
 * and CSI driver the cloud-init scripts install was built against that minor
 * or newer, and registries.yaml already rewrites every system image the k3s
 * release names. If none is complete, the set stays. cluster-autoscaler and
 * alpine/k8s take their newest patch with it. The per-minor channels are what
 * the k3s project publishes for "latest of this minor", which its docs do not
 * promise is `stable`, so the smoke test is what stands behind a patch taken
 * that way.
 *
 * "Built against" is read from the driver's go.mod at the tag cloud-init
 * installs. No driver publishes a machine-readable support table, and a
 * cluster minor newer than the client libraries a driver links is the case its
 * own release notes warn about.
 *
 * Upstream's answers are text from the network. A tag only counts if it has
 * the exact shape of the current one (newerTags), a digest is computed from the
 * bytes rather than read from a header, and the list is run through the CLI's
 * own validator before it leaves this script, then once more before it is
 * written (`write`), and refused unless a CLI built from this revision takes
 * every entry. A list on the channel branch that fails validation stops the
 * job: only this job writes that branch, so it means someone else did.
 *
 * Usage:
 *   node scripts/version-channel.mjs plan <published channel.json>
 *   CHANNEL='{...}' node scripts/version-channel.mjs write <path>
 */
import { createHash } from 'node:crypto';
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  bundledImageSet,
  CHANNEL_IMAGES,
  CHANNEL_KUBERNETES_IMAGES,
  K3S_SYSTEM_IMAGE_MIRRORS,
  k8sMirrorRef,
  k8sMirrorTagRef,
  upstreamRef,
} from '../src/lib/images.js';
import {
  CHANNEL_SCHEMA,
  channelStep,
  compareVersions,
  parseChannelFile,
  versionOf,
} from '../src/lib/version-channel.js';
import { fetchIndex, listTags, newerTags } from './mirror-drift.mjs';

/**
 * In k3s-images.txt and never pulled here: `--disable traefik`, `--disable
 * servicelb`, `--disable gateway-api-crd`. If a release grows a new chart that
 * needs klipper-helm, the k3s smoke test sees its pod stuck.
 */
const K3S_DISABLED_IMAGES = new Set([
  'rancher/klipper-helm',
  'rancher/klipper-lb',
  'rancher/mirrored-library-traefik',
]);

const K3S_RELEASE = /^v\d+\.\d+\.\d+\+k3s\d+$/;

/** The modules a Kubernetes minor is read from: they version with Kubernetes. */
const K8S_MODULE =
  /\bk8s\.io\/(?:api|apimachinery|client-go|cloud-provider|component-base|mount-utils|kubernetes)\s+v[01]\.(\d+)\.\d+/g;

/**
 * A manifest URL in a `kubectl apply -f` of a cloud-init script, or in the
 * `csi_fetch_mirrored` that downloads a CSI driver's manifest to apply it
 * (carbon/cloud-init/k3s/_csi-image-mirror.sh): its repo, its tag, and the
 * path after the tag.
 */
const DRIVER_URL =
  /(?:kubectl apply -f|csi_fetch_mirrored) https:\/\/(?:raw\.githubusercontent\.com|github\.com)\/([\w.-]+\/[\w.-]+)\/(?:releases\/download\/)?(v\d[\d.]*)\/(\S*)/g;

/**
 * The path of a CRD-only manifest in a kubernetes-csi repo. Those CRDs follow
 * a CSI sidecar's version, not a Kubernetes minor, and run no code built
 * against one, so they never hold k3s.
 */
const CRD_ONLY_PATH = /^client\/config\/crd\//;

const major = (version) => Number(version.replace(/^v/, '').split('.')[0]);
const minor = (version) => Number(version.replace(/^v/, '').split('.')[1]);

/**
 * The next tag of one image: its newest patch. A newer minor or major is
 * named, for the issue, and never taken.
 * @param {string} current
 * @param {string[]} tags
 * @returns {{ next: string | null, minor: string | null, major: string | null }}
 */
export function pickImage(current, tags) {
  const newer = newerTags(current, tags);
  const sameMajor = newer.filter((tag) => major(tag) === major(current));
  const patch = sameMajor.filter((tag) => channelStep(tag, current) === 'take');
  const otherMinor = sameMajor.filter((tag) => channelStep(tag, current) === 'ahead');
  const otherMajor = newer.filter((tag) => major(tag) !== major(current));
  return {
    next: patch.at(-1) ?? null,
    minor: otherMinor.at(-1) ?? null,
    major: otherMajor.at(-1) ?? null,
  };
}

/**
 * The Kubernetes minor a driver was built against.
 * @param {string} goMod
 * @returns {number}
 */
export function k8sMinorOfGoMod(goMod) {
  const minors = [...goMod.matchAll(K8S_MODULE)].map((m) => Number(m[1]));
  if (minors.length === 0) throw new Error('no Kubernetes module in go.mod');
  return Math.max(...minors);
}

/**
 * Every driver the cloud-init scripts install, at the tag they install. Read
 * from the scripts, so a bump or a new driver cannot miss this check. A
 * CRD-only manifest is no driver (CRD_ONLY_PATH).
 * @param {string[]} scripts
 * @returns {Array<{ repo: string, tag: string }>}
 */
export function driverPinsIn(scripts) {
  const pins = scripts.flatMap((text) =>
    [...text.matchAll(DRIVER_URL)]
      .filter((m) => !CRD_ONLY_PATH.test(m[3]))
      .map((m) => ({ repo: m[1], tag: m[2] })),
  );
  return [...new Map(pins.map((pin) => [`${pin.repo}@${pin.tag}`, pin])).values()];
}

/**
 * @param {string} text - a release's k3s-images.txt
 * @returns {Array<{ repo: string, tag: string }>}
 */
export function parseK3sImages(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const name = line.replace(/^docker\.io\//, '');
      const at = name.lastIndexOf(':');
      return { repo: name.slice(0, at), tag: name.slice(at + 1) };
    });
}

/**
 * Why this k3s release's system images cannot run here, or null. With
 * `--system-default-registry` a node reaches only what registries.yaml rewrites,
 * so a new one would never pull, and a missing one means the table is stale.
 * @param {Array<{ repo: string }>} images
 * @returns {string | null}
 */
export function systemImagesProblem(images) {
  const used = images.map((i) => i.repo).filter((repo) => !K3S_DISABLED_IMAGES.has(repo));
  const known = K3S_SYSTEM_IMAGE_MIRRORS.map((i) => i.repo);
  const unknown = used.filter((repo) => !known.includes(repo));
  const missing = known.filter((repo) => !used.includes(repo));
  if (unknown.length > 0) return `it needs ${unknown.join(', ')}, which nothing mirrors`;
  if (missing.length > 0) return `it no longer lists ${missing.join(', ')}`;
  return null;
}

/** A k3s release on `current`'s major and minor. */
const onMinorOf = (current) => (version) =>
  typeof version === 'string' &&
  K3S_RELEASE.test(version) &&
  major(version) === major(current) &&
  minor(version) === minor(current);

/**
 * Releases to try, best first, all on the current minor. The current one is
 * always last: a set whose k3s does not move can still take a
 * cluster-autoscaler or kubectl patch.
 * @param {string} current
 * @param {Record<string, string | null>} channels - channel name to its release
 * @returns {string[]}
 */
export function k3sCandidates(current, channels) {
  const sameMinor = onMinorOf(current);
  // On stable's own minor, never run ahead of stable.
  const best = sameMinor(channels.stable)
    ? channels.stable
    : channels[`v${major(current)}.${minor(current)}`];
  const usable = sameMinor(best) && compareVersions(best, current) >= 0;
  return [...new Set([...(usable ? [best] : []), current])];
}

/**
 * A k3s `stable` on a newer minor or major than `current`, or null: what the
 * issue names, for a CLI release to move.
 * @param {string} current
 * @param {Record<string, string | null>} channels
 * @returns {string | null}
 */
export function k3sAhead(current, channels) {
  const { stable } = channels;
  if (typeof stable !== 'string' || !K3S_RELEASE.test(stable)) return null;
  return channelStep(stable, current) === 'ahead' ? stable : null;
}

/**
 * The newest complete k3s release on the current minor, or null.
 * @returns {Promise<{ k3s: string | null, system?: Array<{repo: string, tag: string}>, notes: string[] }>}
 */
async function pickKubernetesSet({ current, channels, upstream, drivers }) {
  const notes = [];
  for (const k3s of k3sCandidates(current, channels)) {
    const m = minor(k3s);
    const behind = drivers.filter((driver) => driver.minor < m).map((d) => `${d.repo} ${d.tag}`);
    const system = parseK3sImages(await upstream.k3sImages(k3s));
    const problem =
      (behind.length > 0 && `${behind.join(', ')} not built for this minor`) ||
      systemImagesProblem(system);
    if (!problem) return { k3s, system, notes };
    notes.push(`k3s ${k3s} left out: ${problem}`);
  }
  return { k3s: null, notes };
}

/**
 * Each key of the list where a CLI built from here takes it, else the bundled
 * copy: a list from before a release moved the bundled one, or from before
 * the patch-only rule, goes back on this revision's line.
 */
function onBundledLine(listed, bundled) {
  const pick = (group) =>
    Object.fromEntries(
      Object.keys(bundled[group]).map((key) => {
        const [mine, theirs] = [bundled[group][key], listed[group][key]];
        return [key, channelStep(versionOf(theirs), versionOf(mine)) === 'take' ? theirs : mine];
      }),
    );
  return { images: pick('images'), kubernetes: pick('kubernetes') };
}

/**
 * The CLI's own validator with the floor every reader applies, and nothing in
 * the list that a CLI built from this revision would keep bundled.
 * @param {unknown} file
 */
function assertTakenWhole(file) {
  const { ahead } = parseChannelFile(file, bundledImageSet());
  if (ahead.length > 0) {
    throw new Error(`${ahead.join(', ')} is on a newer minor or major than this CLI bundles`);
  }
}

/** The shape scripts/mirror-matrix.mjs writes, which mirror-images.yml takes. */
const mirrorEntry = (image) => ({
  src: upstreamRef(image),
  dst: k8sMirrorTagRef(image),
  digest: image.digest,
  index: image.index ?? '',
});

/**
 * The next list.
 *
 * @param {object} o
 * @param {unknown} o.published - channel.json as it stands
 * @param {object} o.upstream - tags, manifest, k3sChannels, k3sImages
 * @param {Array<{ repo: string, tag: string, minor: number }>} o.drivers
 * @returns {Promise<{ file: object, changed: boolean, include: object[], refs: string[],
 *   waiting: Array<{ name: string, current: string, newest: string }>, notes: string[] }>}
 */
export async function planChannel({ published, upstream, drivers }) {
  const bundled = bundledImageSet();
  // A failure here is a list only this job should have written.
  const { set: listed } = parseChannelFile(published);
  const base = onBundledLine(listed, bundled);
  const include = [];
  /** A new minor or major upstream, for a person and a CLI release. */
  const waiting = [];

  /** A new version of `image`: resolved here, copied by the mirror job. */
  const moved = async (image, tag) => {
    const next = { ...image, tag, ...(await upstream.manifest(image, tag)) };
    include.push(mirrorEntry(next));
    return k8sMirrorRef(next);
  };
  /** A ref taken from the bundled copy, which publish-images.yml mirrored. */
  const fromBundled = (image, ref, listedRef) => {
    if (ref !== listedRef && ref === k8sMirrorRef(image)) include.push(mirrorEntry(image));
    return ref;
  };

  const images = {};
  for (const [key, image] of Object.entries(CHANNEL_IMAGES)) {
    const current = versionOf(base.images[key]);
    const pick = pickImage(current, await upstream.tags(image));
    for (const newest of [pick.minor, pick.major].filter(Boolean)) {
      waiting.push({ name: image.repo, current, newest });
    }
    images[key] = pick.next
      ? await moved(image, pick.next)
      : fromBundled(image, base.images[key], listed.images[key]);
  }

  const channels = await upstream.k3sChannels();
  const newerK3s = k3sAhead(base.kubernetes.k3s, channels);
  if (newerK3s) waiting.push({ name: 'k3s', current: base.kubernetes.k3s, newest: newerK3s });
  const picked = await pickKubernetesSet({
    current: base.kubernetes.k3s,
    channels,
    upstream,
    drivers,
  });
  const kubernetes = { k3s: picked.k3s ?? base.kubernetes.k3s };
  for (const [key, image] of Object.entries(CHANNEL_KUBERNETES_IMAGES)) {
    const current = versionOf(base.kubernetes[key]);
    // The set moves together: no complete k3s, no patch for the rest of it.
    const tag = picked.k3s ? pickImage(current, await upstream.tags(image)).next : null;
    kubernetes[key] = tag
      ? await moved(image, tag)
      : fromBundled(image, base.kubernetes[key], listed.kubernetes[key]);
  }

  // A node names these by tag, through registries.yaml, so they are copied
  // before the list names the k3s that asks for them.
  const system =
    picked.system ?? K3S_SYSTEM_IMAGE_MIRRORS.map(({ repo, tag }) => ({ repo, tag }));
  const systemImages = system.filter(({ repo }) => !K3S_DISABLED_IMAGES.has(repo));
  if (kubernetes.k3s !== listed.kubernetes.k3s) {
    for (const { repo, tag } of systemImages) {
      const known = K3S_SYSTEM_IMAGE_MIRRORS.find((i) => i.repo === repo);
      if (known.tag === tag) include.push(mirrorEntry(known));
      else await moved(known, tag);
    }
  }

  const file = { schema: CHANNEL_SCHEMA, images, kubernetes };
  assertTakenWhole(file);
  return {
    file,
    changed: JSON.stringify(file) !== JSON.stringify({ schema: CHANNEL_SCHEMA, ...listed }),
    include,
    refs: [
      ...Object.values(images),
      ...Object.keys(CHANNEL_KUBERNETES_IMAGES).map((key) => kubernetes[key]),
      ...systemImages.map(({ repo, tag }) =>
        k8sMirrorTagRef({ repo, tag }),
      ),
    ],
    waiting,
    notes: picked.notes,
  };
}

/**
 * The tag's linux/amd64 child, by the same select the mirror job runs: platform
 * only, so an attestation entry (architecture "unknown") never matches.
 * @param {string} name
 * @param {Uint8Array} bytes
 * @returns {{ digest: string, index: string }}
 */
export function amd64Child(name, bytes) {
  const manifests = JSON.parse(Buffer.from(bytes).toString('utf8')).manifests ?? [];
  const child = manifests.find(
    (m) => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64',
  );
  if (!child) throw new Error(`no linux/amd64 in ${name}`);
  return {
    digest: child.digest,
    index: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

/** The real upstreams. */
const liveUpstream = {
  tags(image) {
    return listTags(upstreamRef(image).split('/')[0], image.repo);
  },
  async manifest(image, tag) {
    const ref = upstreamRef({ ...image, tag });
    return amd64Child(ref, await fetchIndex(ref.split('/')[0], image.repo, tag));
  },
  async k3sChannels() {
    const res = await fetch('https://update.k3s.io/v1-release/channels', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`${res.status} reading the k3s channels`);
    const { data } = await res.json();
    return Object.fromEntries(data.map((channel) => [channel.name, channel.latest]));
  },
  async k3sImages(version) {
    const res = await fetch(
      `https://github.com/k3s-io/k3s/releases/download/${encodeURIComponent(version)}/k3s-images.txt`,
    );
    if (!res.ok) throw new Error(`${res.status} reading k3s-images.txt of ${version}`);
    return res.text();
  },
};

/** Every driver the scripts install, with the minor its go.mod says. */
async function liveDrivers() {
  const dir = fileURLToPath(new URL('../carbon/cloud-init/k3s', import.meta.url));
  const scripts = readdirSync(dir).map((file) => readFileSync(join(dir, file), 'utf8'));
  return Promise.all(
    driverPinsIn(scripts).map(async ({ repo, tag }) => {
      const res = await fetch(`https://raw.githubusercontent.com/${repo}/${tag}/go.mod`);
      if (!res.ok) throw new Error(`${res.status} reading go.mod of ${repo} ${tag}`);
      return { repo, tag, minor: k8sMinorOfGoMod(await res.text()) };
    }),
  );
}

/**
 * The plan as workflow outputs. Each is one line, which is what $GITHUB_OUTPUT
 * takes, and everything in them passed the validator or the tag filter.
 * @param {Awaited<ReturnType<typeof planChannel>>} out
 * @returns {Record<string, string>}
 */
export function planOutputs(out) {
  return {
    changed: String(out.changed),
    channel: JSON.stringify(out.file),
    include: JSON.stringify(out.include),
    refs: out.refs.join(' '),
    k3s: out.file.kubernetes.k3s,
    traefik_image: out.file.images.traefik,
    docker_socket_proxy_image: out.file.images.dockerSocketProxy,
    waiting: out.waiting.map((m) => `${m.name} ${m.current} to ${m.newest}`).join('; '),
  };
}

async function plan(path) {
  const out = await planChannel({
    published: JSON.parse(readFileSync(path, 'utf8')),
    upstream: liveUpstream,
    drivers: await liveDrivers(),
  });
  const lines = Object.entries(planOutputs(out)).map(([key, value]) => `${key}=${value}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join(''));
  process.stdout.write([...lines, ...out.notes.map((note) => `note: ${note}\n`)].join(''));
}

/** The last check before a publish: the list as the CLI will read it. */
function write(path) {
  const file = JSON.parse(process.env.CHANNEL ?? '');
  assertTakenWhole(file);
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

async function main() {
  const [command, path] = process.argv.slice(2);
  if (command === 'plan' && path) return plan(path);
  if (command === 'write' && path) return write(path);
  throw new Error('usage: version-channel.mjs plan|write <channel.json>');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
