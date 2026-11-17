/**
 * The operator-IP gate of the commands that cannot go on without SSH or the
 * k8s API (`backup`, `restore`, `update`, `failover`, both `scale` paths):
 * refresh the allowlist through ensureOperatorIpAccess, say so when the
 * firewall changed, and exit 1 when the check fails.
 *
 * The other callers of ensureOperatorIpAccess differ on purpose and stay
 * their own: `deploy` runs it under a spinner and throws, `destroy` warns and
 * continues (it is the escape hatch), and `diagnose` and `shell` write to
 * stderr and continue (ensureOperatorIpAccessWarn).
 */

import * as p from '@clack/prompts';
import { ensureOperatorIpAccess } from './operator-ip.js';

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
    if (result.added) {
      p.log.success(`Firewall updated: ${opened} ${result.cidr}`);
    }
  } catch (err) {
    p.log.error(`Operator-IP check failed: ${err.message}`);
    process.exit(1);
  }
}
