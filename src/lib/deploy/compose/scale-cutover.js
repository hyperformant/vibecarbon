/**
 * The compose scale cutover (backup/restore integrity H6, B6, Decision 3).
 *
 * A compose scale replaces a server blue-green: it builds the new one, moves
 * the database onto it and destroys the old one. The database moves through
 * the backup bucket (a base pushed on the old server, restored by name on the
 * new one). Before this, the old server kept taking writes while that ran, so
 * every write between its base backup and the DNS flip was lost when the old
 * server was destroyed. Now the old primary is FENCED first:
 *
 *   1. its writers stop (the app and the primary-only add-ons, by container);
 *   2. its database goes read-only (fenceDatabaseWrites, the planned
 *      failover's fence);
 *   3. it switches to a new WAL file and waits until that file is archived,
 *      so every write before the fence is in the bucket.
 *
 * Only then is the final base pushed, and the new server restores that exact
 * base. The write pause runs from the fence until the DNS flip.
 *
 * The fence is recorded before it is applied (the durable write-fence marker,
 * write-fence.js), so a scale killed mid-cutover (SIGINT exits 130 with no
 * rollback) leaves a record `vibecarbon deploy` lifts. It is cleared when the
 * fence is lifted, and after the old server is destroyed.
 *
 * Any failure before the DNS flip rolls the old server back (C19): its
 * database is unfenced, its writers start again and its backup cron returns.
 * Its WALG_ROLE is demoted only after the flip (a demoted node drops every WAL
 * segment it completes, so a rollback after a demote could leave a gap), so
 * the rollback never has to re-arm it. After the flip there is no rollback.
 *
 * compose-ha: a replaced standby is never restored from the bucket (a restored
 * copy is an independent primary, silent split-brain). rejoinComposeStandby
 * reseeds it from the primary over the replication tunnel, with the same
 * staged reseed restore's compose-ha re-seed runs (configureStandbyReplication),
 * and proves it streaming before it records its system identifier.
 */

import * as p from '@clack/prompts';
import { loadProjectConfig, saveProjectConfig } from '../../config.js';
import { composeWriterServices } from '../../services/standby-policy.js';
import {
  markStandbyUnproven,
  readReplicaState,
  recordSystemIdentifier,
  swappedSinceLastDeploy,
} from '../failover-guard.js';
import {
  fenceDatabaseWrites,
  UNFENCE_SQL_HINT,
  unfenceDatabaseWrites,
  verifyStreaming,
} from '../replication.js';
import { exchangeAndBringUpTunnel, wgIpOf } from '../wireguard.js';
import { clearWriteFenceMarker, writeWriteFenceMarker } from '../write-fence.js';
import {
  buildReplicationOverlay,
  composePsqlRunner,
  configureStandbyReplication,
  ensurePrimaryReplicationAccess,
  openWireguardPortHetznerFirewall,
  openWireguardPortUfw,
  startOldPrimaryWriters,
  stopOldPrimaryWriters,
} from './ha.js';
import {
  composeHaStackOf,
  composeHaStandbyResyncHint,
  detectComposeHaRoleSwap,
} from './ha-role-swap.js';
import { setupComposeBackupCron, sshRunAsync } from './index.js';

/**
 * How long the fence waits for the switched WAL file to be archived. A fixed
 * deadline, not a retry: the archiver is already retrying on its own, and a
 * file it cannot push in two minutes is a broken archive, which the scale must
 * not cut over on.
 */
export const ARCHIVE_WAIT_DEADLINE_MS = 120_000;

/** Close the current WAL file and name it. */
export const SWITCH_WAL_SQL = 'SELECT pg_walfile_name(pg_switch_wal())';

/** The archiver's last pushed and last failed file, `last|failed`. */
export const ARCHIVER_STATE_SQL =
  "SELECT coalesce(last_archived_wal, '') || '|' || coalesce(last_failed_wal, '') FROM pg_stat_archiver";

const WAL_FILE_RE = /^[0-9A-F]{24}$/;

const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

/**
 * Has the archiver pushed `switchWal` (or a later file)? WAL file names sort
 * in write order (timeline, then log, then segment, all fixed-width hex). The
 * archiver pushes in order, so a later last-archived file covers this one. A
 * `.history` file names no segment and covers nothing; a `.backup` label
 * starts with its segment's name.
 *
 * @param {string} lastArchived pg_stat_archiver.last_archived_wal
 * @param {string} switchWal
 * @returns {boolean}
 */
