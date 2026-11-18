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
import { assertInteractiveStdin } from './cli/tty-guard.js';
import { c, link } from './colors.js';
import { registryEntry } from './config-registry.js';
import {
  checkApiToken,
  createCredentialSaver,
  finishS3Credentials,
  promptS3KeyPair,
  resolveApiToken,
} from './guided-setup-shared.js';
import { dotenvPromptProblem, normalizeOperatorValue, readOperatorVar } from './operator-env.js';
import { describeCredentialSource } from './project.js';

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

/**
 * Validate a Vultr API key by making a lightweight API call.
 * `GET /v2/account` with `Authorization: Bearer <key>` answers 401
 * `{"error":"Invalid API token."}` for a bad key (probed 2026-08-08).
 * @param {string} token
 * @returns {Promise<{ valid: boolean, error?: string, unreachable?: boolean }>}
 */
function validateVultrToken(token) {
  return checkApiToken(
    `${API_BASE}/account`,
    { Authorization: `Bearer ${token}` },
    {
      api: 'Vultr',
      unauthorized: 'API key is invalid or was regenerated',
      forbidden:
        'Access denied (403), if you set API Access Control, add this machine’s public IP to the allowed subnets',
    },
  );
}

// What guided-setup-shared.js needs to look up, prompt for and verify the
// key. Vultr calls it an API key, so every line about it says "key".
const API_TOKEN = {
  envKey: 'VULTR_API_TOKEN',
  provider: 'Vultr',
  noun: 'key',
  verify: validateVultrToken,
  format: { pattern: TOKEN_FORMAT, expected: '36 uppercase alphanumeric characters' },
};

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
      `${c.bold('1.')} Open: ${c.boldCyanUnderline(link('https://my.vultr.com/settings/#settingsapi'))}`,
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
      `${c.bold('1.')} Open: ${c.boldCyanUnderline(link('https://my.vultr.com/objectstorage/'))} ${c.dim('and click')} ${c.boldCyan('Create Object Storage')}`,
      `${c.dim('   ├─')} Tier + location: ${c.dim('availability and price vary by location: see')} ${c.boldCyanUnderline(link('https://www.vultr.com/pricing/'))}`,
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

// Session-level save preference: once the user answers "Save keys for future
// deploys?" the decision applies to all credentials this module prompts for
// during this process.
const saveIfWanted = createCredentialSaver({ provider: 'Vultr', envVar: 'VULTR_API_TOKEN' });

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
  const { save = true, force = false, skipPrompts = false, deferSave = false } = options;

  if (!force) {
    const envAccessKey = readOperatorVar('VULTR_ACCESS_KEY').value;
    const envSecretKey = readOperatorVar('VULTR_SECRET_KEY').value;

    if (envAccessKey && envSecretKey) {
      const from = describeCredentialSource(['VULTR_ACCESS_KEY', 'VULTR_SECRET_KEY']);
      p.log.info(`✓ Using Object Storage credentials from ${from.label}`);
      const envRegion = readOperatorVar('VULTR_STORAGE_REGION').value;
      if (!envRegion) {
        // Not fatal — resolveS3Region still returns the compute region's
        // default cluster — but on Vultr that default is a guess, and a
        // key pair pointed at the wrong cluster fails as an opaque auth
        // error rather than a missing-config one.
        p.log.warn(
          'VULTR_STORAGE_REGION is not set; set it to your subscription’s cluster (e.g. ewr1) if backups fail to authenticate.',
        );
      }
      return {
        accessKey: envAccessKey,
        secretKey: envSecretKey,
        region: envRegion,
        source: from.label,
      };
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

  const { accessKey, secretKey } = await promptS3KeyPair({
    provider: 'Vultr',
    accessEnvKey: 'VULTR_ACCESS_KEY',
    secretEnvKey: 'VULTR_SECRET_KEY',
    label: 'Object Storage',
  });

  const regionInput = await p.text({
    message: 'Which cluster is that subscription in? (hostname prefix, e.g. ewr1)',
    placeholder: 'ewr1',
    validate: (v) => {
      if (!v) return 'Cluster is required, Vultr keys only work against their own cluster';
      // Checked on the normalized paste (M11) — "ewr1 " with a stray space
      // or a quoted "ewr1" is fine once cleaned.
      if (
        !CLUSTER_FORMAT.test(normalizeOperatorValue(v, registryEntry('VULTR_STORAGE_REGION')).value)
      ) {
        return 'Just the prefix of the S3 hostname — "ewr1", not "ewr1.vultrobjects.com"';
      }
      return dotenvPromptProblem('VULTR_STORAGE_REGION', v);
    },
  });

  if (p.isCancel(regionInput)) {
    exitCancelled();
  }
  const region = normalizeOperatorValue(regionInput, registryEntry('VULTR_STORAGE_REGION')).value;

  p.log.success('Object Storage credentials received!');

  // In-process coherence (A2) — see getApiToken's identical comment above.
  process.env.VULTR_ACCESS_KEY = accessKey;
  process.env.VULTR_SECRET_KEY = secretKey;
  process.env.VULTR_STORAGE_REGION = region;

  return finishS3Credentials(
    { accessKey, secretKey, region, source: 'what you pasted' },
    { VULTR_ACCESS_KEY: accessKey, VULTR_SECRET_KEY: secretKey, VULTR_STORAGE_REGION: region },
    { save, deferSave },
    saveIfWanted,
  );
}
