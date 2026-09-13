/**
 * Vibecarbon Activate / Deactivate Commands
 * Top-level commands for license management
 *
 * Usage:
 *   vibecarbon activate <key>      # Activate a license key
 *   vibecarbon activate            # Prompt for key interactively
 *   vibecarbon deactivate          # Remove the current license
 */

import * as p from '@clack/prompts';
import { exitCancelled, exitDeclined } from './lib/cli/exit-guard.js';
import { introCommand } from './lib/cli/intro.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { spinner } from './lib/cli/progress.js';
import { c } from './lib/colors.js';
import {
  activateLicense,
  deactivateLicense,
  getLicense,
  hasStoredLicense,
  listStoredLicenses,
} from './lib/licensing/index.js';
import { refreshLicense } from './lib/licensing/refresh.js';
import { getReleaseDate } from './lib/licensing/release-date.js';
import { getTier } from './lib/licensing/tiers.js';
import { manifestExists } from './lib/project.js';
import { VERSION } from './lib/version.js';

/** refreshLicense()'s failure reasons, worded for an operator reading them
 *  directly (never an em dash — see the marketing-copy rule). */
const REFRESH_FAILURE_MESSAGES = {
  'no-key': 'No project license key is stored here. Run vibecarbon activate <key> first.',
  'not-renewed': 'This project subscription has not been renewed yet.',
  'not-found': 'vibecarbon.com does not recognize the stored license key.',
  invalid: 'vibecarbon.com returned a key that could not be verified.',
  offline: 'Could not reach vibecarbon.com. Check your connection and try again.',
};

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string }} */
const ACTIVATE_SPEC = {
  name: 'activate',
  summary: 'Activate a Vibecarbon license key',
  positional: [
    {
      name: 'key',
      optional: true,
      description: 'License key (vc-... or vc2-...). Prompts if omitted.',
    },
  ],
  flags: [
    { name: 'h', boolean: true, description: 'Show this help' },
    {
      name: 'refresh',
      boolean: true,
      description: 'Refresh the stored project key from vibecarbon.com',
    },
  ],
};

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string }} */
const DEACTIVATE_SPEC = {
  name: 'deactivate',
  summary: 'Deactivate the current Vibecarbon license',
  flags: [
    { name: 'h', boolean: true, description: 'Show this help' },
    { name: 'y', boolean: true, description: 'Skip confirmation prompt' },
    {
      name: 'all',
      boolean: true,
      description: 'Remove both the project and legacy license files',
    },
  ],
};

/**
 * `vibecarbon activate -refresh`: ask vibecarbon.com for the current key
 * covering this project's stored v2 license (see refreshLicense), and print
 * the old/new paid-through dates or the reason it could not refresh.
 * Requires a Vibecarbon project with a project-slot key already stored;
 * either miss prints a clear message and exits 1.
 */
async function runActivateRefresh() {
  if (!manifestExists()) {
    p.log.error(c.error('Run vibecarbon activate -refresh inside a Vibecarbon project.'));
    process.exit(1);
  }

  const projectEntry = listStoredLicenses().find((entry) => entry.slot === 'project' && entry.key);
  if (!projectEntry) {
    p.log.error(c.error(REFRESH_FAILURE_MESSAGES['no-key']));
    process.exit(1);
  }

  const oldPaidThrough = getLicense().paidThrough ?? projectEntry.paidThrough ?? 'unknown';

  const s = spinner();
  s.start('Checking vibecarbon.com for a renewed key');
  const result = await refreshLicense();

  if (!result.ok) {
    s.stop('Could not refresh the license key', 1);
    p.log.error(
      c.error(REFRESH_FAILURE_MESSAGES[result.reason] ?? 'Could not refresh the license key.'),
    );
    process.exit(1);
  }

  s.stop('License key refreshed!');
  p.log.success(`Paid through: ${oldPaidThrough} to ${result.paidThrough}`);
  p.outro('You can now deploy, backup, scale, and operate your production stack.');
}

/**
 * Activate a license key (Fullerene)
 * @param {string[]} args - CLI arguments (first positional arg is the key)
 */
