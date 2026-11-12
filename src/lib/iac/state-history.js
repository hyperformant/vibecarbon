/**
 * Pulumi's history copies of a stack's state that still hold a value the seal
 * wraps (state-seal.js), removed once the stack itself is sealed.
 *
 * The DIY backend copies the whole checkpoint to
 * `.pulumi/history/<project>/<stack>/<stack>-<time>.checkpoint.json` on every
 * update (each refresh and each up), beside the `<stack>-<time>.history.json`
 * that `pulumi stack history` lists. No setting turns the copies off
 * (PULUMI_DIY_BACKEND_DISABLE_CHECKPOINT_BACKUPS covers `.pulumi/backups/`
 * only, see buildEnv), and no Pulumi command removes them, so every update
 * before the seal left a copy of the plain user data: on k8s, the provider
 * token and the k3s join token (CLI 3.259.0, 2026-11-11).
 *
 * Decided by content, not by date: a checkpoint is removed only when it holds
 * a value the seal wraps, plain (plainValueCount). A copy written after the
 * seal holds sealed values and stays, and a cleanup that stopped halfway is
 * finished by the next one. Every `.history.json` stays. On a file:// backend
 * each object has a `.attrs` sidecar (gocloud's fileblob), removed with it.
 * Compressed checkpoints (PULUMI_DIY_BACKEND_GZIP or _ZSTD, which an operator
 * can set) are read too.
 *
 * Goes through the backend the stack's Pulumi uses (resolveBackendUrl): the
 * filesystem for file://, the state bucket's own S3 client for s3://. Never
 * logs what a checkpoint holds, only names and counts.
 */

import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { plainValueCount } from './state-seal.js';

const CHECKPOINT = /\.checkpoint\.json(\.gz|\.zst)?$/;

/** How many history checkpoints are read at once. */
const READ_CONCURRENCY = 8;

/**
 * @typedef {object} HistoryBackend
 * @property {(prefix: string) => Promise<string[]>} list - every key under the prefix
 * @property {(key: string) => Promise<Buffer>} read
 * @property {(keys: string[]) => Promise<void>} remove
 */

/**
 * The file:// backend at `url`, the way Pulumi reads it: an absolute path,
 * `~` for the home directory, anything else relative to the working directory.
 * @param {string} url
 * @returns {HistoryBackend}
 */
function fileBackend(url) {
  const raw = decodeURIComponent(url.slice('file://'.length).replace(/\?.*$/, ''));
  const root = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : resolve(raw);
  return {
    async list(prefix) {
      try {
        return readdirSync(join(root, prefix)).map((name) => `${prefix}${name}`);
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return [];
        throw err;
      }
    },
    async read(key) {
      return readFileSync(join(root, key));
    },
    async remove(keys) {
      for (const key of keys) {
        rmSync(join(root, key), { force: true });
        rmSync(join(root, `${key}.attrs`), { force: true });
      }
    },
  };
}

/**
 * The s3:// backend at `url`, through the provider's object storage client for
 * the state bucket: the bucket, region and keys the deploy holds, and only
 * when that client talks to the same bucket at the same host as Pulumi does.
 * Null for a bucket that isn't the deploy's state bucket (an operator's own
 * PULUMI_BACKEND_URL): vibecarbon has no client for it.
 * @param {string} url
 * @param {{ s3Config?: { stateBucket?: string, bucket?: string, accessKey?: string, secretKey?: string, stateBucketRegion?: string, region?: string }, provider?: string }} options
 * @returns {Promise<HistoryBackend | null>}
 */
