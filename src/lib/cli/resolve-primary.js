/**
 * Raised when an HA environment's persisted roles do not name exactly one
 * primary, or two records of the primary disagree. Acting on a guess here
 * would back up, restore into, or reseed from the retired node.
 */
export class AmbiguousPrimaryError extends Error {
  /**
   * @param {string} message - what is wrong with the recorded roles
   * @param {string} [env] - the environment, named in the remedy
   */
  constructor(message, env) {
    super(
      `${env ? `${env}: ` : ''}${message} Run \`vibecarbon deploy ${env ?? '<env>'}\` to record the server roles.`,
    );
    this.name = 'AmbiguousPrimaryError';
    this.env = env;
  }
}

/**
 * The node an environment's persisted roles call primary. The ONE resolver:
 * no command reads servers[0] to mean "the primary" (a failover swaps roles
 * and keeps array order, so index 0 is then the retired node).
 *
 *   - k8s-ha: ha.primary.masterIp (what swapHaRoles swaps). When servers[]
 *     also carries role:'primary' that entry must agree with it.
 *   - compose-ha: the one servers[] entry with role 'primary'.
 *   - single-node modes (compose, kubernetes): the only server, or the k8s
 *     master entry when the node list also holds db and worker nodes.
 *
 * The retired side is not derived here; retired-fence.js computes it from the
 * same persisted roles.
 *
 * @param {object} envConfig
 * @param {{env?: string}} [opts] env names the environment in an AmbiguousPrimaryError
 * @returns {{ip: string, name?: string, entry?: object}|null} entry is the matching servers[] record null when nothing is deployed yet
 * @throws {AmbiguousPrimaryError} HA env with zero or two primaries, or disagreeing records
 */
export function resolvePrimary(envConfig, { env } = {}) {
  const servers = envConfig?.servers ?? [];
  const entry = (sv) => ({ ip: sv.ip ?? '', ...(sv.name && { name: sv.name }), entry: sv });
  const rolePrimaries = servers.filter((sv) => sv.role === 'primary');
  const haIp = envConfig?.ha?.primary?.masterIp;

  if (haIp) {
    if (rolePrimaries.length > 1) {
      throw new AmbiguousPrimaryError(
        `${rolePrimaries.length} servers claim role 'primary'; cannot tell which holds the live database.`,
        env,
      );
    }
    if (rolePrimaries[0] && rolePrimaries[0].ip !== haIp) {
      throw new AmbiguousPrimaryError(
        `servers[] names ${rolePrimaries[0].ip} as primary but ha.primary is ${haIp}; the role swap was only half saved.`,
        env,
      );
    }
    const match = servers.find((sv) => sv.ip === haIp);
    return match ? entry(match) : { ip: haIp };
  }

  const isHa =
    envConfig?.deployMode === 'compose-ha' ||
    envConfig?.ha?.enabled === true ||
    !!envConfig?.secondaryRegion ||
    !!envConfig?.ha?.failoverRegion ||
    servers.some((sv) => sv.role === 'standby');
  if (isHa) {
    if (servers.length === 0) return null;
    if (rolePrimaries.length !== 1) {
      throw new AmbiguousPrimaryError(
        `expected exactly one server with role 'primary', found ${rolePrimaries.length}.`,
        env,
      );
    }
    return entry(rolePrimaries[0]);
  }

  // Single-node: index 0 is by definition the only server (kubernetes lists
  // master first, then db and workers, and records role 'master' when it can).
  const only = servers.find((sv) => sv.role === 'master') ?? servers[0];
  return only ? entry(only) : null;
}

/**
 * The server type on record for the primary's servers[] entry: where an env
 * deployed before the top-level `serverType` record keeps its size. Undefined
 * when nothing is deployed, the entry records no type, or the HA roles are
 * ambiguous (the deploy that records them is the fix, so it must not refuse).
 *
 * @param {object} envConfig
 * @returns {string|undefined}
 */
export function primaryEntryServerType(envConfig) {
  try {
    return resolvePrimary(envConfig)?.entry?.serverType;
  } catch (err) {
    if (err instanceof AmbiguousPrimaryError) return undefined;
    throw err;
  }
}