export function walArchivedThrough(lastArchived, switchWal) {
  const segment = String(lastArchived ?? '')
    .slice(0, 24)
    .toUpperCase();
  return WAL_FILE_RE.test(segment) && segment >= switchWal;
}

/**
 * Fence writes on a compose primary before its database moves. The durable
 * marker (envConfig.ha.writeFence) is written first, before any writer stops.
 *
 * On any failure it rolls its own steps back (unfence, start the writers it
 * stopped, clear the marker once unfenced) and throws the cause plus how that
 * rollback went.
 *
 * @param {object} args
 * @param {string} args.environment
 * @param {string} args.ip the old primary (the marker matches it by IP only:
 *   the replacement keeps the servers[] name)
 * @param {string} args.sshKeyPath
 * @param {string} args.projectName
 * @param {string[]} args.services the enabled add-on names (enabledAddonNames)
 * @param {object} [args.deps] test seams
 * @returns {Promise<{ switchWal: string, stopped: string[], fencedAt: Date }>}
 *   stopped names the containers the stop took down, for the rollback
 */
export async function fenceComposePrimary({
  environment,
  ip,
  sshKeyPath,
  projectName,
  services,
  deps = {},
}) {
  const {
    writeMarker = writeWriteFenceMarker,
    stopWriters = stopOldPrimaryWriters,
    psql = composePsqlRunner,
    fence = (exec) => fenceDatabaseWrites({ exec }),
    now = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    pollMs = 2000,
    deadlineMs = ARCHIVE_WAIT_DEADLINE_MS,
  } = deps;
  const exec = psql(ip, sshKeyPath, `/opt/${projectName}`);
  const fencedAt = new Date(now());
  const writers = composeWriterServices(services ?? []);
  // Recorded BEFORE anything is stopped or fenced: a kill from here on leaves
  // the record deploy's stranded-fence lift acts on.
  writeMarker({ environment }, { ip, source: 'scale' });
  const stop = await stopWriters(ip, sshKeyPath, projectName, writers);
  const stopped = stop?.stopped ?? [];
  try {
    if (!stop?.ok) {
      throw new Error(
        `could not confirm ${writers.join(', ')} stopped on the old server` +
          (stop?.reached ? '' : ' (it did not answer)'),
      );
    }
    await fence(exec);
    // A session that may write: the fence makes every new one read-only.
    const switched = String((await exec(SWITCH_WAL_SQL, { readWrite: true })) ?? '').trim();
    if (!WAL_FILE_RE.test(switched)) {
      throw new Error(
        `pg_switch_wal named no WAL file (got: ${switched.slice(0, 60) || 'nothing'})`,
      );
    }
    const deadline = now() + deadlineMs;
    let state = '';
    for (;;) {
      state = String((await exec(ARCHIVER_STATE_SQL)) ?? '').trim();
      if (walArchivedThrough(state.split('|')[0], switched)) break;
      if (now() >= deadline) {
        const [last, failed] = state.split('|');
        throw new Error(
          `WAL file ${switched} was not archived within ${Math.round(deadlineMs / 1000)}s ` +
            `(last archived: ${last || 'none'}${failed ? `, last failed: ${failed}` : ''})`,
        );
      }
      await sleep(pollMs);
    }
    return { switchWal: switched, stopped, fencedAt };
  } catch (err) {
    const back = await unfenceComposePrimary({
      environment,
      ip,
      sshKeyPath,
      projectName,
      stopped,
      deps,
    });
    throw new Error(
      `write fence on ${ip}: ${firstLine(err)}; ` +
        (back.ok ? 'writes resumed there' : back.problems.join('; ')),
    );
  }
}

/**
 * Undo fenceComposePrimary: lift the database fence (and clear its marker once
 * it reads lifted), then start the writers the stop took down. Never throws;
 * each step that cannot be proven is a problem line with its manual fix. A
 * fence it cannot lift keeps its marker, so deploy lifts it.
 *
 * @returns {Promise<{ ok: boolean, problems: string[] }>}
 */
