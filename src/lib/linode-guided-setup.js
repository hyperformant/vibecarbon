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
import { exitCancelled } from './cli/exit-guard.js';
import { spinner } from './cli/progress.js';
import { assertInteractiveStdin } from './cli/tty-guard.js';
import { c } from './colors.js';
import { setEnvVar } from './project.js';

const API_BASE = 'https://api.linode.com/v4';

// Linode personal-access-token shape: 64 alphanumeric characters (no
// distinctive prefix — same shape secret-scan.js's `linode-token` rule
// pins). Checked against every token we see — WARN, never block: a
// mismatch might just mean Linode changed their scheme, and blocking on a
// heuristic would strand an otherwise-valid token behind it.
const TOKEN_FORMAT = /^[A-Za-z0-9]{64}$/;

function warnIfBadTokenFormat(token) {
  if (!TOKEN_FORMAT.test(token)) {
    p.log.warn(
      'Linode API token does not match the expected format (64 alphanumeric characters), proceeding anyway.',
    );
  }
}

/**
 * Validate a Linode API token by making a lightweight API call.
 * @param {string} token
 * @returns {Promise<{ valid: boolean, error?: string, unreachable?: boolean }>}
 */
async function validateLinodeToken(token) {
  try {
    const res = await fetch(`${API_BASE}/profile`, {
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
    return { valid: false, error: `Linode API returned status ${res.status}` };
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
      `${c.bold('1.')} Open: ${c.boldCyanUnderline('https://cloud.linode.com/profile/tokens')}`,
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
      `${c.bold('1.')} Open: ${c.boldCyanUnderline('https://cloud.linode.com/object-storage/access-keys')}`,
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

// Session-level save preference — same contract as the identical
// module-level flag in hetzner-guided-setup.js / digitalocean-guided-setup.js.
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
      what: 'whether to save the Linode credentials',
      envVar: 'LINODE_API_TOKEN',
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
    const envToken = process.env.LINODE_API_TOKEN;
    if (envToken) {
      warnIfBadTokenFormat(envToken);
      const check = await validateLinodeToken(envToken);
      if (!check.valid) {
        p.log.warn(`LINODE_API_TOKEN environment variable is set but invalid: ${check.error}`);
        // Fall through to interactive prompt
      } else {
        if (check.unreachable) {
          p.log.warn('Could not reach Linode API to verify token, proceeding with saved token');
        }
        p.log.info('✓ Using Linode API token from LINODE_API_TOKEN environment variable');
        return envToken;
      }
    }
  }

  // Off a TTY this prompt can never be answered — clack's promise would
  // neither resolve nor cancel, draining the event loop into a silent
  // exit 0 (the 2026-08-11 v1 RCA). Fail loudly with the env var instead.
  assertInteractiveStdin({ what: 'the Linode API token', envVar: 'LINODE_API_TOKEN' });
  // Interactive prompt (with retry on invalid token)
  displayApiTokenGuide(projectName);

  let token;
  while (true) {
    token = await p.password({
      message: 'Paste your Linode API token here',
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
    const check = await validateLinodeToken(token);
    if (check.valid) {
      if (check.unreachable) {
        s.stop('Could not reach Linode API, proceeding with unverified token');
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
  const { save = true, force = false, skipPrompts = false } = options;

  if (!force) {
    const envAccessKey = process.env.LINODE_ACCESS_KEY;
    const envSecretKey = process.env.LINODE_SECRET_KEY;

    if (envAccessKey && envSecretKey) {
      p.log.info('✓ Using Object Storage credentials from environment variables');
      return { accessKey: envAccessKey, secretKey: envSecretKey };
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

  const accessKey = await p.text({
    message: 'Paste your Object Storage Access Key here',
    validate: (v) => {
      if (!v || v.length < 10) return 'Access Key is required';
      return undefined;
    },
  });

  if (p.isCancel(accessKey)) {
    exitCancelled();
  }

  const secretKey = await p.password({
    message: 'Paste your Object Storage Secret Key here',
    validate: (v) => {
      if (!v || v.length < 10) return 'Secret Key is required';
      return undefined;
    },
  });

  if (p.isCancel(secretKey)) {
    exitCancelled();
  }

  p.log.success('Object Storage credentials received!');

  // In-process coherence (A2) — see getApiToken's identical comment above.
  process.env.LINODE_ACCESS_KEY = accessKey;
  process.env.LINODE_SECRET_KEY = secretKey;

  if (save) {
    await saveIfWanted({
      LINODE_ACCESS_KEY: accessKey,
      LINODE_SECRET_KEY: secretKey,
    });
  }

  return { accessKey, secretKey };
}
