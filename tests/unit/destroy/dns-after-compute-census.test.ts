import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Rule: never delete a DNS record while anything that could still validate or
 * serve it is alive. Every tier tears compute down first and DNS last.
 * (2026-11-04: a k8s-ha teardown deleted DNS while the cluster's cert-manager
 * was mid-validation; a lookup in that gap cached the name as NXDOMAIN for the
 * next deploy.)
 *
 * The tier teardown functions are not drivable in isolation (provider classes,
 * Pulumi, kubectl), so this census reads each tier function's source in call
 * order: the first DNS deletion must come after the last compute deletion.
 */

function body(file: string, startMarker: string): string {
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf(startMarker);
  expect(start, `${startMarker} not found in ${file}`).toBeGreaterThan(-1);
  const next = src.indexOf('\n}\n', start);
  return src.slice(start, next);
}

function code(text: string): string {
  // Drop comment lines so prose mentioning a call cannot satisfy the census.
  return text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const DNS_CALLS = ['cleanupDnsRecords(', 'deleteApexAndWildcard('];
const COMPUTE_CALLS = [
  'deleteServer(',
  'deleteFirewallByName(',
  'deleteSSHKeyByName(',
  'deleteNetwork',
  'destroyStack(',
  'sweepEnvironmentServers(',
  'sweepOrphanedServers(',
];

function lastIndexOfAny(text: string, needles: string[]): number {
  return Math.max(...needles.map((n) => text.lastIndexOf(n)));
}
function firstIndexOfAny(text: string, needles: string[]): number {
  const found = needles.map((n) => text.indexOf(n)).filter((i) => i >= 0);
  return found.length ? Math.min(...found) : -1;
}

const TIERS: Array<[string, string, string]> = [
  ['compose', 'src/destroy.js', 'async function destroyComposeTier('],
  ['compose-ha', 'src/lib/deploy/compose/ha.js', 'export async function destroyComposeHA('],
  ['k8s and k8s-ha', 'src/destroy.js', 'async function destroyK8sTier('],
];

describe('teardown deletes DNS only after compute is gone', () => {
  for (const [name, file, marker] of TIERS) {
    it(`${name}: first DNS deletion follows the last compute deletion`, () => {
      const text = code(body(file, marker));
      const firstDns = firstIndexOfAny(text, DNS_CALLS);
      const lastCompute = lastIndexOfAny(text, COMPUTE_CALLS);
      expect(firstDns).toBeGreaterThan(-1);
      expect(lastCompute).toBeGreaterThan(-1);
      expect(firstDns).toBeGreaterThan(lastCompute);
    });
  }
});