export async function unfenceComposePrimary({
  environment,
  ip,
  sshKeyPath,
  projectName,
  stopped,
  deps = {},
}) {
  const {
    psql = composePsqlRunner,
    unfence = (exec) => unfenceDatabaseWrites({ exec }),
    startWriters = startOldPrimaryWriters,
    clearMarker = clearWriteFenceMarker,
  } = deps;
  const problems = [];
  if (await unfence(psql(ip, sshKeyPath, `/opt/${projectName}`))) {
    clearMarker({ environment });
  } else {
    problems.push(
      `the database on ${ip} is still write-fenced (vibecarbon deploy lifts it); ` +
        `or run this in its db container: ${UNFENCE_SQL_HINT}`,
    );
  }
  const containers = stopped ?? [];
  let started = false;
  try {
    started = await startWriters(ip, sshKeyPath, containers);
  } catch {
    started = false;
  }
  if (!started) {
    problems.push(
      `${containers.join(', ')} did not start again on ${ip}; run docker start ${containers.join(' ')} there`,
    );
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Remove the compose backup cron line from a server, proven by a marker the
 * script prints last (sshRunScript answers false, it never throws).
 *
 * @param {string} ip
 * @param {string} sshKeyPath
 * @param {{ run?: typeof sshRunAsync }} [opts]
 */
export async function removeComposeBackupCron(ip, sshKeyPath, { run = sshRunAsync } = {}) {
  const out = await run(
    ip,
    sshKeyPath,
    'set -e; TMP_CRON=$(mktemp); crontab -l 2>/dev/null | grep -v \'compose-backup.sh\' > "$TMP_CRON" || true; ' +
      'crontab "$TMP_CRON"; rm -f "$TMP_CRON"; echo VC_CRON_REMOVED',
    { timeout: 30_000, retries: 1 },
  );
  if (!String(out === false ? '' : (out ?? '')).includes('VC_CRON_REMOVED')) {
    throw new Error(`could not remove the backup cron on ${ip}`);
  }
}

/**
 * Roll the old primary back after a cutover failed before the DNS flip (C19):
 * lift the database fence, start its writers and put its backup cron back.
 * Its WALG_ROLE was never demoted (that waits for the flip). Deleting the new
 * server is the caller's. Never throws.
 *
 * @param {object} args
 * @param {string} args.environment
 * @param {string} args.ip
 * @param {string} args.sshKeyPath
 * @param {string} args.projectName
 * @param {string[]} args.stopped the containers the fence stopped
 * @param {boolean} args.cronRemoved
 * @param {object} [args.backupConfig] envConfig.backup, to reinstall the cron
 * @param {object} [args.deps]
 * @returns {Promise<{ ok: boolean, problems: string[] }>}
 */
export async function rollbackComposeCutover({
  environment,
  ip,
  sshKeyPath,
  projectName,
  stopped,
  cronRemoved,
  backupConfig,
  deps = {},
}) {
  const { setupCron = setupComposeBackupCron } = deps;
  const problems = [];
  const back = await unfenceComposePrimary({
    environment,
    ip,
    sshKeyPath,
    projectName,
    stopped,
    deps,
  });
  problems.push(...back.problems);
  if (cronRemoved && backupConfig) {
    try {
      await setupCron(ip, sshKeyPath, projectName, backupConfig);
    } catch (err) {
      problems.push(
        `the backup cron on ${ip} is not back (${firstLine(err)}); run vibecarbon deploy to reinstall it`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Write the replication overlay on a compose-ha node before its stack comes
 * up, so its reconcile starts db with the 5433 publish and the repl-gateway
 * (reconcile.sh adds the overlay when the file is present). The node binds the
 * tunnel address of the stack it was born as (wgIpOf).
 *
 * @param {object} args
 * @param {string} args.ip
 * @param {string} args.sshKeyPath
 * @param {string} args.projectName
 * @param {'primary'|'standby'} args.stack
 * @param {{ run?: typeof sshRunAsync }} [args.deps]
 */
export async function writeComposeReplicationOverlay({
  ip,
  sshKeyPath,
  projectName,
  stack,
  deps = {},
}) {
  const { run = sshRunAsync } = deps;
  const overlay = buildReplicationOverlay(wgIpOf({ stackIdentity: stack }));
  await run(
    ip,
    sshKeyPath,
    `cat > /opt/${projectName}/docker-compose.replication.yml << 'REPL'\n${overlay}REPL`,
    { timeout: 10_000 },
  );
}

/**
 * Record a standby the scale proved streaming: its system identifier (the
 * failover replica proof) and the env's replication state, as a deploy that
 * verified streaming records them. An earlier unproven reseed in the same
 * scale (markStandbyUnproven) is then superseded.
 */
function recordProvenStandby(ctx, systemIdentifier) {
  recordSystemIdentifier(ctx, systemIdentifier);
  const config = loadProjectConfig();
  const envConfig = config?.environments?.[ctx.environment];
  if (!envConfig) return;
  envConfig.replication = 'streaming';
  envConfig.degraded = false;
  saveProjectConfig(config);
}

/**
 * Reseed a compose-ha standby from the primary after a scale moved either
 * node (Decision 3), and prove it streaming. Both nodes keep the tunnel
 * address of the stack they were born as (R11), so the tunnel is brought up
 * between the two current IPs by stack.
 *
 *   1. the WireGuard port, peer-scoped, on both hosts and both cloud firewalls;
 *   2. the tunnel (exchangeAndBringUpTunnel, idempotent);
 *   3. the primary side (repl-gateway, replicator role, slot, pg_hba);
 *   4. the staged reseed (configureStandbyReplication);
 *   5. the proof: the standby reads in recovery, streaming, with the
 *      primary's system identifier. Then it is recorded.
 *
 * Anything short of the proof marks the environment's replication degraded
 * (markStandbyUnproven) and warns with the deploy hint. It never throws: the
 * primary serves either way.
 *
 * A pair that has failed over at some point is never reseeded here (C2, as in
 * restore): its standby is rebuilt by role, which is the deploy's reconverge.
 *
 * @param {object} args
 * @param {string} args.environment
 * @param {string} args.projectName
 * @param {object} args.envConfig
 * @param {{ ip: string, entry: object }} args.primary
 * @param {{ ip: string, entry: object }} args.standby
 * @param {string} args.sshKeyPath
 * @param {object} [args.provider] the compute provider (cloud firewall rules)
 * @param {object} [args.deps]
 * @returns {Promise<'streaming'|'degraded'>}
 */
export async function rejoinComposeStandby({
  environment,
  projectName,
  envConfig,
  primary,
  standby,
  sshKeyPath,
  provider,
  deps = {},
}) {
  const {
    ufw = openWireguardPortUfw,
    cloudFirewall = openWireguardPortHetznerFirewall,
    tunnel = exchangeAndBringUpTunnel,
    primaryAccess = ensurePrimaryReplicationAccess,
    reseed = configureStandbyReplication,
    readState = (ip) =>
      readReplicaState({ exec: composePsqlRunner(ip, sshKeyPath, `/opt/${projectName}`) }),
    verify = verifyStreaming,
    record = recordProvenStandby,
    markUnproven = markStandbyUnproven,
    warn = (msg) => p.log.warn(msg),
  } = deps;
  const hint = composeHaStandbyResyncHint({ projectName, environment, envConfig });
  if (
    detectComposeHaRoleSwap({ projectName, environment, envConfig }) ||
    swappedSinceLastDeploy(envConfig)
  ) {
    markUnproven({ environment });
    warn(
      `Not reseeding the standby ${standby.ip} here: this pair has failed over at some point, ` +
        `so its standby is rebuilt by role. Replication is marked degraded. ${hint}`,
    );
    return 'degraded';
  }
  try {
    const primaryStack = composeHaStackOf(primary.entry, projectName, environment);
    const standbyStack = composeHaStackOf(standby.entry, projectName, environment);
    if (!primaryStack || !standbyStack || primaryStack === standbyStack) {
      throw new Error('could not tell which Pulumi stack each node was born as');
    }
    const byStack = { [primaryStack]: primary, [standbyStack]: standby };
    await Promise.all([
      ufw(primary.ip, standby.ip, sshKeyPath),
      ufw(standby.ip, primary.ip, sshKeyPath),
      cloudFirewall(`${projectName}-${environment}-${primaryStack}`, standby.ip, provider),
      cloudFirewall(`${projectName}-${environment}-${standbyStack}`, primary.ip, provider),
    ]);
    await tunnel({ primaryIp: byStack.primary.ip, standbyIp: byStack.standby.ip, sshKeyPath });
    await primaryAccess(primary.ip, sshKeyPath, projectName);
    await reseed(standby.ip, primary.ip, sshKeyPath, projectName, {
      primaryHost: wgIpOf({ stackIdentity: primaryStack }),
    });
    const primaryState = await readState(primary.ip);
    const sysid = primaryState?.inRecovery === false ? primaryState.systemIdentifier : null;
    if (!sysid) throw new Error(`the primary ${primary.ip} did not read back as a primary`);
    const proof = await verify({
      readState: async () => {
        const st = await readState(standby.ip);
        return st?.inRecovery === true && st.systemIdentifier === sysid
          ? (st.receiverStatus ?? '')
          : '';
      },
    });
    if (!proof.streaming) {
      throw new Error(`it is not streaming (last state: ${proof.lastState || 'none'})`);
    }
    record({ environment }, sysid);
    return 'streaming';
  } catch (err) {
    markUnproven({ environment });
    warn(
      `The standby ${standby.ip} could not be proven streaming from the primary ${primary.ip}: ` +
        `${firstLine(err)}. Replication is marked degraded. ${hint}`,
    );
    return 'degraded';
  }
}
