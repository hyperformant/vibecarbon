/**
 * Before a deploy hands the provider API token to a k8s cluster that does
 * not hold it yet, one read with that token proves it can see the cluster:
 * the provider's own get-server on the cluster's master
 * (ProviderClass#getServer). The controllers that read the token act with it
 * (the cloud controller labels and routes nodes, the CSI driver attaches
 * volumes, the cluster autoscaler adds and removes servers), so a token from
 * another project or account would point them at servers that are not this
 * cluster's. A deploy that would hand one over stops before the Secret
 * changes, and the cluster keeps the token it had.
 *
 * Only a read: whether the token may also write is not probed (a write
 * probe would change something on the account), so docs/security.md says
 * the token needs read and write.
 *
 * Callers run it only when a Secret that carries the token is about to be
 * created or to change (applyCloudSecrets, applyK3sManifests), so a deploy
 * whose Secrets already hold the token makes no call. A deploy that hands a
 * new token to both reads once: the verdict is kept for the rest of that
 * deploy (`seen`, one per cluster, from newTokenChecks), by the token's
 * keyed fingerprint and never the token.
 */
import { readOperatorVar } from '../../operator-env.js';
import { describeCredentialSource } from '../../project.js';
import { fingerprintSecret } from '../secret-fingerprint.js';

/**
 * What a provider answers for a server a token cannot see: no such token,
 * not allowed, or a server outside its project or account.
 */
export const CANT_SEE_STATUSES = Object.freeze([401, 403, 404]);

/**
 * The verdicts one deploy of one cluster has reached: each a provider, a
 * master id and the keyed fingerprint of a token that read it
 * (fingerprintSecret, an HMAC under this machine's key), never the token.
 * deployK3s makes one per cluster and hands it to both callers, so the
 * autoscaler's Secret reuses the cloud Secrets' check instead of reading
 * again.
 *
 * @returns {Set<string>}
 */
export function newTokenChecks() {
  return new Set();
}

/**
 * The key a verdict is kept under: no part of it is the token.
 *
 * @param {string} providerName
 * @param {string} id
 * @param {string} token
 */
function verdictKey(providerName, id, token) {
  return `${providerName}\0${id}\0${fingerprintSecret(token)}`;
}

/** Names as one phrase: "a", "a and b", "a, b and c". */
function listing(names) {
  return names.length <= 2
    ? names.join(' and ')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * Where the deploy's token came from, for the line that says which one to
 * fix: the provider's variable, from the shell or the project's .env.local,
 * or neither (a token entered at a prompt).
 *
 * @param {typeof import('../../providers/base.js').BaseProvider} ProviderClass
 * @param {string} token
 */
function tokenSource(ProviderClass, token) {
  const variable = ProviderClass.TOKEN_ENV;
  if (!variable || readOperatorVar(variable).value !== token) {
    return 'It is the token you entered for this deploy';
  }
  return describeCredentialSource([variable]).source === 'env-local'
    ? `It came from ${variable} in your project's .env.local`
    : `It came from ${variable} in your shell environment, which wins over .env.local`;
}

/**
 * Refuse a token that cannot see this cluster's master, before any Secret
 * changes. A 401, 403 or 404 (CANT_SEE_STATUSES), or an answer that is not
 * the master, says the token can't see it and which token to fix; any other
 * failure of the read refuses too and says the check couldn't run, so a
 * token is never handed over unchecked. No retry here: the provider's
 * request already retries what a network or the provider drops
 * (fetchWithRetry), and the next deploy checks again.
 *
 * The master's id is the one the provisioning recorded (`masterId`), else
 * the one the master node carries (`readMasterNodeId`); with neither, it
 * refuses, saying how to have provisioning record it again.
 *
 * `secretNames` are the Secrets the caller is about to write the token
 * into, `namespace/name`: a refusal says it left them as they were. `seen`
 * (newTokenChecks) keeps a passed check for the rest of the deploy: the
 * same token against the same master makes no second read.
 *
 * @param {{
 *   ProviderClass: typeof import('../../providers/base.js').BaseProvider,
 *   token: string,
 *   masterId?: string|number|null,
 *   readMasterNodeId: () => Promise<string|undefined>,
 *   operatorEnv: string,
 *   stackName?: string,
 *   secretNames: string[],
 *   seen?: Set<string>,
 * }} args
 */
export async function assertTokenSeesCluster({
  ProviderClass,
  token,
  masterId,
  readMasterNodeId,
  operatorEnv,
  stackName,
  secretNames,
  seen,
}) {
  const name = ProviderClass.NAME;
  const stack = stackName || operatorEnv;
  const cluster =
    stackName && stackName !== operatorEnv
      ? `${operatorEnv}'s ${stackName} cluster`
      : `${operatorEnv}'s cluster`;
  const one = secretNames.length === 1;
  const stopped =
    `so this deploy stopped before writing it into ${listing(secretNames)}, and left ` +
    `${one ? 'that Secret as it was' : 'those Secrets as they were'}`;
  const couldnt = `Couldn't check that your ${name} API token can see ${cluster}`;
  let id = masterId != null && String(masterId) !== '' ? String(masterId) : undefined;
  if (id === undefined) {
    try {
      id = await readMasterNodeId();
    } catch (err) {
      throw new Error(
        `${couldnt}: reading which server its master is from the cluster failed, ${stopped}. ` +
          `Deploy ${operatorEnv} again to check once more.\n${err.message}`,
        { cause: err },
      );
    }
  }
  if (!id) {
    // Only the provisioning step records the id, and a deploy skips that
    // step while its record matches. -full clears the environment's own
    // record (deploy-state-<env>.json), not a k8s-ha cluster's.
    const rerun =
      stack === operatorEnv
        ? `Run \`vibecarbon deploy ${operatorEnv} -full\`: it redoes every step, provisioning ` +
          'included, and provisioning records the id.'
        : `Delete \`.vibecarbon/deploy-state-${stack}.json\` in your project (\`-full\` clears ` +
          `only ${operatorEnv}'s own record), then deploy ${operatorEnv} again: it redoes every ` +
          `step for ${stack}, provisioning included, and provisioning records the id.`;
    throw new Error(
      `${couldnt}: this deploy's record of the cluster names no master server, and the master ` +
        `node names none either (the cloud controller sets that only once it has the token), ` +
        `${stopped}. ${rerun}`,
    );
  }
  const key = verdictKey(name, id, token);
  if (seen?.has(key)) return;
  const cantSee = (answer) =>
    `Your ${name} API token can't see ${cluster}: ${answer} when this deploy read its master ` +
    `server (${id}) with it, ${stopped}. ${tokenSource(ProviderClass, token)}; it may be ` +
    `another project's or account's token. Set ${ProviderClass.TOKEN_ENV} to a token that can ` +
    `see ${cluster}'s servers, with read and write access (the cluster uses it to add nodes and ` +
    `attach volumes), then deploy ${operatorEnv} again.`;
  let server;
  try {
    server = await new ProviderClass(token).getServer(id);
  } catch (err) {
    if (CANT_SEE_STATUSES.includes(err?.status)) {
      throw new Error(`${cantSee(`${name} answered HTTP ${err.status}`)}\n${err.message}`, {
        cause: err,
      });
    }
    throw new Error(
      `${couldnt}: reading its master server (${id}) with it failed, ${stopped}. ` +
        `Deploy ${operatorEnv} again to check once more.\n${err?.message ?? String(err)}`,
      { cause: err },
    );
  }
  if (String(server?.id ?? '') !== id) {
    throw new Error(cantSee(`${name} didn't answer with that server`));
  }
  seen?.add(key);
}
