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
import { exitCancelled } from './cli/exit-guard.js';
import { spinner } from './cli/progress.js';
import { assertInteractiveStdin } from './cli/tty-guard.js';
import { verifyToken } from './cloudflare-dns.js';
import { c } from './colors.js';
import { setEnvVar } from './project.js';

/**
 * Display improved visual guide for API token creation.
 */
export function displayApiTokenGuide(projectName) {
  p.note(
    [
      `${c.bold('1.')} Open: ${c.boldCyanUnderline('https://dash.cloudflare.com/profile/api-tokens')}`,
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

// Session-level save preference: null = not asked yet, true/false = user's
// answer — same contract as hetzner/digitalocean-guided-setup.js's identical
// module-level flag (kept here for structural parity even though Cloudflare
// currently prompts for only one credential per session).
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
      what: 'whether to save the Cloudflare credentials',
      envVar: 'CLOUDFLARE_API_TOKEN',
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
    // Check environment variable
    const envToken = process.env.CLOUDFLARE_API_TOKEN;
    if (envToken) {
      const check = await verifyToken(envToken);
      if (!check.valid) {
        p.log.warn(`CLOUDFLARE_API_TOKEN environment variable is set but invalid: ${check.error}`);
        // Fall through to interactive prompt
      } else {
        if (check.unreachable) {
          p.log.warn('Could not reach Cloudflare API to verify token, proceeding with saved token');
        }
        p.log.info('✓ Using Cloudflare API token from CLOUDFLARE_API_TOKEN environment variable');
        return envToken;
      }
    }
  }

  // Off a TTY this prompt can never be answered — clack's promise would
  // neither resolve nor cancel, draining the event loop into a silent
  // exit 0 (the 2026-08-11 v1 RCA). Fail loudly with the env var instead.
  assertInteractiveStdin({ what: 'the Cloudflare API token', envVar: 'CLOUDFLARE_API_TOKEN' });
  // Interactive prompt (with retry on invalid token)
  displayApiTokenGuide(projectName);

  let token;
  while (true) {
    token = await p.password({
      message: 'Paste your Cloudflare API token here',
      validate: (v) => {
        if (!v || v.length < 10) return 'API token is required';
        return undefined;
      },
    });

    if (p.isCancel(token)) {
      exitCancelled();
    }

    const s = spinner();
    s.start('Verifying API token...');
    const check = await verifyToken(token);
    if (check.valid) {
      if (check.unreachable) {
        s.stop('Could not reach Cloudflare API, proceeding with unverified token');
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
  process.env.CLOUDFLARE_API_TOKEN = token;

  if (save) {
    await saveIfWanted({ CLOUDFLARE_API_TOKEN: token });
  }

  return token;
}
