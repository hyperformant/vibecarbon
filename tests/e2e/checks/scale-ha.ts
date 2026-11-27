/**
 * What the e2e lifecycle asserts about a k8s-ha environment's replication
 * firewall rule (UDP 51821 from the peer cluster's database node), from the
 * outside.
 *
 * Every up resets an inline cloud firewall (Hetzner, DigitalOcean, Linode) to
 * what its program declares, and the programs declare the replication rule
 * from the peer's recorded database address (replicationPeerIpFor). The deploy
 * and scale's tunnel rebuild also write it over REST
 * (openReplicationFirewallForPeers). Vultr's program declares none: REST is
 * its only writer, and its up leaves the rule alone.
 *
 * The firewall read (checkReplicationFirewalls) asks each side's firewall for
 * the OTHER side's recorded database node:
 * `buildReplicationFirewallRules(firewall, peerDbIp)` returns null, the
 * provider's own answer for "already open". What that proves depends on who
 * wrote the firewall last:
 *
 *   - verify-scale: a REST write. The e2e scale changes the database type, so
 *     scale's tunnel rebuild re-opens the rule by REST after both ups. The
 *     read proves the scale ends with the rule open, not that the ups kept it.
 *   - verify-failover: the failover's converge up on the promoted side, the
 *     only writer since the last REST write (the restore-deploy's opener, or
 *     an operator push after it, which keeps every other rule). The read
 *     proves the program declares the rule.
 *   - reconverge-deploy: the deploy's stack-named REST opener, after both
 *     sides' ups. The read proves the opener paired each firewall with the
 *     right peer after the roles swapped.
 *
 * What the scale's ups did is read from the scale's own output
 * (checkScaleUpsKeptReplicationRule). Each converge says the peer its program
 * declares the rule from (replicationRuleNotice, iac/program-inputs.js), and
 * that must be the peer the record names. Its per-resource markers,
 * `[perf] scale.k8s.<stack>.upStack.resource.<Type>.<name>`, one per resource
 * an up created, updated or replaced (src/lib/iac/resource-timing.js), add
 * the end-to-end proof where a refresh reads the rules back in place
 * (K8S_FIREWALL_RULES_READ_BACK_IN_PLACE): there no firewall resource may
 * appear, since an up that planned a firewall change declared something
 * other than what REST wrote. Scaleway's provider plans the first up after a
 * REST insert as a change however the rules were declared, so there the
 * declared peer is the proof, and the program census
 * (tests/unit/iac/k8s-firewall-round-trip-census.test.ts) that the rule it
 * declares is the one REST writes. That holds for an environment this run
 * deployed. The first up after a CLI upgrade, on an environment an older CLI
 * deployed, is not an e2e case.
 *
 * Firewalls and markers are named by STACK (`<project>-<stack>-firewall`,
 * `scale.k8s.<stack>`): a failover swaps the roles, never the stacks. Modes
 * other than k8s-ha run none of these checks.
 */
import {
  parseReplicationRuleNotices,
  replicationPeerIpFor,
} from '../../../src/lib/iac/program-inputs.js';
import { parsePerfLines } from '../metrics/reporter.js';
import type { VerificationResult } from '../scenarios/types.js';

/** The slice of a provider the firewall read needs. */
export interface ReplicationFirewallProvider {
  findFirewallByName(name: string): Promise<object | null>;
  buildReplicationFirewallRules(firewall: object, peerIp: string): unknown[] | null;
}

type HaSideRecord = { stack?: string; dbIp?: string } & Record<string, unknown>;

/** The slice of `environments[env]` the checks need. */
export type HaEnvRecord = { ha?: { primary?: HaSideRecord; standby?: HaSideRecord } } & Record<
  string,
  unknown
>;

/** One side: its stack, and the peer address its firewall must admit or why there is none. */
type Side = { stack: string; peerIp: string } | { stack: string; problem: string };

