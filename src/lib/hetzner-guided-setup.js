/**
 * Hetzner Guided Setup - Interactive prompts for first-time setup
 *
 * This module provides improved DX for users setting up Hetzner credentials:
 * 1. Creating a Hetzner API token
 * 2. Creating S3 Object Storage credentials
 *
 * Features:
 * - Clear visual guides with step-by-step instructions
 * - Better validation and error messages
 * - Lookup chain: env var (shell or the project's .env.local, folded in by
 *   bootstrapOperatorEnv at CLI startup — see project.js) → interactive prompt
 * - Single "Save keys for future deploys?" prompt applies to all credentials
 */

import * as p from '@clack/prompts';
import { c, link } from './colors.js';
import { registryEntry } from './config-registry.js';
import {
  checkApiToken,
  createCredentialSaver,
  resolveApiToken,
  resolveS3KeyPair,
} from './guided-setup-shared.js';
import { normalizeOperatorValue } from './operator-env.js';

/**
 * Validate a Hetzner API token by making a lightweight API call.
 * @param {string} token
 * @returns {Promise<{ valid: boolean, error?: string }>}
 */
function validateHetznerToken(token) {
  return checkApiToken(
    'https://api.hetzner.cloud/v1/locations?per_page=1',
    { Authorization: `Bearer ${token}` },
    { api: 'Hetzner', unauthorized: 'Token is invalid or expired' },
  );
}

// What guided-setup-shared.js needs to look up, prompt for and verify the token.
const API_TOKEN = {
  envKey: 'HETZNER_API_TOKEN',
  provider: 'Hetzner',
  verify: validateHetznerToken,
  // Measure the NORMALIZED paste: a quote-wrapped or newline-terminated
  // 64-char token is fine once cleaned (M11).
  shapeProblem: (v) =>
    normalizeOperatorValue(v, registryEntry('HETZNER_API_TOKEN')).value.length !== 64
      ? 'Token should be 64 characters - please check you copied it correctly'
      : undefined,
};

/**
 * Display improved visual guide for API token creation.
 * Pinned to 3 numbered steps: open the page → click the button → paste the
 * token below (see the Providers plan's B2a guide standard).
 */
export function displayApiTokenGuide(projectName) {
  p.note(
    [
      `${c.bold('1.')} Open: ${c.boldCyanUnderline(link('https://console.hetzner.cloud/projects'))}`,
      `${c.dim('   └─')} Pick ${c.info(projectName || 'your-project')} ${c.dim('(or create it)')} → ${c.info('Security')} → ${c.info('API tokens')}`,
      '',
      `${c.bold('2.')} Click ${c.boldCyan('Generate API token')}`,
      `${c.dim('   ├─')} Description: ${c.info(`"${projectName || 'vibecarbon'}-deploy"`)}`,
      `${c.dim('   └─')} Permissions: ${c.info('Read & Write')} ${c.dim('(required)')}`,
      '',
      `${c.bold('3.')} ${c.boldYellow('⚠️  Copy the token immediately')} ${c.dim('; it is only shown once!')} Paste it below.`,
      '',
      c.dim(
        'Recommended: a dedicated Hetzner project + dedicated API token per vibecarbon project.',
      ),
    ].join('\n'),
    c.boldCyan('🔑 Hetzner API Token Setup'),
  );
}

/**
 * Display improved visual guide for S3 credentials creation.
 * Pinned to 3 numbered steps — same standard as displayApiTokenGuide above.
 */
export function displayS3CredentialsGuide(projectName) {
  p.note(
    [
      `${c.bold('1.')} Open: ${c.boldCyanUnderline(link('https://console.hetzner.cloud/projects'))}`,
      `${c.dim('   └─')} Pick ${c.info(projectName || 'your-project')} → ${c.info('Security')} → ${c.info('S3 credentials')}`,
      '',
      `${c.bold('2.')} Click ${c.boldCyan('Generate credentials')}`,
      `${c.dim('   └─')} Description: ${c.info(`"${projectName || 'vibecarbon'}-s3"`)}`,
      '',
      `${c.bold('3.')} ${c.boldYellow('⚠️  Copy BOTH credentials immediately')} ${c.dim('(the secret is only shown once)')} and paste them below.`,
      '',
      c.dim('Why S3? Required for database backups and file uploads.'),
      c.dim(
        'Recommended: a dedicated Hetzner project + dedicated API token per vibecarbon project.',
      ),
    ].join('\n'),
    c.boldCyan('🗄️  Hetzner Object Storage Setup'),
  );
}

// Session-level save preference: once the user answers "Save keys for future
// deploys?" the decision applies to all credentials prompted during this process.
const saveIfWanted = createCredentialSaver({ provider: 'Hetzner', envVar: 'HETZNER_API_TOKEN' });

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
 * Get S3 credentials: the env vars, else the interactive prompt (see
 * resolveS3KeyPair in guided-setup-shared.js).
 *
 * @param {string} [projectName] - Project name for display in guide
 * @param {{ save?: boolean, force?: boolean, skipPrompts?: boolean, deferSave?: boolean }} [options] -
 *   see resolveS3KeyPair
 * @returns {Promise<{accessKey: string, secretKey: string}|null>}
 */
export async function getS3Credentials(projectName, options = {}) {
  return resolveS3KeyPair(
    {
      provider: 'Hetzner',
      accessEnvKey: 'HETZNER_ACCESS_KEY',
      secretEnvKey: 'HETZNER_SECRET_KEY',
      label: 'S3',
    },
    { displayKeysGuide: displayS3CredentialsGuide, saveIfWanted },
    projectName,
    options,
  );
}
