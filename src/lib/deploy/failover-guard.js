/**
 * Failover guard: the positive replica proof, the preconditions gate and the
 * failover journal shared by both HA tiers (compose-ha and k8s-ha).
 *
 * Failover used to infer "a previous run already promoted it" from
 * `pg_is_in_recovery() = 'f'` alone. That one reading is true in three worlds
 * that must never be promoted: the old primary on a failback before
 * `vibecarbon deploy` reconverged, an unseeded standby finalized under
 * `-allow-degraded`, and a standby whose promote landed after the first run
 * gave up and un-quiesced the old primary. So nothing reads it alone any more:
 *
 *   - `readReplicaState` is the one place that turns psql's 't'/'f' text into a
 *     value (the promote-inference census enforces that);
 *   - `assertFailoverPreconditions` decides promote, resume or refuse from that
 *     state plus the persisted config (R1);
 *   - the journal (`ha.failoverInFlight`, R2) is what lets "out of recovery"
 *     mean "this failover already promoted it". It is written right before the
 *     promote call and cleared by the same save that persists the role swap.
 */

import { randomUUID } from 'node:crypto';
import * as p from '@clack/prompts';
import { exitCancelled, exitDeclined } from '../cli/exit-guard.js';
import { updateProjectConfig } from '../config.js';
import { DEGRADED_CAUSE } from './env-safety-fields.js';

/** Refusal raised before any write. The message names the reason and `vibecarbon deploy`. */
export class FailoverRefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FailoverRefusedError';
  }
}

/**
 * One round trip: recovery flag, cluster identity, replay position and the
 * walreceiver's view. The receiver subqueries return no row on a primary, which
 * psql -tA prints as an empty field.
 */
export const REPLICA_STATE_SQL =
  'SELECT pg_is_in_recovery(), ' +
  '(SELECT system_identifier FROM pg_control_system()), ' +
  'pg_last_wal_replay_lsn(), ' +
  '(SELECT status FROM pg_stat_wal_receiver), ' +
  '(SELECT floor(EXTRACT(EPOCH FROM now() - last_msg_receipt_time)) FROM pg_stat_wal_receiver)';

const UNKNOWN_STATE = Object.freeze({
  inRecovery: null,
  systemIdentifier: null,
  replayLsn: null,
  receiverStatus: null,
  lastMsgAgeS: null,
});

/**
 * Read a database's replica state through the tier's psql runner. Never throws:
 * an exec failure or output that is not one well-formed row reads as all-null,
 * which every caller treats as unknown (never as promoted).
 *
 * @param {{ exec: (sql: string) => Promise<string> }} args
 * @returns {Promise<{ inRecovery: boolean|null, systemIdentifier: string|null, replayLsn: string|null, receiverStatus: string|null, lastMsgAgeS: number|null }>}
 */
export async function readReplicaState({ exec }) {
  let out;
  try {
    out = await exec(REPLICA_STATE_SQL);
  } catch {
    return { ...UNKNOWN_STATE };
  }
  const row = (typeof out === 'string' ? out : '').trim().split('\n').pop() ?? '';
  const fields = row.split('|');
  if (fields.length !== 5) return { ...UNKNOWN_STATE };
  const [recovery, sysid, lsn, status, age] = fields.map((f) => f.trim());
  const inRecovery = recovery === 't' ? true : recovery === 'f' ? false : null;
  if (inRecovery === null) return { ...UNKNOWN_STATE };
  const ageNum = age === '' ? null : Number(age);
  return {
    inRecovery,
    systemIdentifier: /^\d+$/.test(sysid) ? sysid : null,
    replayLsn: /^[0-9A-Fa-f]+\/[0-9A-Fa-f]+$/.test(lsn) ? lsn : null,
    receiverStatus: status || null,
    lastMsgAgeS: Number.isFinite(ageNum) ? ageNum : null,
  };
}

/**
 * R8: a walreceiver message younger than this means the primary is still
 * streaming to the standby, so it is alive even if this machine cannot reach it.
 */
export const PRIMARY_ALIVE_MAX_AGE_S = 60;

/** The R8 refusal: the operator is partitioned from a primary that is alive. */
export const PRIMARY_ALIVE_MESSAGE =
  'the primary is still streaming to the standby; your machine cannot reach it. ' +
  'Rerun with -force-unplanned to fail over anyway';

