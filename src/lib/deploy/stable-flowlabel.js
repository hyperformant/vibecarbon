/**
 * net.core.txrehash=0 on servers created before v0.54.1.
 *
 * Since v0.54.1 every server sets it at boot, before it downloads anything:
 * k3s nodes through carbon/cloud-init/k3s/_stable-flowlabel.sh, compose servers
 * through the bootcmd and sysctl.d file in carbon/cloud-init/docker-ce-setup.yaml
 * (why: tests/unit/deploy/stable-flowlabel-census.test.ts). A server made
 * before then never reads new user data, so it pulls with the kernel default,
 * and GitHub's CDN resets the pull when a socket's IPv6 flow label changes.
 * So every deploy also sets it over SSH: the first remote command each node
 * runs on the deploy's way to its image pulls starts with the snippet's own
 * commands, in the same session, so no round trip is added. The carriers are
 * check-db-ledger's read on compose servers (every deploy, before any step
 * that pulls), and on k8s the runtime base pull on the master (the pull with
 * no retry, in its own session) and the pre-pull on every node, which opens
 * as soon as k3s answers, minutes before the apply has kubelet pull anything.
 * A socket reads the setting when it opens, so it covers every pull after.
 *
 * It stays, with no removal date: one printf and one sysctl, both idempotent,
 * on commands the deploy sends anyway. On a server that already has it they
 * rewrite the same line and set the same value.
 *
 * Best effort on a live server: it runs ahead of the carrier's own commands
 * and changes neither their output (sysctl -q) nor their exit status, so a
 * server where it cannot be set is still deployed, and a pull it did not
 * protect still reports its own failure.
 *
 * Census: tests/unit/deploy/stable-flowlabel-deploy-census.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLOUD_INIT_DIR } from '../iac/cloud-init.js';

/** The one source: the snippet every k3s node's cloud-init embeds. */
export const STABLE_FLOWLABEL_SNIPPET = join(CLOUD_INIT_DIR, '_stable-flowlabel.sh');

let prefix;

/**
 * The snippet's commands, its comment lines left out: write
 * /etc/sysctl.d/99-vibecarbon-stable-flowlabel.conf and apply it. POSIX sh,
 * ending in a newline.
 *
 * @returns {string}
 */
export function stableFlowLabelPrefix() {
  prefix ??= `${readFileSync(STABLE_FLOWLABEL_SNIPPET, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() && !line.trimStart().startsWith('#'))
    .join('\n')}\n`;
  return prefix;
}

/**
 * A remote script or command that sets the stable flow label first.
 *
 * @param {string} script
 * @returns {string}
 */
export function withStableFlowLabel(script) {
  return `${stableFlowLabelPrefix()}${script}`;
}
