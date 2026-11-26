/**
 * The operator-IP gate of the commands that cannot go on without SSH or the
 * k8s API (`backup`, `restore`, `update`, `failover`, both `scale` paths):
 * refresh the allowlist through ensureOperatorIpAccess, say so when the
 * firewall changed (or changed only in part), and exit 1 when the check
 * fails. A push that fails for an address already on the list warns and goes
 * on instead: before records existed, such a command pushed nothing at all,
 * and a failover must not stop on a firewall API that is down when the
 * address it comes from is already let in.
 *
 * The other callers of ensureOperatorIpAccess differ on purpose and stay
 * their own: `deploy` runs it under a spinner and throws, `destroy` warns and
 * continues (it is the escape hatch), and `diagnose`, `shell` and `status`
 * write to stderr and continue (ensureOperatorIpAccessWarn, and for status,
 * every deployed environment at once, ensureOperatorIpAccessWarnAll).
 */

import * as p from '@clack/prompts';
import { ensureOperatorIpAccess, FirewallPushError } from './operator-ip.js';
import { providerIdFor, resolveProviderToken } from './providers/index.js';

/**
 * No-op without a provider token: there is nothing to patch the firewall with.
 *
 * @param {object} o
 * @param {object} o.projectConfig
 * @param {string} o.environment user-facing environment name
 * @param {boolean} o.isHA patch both the primary and the standby firewall
 * @param {string | null | undefined} o.apiToken
 * @param {boolean} o.yes
 * @param {string} [o.opened] what the success line says is open. Only the
 *   compose scale passes one ('SSH now allows'), the wording it has always had.
 */
export async function requireOperatorIpAccess({
  projectConfig,
  environment,
  isHA,
  apiToken,
  yes,
  opened = 'SSH/k8s API now allow',
}) {
  if (!apiToken) return;
  try {
    const result = await ensureOperatorIpAccess({
      projectConfig,
      environment,
      isHA,
      apiToken,
      yes,
      onMessage: (msg) => p.log.info(msg),
    });
    if (result.missed?.length > 0) {
      p.log.warn(
        `Firewall not fully updated: ${result.missed.join(' and ')} not found, so it may not allow ${result.cidr} yet. Rerun this command once the provider lists it.`,
      );
    } else if (result.added || result.pushed) {
      p.log.success(`Firewall updated: ${opened} ${result.cidr}`);
    }
  } catch (err) {
    if (err instanceof FirewallPushError && !err.added) {
      p.log.warn(
        `Firewall not refreshed (${err.message}). Carrying on, since ${err.cidr} was already on the list; if SSH times out, rerun once the provider answers.`,
      );
      return;
    }
    p.log.error(`Operator-IP check failed: ${err.message}`);
    process.exit(1);
  }
}

/**
 * requireOperatorIpAccess for an environment as its record describes it: both
 * firewalls for compose-HA and k8s HA, and the provider token from the
 * operator's environment. The gate of `backup`, `restore` and `update`.
 *
 * @param {object} o
 * @param {object} o.projectConfig
 * @param {string} o.envName user-facing environment name
 * @param {{ deployMode?: string, ha?: { enabled?: boolean } }} o.envConfig
 * @param {boolean} o.yes
 */
export async function requireEnvOperatorIpAccess({ projectConfig, envName, envConfig, yes }) {
  await requireOperatorIpAccess({
    projectConfig,
    environment: envName,
    isHA: envConfig.deployMode === 'compose-ha' || !!envConfig.ha?.enabled,
    apiToken: resolveProviderToken(providerIdFor(envConfig)),
    yes,
  });
}
