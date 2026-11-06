/**
 * The version channel's client side: what a command runs, and how it knows.
 *
 * .github/workflows/version-channel.yml publishes channel.json on this repo's
 * `channel` branch. A deploy reads it once at its start, picks one set
 * (chooseImageSet), activates it for the process and records it on the
 * environment. Restore, failover and scale run the recorded set and never read
 * the channel (useRecordedImageSet).
 *
 * THE VALIDATION IS A SECURITY BOUNDARY. This file chooses what runs on
 * customer servers, and its values end up in root cloud-init shell, compose
 * .env files, Kubernetes manifests and `kubectl set image` argv. So nothing in
 * it is trusted, and the rules are exact rather than a blocklist:
 *
 *   - the keys are this CLI's own table, no more and no fewer;
 *   - the package comes from the key: `traefik` can only ever name
 *     ghcr.io/hyperformant/traefik, so a file cannot put one of our other
 *     images, or anything outside the org, under a known name;
 *   - a ref is `<package>:<numeric version>@sha256:<64 hex>`, anchored at both
 *     ends, which leaves no room for a newline, a quote or a shell character;
 *   - k3s is `v1.2.3+k3s4`, and that string reaches INSTALL_K3S_VERSION in a
 *     root shell, so it is held to the same standard as a ref;
 *   - a channel entry may not be older than this CLI's bundled copy, and may
 *     not change the major. The first stops a list rolling a fix back. The
 *     second is why an old CLI never runs a major its templates were not
 *     written for: when a person moves a major in a new CLI, older CLIs reject
 *     the file and stay on what they bundle.
 *
 * Any of these failing rejects the whole file: there is no partial channel.
 * A reason names the key that failed and never repeats the file's content, so
 * a hostile file cannot write to the operator's terminal or log.
 *
 * Reading never blocks or fails a deploy: a 3 s bound, and any problem means
 * the bundled copy and one quiet note.
 *
 * Dependency-free apart from images.js: scripts/version-channel.mjs runs this
 * validator on what it is about to publish, in a CI job with no install step.
 */
import {
  activateImageSet,
  bundledImageSet,
  CHANNEL_IMAGES,
  CHANNEL_KUBERNETES_IMAGES,
  K8S_MIRROR_ORG,
  mirroredImageName,
  PRE_CHANNEL_KUBERNETES,
} from './images.js';

/** Fixed at the top of the file so a CLI never fetches a location it was handed. */
export const CHANNEL_URL =
  'https://raw.githubusercontent.com/hyperformant/vibecarbon/channel/channel.json';

/** A new required key is a schema bump: older CLIs fall back to their bundled copy. */
export const CHANNEL_SCHEMA = 1;
export const CHANNEL_READ_TIMEOUT_MS = 3_000;

/** A real file is about 1 KiB. */
const CHANNEL_MAX_CHARS = 64 * 1024;

const VERSION = /^v?\d{1,9}(?:\.\d{1,9}){1,3}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const K3S_RELEASE = /^v\d{1,9}\.\d{1,9}\.\d{1,9}\+k3s\d{1,9}$/;

/** @param {string} version e.g. "v3.7.17", "1.8.1.3", "v1.37.2+k3s1" @returns {number[]} */
const versionParts = (version) => version.replace('+k3s', '.').match(/\d+/g).map(Number);

/** @param {number[]} a @param {number[]} b @returns {number} */
function compareParts(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Sort order of two versions, for the job that writes the list. */
export function compareVersions(a, b) {
  return compareParts(versionParts(a), versionParts(b));
}

/** Why a file or a record was refused. Its message names a key, never a value. */
class ImageSetRejected extends Error {}

function reject(where, why) {
  throw new ImageSetRejected(`${where} ${why}`);
}

/** The one object shape allowed at `where`: exactly `keys`. */
function assertExactKeys(value, keys, where) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    reject(where, 'not an object');
  }
  const got = Object.keys(value).sort();
  const want = [...keys].sort();
  if (got.length !== want.length || got.some((key, i) => key !== want[i])) {
    reject(where, 'does not hold exactly the expected keys');
  }
}

/** The version a validated ref or k3s string carries. */
export function versionOf(value) {
  return value.includes('@') ? value.slice(value.indexOf(':') + 1, value.indexOf('@')) : value;
}