async function s3Backend(url, { s3Config, provider }) {
  const parsed = new URL(url);
  const bucket = parsed.hostname;
  const stateBucket = s3Config?.stateBucket ?? s3Config?.bucket;
  if (!stateBucket || bucket !== stateBucket) return null;
  if (!provider || !s3Config?.accessKey || !s3Config?.secretKey) {
    throw new Error(`no object storage client for the state bucket ${bucket}`);
  }
  const { getObjectStorageProvider } = await import('../providers/index.js');
  const store = await getObjectStorageProvider(
    provider,
    s3Config.accessKey,
    s3Config.secretKey,
    s3Config.stateBucketRegion || s3Config.region,
  );
  const host = (s) => String(s ?? '').replace(/^https?:\/\//, '');
  if (host(store.endpoint) !== host(parsed.searchParams.get('endpoint'))) {
    throw new Error(
      `the state bucket's client would reach ${host(store.endpoint)}, but Pulumi uses ${host(parsed.searchParams.get('endpoint'))}`,
    );
  }
  return {
    list: (prefix) => store.listObjectKeys(bucket, prefix),
    read: (key) => store.getObjectBytes(bucket, key),
    remove: (keys) => store.deleteObjectKeys(bucket, keys),
  };
}

/**
 * The backend at `url`, or null for one vibecarbon doesn't manage (an
 * operator's PULUMI_BACKEND_URL naming Pulumi Cloud, for example).
 * @param {string} url
 * @param {{ s3Config?: object, provider?: string }} options
 * @returns {Promise<HistoryBackend | null>}
 */
async function historyBackend(url, options) {
  if (url.startsWith('file://')) return fileBackend(url);
  if (url.startsWith('s3://')) return s3Backend(url, options);
  return null;
}

/**
 * The checkpoint in `bytes`, or null when it isn't one this can read. A parse
 * error is never rethrown: its message quotes the text.
 * @param {string} key
 * @param {Buffer} bytes
 */
function parseCheckpoint(key, bytes) {
  try {
    const text = key.endsWith('.gz')
      ? gunzipSync(bytes)
      : key.endsWith('.zst')
        ? zstdDecompressSync(bytes)
        : bytes;
    return JSON.parse(text.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Remove every history checkpoint of `stackName` that still holds a plain
 * value the seal wraps. Throws when a list, read or delete fails; the caller
 * warns and tries again on the next deploy.
 *
 * @param {object} args
 * @param {string} args.backendUrl - what the stack's Pulumi uses (resolveBackendUrl)
 * @param {string} args.projectName - the Pulumi project
 * @param {string} args.stackName
 * @param {Readonly<Record<string, { userDataInput: string }>>} args.types - SERVER_RESOURCE_TYPES
 * @param {object} [args.s3Config]
 * @param {string} [args.provider]
 * @returns {Promise<{ managed: boolean, checked: number, removed: number, unreadable: string[] }>}
 *   `managed` false: the backend is not one vibecarbon can reach, nothing was read.
 *   `unreadable`: checkpoint names that didn't parse, left as they are.
 */
export async function removePlainHistory({
  backendUrl,
  projectName,
  stackName,
  types,
  s3Config,
  provider,
}) {
  const backend = await historyBackend(backendUrl, { s3Config, provider });
  if (!backend) return { managed: false, checked: 0, removed: 0, unreadable: [] };
  const prefix = `.pulumi/history/${projectName}/${stackName}/`;
  const keys = (await backend.list(prefix)).filter((key) => CHECKPOINT.test(key));
  const plain = [];
  const unreadable = [];
  for (let i = 0; i < keys.length; i += READ_CONCURRENCY) {
    const batch = keys.slice(i, i + READ_CONCURRENCY);
    const bytes = await Promise.all(batch.map((key) => backend.read(key)));
    batch.forEach((key, j) => {
      const checkpoint = parseCheckpoint(key, bytes[j]);
      const latest = checkpoint?.checkpoint?.latest;
      if (checkpoint === null) unreadable.push(key.slice(prefix.length));
      else if (latest && plainValueCount({ deployment: latest }, types) > 0) plain.push(key);
    });
  }
  if (plain.length > 0) await backend.remove(plain);
  return { managed: true, checked: keys.length, removed: plain.length, unreadable };
}