/**
 * Classify a failover from the standby's vantage point (R8). The operator's
 * own reachability check says only what this machine sees: a primary behind a
 * partition looks exactly like a dead one. The standby's walreceiver is the
 * better witness. `streaming` with a message under 60 s old means the primary
 * is alive and still shipping WAL, and an unplanned failover would make a
 * second primary next to it. A streaming receiver whose age cannot be read
 * counts as alive (fail safe: -force-unplanned overrides).
 *
 * @param {{ primaryReachable: boolean, standbyState: Awaited<ReturnType<typeof readReplicaState>>|null }} args
 * @returns {'planned'|'unplanned'|'refuse-primary-alive'}
 */
export function classifyFailover({ primaryReachable, standbyState }) {
  if (primaryReachable) return 'planned';
  if (standbyState?.receiverStatus !== 'streaming') return 'unplanned';
  const age = standbyState.lastMsgAgeS;
  return typeof age === 'number' && age >= PRIMARY_ALIVE_MAX_AGE_S
    ? 'unplanned'
    : 'refuse-primary-alive';
}

/**
 * Throw the R8 refusal when the classification says the primary is alive and
 * the operator did not pass -force-unplanned. Runs before any write.
 *
 * @param {ReturnType<typeof classifyFailover>} kind
 * @param {{ forceUnplanned?: boolean }} parsed
 */
export function assertFailoverClassified(kind, parsed) {
  if (kind === 'refuse-primary-alive' && !parsed?.forceUnplanned) {
    throw new FailoverRefusedError(`Failover refused: ${PRIMARY_ALIVE_MESSAGE}`);
  }
}

/**
 * The way out while a failover journal is set: finish the failover, or call it
 * off. Every refusal that fires on a journal names both, never a command that
 * would refuse in turn (deploy, restore and scale all refuse on a journal).
 *
 * @param {string} environment
 * @returns {string}
 */
export function failoverInFlightNextStep(environment) {
  return (
    `rerun \`vibecarbon failover ${environment}\` to finish it, or run \`vibecarbon failover ` +
    `${environment} -abort\` to call it off and keep the old primary`
  );
}

/**
 * Deploy, restore and scale refuse while a failover journal is set, on every HA
 * tier: the roles may be mid-swap, the standby may be promoting, and a deploy's
 * final save rebuilds `ha` and would drop the journal the rerun of `vibecarbon
 * failover` resumes from. A restore would also rewind and restart the fenced
 * old primary while the standby may already serve as a second one.
 *
 * @param {{ environment: string, envConfig: object, action?: 'deploy'|'restore'|'scale' }} args
 */
export function assertNoFailoverInFlight({ environment, envConfig, action = 'deploy' }) {
  if (envConfig?.ha?.failoverInFlight) {
    throw new Error(
      `Refusing to ${action} "${environment}": a failover is still in flight (its journal is set), ` +
        `so the roles may be mid-swap. ${failoverInFlightNextStep(environment)}`,
    );
  }
}

/** True when a failover swapped the roles and no deploy has reconverged since. */
export function swappedSinceLastDeploy(envConfig) {
  if (!envConfig?.lastFailover) return false;
  const failedOverAt = Date.parse(envConfig.lastFailover);
  const deployedAt = Date.parse(envConfig.deployedAt ?? '');
  if (Number.isNaN(deployedAt)) return true;
  return Number.isNaN(failedOverAt) || failedOverAt > deployedAt;
}

/**
 * The preconditions gate (R1). Runs before any quiesce, cloud change or kubectl
 * write. Returns `{ mode: 'resume' }` only when the standby is out of recovery
 * AND the journal says this failover promoted it; otherwise a promote needs a
 * standby that is in recovery, holds the recorded database and is not degraded.
 *
 * Planned mode with nothing recorded is allowed only against a streaming
 * standby whose identifier matches the live primary's (`primaryState`); an
 * unplanned one refuses, since nothing proves the standby holds this database.
 *
 * @param {object} args
 * @param {object} args.envConfig
 * @param {string} args.environment
 * @param {Awaited<ReturnType<typeof readReplicaState>>} args.standbyState
 * @param {'compose-ha'|'k8s-ha'} args.tier
 * @param {boolean} [args.planned] the old primary answered (planned switchover)
 * @param {Awaited<ReturnType<typeof readReplicaState>>|null} [args.primaryState]
 * @param {boolean} [args.forceUnproven] -force-unproven: unplanned only, skips the
 *   system identifier proof (the standby must still be in recovery)
 * @param {boolean} [args.allowDegraded] -allow-degraded: with forceUnproven only,
 *   also accepts a standby the last deploy flagged degraded
 * @returns {{ mode: 'promote'|'resume', unproven?: true }}
 */
