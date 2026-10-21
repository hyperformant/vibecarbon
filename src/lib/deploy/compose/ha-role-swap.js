/**
 * Compose-HA role swap: the detector, and the role-aware reconverge plan.
 *
 * THE SHAPE. `vibecarbon failover` persists a compose-HA swap by flipping the
 * `role` FIELD on `envConfig.servers[]` (see swapComposeHaRoles in ./ha.js).
 * Nothing else moves: entry `name`s and the two Pulumi stacks (`${env}-primary`
 * / `${env}-standby`) keep their birth identity, and so do the WireGuard tunnel
 * addresses (the `-primary` stack's node keeps 10.99.0.1, R11: re-addressing
 * would rewrite the serving primary's wg0 and replication overlay, which
 * recreates its db).
 *
 * THE RECONVERGE (R12). `vibecarbon deploy` on such an environment resolves the
 * pair by ROLE (`planComposeHaReconverge`): the promoted node stays the primary
 * and the retired node is rebuilt as the new standby from it. Each node keeps
 * its stack (Pulumi `up` runs on both, nothing is replaced) and its birth tunnel
 * address; the reseed dials the promoted node's own address
 * (`wgIpOf({ stackIdentity })`). The promoted node's db is never stopped,
 * restarted or reseeded. It requires a finished failover:
 *   - no failover journal (`ha.failoverInFlight`): rerun `vibecarbon failover`;
 *   - the promoted node reads out of recovery;
 *   - DNS already points at the promoted node.
 *
 * k8s-HA reconverges on its own model: `swapHaRoles` (src/failover.js) swaps
 * `ha.primary` / `ha.standby`, objects that carry their own `.stack`.
 *
 * Until a reconverge has verified streaming, `lastFailover` stays set, and a
 * second `vibecarbon failover` and `restore`'s standby re-seed refuse with the
 * reconverge (`vibecarbon deploy`) as the way back.
 *
 * This module does no I/O (failover-guard's swappedSinceLastDeploy is pure): the
 * readers the readiness check needs are injected,
 * so it is unit-tested against config fixtures and called at the very top of
 * executeDeployment, ahead of every infra mutation.
 */

import { swappedSinceLastDeploy } from '../failover-guard.js';

const PRIMARY = 'primary';
const STANDBY = 'standby';
/** The two Pulumi stack suffixes a compose-HA environment is born with. */
const STACKS = [PRIMARY, STANDBY];

/**
 * Read the stack identity out of ONE name string: exact match against the two
 * expected stack names first, then a `-primary` / `-standby` suffix fallback
 * (which survives a project/environment rename in config after the deploy).
 *
 * Returns null when the string matches neither — and also when it somehow
 * matches BOTH, because an ambiguous identity is not an identity. Answering
 * "primary" whenever primary happens to be tested first would silently pick a
 * side on exactly the inputs we understand least.
 *
 * @returns {'primary'|'standby'|null}
 */
function identityFromName(name, projectName, environment) {
  if (typeof name !== 'string' || name === '') return null;
  const exact = STACKS.filter((stack) => name === `${projectName}-${environment}-${stack}`);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const suffixed = STACKS.filter((stack) => name.endsWith(`-${stack}`));
  return suffixed.length === 1 ? suffixed[0] : null;
}

/**
 * Which Pulumi stack was this servers[] entry provisioned as?
 *
 * `name` is the STRONG signal and is consulted alone first: haPersistPendingConfig
 * writes `name: ${projectName}-${environment}-<suffix>` at provisioning time and
 * every later writer preserves it (failover's role flip and scale's blue-green
 * replacement both spread the original entry). `providerServerName` is only a
 * fallback for entries that never got a `name` — scale stamps the *permanent*
 * provider name there, and after a scale-following-failover the two fields can
 * point at DIFFERENT stacks. Reading them as one pool let whichever stack was
 * tested first win, which on that crosswise shape resolved the pair backwards
 * and silenced the guard on a genuinely swapped environment.
 *
 * @returns {'primary'|'standby'|null} null when identity can't be established.
 */
function stackIdentityOf(entry, projectName, environment) {
  return (
    identityFromName(entry?.name, projectName, environment) ??
    identityFromName(entry?.providerServerName, projectName, environment)
  );
}

