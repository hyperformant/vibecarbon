/**
 * ENVIRONMENT SERVER-NAME FAMILY — every provider-side server name one
 * environment's lifecycle can produce, in one place.
 *
 * WHY THIS EXISTS
 * ---------------
 * The compose tiers have no Pulumi-graph walk to lean on at teardown: their
 * destroy paths find servers BY NAME (destroyComposeTier's `providerServerName`
 * fallback, resolveHaServers' `findServersByName` pair). That is only as
 * complete as the list of names they try, and the list was the DEPLOY's names —
 * `${project}-${env}` and `${project}-${env}-(primary|standby)`.
 *
 * `scale` creates a server the deploy never does. Its blue-green replacement is
 * provisioned OUTSIDE Pulumi (`provider.createServer` straight from
 * scale.js's `scaleServers`) under a temporary name
 *
 *     `${projectName}-${environment}[-${role}]-new`
 *
 * and only renamed to the permanent name at the END of a successful migration
 * (scale.js step 12, `provider.renameServer`). Kill a scale run between those
 * two points — SIGKILL, a lost laptop link, a cancelled CI job — and the `-new`
 * server survives with a name no destroy path has ever looked for, in no Pulumi
 * state any destroy can walk (it was never a Pulumi resource, and a killed run
 * checkpoints nothing).
 *
 * Live receipt (2026-08-10, all-provider orphan audit): a killed mid-scale
 * compose-ha run left `<project>-e2-primary-new` and `<project>-e2-standby-new`
 * running. The subsequent `destroy e2 -y -orphans -purge` printed
 *   "No leaked resources: every targeted resource was confirmed deleted ...
 *    and every provider listing was read in full"
 * while both servers were sitting in the very listing it had just read. Not a
 * missed delete — a missed NAME. The teardown was honest about everything it
 * knew to look for, and `-new` was not in that set.
 *
 * THE FAMILY, ENUMERATED FROM THE CODE
 * ------------------------------------
 * Every `${projectName}-${environment}...` server name any lifecycle command
 * can create today:
 *
 *   deploy   compose      `${p}-${e}`                        effects/index.js
 *   deploy   compose-ha   `${p}-${e}-primary` / `-standby`   iac program, via
 *                                                            stackEnv
 *   scale    both         the same names + `-new`            scale.js
 *   failover both         (none — flips a role FIELD only)   failover.js
 *   restore  both         (none — reuses the live servers)   restore.js
 *
 * `-new` is therefore the ONLY transient suffix in the lifecycle, and
 * tests/unit/destroy/server-name-family-census.test.ts walks src/ to keep that
 * true: any new `${projectName}-${environment}`-shaped literal must be
 * classified here (server → joins the family) or in the census's
 * non-server allowlist (firewall / ssh-key / cluster / stack), or the census
 * fails. A suffix nobody classified is exactly how `-new` got missed.
 *
 * Pure — no I/O, no provider imports — so both destroy.js and
 * deploy/compose/ha.js can share it (ha.js cannot import destroy.js: destroy
 * registers process-level signal handlers at module load, the same constraint
 * that put deleteApexAndWildcard in the DNS backends).
 */

/**
 * The role suffixes a compose-HA environment provisions. Compose-single has
 * no role suffix at all (its server is the bare `${project}-${env}`), which is
 * why the empty base is always part of the family.
 */
export const HA_ROLE_SUFFIXES = ['primary', 'standby'];

/**
 * scale.js's temporary blue-green name suffix. A server still carrying it is
 * BY DEFINITION mid-scale residue: the successful path renames it away before
 * scale returns.
 */
export const SCALE_REPLACEMENT_SUFFIX = 'new';

/** Role labels that are provider-name components, not config-only role fields. */
function normalizeRoles(roles) {
  const out = new Set(HA_ROLE_SUFFIXES);
  for (const role of roles ?? []) {
    if (typeof role === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(role)) out.add(role);
  }
  return [...out];
}

