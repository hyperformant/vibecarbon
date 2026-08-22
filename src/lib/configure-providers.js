/**
 * Providers section of `vibecarbon configure` (see src/configure.js FEATURES[0]).
 *
 * Owner design (see
 * the providers-configure-env-local-credentials plan,
 * §B1/B2/B2a/B3): a single grouped sub-menu for
 * every cloud/DNS credential the CLI needs locally —
 *   Compute (every registered provider) → DNS (Cloudflare) → Docker Hub (info row)
 * — grouped by `PROVIDER_MENU` array order + hint prefixes (@clack/prompts has
 * no native grouped single-select).
 *
 * Compute entries are DERIVED from providers/index.js's `listProviders()` +
 * `getProviderClass()`, so a third compute provider registered there
 * auto-appears here without touching this file — token-only (no S3/Spaces
 * offer, no dedicated guide) unless it also gets an entry in
 * `COMPUTE_GUIDED_MODULES`/`STORAGE_KEYS_BY_PROVIDER` below. Cloudflare (DNS)
 * has no registry entry of its own (it's not a compute/deploy provider), so
 * it's a static menu entry. Docker Hub is a pure informational row — its
 * credentials are operator-shell-level (DOCKER_HUB_USERNAME/TOKEN), outside
 * the project's .env.local store entirely (owner decision) — selecting it
 * never writes anything.
 *
 * Every credential this module resolves is `operator-secret` classified (see
 * config-registry.js) — `configure`'s write loop already derives `localOnly`
 * from `isOperatorKey()`, so returning a flat `{ ENV_KEY: value }` object
 * from `promptProviders` rides the standard write loop with no special
 * persistence contract, exactly like every other configure feature.
 */

import * as p from '@clack/prompts';
import { exitCancelled } from './cli/exit-guard.js';
import { getApiToken as getCloudflareApiToken } from './cloudflare-guided-setup.js';
import { c } from './colors.js';
import { isSecretKey } from './config-registry.js';
import * as digitaloceanGuidedSetup from './digitalocean-guided-setup.js';
import { envSummaryLines } from './env-summary.js';
import * as hetznerGuidedSetup from './hetzner-guided-setup.js';
import * as linodeGuidedSetup from './linode-guided-setup.js';
import { getBootstrappedKeys } from './project.js';
import { getProviderClass, listProviders } from './providers/index.js';
import * as scalewayGuidedSetup from './scaleway-guided-setup.js';
import * as vultrGuidedSetup from './vultr-guided-setup.js';

// Per-id guided-setup module (token guide + S3/Spaces guide + verification).
// Only ids present here get the dedicated guide + storage-key offer; any
// other id in listProviders() still gets a menu entry (see
// buildComputeEntries below) but falls back to genericGetApiToken —
// "auto-appear token-only".
const COMPUTE_GUIDED_MODULES = {
  hetzner: hetznerGuidedSetup,
  digitalocean: digitaloceanGuidedSetup,
  linode: linodeGuidedSetup,
  vultr: vultrGuidedSetup,
  scaleway: scalewayGuidedSetup,
};

// Companion env keys a provider's token flow collects ALONGSIDE the token —
// the multi-var credential seam. Values reference the guided module's own
// EXTRA_ENV_KEYS export (single source of truth) rather than re-listing the
// names here; only providers whose credential is a SET (Scaleway's
// secret-key + access-key + project-id triple) appear.
const EXTRA_ENV_KEYS_BY_PROVIDER = {
  scaleway: scalewayGuidedSetup.EXTRA_ENV_KEYS,
};

// Object-storage env-var pair each compute provider's guided module writes.
// A provider id absent here has no storage-credential concept in this menu.
// Scaleway is DELIBERATELY absent: its single IAM pair signs both compute
// and S3 (audit-verified), so there is no second credential to offer — the
// token flow collects the full triple via EXTRA_ENV_KEYS_BY_PROVIDER above.
const STORAGE_KEYS_BY_PROVIDER = {
  hetzner: ['HETZNER_ACCESS_KEY', 'HETZNER_SECRET_KEY'],
  digitalocean: ['DIGITALOCEAN_ACCESS_KEY', 'DIGITALOCEAN_SECRET_KEY'],
  linode: ['LINODE_ACCESS_KEY', 'LINODE_SECRET_KEY'],
  vultr: ['VULTR_ACCESS_KEY', 'VULTR_SECRET_KEY'],
};

// Display name for the storage-credential pair in menu hints — Hetzner calls
// it "S3", DigitalOcean calls the same concept "Spaces".
const STORAGE_LABEL = {
  hetzner: 'S3',
  digitalocean: 'Spaces',
  linode: 'Object Storage',
  vultr: 'Object Storage',
};

// ============================================================================
// Per-entry summary
// ============================================================================

