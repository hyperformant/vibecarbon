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
 * @returns {string} the note body
 */
export function destroyPreviewBody({
  envConfig,
  projectName,
  envName,
  purgeBackups = false,
  s3SetupCompleted = false,
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

  // Plain destroy keeps the app bucket and its objects; -purge deletes it
  // once no other environment uses it.
  const storageScope = ', kept (deleted only with -purge when no other environment uses it)';
  const storageBlock = envConfig.s3?.bucket
    ? `${c.bold('S3 Storage:')}
    ${c.error('•')} Bucket: ${envConfig.s3.bucket}${storageScope}${mark(bucketsKnown)}
`
    : '';

  const backupBlock = envConfig.backupS3?.bucket
    ? `${c.bold('S3 Backups:')}
    ${
      purgeBackups
        ? `${c.error('•')} Bucket: ${envConfig.backupS3.bucket} (WILL BE DELETED, because you passed -purge)`
        : `${c.success('•')} Bucket: ${envConfig.backupS3.bucket} (PRESERVED for recovery)`
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
${storageBlock}${backupBlock}
${c.bold('GitHub:')}
    ${c.error('•')} Environment: ${envName}
${footer}
${c.danger('WARNING: All data on these servers will be permanently lost!')}
  `;
}
