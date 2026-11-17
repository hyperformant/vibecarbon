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
import { assertInteractiveStdin } from './cli/tty-guard.js';
import { c, link } from './colors.js';
import { registryEntry } from './config-registry.js';
import {
  checkApiToken,
  createCredentialSaver,
  finishS3Credentials,
  promptForVerifiedToken,
  promptS3KeyPair,
  verifiedEnvToken,
} from './guided-setup-shared.js';
import { normalizeOperatorValue, readOperatorVar } from './operator-env.js';
import { describeCredentialSource } from './project.js';

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
 * Get API token with improved visual guidance
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
  assertInteractiveStdin({ what: 'the Hetzner API token', envVar: 'HETZNER_API_TOKEN' });
  // Interactive prompt (with retry on invalid token)
  displayApiTokenGuide(projectName);
  const token = await promptForVerifiedToken(API_TOKEN);

  // In-process coherence (A2): a freshly-entered token must be visible to
  // any later env-first resolution in this same process, regardless of
  // whether the operator chooses to persist it to .env.local below.
  process.env.HETZNER_API_TOKEN = token;

  if (save) {
    await saveIfWanted({ HETZNER_API_TOKEN: token });
  }

  return token;
}

/**
 * Get S3 credentials with improved visual guidance
 * Lookup order: env vars (shell, or the project's .env.local via
 * bootstrapOperatorEnv) → interactive prompt
 *
 * @param {string} [projectName] - Project name for display in guide
 * @param {{ save?: boolean, force?: boolean, skipPrompts?: boolean }} [options] - Options
 *   save: offer to save credentials (default true)
 *   force: skip env lookup and go straight to interactive prompt (default false)
 *   skipPrompts: never fall through to the interactive prompt — return null
 *     instead when env vars are missing (default false). For batch/non-TTY
 *     callers (destroy.js's resolveDestroyS3Config, M3 Task 9g): clack's
 *     prompt primitives have no isTTY/stdin-close handling of their own, so
 *     without this a non-TTY caller with missing creds hangs forever instead
 *     of getting a fast, loud result.
 * @returns {Promise<{accessKey: string, secretKey: string}|null>}
 */
export async function getS3Credentials(projectName, options = {}) {
  const { save = true, force = false, skipPrompts = false, deferSave = false } = options;

  if (!force) {
    // Check environment variables
    const envAccessKey = readOperatorVar('HETZNER_ACCESS_KEY').value;
    const envSecretKey = readOperatorVar('HETZNER_SECRET_KEY').value;

    if (envAccessKey && envSecretKey) {
      const from = describeCredentialSource(['HETZNER_ACCESS_KEY', 'HETZNER_SECRET_KEY']);
      p.log.info(`✓ Using S3 credentials from ${from.label}`);
      return { accessKey: envAccessKey, secretKey: envSecretKey, source: from.label };
    }
  }

  if (skipPrompts) return null;

  // Off a TTY this prompt can never be answered — clack's promise would
  // neither resolve nor cancel, draining the event loop into a silent
  // exit 0 (the 2026-08-11 v1 RCA). Fail loudly with the env var instead.
  assertInteractiveStdin({
    what: 'the Hetzner object-storage keys',
    envVar: 'HETZNER_ACCESS_KEY/HETZNER_SECRET_KEY',
  });
  // Interactive prompt
  displayS3CredentialsGuide(projectName);
  const { accessKey, secretKey } = await promptS3KeyPair({
    provider: 'Hetzner',
    accessEnvKey: 'HETZNER_ACCESS_KEY',
    secretEnvKey: 'HETZNER_SECRET_KEY',
    label: 'S3',
  });

  p.log.success('S3 credentials received!');

  // In-process coherence (A2) — see getApiToken's identical comment above.
  process.env.HETZNER_ACCESS_KEY = accessKey;
  process.env.HETZNER_SECRET_KEY = secretKey;

  return finishS3Credentials(
    { accessKey, secretKey, source: 'what you pasted' },
    { HETZNER_ACCESS_KEY: accessKey, HETZNER_SECRET_KEY: secretKey },
    { save, deferSave },
    saveIfWanted,
  );
}