/**
 * Detect an active compose-HA failover role swap in a persisted environment.
 *
 * Fires only on positive evidence: a compose-HA environment with exactly two
 * servers, each resolvable to a distinct Pulumi stack and each carrying a
 * primary/standby role, where the role assignment is INVERTED relative to the
 * stacks. Anything less — a legacy config with no role fields, a half-persisted
 * deploy, any other tier — returns null, because refusing a deploy on a guess
 * is its own outage.
 *
 * @param {object} args
 * @param {string} args.projectName
 * @param {string} args.environment
 * @param {object} args.envConfig - the environment's PERSISTED config
 * @returns {null | {
 *   environment: string,
 *   byStack: { primary: {ip: string|null, role: string, name: string|null},
 *              standby: {ip: string|null, role: string, name: string|null} },
 *   lastFailover: string|null,
 * }}
 */
export function detectComposeHaRoleSwap({ projectName, environment, envConfig } = {}) {
  if (envConfig?.deployMode !== 'compose-ha') return null;
  const servers = Array.isArray(envConfig.servers) ? envConfig.servers : [];
  if (servers.length !== 2) return null;

  const byStack = new Map();
  for (const entry of servers) {
    const stack = stackIdentityOf(entry, projectName, environment);
    const role = typeof entry?.role === 'string' ? entry.role : null;
    // Both signals are required. Without the stack we don't know what deploy
    // would treat this node as; without the role we have no claim to contradict.
    if (!stack || !role || byStack.has(stack)) return null;
    byStack.set(stack, { ip: entry.ip ?? null, role, name: entry.name ?? null });
  }
  if (byStack.size !== STACKS.length) return null;

  const provisionedPrimary = byStack.get(PRIMARY);
  const provisionedStandby = byStack.get(STANDBY);
  const swapped = provisionedPrimary.role === STANDBY || provisionedStandby.role === PRIMARY;
  if (!swapped) return null;

  return {
    environment,
    byStack: { primary: provisionedPrimary, standby: provisionedStandby },
    lastFailover: envConfig.lastFailover ?? null,
  };
}

/**
 * The stack a servers[] entry belongs to, for the WireGuard address lookup
 * (`wgIpOf`). A legacy entry with no stack-shaped name falls back to its role:
 * the detector cannot read a swap there, so it is treated as never swapped.
 *
 * @returns {'primary'|'standby'|null}
 */
export function composeHaStackOf(entry, projectName, environment) {
  const stack = stackIdentityOf(entry, projectName, environment);
  if (stack) return stack;
  return entry?.role === PRIMARY || entry?.role === STANDBY ? entry.role : null;
}

/**
 * The way back to two nodes after a compose-HA failover: one deploy. The one
 * place this path is spelled, so the failover refusal, its recovery lines and
 * restore's skip all name the same command.
 *
 * @param {string} environment
 * @returns {string[]}
 */
export const COMPOSE_HA_SWAPPED_RECOVERY = (environment) => [
  `Run vibecarbon deploy ${environment} to get back to two nodes: it keeps the promoted node`,
  'serving as the primary and rebuilds the retired node as the new standby from it,',
  'with no downtime.',
];

/**
 * Render the failover refusal (R4). Until a deploy reconverges, the node with
 * role standby is the retired node, frozen at the failover and not replicating:
 * promoting it would serve a database missing every write since.
 */
export function composeHaFailoverRefusalMessage(detail) {
  const { environment, byStack, lastFailover } = detail;
  const liveIp = byStack.standby.ip ?? '(ip unknown)';
  const retiredIp = byStack.primary.ip ?? '(ip unknown)';
  return [
    `Failover refused: "${environment}" already failed over, and no deploy has rebuilt the retired node as the standby yet.`,
    '',
    `  Live node      ${liveIp.padEnd(16)}role "${byStack.standby.role}", born as Pulumi stack "${environment}-standby"`,
    `  Retired node   ${retiredIp.padEnd(16)}role "${byStack.primary.role}", born as Pulumi stack "${environment}-primary"`,
    ...(lastFailover ? [`  Last failover  ${lastFailover}`] : []),
    '',
    `The retired node ${retiredIp} is frozen at the last failover and does not replicate,`,
    'so a second failover would promote a database missing every write since.',
    '',
    ...COMPOSE_HA_SWAPPED_RECOVERY(environment),
  ].join('\n');
}

