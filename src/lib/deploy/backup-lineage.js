/**
 * The database lineage a deploy leaves on record (B8).
 *
 * Each database archives under its own folder of the environment's backup
 * prefix, named by its system identifier (carbon/volumes/db/walg-env.sh). A
 * destroyed and redeployed environment is a new database, so its archive is
 * a new folder beside the old one, and nothing on the server remembers the
 * old one. `.vibecarbon.json` does: after every successful deploy the
 * orchestrator reads the role primary's system identifier and records it as
 * `backup.lineage`; a changed one moves the old value to
 * `backup.priorLineages` (recordBackupLineage). The `backup` block survives a
 * destroy (env-identity.js), so a redeploy still knows it.
 *
 * A deploy that leaves a new lineage beside older ones that hold base
 * backups names the restore of each (Decision 2: never a refusal, the deploy
 * is fine; the operator decides whether the old data matters).
 */

import { recordBackupLineage } from '../walg/restore-base.js';
import { LINEAGE_RE } from '../walg/restore-layout.js';

/** The database's system identifier, the name of its archive folder. */
export const SYSTEM_IDENTIFIER_SQL = 'SELECT system_identifier FROM pg_control_system()';

/**
 * @param {unknown} out psql -tA output
 * @returns {string|null}
 */
export function parseSystemIdentifier(out) {
  const row = String(out ?? '')
    .trim()
    .split('\n')
    .pop()
    ?.trim();
  return row && LINEAGE_RE.test(row) ? row : null;
}

/**
 * Read the deployed database's lineage and return the `backup` record to save.
 * Throws when the system identifier cannot be read: the deploy must not
 * finish with a lineage on record that may not be its own.
 *
 * @param {object} args
 * @param {string} args.environment
 * @param {{ lineage?: string, priorLineages?: string[] } | undefined} args.backup  the record before this deploy
 * @param {(sql: string) => Promise<string>} args.exec  psql on the role primary
 * @param {string} args.where  the primary, for the error
 * @param {(() => Promise<Array<{ lineage: string, newestFinish: Date|null }>>) | null} [args.listLineages]
 *   the lineages under the env's prefix, or null when the bucket cannot be read from here
 * @param {{ info: (m: string) => void, warn: (m: string) => void }} args.log
 * @returns {Promise<{ lineage: string, priorLineages?: string[] }>}
 */
export async function recordDeployedLineage({
  environment,
  backup,
  exec,
  where,
  listLineages = null,
  log,
}) {
  let sysid = null;
  let cause = 'no system identifier in the reply';
  try {
    sysid = parseSystemIdentifier(await exec(SYSTEM_IDENTIFIER_SQL));
  } catch (err) {
    cause = String(err?.message ?? err).split('\n')[0];
  }
  if (!sysid) {
    throw new Error(
      `could not read the database system identifier on ${where} (${cause}), so this deploy ` +
        'cannot record which backup lineage is its own. Rerun vibecarbon deploy',
    );
  }
  const record = recordBackupLineage(backup, sysid);
  if (backup?.lineage === sysid || !listLineages) return record;
  let others = [];
  try {
    others = (await listLineages()).filter((l) => l.lineage !== sysid && l.newestFinish);
  } catch (err) {
    log.warn(
      `could not list the earlier backup lineages of ${environment} ` +
        `(${String(err?.message ?? err).split('\n')[0]}); vibecarbon restore ${environment} -l shows them`,
    );
    return record;
  }
  if (others.length > 0) {
    log.info(
      [
        `${environment} runs a new database (backup lineage ${sysid}). The backups of an earlier one are still in the bucket. To restore one:`,
        ...others.map((l) => `  vibecarbon restore ${environment} -lineage ${l.lineage}`),
      ].join('\n'),
    );
  }
  return record;
}
