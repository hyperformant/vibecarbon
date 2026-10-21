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
import { loadProjectConfig, saveProjectConfig } from '../config.js';

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

/** True when a failover swapped the roles and no deploy has reconverged since. */
function swappedSinceLastDeploy(envConfig) {
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

  if (standbyState?.inRecovery == null) {
    refuse(
      `could not read the standby database's recovery state, so nothing proves it is a ` +
        `replica. check the standby db is up, or run ${deploy} to repair replication`,
    );
  }

  if (forceUnproven && planned) {
    refuse(
      `-force-unproven is for a dead primary only. the primary is answering, so this is a ` +
        `planned failover and the standby must prove it holds this database. drop the flag, ` +
        `or run ${deploy} to record the proof`,
    );
  }
  if (allowDegraded && !forceUnproven) {
    refuse(
      `-allow-degraded only applies together with -force-unproven. run ${deploy} to restore ` +
        `streaming instead`,
    );
  }

  if (swappedSinceLastDeploy(envConfig)) {
    refuse(
      `the last failover (${envConfig.lastFailover}) swapped the roles and no deploy has ` +
        `reconverged since, so the standby is the old primary and holds none of the new ` +
        `writes. run ${deploy} first, then fail over`,
    );
  }

  if (envConfig?.replication === 'degraded' && !(forceUnproven && allowDegraded)) {
    refuse(
      `replication is degraded (the last deploy did not prove the standby streaming), so ` +
        `the standby may be missing writes or hold no data at all. run ${deploy} to ` +
        `restore streaming, then fail over`,
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
        `for it, so promoting it could serve stale or empty data. run ${deploy} to reseed it`,
    );
  }

  // Past here only the identifier proof remains, which -force-unproven skips.
  // The standby is in recovery (a replica of something); that is all it proves.
  if (forceUnproven) return { mode: 'promote', unproven: true };

  const differentDatabase = (expectedId, source) =>
    refuse(
      `the standby holds a different database (system identifier ${live ?? 'unreadable'}, ` +
        `${source} ${expectedId}), so it was never seeded from this primary. run ${deploy} ` +
        `to reseed it`,
    );

  if (recorded) {
    if (live !== recorded) differentDatabase(recorded, 'recorded at its last seed:');
  } else {
    const primaryId = primaryState?.systemIdentifier ?? null;
    if (!planned || standbyState.receiverStatus !== 'streaming' || !primaryId) {
      refuse(
        `no seeded system identifier is recorded for ${environment}, so nothing proves the ` +
          `standby holds this database. run ${deploy} to record it`,
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
  const config = loadProjectConfig();
  const envConfig = config?.environments?.[ctx.environment];
  if (!envConfig) {
    throw new Error(`failover journal: environment ${ctx.environment} is not in .vibecarbon.json`);
  }
  const id = randomUUID();
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
  saveProjectConfig(config);
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
  const config = loadProjectConfig();
  const ha = config?.environments?.[ctx.environment]?.ha;
  if (!ha || !('failoverInFlight' in ha)) return;
  delete ha.failoverInFlight;
  saveProjectConfig(config);
}

/**
 * Record the system identifier of a freshly seeded or verified-streaming
 * standby, the value R1(b) compares against at failover time.
 *
 * @param {{ environment: string }} ctx
 * @param {string} systemIdentifier
 */
export function recordSystemIdentifier(ctx, systemIdentifier) {
  const config = loadProjectConfig();
  const envConfig = config?.environments?.[ctx.environment];
  if (!envConfig || !systemIdentifier) return;
  envConfig.ha = { ...(envConfig.ha ?? {}), systemIdentifier };
  saveProjectConfig(config);
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
  return (
    `promotion state unknown: old primary kept fenced; rerun vibecarbon failover ${envName} ` +
    `to finish`
  );
}
