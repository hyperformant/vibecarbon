/**
 * The ghcr.io login a compose server pulls a private app image with: the
 * `ghcr.io` entry of its /root/.docker/config.json, holding a GitHub classic
 * token with only read:packages (the token rules are in ../ghcr-pull.js). A
 * server that pulls a public image, or runs an image this machine sent or the
 * server built, holds no ghcr.io entry at all.
 *
 * A compose deploy, a compose-ha deploy and a compose scale each resolve the
 * credential once (resolveGhcrPull, with the servers' login files as its
 * stores: serverStores) and hand it to ensureGhcrLoginOn, the one writer of
 * that entry (tests/unit/deploy/ghcr-server-login-census.test.ts). Every other
 * entry in the file (Docker Hub's) stays as it was.
 *
 * The token reaches a server only through dockerLoginOnServer's script, on
 * ssh's stdin. It is never in an argv, a local file, a log or an error. A
 * read brings back only the ghcr.io entry's login, never the file (Docker
 * Hub's pair stays on the server), on ssh's stdout as a secret read: a
 * failure neither echoes it nor carries it (runCommandAsync's `secret`).
 */

import * as p from '@clack/prompts';
import { shEscape } from '../../shell.js';
import { dockerLoginOnServer, sshRunAsync } from './index.js';

const GHCR = 'ghcr.io';
const DOCKER_CONFIG = '/root/.docker/config.json';

/** Where a compose pull token lives, to complete the ask's "it lives ___". */
export const COMPOSE_KEPT_AS = "on the server in docker's login file";

/** The same, in the words a refused token is told with (ghcr-pull.js TokenWhere). */
export const COMPOSE_WHERE = {
  lives: COMPOSE_KEPT_AS,
  readers: 'anyone with root on the server',
  puller: 'the server',
};

/**
 * The ghcr.io package an app image ref names (`ghcr.io/<owner>/<repo>:<tag>`,
 * or `@<digest>`), or null for an image from anywhere else: a local-only tag,
 * another registry.
 *
 * @param {string} image
 * @returns {{ owner: string, repo: string } | null}
 */
