/**
 * DigitalOcean Guided Setup - Interactive prompts for first-time setup
 *
 * Mirrors hetzner-guided-setup.js's structure exactly (see its doc for the
 * shared design): lookup chain env var (shell or the project's .env.local,
 * folded in by bootstrapOperatorEnv at CLI startup — see project.js) →
 * interactive prompt, single "Save keys for future deploys?" prompt shared
 * across every credential prompted within one guided-setup flow.
 *
 * DigitalOcean writes the API token and Spaces credentials as three flat,
 * independent env vars (DIGITALOCEAN_API_TOKEN, DIGITALOCEAN_ACCESS_KEY/
 * SECRET) — no nested object to merge fields into.
 */

import * as p from '@clack/prompts';
import { c, link } from './colors.js';
import {
  checkApiToken,
  createCredentialSaver,
  resolveApiToken,
  resolveS3KeyPair,
} from './guided-setup-shared.js';

const API_BASE = 'https://api.digitalocean.com/v2';

// DigitalOcean personal-access-token shape: `dop_v1_`/`doo_v1_`/`dor_v1_` +
// 64 lowercase-hex characters. Checked against every token we see (env,
// saved, and freshly entered) — WARN, never block: a mismatch might just
// mean DO changed their prefix scheme, and blocking on a heuristic would
// strand an otherwise-valid token behind it.
const TOKEN_FORMAT = /^do[por]_v1_[a-f0-9]{64}$/;

/**
 * Validate a DigitalOcean API token by making a lightweight API call.
 * @param {string} token
 * @returns {Promise<{ valid: boolean, error?: string, unreachable?: boolean }>}
 */
function validateDigitalOceanToken(token) {
  return checkApiToken(
    `${API_BASE}/account`,
    { Authorization: `Bearer ${token}` },
    { api: 'DigitalOcean', unauthorized: 'Token is invalid or expired' },
  );
}

// What guided-setup-shared.js needs to look up, prompt for and verify the token.
const API_TOKEN = {
  envKey: 'DIGITALOCEAN_API_TOKEN',
  provider: 'DigitalOcean',
  verify: validateDigitalOceanToken,
  format: { pattern: TOKEN_FORMAT, expected: 'do[por]_v1_ + 64 hex characters' },
};

/**
 * Display improved visual guide for API token creation.
 * Pinned to 3 numbered steps (the B2a guide standard): the project station
 * and the token station are separate in DO's console, so step 2 folds
 * "open the page" and "click the button" into one line to stay at three.
 *
 * DO tokens are account-scoped, but deploy/scale run ensureProjectAssignment
 * (providers/digitalocean.js) afterwards: find-or-create the DO project by
 * the vibecarbon project name and file the droplets into it. Step 1 tells
 * the operator to name a pre-created project to match — or skip it and let
 * deploy create it.
 *
 * The trailing line answers the "second environment" question: one token
 * per vibecarbon project covers every environment (resources are
 * name-scoped `${projectName}-${environment}`), so this guide only ever
 * shows once per project — later deploys resolve the saved token env-first.
 */
export function displayApiTokenGuide(projectName) {
  p.note(
    [
      `${c.bold('1.')} Create a dedicated project for this app: ${c.boldCyanUnderline(link('https://cloud.digitalocean.com/projects/new'))}`,
      `${c.dim('   └─')} Name it ${c.info(`"${projectName || 'vibecarbon'}"`)} ${c.dim('— deploy files this app’s resources into it automatically (and creates it if missing, so this step is optional).')}`,
      '',
      `${c.bold('2.')} Generate a token: ${c.boldCyanUnderline(link('https://cloud.digitalocean.com/account/api/tokens'))} → ${c.boldCyan('Generate New Token')}`,
      `${c.dim('   ├─')} Name: ${c.info(`"${projectName || 'vibecarbon'}-deploy"`)}`,
      `${c.dim('   └─')} Scope: ${c.info('Full Access')} ${c.dim('(required)')}`,
      '',
      `${c.bold('3.')} ${c.boldYellow('⚠️  Copy the token immediately')} ${c.dim('; it will only be shown once!')} Paste it below.`,
      '',
      c.dim(
        'One dedicated project + one token per vibecarbon project — every environment (prod, staging, …) deploys with the same token.',
      ),
    ].join('\n'),
    c.boldCyan('🔑 DigitalOcean API Token Setup'),
  );
}

/**
 * Display improved visual guide for Spaces (S3-compatible) credentials
 * creation. Pinned to 3 numbered steps — same standard as
 * displayApiTokenGuide above. Includes the known gotcha: DigitalOcean greys
 * out "Create Access Key" until the account has at least one Space (bucket).
 */
export function displayS3CredentialsGuide(projectName) {
  p.note(
    [
      `${c.bold('1.')} Open: ${c.boldCyanUnderline(link('https://cloud.digitalocean.com/spaces/access_keys'))}`,
      `${c.dim('   └─')} ${c.dim('Full Access keys, not under Applications & API; the console moved this page here.')}`,
      '',
      `${c.bold('2.')} Click ${c.boldCyan('Create Access Key')}`,
      `${c.dim('   ├─')} Name: ${c.info(`"${projectName || 'vibecarbon'}-s3"`)}`,
      `${c.dim('   └─')} ${c.boldYellow('Greyed out?')} ${c.dim('Create a Space (bucket) first to activate Spaces, then retry.')}`,
      '',
      `${c.bold('3.')} ${c.boldYellow('⚠️  Copy BOTH keys immediately')} ${c.dim('(the secret is only shown once)')} and paste them below.`,
      '',
      c.dim('Why Spaces? Required for database backups and file uploads.'),
      c.dim(
        'Recommended: a dedicated DigitalOcean project + dedicated API keys per vibecarbon project.',
      ),
    ].join('\n'),
    c.boldCyan('🗄️  DigitalOcean Spaces Setup'),
  );
}

// Session-level save preference: once the user answers "Save keys for future
// deploys?" the decision applies to all credentials this module prompts for
// during this process.
const saveIfWanted = createCredentialSaver({
  provider: 'DigitalOcean',
  envVar: 'DIGITALOCEAN_API_TOKEN',
});

/**
 * Get the API token: the env var, else the interactive prompt (see
 * resolveApiToken in guided-setup-shared.js).
 *
 * @param {string} [projectName] - Project name for display in guide
 * @param {{ save?: boolean, force?: boolean }} [options] - see resolveApiToken
 * @returns {Promise<string>}
 */
export async function getApiToken(projectName, options = {}) {
  return resolveApiToken(
    API_TOKEN,
    { displayTokenGuide: displayApiTokenGuide, saveIfWanted },
    projectName,
    options,
  );
}

/**
 * Get Spaces (S3-compatible) credentials: the env vars, else the
 * interactive prompt (see resolveS3KeyPair in guided-setup-shared.js).
 *
 * @param {string} [projectName] - Project name for display in guide
 * @param {{ save?: boolean, force?: boolean, skipPrompts?: boolean, deferSave?: boolean }} [options] -
 *   see resolveS3KeyPair
 * @returns {Promise<{accessKey: string, secretKey: string}|null>}
 */
export async function getS3Credentials(projectName, options = {}) {
  return resolveS3KeyPair(
    {
      provider: 'DigitalOcean',
      accessEnvKey: 'DIGITALOCEAN_ACCESS_KEY',
      secretEnvKey: 'DIGITALOCEAN_SECRET_KEY',
      label: 'Spaces',
    },
    { displayKeysGuide: displayS3CredentialsGuide, saveIfWanted },
    projectName,
    options,
  );
}
