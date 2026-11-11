/**
 * Closing summary printed after a successful deploy.
 *
 * The provisioning log prints the server IP early ("VPS provisioned: …") and
 * it scrolls away under the image transfer and stack output. Without a domain
 * the deploy ended on "complete!" alone, so the one thing the operator needed
 * next (where is my site?) was buried. This note restates it last.
 */

import { link } from '../colors.js';
import { hasAutomatedDns } from '../dns-provider.js';
import { clusterIngressIp } from './k8s/ingress-ip.js';

/**
 * The public entry IP for each tier's result shape: the cluster's ingress IP
 * for k8s (single and HA, matching the k8s DNS update: clusterIngressIp, the
 * floating IP or on DigitalOcean the master's own), the primary for
 * compose-HA, the lone VPS for compose.
 *
 * @param {object} deployResult
 * @returns {string|null}
 */
export function entryIpFor(deployResult) {
  return (
    clusterIngressIp(deployResult?.primary) ||
    deployResult?.primaryIp ||
    clusterIngressIp(deployResult) ||
    null
  );
}

/**
 * @param {object} args
 * @param {string} args.environment
 * @param {string|null} args.domain
 * @param {string|null} args.dnsProvider
 * @param {string|null} args.entryIp
 * @param {Array<{name: string, ip: string}>} args.servers
 * @returns {string[]} lines for formatCommandNote
 */
export function completionSummaryLines({ environment, domain, dnsProvider, entryIp, servers }) {
  const lines = [];

  if (domain) {
    lines.push(`Open:     ${link(`https://${domain}`)}`);
  } else if (entryIp) {
    lines.push(`Open:     ${link(`http://${entryIp}`)}`);
  }

  // HA tiers list both sides so the operator knows where the standby lives;
  // k8s lists every node it persisted. Single-server compose shows its one IP.
  const shown = (servers ?? []).filter((s) => s?.ip);
  if (shown.length === 1) {
    lines.push(`Server:   ${shown[0].ip}`);
  } else if (shown.length > 1) {
    lines.push('Servers:');
    for (const s of shown) lines.push(`  ${s.name.padEnd(10)}${s.ip}`);
  }

  if (domain && !hasAutomatedDns(dnsProvider) && entryIp) {
    lines.push(
      '',
      'Point your domain at the server so it loads (and https can issue):',
      `  A record   ${domain}  →  ${entryIp}`,
    );
  } else if (!domain) {
    lines.push('', '# no domain yet, so the site is plain http on the IP above');
  }

  lines.push(
    '',
    `vibecarbon status ${environment}    # health of every container`,
    `vibecarbon diagnose ${environment}  # full state dump if something looks off`,
  );
  return lines;
}
