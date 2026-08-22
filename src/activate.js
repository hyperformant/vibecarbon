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
} from './lib/licensing/index.js';

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string }} */
const ACTIVATE_SPEC = {
  name: 'activate',
  summary: 'Activate a Vibecarbon license key',
  positional: [
    {
      name: 'key',
      optional: true,
      description: 'License key (vc-...). Prompts if omitted.',
    },
  ],
  flags: [{ name: 'h', boolean: true, description: 'Show this help' }],
};

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string }} */
const DEACTIVATE_SPEC = {
  name: 'deactivate',
  summary: 'Deactivate the current Vibecarbon license',
  flags: [
    { name: 'h', boolean: true, description: 'Show this help' },
    { name: 'y', boolean: true, description: 'Skip confirmation prompt' },
  ],
};

/**
 * Activate a license key (Fullerene)
 * @param {string[]} args - CLI arguments (first positional arg is the key)
 */
export async function runActivate(args) {
  const { positional, handled } = parseFlagsOrExit(args, ACTIVATE_SPEC);
  if (handled) return;

  introCommand('activate');

  // Check if already activated
  const currentLicense = getLicense();
  if (currentLicense.active) {
    p.log.info(`You already have an active ${c.success(currentLicense.displayName)} license.`);
    p.log.info(`Customer ID: ${c.dim(currentLicense.customerId)}`);
    const proceed = await p.confirm({
      message: 'Replace with a new license key?',
      initialValue: false,
    });
    // The two answers genuinely differ here, unlike the other confirm sites.
    // An explicit "no" is the SUCCESS path: the operator has a working
    // license and chose to keep it, so the command's purpose is already
    // satisfied — exit 0 is correct. Ctrl-C/ESC is not an answer at all, and
    // must not be reported as "kept your license on purpose".
    if (p.isCancel(proceed)) {
      exitCancelled();
    }
    if (!proceed) {
      p.outro('Keeping current license.');
      return;
    }
  }

  // Get key from args or prompt
  let licenseKey = /** @type {string|undefined} */ (positional.key);

  if (!licenseKey) {
    const inputKey = await p.text({
      message: 'Enter your license key:',
      placeholder: 'vc-xxxxxxxx-signature...',
      validate: (value) => {
        if (!value) return 'License key is required';
        const trimmed = value.trim().toLowerCase();
        if (!trimmed.startsWith('vc-')) {
          return 'Invalid key format. Expected vc-...';
        }
        return undefined;
      },
    });

    if (p.isCancel(inputKey)) {
      exitCancelled();
    }

    licenseKey = inputKey;
  }

  const s = spinner();
  s.start('Validating license key...');

  const result = activateLicense(licenseKey);

  if (!result.success) {
    s.stop('License validation failed');
    p.log.error(c.error(`Error: ${result.error}`));
    p.log.info('');
    p.log.info(`${c.dim('Purchase a license at')} ${c.info('https://vibecarbon.com/#pricing')}`);
    process.exit(1);
  }

  s.stop('License activated!');

  p.log.success(`Welcome to ${c.success(result.tierName)}!`);

  p.note(
    `Tier: ${result.tierName}\nExpires: Never\nFeatures: ${result.features.join(', ')}`,
    'License Details',
  );

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

  const result = deactivateLicense();

  if (!result.success) {
    p.log.error(c.error(`Error: ${result.error}`));
    process.exit(1);
  }

  p.log.success(c.success(result.message));
  p.outro('You are now using the Graphite tier.');
}
