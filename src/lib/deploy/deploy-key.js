/**
 * The deploy key an environment's servers trust, required before a deploy
 * would make a new one.
 *
 * Every mode keeps one key per environment at `.vibecarbon/deploy_key_<env>`
 * (sshKeyPathFor in lib/ssh.js), made by the first deploy. A deploy from a
 * machine without it used to make a new key and run the up with that one: the
 * new key can't log in to the servers already running, and on DigitalOcean
 * the up replaced the droplet to install it, its database with it. So every
 * path that makes a deploy key (generateSSHKeyPair in deploy/utils.js,
 * ensureSshKey in deploy/k8s/k3s.js) runs requireDeployKey first, and the
 * deploy runs it once more before anything else touches the environment
 * (census: tests/unit/deploy/deploy-key-census.test.ts).
 */

import { existsSync } from 'node:fs';
import { basename, isAbsolute, relative } from 'node:path';

/**
 * Whether the environment's record names servers a deploy already made: any
 * servers[] entry with an address (compose, compose-ha, k8s), or k8s-ha's
 * recorded master addresses.
 *
 * @param {object} [envConfig]
 * @returns {boolean}
 */
export function recordsServers(envConfig) {
  const servers = Array.isArray(envConfig?.servers) ? envConfig.servers : [];
  return (
    servers.some((server) => !!server?.ip) ||
    !!envConfig?.ha?.primary?.masterIp ||
    !!envConfig?.ha?.standby?.masterIp
  );
}

/** The environment's servers exist, and this machine lacks the key they trust. */
export class DeployKeyMissingError extends Error {
  /**
   * @param {{ environment: string, missing: string[], keyName: string }} args
   */
  constructor({ environment, missing, keyName }) {
    const files = missing.join(' and ');
    // The command ends the message, so a double-click copies it whole
    // (tests/unit/lib/copyable-command-census.test.ts).
    super(
      `Your ${environment} environment already has servers, but this machine ` +
        `doesn't have the deploy key they trust: ${files} ` +
        `${missing.length > 1 ? 'are' : 'is'} missing. vibecarbon stops here instead ` +
        "of making a new key, because a new key can't log in to those servers, and on " +
        'some providers putting it in place would replace them, and the data on them. ' +
        `The key lives in the .vibecarbon folder of the project on the machine that ` +
        `deployed ${environment}. Copy ${keyName} and ${keyName}.pub from there into ` +
        `this project's .vibecarbon folder, then deploy again: vibecarbon deploy ${environment}`,
    );
    this.name = 'DeployKeyMissingError';
    this.environment = environment;
    this.missing = missing;
  }
}

/**
 * Refuse to go on when the environment records servers and either half of
 * its deploy key is missing here. A first deploy (nothing recorded) passes:
 * it makes the key.
 *
 * @param {{ environment: string, envConfig?: object, keyPath: string, cwd?: string }} args
 *   keyPath: the key's path (sshKeyPathFor); cwd: what the message's paths
 *   are relative to.
 * @throws {DeployKeyMissingError}
 */
export function requireDeployKey({ environment, envConfig, keyPath, cwd = process.cwd() }) {
  if (!recordsServers(envConfig)) return;
  const missing = [keyPath, `${keyPath}.pub`].filter((path) => !existsSync(path));
  if (missing.length === 0) return;
  const shown = (path) => {
    const rel = relative(cwd, path);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
  };
  // HA clusters deploy under <env>-primary / <env>-standby; the operator
  // types the environment.
  const operatorEnv = environment.replace(/-(primary|standby)$/, '');
  throw new DeployKeyMissingError({
    environment: operatorEnv,
    missing: missing.map(shown),
    keyName: basename(keyPath),
  });
}