export function ghcrImagePackage(image) {
  const m = /^ghcr\.io\/([^/:@\s]+)\/([^/:@\s]+)(?:[:@]\S*)?$/i.exec(String(image ?? '').trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** A string as a python literal: JSON's escapes are python's too. */
const py = (value) => JSON.stringify(String(value));

/**
 * The python that prints a docker login file's ghcr.io login (base64 of
 * `user:token`) and nothing else: no line at all for no file, no entry, or a
 * body docker could not read either. Run with `python3 -I`, the program on
 * stdin.
 *
 * @param {string} cfgPath
 * @returns {string}
 */
export function ghcrLoginReadPython(cfgPath) {
  return `import json
cfg_path = ${py(cfgPath)}
host = ${py(GHCR)}
try:
    with open(cfg_path) as f:
        cfg = json.load(f)
except Exception:
    cfg = None
auths = cfg.get('auths') if isinstance(cfg, dict) else None
entry = auths.get(host) if isinstance(auths, dict) else None
auth = entry.get('auth') if isinstance(entry, dict) else None
if isinstance(auth, str) and auth:
    print(auth)
`;
}

/**
 * The script a read sends on ssh's stdin: ghcrLoginReadPython over the file.
 * A server with no python3 prints nothing, so its login reads as none and a
 * token is written again (dockerLoginOnServer handles that server).
 *
 * @param {string} [cfgPath]
 * @returns {string}
 */
export function ghcrLoginReadScript(cfgPath = DOCKER_CONFIG) {
  return `cfg=${shEscape(cfgPath)}
if [ ! -s "$cfg" ] || ! command -v python3 >/dev/null 2>&1; then exit 0; fi
python3 -I - <<'PY'
${ghcrLoginReadPython(cfgPath)}PY
`;
}

/** The pair in a login read's output, or null when there is none to read. */
function ghcrPairIn(out) {
  const auth = String(out ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!auth) return null;
  const pair = Buffer.from(auth, 'base64').toString('utf-8');
  const colon = pair.indexOf(':');
  const username = pair.slice(0, colon);
  const token = pair.slice(colon + 1);
  if (colon < 1 || !token) return null;
  return { username, token };
}

/**
 * The ghcr.io pair a server's docker login file holds, or null when there is
 * no file, no ghcr.io entry, or a body docker could not read either. A server
 * ssh cannot reach throws. Only that entry's login leaves the server, on a
 * secret read.
 *
 * @param {string} ip
 * @param {string} sshKeyPath
 * @param {{ retries?: number }} [options] - sshRunAsync's transport attempts
 * @returns {Promise<{ username: string, token: string } | null>}
 */
export async function readGhcrLoginOnServer(ip, sshKeyPath, { retries } = {}) {
  const out = await sshRunAsync(ip, sshKeyPath, '/bin/bash -s', {
    timeout: 30_000,
    input: ghcrLoginReadScript(),
    secret: true,
    ...(retries !== undefined && { retries }),
  });
  return ghcrPairIn(out);
}

/** The line of a failed read that says why: ssh's own, else the error's first. */
function whyUnread(err) {
  const lines = (text) =>
    String(text ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  return (lines(err?.stderr)[0] ?? lines(err?.message)[0] ?? 'no answer').slice(0, 200);
}

/**
 * Servers as places a pull token may be stored, each read over ssh with the
 * environment's key, in order. `name` is how the operator knows the server
 * (`prod`, `prod-standby`); the store is `on <name>'s server`. A server that
 * cannot be read is warned about and holds nothing to reuse.
 *
 * @param {Array<{ name: string, ip: string }>} servers
 * @param {string} sshKeyPath
 * @returns {import('../ghcr-pull.js').PullStore[]}
 */
export function serverStores(servers, sshKeyPath) {
  return servers.map(({ name, ip }) => {
    const store = `on ${name}'s server`;
    return {
      name: store,
      // One attempt: a server that does not answer has no token to offer, and
      // the resolve goes on to the next store or GHCR_PULL_TOKEN. Its own
      // deploy step reaches it, or fails, later.
      read: async () => {
        try {
          return await readGhcrLoginOnServer(ip, sshKeyPath, { retries: 1 });
        } catch (err) {
          // A changed operator IP stops the whole command: its abort names the
          // cause, where a warning here would end in a GHCR_PULL_TOKEN refusal.
          if (err?.code === 'OPERATOR_IP_CHANGED') throw err;
          p.log.warn(`could not read the token ${store} (${whyUnread(err)}), so it is not reused.`);
          return null;
        }
      },
    };
  });
}

/**
 * An environment's recorded compose servers, by the names serverStores gives
 * them: the environment's own name for its one server, `<env>-<role>` for
 * each side of compose-ha. An entry with no address is left out.
 *
 * @param {string} environment
 * @param {Array<{ ip?: string, role?: string } | null | undefined>} entries - servers[] entries
 * @returns {Array<{ name: string, ip: string }>}
 */
export function namedComposeServers(environment, entries) {
  return entries
    .filter((entry) => entry?.ip)
    .map((entry) => ({
      name:
        entry.role === 'primary' || entry.role === 'standby'
          ? `${environment}-${entry.role}`
          : environment,
      ip: entry.ip,
    }));
}

/**
 * The python that drops the ghcr.io entry from a docker login file, the way
 * dockerLoginOnServer merges one in: it reads the JSON, deletes that one key,
 * and writes the rest of the same object back into the same file, whose mode
 * stays as it was. Prints `removed`, or `absent` when there was no entry (no
 * file, no ghcr.io key). A body it cannot read as JSON that still names
 * ghcr.io fails loudly rather than keep a login it cannot see. Run with
 * `python3 -I`, the program on stdin.
 *
 * @param {string} cfgPath
 * @returns {string}
 */
export function ghcrLoginRemovalPython(cfgPath) {
  return `import json, sys
cfg_path = ${py(cfgPath)}
host = ${py(GHCR)}
try:
    with open(cfg_path) as f:
        text = f.read()
except FileNotFoundError:
    print('absent')
    sys.exit(0)
try:
    cfg = json.loads(text)
except ValueError:
    if '"' + host + '"' in text:
        sys.exit(cfg_path + ' is not json docker can read but names ' + host + ', so its login could not be removed')
    print('absent')
    sys.exit(0)
auths = cfg.get('auths') if isinstance(cfg, dict) else None
if isinstance(auths, dict) and host in auths:
    del auths[host]
    with open(cfg_path, 'w') as f:
        json.dump(cfg, f)
    print('removed')
else:
    print('absent')
`;
}

/**
 * The script a removal sends on ssh's stdin: ghcrLoginRemovalPython over the
 * file. cloud-init runs on python3, so a server has it; one that does not,
 * and whose file names ghcr.io, fails loudly rather than keep the login.
 *
 * @param {string} [cfgPath]
 * @returns {string}
 */
export function ghcrLoginRemovalScript(cfgPath = DOCKER_CONFIG) {
  return `set -e
cfg=${shEscape(cfgPath)}
if [ ! -s "$cfg" ]; then echo absent; exit 0; fi
if ! command -v python3 >/dev/null 2>&1; then
  if grep -qF '"${GHCR}"' "$cfg"; then
    echo "the server has no python3 to edit $cfg, so its ${GHCR} login could not be removed" >&2
    exit 1
  fi
  echo absent
  exit 0
fi
python3 -I - <<'PY'
${ghcrLoginRemovalPython(cfgPath)}PY
`;
}

async function removeGhcrLogin(ip, sshKeyPath) {
  // A secret read like every command on the login file (secret-read-census):
  // it prints only `removed` or `absent`.
  const out = await sshRunAsync(ip, sshKeyPath, '/bin/bash -s', {
    timeout: 30_000,
    input: ghcrLoginRemovalScript(),
    secret: true,
  });
  const said = String(out ?? '')
    .trim()
    .split('\n')
    .at(-1);
  if (said === 'removed' || said === 'absent') return said;
  throw new Error(
    `${ip} did not say whether it dropped its ${GHCR} login, so it may still hold one. ` +
      'run the command again.',
  );
}

/**
 * Make a server's ghcr.io login match the pull credential: resolveGhcrPull's,
 * or null when nothing the server runs comes from ghcr (a local or direct
 * build, an image sent from this machine). The one writer of that entry.
 *
 * - null or public: the entry goes ('removed'), or there was none
 *   ('absent'). A public package needs no login, and a token left there would
 *   be checked by no later run. Every other entry stays as it was.
 * - a token: 'kept' when the entry already holds this pair, else written
 *   through dockerLoginOnServer ('stored').
 *
 * @param {string} ip
 * @param {string} sshKeyPath
 * @param {import('../ghcr-pull.js').GhcrPull | null} pull
 * @returns {Promise<'removed' | 'absent' | 'kept' | 'stored'>}
 */
export async function ensureGhcrLoginOn(ip, sshKeyPath, pull) {
  if (pull == null || pull.mode === 'public') return removeGhcrLogin(ip, sshKeyPath);
  if (pull.mode !== 'token' || !pull.username || !pull.token) {
    throw new TypeError(
      'ensureGhcrLoginOn needs the pull credential resolveGhcrPull resolved, or null',
    );
  }
  const stored = await readGhcrLoginOnServer(ip, sshKeyPath);
  if (stored?.username === pull.username && stored?.token === pull.token) return 'kept';
  await dockerLoginOnServer(ip, sshKeyPath, {
    username: pull.username,
    token: pull.token,
    registry: 'ghcr.io',
  });
  return 'stored';
}