export function assertFailoverPreconditions({
  envConfig,
  environment,
  standbyState,
  tier,
  planned = false,
  primaryState = null,
  forceUnproven = false,
  allowDegraded = false,
}) {
  if (tier !== 'compose-ha' && tier !== 'k8s-ha') {
    throw new Error(`assertFailoverPreconditions: unknown tier ${JSON.stringify(tier)}`);
  }
  const deploy = `vibecarbon deploy ${environment}`;
  const refuse = (reason) => {
    throw new FailoverRefusedError(`Failover refused: ${reason}`);
  };
  // The repair a refusal names. With a journal set, deploy itself refuses, so
  // the abort comes first (C1: no refusal may point at a command that refuses).
  const repair = envConfig?.ha?.failoverInFlight
    ? (why) =>
        `a failover is in flight, so deploy refuses until it is settled: run vibecarbon ` +
        `failover ${environment} -abort to call it off and keep the old primary, then run ` +
        `${deploy} ${why}`
    : (why) => `run ${deploy} ${why}`;

  if (standbyState?.inRecovery == null) {
    refuse(
      `could not read the standby database's recovery state, so nothing proves it is a ` +
        `replica. check the standby db is up, or ${repair('to repair replication')}`,
    );
  }

  if (forceUnproven && planned) {
    refuse(
      `-force-unproven is for a dead primary only. the primary is answering, so this is a ` +
        `planned failover and the standby must prove it holds this database. drop the flag, ` +
        `or ${repair('to record the proof')}`,
    );
  }
  if (allowDegraded && !forceUnproven) {
    refuse(
      `-allow-degraded only applies together with -force-unproven. ` +
        repair('to restore streaming instead'),
    );
  }

  if (swappedSinceLastDeploy(envConfig)) {
    refuse(
      `the last failover (${envConfig.lastFailover}) swapped the roles and no deploy has ` +
        `reconverged since, so the standby is the old primary and holds none of the new ` +
        `writes. ${repair('first, then fail over')}`,
    );
  }

  if (envConfig?.replication === 'degraded' && !(forceUnproven && allowDegraded)) {
    refuse(
      `replication is degraded (the last deploy did not prove the standby streaming), so ` +
        `the standby may be missing writes or hold no data at all. ` +
        repair('to restore streaming, then fail over'),
    );
  }

  // A promoted standby without the app image serves nothing. With the
  // primary up, a deploy copies it there first, so a planned failover refuses.
  // With the primary dead nothing can copy it, so -force-unproven promotes
  // anyway and says the app is down until a deploy builds it on the new
  // primary. A failover already in flight is let finish (R6).
  if (
    envConfig?.degradedCause === DEGRADED_CAUSE.STANDBY_IMAGE_MISSING &&
    !envConfig?.ha?.failoverInFlight
  ) {
    const missing =
      `the standby is missing the app image (the last deploy could not copy it to the ` +
      `standby's registry), so a promoted standby could not start the app.`;
    if (planned) refuse(`${missing} ${repair('to copy it, then fail over')}`);
    if (!forceUnproven) {
      refuse(
        `${missing} the primary is unreachable, so no deploy can copy it there now. pass ` +
          `-force-unproven to promote it anyway; it serves nothing until a deploy builds ` +
          `the image on it`,
      );
    }
    p.log.warn(
      'the promoted standby has no app image; it serves nothing until\n' +
        `  vibecarbon deploy ${environment}\n` +
        'builds it there',
    );
  }

  const recorded = envConfig?.ha?.systemIdentifier ?? null;
  const live = standbyState.systemIdentifier;

  if (standbyState.inRecovery === false) {
    const journal = envConfig?.ha?.failoverInFlight;
    const expected = journal?.systemIdentifier ?? recorded;
    if (journal?.target === 'standby' && live && expected && live === expected) {
      return { mode: 'resume' };
    }
    refuse(
      `the standby is not a replica (it is out of recovery) and no failover is in flight ` +
        `for it, so promoting it could serve stale or empty data. ${repair('to reseed it')}`,
    );
  }

  // Past here only the identifier proof remains, which -force-unproven skips.
  // The standby is in recovery (a replica of something); that is all it proves.
  if (forceUnproven) return { mode: 'promote', unproven: true };

  const differentDatabase = (expectedId, source) =>
    refuse(
      `the standby holds a different database (system identifier ${live ?? 'unreadable'}, ` +
        `${source} ${expectedId}), so it was never seeded from this primary. ` +
        repair('to reseed it'),
    );

  if (recorded) {
    if (live !== recorded) differentDatabase(recorded, 'recorded at its last seed:');
  } else {
    const primaryId = primaryState?.systemIdentifier ?? null;
    if (!planned || standbyState.receiverStatus !== 'streaming' || !primaryId) {
      refuse(
        `no seeded system identifier is recorded for ${environment}, so nothing proves the ` +
          `standby holds this database. ${repair('to record it')}`,
      );
    }
    if (live !== primaryId) differentDatabase(primaryId, 'the primary has');
  }
  if (planned && primaryState?.systemIdentifier && live !== primaryState.systemIdentifier) {
    differentDatabase(primaryState.systemIdentifier, 'the primary has');
  }
  return { mode: 'promote' };
}

