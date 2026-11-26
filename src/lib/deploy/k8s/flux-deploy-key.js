/**
 * The key Flux reads the project's repo with: a read-only deploy key of its
 * own per cluster, so a k8s-ha primary and standby can each be revoked alone.
 * The workflow's GITHUB_TOKEN it replaces stopped working the moment its job
 * ended.
 *
 * Every `configure cicd <env>` makes a new key (rotateFluxDeployKey): the
 * public half goes to GitHub with `gh`, titled for the cluster; the private
 * half goes into the cluster's flux-system Secret, beside GitHub's published
 * host keys, and nowhere else. It reaches kubectl on stdin, never argv or
 * disk, and this process keeps no copy. Then the key that Secret held before,
 * the one with the same title, is removed. A key titled for any other cluster,
 * or added by anyone else, is never touched.
 */

import { generateKeyPairSync } from 'node:crypto';
import { runCommandAsync } from '../../command.js';
import { environmentForStack } from '../../environment-name.js';
import { replaceWholeSecret } from './flux-bootstrap.js';
import { secretManifest } from './k3s.js';

/** How long one gh call may take before it counts as hung. */
const GH_TIMEOUT_MS = 60_000;

/** The Secret the cluster file's GitRepository names (`secretRef`). */
const FLUX_SECRET = { namespace: 'flux-system', name: 'flux-system' };

const gh = (args, { timeout = GH_TIMEOUT_MS } = {}) =>
  runCommandAsync(['gh', ...args], { cleanEnv: true, silent: true, timeout });

/** One SSH wire-format field: a big-endian uint32 length, then the bytes. */
function sshField(bytes) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/**
 * A new ed25519 pair. The private half is PKCS8 PEM, which Flux reads (Go's
 * ssh.ParseRawPrivateKey); the public half is the OpenSSH line GitHub takes,
 * built from the key's own 32 bytes.
 *
 * @returns {{ privateKeyPem: string, publicKey: string }}
 */
export function generateDeployKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const { x } = publicKey.export({ format: 'jwk' });
  const blob = Buffer.concat([
    sshField(Buffer.from('ssh-ed25519')),
    sshField(Buffer.from(x, 'base64url')),
  ]);
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: `ssh-ed25519 ${blob.toString('base64')}`,
  };
}

/** One published host key: its type, then base64. */
const HOST_KEY = /^[a-z0-9@.-]+ [A-Za-z0-9+/]+={0,2}$/;

/**
 * known_hosts for github.com from the host keys GitHub publishes (its meta
 * API), read over gh's authenticated TLS rather than trusted on first
 * contact. An answer that is empty or not just keys is refused.
 *
 * @param {{ timeout?: number }} [options] - for the gh call, in ms
 * @returns {Promise<string>}
 */
export async function githubKnownHosts({ timeout } = {}) {
  const out = await gh(['api', 'meta', '--jq', '.ssh_keys[]'], { timeout });
  const keys = String(out ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (keys.length === 0 || !keys.every((key) => HOST_KEY.test(key))) {
    throw new Error(
      "gh api meta did not answer with github's published ssh host keys, which flux checks " +
        'github.com against before it clones. run this again in a minute.',
    );
  }
  return keys.map((key) => `github.com ${key}\n`).join('');
}

/**
 * The title of a cluster's key at GitHub, the one thing that marks a key as
 * this cluster's to replace.
 *
 * @param {string} envName - the cluster (`prod`, `prod-standby`)
 */
export function deployKeyTitle(envName) {
  return `vibecarbon flux ${envName}`;
}

/**
 * Add a read-only deploy key to the repo.
 *
 * @param {{ owner: string, repo: string, title: string, publicKey: string }} args
 * @returns {Promise<number>} the key's id
 */
export async function addDeployKey({ owner, repo, title, publicKey }) {
  const out = await gh([
    'api',
    '-X',
    'POST',
    `repos/${owner}/${repo}/keys`,
    '-f',
    `title=${title}`,
    '-f',
    `key=${publicKey}`,
    '-F',
    'read_only=true',
    '--jq',
    '.id',
  ]);
  const id = Number(String(out ?? '').trim());
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(
      `github took the deploy key "${title}" on ${owner}/${repo} but did not answer with its id. ` +
        'the next configure cicd removes it.',
    );
  }
  return id;
}

