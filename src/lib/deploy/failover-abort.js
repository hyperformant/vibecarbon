/**
 * `vibecarbon failover <env> -abort`: call off a failover whose journal is set
 * (HA-correctness final review C1).
 *
 * The journal (`ha.failoverInFlight`) makes deploy, restore and scale refuse,
 * and a rerun of `vibecarbon failover` resumes from it. That rerun refuses too
 * when the standby can no longer be proven (unreadable, out of recovery under
 * another identity, degraded), and the old primary stays fenced while it
 * waits. Without a way out the site stays down until someone hand-edits
 * .vibecarbon.json. `-abort` is that way out, and it keeps the OLD primary:
 *
 *   1. fence the standby: stop its database and PROVE it down, so nothing can
 *      promote it or serve from it next to the old primary. Not proven, nothing
 *      else is touched and the abort refuses;
 *   2. stop the standby's writers and set its WALG_ROLE=standby (best effort:
 *      its database is already down);
 *   3. point DNS back at the old primary when the provider is managed;
 *   4. lift the old primary's database write fence, give it back its wal-g
 *      write-guard and ACME issuer, name it in the backup-prefix fence (a
 *      failover may have named the standby there), and start its writers;
 *   5. clear the journal (and the write-fence marker, when the lift is
 *      proven), drop the recorded system identifier and mark replication
 *      degraded, so the next `vibecarbon deploy` reseeds the standby.
 *
 * The tier backends (compose-ha in compose/ha.js, k8s-ha in failover.js) do the
 * I/O; this module owns the order, the refusal and the single save.
 */

import { updateProjectConfig } from '../config.js';
import { backupFenceRecord, backupFenceWarning } from './backup-fence.js';
import { FailoverRefusedError } from './failover-guard.js';

/**
 * @typedef {object} AbortBackend
 * @property {{ primary: string, standby: string }} ips
 * @property {() => Promise<{ ok: boolean, reason?: string }>} stopStandbyDb
 *   stop the standby's database and prove it is not running
 * @property {() => Promise<boolean>} disarmStandby
 *   stop its writers and set WALG_ROLE=standby; best effort
 * @property {(() => Promise<{ ok: boolean, reason?: string }>)|null} repointDns
 *   managed DNS: point the A records back at the old primary; null for manual
 * @property {() => Promise<boolean>} primaryReachable
 * @property {() => Promise<boolean>} unfencePrimary - proven lift of the db write fence
 * @property {() => Promise<boolean>} armPrimary - WALG_ROLE=primary and the ACME issuer
 * @property {() => Promise<boolean>} startPrimaryWriters
 * @property {() => Promise<{ ok: boolean, reason?: string }>} writeBackupFence
 *   name the old primary in the backup-prefix fence (backup-fence.js): a
 *   failover may have named the standby there already
 * @property {string} unfenceHint - the manual lift, for a warning
 * @property {string} stopDbHint - the manual standby stop, for the refusal
 */

/**
 * Persist an abort: one save. The write-fence marker stays when the lift was
 * not proven, so the next deploy or failover that reaches the primary lifts it.
 *
 * @param {{ environment: string }} ctx
 * @param {{ fenceLifted: boolean, backupFence?: object|null }} opts - backupFence:
 *   the backup-prefix fence write's record (backup-fence.js), when one was tried
 */
export function recordFailoverAbort(ctx, { fenceLifted, backupFence = null }) {
  updateProjectConfig((config) => {
    const envConfig = config.environments?.[ctx.environment];
    if (!envConfig) {
      throw new Error(`failover abort: environment ${ctx.environment} is not in .vibecarbon.json`);
    }
    const ha = { ...(envConfig.ha ?? {}) };
    delete ha.failoverInFlight;
    // The standby's data is unknown now (it may have promoted): nothing proves
    // it holds this database until a deploy reseeds it.
    delete ha.systemIdentifier;
    if (fenceLifted) delete ha.writeFence;
    if (backupFence) ha.backupFence = backupFence;
    envConfig.ha = ha;
    envConfig.replication = 'degraded';
    envConfig.degraded = true;
  });
}