/**
 * Write the failover journal (R2) through the project config save, right before
 * the promote call. A rerun that finds the standby out of recovery resumes only
 * when this names it.
 *
 * @param {{ environment: string }} ctx
 * @param {{ target: 'primary'|'standby', primaryLsn: string|null, systemIdentifier: string, override?: 'force-unproven' }} journal
 * @returns {Promise<string>} the journal id
 */
export async function writeFailoverJournal(
  ctx,
  { target, primaryLsn, systemIdentifier, override },
) {
  const id = randomUUID();
  updateProjectConfig((config) => {
    const envConfig = config.environments?.[ctx.environment];
    if (!envConfig) {
      throw new Error(
        `failover journal: environment ${ctx.environment} is not in .vibecarbon.json`,
      );
    }
    envConfig.ha = {
      ...(envConfig.ha ?? {}),
      failoverInFlight: {
        id,
        target,
        startedAt: new Date().toISOString(),
        primaryLsn: primaryLsn ?? null,
        systemIdentifier,
        ...(override && { override }),
      },
    };
  });
  return id;
}

/**
 * Clear the journal when a promote was proven not to have happened. A completed
 * failover clears it in the role-swap save instead (`swapHaRoles`).
 *
 * @param {{ environment: string }} ctx
 * @returns {Promise<void>}
 */
export async function clearFailoverJournal(ctx) {
  updateProjectConfig((config) => {
    const ha = config.environments?.[ctx.environment]?.ha;
    if (ha) delete ha.failoverInFlight;
  });
}

/**
 * Record the system identifier of a freshly seeded or verified-streaming
 * standby, the value R1(b) compares against at failover time.
 *
 * @param {{ environment: string }} ctx
 * @param {string} systemIdentifier
 */
export function recordSystemIdentifier(ctx, systemIdentifier) {
  if (!systemIdentifier) return;
  updateProjectConfig((config) => {
    const envConfig = config.environments?.[ctx.environment];
    if (!envConfig) return;
    envConfig.ha = { ...(envConfig.ha ?? {}), systemIdentifier };
  });
}

/**
 * Mark the standby unproven after a restore that did not reseed it and verify
 * it (skipped, failed, or never confirmed): replication degraded, and the
 * recorded system identifier dropped. The restore rewound the primary, so the
 * standby's identifier still matches but its data is ahead of the restored
 * primary on another history; without this the replica proof would pass it.
 * The next deploy reseeds it and records the identifier again.
 *
 * @param {{ environment: string }} ctx
 */
export function markStandbyUnproven(ctx) {
  updateProjectConfig((config) => {
    const envConfig = config.environments?.[ctx.environment];
    if (!envConfig) return;
    envConfig.replication = 'degraded';
    envConfig.degraded = true;
    if (envConfig.ha && typeof envConfig.ha === 'object') delete envConfig.ha.systemIdentifier;
  });
}

/**
 * The `ha` fields a deploy persists for failover's replica proof: the standby's
 * system identifier, only when this deploy verified streaming. A degraded deploy
 * records nothing, so an unplanned failover refuses until one proves it.
 *
 * @param {{ replicationStatus?: string, systemIdentifier?: string|null }} deployResult
 * @returns {{ systemIdentifier?: string }}
 */
export function haSeedRecord(deployResult) {
  const { replicationStatus, systemIdentifier } = deployResult ?? {};
  return replicationStatus === 'streaming' && systemIdentifier ? { systemIdentifier } : {};
}