/**
 * Every provider-side server name this environment's lifecycle can produce.
 *
 * Deliberately a superset: it costs one extra `findServersByName` per name at
 * teardown (an exact-name filter, not a listing walk) and buys immunity to the
 * whole class. A name that never existed simply resolves to nothing.
 *
 * @param {object} args
 * @param {string} args.projectName
 * @param {string} args.environment
 * @param {string[]} [args.roles] - extra role suffixes seen in this env's
 *   persisted `servers[]`; the HA pair is always included regardless.
 * @returns {string[]} permanent names first, then their `-new` twins.
 */
export function environmentServerNames({ projectName, environment, roles } = {}) {
  if (!projectName || !environment) return [];
  const bases = ['', ...normalizeRoles(roles).map((role) => `-${role}`)];
  const permanent = bases.map((base) => `${projectName}-${environment}${base}`);
  return [...permanent, ...permanent.map((name) => `${name}-${SCALE_REPLACEMENT_SUFFIX}`)];
}

/**
 * The transient (mid-scale) half of the family — the names that must never
 * outlive a scale run, and which no deploy ever creates.
 *
 * @param {object} args - same shape as environmentServerNames
 * @returns {string[]}
 */
export function scaleReplacementNames(args) {
  return environmentServerNames(args).filter((name) =>
    name.endsWith(`-${SCALE_REPLACEMENT_SUFFIX}`),
  );
}

/**
 * Is `name` a scale replacement server's temporary name?
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isScaleReplacementName(name) {
  return typeof name === 'string' && name.endsWith(`-${SCALE_REPLACEMENT_SUFFIX}`);
}

/**
 * Does this provider-side server name belong to this environment?
 *
 * @param {string} name
 * @param {object} args - same shape as environmentServerNames
 * @returns {boolean}
 */
export function isEnvironmentServerName(name, args) {
  return typeof name === 'string' && environmentServerNames(args).includes(name);
}

/**
 * The values this environment's servers can carry in their `environment`
 * LABEL — which is not the same set as the name suffixes.
 *
 * Compose-HA runs one Pulumi stack per node and passes the STACK env into the
 * program (`environment: ${env}-primary`), so its Pulumi-created servers are
 * labelled `e2-primary` / `e2-standby`. scale's replacement server is created
 * outside Pulumi and labelled with the PLAIN env (`e2` — see
 * buildReplacementServerArgs). A label filter that knew only one of those
 * shapes would miss the other, which is the same single-spelling mistake the
 * name family above exists to prevent.
 *
 * @param {object} args
 * @param {string} args.environment
 * @param {string} [args.deployMode]
 * @returns {string[]}
 */
export function environmentLabelValues({ environment, deployMode } = {}) {
  if (!environment) return [];
  if (deployMode === 'compose-ha') {
    return [environment, ...HA_ROLE_SUFFIXES.map((role) => `${environment}-${role}`)];
  }
  return [environment];
}

/**
 * Ownership predicate for the destroy-time backstop sweep: does this provider
 * server row belong to the environment being destroyed?
 *
 * Two independent signals, either sufficient:
 *   - LABELS (`managed-by=vibecarbon` + project + one of this env's label
 *     values). Survives a rename; the strong signal.
 *   - NAME in the family above. Survives a provider that drops labels, and
 *     covers any pre-label server.
 *
 * Both are required to agree on the PROJECT, so a second project's `e2` in the
 * same account is never in scope.
 *
 * @param {{name?: string|null, labels?: Record<string,string>}} server
 * @param {object} args
 * @param {string} args.projectName
 * @param {string} args.environment
 * @param {string} [args.deployMode]
 * @param {string[]} [args.roles]
 * @returns {boolean}
 */
export function isEnvironmentOwnedServer(server, { projectName, environment, deployMode, roles }) {
  if (!server || !projectName || !environment) return false;
  const labels = server.labels ?? {};
  const labelOwned =
    labels['managed-by'] === 'vibecarbon' &&
    labels.project === projectName &&
    environmentLabelValues({ environment, deployMode }).includes(labels.environment);
  if (labelOwned) return true;
  return isEnvironmentServerName(server.name, { projectName, environment, roles });
}
