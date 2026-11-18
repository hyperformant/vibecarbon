/**
 * Linode Guided Setup - Interactive prompts for first-time setup
 *
 * Mirrors digitalocean-guided-setup.js / hetzner-guided-setup.js structure
 * exactly (see their docs for the shared design): lookup chain env var
 * (shell or the project's .env.local, folded in by bootstrapOperatorEnv at
 * CLI startup — see project.js) → interactive prompt, single "Save keys for
 * future deploys?" prompt shared across every credential prompted within
 * one guided-setup flow.
 *
 * Linode writes the API token and Object Storage credentials as three
 * flat, independent env vars (LINODE_API_TOKEN,
 * LINODE_ACCESS_KEY/SECRET).
 */

import * as p from '@clack/prompts';
import { c, link } from './colors.js';
import {
  checkApiToken,
  createCredentialSaver,
  resolveApiToken,
  resolveS3KeyPair,
} from './guided-setup-shared.js';

const API_BASE = 'https://api.linode.com/v4';

// Linode personal-access-token shape: 64 alphanumeric characters (no
// distinctive prefix — same shape secret-scan.js's `linode-token` rule
// pins). Checked against every token we see — WARN, never block: a
// mismatch might just mean Linode changed their scheme, and blocking on a
// heuristic would strand an otherwise-valid token behind it.
const TOKEN_FORMAT = /^[A-Za-z0-9]{64}$/;

/**
 * Validate a Linode API token by making a lightweight API call.
 * @param {string} token
 * @returns {Promise<{ valid: boolean, error?: string, unreachable?: boolean }>}
 */
function validateLinodeToken(token) {
  return checkApiToken(
    `${API_BASE}/profile`,
    { Authorization: `Bearer ${token}` },
    { api: 'Linode', unauthorized: 'Token is invalid or expired' },
  );
}

// What guided-setup-shared.js needs to look up, prompt for and verify the token.
const API_TOKEN = {
  envKey: 'LINODE_API_TOKEN',
  provider: 'Linode',
  verify: validateLinodeToken,
  format: { pattern: TOKEN_FORMAT, expected: '64 alphanumeric characters' },
};

/**
 * Display improved visual guide for API token creation.
 * Pinned to 3 numbered steps: open the page → click the button → paste the
 * token below (see the Providers plan's B2a guide standard).
 */
export function displayApiTokenGuide(projectName) {
  p.note(
    [
      `${c.bold('1.')} Open: ${c.boldCyanUnderline(link('https://cloud.linode.com/profile/tokens'))}`,
      '',
      `${c.bold('2.')} Click ${c.boldCyan('Create a Personal Access Token')}`,
      `${c.dim('   ├─')} Label: ${c.info(`"${projectName || 'vibecarbon'}-deploy"`)}`,
      `${c.dim('   ├─')} Expiry: ${c.info('Never')} ${c.dim('(or your rotation policy)')}`,
      `${c.dim('   └─')} Scopes: ${c.info('Select All (Read/Write)')} ${c.dim('(required)')}`,
      '',
      `${c.bold('3.')} ${c.boldYellow('⚠️  Copy the token immediately')} ${c.dim('; it will only be shown once!')} Paste it below.`,
      '',
      c.dim('Recommended: a dedicated API token per vibecarbon project.'),
    ].join('\n'),
    c.boldCyan('🔑 Linode API Token Setup'),
  );
}

/**
 * Display improved visual guide for Object Storage (S3-compatible)
 * credentials creation. Pinned to 3 numbered steps — same standard as
 * displayApiTokenGuide above. Includes the billing gotcha: creating the
 * first access key activates Object Storage on the account (flat monthly
 * base fee).
 */
export function displayS3CredentialsGuide(projectName) {
  p.note(
    [
      `${c.bold('1.')} Open: ${c.boldCyanUnderline(link('https://cloud.linode.com/object-storage/access-keys'))}`,
      '',
      `${c.bold('2.')} Click ${c.boldCyan('Create Access Key')}`,
      `${c.dim('   ├─')} Label: ${c.info(`"${projectName || 'vibecarbon'}-s3"`)}`,
      `${c.dim('   └─')} ${c.boldYellow('Note:')} ${c.dim('your first key enables Object Storage account-wide (flat monthly base fee).')}`,
      '',
      `${c.bold('3.')} ${c.boldYellow('⚠️  Copy BOTH keys immediately')} ${c.dim('(the secret is only shown once)')} and paste them below.`,
      '',
      c.dim('Why Object Storage? Required for database backups and file uploads.'),
    ].join('\n'),
    c.boldCyan('🗄️  Linode Object Storage Setup'),
  );
}

// Session-level save preference: once the user answers "Save keys for future
// deploys?" the decision applies to all credentials this module prompts for
// during this process.
const saveIfWanted = createCredentialSaver({
  provider: 'Linode',
  envVar: 'LINODE_API_TOKEN',
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
 * Get Object Storage (S3-compatible) credentials: the env vars, else the
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
      provider: 'Linode',
      accessEnvKey: 'LINODE_ACCESS_KEY',
      secretEnvKey: 'LINODE_SECRET_KEY',
      label: 'Object Storage',
    },
    { displayKeysGuide: displayS3CredentialsGuide, saveIfWanted },
    projectName,
    options,
  );
}