/** The one-line risk statement for -force-unproven. */
export const UNPROVEN_RISK_LINE =
  '-force-unproven: nothing proves the standby holds this database, so the promoted side may ' +
  'be missing writes or hold different data entirely';

/**
 * Typed confirmation for -force-unproven: the env name, or -y. Without a TTY
 * and without -y it refuses rather than hanging on a prompt.
 *
 * @param {string} envName
 * @param {{ yes?: boolean }} parsed
 */
export async function confirmUnprovenFailover(envName, parsed) {
  if (parsed.yes) return;
  if (!process.stdin.isTTY) {
    p.log.error('-force-unproven needs a typed confirmation; pass -y in a script');
    process.exit(1);
  }
  const typed = await p.text({
    message: `Type ${envName} to promote a standby nothing proves is a replica`,
  });
  if (p.isCancel(typed)) exitCancelled();
  if (typed !== envName) exitDeclined();
}

/** R3: the exit message for a promotion the flow could not confirm. */
export function promotionUnknownMessage(envName) {
  return `promotion state unknown: old primary kept fenced. ${failoverInFlightNextStep(envName)}`;
}

/**
 * The exit message for a promote that was never sent: the standby did not read
 * as a replica right before it. Used only when this run started with no journal,
 * so nothing anywhere has asked the standby to promote.
 *
 * @param {string} envName
 * @param {string} standbyIp
 */
export function promotionNotIssuedMessage(envName, standbyIp) {
  return (
    `Failover aborted: the standby ${standbyIp} did not read as a replica right before ` +
    `the promote, so no promote was sent and the old primary keeps serving. check the ` +
    `standby db is up, then rerun vibecarbon failover ${envName}`
  );
}

/**
 * Raised when the role swap is persisted but the DNS flip is not proven. The
 * failover itself happened (the standby is promoted, the swap is saved), so the
 * only thing left undone is pointing the A records at the new primary. The
 * message names the record and the deploy that repoints it (managed DNS: the
 * compose reconverge repoints before its reseed gate, k8s at its DNS step).
 */
export class FailoverDnsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FailoverDnsError';
  }
}

/**
 * @param {{ domain: string, ip: string, reason?: string, noBaseFor?: string }} args
 *   `noBaseFor`: the environment, when the failover skipped its first base
 *   backup on the new timeline because the flip was not confirmed (the push
 *   would only stretch an outage); the message then names the command.
 * @returns {string}
 */
export function dnsDidNotMessage({ domain, ip, reason, noBaseFor }) {
  return (
    `FAILOVER COMPLETED, DNS DID NOT: point A records for ${domain} (apex and *.${domain}) at ${ip}` +
    (reason ? `. ${reason}` : '') +
    `. until they move, ${domain} is down: the old primary is fenced or gone, so nothing serves it` +
    '. the roles are saved; run vibecarbon deploy to point the records at the promoted node and rebuild the old primary' +
    (noBaseFor
      ? `. no base backup was pushed on the new timeline either: once DNS points at ${ip}, run vibecarbon backup ${noBaseFor}`
      : '')
  );
}

/**
 * Flip apex + wildcard to `ip`, then read both back through the provider's own
 * API. A provider that accepted the write but holds a different value (or a
 * flip that threw) is "not flipped": success is only ever what the read-back
 * confirms. Never throws.
 *
 * @param {object} args
 * @param {() => Promise<unknown>} args.update - writes the apex + wildcard records
 * @param {(name: string) => Promise<string[]>} args.read - every A record target at the name
 * @param {string} args.domain
 * @param {string} args.ip
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function flipAndVerifyDns({ update, read, domain, ip }) {
  try {
    await update();
  } catch (error) {
    return { ok: false, reason: `the DNS update failed: ${error.message}` };
  }
  for (const name of [domain, `*.${domain}`]) {
    let seen;
    try {
      seen = await read(name);
    } catch (error) {
      return { ok: false, reason: `could not read ${name} back: ${error.message}` };
    }
    // Exactly [ip]: a stale second A record would keep sending part of the
    // traffic to the retired node.
    if (!Array.isArray(seen) || seen.length !== 1 || seen[0] !== ip) {
      return {
        ok: false,
        reason: `${name} reads back as ${Array.isArray(seen) && seen.length > 0 ? seen.join(', ') : 'nothing'}, not only ${ip}`,
      };
    }
  }
  return { ok: true };
}