/**
 * Failover's entry guard. Throws when the environment failed over and no deploy
 * has reconverged it (`lastFailover` is cleared only by a reconverge that
 * verified streaming); returns silently otherwise, including on a swapped pair
 * a deploy already rebuilt, where the reseed dials the role primary's address.
 * Called from failoverComposeHA before any ssh call.
 *
 * @param {{ projectName: string, environment: string, envConfig: object }} args
 */
export function assertNoComposeHaRoleSwap({ projectName, environment, envConfig }) {
  const detail = detectComposeHaRoleSwap({ projectName, environment, envConfig });
  if (!detail || !envConfig?.lastFailover) return;
  throw new Error(composeHaFailoverRefusalMessage(detail));
}

/**
 * The recovery steps `vibecarbon failover` prints after a compose-HA swap.
 * Shares COMPOSE_HA_SWAPPED_RECOVERY with the refusal so the two cannot drift.
 *
 * @param {{envName: string, promotedIp: string, retiredIp: string}} args
 * @returns {string[]}
 */
export function composeHaFailoverRecoveryInstructions({ envName, promotedIp, retiredIp }) {
  return [
    `1. ${promotedIp} is now the primary, every write from here on lands there.`,
    `2. Fix the issue on the retired node (${retiredIp}) but keep it out of service: its`,
    '   database is frozen at the moment of the failover.',
    `3. Run \`vibecarbon deploy ${envName}\` once ${retiredIp} answers: it keeps ${promotedIp}`,
    `   serving as the primary and rebuilds ${retiredIp} as the new standby from it.`,
  ];
}

/**
 * How to resync a compose-HA standby that restore's re-seed did not (or must
 * not) bring back. `vibecarbon deploy` is the resync in every case: on a failed
 * over environment it is the role-aware reconverge. A failover still in flight
 * has to finish first.
 *
 * @param {{projectName: string, environment: string, envConfig: object}} args
 * @returns {string}
 */
export function composeHaStandbyResyncHint({ projectName, environment, envConfig }) {
  if (envConfig?.ha?.failoverInFlight) {
    return (
      `A failover is still in flight: run \`vibecarbon failover ${environment}\` to finish it, ` +
      `then \`vibecarbon deploy ${environment}\` to rebuild the standby.`
    );
  }
  if (
    detectComposeHaRoleSwap({ projectName, environment, envConfig }) ||
    swappedSinceLastDeploy(envConfig)
  ) {
    return (
      `Run \`vibecarbon deploy ${environment}\`: it rebuilds the standby from the primary by ` +
      'role, with no downtime.'
    );
  }
  return `Run \`vibecarbon deploy ${environment}\` to resync the standby.`;
}

/** The fields of a servers[] entry a reconverge carries, plus its stack. */
function reconvergeNode(entry, stack) {
  return {
    ip: entry.ip ?? null,
    name: entry.name ?? null,
    id: entry.id ?? null,
    region: entry.region ?? null,
    serverType: entry.serverType ?? null,
    firewallId: entry.firewallId ?? null,
    stack,
  };
}

/**
 * Classify a compose-HA deploy (R12): null for a pair that has not failed over
 * since its last deploy and whose roles match its stacks (the normal deploy),
 * otherwise the role mapping the deploy converges to. `promoted` is the node the
 * persisted roles call primary, `retired` the other; each keeps its stack.
 *
 * A swapped pair stays a reconverge on every later deploy too (its roles never
 * match its stacks again), which is idempotent: the reseed is skipped while the
 * standby streams from the primary.
 *
 * @param {{ projectName: string, environment: string, envConfig: object }} args
 * @returns {null | { promoted: object, retired: object }}
 * @throws one line naming `vibecarbon failover` while a failover journal is set
 */