/** Each side's stack and its peer's recorded database address. */
function sidesOf(envName: string, envConfig: HaEnvRecord): Side[] {
  return (['primary', 'standby'] as const).map((role) => {
    const stack = envConfig.ha?.[role]?.stack ?? `${envName}-${role}`;
    try {
      const peerIp = replicationPeerIpFor(envConfig, stack);
      return peerIp
        ? { stack, peerIp }
        : { stack, problem: `stack ${stack}: the record holds no database address for its peer` };
    } catch (err) {
      return { stack, problem: err instanceof Error ? err.message : String(err) };
    }
  });
}

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
  for (const side of sidesOf(envName, envConfig)) {
    const { stack } = side;
    const checkName = `replication_firewall:${stack}`;
    const firewallName = `${projectName}-${stack}-firewall`;
    const fail = (errorMessage: string): VerificationResult => ({
      checkName,
      status: 'fail',
      errorMessage,
      details: { stack, firewallName },
    });
    if ('problem' in side) {
      results.push(fail(side.problem));
      continue;
    }
    const { peerIp } = side;
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

/** A firewall resource's `<Type>` in a per-resource marker. */
const FIREWALL_TYPE = /Firewall|SecurityGroup/;

/**
 * Check each side's scale up kept the replication rule, from the scale CLI's
 * output. Its converge must say it declares the rule from the peer the record
 * names. Where `rulesReadBackInPlace`, its up must also have changed no
 * firewall resource. A side whose up left no `scale.k8s.<stack>.upStack`
 * marker fails too: with perf tracing off, or no up run, an absent firewall
 * marker would prove nothing.
 */
export function checkScaleUpsKeptReplicationRule(opts: {
  /** The scale CLI's stdout and stderr. */
  output: string;
  envName: string;
  envConfig: HaEnvRecord;
  /** The provider's K8S_FIREWALL_RULES_READ_BACK_IN_PLACE. */
  rulesReadBackInPlace: boolean;
}): VerificationResult[] {
  const perf = parsePerfLines(opts.output).map((e) => e.name);
  const declared = parseReplicationRuleNotices(opts.output);
  return sidesOf(opts.envName, opts.envConfig).map((side) => {
    const { stack } = side;
    const checkName = `scale_up_kept_replication_rule:${stack}`;
    const fail = (errorMessage: string): VerificationResult => ({
      checkName,
      status: 'fail',
      errorMessage,
      details: { stack },
    });
    if ('problem' in side) return fail(side.problem);
    const { peerIp } = side;
    const stem = `scale.k8s.${stack}.upStack`;
    if (!perf.includes(stem)) {
      return fail(
        `stack ${stack}: no [perf] ${stem} marker, so the scale's up was not read for a ` +
          `firewall change (expected peer database node ${peerIp})`,
      );
    }
    const said = declared.get(stack);
    if (said !== peerIp) {
      return fail(
        `stack ${stack}: the scale's converge ${said ? `declared the rule from ${said}` : 'declared no replication rule'}, ` +
          `not from the peer database node ${peerIp}, so its up reset the firewall without it`,
      );
    }
    const changed = perf
      .filter((name) => name.startsWith(`${stem}.resource.`))
      .map((name) => name.slice(`${stem}.resource.`.length))
      .filter((resource) => {
        const [type, name] = resource.split('.');
        return name !== undefined && FIREWALL_TYPE.test(type);
      });
    if (changed.length > 0 && opts.rulesReadBackInPlace) {
      return fail(
        `stack ${stack}: the scale's up changed ${changed.join(', ')}, so its program did not ` +
          `declare the rules REST wrote (UDP 51821 from the peer database node ${peerIp} among them)`,
      );
    }
    return {
      checkName,
      status: 'pass',
      details: { stack, peerIp, ...(changed.length > 0 && { rewrote: changed }) },
    };
  });
}

/**
 * The checks verify-scale adds for `mode`: replication, the firewall read
 * and, on a provider whose program declares its rules inline
 * (`K8S_OPERATOR_RULES_AFTER_UP === false`), what the scale's ups kept. All for
 * k8s-ha, none otherwise. The checks are injected so the gating is testable
 * without SSH or a cloud.
 */
export async function runScaleHaChecks(opts: {
  mode: string;
  inlineFirewallRules: boolean;
  replication: () => Promise<VerificationResult[]>;
  firewalls: () => Promise<VerificationResult[]>;
  scaleUps: () => VerificationResult[];
}): Promise<VerificationResult[]> {
  if (opts.mode !== 'k8s-ha') return [];
  return [
    ...(await opts.replication()),
    ...(await opts.firewalls()),
    ...(opts.inlineFirewallRules ? opts.scaleUps() : []),
  ];
}

/** The firewall read verify-failover and reconverge-deploy add: k8s-ha only. */
export async function runHaFirewallChecks(opts: {
  mode: string;
  firewalls: () => Promise<VerificationResult[]>;
}): Promise<VerificationResult[]> {
  if (opts.mode !== 'k8s-ha') return [];
  return opts.firewalls();
}
