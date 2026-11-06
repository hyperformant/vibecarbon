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
 * Scaleway holds its public IP as a resource of its own, and the old server's
 * delete releases it, so the replacement gets a flexible IP and that resource
 * follows too. Its ids also carry the zone (`fr-par-1/<uuid>`). The SBS root
 * volume is an output only: the deploy's refresh reads the new one.
 */

/** The program's logical name for the compose server, in every compose program. */
export const COMPOSE_SERVER_LOGICAL_NAME = 'server';

/**
 * Per provider: the server resource's type token, its size input and its
 * public-IP output (programs/<provider>-compose.js). A provider whose IP is a
 * resource of its own names that resource instead, and zones its ids.
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
  scaleway: {
    type: 'scaleway:instance/server:Server',
    sizeKey: 'type',
    ipResource: { type: 'scaleway:instance/ip:Ip', name: 'ip' },
  },
});

/**
 * @param {string} providerId
 * @returns {{ type: string, sizeKey: string, ipKey?: string, ipResource?: { type: string, name: string } } | null}
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
  const [server] = matches;
  const before = JSON.stringify(next);
  // A zoned provider's ids read `<zone>/<uuid>`, and the stack's output is bare.
  const zone = spec.ipResource ? `${String(server.id).split('/')[0]}/` : '';
  const id = `${zone}${target.serverId}`;
  server.id = id;
  server.inputs = { ...(server.inputs ?? {}), [spec.sizeKey]: target.serverType };
  server.outputs = {
    ...(server.outputs ?? {}),
    id,
    [spec.sizeKey]: target.serverType,
    ...(spec.ipKey ? { [spec.ipKey]: target.ip } : {}),
  };
  if (spec.ipResource) {
    const ipId = retargetIpResource(resources, spec.ipResource, target, zone, stackName);
    server.inputs.ipIds = [ipId];
    server.outputs.ipIds = [ipId];
  }
  // The stack outputs `status`, `failover` and the deploy read (serverIp,
  // serverId) name the replacement too. Every compose program exports both.
  const stackRes = resources.find((r) => r?.type === 'pulumi:pulumi:Stack');
  if (stackRes?.outputs) {
    if ('serverId' in stackRes.outputs) stackRes.outputs.serverId = String(target.serverId);
    if ('serverIp' in stackRes.outputs) stackRes.outputs.serverIp = target.ip;
  }
  return { deployment: next, changed: JSON.stringify(next) !== before };
}

/**
 * Point the stack's IP resource at the replacement's flexible IP.
 *
 * @returns {string} the IP's zoned id, which the server's ipIds name
 */
function retargetIpResource(resources, ipResource, target, zone, stackName) {
  if (!target.ipId) {
    throw new Error(
      `stack ${stackName}: no flexible IP id for ${target.ip}, so state would keep naming a ` +
        'released IP',
    );
  }
  const ips = resources.filter(
    (r) => r?.type === ipResource.type && String(r?.urn ?? '').endsWith(`::${ipResource.name}`),
  );
  if (ips.length !== 1) {
    throw new Error(
      `stack ${stackName} holds ${ips.length === 0 ? 'no' : ips.length} ${ipResource.type} ` +
        `named "${ipResource.name}"`,
    );
  }
  const id = `${zone}${target.ipId}`;
  ips[0].id = id;
  ips[0].outputs = { ...(ips[0].outputs ?? {}), id, address: target.ip };
  return id;
}

/**
 * The flexible IP holding `address`. A scale records the replacement's address
 * rather than this id, which keeps every path that resumes a scale or repairs
 * its state the same, and only the provider can say which IP that is.
 */
async function flexibleIpIdFor(address, options) {
  const { getProviderClass } = await import('../providers/index.js');
  const provider = new (getProviderClass(options.provider))(options.providerToken);
  const { items } = await provider.listFlexibleIPsDetailed();
  const match = items.find((ip) => ip.address === address);
  if (!match) throw new Error(`no flexible IP holds ${address}`);
  return match.id;
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
      const resolved = spec.ipResource
        ? { ...target, ipId: await flexibleIpIdFor(target.ip, options) }
        : target;
      const { deployment, changed } = retargetServerResource(state, spec, resolved, stackName);
      if (changed) {
        await withStateBackendRetry(() => stack.importStack(deployment), 'server-state import');
      }
      return { changed };
    },
  );
}
