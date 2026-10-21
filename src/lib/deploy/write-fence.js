/**
 * The planned-failover write fence, as a recorded fact (HA-correctness Task 3).
 * Compose scale writes the same marker around its cutover fence
 * (compose/scale-cutover.js), so a killed scale is lifted the same way.
 *
 * A planned failover makes the old primary read-only at the database
 * (fenceDatabaseWrites in replication.js) before it promotes the standby. If
 * the run dies between that fence and the failover journal (SIGINT exits 130,
 * an ssh drop), nothing has promoted, yet the still-serving primary refuses
 * every write, and a redeploy would restart the app onto it. So the fence is
 * recorded before it is applied: `envConfig.ha.writeFence = { node, ip, at }`,
 * written through the same atomic config save as the journal.
 *
 * The marker is cleared when the fence is lifted, and by the role-swap save of
 * a completed failover (the retired node's read-only state then belongs to the
 * retired-node handling). With a journal present the promote may have started,
 * so the marker is left to the journal flow (`vibecarbon failover` finishes it).
 *
 * `vibecarbon failover` and `vibecarbon deploy` lift a stranded fence (marker,
 * no journal); deploy also probes the role primary after bring-up (defence in
 * depth); `vibecarbon status` shows a fenced primary.
 */

import { updateProjectConfig } from '../config.js';
import { failoverInFlightNextStep } from './failover-guard.js';
import { UNFENCE_SQL_HINT, unfenceDatabaseWrites, WRITE_FENCE_SETTING } from './replication.js';
import { isRetiredSide } from './retired-fence.js';

/**
 * Record the fence BEFORE applying it.
 *
 * @param {{ environment: string }} ctx
 * @param {{ node?: string, ip: string, source?: 'scale' }} target - the old
 *   primary. Scale passes no node: its replacement keeps the servers[] name,
 *   so a name would also match the new server; scale markers match by IP.
 */
export function writeWriteFenceMarker(ctx, { node, ip, source }) {
  updateProjectConfig((config) => {
    const envConfig = config.environments?.[ctx.environment];
    if (!envConfig) {
      throw new Error(`write fence: environment ${ctx.environment} is not in .vibecarbon.json`);
    }
    envConfig.ha = {
      ...(envConfig.ha ?? {}),
      writeFence: {
        ...(node ? { node } : {}),
        ip,
        ...(source ? { source } : {}),
        at: new Date().toISOString(),
      },
    };
  });
}

/** Clear the marker once the fence is lifted. A no-op when none is set. */
export function clearWriteFenceMarker(ctx) {
  updateProjectConfig((config) => {
    const ha = config.environments?.[ctx.environment]?.ha;
    if (!ha || !('writeFence' in ha)) return;
    delete ha.writeFence;
    // A single-server compose env carries `ha` only for this marker (scale's
    // fence): leave no empty `ha` behind, which status reads as HA.
    if (Object.keys(ha).length === 0) delete config.environments[ctx.environment].ha;
  });
}

/** What left a fence, for the operator's line: a scale's marker says so. */
const fenceSource = (marker) =>
  marker?.source === 'scale' ? 'an interrupted scale' : 'an interrupted failover';

/**
 * The remedy while a compose scale's cutover journal is set: the scale itself
 * finishes it, or rolls it back.
 *
 * @param {string} environment
 * @returns {string}
 */
export function scaleCutoverNextStep(environment) {
  return `rerun vibecarbon scale ${environment} to finish it, or roll it back if DNS never moved`;
}

/**
 * Journal a compose scale's cutover on its write-fence marker, BEFORE the DNS
 * flip starts: from here the database may serve from the new server, so the
 * old one must never be lifted by a deploy (two writable primaries in one
 * lineage). `vibecarbon scale` resumes from it; `done` lists the post-flip
 * steps already run.
 *
 * @param {{ environment: string }} ctx
 * @param {{ oldId: string|number, oldIp: string, newServerId: string|number, newIp: string,
 *   stopped: string[], cronRemoved: boolean }} cutover
 */
export function writeScaleCutoverJournal(ctx, cutover) {
  updateProjectConfig((config) => {
    const fence = config.environments?.[ctx.environment]?.ha?.writeFence;
    if (!fence) {
      throw new Error(`scale cutover: no write-fence marker for ${ctx.environment} to journal on`);
    }
    fence.cutover = { ...cutover, done: [], startedAt: new Date().toISOString() };
  });
}

/** Record a post-flip step of the journaled cutover as done. */
export function markScaleCutoverStep(ctx, step) {
  updateProjectConfig((config) => {
    const cutover = config.environments?.[ctx.environment]?.ha?.writeFence?.cutover;
    if (cutover && !cutover.done.includes(step)) cutover.done.push(step);
  });
}

/** Drop the cutover journal, keeping the marker (a fence still on the old server). */
export function clearScaleCutoverJournal(ctx) {
  updateProjectConfig((config) => {
    const fence = config.environments?.[ctx.environment]?.ha?.writeFence;
    if (fence) delete fence.cutover;
  });
}

/**
 * Refuse a command while a compose scale's cutover is journaled: the config
 * may still name the old server while DNS and the database already moved.
 *
 * @param {{ environment: string, envConfig: object, action: string }} args
 */
