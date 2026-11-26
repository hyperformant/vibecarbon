/**
 * What verify-scale asserts for a k8s-ha environment, from the outside.
 *
 * A scale is an up on both sides, and every up resets an inline cloud
 * firewall to what its program declares (the replication rule rides in the
 * program through replicationPeerIpFor; Vultr's is REST-written and its up
 * leaves it alone). So after the scale two things must hold:
 *
 *   - replication still streams and carries data (runReplicationChecks);
 *   - each side's firewall still admits the OTHER side's recorded database
 *     node on UDP 51821: `buildReplicationFirewallRules(firewall, peerDbIp)`
 *     returns null, the provider's own answer for "already open".
 *
 * Firewalls are named by STACK, as the REST opener does
 * (`<project>-<stack>-firewall`): a failover swaps the roles, never the
 * stacks. Other modes run neither check.
 */
import { replicationPeerIpFor } from '../../../src/lib/iac/program-inputs.js';
import type { VerificationResult } from '../scenarios/types.js';

/** The slice of a provider the firewall read needs. */
export interface ReplicationFirewallProvider {
  findFirewallByName(name: string): Promise<object | null>;
  buildReplicationFirewallRules(firewall: object, peerIp: string): unknown[] | null;
}

type HaSideRecord = { stack?: string; dbIp?: string } & Record<string, unknown>;

/** The slice of `environments[env]` the firewall read needs. */
export type HaEnvRecord = { ha?: { primary?: HaSideRecord; standby?: HaSideRecord } } & Record<
  string,
  unknown
>;

/**
 * Check each side's firewall admits the other side's recorded database node.
 * Never throws: an unreadable firewall, a missing peer address or a rule that
 * is not there is a failed result naming the stack and the expected address.
 */
export async function checkReplicationFirewalls(opts: {
  provider: ReplicationFirewallProvider | null;
  projectName: string;
  envName: string;
  envConfig: HaEnvRecord;
}): Promise<VerificationResult[]> {
  const { provider, projectName, envName, envConfig } = opts;
  const results: VerificationResult[] = [];
  for (const role of ['primary', 'standby'] as const) {
    const stack = envConfig.ha?.[role]?.stack ?? `${envName}-${role}`;
    const checkName = `replication_firewall:${stack}`;
    const firewallName = `${projectName}-${stack}-firewall`;
    const fail = (errorMessage: string): VerificationResult => ({
      checkName,
      status: 'fail',
      errorMessage,
      details: { stack, firewallName },
    });
    let peerIp: string | undefined;
    try {
      peerIp = replicationPeerIpFor(envConfig, stack);
    } catch (err) {
      results.push(fail(err instanceof Error ? err.message : String(err)));
      continue;
    }
    if (!peerIp) {
      results.push(fail(`stack ${stack}: the record holds no database address for its peer`));
      continue;
    }
    if (!provider) {
      results.push(fail(`stack ${stack}: no provider instance to read ${firewallName} with`));
      continue;
    }
    try {
      const firewall = await provider.findFirewallByName(firewallName);
      if (!firewall) {
        results.push(fail(`stack ${stack}: firewall ${firewallName} not found or unreadable`));
        continue;
      }
      const missing = provider.buildReplicationFirewallRules(firewall, peerIp) !== null;
      results.push(
        missing
          ? fail(
              `stack ${stack}: firewall ${firewallName} does not admit UDP 51821 from the peer database node ${peerIp}`,
            )
          : { checkName, status: 'pass', details: { stack, firewallName, peerIp } },
      );
    } catch (err) {
      results.push(
        fail(
          `stack ${stack}: reading ${firewallName} threw: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }
  return results;
}

/**
 * The checks verify-scale adds for `mode`: both for k8s-ha, none otherwise.
 * `replication` and `firewalls` are the real checks in the lifecycle, injected
 * so the gating is testable without SSH or a cloud.
 */
export async function runScaleHaChecks(opts: {
  mode: string;
  replication: () => Promise<VerificationResult[]>;
  firewalls: () => Promise<VerificationResult[]>;
}): Promise<VerificationResult[]> {
  if (opts.mode !== 'k8s-ha') return [];
  return [...(await opts.replication()), ...(await opts.firewalls())];
}
