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
 * whose Secrets already hold the token makes no call.
 */
import { readOperatorVar } from '../../operator-env.js';
import { describeCredentialSource } from '../../project.js';

/**
 * What a provider answers for a server a token cannot see: no such token,
 * not allowed, or a server outside its project or account.
 */
export const CANT_SEE_STATUSES = Object.freeze([401, 403, 404]);

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
 * refuses.
 *
 * @param {{
 *   ProviderClass: typeof import('../../providers/base.js').BaseProvider,
 *   token: string,
 *   masterId?: string|number|null,
 *   readMasterNodeId: () => Promise<string|undefined>,
 *   operatorEnv: string,
 *   stackName?: string,
 *   kubeconfig?: string,
 * }} args
 */
export async function assertTokenSeesCluster({
  ProviderClass,
  token,
  masterId,
  readMasterNodeId,
  operatorEnv,
  stackName,
  kubeconfig,
}) {
  const name = ProviderClass.NAME;
  const cluster =
    stackName && stackName !== operatorEnv
      ? `${operatorEnv}'s ${stackName} cluster`
      : `${operatorEnv}'s cluster`;
  const stopped =
    'so this deploy stopped before handing it over, and the cluster still holds the token it had';
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
    throw new Error(
      `${couldnt}: this deploy's record has no id for its master server (vibecarbon 0.50 and ` +
        `older didn't keep one), and the master node names none either, which the cluster's ` +
        `cloud controller sets once it runs. So this deploy stopped before handing the token ` +
        `over, and the cluster still holds the one it had. See whether the controller runs ` +
        `with \`KUBECONFIG=${kubeconfig ?? '<kubeconfig>'} kubectl -n kube-system get pods\`.`,
    );
  }
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
}