export function planComposeHaReconverge({ projectName, environment, envConfig } = {}) {
  if (envConfig?.deployMode !== 'compose-ha') return null;
  if (envConfig.ha?.failoverInFlight) {
    throw new Error(
      `Refusing to deploy "${environment}": a failover is still in flight (its journal is set), ` +
        `so the roles may be mid-swap. run vibecarbon failover ${environment} to finish it, then deploy`,
    );
  }
  const swapped = detectComposeHaRoleSwap({ projectName, environment, envConfig });
  if (!swapped && !swappedSinceLastDeploy(envConfig)) return null;

  const servers = Array.isArray(envConfig.servers) ? envConfig.servers : [];
  const promoted = servers.find((sv) => sv?.role === PRIMARY);
  const retired = servers.find((sv) => sv?.role === STANDBY);
  if (servers.length !== 2 || !promoted || !retired) return null;
  // Stack identity must be read, never assumed: it picks each stack's Pulumi
  // location and each node's tunnel address.
  const promotedStack = stackIdentityOf(promoted, projectName, environment);
  const retiredStack = stackIdentityOf(retired, projectName, environment);
  if (!promotedStack || !retiredStack || promotedStack === retiredStack) return null;
  return {
    promoted: reconvergeNode(promoted, promotedStack),
    retired: reconvergeNode(retired, retiredStack),
  };
}

/**
 * The reseed-target guard: refuse to wipe a node that may be the serving
 * primary, out of recovery with DNS pointing at it. The target is the retired
 * node by construction; this catches a config that says otherwise.
 *
 * @param {object} args
 * @param {string} args.environment
 * @param {{ ip: string }} args.target - the node about to be reseeded
 * @param {{ inRecovery: boolean|null }} args.state - its replica state
 * @param {string|null} args.domain
 * @param {string[]} args.dnsAnswer - the domain's A records
 */
export function assertReseedTargetNotServing({ environment, target, state, domain, dnsAnswer }) {
  if (state?.inRecovery === false && domain && dnsAnswer.includes(target.ip)) {
    throw new Error(
      `Refusing to reseed ${target.ip}: it is out of recovery and ${domain} resolves to it, so it ` +
        `may be the serving primary. point DNS at the promoted primary only, then rerun ` +
        `vibecarbon deploy ${environment}`,
    );
  }
}

/**
 * The reconverge preconditions (R12), read before any infra mutation: the
 * promoted node is out of recovery, DNS points at it, and the retired node is
 * not serving. Throws one line naming the cause and the command that fixes it.
 *
 * @param {object} args
 * @param {{ promoted: { ip: string }, retired: { ip: string } }} args.plan
 * @param {string} args.environment
 * @param {string|null} args.domain
 * @param {(ip: string) => Promise<{ inRecovery: boolean|null }>} args.readState
 * @param {(hostname: string) => Promise<string[]>} args.resolveA
 */
export async function assertComposeHaReconvergeReady({
  plan,
  environment,
  domain,
  readState,
  resolveA,
}) {
  const refuse = (cause) => {
    throw new Error(`Refusing to reconverge "${environment}": ${cause}`);
  };
  const { promoted, retired } = plan;
  const promotedState = await readState(promoted.ip);
  if (promotedState?.inRecovery == null) {
    refuse(
      `could not read the promoted primary's recovery state (${promoted.ip}). check its db is ` +
        `up, then rerun vibecarbon deploy ${environment}`,
    );
  }
  if (promotedState.inRecovery === true) {
    refuse(
      `the promoted node ${promoted.ip} is still in recovery, so the failover never finished ` +
        `promoting it. run vibecarbon failover ${environment} to finish it, then deploy`,
    );
  }
  if (!domain) return;
  let dnsAnswer = [];
  try {
    dnsAnswer = (await resolveA(domain)) ?? [];
  } catch {
    dnsAnswer = [];
  }
  if (!dnsAnswer.includes(promoted.ip)) {
    refuse(
      `${domain} resolves to ${dnsAnswer.join(', ') || 'nothing'}, not the promoted primary ` +
        `${promoted.ip}, so the failover's DNS flip has not landed. point the A records at ` +
        `${promoted.ip}, then rerun vibecarbon deploy ${environment}`,
    );
  }
  assertReseedTargetNotServing({
    environment,
    target: retired,
    state: await readState(retired.ip),
    domain,
    dnsAnswer,
  });
}
