/**
 * What a restore leaves on the server while it runs, and the proof that ends
 * it. Shared by `vibecarbon restore` and, later, `deploy -restore` (k3s.js),
 * which must not import a command module.
 *
 * Two markers, on purpose:
 *
 * - The k8s marker KEYS on Secret vibecarbon-infra-secrets
 *   (RESTORE_MARKER_KEYS). The db pod's walg-restore init container restores
 *   when RESTORE_BACKUP is set, fetching exactly that backup and applying
 *   RESTORE_RECOVERY_CONF. RESTORE_TARGET stays for the seed-standby init,
 *   which skips its seed while a restore runs. All three are set and cleared
 *   together, by one patch.
 *
 * - The in-progress FILE inside PGDATA (RESTORE_LAYOUT.inProgress), on both
 *   tiers. A restore fetches into a staging dir on the same volume and only
 *   then moves the live cluster aside and the staged one in; the file is there
 *   for exactly that swap. A boot that finds it with no restore running stops
 *   with "restore interrupted; rerun vibecarbon restore" (compose:
 *   carbon/volumes/db/db-guard.sh, k8s: the walg-restore init).
 *
 * The staging dir and the previous cluster live INSIDE PGDATA: both tiers
 * mount the volume at PGDATA, and a mount point cannot be renamed. The
 * previous cluster stays until the restored database has promoted and proved
 * writable; only then does the CLI remove it.
 */
import * as p from '@clack/prompts';
import { assertRolePrimaryWritable } from '../deploy/write-fence.js';
import { sshKubectl } from '../ssh.js';
import { RESTORE_MARKER_KEYS, restoreMarkerStringData } from './restore-layout.js';

// The key list and its stringData live in restore-layout.js (no imports), so
// k3s.js's buildInfraSecretData shares them without this module's graph.
export { RESTORE_MARKER_KEYS, restoreMarkerStringData };

async function patchMarker(ip, sshKeyPath, stringData) {
  await sshKubectl(ip, sshKeyPath, [
    'patch',
    'secret',
    'vibecarbon-infra-secrets',
    '-n',
    'vibecarbon',
    '--type=merge',
    '-p',
    JSON.stringify({ stringData }),
  ]);
}

/**
 * Set the k8s restore marker: the db pod's next boot restores `backup`.
 *
 * @param {{ ip: string, sshKeyPath: string, backup: string, target: string, recoveryConf: string }} args
 */
export async function setRestoreMarker({ ip, sshKeyPath, backup, target, recoveryConf }) {
  await patchMarker(ip, sshKeyPath, restoreMarkerStringData({ backup, target, recoveryConf }));
}

/** Clear every marker key. Only once the restored database is proven. */
export async function clearRestoreMarker({ ip, sshKeyPath }) {
  await patchMarker(ip, sshKeyPath, restoreMarkerStringData(null));
}

/**
 * A restored database must take writes (final review M4). The recovery config
 * strips default_transaction_read_only from the fetched cluster, so a base
 * taken under a stranded write fence comes back writable; this is the proof.
 * Same check and lift as the deploy's (write-fence.js): fenced is lifted with
 * a warning, a lift that fails throws with the manual fix, an unreadable
 * setting warns.
 *
 * @param {{ environment: string, envConfig: object, exec: (sql: string, o?: object) => Promise<string> }} args
 */
export async function assertRestoredPrimaryWritable({ environment, envConfig, exec }) {
  const state = await assertRolePrimaryWritable({
    environment,
    envConfig,
    exec,
    warn: (line) => p.log.warn(`restored database: ${line}`),
  });
  if (state === 'unknown') {
    p.log.warn(
      "could not read the restored database's write-fence setting; vibecarbon status shows it " +
        'once the database answers',
    );
  }
}
