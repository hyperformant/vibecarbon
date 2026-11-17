/**
 * Cloudflare Guided Setup - Interactive prompts for first-time setup
 *
 * Mirrors hetzner-guided-setup.js / digitalocean-guided-setup.js's structure
 * (see hetzner's doc comment for the shared design): lookup chain env var
 * (shell or the project's .env.local, folded in by bootstrapOperatorEnv at
 * CLI startup — see project.js) → interactive prompt, with a "Save keys for
 * future deploys?" prompt on acceptance.
 *
 * Cloudflare has exactly one credential (the API token) — there's no
 * S3-equivalent guide/getter here, unlike the two compute-provider modules.
 * Token verification lives in cloudflare-dns.js's `verifyToken` (shared with
 * deploy/prompts.js's DNS-provider flow) rather than a private validator, so
 * both call sites hit the Cloudflare API the same way.
 */

import * as p from '@clack/prompts';
import { assertInteractiveStdin } from './cli/tty-guard.js';
import { verifyToken } from './cloudflare-dns.js';
import { c, link } from './colors.js';
import {
  createCredentialSaver,
  promptForVerifiedToken,
  verifiedEnvToken,
} from './guided-setup-shared.js';

// What guided-setup-shared.js needs to look up, prompt for and verify the token.
const API_TOKEN = {
  envKey: 'CLOUDFLARE_API_TOKEN',
  provider: 'Cloudflare',
  verify: verifyToken,
};

/**
 * Display improved visual guide for API token creation.
 */
export function displayApiTokenGuide(projectName) {
  p.note(
    [
      `${c.bold('1.')} Open: ${c.boldCyanUnderline(link('https://dash.cloudflare.com/profile/api-tokens'))}`,
      '',
      `${c.bold('2.')} Click ${c.boldCyan('Create Token')}`,
      `${c.dim('   ├─')} Template: ${c.info('Edit zone DNS')}`,
      `${c.dim('   └─')} Token name: ${c.info(`"${projectName || 'vibecarbon'}-deploy"`)}`,
      '',
      `${c.bold('3.')} Select the zone(s) this project needs, then ${c.boldCyan('Continue to summary')} → ${c.boldCyan('Create Token')}`,
      `${c.dim('   └─')} ${c.boldYellow('⚠️  Copy the token immediately')} ${c.dim('; it is only shown once!')}`,
      '',
      c.dim(
        "Recommended: a dedicated API token scoped to this project's zone(s); don't reuse one token across multiple vibecarbon projects.",
      ),
    ].join('\n'),
    c.boldCyan('🔑 Cloudflare API Token Setup'),
  );
}

// Session-level save preference: once the user answers "Save keys for future
// deploys?" the decision applies to all credentials this module prompts for
// during this process.
const saveIfWanted = createCredentialSaver({
  provider: 'Cloudflare',
  envVar: 'CLOUDFLARE_API_TOKEN',
});

/**
 * Get API token with improved visual guidance.
 * Lookup order: env var (shell, or the project's .env.local via
 * bootstrapOperatorEnv) → interactive prompt.
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
  assertInteractiveStdin({ what: 'the Cloudflare API token', envVar: 'CLOUDFLARE_API_TOKEN' });
  // Interactive prompt (with retry on invalid token)
  displayApiTokenGuide(projectName);
  const token = await promptForVerifiedToken(API_TOKEN);

  // In-process coherence (A2): a freshly-entered token must be visible to
  // any later env-first resolution in this same process, regardless of
  // whether the operator chooses to persist it to .env.local below.
  process.env.CLOUDFLARE_API_TOKEN = token;

  if (save) {
    await saveIfWanted({ CLOUDFLARE_API_TOKEN: token });
  }

  return token;
}