export function assertNoScaleCutoverInFlight({ environment, envConfig, action }) {
  const cutover = envConfig?.ha?.writeFence?.cutover;
  if (!cutover) return;
  throw new Error(
    `Refusing to ${action} "${environment}": a compose scale stopped mid-cutover ` +
      `(old server ${cutover.oldIp}, new server ${cutover.newIp}); ` +
      scaleCutoverNextStep(environment),
  );
}

/**
 * Read the role primary's write-fence setting from a fresh session.
 *
 * @param {(sql: string) => Promise<string>} exec
 * @returns {Promise<'on'|'off'|null>} null when unreadable
 */
export async function readWriteFence(exec) {
  try {
    const out = String((await exec(`SELECT current_setting('${WRITE_FENCE_SETTING}')`)) ?? '');
    const v = out.trim();
    return v === 'on' || v === 'off' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Lift a fence a planned failover left behind without promoting (ruling 2):
 * a marker with no journal. Only on the node the marker names when it is
 * still the role primary; a marker on any other node is stale and is cleared.
 *
 * @param {object} opts
 * @param {string} opts.environment
 * @param {object} opts.envConfig - persisted env config (marker + journal)
 * @param {{ name?: string, ip: string }} opts.rolePrimary
 * @param {(sql: string, o?: object) => Promise<string>} opts.exec - psql on the role primary
 * @param {(line: string) => void} opts.log - one line for the operator
 * @param {object} [opts.deps]
 * A retired node (retired-fence.js) is never lifted here: its read-only
 * setting is the retirement fence, which comes off only when a deploy has
 * rebuilt it as a proven replica.
 *
 * @returns {Promise<'none'|'journal'|'retired'|'stale'|'lifted'>}
 * @throws when the fence cannot be lifted (the one-line cause and manual fix)
 */
export async function liftStrandedWriteFence({
  environment,
  envConfig,
  rolePrimary,
  exec,
  log,
  deps = {},
}) {
  const {
    unfence = (e) => unfenceDatabaseWrites({ exec: e }),
    clearMarker = clearWriteFenceMarker,
  } = deps;
  const marker = envConfig?.ha?.writeFence;
  if (!marker) return 'none';
  // A scale cutover journal is a journal too: the database may already serve
  // from the new server, so the old one is never lifted here.
  if (envConfig?.ha?.failoverInFlight || marker.cutover) return 'journal';
  if (isRetiredSide(envConfig, rolePrimary?.ip)) return 'retired';
  const onPrimary =
    rolePrimary &&
    (marker.ip === rolePrimary.ip || (marker.node && marker.node === rolePrimary.name));
  if (!onPrimary) {
    clearMarker({ environment });
    log(
      `cleared a stale write-fence record for ${marker.node || marker.ip}: it is not the primary`,
    );
    return 'stale';
  }
  if (!(await unfence(exec))) {
    throw new Error(
      `the primary (${rolePrimary.ip}) is still write-fenced from ${fenceSource(marker)} and ` +
        `could not be lifted; run this in its db container, then rerun: ${UNFENCE_SQL_HINT}`,
    );
  }
  clearMarker({ environment });
  log(
    `lifted the write fence ${fenceSource(marker)} left on the primary (${rolePrimary.ip}); ` +
      'it takes writes again',
  );
  return 'lifted';
}

/**
 * Deploy's defence in depth (ruling 3): after bring-up the role primary must
 * take writes. A primary that reads fenced with no journal is lifted (and any
 * marker cleared) with a warning; with a journal the failover is mid-flight,
 * so deploy refuses and names the command that finishes it.
 *
 * @returns {Promise<'writable'|'unknown'|'lifted'>}
 * @throws on a fenced primary with a journal, or a lift that fails
 */
export async function assertRolePrimaryWritable({ environment, envConfig, exec, warn, deps = {} }) {
  const {
    unfence = (e) => unfenceDatabaseWrites({ exec: e }),
    clearMarker = clearWriteFenceMarker,
    read = readWriteFence,
  } = deps;
  const state = await read(exec);
  if (state !== 'on') return state === 'off' ? 'writable' : 'unknown';
  // A scale cutover in flight: the fenced server is the one the database is
  // moving away from. Lifting it would make two writable primaries.
  const cutover = envConfig?.ha?.writeFence?.cutover;
  if (cutover) {
    throw new Error(
      `the primary is write-fenced by a compose scale cutover still in flight; ` +
        scaleCutoverNextStep(environment),
    );
  }
  if (envConfig?.ha?.failoverInFlight) {
    throw new Error(
      `the primary is write-fenced by a failover still in flight; ` +
        failoverInFlightNextStep(environment),
    );
  }
  if (!(await unfence(exec))) {
    throw new Error(
      `the primary is write-fenced and could not be lifted; run this in its db container, ` +
        `then rerun vibecarbon deploy: ${UNFENCE_SQL_HINT}`,
    );
  }
  clearMarker({ environment });
  warn('the primary was write-fenced with no failover in flight; lifted it, it takes writes again');
  return 'lifted';
}