/**
 * Every deploy key on the repo, every page. The title is filtered here, not
 * in the jq expression, so no title is ever spliced into one.
 *
 * @param {{ owner: string, repo: string }} args
 * @returns {Promise<Array<{ id: number, title: string }>>}
 */
export async function listDeployKeys({ owner, repo }) {
  const out = await gh([
    'api',
    `repos/${owner}/${repo}/keys`,
    '--paginate',
    '--jq',
    '.[] | "\\(.id)\\t\\(.title)"',
  ]);
  return String(out ?? '')
    .split('\n')
    .map((line) => {
      const tab = line.indexOf('\t');
      return { id: Number(line.slice(0, tab)), title: line.slice(tab + 1) };
    })
    .filter(({ id }) => Number.isSafeInteger(id) && id > 0);
}

/**
 * @param {{ owner: string, repo: string, id: number }} args
 */
export async function deleteDeployKey({ owner, repo, id }) {
  await gh(['api', '-X', 'DELETE', `repos/${owner}/${repo}/keys/${id}`]);
}

/**
 * The flux-system Secret Flux clones with over ssh: the key and GitHub's host
 * keys, and nothing else.
 *
 * @param {{ privateKeyPem: string, publicKey: string, knownHosts: string }} args
 * @returns {string}
 */
export function fluxSystemSecretManifest({ privateKeyPem, publicKey, knownHosts }) {
  return secretManifest(
    FLUX_SECRET.name,
    { identity: privateKeyPem, 'identity.pub': publicKey, known_hosts: knownHosts },
    FLUX_SECRET.namespace,
  );
}

/**
 * Give the cluster a new deploy key: host keys first (nothing is added
 * without them), then the new key at GitHub, then the Secret written whole,
 * and only then the old key, the one titled for this cluster, removed. Flux
 * never holds a key GitHub has already dropped.
 *
 * A Secret write that fails takes the new key back, and the cluster keeps the
 * old one, which still works. If even that removal fails, the key left at
 * GitHub opens nothing (its private half was never kept), and the next run
 * removes it by its title.
 *
 * @param {{ env: NodeJS.ProcessEnv, owner: string, repo: string, envName: string }} args -
 *   env carries the cluster's KUBECONFIG; envName names the cluster
 * @returns {Promise<{ keyId: number, removed: number[] }>}
 */
export async function rotateFluxDeployKey({ env, owner, repo, envName }) {
  const knownHosts = await githubKnownHosts();
  const title = deployKeyTitle(envName);
  const { privateKeyPem, publicKey } = generateDeployKeyPair();
  let keyId;
  try {
    keyId = await addDeployKey({ owner, repo, title, publicKey });
  } catch (err) {
    // GitHub answers 404, not 403, to a user who may not manage the repo's keys.
    if (/HTTP 404/.test(String(err?.stderr ?? ''))) {
      throw new Error(
        `adding a deploy key to ${owner}/${repo} needs admin rights on the repo. ` +
          `ask an admin to give you admin, or to run vibecarbon configure cicd ${environmentForStack(envName)}`,
      );
    }
    throw err;
  }
  try {
    await replaceWholeSecret({
      env,
      ...FLUX_SECRET,
      manifest: fluxSystemSecretManifest({ privateKeyPem, publicKey, knownHosts }),
    });
  } catch (err) {
    await deleteDeployKey({ owner, repo, id: keyId }).catch(() => {});
    throw err;
  }
  const removed = [];
  for (const key of await listDeployKeys({ owner, repo })) {
    if (key.title !== title || key.id === keyId) continue;
    await deleteDeployKey({ owner, repo, id: key.id });
    removed.push(key.id);
  }
  return { keyId, removed };
}
