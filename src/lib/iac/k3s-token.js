/**
 * The k3s join token a k8s program is built with.
 *
 * Every node's user data carries it, and a node with another token can't join
 * the cluster. Servers ignore changes to their user data once they exist
 * (create-timeout.js), so a live server keeps the token it booted with,
 * whatever a later program says. The token a program gets must therefore be
 * the one the stack's servers already have:
 *
 *   - a stack whose outputs record a token (classifyK3sTokenProbe's
 *     `recovered`) replays it unchanged, so an existing cluster never changes
 *     token;
 *   - a stack with none recorded (`missing`: the backend has no such stack;
 *     `empty`: it exists without the token) gets one derived from the
 *     project's state passphrase, the Pulumi project and the stack. A first
 *     `up` that failed after it created servers leaves the stack's outputs
 *     empty while those servers booted with its token, and the rerun derives
 *     that same token, so the stack records the one its servers run with and
 *     every later scale and the carbon-autoscaler join new nodes with it.
 *     A random token there would be recorded instead, and no new node could
 *     join the serving cluster.
 *
 * The programs refuse to build without a token (requireK3sToken), so a missing
 * derivation stops the command instead of silently making a random one.
 *
 * The derived token is no more exposed than a random one: the passphrase it
 * comes from already decrypts the state that records the token. Neither is
 * ever logged; the token travels to the program in-process and into the state
 * as a Pulumi secret, never in argv. On the operator's machine the deploy
 * ledger keeps it in plain text, as it kept a random one: the deploy records
 * the up's outputs, this token among them, in
 * .vibecarbon/deploy-state-<stack>.json (k3s.js
 * completeStep('k3s-infra', outputs)), and a deploy that skips an unchanged
 * k3s-infra step reads the token back from there for the carbon-autoscaler's
 * config. The scaffold's .gitignore lists .vibecarbon/, and destroy's local
 * cleanup deletes the file.
 *
 * The derivation has no per-cluster or random input: the same passphrase,
 * project and stack always give the same token, so a cluster destroyed and
 * deployed again under the same environment name gets its predecessor's
 * token (docs/security.md, "The cluster's join token").
 */

import { createHmac } from 'node:crypto';
import { requirePulumiProject } from './pulumi-project.js';

/** The derivation's purpose and version. A new derivation gets a new version. */
const PURPOSE = 'vibecarbon-k3s-token-v1';

/**
 * The k3s token for `stackName` of `projectName`: hex HMAC-SHA256 keyed by the
 * state passphrase over `vibecarbon-k3s-token-v1\0<project>\0<stack>`. The
 * project is named as the stack's Pulumi state key names it
 * (requirePulumiProject), and the stack exactly as the stack open names it,
 * so the derivation and the stack can't disagree. 64 hex characters, the
 * shape of the random token it replaces.
 *
 * @param {{ passphrase: string, projectName: string, stackName: string }} args
 * @returns {string}
 */
export function deriveK3sToken({ passphrase, projectName, stackName }) {
  if (typeof passphrase !== 'string' || passphrase === '') {
    throw new Error('deriveK3sToken: the state passphrase is required');
  }
  if (typeof stackName !== 'string' || stackName === '') {
    throw new Error('deriveK3sToken: the stack name is required');
  }
  const project = requirePulumiProject({ projectName });
  return createHmac('sha256', passphrase)
    .update(`${PURPOSE}\0${project}\0${stackName}`)
    .digest('hex');
}

/**
 * The token, and whether it was replayed, a k8s program is built with, from
 * the probe's verdict. The passphrase comes from ensureStatePassphrase, the
 * resolver every stack open uses (getOrCreateStack), for the same project
 * directory: by now the probe's own open has verified it, so this reads its
 * memo.
 *
 * `k3sTokenReplayed` is what the programs used to read from a token being
 * present at all: only a replayed token protects a worker with a join trigger
 * (workerResourceOptions' omitJoinTrigger).
 *
 * @param {{ status: string, priorK3sToken?: string }} probe classifyK3sTokenProbe's verdict
 * @param {{ projectName: string, stackName: string, projectDir?: string }} where
 * @returns {Promise<{ k3sToken: string, k3sTokenReplayed: boolean }>}
 */
export async function k3sTokenForStack(probe, { projectName, stackName, projectDir }) {
  switch (probe?.status) {
    case 'recovered': {
      const recorded = probe.priorK3sToken;
      if (typeof recorded !== 'string' || recorded === '') {
        throw new Error('k3sTokenForStack: a recovered probe carries no k3s token');
      }
      return { k3sToken: recorded, k3sTokenReplayed: true };
    }
    case 'missing':
    case 'empty': {
      const { ensureStatePassphrase } = await import('../state-passphrase.js');
      const passphrase = await ensureStatePassphrase(projectDir ?? process.cwd());
      return {
        k3sToken: deriveK3sToken({ passphrase, projectName, stackName }),
        k3sTokenReplayed: false,
      };
    }
    default:
      throw new Error(`k3sTokenForStack: unknown k3s token probe status '${probe?.status}'`);
  }
}

/**
 * The k3s token a k8s program was given, or a refusal naming the program. A
 * program never makes its own: the CLI always passes the stack's recorded
 * token or the derived one (k3sTokenForStack).
 *
 * @param {{ k3sToken?: unknown }} config
 * @param {string} program the builder's name, for the refusal
 * @returns {string}
 */
export function requireK3sToken(config, program) {
  const token = config?.k3sToken;
  if (typeof token === 'string' && token !== '') return token;
  throw new Error(
    `${program}: k3sToken required. The CLI passes the stack's recorded token, or one derived ` +
      "from the project's state passphrase when the stack records none; a program never makes " +
      "its own, because a random one would differ from the token the stack's servers booted with.",
  );
}
