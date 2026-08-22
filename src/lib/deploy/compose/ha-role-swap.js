/**
 * Compose-HA role-swap guard (data-loss refusal).
 *
 * THE HAZARD. `vibecarbon failover` persists a compose-HA swap by flipping the
 * `role` FIELD on `envConfig.servers[]` (see failoverComposeHA in ./ha.js).
 * Nothing else moves: array order, entry `name`s, and the two Pulumi stacks
 * (`${env}-primary` / `${env}-standby`) all keep their birth identity. But the
 * compose-HA deploy resolves the pair from that PROVISIONING identity —
 * effects/compose-ha.js reads ctx.primary/ctx.standby straight out of the
 * `${env}-primary` / `${env}-standby` stack outputs and never consults the role
 * field. So a `vibecarbon deploy` against a swapped environment would:
 *
 *   1. persist role:'primary' back onto the retired node (silently undoing the
 *      swap the failover recorded),
 *   2. re-point apex + wildcard DNS at that retired node, and
 *   3. call configureStandbyReplication(<promoted node>, <retired node>) —
 *      destructive by design: it wipes the target's PGDATA and re-basebackups
 *      it from the source. The target here is the PROMOTED primary, holding
 *      every write taken since the failover.
 *
 * k8s-HA does not have this hole: `swapHaRoles` (src/failover.js) swaps
 * `ha.primary` / `ha.standby` — objects that carry their own `.stack` — and the
 * orchestrator derives `haStacks` from them, so its redeploy follows the role↔
 * stack mapping. Compose-HA has no such reconciler.
 *
 * Until role-aware compose-HA redeploy ships, the deploy REFUSES a swapped
 * environment. There is deliberately no bypass flag: the only outcomes of
 * proceeding are silent data loss or a manual recovery the operator could just
 * as well perform before deploying.
 *
 * This module is PURE (no I/O, no imports) so the detector can be unit-tested
 * against config fixtures and called at the very top of executeDeployment,
 * ahead of every infra mutation.
 */

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
 * Render the refusal. States what is true of THIS environment (which node holds
 * the writes, which stack each was born as) and exactly what a deploy would do
 * to it, so the operator can act without reading the source.
 */
export function composeHaRoleSwapMessage(detail) {
  const { environment, byStack, lastFailover } = detail;
  const live = byStack.standby; // provisioned as `${env}-standby`, promoted by the failover
  const retired = byStack.primary; // provisioned as `${env}-primary`, retired by the failover
  const liveIp = live.ip ?? '(ip unknown)';
  const retiredIp = retired.ip ?? '(ip unknown)';
  return [
    `Refusing to deploy "${environment}": a failover has swapped the compose-HA roles in this environment.`,
    '',
    `  Live node      ${liveIp.padEnd(16)}role "${live.role}"  — provisioned as Pulumi stack "${environment}-standby"`,
    `  Retired node   ${retiredIp.padEnd(16)}role "${retired.role}"  — provisioned as Pulumi stack "${environment}-primary"`,
    ...(lastFailover ? [`  Last failover  ${lastFailover}`] : []),
    '',
    'Compose-HA deploy is not role-aware: it resolves the pair from the Pulumi stack',
    'names, not from the roles the failover persisted. On this environment it would',
    `  - re-point DNS (apex + wildcard) at the retired node ${retiredIp}, and`,
    `  - re-seed ${liveIp} as the standby, which WIPES that node's PostgreSQL data`,
    '    directory and re-basebackups it from the retired node, destroying every',
    '    write taken since the failover.',
    '',
    'This path is blocked until role-aware compose-HA redeploy support ships. There is',
    'no automated failback today: see the operational notes in docs/rto-rpo.md before',
    'taking any recovery action on this environment.',
  ].join('\n');
}

/**
 * Deploy-entry guard. Throws when the environment is in the post-failover
 * swapped state; returns silently otherwise (including for every non-compose-HA
 * tier). Called from executeDeployment before any infra mutation.
 */
export function assertNoComposeHaRoleSwap({ projectName, environment, envConfig }) {
  const detail = detectComposeHaRoleSwap({ projectName, environment, envConfig });
  if (!detail) return;
  throw new Error(composeHaRoleSwapMessage(detail));
}

/**
 * The recovery steps `vibecarbon failover` prints after a compose-HA swap.
 *
 * Lives here so it cannot drift from the refusal above — the instructions used
 * to end with "3. Redeploy to update configuration", which walked the operator
 * into exactly the data loss that guard now blocks.
 *
 * @param {{envName: string, promotedIp: string, retiredIp: string}} args
 * @returns {string[]}
 */
export function composeHaFailoverRecoveryInstructions({ envName, promotedIp, retiredIp }) {
  return [
    `1. ${promotedIp} is now the primary, every write from here on lands there.`,
    `2. Fix the issue on the retired node (${retiredIp}) but keep it out of service: its`,
    '   database is frozen at the moment of the failover.',
    `3. Do NOT run \`vibecarbon deploy ${envName}\`, compose-HA deploy is not role-aware,`,
    `   so it would re-point DNS at ${retiredIp} and WIPE ${promotedIp}'s database. Deploy`,
    '   refuses this environment until role-aware redeploy support ships.',
    '4. There is no automated failback today: see the operational notes in',
    '   docs/rto-rpo.md before restoring HA symmetry.',
  ];
}

/**
 * How to resync a compose-HA standby that a re-seed just failed to bring back
 * (restore.js's post-restore re-seed). `vibecarbon deploy` IS the resync for a
 * symmetric environment — it re-runs configureStandbyReplication — but on a
 * swapped one the same sentence points at a deploy that now refuses, so the
 * hint has to know which environment it is talking about. Shared with the
 * refusal above so the two can't disagree.
 *
 * @param {{projectName: string, environment: string, envConfig: object}} args
 * @returns {string}
 */
export function composeHaStandbyResyncHint({ projectName, environment, envConfig }) {
  if (detectComposeHaRoleSwap({ projectName, environment, envConfig })) {
    return (
      `\`vibecarbon deploy ${environment}\` cannot resync it: a failover has swapped this ` +
      "environment's roles and deploy refuses it (it would re-point DNS at the retired node " +
      'and wipe the promoted primary). See the operational notes in docs/rto-rpo.md.'
    );
  }
  return `Run \`vibecarbon deploy ${environment}\` to resync the standby.`;
}
