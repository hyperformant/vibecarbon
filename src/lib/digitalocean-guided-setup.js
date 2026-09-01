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
import { exitCancelled } from './cli/exit-guard.js';
import { spinner } from './cli/progress.js';
import { assertInteractiveStdin } from './cli/tty-guard.js';
import { c } from './colors.js';
import { setEnvVar } from './project.js';

const API_BASE = 'https://api.digitalocean.com/v2';

// DigitalOcean personal-access-token shape: `dop_v1_`/`doo_v1_`/`dor_v1_` +
// 64 lowercase-hex characters. Checked against every token we see (env,
// saved, and freshly entered) — WARN, never block: a mismatch might just
// mean DO changed their prefix scheme, and blocking on a heuristic would
// strand an otherwise-valid token behind it.
const TOKEN_FORMAT = /^do[por]_v1_[a-f0-9]{64}$/;

function warnIfBadTokenFormat(token) {
  if (!TOKEN_FORMAT.test(token)) {
    p.log.warn(
      'DigitalOcean API token does not match the expected format (do[por]_v1_ + 64 hex characters), proceeding anyway.',
    );
  }
}

/**
 * Validate a DigitalOcean API token by making a lightweight API call.
 * @param {string} token
 * @returns {Promise<{ valid: boolean, error?: string, unreachable?: boolean }>}
 */
async function validateDigitalOceanToken(token) {
  try {
    const res = await fetch(`${API_BASE}/account`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return { valid: true };
    if (res.status === 401) return { valid: false, error: 'Token is invalid or expired' };
    // A 5xx is the PROVIDER's outage, not the operator's credential: treat it
    // like the network-error catch below (proceed with the env token; real
    // API calls fail honestly later if the outage persists). Live RCA
    // 2026-09-01 (run 33557406486): a Vultr API 502 on this preflight read
    // as "token invalid", and the non-TTY destroy died trying to prompt.
    if (res.status >= 500) return { valid: true, unreachable: true };
    return { valid: false, error: `DigitalOcean API returned status ${res.status}` };
  } catch {
    return { valid: true, unreachable: true };
  }
}

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
      `${c.bold('1.')} Create a dedicated project for this app: ${c.boldCyanUnderline('https://cloud.digitalocean.com/projects/new')}`,
      `${c.dim('   └─')} Name it ${c.info(`"${projectName || 'vibecarbon'}"`)} ${c.dim('— deploy files this app’s resources into it automatically (and creates it if missing, so this step is optional).')}`,
      '',
      `${c.bold('2.')} Generate a token: ${c.boldCyanUnderline('https://cloud.digitalocean.com/account/api/tokens')} → ${c.boldCyan('Generate New Token')}`,
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
      `${c.bold('1.')} Open: ${c.boldCyanUnderline('https://cloud.digitalocean.com/spaces/access_keys')}`,
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

// Session-level save preference: null = not asked yet, true/false = user's
// answer. Once the user answers "Save keys for future deploys?" the
// decision applies to all credentials prompted during this process — same
// contract as hetzner-guided-setup.js's identical module-level flag.
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
      what: 'whether to save the DigitalOcean credentials',
      envVar: 'DIGITALOCEAN_API_TOKEN',
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
    const envToken = process.env.DIGITALOCEAN_API_TOKEN;
    if (envToken) {
      warnIfBadTokenFormat(envToken);
      const check = await validateDigitalOceanToken(envToken);
      if (!check.valid) {
        p.log.warn(
          `DIGITALOCEAN_API_TOKEN environment variable is set but invalid: ${check.error}`,
        );
        // Fall through to interactive prompt
      } else {
        if (check.unreachable) {
          p.log.warn(
            'Could not reach DigitalOcean API to verify token, proceeding with saved token',
          );
        }
        p.log.info(
          '✓ Using DigitalOcean API token from DIGITALOCEAN_API_TOKEN environment variable',
        );
        return envToken;
      }
    }
  }

  // Off a TTY this prompt can never be answered — clack's promise would
  // neither resolve nor cancel, draining the event loop into a silent
  // exit 0 (the 2026-08-11 v1 RCA). Fail loudly with the env var instead.
  assertInteractiveStdin({ what: 'the DigitalOcean API token', envVar: 'DIGITALOCEAN_API_TOKEN' });
  // Interactive prompt (with retry on invalid token)
  displayApiTokenGuide(projectName);

  let token;
  while (true) {
    token = await p.password({
      message: 'Paste your DigitalOcean API token here',
      validate: (v) => {
        if (!v || v.length < 10) return 'API token is required';
        return undefined;
      },
    });

    if (p.isCancel(token)) {
      exitCancelled();
    }

    warnIfBadTokenFormat(token);

    const s = spinner();
    s.start('Verifying API token...');
    const check = await validateDigitalOceanToken(token);
    if (check.valid) {
      if (check.unreachable) {
        s.stop('Could not reach DigitalOcean API, proceeding with unverified token');
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
  process.env.DIGITALOCEAN_API_TOKEN = token;

  if (save) {
    await saveIfWanted({ DIGITALOCEAN_API_TOKEN: token });
  }

  return token;
}

/**
 * Get Spaces (S3-compatible) credentials with improved visual guidance
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
    const envAccessKey = process.env.DIGITALOCEAN_ACCESS_KEY;
    const envSecretKey = process.env.DIGITALOCEAN_SECRET_KEY;

    if (envAccessKey && envSecretKey) {
      p.log.info('✓ Using Spaces credentials from environment variables');
      return { accessKey: envAccessKey, secretKey: envSecretKey };
    }
  }

  if (skipPrompts) return null;

  // Off a TTY this prompt can never be answered — clack's promise would
  // neither resolve nor cancel, draining the event loop into a silent
  // exit 0 (the 2026-08-11 v1 RCA). Fail loudly with the env var instead.
  assertInteractiveStdin({
    what: 'the DigitalOcean object-storage keys',
    envVar: 'DIGITALOCEAN_ACCESS_KEY/DIGITALOCEAN_SECRET_KEY',
  });
  // Interactive prompt
  displayS3CredentialsGuide(projectName);

  const accessKey = await p.text({
    message: 'Paste your Spaces Access Key here',
    validate: (v) => {
      if (!v || v.length < 10) return 'Access Key is required';
      return undefined;
    },
  });

  if (p.isCancel(accessKey)) {
    exitCancelled();
  }

  const secretKey = await p.password({
    message: 'Paste your Spaces Secret Key here',
    validate: (v) => {
      if (!v || v.length < 10) return 'Secret Key is required';
      return undefined;
    },
  });

  if (p.isCancel(secretKey)) {
    exitCancelled();
  }

  p.log.success('Spaces credentials received!');

  // In-process coherence (A2) — see getApiToken's identical comment above.
  process.env.DIGITALOCEAN_ACCESS_KEY = accessKey;
  process.env.DIGITALOCEAN_SECRET_KEY = secretKey;

  if (save) {
    await saveIfWanted({
      DIGITALOCEAN_ACCESS_KEY: accessKey,
      DIGITALOCEAN_SECRET_KEY: secretKey,
    });
  }

  return { accessKey, secretKey };
}