/** A version may not go below `floor`, nor to another major. */
function assertAboveFloor(version, floor, where) {
  if (floor === undefined) return;
  const [got, want] = [versionParts(version), versionParts(versionOf(floor))];
  if (got[0] !== want[0]) reject(where, 'names another major than this CLI bundles');
  if (compareParts(got, want) < 0) reject(where, 'is older than this CLI bundles');
}

/** `ref` is exactly this key's package, a numeric version and a digest. */
function parseRef(ref, image, where, floor) {
  if (typeof ref !== 'string') reject(where, 'is not a string');
  const prefix = `${K8S_MIRROR_ORG}/${mirroredImageName(image.repo)}:`;
  if (!ref.startsWith(prefix)) reject(where, 'is not this image in our ghcr org');
  const [tag, digest, ...rest] = ref.slice(prefix.length).split('@');
  if (rest.length > 0 || !VERSION.test(tag) || !DIGEST.test(digest ?? '')) {
    reject(where, 'is not a version and a sha256 digest');
  }
  assertAboveFloor(tag, floor, where);
  return ref;
}

function parseRefs(value, table, where, floors) {
  return Object.fromEntries(
    Object.entries(table).map(([key, image]) => [
      key,
      parseRef(value[key], image, `${where}.${key}`, floors?.[key]),
    ]),
  );
}

/**
 * Validate a set and return a fresh copy of it. Throws on anything else.
 *
 * `floor` is for what comes from the channel: the bundled copy. A recorded set
 * is held to the shape only, because a cluster older than this CLI is normal.
 *
 * @param {unknown} value
 * @param {{ floor?: import('./images.js').ImageSet }} [opts]
 * @returns {import('./images.js').ImageSet}
 */
export function parseImageSet(value, { floor } = {}) {
  const set = /** @type {any} */ (value);
  assertExactKeys(set, ['images', 'kubernetes'], 'set');
  assertExactKeys(set.images, Object.keys(CHANNEL_IMAGES), 'images');
  assertExactKeys(set.kubernetes, ['k3s', ...Object.keys(CHANNEL_KUBERNETES_IMAGES)], 'kubernetes');
  const { k3s } = set.kubernetes;
  if (typeof k3s !== 'string' || !K3S_RELEASE.test(k3s)) {
    reject('kubernetes.k3s', 'is not a k3s release version');
  }
  assertAboveFloor(k3s, floor?.kubernetes.k3s, 'kubernetes.k3s');
  return {
    images: parseRefs(set.images, CHANNEL_IMAGES, 'images', floor?.images),
    kubernetes: {
      k3s,
      ...parseRefs(set.kubernetes, CHANNEL_KUBERNETES_IMAGES, 'kubernetes', floor?.kubernetes),
    },
  };
}

/**
 * A channel.json document, parsed. Throws on anything but the exact shape.
 *
 * @param {unknown} value
 * @param {import('./images.js').ImageSet} floor - this CLI's bundled copy
 * @returns {import('./images.js').ImageSet}
 */
export function parseChannelFile(value, floor) {
  const file = /** @type {any} */ (value);
  assertExactKeys(file, ['schema', 'images', 'kubernetes'], 'file');
  if (file.schema !== CHANNEL_SCHEMA) reject('schema', 'is not one this CLI reads');
  return parseImageSet({ images: file.images, kubernetes: file.kubernetes }, { floor });
}

/**
 * Read the channel. Never throws, and never takes longer than `timeoutMs`,
 * body included: the abort signal covers the whole exchange.
 *
 * @param {{ url?: string, fetchFn?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<{ set?: import('./images.js').ImageSet, problem?: string }>}
 */
