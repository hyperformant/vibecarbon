/**
 * Vultr Guided Setup - Interactive prompts for first-time setup
 *
 * Mirrors linode-guided-setup.js / digitalocean-guided-setup.js /
 * hetzner-guided-setup.js structure exactly (see their docs for the shared
 * design): lookup chain env var (shell or the project's .env.local, folded
 * in by bootstrapOperatorEnv at CLI startup — see project.js) → interactive
 * prompt, single "Save keys for future deploys?" prompt shared across every
 * credential prompted within one guided-setup flow.
 *
 * Vultr writes the API token and Object Storage credentials as four flat,
 * independent env vars (VULTR_API_TOKEN, VULTR_ACCESS_KEY/SECRET,
 * VULTR_STORAGE_REGION).
 *
 * THE CLUSTER IS PART OF THE CREDENTIAL (the one structural difference from
 * every sibling module): Vultr mints object-storage keys PER SUBSCRIPTION,
 * and one subscription lives in exactly one cluster, so a key pair only
 * authenticates against its own cluster's endpoint. There is no account-wide
 * key whose region can be inferred from the compute region — the cluster
 * slug is required config, so getS3Credentials collects it alongside the
 * pair. See the vultr-provider-step0-audit plan
 * (live-probed 2026-08-08) and vultr-objectstorage.js.
 */

import * as p from '@clack/prompts';
import { exitCancelled } from './cli/exit-guard.js';
import { spinner } from './cli/progress.js';
import { assertInteractiveStdin } from './cli/tty-guard.js';
import { c } from './colors.js';
import { setEnvVar } from './project.js';

const API_BASE = 'https://api.vultr.com/v2';

// Vultr API key shape: 36 UPPERCASE alphanumeric characters (no prefix —
// same shape secret-scan.js's `vultr-token` rule pins; confirmed against a
// live key in the step-0 audit). Checked against every token we see —
// WARN, never block: a mismatch might just mean Vultr changed their
// scheme, and blocking on a heuristic would strand an otherwise-valid
// token behind it.
const TOKEN_FORMAT = /^[A-Z0-9]{36}$/;

// Object Storage cluster slug — the hostname prefix of
// `<cluster>.vultrobjects.com` (e.g. `ewr1`, `chi3`). Lowercase alnum;
// NOT a compute region id (the `ord` region's cluster is `chi3`).
const CLUSTER_FORMAT = /^[a-z0-9]+$/;

function warnIfBadTokenFormat(token) {
  if (!TOKEN_FORMAT.test(token)) {
    p.log.warn(
      'Vultr API key does not match the expected format (36 uppercase alphanumeric characters), proceeding anyway.',
    );
  }
}

/**
 * Validate a Vultr API key by making a lightweight API call.
 * `GET /v2/account` with `Authorization: Bearer <key>` answers 401
 * `{"error":"Invalid API token."}` for a bad key (probed 2026-08-08).
 * @param {string} token
 * @returns {Promise<{ valid: boolean, error?: string, unreachable?: boolean }>}
 */
