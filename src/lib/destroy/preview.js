/**
 * The "This will permanently delete:" preview `vibecarbon destroy` shows
 * before it asks for confirmation.
 *
 * It is built from local evidence only, and says how good that evidence is.
 * A deploy saves its env entry (bucket names, deploy mode) BEFORE it creates
 * anything, deliberately: if it dies halfway, destroy still knows what may
 * have been left behind. So a recorded name is not proof the resource exists.
 * excitingai (2026-10-16) failed at its first S3 call and the old preview
 * still promised to delete an SSH key and a storage bucket that were never
 * created.
 *
 * Why labels and not a live probe: the preview runs before any credential is
 * resolved (the API token and S3 keys are asked for after the confirmation),
 * so probing would mean prompting for keys just to draw a list, and adding
 * network calls in front of a yes/no question. The teardown already probes
 * every resource and reports "not found" for the ones that are gone, so the
 * preview only has to be honest about which items are confirmed by a finished
 * deploy step and which are just recorded.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { c } from '../colors.js';
import { DNS_PROVIDERS, hasAutomatedDns } from '../dns-provider.js';

const MAY_NOT_EXIST = 'recorded in .vibecarbon.json, may not exist';

/**
 * Did the deploy's S3 step finish for this environment? Read from the
 * deploy-state file the orchestrator's StateTracker writes. Any read problem
 * means "not known to have finished".
 * @param {string} cwd
 * @param {string} envName
 * @returns {boolean}
 */
export function readS3SetupCompleted(cwd, envName) {
  const file = join(cwd, '.vibecarbon', `deploy-state-${envName}.json`);
  if (!existsSync(file)) return false;
  try {
    const state = JSON.parse(readFileSync(file, 'utf-8'));
    return state?.steps?.['s3-setup']?.status === 'completed';
  } catch {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {object} opts.envConfig
 * @param {string} opts.projectName
 * @param {string} opts.envName
 * @param {boolean} [opts.purgeBackups]
 * @param {boolean} [opts.s3SetupCompleted]  From readS3SetupCompleted.
 * @param {boolean} [opts.appBucketOwned]  The app bucket is this env's own
 *   (destroyPreviewBucketFacts); a legacy shared bucket is never deleted.
 * @param {boolean} [opts.backupBucketHeld]  Another environment still keeps
 *   backups in the bucket, so -purge removes only this env's folder.
 * @returns {string} the note body
 */
export function destroyPreviewBody({
  envConfig,
  projectName,
  envName,
  purgeBackups = false,
  s3SetupCompleted = false,
  appBucketOwned = true,
  backupBucketHeld = false,
}) {
  const finished = envConfig.status === 'deployed';
  const servers = envConfig.servers ?? [];
  // The SSH key is created before any server, so a recorded server proves it.
  const sshKeyKnown = finished || servers.length > 0;
  const bucketsKnown = finished || s3SetupCompleted;
  const caveat = (known) => (known ? '' : ` ${c.dim(`(${MAY_NOT_EXIST})`)}`);
  let anyCaveat = false;
  const mark = (known) => {
    if (!known) anyCaveat = true;
    return caveat(known);
  };

  const serverList =
    servers.map((s) => `    ${c.error('•')} ${s.name} (${s.ip})`).join('\n') || '    None';
  const firewallList =
    servers.map((s) => `    ${c.error('•')} ${s.name}-fw`).join('\n') || '    None';

  // SSH-key line: every tier's real key name starts with this
  // `${projectName}-${envName}` slug (the suffix is tier-dependent: `-key`,
  // `-ha-key`, `-${location}-key`).
  const sshKeyLine = `    ${c.error('•')} ${projectName}-${envName}${mark(sshKeyKnown)}`;

  const dnsBlock = hasAutomatedDns(envConfig.dns?.provider)
    ? `${c.bold(`${DNS_PROVIDERS[envConfig.dns.provider].name} Resources:`)}
    ${c.error('•')} DNS records: ${envConfig.domain} (apex + wildcard)
    ${DNS_PROVIDERS[envConfig.dns.provider].healthChecks ? `${c.error('•')} Health checks` : ''}
`
    : '';

  // The env's own app bucket: plain destroy keeps it and its uploads (with
  // the env's backups), -purge deletes it. A pinned bucket or a legacy
  // per-project bucket may serve other environments, so destroy never
  // deletes either (deleteAppBucketEffect).
  const storageLine = envConfig.s3?.bucketPin
    ? `${c.success('•')} Bucket: ${envConfig.s3.bucket} (kept: pinned, delete manually)`
    : !appBucketOwned
      ? `${c.success('•')} Bucket: ${envConfig.s3?.bucket} (kept: legacy shared bucket, delete manually)`
      : purgeBackups
        ? `${c.error('•')} Bucket: ${envConfig.s3?.bucket} (WILL BE DELETED, because you passed -purge)`
        : `${c.success('•')} Bucket: ${envConfig.s3?.bucket} (kept; deleted with -purge)`;
  const storageBlock = envConfig.s3?.bucket
    ? `${c.bold('S3 Storage:')}
    ${storageLine}${mark(bucketsKnown)}
`
    : '';

  // The env's own app storage key (security plan R9): every destroy revokes
  // a minted one; a pasted Hetzner key can only be deleted in the console.
  const appKey = envConfig.s3?.appKey;
  const appKeyBlock = appKey?.id
    ? `${c.bold('Storage Key:')}
    ${
      appKey.scoping === 'mint'
        ? `${c.error('•')} App storage key ${appKey.id} (WILL BE REVOKED)`
        : `${c.error('•')} App storage key ${appKey.id} (pasted: stays denied in the bucket fences; delete it in the console, then forget it)`
    }
`
    : '';

  // The backup bucket is per project: -purge deletes this env's folder, and
  // the bucket only with the last environment that keeps backups in it
  // (handleBackupBucket).
  const backupBlock = envConfig.backupS3?.bucket
    ? `${c.bold('S3 Backups:')}
    ${
      !purgeBackups
        ? `${c.success('•')} Bucket: ${envConfig.backupS3.bucket} (PRESERVED for recovery)`
        : backupBucketHeld
          ? `${c.error('•')} Bucket: ${envConfig.backupS3.bucket} (backups/${projectName}/${envName}/ WILL BE DELETED, because you passed -purge; the bucket stays for the other environments)`
          : `${c.error('•')} Bucket: ${envConfig.backupS3.bucket} (WILL BE DELETED, because you passed -purge)`
    }${mark(bucketsKnown)}
`
    : '';

  const footer = anyCaveat
    ? `\n${c.dim('Items marked "may not exist" are names the last deploy recorded before it stopped. Destroy checks each one and skips what is already gone.')}\n`
    : '';

  return `
${c.danger('This will permanently delete:')}

${c.bold('Servers:')}
${serverList}

${c.bold('Firewalls:')}
${firewallList}

${c.bold('SSH Keys:')}
${sshKeyLine}

${dnsBlock}
${storageBlock}${appKeyBlock}${backupBlock}
${c.bold('GitHub:')}
    ${c.error('•')} Environment: ${envName}
${footer}
${c.danger('WARNING: All data on these servers will be permanently lost!')}
  `;
}
