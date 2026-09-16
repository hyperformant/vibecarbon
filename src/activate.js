/**
 * Vibecarbon Activate / Deactivate Commands
 *
 *   vibecarbon activate [key]          Bind a key to this project (online)
 *   vibecarbon deactivate [key] [-rm]  Ask for a release link by email; -rm
 *                                      removes only the local file
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
  hasStoredLicense,
  removeLicenseFile,
} from './lib/licensing/index.js';
import { VERSION } from './lib/version.js';

const LICENSE_URL = 'https://vibecarbon.com/license';
const PRICING_URL = 'https://vibecarbon.com/pricing';

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string }} */
const ACTIVATE_SPEC = {
  name: 'activate',
  summary: 'Bind a Vibecarbon license key to this project',
  positional: [
    { name: 'key', optional: true, description: 'License key (vc-...). Prompts if omitted.' },
  ],
  flags: [{ name: 'h', boolean: true, description: 'Show this help' }],
};

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string }} */
const DEACTIVATE_SPEC = {
  name: 'deactivate',
  summary: 'Release the license key from this project (confirmed by email)',
  positional: [
    {
      name: 'key',
      optional: true,
      description: 'License key, when there is no .vibecarbon.license here',
    },
  ],
  flags: [
    { name: 'h', boolean: true, description: 'Show this help' },
    { name: 'y', boolean: true, description: 'Skip confirmation prompt' },
    {
      name: 'rm',
      boolean: true,
      description: 'Remove the local .vibecarbon.license only; no request is sent',
    },
  ],
};

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * What the tier just activated actually buys. Graphene does NOT cover HA —
 * telling a Graphene customer it does sends them into a deploy that
 * requireDeployEntitlement() refuses. An unrecognised tier says nothing
 * about scope rather than guessing.
 * @param {string} [tier]
 */
function activatedOutro(tier) {
  if (tier === 'graphene') return 'You can now deploy to Kubernetes environments.';
  if (tier === 'fullerene') return 'You can now deploy to Kubernetes and HA environments.';
  return 'License activated.';
}

export async function runActivate(args) {
  const { positional, handled } = parseFlagsOrExit(args, ACTIVATE_SPEC);
  if (handled) return;
  introCommand('activate');

  let licenseKey = /** @type {string|undefined} */ (positional.key);
  if (!licenseKey) {
    const inputKey = await p.text({
      message: 'Enter your license key:',
      placeholder: 'vc-...',
      validate: (value) => {
        if (!value) return 'License key is required';
        if (!/^vc-[0-9a-f]{16}-[0-9a-f]{128}$/i.test(value.trim()))
          return 'Invalid key format. Expected vc-<id>-<signature>';
        return undefined;
      },
    });
    if (p.isCancel(inputKey)) exitCancelled();
    licenseKey = inputKey;
  }

  const s = spinner();
  s.start('Binding this key to the project on vibecarbon.com');
  const result = await activateLicense(licenseKey);
  if (!result.success) {
    s.stop('Activation failed', 1);
    p.log.error(c.error(`Error: ${result.error}`));
    if (result.reason === 'project_already_licensed' && result.switchPlan) {
      p.log.info(`${c.dim('Switch plans at')} ${c.info(LICENSE_URL)}`);
    } else if (result.reason === 'invalid' || result.reason === 'unknown_key') {
      p.log.info(`${c.dim('Buy a license at')} ${c.info(PRICING_URL)}`);
    }
    process.exit(1);
  }
  s.stop('License activated');

  p.log.success(`Welcome to ${c.success(capitalize(result.tier))}!`);
  p.note(
    [
      `Tier: ${capitalize(result.tier)}`,
      `Project: ${result.projectId}`,
      `Status: ${result.status}`,
      `This CLI: v${VERSION}`,
      '',
      'commit .vibecarbon.license so everyone on the project can deploy.',
      'Subscription status is re-checked on every paid deploy.',
    ].join('\n'),
    'License Details',
  );
  p.outro(activatedOutro(result.tier));
}

export async function runDeactivate(args) {
  const { positional, values, handled } = parseFlagsOrExit(args, DEACTIVATE_SPEC);
  if (handled) return;
  introCommand('deactivate');

  const key = /** @type {string|undefined} */ (positional.key);
  const yes = !!values.y;

  if (values.rm) {
    if (!hasStoredLicense()) {
      p.log.info('No .vibecarbon.license here.');
      p.outro('');
      return;
    }
    if (!yes) {
      const confirm = await p.confirm({
        message:
          'Remove the local .vibecarbon.license? No request is sent; the key stays bound on vibecarbon.com.',
      });
      if (p.isCancel(confirm)) exitCancelled();
      if (!confirm) exitDeclined();
    }
    const r = removeLicenseFile();
    if (!r.success) {
      p.log.error(c.error(`Error: ${r.error}`));
      process.exit(1);
    }
    p.log.success('Removed .vibecarbon.license.');
    p.outro('');
    return;
  }

  if (!key && !hasStoredLicense()) {
    p.log.info('No license here. Pass the key: vibecarbon deactivate <key>');
    p.outro('');
    return;
  }

  if (!yes) {
    const confirm = await p.confirm({
      message:
        'Ask vibecarbon.com to email a release link for this key? Nothing changes until it is clicked.',
    });
    if (p.isCancel(confirm)) exitCancelled();
    if (!confirm) exitDeclined();
  }

  const s = spinner();
  s.start('Requesting a release link');
  const result = await deactivateLicense({ key });
  if (!result.success) {
    s.stop('Request failed', 1);
    p.log.error(c.error(`Error: ${result.error}`));
    process.exit(1);
  }
  s.stop('Release link sent');
  p.log.success(
    'Check your email: click the link within an hour to release this key from its project.',
  );
  p.log.info(
    'Nothing changes until you do. .vibecarbon.license stays here; run vibecarbon deactivate -rm to remove it.',
  );
  p.outro('');
}