async function validateVultrToken(token) {
  try {
    const res = await fetch(`${API_BASE}/account`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return { valid: true };
    if (res.status === 401) return { valid: false, error: 'API key is invalid or was regenerated' };
    if (res.status === 403) {
      return {
        valid: false,
        error:
          'Access denied (403), if you set API Access Control, add this machine’s public IP to the allowed subnets',
      };
    }
    // A 5xx is the PROVIDER's outage, not the operator's credential: treat it
    // like the network-error catch below (proceed with the env token; real
    // API calls fail honestly later if the outage persists). Live RCA
    // 2026-09-01 (run 33557406486): a Vultr API 502 on this preflight read
    // as "token invalid", and the non-TTY destroy died trying to prompt.
    if (res.status >= 500) return { valid: true, unreachable: true };
    return { valid: false, error: `Vultr API returned status ${res.status}` };
  } catch {
    return { valid: true, unreachable: true };
  }
}

/**
 * Display improved visual guide for API key creation.
 * Pinned to 3 numbered steps: open the page → click the button → paste the
 * key below (see the Providers plan's B2a guide standard).
 *
 * Step 3 is the Access Control gotcha rather than Linode's copy-once
 * warning: Vultr keys stay readable in the portal, but the API silently
 * refuses calls from any IP outside the allowed-subnets list, which reads
 * as "my brand-new key doesn't work".
 */
export function displayApiTokenGuide(_projectName) {
  p.note(
    [
      `${c.bold('1.')} Open: ${c.boldCyanUnderline('https://my.vultr.com/settings/#settingsapi')}`,
      `${c.dim('   └─')} ${c.dim('Or in the console: Account → API (under "Other").')}`,
      '',
      `${c.bold('2.')} Click ${c.boldCyan('Enable API')}, then copy the ${c.boldCyan('API Key')}`,
      `${c.dim('   └─')} ${c.dim('Vultr issues ONE key per account; use Sub-Accounts, not a second key, to separate environments.')}`,
      '',
      `${c.bold('3.')} ${c.boldYellow('⚠️  Check Access Control on the same page')} ${c.dim('; the API rejects calls from any IP outside the allowed subnets.')}`,
      `${c.dim('   └─')} Add this machine's public IP ${c.dim('(or')} ${c.info('0.0.0.0/0')} ${c.dim('to allow any).')}`,
      '',
      c.dim('Paste the key below. You can rotate it any time from the same page.'),
    ].join('\n'),
    c.boldCyan('🔑 Vultr API Key Setup'),
  );
}

/**
 * Display improved visual guide for Object Storage (S3-compatible)
 * credentials creation. Pinned to 3 numbered steps — same standard as
 * displayApiTokenGuide above. Includes the billing gotcha (a subscription
 * is a flat monthly commitment, not usage-metered) and the cluster, which
 * is the third thing we collect here.
 */
export function displayS3CredentialsGuide(projectName) {
  p.note(
    [
      `${c.bold('1.')} Open: ${c.boldCyanUnderline('https://my.vultr.com/objectstorage/')} ${c.dim('and click')} ${c.boldCyan('Create Object Storage')}`,
      `${c.dim('   ├─')} Tier + location: ${c.dim('availability and price vary by location: see')} ${c.boldCyanUnderline('https://www.vultr.com/pricing/')}`,
      `${c.dim('   ├─')} Name: ${c.info(`"${projectName || 'vibecarbon'}-s3"`)}`,
      `${c.dim('   └─')} ${c.boldYellow('Note:')} ${c.dim('each subscription bills a FLAT monthly fee, one is enough.')}`,
      '',
      `${c.bold('2.')} Open the new subscription → ${c.boldCyan('Overview')} → ${c.boldCyan('S3 Credentials')}`,
      '',
      `${c.bold('3.')} Copy the ${c.boldCyan('access key')}, the ${c.boldCyan('secret key')} ${c.dim('(eye icon reveals it)')}, and the ${c.boldCyan('hostname')} — paste them below.`,
      '',
      c.dim('Why Object Storage? Required for database backups and file uploads.'),
    ].join('\n'),
    c.boldCyan('🗄️  Vultr Object Storage Setup'),
  );
}

// Session-level save preference — same contract as the identical
// module-level flag in linode-guided-setup.js / hetzner-guided-setup.js /
// digitalocean-guided-setup.js.
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
      what: 'whether to save the Vultr credentials',
      envVar: 'VULTR_API_TOKEN',
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
    const envToken = process.env.VULTR_API_TOKEN;
    if (envToken) {
      warnIfBadTokenFormat(envToken);
      const check = await validateVultrToken(envToken);
      if (!check.valid) {
        p.log.warn(`VULTR_API_TOKEN environment variable is set but invalid: ${check.error}`);
        // Fall through to interactive prompt
      } else {
        if (check.unreachable) {
          p.log.warn('Could not reach Vultr API to verify key, proceeding with saved key');
        }
        p.log.info('✓ Using Vultr API key from VULTR_API_TOKEN environment variable');
        return envToken;
      }
    }
  }

  // Off a TTY this prompt can never be answered — clack's promise would
  // neither resolve nor cancel, draining the event loop into a silent
  // exit 0 (the 2026-08-11 v1 RCA). Fail loudly with the env var instead.
  assertInteractiveStdin({ what: 'the Vultr API key', envVar: 'VULTR_API_TOKEN' });
  // Interactive prompt (with retry on invalid token)
  displayApiTokenGuide(projectName);

  let token;
  while (true) {
    token = await p.password({
      message: 'Paste your Vultr API key here',
      validate: (v) => {
        if (!v || v.length < 10) return 'API key is required';
        return undefined;
      },
    });

    if (p.isCancel(token)) {
      exitCancelled();
    }

    warnIfBadTokenFormat(token);

    const s = spinner();
    s.start('Verifying API key...');
    const check = await validateVultrToken(token);
    if (check.valid) {
      if (check.unreachable) {
        s.stop('Could not reach Vultr API, proceeding with unverified key');
      } else {
        s.stop('API key verified');
      }
      break;
    }
    s.stop(`Key invalid: ${check.error}`);
    p.log.warn('Please try again with a valid key.');
  }

  // In-process coherence (A2): a freshly-entered token must be visible to
  // any later env-first resolution in this same process, regardless of
  // whether the operator chooses to persist it to .env.local below.
  process.env.VULTR_API_TOKEN = token;

  if (save) {
    await saveIfWanted({ VULTR_API_TOKEN: token });
  }

  return token;
}

