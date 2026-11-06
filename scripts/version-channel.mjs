#!/usr/bin/env node
/**
 * The planning step of .github/workflows/version-channel.yml: read what is
 * published, read upstream, and say what the next list is and what has to be
 * copied into ghcr first. It writes nothing outside its own output, and
 * publishes nothing: the workflow mirrors, smoke-tests and only then publishes.
 *
 * WHAT MOVES. The floating images move to their newest patch or minor. A new
 * major stays where it is and is reported, so the job can open one issue.
 *
 * Kubernetes moves as a set. The candidates are k3s `stable`, then the newest
 * release of each minor below it, then the current release, and the first
 * complete one wins. Complete means: cluster-autoscaler and alpine/k8s both have
 * that minor, every CCM and CSI driver the cloud-init scripts install was built
 * against that minor or newer, and registries.yaml already rewrites every system
 * image k3s release names. If none is complete, the set stays. The per-minor
 * channels are what the k3s project publishes for "latest of this minor", which
 * its docs do not promise is `stable`, so the smoke test is what stands behind
 * a patch taken that way.
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
 * written (`write`). A list on the channel branch that fails validation stops
 * the job: only this job writes that branch, so it means someone else did.
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

/** A manifest URL in a `kubectl apply -f` of a cloud-init script. */
const DRIVER_URL =
  /kubectl apply -f https:\/\/(?:raw\.githubusercontent\.com|github\.com)\/([\w.-]+\/[\w.-]+)\/(?:releases\/download\/)?(v\d[\d.]*)\//g;

const major = (version) => Number(version.replace(/^v/, '').split('.')[0]);
const minor = (version) => Number(version.replace(/^v/, '').split('.')[1]);

/**
 * The next tag of one floating image.
 * @param {string} current
 * @param {string[]} tags
 * @returns {{ next: string | null, major: string | null }}
 */
export function pickImage(current, tags) {
  const newer = newerTags(current, tags);
  const sameMajor = newer.filter((tag) => major(tag) === major(current));
  const otherMajor = newer.filter((tag) => major(tag) !== major(current));
  return { next: sameMajor.at(-1) ?? null, major: otherMajor.at(-1) ?? null };
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
 * from the scripts, so a bump or a new driver cannot miss this check.
 * @param {string[]} scripts
 * @returns {Array<{ repo: string, tag: string }>}
 */
export function driverPinsIn(scripts) {
  const pins = scripts.flatMap((text) =>
    [...text.matchAll(DRIVER_URL)].map((m) => ({ repo: m[1], tag: m[2] })),
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

/**
 * Releases to try, best first. The current one is always last: a set whose
 * k3s does not move can still take a cluster-autoscaler or kubectl patch.
 * @param {string} current
 * @param {Record<string, string | null>} channels - channel name to its release
 * @returns {string[]}
 */
export function k3sCandidates(current, channels) {
  const usable = (version) =>
    typeof version === 'string' &&
    K3S_RELEASE.test(version) &&
    major(version) === major(current) &&
    compareVersions(version, current) >= 0;
  const stable = usable(channels.stable) ? channels.stable : current;
  const minors = [];
  for (let m = minor(stable) - 1; m >= minor(current); m--) {
    minors.push(channels[`v${major(current)}.${m}`]);
  }
  return [...new Set([stable, ...minors.filter(usable), current])];
}

/** The newest tag on `k3sMinor` of an image that follows Kubernetes, or null. */
function onMinor(image, tags, k3sMinor) {
  const same = newerTags(`${image.tag.startsWith('v') ? 'v' : ''}0.0.0`, tags).filter(
    (tag) => major(tag) === 1 && minor(tag) === k3sMinor,
  );
  return same.at(-1) ?? null;
}

/**
 * The newest complete Kubernetes set, or null.
 * @returns {Promise<{ k3s: string, tags: Record<string, string>, system: Array<{repo: string, tag: string}>, notes: string[] }>}
 */
async function pickKubernetesSet({ current, upstream, drivers }) {
  const candidates = k3sCandidates(current, await upstream.k3sChannels());
  const lists = Object.fromEntries(
    await Promise.all(
      Object.entries(CHANNEL_KUBERNETES_IMAGES).map(async ([key, image]) => [
        key,
        await upstream.tags(image),
      ]),
    ),
  );
  const notes = [];
  for (const k3s of candidates) {
    const m = minor(k3s);
    const tags = Object.fromEntries(
      Object.entries(CHANNEL_KUBERNETES_IMAGES).map(([key, image]) => [
        key,
        onMinor(image, lists[key], m),
      ]),
    );
    const noTag = Object.keys(tags).filter((key) => !tags[key]);
    const behind = drivers.filter((driver) => driver.minor < m).map((d) => `${d.repo} ${d.tag}`);
    const system = parseK3sImages(await upstream.k3sImages(k3s));
    const problem =
      (noTag.length > 0 && `no ${noTag.join(' or ')} for this minor`) ||
      (behind.length > 0 && `${behind.join(', ')} not built for this minor`) ||
      systemImagesProblem(system);
    if (!problem) return { k3s, tags, system, notes };
    notes.push(`k3s ${k3s} left out: ${problem}`);
  }
  return { k3s: null, notes };
}

/** Each key's newer value of two sets. */
function newestOf(a, b) {
  const newer = (x, y) => (compareVersions(versionOf(x), versionOf(y)) >= 0 ? x : y);
  const merge = (left, right) =>
    Object.fromEntries(Object.keys(left).map((key) => [key, newer(left[key], right[key])]));
  return {
    images: merge(a.images, b.images),
    kubernetes: merge(a.kubernetes, b.kubernetes),
  };
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
 *   majors: Array<{ name: string, current: string, newest: string }>, notes: string[] }>}
 */
export async function planChannel({ published, upstream, drivers }) {
  const bundled = bundledImageSet();
  // A failure here is a list only this job should have written.
  const listed = parseChannelFile(published);
  const base = newestOf(listed, bundled);
  const include = [];
  const majors = [];

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
    if (pick.major) majors.push({ name: image.repo, current, newest: pick.major });
    images[key] = pick.next
      ? await moved(image, pick.next)
      : fromBundled(image, base.images[key], listed.images[key]);
  }

  const picked = await pickKubernetesSet({ current: base.kubernetes.k3s, upstream, drivers });
  const kubernetes = { k3s: picked.k3s ?? base.kubernetes.k3s };
  for (const [key, image] of Object.entries(CHANNEL_KUBERNETES_IMAGES)) {
    const current = versionOf(base.kubernetes[key]);
    const tag = picked.tags?.[key];
    kubernetes[key] =
      tag && compareVersions(tag, current) > 0
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
  // The CLI's own validator, with the floor every reader applies.
  parseChannelFile(file, bundled);
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
    majors,
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
    majors: out.majors.map((m) => `${m.name} ${m.current} to ${m.newest}`).join('; '),
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
  parseChannelFile(file, bundledImageSet());
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

async function main() {
  const [command, path] = process.argv.slice(2);
  if (command === 'plan' && path) return plan(path);
  if (command === 'write' && path) return write(path);
  throw new Error('usage: version-channel.mjs plan|write <channel.json>');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