// Per-entry summary lines for the "already configured" note (promptProviders
// step 3). Hetzner is intentionally token-only in isConfigured (S3 is
// optional there), so its summary calls that out explicitly when unset.
function entrySummaryLines(env, entry) {
  const lines = envSummaryLines(env, entry.envKeys, isSecretKey);
  if (entry.id === 'hetzner' && !(env.HETZNER_ACCESS_KEY && env.HETZNER_SECRET_KEY)) {
    lines.push(c.dim('S3 credentials not set, needed for backups & uploads'));
  }
  return lines;
}

// ============================================================================
// Shell-override warning (A2 provenance)
// ============================================================================

// A key is a "shell override" when it's present in process.env but was NOT
// one bootstrapOperatorEnv() folded in from .env.local this run — i.e. the
// operator's shell/CI exported it, and that value wins over whatever (if
// anything) is saved in the project's store. Post-bootstrap, the provenance
// Set is the only way to tell those two cases apart.
function warnShellOverrides(entry) {
  const bootstrapped = getBootstrappedKeys();
  for (const key of entry.envKeys) {
    if (process.env[key] && !bootstrapped.has(key)) {
      p.log.warn(`${key} is set in your shell and overrides what's saved to .env.local.`);
    }
  }
}

// ============================================================================
// Guided-prompt runners
// ============================================================================

// Fallback for a compute provider registered in providers/index.js with no
// entry in COMPUTE_GUIDED_MODULES — no dedicated guide/verification, just a
// plain env-first token prompt. Keeps "future providers auto-appear
// token-only" true without requiring a guided-setup module to exist first.
async function genericGetApiToken(Provider, _projectName, options = {}) {
  const { force = false } = options;
  if (!force) {
    const envToken = process.env[Provider.TOKEN_ENV];
    if (envToken) return envToken;
  }
  p.log.info(
    `No dedicated setup guide yet for ${Provider.NAME}, paste an existing API token below.`,
  );
  const token = await p.password({
    message: `Paste your ${Provider.NAME} API token here`,
    validate: (v) => {
      if (!v || v.length < 10) return 'API token is required';
      return undefined;
    },
  });
  if (p.isCancel(token)) {
    exitCancelled();
  }
  process.env[Provider.TOKEN_ENV] = token;
  return token;
}

async function runComputeEntry(id, Provider, storageKeys, projectName) {
  const guided = COMPUTE_GUIDED_MODULES[id];
  const token = guided
    ? await guided.getApiToken(projectName, { force: true, save: false })
    : await genericGetApiToken(Provider, projectName, { force: true, save: false });

  const vars = { [Provider.TOKEN_ENV]: token };

  // Multi-var credential seam (the Vultr `region` precedent, one level up):
  // EXTRA_ENV_KEYS_BY_PROVIDER lists the companions a provider's token flow
  // collects with the token — Scaleway's SCALEWAY_ACCESS_KEY +
  // SCALEWAY_DEFAULT_PROJECT_ID travel with SCALEWAY_SECRET_KEY. getApiToken already
  // collected them into process.env (in-process coherence, A2); without
  // this fold they'd be silently dropped, since configure passes
  // save:false and persists only what run() returns.
  for (const key of EXTRA_ENV_KEYS_BY_PROVIDER[id] ?? []) {
    if (process.env[key]) vars[key] = process.env[key];
  }

  if (guided && storageKeys.length === 2) {
    const wantStorage = await p.confirm({
      message: 'Also set up S3/Spaces keys now? (needed for backups & uploads)',
      initialValue: true,
    });
    // Ctrl-C here (isCancel) is treated the same as declining — this is an
    // optional follow-up to a compute token the operator already provided,
    // not a destructive or in-progress operation, so there's nothing to
    // abort back out of. A bare `no` falls through identically.
    if (!p.isCancel(wantStorage) && wantStorage) {
      const creds = await guided.getS3Credentials(projectName, { force: true, save: false });
      vars[storageKeys[0]] = creds.accessKey;
      vars[storageKeys[1]] = creds.secretKey;
      // Optional third value, additive on the {accessKey, secretKey}
      // contract: a guided module returns `region` when the object-storage
      // region is part of the credential rather than derivable from the
      // compute region. Vultr is the only such provider today — its keys
      // are minted per subscription and a subscription is one cluster (see
      // vultr-guided-setup.js). Without this the operator would be
      // prompted for the cluster and have it silently dropped, since
      // configure passes save:false and persists only what run() returns.
      if (creds.region && Provider.S3_REGION_ENV) {
        vars[Provider.S3_REGION_ENV] = creds.region;
      }
    }
  }

  return vars;
}

// ============================================================================
// PROVIDER_MENU
// ============================================================================