/**
 * Get Object Storage (S3-compatible) credentials with improved visual
 * guidance. Lookup order: env vars (shell, or the project's .env.local via
 * bootstrapOperatorEnv) → interactive prompt
 *
 * Collects the subscription's CLUSTER as a third value (see the module
 * doc): the returned `region` is additive on top of the cross-provider
 * `{accessKey, secretKey}` contract, so callers that destructure only the
 * pair are unaffected. configure-providers.js picks it up generically via
 * `Provider.S3_REGION_ENV`.
 *
 * @param {string} [projectName] - Project name for display in guide
 * @param {{ save?: boolean, force?: boolean, skipPrompts?: boolean }} [options] - Options
 *   save: offer to save credentials (default true)
 *   force: skip env lookup and go straight to interactive prompt (default false)
 *   skipPrompts: never fall through to the interactive prompt — return null
 *     instead when env vars are missing (default false). Same non-TTY
 *     contract as digitalocean-guided-setup.js's getS3Credentials.
 * @returns {Promise<{accessKey: string, secretKey: string, region?: string}|null>}
 */
export async function getS3Credentials(projectName, options = {}) {
  const { save = true, force = false, skipPrompts = false } = options;

  if (!force) {
    const envAccessKey = process.env.VULTR_ACCESS_KEY;
    const envSecretKey = process.env.VULTR_SECRET_KEY;

    if (envAccessKey && envSecretKey) {
      p.log.info('✓ Using Object Storage credentials from environment variables');
      const envRegion = process.env.VULTR_STORAGE_REGION;
      if (!envRegion) {
        // Not fatal — resolveS3Region still returns the compute region's
        // default cluster — but on Vultr that default is a guess, and a
        // key pair pointed at the wrong cluster fails as an opaque auth
        // error rather than a missing-config one.
        p.log.warn(
          'VULTR_STORAGE_REGION is not set; set it to your subscription’s cluster (e.g. ewr1) if backups fail to authenticate.',
        );
      }
      return { accessKey: envAccessKey, secretKey: envSecretKey, region: envRegion };
    }
  }

  if (skipPrompts) return null;

  // Off a TTY this prompt can never be answered — clack's promise would
  // neither resolve nor cancel, draining the event loop into a silent
  // exit 0 (the 2026-08-11 v1 RCA). Fail loudly with the env var instead.
  assertInteractiveStdin({
    what: 'the Vultr object-storage keys',
    envVar: 'VULTR_ACCESS_KEY/VULTR_SECRET_KEY',
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

  const region = await p.text({
    message: 'Which cluster is that subscription in? (hostname prefix, e.g. ewr1)',
    placeholder: 'ewr1',
    validate: (v) => {
      if (!v) return 'Cluster is required, Vultr keys only work against their own cluster';
      if (!CLUSTER_FORMAT.test(v)) {
        return 'Just the prefix of the S3 hostname — "ewr1", not "ewr1.vultrobjects.com"';
      }
      return undefined;
    },
  });

  if (p.isCancel(region)) {
    exitCancelled();
  }

  p.log.success('Object Storage credentials received!');

  // In-process coherence (A2) — see getApiToken's identical comment above.
  process.env.VULTR_ACCESS_KEY = accessKey;
  process.env.VULTR_SECRET_KEY = secretKey;
  process.env.VULTR_STORAGE_REGION = region;

  if (save) {
    await saveIfWanted({
      VULTR_ACCESS_KEY: accessKey,
      VULTR_SECRET_KEY: secretKey,
      VULTR_STORAGE_REGION: region,
    });
  }

  return { accessKey, secretKey, region };
}
