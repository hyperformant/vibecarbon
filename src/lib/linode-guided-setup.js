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
import { assertInteractiveStdin } from './cli/tty-guard.js';
import { c, link } from './colors.js';
import {
  checkApiToken,
  createCredentialSaver,
  finishS3Credentials,
  promptForVerifiedToken,
  promptS3KeyPair,
  verifiedEnvToken,
} from './guided-setup-shared.js';
import { readOperatorVar } from './operator-env.js';
import { describeCredentialSource } from './project.js';

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
 * Get API token with improved visual guidance.
 * Lookup order: env var (shell, or the project's .env.local via
 * bootstrapOperatorEnv) → interactive prompt
 *
 * @param {string} [projectName] - Project name for display in guide
 * @param {{ save?: boolean, force?: boolean }} [options] - Options
 *   save: offer to save credentials (default true)
 *   force: skip the env lookup and go straight to interactive prompt (default false)
 * @returns {Promise<string|null>}
 */
export async function getApiToken(projectName, options = {}) {
  const { save = true, force = false } = options;

  if (!force) {
    const envToken = await verifiedEnvToken(API_TOKEN);
    if (envToken) return envToken;
  }

  // Off a TTY this prompt can never be answered — clack's promise would
  // neither resolve nor cancel, draining the event loop into a silent
  // exit 0 (the 2026-08-11 v1 RCA). Fail loudly with the env var instead.
  assertInteractiveStdin({ what: 'the Linode API token', envVar: 'LINODE_API_TOKEN' });
  // Interactive prompt (with retry on invalid token)
  displayApiTokenGuide(projectName);
  const token = await promptForVerifiedToken(API_TOKEN);

  // In-process coherence (A2): a freshly-entered token must be visible to
  // any later env-first resolution in this same process, regardless of
  // whether the operator chooses to persist it to .env.local below.
  process.env.LINODE_API_TOKEN = token;

  if (save) {
    await saveIfWanted({ LINODE_API_TOKEN: token });
  }

  return token;
}

/**
 * Get Object Storage (S3-compatible) credentials with improved visual
 * guidance. Lookup order: env vars (shell, or the project's .env.local via
 * bootstrapOperatorEnv) → interactive prompt
 *
 * @param {string} [projectName] - Project name for display in guide
 * @param {{ save?: boolean, force?: boolean, skipPrompts?: boolean }} [options] - Options
 *   save: offer to save credentials (default true)
 *   force: skip env lookup and go straight to interactive prompt (default false)
 *   skipPrompts: never fall through to the interactive prompt — return null
 *     instead when env vars are missing (default false). Same non-TTY
 *     contract as digitalocean-guided-setup.js's getS3Credentials.
 * @returns {Promise<{accessKey: string, secretKey: string}|null>}
 */
export async function getS3Credentials(projectName, options = {}) {
  const { save = true, force = false, skipPrompts = false, deferSave = false } = options;

  if (!force) {
    const envAccessKey = readOperatorVar('LINODE_ACCESS_KEY').value;
    const envSecretKey = readOperatorVar('LINODE_SECRET_KEY').value;

    if (envAccessKey && envSecretKey) {
      const from = describeCredentialSource(['LINODE_ACCESS_KEY', 'LINODE_SECRET_KEY']);
      p.log.info(`✓ Using Object Storage credentials from ${from.label}`);
      return { accessKey: envAccessKey, secretKey: envSecretKey, source: from.label };
    }
  }

  if (skipPrompts) return null;

  // Off a TTY this prompt can never be answered — clack's promise would
  // neither resolve nor cancel, draining the event loop into a silent
  // exit 0 (the 2026-08-11 v1 RCA). Fail loudly with the env var instead.
  assertInteractiveStdin({
    what: 'the Linode object-storage keys',
    envVar: 'LINODE_ACCESS_KEY/LINODE_SECRET_KEY',
  });
  // Interactive prompt
  displayS3CredentialsGuide(projectName);
  const { accessKey, secretKey } = await promptS3KeyPair({
    provider: 'Linode',
    accessEnvKey: 'LINODE_ACCESS_KEY',
    secretEnvKey: 'LINODE_SECRET_KEY',
    label: 'Object Storage',
  });

  p.log.success('Object Storage credentials received!');

  // In-process coherence (A2) — see getApiToken's identical comment above.
  process.env.LINODE_ACCESS_KEY = accessKey;
  process.env.LINODE_SECRET_KEY = secretKey;

  return finishS3Credentials(
    { accessKey, secretKey, source: 'what you pasted' },
    { LINODE_ACCESS_KEY: accessKey, LINODE_SECRET_KEY: secretKey },
    { save, deferSave },
    saveIfWanted,
  );
}