export async function readChannel({
  url = CHANNEL_URL,
  fetchFn = globalThis.fetch,
  timeoutMs = CHANNEL_READ_TIMEOUT_MS,
} = {}) {
  try {
    const res = await fetchFn(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { problem: `it answered ${res.status}` };
    const text = await readCapped(res);
    if (text === null) return { problem: 'the file is too large' };
    return { set: parseChannelFile(JSON.parse(text), bundledImageSet()) };
  } catch (err) {
    if (err instanceof ImageSetRejected) return { problem: err.message };
    // Fixed text on purpose: JSON.parse quotes the input in its message.
    if (err instanceof SyntaxError) return { problem: 'the file is not JSON' };
    return { problem: 'unreachable' };
  }
}

/**
 * THE choice, pure. The images move to the channel's list on every deploy,
 * since a deploy is the explicit act that takes fixes. The Kubernetes set does
 * too, except on an existing cluster (`keepKubernetes`).
 *
 * @param {object} o
 * @param {import('./images.js').ImageSet | null} o.channel - null when unusable
 * @param {import('./images.js').ImageSet} o.bundled
 * @param {Record<string, string> | null} o.keepKubernetes
 * @returns {import('./images.js').ImageSet}
 */
export function chooseImageSet({ channel, bundled, keepKubernetes }) {
  const current = channel ?? bundled;
  return { images: current.images, kubernetes: keepKubernetes ?? current.kubernetes };
}

/**
 * The environment's recorded set, or null when it has none or it fails
 * validation (`note` says which).
 *
 * @param {{ imageSet?: unknown } | undefined} envConfig
 * @param {(line: string) => void} note
 * @returns {import('./images.js').ImageSet | null}
 */
function recordedImageSet(envConfig, note) {
  if (!envConfig?.imageSet) return null;
  try {
    return parseImageSet(envConfig.imageSet);
  } catch (err) {
    note(`the versions recorded for this environment are not usable (${err.message})`);
    return null;
  }
}

/**
 * The body as text, or null past the cap. The cap holds while reading, so a huge
 * answer never reaches memory.
 *
 * @param {Response} res
 * @returns {Promise<string | null>}
 */
async function readCapped(res) {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of res.body ?? []) {
    text += decoder.decode(chunk, { stream: true });
    if (text.length > CHANNEL_MAX_CHARS) return null;
  }
  return text;
}

/**
 * A live cluster with no record was built before the channel existed. The
 * bundled Kubernetes set is not what it runs: taking it would join new workers
 * to an older master. A record that exists but fails validation is not this
 * case, since only a CLI with the channel writes one.
 *
 * @param {any} envConfig
 * @returns {import('./images.js').ImageSet | null}
 */
function preChannelImageSet(envConfig) {
  const live = envConfig?.deployMode === 'kubernetes' && envConfig.deployedAt;
  if (!live || envConfig.imageSet) return null;
  return { ...bundledImageSet(), kubernetes: { ...PRE_CHANNEL_KUBERNETES } };
}

/**
 * The set a deploy runs, resolved once at its start and activated. The caller
 * records it. Never throws: no problem here stops a deploy.
 *
 * @param {object} o
 * @param {any} o.envConfig - the environment as it stood before this deploy
 * @param {boolean} o.k8s - this deploy's tier runs Kubernetes
 * @param {() => Promise<{ set?: import('./images.js').ImageSet, problem?: string }>} [o.read]
 * @param {(line: string) => void} [o.note]
 * @returns {Promise<import('./images.js').ImageSet>}
 */
export async function resolveDeployImageSet({
  envConfig,
  k8s,
  read = readChannel,
  note = () => {},
}) {
  const bundled = bundledImageSet();
  const { set: channel = null, problem } = await read().catch(() => ({ problem: 'unreachable' }));
  if (!channel) {
    note(`version channel not used (${problem}), deploying the versions bundled with this CLI`);
  }
  const recorded = recordedImageSet(envConfig, note) ?? preChannelImageSet(envConfig);
  // A cluster already built with a version stays on it.
  const existingCluster =
    k8s && envConfig?.deployMode === 'kubernetes' && (recorded || envConfig.deployedAt);
  const set = chooseImageSet({
    channel,
    bundled,
    keepKubernetes: existingCluster ? (recorded ?? bundled).kubernetes : null,
  });
  activateImageSet(set);
  return set;
}

/**
 * For every command that is not a deploy: run what the environment recorded,
 * and do not read the channel. A cluster with no record keeps the Kubernetes set
 * it was built with.
 *
 * @param {{ imageSet?: unknown } | undefined} envConfig
 * @param {{ note?: (line: string) => void }} [opts]
 */
export function useRecordedImageSet(envConfig, { note = () => {} } = {}) {
  activateImageSet(recordedImageSet(envConfig, note) ?? preChannelImageSet(envConfig));
}