export async function runActivate(args) {
  const { values, positional, handled } = parseFlagsOrExit(args, ACTIVATE_SPEC);
  if (handled) return;

  introCommand('activate');

  if (values.refresh) {
    await runActivateRefresh();
    return;
  }

  // Get key from args or prompt. Needed up front now: which slot a key
  // targets (legacy vs project) decides whether "already active" even
  // applies, so that check happens below, once the key is in hand.
  let licenseKey = /** @type {string|undefined} */ (positional.key);

  if (!licenseKey) {
    const inputKey = await p.text({
      message: 'Enter your license key:',
      placeholder: 'vc-... or vc2-...',
      validate: (value) => {
        if (!value) return 'License key is required';
        const trimmed = value.trim().toLowerCase();
        if (!/^vc2?-/.test(trimmed)) {
          return 'Invalid key format. Expected vc-... or vc2-...';
        }
        return undefined;
      },
    });

    if (p.isCancel(inputKey)) {
      exitCancelled();
    }

    licenseKey = inputKey;
  }

  // A cheap prefix read, not a validation: activateLicense() below is the
  // single source of truth for whether the key is actually good. This only
  // decides which stored slot (legacy or project) the "already active"
  // check below should look at.
  const trimmedKey = (licenseKey || '').trim().toLowerCase();
  const enteredFormat = trimmedKey.startsWith('vc2-')
    ? 'v2'
    : trimmedKey.startsWith('vc-')
      ? 'v1'
      : null;

  const stored = listStoredLicenses();
  const legacyEntry = stored.find((entry) => entry.slot === 'legacy' && entry.valid);
  const projectEntry = stored.find((entry) => entry.slot === 'project' && entry.valid);

  // A v2 key activated while only the (global, lifetime) legacy key is on
  // file is not a conflict: the legacy key keeps covering every project
  // exactly as before, and this key gets stored alongside it for this
  // project. No "Replace?" prompt needed.
  if (enteredFormat === 'v2' && legacyEntry && !projectEntry) {
    p.log.info(
      'Your lifetime license already covers every project. This key will also be stored for this project.',
    );
  }

  // "Replace?" only makes sense when the SAME slot the new key targets is
  // already occupied: a legacy key over a legacy key, or a project key over
  // a project key for this same project.
  const existingEntry =
    enteredFormat === 'v1' ? legacyEntry : enteredFormat === 'v2' ? projectEntry : null;

  if (existingEntry) {
    const tierDef = getTier(existingEntry.tier);
    const displayName = tierDef ? tierDef.displayName : existingEntry.tier;
    const subject =
      enteredFormat === 'v2' ? `${displayName} license for this project` : `${displayName} license`;
    p.log.info(`You already have an active ${c.success(subject)}.`);
    p.log.info(`Customer ID: ${c.dim(existingEntry.customerId)}`);
    const proceed = await p.confirm({
      message: 'Replace with a new license key?',
      initialValue: false,
    });
    // The two answers genuinely differ here, unlike the other confirm sites.
    // An explicit "no" is the SUCCESS path: the operator has a working
    // license and chose to keep it, so the command's purpose is already
    // satisfied, so exit 0 is correct. Ctrl-C/ESC is not an answer at all,
    // and must not be reported as "kept your license on purpose".
    if (p.isCancel(proceed)) {
      exitCancelled();
    }
    if (!proceed) {
      p.outro('Keeping current license.');
      return;
    }
  }

  const s = spinner();
  s.start('Validating license key...');

  const result = activateLicense(licenseKey);

  if (!result.success) {
    s.stop('License validation failed');
    p.log.error(c.error(`Error: ${result.error}`));
    p.log.info('');
    p.log.info(`${c.dim('Subscribe at')} ${c.info('https://vibecarbon.com/pricing')}`);
    process.exit(1);
  }

  s.stop('License activated!');

  p.log.success(`Welcome to ${c.success(result.tierName)}!`);

  const detailLines = [`Tier: ${result.tierName}`];
  if (result.format === 'v2') {
    detailLines.push(`Project: ${result.projectId}`);
    detailLines.push(`Paid through: ${result.paidThrough}`);
  } else {
    detailLines.push('Expires: Never');
  }

  const releaseDate = getReleaseDate();
  detailLines.push(`This CLI: v${VERSION} (released ${releaseDate})`);

  if (result.format === 'v2' && result.paidThrough && releaseDate > result.paidThrough) {
    detailLines.push(
      'This key does not cover this CLI release. Renew, or run the CLI version you paid for.',
    );
  }

  detailLines.push(`Features: ${result.features.join(', ')}`);

  p.note(detailLines.join('\n'), 'License Details');

  p.outro('You can now deploy, backup, scale, and operate your production stack.');
}

/**
 * Deactivate the current license
 * @param {string[]} args - CLI arguments
 */
export async function runDeactivate(args) {
  const { values, handled } = parseFlagsOrExit(args, DEACTIVATE_SPEC);
  if (handled) return;

  introCommand('deactivate');

  // Presence, not validity: an unverifiable or corrupt file must still be
  // removable — see hasStoredLicense() in src/lib/licensing/index.js.
  if (!hasStoredLicense()) {
    p.log.info('No license is currently activated.');
    p.outro('');
    return;
  }

  const license = getLicense();
  const yes = !!values.y;

  if (!yes) {
    const subject = license.active ? `your ${license.displayName} license` : 'the stored license';
    const confirm = await p.confirm({
      message: `Deactivate ${subject}? You will revert to the Graphite tier.`,
    });

    // Ctrl-C/ESC and an explicit "no" are different answers: one is an
    // interrupt, the other a considered refusal. Both stop the run.
    if (p.isCancel(confirm)) {
      exitCancelled();
    }
    if (!confirm) {
      exitDeclined();
    }
  }

  const result = deactivateLicense({ all: !!values.all });

  if (!result.success) {
    p.log.error(c.error(`Error: ${result.error}`));
    process.exit(1);
  }

  // Default (non -all) removes only the project file, and a legacy key may
  // still be sitting in the other slot — re-read rather than assume
  // Graphite, or a Fullerene holder gets told they just lost their tier.
  const remaining = getLicense();
  const tierName = remaining.active ? remaining.name : 'Graphite';
  p.log.success(c.success(`License deactivated. Using ${tierName} tier.`));
  p.outro(`You are now using the ${tierName} tier.`);
}
