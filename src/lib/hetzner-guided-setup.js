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
import { exitCancelled } from './cli/exit-guard.js';
import { spinner } from './cli/progress.js';
import { assertInteractiveStdin } from './cli/tty-guard.js';
import { c } from './colors.js';
import { setEnvVar } from './project.js';

/**
 * Validate a Hetzner API token by making a lightweight API call.
 * @param {string} token
 * @returns {Promise<{ valid: boolean, error?: string }>}
 */
async function validateHetznerToken(token) {
  try {
    const res = await fetch('https://api.hetzner.cloud/v1/locations?per_page=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return { valid: true };
    if (res.status === 401) return { valid: false, error: 'Token is invalid or expired' };
    return { valid: false, error: `Hetzner API returned status ${res.status}` };
  } catch {
    return { valid: true, unreachable: true };
  }
}

/**
 * Display improved visual guide for API token creation.
 * Pinned to 3 numbered steps: open the page → click the button → paste the
 * token below (see the Providers plan's B2a guide standard).
 */
export function displayApiTokenGuide(projectName) {
  p.note(
    [
      `${c.bold('1.')} Open: ${c.boldCyanUnderline('https://console.hetzner.cloud/projects')}`,
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
      `${c.bold('1.')} Open: ${c.boldCyanUnderline('https://console.hetzner.cloud/projects')}`,
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

// Session-level save preference: null = not asked yet, true/false = user's answer.
// Once the user answers "Save keys for future deploys?" the decision applies to all
// credentials prompted during this process.
let _savePreference = null;

/**
 * Ask the user once whether to save credentials, then reuse the answer.
 * @param {Record<string, string>} envVars - Flat env-var-name → value map to
 *   persist to the project's .env.local (operator-secret keys — see
 *   config-registry.js — always write localOnly, never .env).
 */
async function saveIfWanted(envVars) {
  if (_savePreference === null) {
    // Unreachable by construction today (this helper only runs after an
    // interactive prompt already succeeded, so stdin was a TTY), but the
    // invariant is 'any function that prompts, guards first' — so a future
    // caller that reaches it non-interactively fails loudly, not silently.
    assertInteractiveStdin({
      what: 'whether to save the Hetzner credentials',
      envVar: 'HETZNER_API_TOKEN',
    });
    const shouldSave = await p.confirm({
      message: 'Save keys for future deploys?',
      initialValue: true,
    });
    _savePreference = shouldSave && !p.isCancel(shouldSave);
  }

  if (_savePreference) {
    for (const [key, value] of Object.entries(envVars)) {
      setEnvVar(key, value, process.cwd(), { localOnly: true });
    }
    p.log.info(c.dim('Saved to .env.local'));
  }
}

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
    // Check environment variable
    const envToken = process.env.HETZNER_API_TOKEN;
    if (envToken) {
      const check = await validateHetznerToken(envToken);
      if (!check.valid) {
        p.log.warn(`HETZNER_API_TOKEN environment variable is set but invalid: ${check.error}`);
        // Fall through to interactive prompt
      } else {
        if (check.unreachable) {
          p.log.warn('Could not reach Hetzner API to verify token, proceeding with saved token');
        }
        p.log.info('✓ Using Hetzner API token from HETZNER_API_TOKEN environment variable');
        return envToken;
      }
    }
  }

  // Off a TTY this prompt can never be answered — clack's promise would
  // neither resolve nor cancel, draining the event loop into a silent
  // exit 0 (the 2026-08-11 v1 RCA). Fail loudly with the env var instead.
  assertInteractiveStdin({ what: 'the Hetzner API token', envVar: 'HETZNER_API_TOKEN' });
  // Interactive prompt (with retry on invalid token)
  displayApiTokenGuide(projectName);

  let token;
  while (true) {
    token = await p.password({
      message: 'Paste your Hetzner API token here',
      validate: (v) => {
        if (!v || v.length < 10) return 'API token is required';
        if (v.length !== 64)
          return 'Token should be 64 characters - please check you copied it correctly';
        return undefined;
      },
    });

    if (p.isCancel(token)) {
      exitCancelled();
    }

    const s = spinner();
    s.start('Verifying API token...');
    const check = await validateHetznerToken(token);
    if (check.valid) {
      if (check.unreachable) {
        s.stop('Could not reach Hetzner API, proceeding with unverified token');
      } else {
        s.stop('API token verified');
      }
      break;
    }
    s.stop(`Token invalid: ${check.error}`);
    p.log.warn('Please try again with a valid token.');
  }

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
  const { save = true, force = false, skipPrompts = false } = options;

  if (!force) {
    // Check environment variables
    const envAccessKey = process.env.HETZNER_ACCESS_KEY;
    const envSecretKey = process.env.HETZNER_SECRET_KEY;

    if (envAccessKey && envSecretKey) {
      p.log.info('✓ Using S3 credentials from environment variables');
      return { accessKey: envAccessKey, secretKey: envSecretKey };
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

  const accessKey = await p.text({
    message: 'Paste your S3 Access Key here',
    validate: (v) => {
      if (!v || v.length < 10) return 'Access Key is required';
      return undefined;
    },
  });

  if (p.isCancel(accessKey)) {
    exitCancelled();
  }

  const secretKey = await p.password({
    message: 'Paste your S3 Secret Key here',
    validate: (v) => {
      if (!v || v.length < 10) return 'Secret Key is required';
      return undefined;
    },
  });

  if (p.isCancel(secretKey)) {
    exitCancelled();
  }

  p.log.success('S3 credentials received!');

  // In-process coherence (A2) — see getApiToken's identical comment above.
  process.env.HETZNER_ACCESS_KEY = accessKey;
  process.env.HETZNER_SECRET_KEY = secretKey;

  if (save) {
    await saveIfWanted({ HETZNER_ACCESS_KEY: accessKey, HETZNER_SECRET_KEY: secretKey });
  }

  return { accessKey, secretKey };
}