function buildComputeEntries() {
  return listProviders().map(({ id }) => {
    const Provider = getProviderClass(id);
    const storageKeys = STORAGE_KEYS_BY_PROVIDER[id] || [];
    // Multi-var credential companions (see runComputeEntry's EXTRA_ENV_KEYS
    // fold) — part of the entry's env surface for summaries + overrides.
    const extraKeys = EXTRA_ENV_KEYS_BY_PROVIDER[id] ?? [];
    const storageLabel = STORAGE_LABEL[id];
    const label = Provider.NAME;

    return {
      id,
      label,
      hint: storageLabel
        ? `Compute · API token + ${storageLabel} credentials`
        : extraKeys.length > 0
          ? 'Compute · API key set (S3 reuses the same keys)'
          : 'Compute · API token',
      envKeys: [Provider.TOKEN_ENV, ...extraKeys, ...storageKeys],
      isConfigured: (env) => {
        const hasToken = Boolean(env[Provider.TOKEN_ENV]);
        // DO's Spaces keys are load-bearing for the tiers it supports (no
        // separate object-storage story), so it's only "configured" with
        // both; Hetzner's S3 is optional (backups/uploads only) — token
        // alone counts, and the summary notes S3 is unset (OWNER-PINNED
        // asymmetry, not an oversight). A provider with EXTRA_ENV_KEYS
        // (Scaleway's triple) is only configured when the WHOLE set is
        // present — a partial triple fails at deploy start by design
        // (buildIacEnv), so advertising it as configured would lie.
        if (id === 'digitalocean') {
          return hasToken && storageKeys.every((k) => Boolean(env[k]));
        }
        return hasToken && extraKeys.every((k) => Boolean(env[k]));
      },
      run: (projectName) => runComputeEntry(id, Provider, storageKeys, projectName),
    };
  });
}

const cloudflareEntry = {
  id: 'cloudflare',
  label: 'Cloudflare',
  hint: 'DNS · API token (Hetzner DNS reuses your Hetzner compute token)',
  envKeys: ['CLOUDFLARE_API_TOKEN'],
  isConfigured: (env) => Boolean(env.CLOUDFLARE_API_TOKEN),
  run: async (projectName) => {
    const token = await getCloudflareApiToken(projectName, { force: true, save: false });
    return { CLOUDFLARE_API_TOKEN: token };
  },
};

// Informational row, not a per-project credential (OWNER-PINNED): Docker Hub
// creds are operator-shell-level, outside the .env.local store entirely.
// isConfigured is always false (nothing here is ever "configured" in the
// project's store) and run() writes nothing.
const dockerHubEntry = {
  id: 'docker-hub',
  label: 'Docker Hub',
  hint: 'Registry · env var only, operator-level (not stored here)',
  envKeys: [],
  isConfigured: () => false,
  run: async () => {
    p.note(
      [
        'Docker Hub credentials are operator-level, not project-level, ',
        'they live in your shell/CI env, never in .env.local.',
        '',
        `Export ${c.bold('DOCKER_HUB_USERNAME')} and ${c.bold('DOCKER_HUB_TOKEN')} in your`,
        'shell (or CI secrets, or tests/.env.e2e for e2e runs).',
        '',
        `${c.bold('Create a token:')} ${c.boldCyanUnderline('https://hub.docker.com/settings/security')}`,
      ].join('\n'),
      'Docker Hub: informational',
    );
    return {};
  },
};

/** Grouped provider menu: Compute → DNS → Docker Hub (info row). */
export const PROVIDER_MENU = [...buildComputeEntries(), cloudflareEntry, dockerHubEntry];

// ============================================================================
// promptProviders — the Providers feature's promptFn (see configure.js)
// ============================================================================

/**
 * `promptFn` for the "Providers" configure feature. Returns a flat
 * `{ ENV_KEY: value, … }` object riding the standard write loop (values are
 * all operator-secret keys, so `configure`'s loop writes them `.env.local`
 * only), or `null` on cancel/decline. Values are never logged.
 *
 * @param {Record<string, string>} env - Current `.env.local` snapshot.
 * @param {{ projectConfig?: { projectName?: string } }} [ctx]
 * @returns {Promise<Record<string, string>|null>}
 */
export async function promptProviders(env, ctx = {}) {
  const projectName = ctx.projectConfig?.projectName;

  const selected = await p.select({
    message: 'Which provider?',
    options: PROVIDER_MENU.map((entry) => ({
      value: entry.id,
      label: entry.isConfigured(env) ? `${entry.label} ${c.success('✓ configured')}` : entry.label,
      hint: entry.hint,
    })),
  });
  if (p.isCancel(selected)) return null;

  const entry = PROVIDER_MENU.find((e) => e.id === selected);

  warnShellOverrides(entry);

  if (entry.isConfigured(env)) {
    const lines = entrySummaryLines(env, entry);
    p.note(
      lines.length ? lines.join('\n') : c.dim('(configured)'),
      `${entry.label}: current settings`,
    );

    const overwrite = await p.confirm({
      message: `${entry.label} is already configured. Re-configure and overwrite these settings?`,
      initialValue: false,
    });
    if (p.isCancel(overwrite) || !overwrite) return null;
  }

  return entry.run(projectName);
}