/**
 * Run the abort through a tier backend. Throws FailoverRefusedError, with
 * nothing changed, when no journal is set or the standby's database cannot be
 * proven down. Every later step is best effort and warns with its manual fix:
 * the journal is cleared either way, since the standby can no longer promote.
 *
 * @param {object} args
 * @param {string} args.environment
 * @param {object} args.envConfig - the persisted env config
 * @param {AbortBackend} args.backend
 * @param {(line: string) => void} args.log
 * @param {(line: string) => void} args.warn
 * @param {(ctx: object, opts: object) => void} [args.record] - test seam
 * @returns {Promise<{ fenceLifted: boolean, warnings: string[] }>}
 */
export async function abortFailover({
  environment,
  envConfig,
  backend,
  log,
  warn,
  record = recordFailoverAbort,
}) {
  if (!envConfig?.ha?.failoverInFlight) {
    throw new FailoverRefusedError(
      `Abort refused: no failover is in flight for ${environment} (no journal is set), so ` +
        `there is nothing to call off. vibecarbon status ${environment} shows the roles`,
    );
  }
  const { primary, standby } = backend.ips;
  const warnings = [];
  const note = (line) => {
    warnings.push(line);
    warn(line);
  };

  // 1. The one step that must hold: a standby that might still promote must be
  // down before the old primary takes writes again.
  const stopped = await backend.stopStandbyDb();
  if (!stopped.ok) {
    throw new FailoverRefusedError(
      `Abort refused: could not prove the standby's database (${standby}) stopped` +
        `${stopped.reason ? ` (${stopped.reason})` : ''}, so it could still promote and serve ` +
        `next to the old primary. stop it yourself (${backend.stopDbHint}) or power the server ` +
        `off, then rerun vibecarbon failover ${environment} -abort`,
    );
  }
  log(`stopped the standby's database (${standby}): it cannot promote or serve`);

  // 2. Belt and braces on the standby: a reboot must not bring it back archiving.
  if (!(await backend.disarmStandby())) {
    note(
      `could not stop the standby's writers or set its WALG_ROLE=standby (${standby}); its ` +
        'database is down, and vibecarbon deploy rebuilds it as the standby',
    );
  }

  // 3. A failover that got as far as its DNS flip left the records on the standby.
  if (backend.repointDns) {
    const dns = await backend.repointDns();
    if (dns.ok) log(`DNS points at the old primary ${primary} again`);
    else
      note(
        `could not point DNS back at the old primary ${primary} (${dns.reason}); set the A ` +
          `records (apex and wildcard) to ${primary} yourself`,
      );
  }

  // 4. The old primary serves again.
  let fenceLifted = false;
  let fenceRecord = null;
  if (await backend.primaryReachable()) {
    fenceLifted = await backend.unfencePrimary();
    if (!fenceLifted) {
      note(
        `could not lift the database write fence on the old primary (${primary}); run this in ` +
          `its db container: ${backend.unfenceHint}`,
      );
    }
    if (!(await backend.armPrimary())) {
      note(
        `could not confirm the old primary's backups and ACME issuer re-armed (${primary}); ` +
          `vibecarbon deploy ${environment} re-renders both`,
      );
    }
    const fence = await backend.writeBackupFence();
    if (!fence.ok) note(backupFenceWarning(primary, fence.reason));
    fenceRecord = backupFenceRecord(fence);
    if (!(await backend.startPrimaryWriters())) {
      note(
        `could not start the old primary's app tier (${primary}); vibecarbon deploy ` +
          `${environment} brings it up`,
      );
    }
  } else {
    note(
      `the old primary ${primary} does not answer, so its write fence stays recorded and the ` +
        `backup-prefix fence may still name the standby; the next vibecarbon deploy ` +
        `${environment} that reaches it lifts the one and rewrites the other`,
    );
  }

  record({ environment }, { fenceLifted, backupFence: fenceRecord });
  log(
    `failover called off: ${primary} stays the primary. replication is marked degraded; run ` +
      `vibecarbon deploy ${environment} to reseed the standby ${standby} from it`,
  );
  return { fenceLifted, warnings };
}
