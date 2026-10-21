/**
 * Point a compose stack's `server` resource at the server that actually runs.
 *
 * Compose scale builds the replacement with provider.createServer and deletes
 * the old server outside Pulumi. Left alone, the stack still names the deleted
 * server: the next compose-ha deploy's pre-up refresh drops it, and `up`
 * creates a fresh server named like the replacement (a name collision on
 * Hetzner; on the other providers an empty server the deploy then targets).
 *
 * The fix re-points the resource the program declares (logical name `server`,
 * same URN) at the replacement: the new provider id, the new size, the new IP,
 * through exportStack/importStack (the Automation API's documented way to edit
 * a stack's state). `pulumi import` is not used, on purpose: an import has no
 * prior state, so the inputs a provider never reads back (user data, SSH keys,
 * Linode's authorized keys and metadata) come in empty, and they are
 * replace-on-change on every provider here, so the next `up` would replace the
 * server. A re-pointed resource keeps them as the deploy wrote them (the
 * replacement was built from the same image, user data and key), and the
 * deploy's refresh reads every readable field from the new server.
 *
 * Scaleway has no spec: its server holds a flexible IP resource and an SBS
 * root volume, and the old server's delete releases both, which a re-point of
 * the server alone cannot account for. Compose scale refuses there up front.
 */

/** The program's logical name for the compose server, in every compose program. */
export const COMPOSE_SERVER_LOGICAL_NAME = 'server';

/**
 * Per provider: the server resource's type token, its size input and its
 * public-IP output (programs/<provider>-compose.js).
 */
export const COMPOSE_SERVER_STATE = Object.freeze({
  hetzner: { type: 'hcloud:index/server:Server', sizeKey: 'serverType', ipKey: 'ipv4Address' },
  digitalocean: {
    type: 'digitalocean:index/droplet:Droplet',
    sizeKey: 'size',
    ipKey: 'ipv4Address',
  },
  vultr: { type: 'vultr:index/instance:Instance', sizeKey: 'plan', ipKey: 'mainIp' },
  linode: { type: 'linode:index/instance:Instance', sizeKey: 'type', ipKey: 'ipAddress' },
});

/**
 * @param {string} providerId
 * @returns {{ type: string, sizeKey: string, ipKey: string } | null}
 */
export function composeServerStateSpec(providerId) {
  return Object.hasOwn(COMPOSE_SERVER_STATE, providerId) ? COMPOSE_SERVER_STATE[providerId] : null;
}

/**
 * Re-point the `server` resource of an exported deployment at `target`. Pure:
 * returns a new deployment, and `changed: false` when it already names it.
 *
 * @param {{ deployment?: { resources?: object[] } }} state - exportStack's result
 * @param {{ type: string, sizeKey: string, ipKey: string }} spec
 * @param {{ serverId: string|number, serverType: string, ip: string }} target
 * @param {string} [stackName] - for the error line
 */
export function retargetServerResource(state, spec, target, stackName = '?') {
  const next = structuredClone(state);
  const resources = next?.deployment?.resources ?? [];
  const isServer = (r) =>
    r?.type === spec.type && String(r?.urn ?? '').endsWith(`::${COMPOSE_SERVER_LOGICAL_NAME}`);
  const matches = resources.filter(isServer);
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `stack ${stackName} holds no ${spec.type} named "${COMPOSE_SERVER_LOGICAL_NAME}" to point at server ${target.serverId}`
        : `stack ${stackName} holds ${matches.length} ${spec.type} resources named "${COMPOSE_SERVER_LOGICAL_NAME}"; refusing to guess which is server ${target.serverId}`,
    );
  }
  const id = String(target.serverId);
  const [server] = matches;
  const before = JSON.stringify(next);
  server.id = id;
  server.inputs = { ...(server.inputs ?? {}), [spec.sizeKey]: target.serverType };
  server.outputs = {
    ...(server.outputs ?? {}),
    id,
    [spec.sizeKey]: target.serverType,
    [spec.ipKey]: target.ip,
  };
  // The stack outputs `status`, `failover` and the deploy read (serverIp,
  // serverId) name the replacement too. Every compose program exports both.
  const stackRes = resources.find((r) => r?.type === 'pulumi:pulumi:Stack');
  if (stackRes?.outputs) {
    if ('serverId' in stackRes.outputs) stackRes.outputs.serverId = id;
    if ('serverIp' in stackRes.outputs) stackRes.outputs.serverIp = target.ip;
  }
  return { deployment: next, changed: JSON.stringify(next) !== before };
}

/**
 * Re-point stack `stackName`'s server at `target` in the state backend.
 * Idempotent. The stack must exist (never created here); the whole
 * read-modify-write holds the per-bucket state lock.
 *
 * @param {string} stackName
 * @param {{ serverId: string|number, serverType: string, ip: string }} target
 * @param {{ provider: string, providerToken?: string, s3Config?: object, projectName: string }} options
 * @returns {Promise<{ changed: boolean }>}
 */
export async function syncServerState(stackName, target, options) {
  const spec = composeServerStateSpec(options.provider);
  if (!spec) {
    throw new Error(`Pulumi state cannot follow a replaced compose server on ${options.provider}`);
  }
  const { getOrCreateStack, resolveBackendUrl, withStateBackendRetry } = await import('./index.js');
  const { withStateLock } = await import('./state-lock.js');
  return withStateLock(
    resolveBackendUrl(options.s3Config, options.provider),
    `server-state ${stackName}`,
    async () => {
      const stack = await getOrCreateStack(stackName, async () => ({}), {
        ...options,
        requireExisting: true,
      });
      const state = await withStateBackendRetry(() => stack.exportStack(), 'server-state export');
      const { deployment, changed } = retargetServerResource(state, spec, target, stackName);
      if (changed) {
        await withStateBackendRetry(() => stack.importStack(deployment), 'server-state import');
      }
      return { changed };
    },
  );
}
