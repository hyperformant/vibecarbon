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
 * read brings the login file back on ssh's stdout, captured and never
 * printed.
 */

import { shEscape } from '../../shell.js';
import { dockerLoginOnServer, sshRunAsync } from './index.js';

const GHCR = 'ghcr.io';
const DOCKER_CONFIG = '/root/.docker/config.json';

/** Where a compose pull token lives, to complete the ask's "it lives ___". */
export const COMPOSE_KEPT_AS = "on the server in docker's login file";

/** The same, in the words a refused token is told with (ghcr-pull.js TokenWhere). */
export const COMPOSE_WHERE = {
  lives: "on the server in docker's login file",
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

/** The ghcr.io pair in a docker login file's text, or null when there is none to read. */
function ghcrPairIn(text) {
  let auth;
  try {
    auth = JSON.parse(String(text ?? ''))?.auths?.[GHCR]?.auth;
  } catch {
    return null;
  }
  if (typeof auth !== 'string' || !auth) return null;
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
 * ssh cannot reach throws. `|| true` makes a missing file an empty answer, so
 * the command never fails while holding the file (runCommandAsync echoes a
 * failed command's output under CI or DEBUG).
 *
 * @param {string} ip
 * @param {string} sshKeyPath
 * @returns {Promise<{ username: string, token: string } | null>}
 */
export async function readGhcrLoginOnServer(ip, sshKeyPath) {
  const out = await sshRunAsync(ip, sshKeyPath, `cat ${DOCKER_CONFIG} 2>/dev/null || true`, {
    timeout: 30_000,
  });
  return ghcrPairIn(out);
}

/**
 * Servers as places a pull token may be stored, each read over ssh with the
 * environment's key, in order. `name` is how the operator knows the server
 * (`prod`, `prod-standby`); the store is `on <name>'s server`.
 *
 * @param {Array<{ name: string, ip: string }>} servers
 * @param {string} sshKeyPath
 * @returns {import('../ghcr-pull.js').PullStore[]}
 */
export function serverStores(servers, sshKeyPath) {
  return servers.map(({ name, ip }) => ({
    name: `on ${name}'s server`,
    read: () => readGhcrLoginOnServer(ip, sshKeyPath),
  }));
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
 * Drop the ghcr.io entry from a server's docker login file, the way
 * dockerLoginOnServer merges one in: python3 reads the JSON, deletes that one
 * key, and writes the rest of the same object back. Prints `removed`, or
 * `absent` when there was no entry (no file, no ghcr.io key, or a body docker
 * could not read either, which is left as it is). cloud-init runs on python3,
 * so a server has it; one that does not, and holds an entry, fails loudly
 * rather than keep it.
 */
const REMOVE_GHCR_LOGIN = `
set -e
cfg=${DOCKER_CONFIG}
if [ ! -s "$cfg" ]; then echo absent; exit 0; fi
if ! command -v python3 >/dev/null 2>&1; then
  if grep -qF '"${GHCR}"' "$cfg"; then
    echo "the server has no python3 to edit $cfg, so its ${GHCR} login could not be removed" >&2
    exit 1
  fi
  echo absent
  exit 0
fi
HOST=${shEscape(GHCR)} python3 -I - <<'PY'
import json, os
cfg_path = '${DOCKER_CONFIG}'
try:
    with open(cfg_path) as f:
        cfg = json.load(f)
except Exception:
    cfg = None
auths = cfg.get('auths') if isinstance(cfg, dict) else None
if isinstance(auths, dict) and os.environ['HOST'] in auths:
    del auths[os.environ['HOST']]
    with open(cfg_path, 'w') as f:
        json.dump(cfg, f)
    print('removed')
else:
    print('absent')
PY
`;

async function removeGhcrLogin(ip, sshKeyPath) {
  const out = await sshRunAsync(ip, sshKeyPath, '/bin/bash -s', {
    timeout: 30_000,
    input: REMOVE_GHCR_LOGIN,
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
