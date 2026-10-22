/**
 * Deployment Prompts
 * Interactive CLI flow for gathering deployment configuration
 */

import * as p from '@clack/prompts';
import {
  DEFAULT_BACKUP_RETENTION_DAYS,
  DEFAULT_BACKUP_SCHEDULE,
  resolveBackupSettings,
} from '../../../carbon/scripts/render-backup-settings.mjs';
import { exitCancelled, exitDeclined } from '../cli/exit-guard.js';
import { spinner } from '../cli/progress.js';
import { c, printBanner } from '../colors.js';
import { loadProjectConfig } from '../config.js';
import {
  DNS_PROVIDERS,
  findZoneForDomain,
  getDnsGuidedSetup,
  getDnsProvider,
  hasAutomatedDns,
  operatorConfigForDns,
  resolveDnsToken,
} from '../dns-provider.js';
import { resolveEnvSeed } from '../env-identity.js';
import { requireDeployEntitlement } from '../licensing/index.js';
import { readOperatorVar } from '../operator-env.js';
import {
  getObjectStorageProvider,
  listProviders,
  providerFor,
  providerIdFor,
  resolveS3RegionFor,
} from '../providers/index.js';
import {
  assertBucketPin,
  deriveEnvAppBucketName,
  deriveProjectBucketName,
} from '../providers/s3-base.js';
import { ROLE_MIN_RAM_GB, rankLocationsByPrice, rankStandbyLocations } from '../sizing.js';
import { printUpdateNotice } from '../telemetry/update-check.js';
import { validateDomain } from '../validators.js';
import { VERSION } from '../version.js';
import { walgPrefixFor } from '../walg/restore-base.js';
import { composeHaStackOf } from './compose/ha-role-swap.js';
import { collectDeployDelta, formatDeployDeltaLines } from './delta.js';
import { assertOperatorConfig } from './preflight.js';
import { haStacksFrom, k8sStandbyTypes } from './standby-types.js';
import { resolveTier } from './tier-registry.js';
import {
  DEFAULT_WORKER_MAX,
  DEFAULT_WORKER_MIN,
  getBranchName,
  getProviderConfig,
  normalizeEnvName,
} from './utils.js';

// Re-export constants
export { DEFAULT_WORKER_MAX, DEFAULT_WORKER_MIN };

// Deploy-mode select option value → tier-registry id (see tier-registry.js
// TIERS). Used to filter the interactive select to Provider.SUPPORTED_TIERS
// below — the option values themselves predate the tier-id vocabulary
// ('kubernetes'/'kubernetes-ha' vs 'k8s'/'k8s-ha') so they don't line up
// 1:1.
//
// compose-ha stays in the map, but the picker only offers it on a provider
// that has no Kubernetes tier at all — see COMPOSE_HA_OPTION below.
const MODE_OPTION_TIER = {
  compose: 'compose',
  'compose-ha': 'compose-ha',
  kubernetes: 'k8s',
  'kubernetes-ha': 'k8s-ha',
};

// Compose HA is a fully supported deploy mode (existing environments keep
// working, `-mode compose-ha` still resolves, resolveTier still prices it at
// Fullerene, the e2e matrix still runs it) but it is no longer RECOMMENDED:
// Kubernetes HA is the HA answer we lead with, so the picker hides Compose
// HA wherever Kubernetes HA is on offer.
//
// "Wherever" is per provider, not global. Vultr and Scaleway declare
// SUPPORTED_TIERS = ['compose', 'compose-ha'] (no Kubernetes tiers built
// yet), so hiding it unconditionally would leave their operators a
// one-option select and put the only HA mode they can run behind a flag
// they were never shown. On a provider with no Kubernetes tier, Compose HA
// IS the HA answer, so it is listed.
const COMPOSE_HA_OPTION = {
  value: 'compose-ha',
  label: 'Docker Compose HA (Auto Failover)',
  hint: '2 VPS - Simple failover without K8s complexity - Enterprise resiliency, Fullerene',
};

/**
 * The backup schedule and retention this deploy runs with: the flag, else what
 * the environment recorded (envConfig.backup survives between deploys), else
 * the default. A plain `vibecarbon deploy <env>` therefore keeps the recorded
 * values and never resets them.
 *
 * @param {{backupSchedule?: string, backupRetentionDays?: string|number|null}} args
 * @param {{backup?: {schedule?: string, retentionDays?: number|string}}} envConfig
 * @returns {{schedule: string, retentionDays: number}}
 * @throws {Error} on a schedule that is not a 5-field cron expression, or a retention that is not a positive whole number
 */
export function resolveBackupConfig(args, envConfig) {
  const config = {
    schedule: args.backupSchedule || envConfig.backup?.schedule || DEFAULT_BACKUP_SCHEDULE,
    retentionDays: Number.parseInt(
      args.backupRetentionDays || envConfig.backup?.retentionDays || DEFAULT_BACKUP_RETENTION_DAYS,
      10,
    ),
  };
  // Throws on a malformed cron expression or a retention of 0 or NaN.
  return resolveBackupSettings(config);
}

/**
 * Validate `-region` (when supplied) against a resolved provider's REGIONS
 * map. Exported so gatherDeploymentConfig's two call sites — the initial
 * guard (resolved against envConfig's persisted/default provider) and the
 * post-select re-check (after the new environment's provider select below
 * has possibly changed which provider is in play) — share one
 * implementation instead of duplicating the error message.
 * @param {{region?: string|null}} args
 * @param {typeof BaseProvider} Provider
 */
export function assertValidRegionFlag(args, Provider) {
  if (args.region && !Object.hasOwn(Provider.REGIONS, args.region)) {
    p.log.error(
      `Unknown region '${args.region}' for ${Provider.NAME}. Valid: ${Object.keys(Provider.REGIONS).join(', ')}`,
    );
    process.exit(1);
  }
}

/**
 * Resolve which cloud provider drives this deploy. Only TRULY NEW
 * environments show an interactive select — hetzner is first/default in
 * the list (see the cloud-agnostic direction design for provider parity).
 * "New" means neither `provider` NOR `deployMode` has been persisted yet:
 * `deployMode` is the same signal resolveDeployMode itself uses to detect
 * an existing environment, so a LEGACY env from before provider tracking
 * existed (deployMode set, provider never persisted) is correctly treated
 * as existing too — falling back to hetzner byte-identically, not
 * re-prompting an operator whose environment is already deployed.
 * An existing/resumed environment is returned unchanged — switching
 * providers mid-environment isn't supported (region/server-type/S3
 * catalogs are provider-specific, and a switch would orphan already-
 * deployed infra); a `-provider` flag CONFLICTING with the binding errors
 * loudly rather than being silently ignored (matching it proceeds).
 *
 * `-provider <id>` seeds the choice (flags-seed-prompts): interactively it
 * replaces the select; with `-y` it satisfies the explicitness rule. Under
 * `-y` with NO flag, a genuinely new environment ERRORS (exit 1) listing
 * the registry-derived options — the pre-2026-08-08 silent hetzner default
 * was the same silent-default class the de-defaulting audits eliminated in
 * the e2e runner, and the provider is the most consequential binding an
 * environment has (owner decision, PR 2 opening commit).
 *
 * Returns an envConfig-shaped object with `provider` resolved (the input is
 * spread, never mutated, so a selection materializes `provider` onto a
 * fresh object) alongside the matching Provider class, so callers can
 * re-bind both in one assignment and thread them through every
 * Provider-derived prompt/guard that follows (region list, server types, S3
 * region, standby region, the -region re-check, and the deploy-mode
 * select's SUPPORTED_TIERS filter).
 *
 * @param {{yes?: boolean, provider?: string|null}} args
 * @param {{provider?: string, deployMode?: string}} envConfig
 * @returns {Promise<{envConfig: object, Provider: typeof BaseProvider}>}
 */
export async function resolveProvider(args, envConfig) {
  const registryIds = listProviders().map(({ id }) => id);

  // A supplied flag is validated up front — same loud shape either mode.
  if (args.provider && !registryIds.includes(args.provider)) {
    p.log.error(`Unknown provider '${args.provider}'. Valid: ${registryIds.join(', ')}`);
    process.exit(1);
  }

  if (envConfig.provider || envConfig.deployMode) {
    // Existing or legacy environment: the binding wins. A contradicting
    // flag is a user error worth stopping on — silently proceeding on the
    // OTHER provider than the operator named would be worse than exiting.
    const bound = envConfig.provider ?? 'hetzner';
    if (args.provider && args.provider !== bound) {
      p.log.error(
        `This environment is bound to ${bound}; -provider ${args.provider} cannot change it. ` +
          'Provider switching is not supported, create a new environment instead.',
      );
      process.exit(1);
    }
    return { envConfig, Provider: providerFor(envConfig) };
  }

  if (args.provider) {
    const resolvedEnvConfig = { ...envConfig, provider: args.provider };
    return { envConfig: resolvedEnvConfig, Provider: providerFor(resolvedEnvConfig) };
  }

  if (args.yes) {
    p.log.error(
      'New environments require an explicit provider in non-interactive mode. ' +
        `Pass -provider <${registryIds.join('|')}> or run without -y to choose interactively.`,
    );
    process.exit(1);
  }

  const options = listProviders().map(({ id, name }) => ({
    value: id,
    label: name,
  }));

  const selected = await p.select({
    message: 'Cloud provider:',
    options,
    initialValue: 'hetzner',
  });
  if (p.isCancel(selected)) {
    exitCancelled();
  }

  const resolvedEnvConfig = { ...envConfig, provider: selected };
  return { envConfig: resolvedEnvConfig, Provider: providerFor(resolvedEnvConfig) };
}

/**
 * Resolve deploy mode (compose vs kubernetes) based on args and existing config.
 */
export async function resolveDeployMode(args, envConfig) {
  // Respect existing environment's deploy mode + HA setting
  if (envConfig.deployMode) {
    return { deployMode: envConfig.deployMode, ha: envConfig.ha?.enabled || false };
  }

  // Fullerene tier features: resolve from CLI flags. Not filtered by
  // SUPPORTED_TIERS here — an unsupported flag-selected tier passes
  // through and is caught loudly by assertTierSupported() at orchestrator
  // entry instead of silently here.
  if (args.compose && args.ha) return { deployMode: 'compose-ha', ha: true };
  if (args.compose) return { deployMode: 'compose', ha: false };
  if (args.k8s && args.ha) return { deployMode: 'kubernetes', ha: true };
  if (args.k8s) return { deployMode: 'kubernetes', ha: false };
  if (args.ha) return { deployMode: 'kubernetes', ha: true };

  // Non-interactive: default to compose when --yes and no mode flags
  if (args.yes) {
    return { deployMode: 'compose', ha: false };
  }

  // Interactive: Simple choices optimized for robustness. Filtered to
  // tiers the resolved provider actually supports (see providerFor() in
  // lib/providers/index.js) — a no-op filter for Hetzner, which supports
  // all four tiers.
  const Provider = providerFor(envConfig);
  const allOptions = [
    {
      value: 'compose',
      label: 'Docker Compose (Fast)',
      hint: '1 VPS - Best for startups and internal tools - Go live, Graphite',
    },
    {
      value: 'kubernetes',
      label: 'Kubernetes (Auto Scaling)',
      hint: 'k3s + Autoscaling - Best for high-traffic apps - Scale on demand, Graphene',
    },
    {
      value: 'kubernetes-ha',
      label: 'Kubernetes HA (Auto Scaling + Failover)',
      hint: 'Multi-region cluster - Maximum availability - Enterprise resiliency, Fullerene',
    },
  ];
  // Compose HA is offered only when this provider has no Kubernetes tier at
  // all; it slots in right after plain Compose so the list still reads
  // simplest-to-most-capable.
  const supportsK8s = Provider.SUPPORTED_TIERS.some((tier) => tier === 'k8s' || tier === 'k8s-ha');
  const offered = supportsK8s
    ? allOptions
    : [allOptions[0], COMPOSE_HA_OPTION, ...allOptions.slice(1)];

  const options = offered.filter((opt) =>
    Provider.SUPPORTED_TIERS.includes(MODE_OPTION_TIER[opt.value]),
  );

  const mode = await p.select({
    message: 'Deployment architecture:',
    options,
  });

  if (p.isCancel(mode)) {
    exitCancelled();
  }

  if (mode === 'kubernetes-ha') return { deployMode: 'kubernetes', ha: true };
  if (mode === 'compose-ha') return { deployMode: 'compose-ha', ha: true };
  return { deployMode: mode, ha: false };
}

/**
 * Helper: fetch DNS zones with retry on transient network errors
 */
async function fetchZonesWithRetry(fetchFn, providerLabel) {
  const s = spinner();
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    s.start(
      attempt === 1
        ? `Fetching your ${providerLabel} zones`
        : `Retrying zone fetch (attempt ${attempt}/3)`,
    );
    try {
      const zones = await fetchFn();
      s.stop('Zones retrieved');
      return zones;
    } catch (error) {
      lastError = error;
      const isTransient =
        error.message?.includes('fetch failed') ||
        error.message?.includes('ECONNRESET') ||
        error.message?.includes('ETIMEDOUT');
      if (!isTransient || attempt === 3) {
        s.stop(`Failed to fetch ${providerLabel} zones: ${error.message}`);
        throw error;
      }
      s.stop(`Zone fetch failed (${error.message}), retrying...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastError;
}

/**
 * Helper: offer a DNS backend's domain-onboarding flow when zone discovery
 * comes up empty.
 *
 * CAPABILITY SNIFF, never a provider-id branch (the seam rule — see
 * dns-provider.js): a backend whose guided-setup module exports
 * `onboardDomain` can adopt a domain the account does not manage yet. Today
 * that is only Scaleway, whose API answers 403 "domain not found" for every
 * zone and record call on an unowned domain, so its operators would otherwise
 * land on "no zones found → manual DNS" with nothing explaining why. Every
 * other backend creates zones on demand, exports nothing here, and this is a
 * no-op.
 *
 * Never throws, and never changes the caller's control flow: onboarding is an
 * out-of-band, multi-day process (publish an ownership record at the CURRENT
 * DNS host, then repoint nameservers), so the most a deploy can do is start it
 * and print the remaining steps.
 *
 * @param {string} dnsProvider - a DNS_PROVIDERS key
 * @param {string} dnsToken
 * @param {string|null} domain - seeds the suggestion; may be null
 * @returns {Promise<void>}
 */
async function offerDomainOnboarding(dnsProvider, dnsToken, domain) {
  try {
    const guidedSetup = await getDnsGuidedSetup(dnsProvider);
    if (typeof guidedSetup?.onboardDomain !== 'function') return;
    await guidedSetup.onboardDomain(dnsToken, domain);
  } catch (error) {
    p.log.warn(`Could not start domain onboarding: ${error.message}`);
  }
}

/**
 * Helper: select a zone and prompt for domain
 */
async function selectZoneAndDomain(zones, providerLabel, existingDomain) {
  let selectedZone;

  if (existingDomain) {
    const domainParts = existingDomain.split('.');
    for (let i = 0; i < domainParts.length - 1; i++) {
      const possibleZone = domainParts.slice(i).join('.');
      selectedZone = zones.find((z) => z.name === possibleZone);
      if (selectedZone) break;
    }
    if (selectedZone) {
      p.log.info(`Auto-detected zone: ${c.bold(selectedZone.name)}`);
      return { zone: selectedZone, domain: existingDomain };
    }
  }

  if (zones.length === 1) {
    selectedZone = zones[0];
    p.log.info(`Using zone: ${c.bold(selectedZone.name)}`);
  } else {
    const zoneOptions = zones.map((z) => ({ value: z, label: z.name }));
    selectedZone = await p.select({
      message: `Select your ${providerLabel} DNS zone`,
      options: zoneOptions,
    });
    if (p.isCancel(selectedZone)) {
      exitCancelled();
    }
  }

  const suggestedDomain = `app.${selectedZone.name}`;
  const chosenDomain = await p.text({
    message: `Domain name for ${selectedZone.name}`,
    placeholder: suggestedDomain,
    defaultValue: suggestedDomain,
    initialValue: existingDomain || undefined,
    validate: (v) => {
      if (!v) return undefined;
      const domainErr = validateDomain(v);
      if (domainErr) return domainErr;
      if (!v.endsWith(selectedZone.name) && v !== selectedZone.name) {
        return `Domain must be under ${selectedZone.name} (e.g., app.${selectedZone.name})`;
      }
      return undefined;
    },
  });
  if (p.isCancel(chosenDomain)) {
    exitCancelled();
  }

  return { zone: selectedZone, domain: chosenDomain || null };
}

/**
 * Gather full deployment configuration through interactive prompts and CLI args
 */
/**
 * Manual DNS with no domain is the absence of a DNS setup, not a choice worth
 * keeping: it is where a native pick lands when the account has no zones,
 * and manual itself never asks for a domain. Persisted (or carried through
 * destroy's identity record), it skipped the DNS prompt on every later
 * deploy, leaving no way to add a domain. The caller asks again with Manual
 * preselected, so Enter keeps the old behavior. `-y` keeps it silently.
 *
 * @param {{ dnsProvider?: string|null, yes?: boolean }} args
 * @param {string|null|undefined} dnsProvider - the saved (or seeded) pick
 * @param {string|null|undefined} domain
 * @returns {boolean}
 */
export function shouldReaskManualDns(args, dnsProvider, domain) {
  return !args.dnsProvider && dnsProvider === 'manual' && !domain && !args.yes;
}

/** Env names become branch, server and bucket name parts. */
const ENV_NAME_FORMAT = /^[a-z][a-z0-9-]{0,19}$/;

/**
 * Ask which environment to deploy when none was named. A bare
 * `vibecarbon deploy` used to go straight to "prod" without a pause, so a
 * first deploy never offered the choice. `prod` stays the default: Enter
 * accepts it. Skipped for `-y` and non-interactive runs, which keep the
 * silent `prod` default.
 *
 * @param {{ env: string|null, yes: boolean }} args
 * @param {{ isTTY?: boolean }} [opts]
 * @returns {Promise<string|null>} the chosen name, or args.env unchanged
 */
export async function promptEnvironmentName(args, { isTTY = Boolean(process.stdin.isTTY) } = {}) {
  if (args.env || args.yes || !isTTY) return args.env;
  const answer = await p.text({
    message: 'Environment name:',
    initialValue: 'prod',
    defaultValue: 'prod',
    validate: (value) => {
      const name = normalizeEnvName((value || 'prod').trim());
      if (!ENV_NAME_FORMAT.test(name)) {
        return 'Use lowercase letters, numbers and hyphens, starting with a letter (max 20).';
      }
      return undefined;
    },
  });
  if (p.isCancel(answer)) exitCancelled();
  return normalizeEnvName((answer || 'prod').trim());
}

/**
 * One live, cheap, authenticated call (ListBuckets) against the storage
 * endpoint the deploy will use, behind a spinner, with the result in one line.
 *
 * @param {import('../providers/s3-base.js').S3CompatibleProvider} s3Provider
 * @param {string} source  Where the keys came from, as a phrase that reads
 *   after "from" ("your project's .env.local", "what you pasted").
 * @returns {Promise<{verdict: 'ok' | 'rejected' | 'unverified', reason?: string}>}
 */
async function verifyObjectStorageKeys(s3Provider, source) {
  const s = spinner();
  s.start('Verifying S3 credentials');
  const check = await s3Provider.validateCredentials();
  if (check.valid) {
    s.stop('S3 credentials verified');
    return { verdict: 'ok' };
  }
  if (check.rejected) {
    s.stop('S3 credentials rejected', 1);
    const pasted = source === 'what you pasted';
    p.log.warn(
      `S3 at ${s3Provider.getEndpoint()} rejected the keys from ${source}: ${check.error}.` +
        (pasted
          ? ' Paste them again below.'
          : " Stale keys, or keys from another project, are the usual cause. Paste this project's keys below."),
    );
    return { verdict: 'rejected', reason: check.error };
  }
  s.stop(
    `Could not check the S3 credentials (${check.error}), so we'll carry on and they'll be tried when the buckets are created`,
  );
  return { verdict: 'unverified', reason: check.error };
}

/**
 * An environment's persisted app bucket disagrees with the bucket derived for
 * that environment. Built from names only, so it is safe to print.
 */
export class StorageBucketMismatchError extends Error {
  constructor(envName, persisted, expected) {
    super(
      `Environment "${envName}" is configured for bucket "${persisted}", but its app bucket is now "${expected}" (one bucket per environment). ` +
        `To keep using the old bucket, set environments.${envName}.s3.bucketPin to "${persisted}" in .vibecarbon.json. ` +
        `Or copy the objects across and redeploy: for a bucket that kept this environment's files under "${envName}/" run ` +
        `aws s3 sync s3://${persisted}/${envName}/ s3://${expected}/, ` +
        `for one that kept them at the root run aws s3 sync s3://${persisted} s3://${expected}; ` +
        `then clear environments.${envName}.s3.bucket.`,
    );
    this.name = 'StorageBucketMismatchError';
  }
}

/**
 * Where a deploy of `envName` keeps its objects.
 *
 * Each environment has its own long-lived app bucket, derived from the project
 * name, bucketSalt and env name (deriveEnvAppBucketName); `envConfig.s3.bucketPin`
 * pins a different one. A persisted `envConfig.s3.bucket` never overrides this;
 * if it names a different bucket the deploy stops rather than silently
 * re-pointing the app.
 *
 * The backup bucket is per project and keeps its persisted name once an
 * environment has deployed (restore reads backups there; after a destroy the
 * identity seed carries `backupS3`). WAL-G archives under `walgPrefix` in it.
 *
 * `bucket` is the only source of the app bucket name, so a scoped app key
 * (security plan, S3 scoping) targets exactly this bucket.
 *
 * @param {string} envName already validated by ENV_NAME_FORMAT
 * @param {{ s3?: { bucket?: string, bucketPin?: string }, backupS3?: { bucket?: string } }} envConfig
 * @param {{ projectName: string, bucketSalt?: string }} projectConfig
 * @returns {{ bucket: string, backupBucket: string, walgPrefix: string }}
 */
export function resolveEnvStorage(envName, envConfig, projectConfig) {
  const pin = envConfig.s3?.bucketPin;
  const bucket =
    pin !== undefined && pin !== null
      ? assertBucketPin(
          pin,
          `bucketPin for environment "${envName}"`,
          `environments.${envName}.s3.bucketPin`,
        )
      : deriveEnvAppBucketName(projectConfig, envName);
  const persisted = envConfig.s3?.bucket;
  if (persisted && persisted !== bucket) {
    throw new StorageBucketMismatchError(envName, persisted, bucket);
  }
  return {
    bucket,
    backupBucket: envConfig.backupS3?.bucket || deriveProjectBucketName(projectConfig, 'backups'),
    walgPrefix: walgPrefixFor(projectConfig.projectName, envName),
  };
}

/**
 * The optional per-environment "app storage key" paste, for a provider whose
 * keys can only be made in its console (`appKeyScoping: 'paste-fence'`,
 * Hetzner; security plan R2). Skipping is a fine answer: the env stays on the
 * `shared` tier, where the app holds the deploy's own key. Pasting moves it to
 * `fenced` on the next deploy: the app gets this key, and every other
 * vibecarbon bucket in the project denies it.
 *
 * @param {{ environment: string, projectName?: string }} args
 * @returns {Promise<{ accessKey: string, secretKey: string } | null>} null when skipped
 */
export async function promptAppStorageKey({ environment, projectName }) {
  p.note(
    [
      `${c.bold('1.')} Open: ${c.boldCyanUnderline('https://console.hetzner.cloud/projects')}`,
      `${c.dim('   └─')} Pick ${c.info(projectName || 'your-project')} → ${c.info('Security')} → ${c.info('S3 credentials')}`,
      '',
      `${c.bold('2.')} Click ${c.boldCyan('Generate credentials')}`,
      `${c.dim('   └─')} Description: ${c.info(`"${projectName || 'vibecarbon'}-${environment}-app"`)}`,
      '',
      `${c.bold('3.')} Copy both values ${c.dim('(the secret is only shown once)')} and paste them below.`,
      '',
      c.dim(`This must be a NEW key, not the one deploys use. ${environment}'s app gets it,`),
      c.dim('and every other vibecarbon bucket in the project denies it: the Pulumi state,'),
      c.dim("the backups, and the other environments' uploads."),
      c.dim('It can still list bucket names and use buckets vibecarbon does not manage.'),
    ].join('\n'),
    `App storage key for ${environment}`,
  );
  const paste = await p.confirm({
    message: `Paste an app storage key for ${environment}? (skip to keep sharing the deploy key)`,
    initialValue: true,
  });
  if (p.isCancel(paste)) exitCancelled();
  if (!paste) return null;
  const accessKey = await p.text({
    message: 'Access key',
    validate: (v) => (v?.trim() ? undefined : 'paste the access key, or press ctrl-c to stop'),
  });
  if (p.isCancel(accessKey)) exitCancelled();
  const secretKey = await p.password({
    message: 'Secret key',
    validate: (v) => (v?.trim() ? undefined : 'paste the secret key, or press ctrl-c to stop'),
  });
  if (p.isCancel(secretKey)) exitCancelled();
  return { accessKey: String(accessKey).trim(), secretKey: String(secretKey).trim() };
}

/** How a role reads in the out-of-stock refusal. */
const ROLE_LABEL = {
  compose: 'compose',
  master: 'k8s master',
  db: 'k8s database',
  worker: 'k8s worker',
};

/**
 * The refusal for a role whose default is null: nothing among the provider's
 * candidates for it is orderable in `region` right now (P7, ruling B6). The
 * deploy fails closed rather than falling to a pricier type, and names the
 * cheapest same-continent regions (at most 3) that can place every role of
 * this deploy, each with its monthly price (servers plus billed IPv4).
 *
 * For an HA standby (`options.standby`), `region` is the standby location:
 * the line says so, the primary's location is never offered as a standby
 * (`options.exclude`), each role needs at least the RAM of the primary node
 * it stands in for (`options.minRamGb` in the line; nearby locations are
 * ranked by what the standby would place there, `rankStandbyLocations` over
 * `options.primaryTypes`), and the hint names `-standby-region`.
 *
 * @param {object} Provider - the provider class
 * @param {string} region
 * @param {string} role - the role with nothing orderable
 * @param {string[]} roles - every role this deploy places
 * @param {string} environment - for the command in the hint
 * @param {{standby?: boolean, exclude?: string[], minRamGb?: Record<string, number>,
 *   primaryTypes?: Record<string, string|undefined>}} [options]
 * @returns {{line: string, hint: string}} one error line, and the next step
 *   with its command on its own line
 */
export function unorderableDefaultRefusal(
  Provider,
  region,
  role,
  roles,
  environment,
  { standby = false, exclude = [], minRamGb = {}, primaryTypes = {} } = {},
) {
  const label = `${standby ? 'standby ' : ''}${ROLE_LABEL[role] ?? role}`;
  const cause =
    `no ${label} server with ${minRamGb[role] ?? ROLE_MIN_RAM_GB[role]} GB+ RAM ` +
    `is orderable in ${region} right now`;
  const continent = Provider.REGION_CONTINENT?.[region];
  const neighbours = Object.keys(Provider.REGIONS).filter(
    (r) =>
      r !== region &&
      !exclude.includes(r) &&
      continent &&
      Provider.REGION_CONTINENT?.[r] === continent,
  );
  const nearby = (
    standby
      ? rankStandbyLocations(Provider, neighbours, roles, primaryTypes)
      : rankLocationsByPrice(Provider, neighbours, roles)
  ).slice(0, 3);
  if (nearby.length === 0) {
    return standby
      ? {
          line: `${cause}, and no other standby location on this continent has one either`,
          hint:
            '-server-type sizes the primary and its standby together; name one that is in ' +
            `stock in both locations, and deploy again:\n  vibecarbon deploy ${environment} -server-type <type>`,
        }
      : {
          line: `${cause}, and none is orderable in the other regions on this continent either`,
          hint: `name a server type that is in stock, and deploy again:\n  vibecarbon deploy ${environment} -server-type <type>`,
        };
  }
  const options = nearby.map(({ location, monthly, types }) => {
    const price = monthly === null ? '' : ` $${monthly.toFixed(2)}/mo`;
    return `${location} (${roles.map((r) => types[r]).join(' + ')}${price})`;
  });
  return {
    line: `${cause}; orderable nearby: ${options.join(', ')}`,
    hint: `deploy in ${nearby[0].location}, the cheapest of those, with:\n  vibecarbon deploy ${environment} ${standby ? '-standby-region' : '-region'} ${nearby[0].location}`,
  };
}

export async function gatherDeploymentConfig(args) {
  console.clear();
  printBanner();
  printUpdateNotice();
  p.intro(`${c.bold('vibecarbon deploy')} ${c.dim(`v${VERSION}`)}`);

  const projectConfig = loadProjectConfig();
  if (!projectConfig) {
    p.log.error('No Vibecarbon project found. Run this command from your project directory.');
    process.exit(1);
  }

  const services = projectConfig.services || {};
  const environment = normalizeEnvName(args.env || 'prod');
  // A name that was destroyed seeds from the identity destroy recorded
  // (placement, domain, DNS, backup bucket, sizing) — a rebuild or a region
  // move starts from what the env was instead of a hand-typed block. Flags
  // still override (args.X wins in every chain below), and the record is
  // cleared once the deploy finalizes (orchestrator).
  const seed = resolveEnvSeed(projectConfig, environment);
  let envConfig = seed.envConfig;
  if (seed.fromDestroyed) {
    const when = seed.fromDestroyed.destroyedAt
      ? ` (destroyed ${seed.fromDestroyed.destroyedAt.slice(0, 10)})`
      : '';
    p.log.info(
      `Re-using the settings of the previous ${c.bold(environment)} environment${when}: ` +
        `${[envConfig.domain, envConfig.region, envConfig.serverType].filter(Boolean).join(', ')}. ` +
        'Flags such as -region / -server-type override them.',
    );
  }
  const resuming = envConfig.status === 'deploying';

  // Resolved once per flow — see providerFor() in lib/providers/index.js.
  let Provider = providerFor(envConfig);
  assertValidRegionFlag(args, Provider);

  if (resuming) {
    p.log.info(`Resuming previous deployment to ${c.bold(environment)}...`);
  } else {
    p.log.info(`Deploying to environment: ${c.bold(environment)}`);
  }

  // Cloud provider selection (new environments only — see resolveProvider's
  // doc). Runs BEFORE resolveDeployMode below so its SUPPORTED_TIERS filter
  // (selecting DigitalOcean must hide the k8s modes) sees the provider just
  // chosen here, not the hetzner default the two bindings above assumed.
  ({ envConfig, Provider } = await resolveProvider(args, envConfig));

  // Gate 2a (operator config hygiene, spec §3): the provider is now known —
  // refuse a MALFORMED (never a merely-absent — `presence: false`) token
  // before promptApiToken() below verifies it against the live provider
  // API and fetchServerTypes() queries it further. A missing token is
  // exactly what that prompt is for; a garbled one reaching a real API call
  // is what this gate exists to head off (see preflight.js's
  // assertOperatorConfig doc for why this can't wait for
  // checkDeployPrerequisites, deep in the orchestrator).
  assertOperatorConfig([`provider:${providerIdFor(envConfig)}`], { presence: false });

  // Re-run the -region guard: a region valid for the provider resolved
  // above (before any selection could happen) may not be valid for the one
  // just chosen — e.g. `-region hel1` is a real Hetzner region but unknown
  // to DigitalOcean.
  assertValidRegionFlag(args, Provider);

  const { deployMode, ha } = await resolveDeployMode(args, envConfig);

  // Gate immediately after the deploy mode is known, before any region, DNS
  // or credential prompt. Every deploy into a paid mode checks the project's
  // subscription (live, or the cached verdict); Compose returns at once.
  const deployTier = resolveTier({ deployMode, ha });
  await requireDeployEntitlement({ deployTier, projectConfig });

  const isComposeDeploy = deployMode === 'compose' || deployMode === 'compose-ha';
  const config = {
    environment,
    // envConfig carries the provider chosen by a prior (possibly resumed)
    // deploy of this environment; 'hetzner' is the only default today.
    provider: envConfig.provider ?? 'hetzner',
    ha,
    observability: services.observability || false,
    deployMode,
  };
  const providerConfig = getProviderConfig(config.provider);
  // Provider class already resolved above — config.provider is the same
  // `envConfig.provider ?? 'hetzner'` fallback providerFor() applied to
  // envConfig there, so no need to re-resolve it.

  // Direct vs Push prompt (compose only, when CI/CD is configured).
  //
  // K8s is local-first via deployK3s — no prompt, no choice. Compose with
  // CI/CD offers both paths: direct is faster (~30s warm) but bypasses
  // the CI review workflow; push is slower (~3 min) but goes through GHA
  // and deploys via Flux.
  //
  // Skipped when:
  //   - -y / --yes — non-interactive auto-detects (push if CI configured,
  //     direct otherwise)
  //   - CI/CD not configured — direct is the only option anyway
  //
  // Mutates args.direct / args.push so the downstream resolveBuildMode call
  // in orchestrator picks up the selection. Pre-PR-5 the operator could
  // also set these via CLI flags; PR 5 dropped that surface — this prompt
  // is now the only path to the override.
  if (isComposeDeploy && !args.yes && !resuming) {
    const { ciAvailable } = await import('../ci-setup.js');
    if (ciAvailable()) {
      const choice = await p.select({
        message: 'How would you like to deploy?',
        options: [
          {
            value: 'direct',
            label: 'Direct',
            hint: 'Build here and push to the server (~30s warm, no CI)',
          },
          {
            value: 'push',
            label: 'Push',
            hint: 'Commit + GitHub Actions build & deploy (~3 min)',
          },
        ],
        initialValue: 'direct',
      });
      if (p.isCancel(choice)) {
        exitCancelled();
      }
      if (choice === 'direct') args.direct = true;
      else if (choice === 'push') args.push = true;
    }
  }

  // Region Selection (Aggressive Default)
  // args.region validity against Provider.REGIONS was already checked above
  // — region here is either unset, a known-good -region value, a
  // previously-persisted (already-valid) envConfig.region, or the provider
  // default.
  let region = args.region || envConfig.region || Provider.DEFAULT_REGION; // Nuremberg as default robust region
  if (!args.region && !envConfig.region && !args.yes) {
    const regionOptions = Object.entries(providerConfig.regions).map(([id, name]) => ({
      value: id,
      label: `${id} - ${name}`,
    }));
    region = await p.select({
      message: 'Region:',
      options: regionOptions,
      initialValue: region,
    });
    if (p.isCancel(region)) {
      exitCancelled();
    }
  }

  const apiToken = await Provider.promptApiToken(projectConfig.projectName);
  if (!apiToken) {
    p.log.error('API token required');
    process.exit(1);
  }

  // Server types resolve (and the ARM guard runs) straight after the API
  // token, which the live catalog needs, and BEFORE the object-storage keys.
  // The guard needs nothing from S3, and a persisted ARM type in
  // .vibecarbon.json is a dead end: refuse it before asking the operator for
  // (and live-verifying) secrets the run can never use. Nothing here prompts
  // but the HA standby question, whose default is priced from this catalog.
  await Provider.fetchServerTypes(apiToken);
  const regionDefaults = Provider.getRegionDefaults(region);

  // Server Type Selection (Streamlined)
  let serverType, masterServerType, workerServerType, dbServerType;

  if (isComposeDeploy) {
    // Compose = the whole stack on one host: the compose role's default (the
    // cheapest orderable 4 GB+ type in the region, src/lib/sizing.js). Never
    // the k8s db default, which is a 2 GB role.
    serverType = args.serverType || envConfig.serverType || regionDefaults.composeType;
    masterServerType = workerServerType = dbServerType = serverType;
  } else {
    // `args.serverType` acts as a blanket fallback for all three node roles
    // when a role-specific value isn't set. Matches the compose case's simpler
    // mental model and lets e2e pin the whole cluster to a single known-good
    // SKU. (`args.serverType` comes from `deploy -server-type <id>` or a
    // programmatic caller; the per-role values from `.vibecarbon.json` / the
    // interactive prompt. `scale` is the command that takes `-type`.)
    const blanket = args.serverType || envConfig.serverType;
    masterServerType =
      args.masterServerType || envConfig.masterServerType || blanket || regionDefaults.masterType;
    dbServerType = args.dbServerType || envConfig.dbServerType || blanket || regionDefaults.dbType;
    workerServerType =
      args.workerServerType || envConfig.workerServerType || blanket || regionDefaults.workerType;
    serverType = workerServerType;
  }

  // A role default is null when nothing among the provider's candidates for
  // it is orderable in this region right now. Refuse here, before the S3 keys
  // are asked for and before anything is created: a null type would otherwise
  // reach Pulumi and the env record (ruling B6: fail closed, never a pricier
  // fallback). Only a default can be null; a flag or a recorded type is kept.
  const roleTypes = isComposeDeploy
    ? [['compose', serverType]]
    : [
        ['master', masterServerType],
        ['db', dbServerType],
        ['worker', workerServerType],
      ];
  const unorderable = roleTypes.find(([, type]) => !type);
  if (unorderable) {
    const { line, hint } = unorderableDefaultRefusal(
      Provider,
      region,
      unorderable[0],
      roleTypes.map(([role]) => role),
      environment,
    );
    p.log.error(line);
    p.log.info(hint);
    process.exit(1);
  }

  // Guard every resolved type. The region defaults and any option list are
  // amd64 by construction (the provider catalogs drop ARM and
  // lib/server-types.js filters the builders), so what this actually catches is
  // an operator-authored `.vibecarbon.json` — the one path that reaches Pulumi
  // without passing a prompt. vibecarbon is x86-64 only; see
  // src/lib/deploy/platform.js. Failing here is deliberate: a deploy is
  // attended and the config is one edit away, so it's better than silently
  // provisioning ARM hardware the app image cannot exec on.
  for (const [label, value] of [
    ['serverType', serverType],
    ['masterServerType', masterServerType],
    ['dbServerType', dbServerType],
    ['workerServerType', workerServerType],
  ]) {
    try {
      Provider.assertAmd64ServerType(value, `.vibecarbon.json ${label}`);
    } catch (err) {
      p.log.error(err.message);
      process.exit(1);
    }
  }

  // HA standby location and size. Both come from the role picker
  // (src/lib/sizing.js) over the live catalog, so this runs after the fetch
  // above: the default is the cheapest same-continent partner where every
  // standby role is orderable (DigitalOcean nyc3 pairs with tor1, since the
  // static nyc3 -> sfo3 pair sold none of the default sizes on 2026-10-22).
  // The prompt pre-selects it, so the common case is one Enter; it is skipped
  // when set via -standby-region, saved config, or -y.
  let secondaryRegion = null;
  // k8s-ha: the standby's resolved types, for the skeleton save to record.
  let standbyServerTypes;
  if (ha) {
    // The k8s-ha pilot-light standby places a master and a db, no worker.
    const standbyRoles = isComposeDeploy ? ['compose'] : ['master', 'db'];
    const primaryTypes = isComposeDeploy
      ? { compose: serverType }
      : { master: masterServerType, db: dbServerType };
    // The default must fit the primary's types without shrinking them.
    const standbyDefault = Provider.getDefaultStandbyRegion(region, standbyRoles, primaryTypes);
    secondaryRegion = args.secondaryRegion || envConfig.secondaryRegion || standbyDefault;
    if (!args.secondaryRegion && !envConfig.secondaryRegion && !args.yes) {
      const standbyOptions = Object.entries(providerConfig.regions)
        .filter(([id]) => id !== region)
        .map(([id, name]) => ({ value: id, label: `${id} - ${name}` }));
      secondaryRegion = await p.select({
        message: 'Standby region (HA failover target):',
        options: standbyOptions,
        initialValue: standbyDefault,
      });
      if (p.isCancel(secondaryRegion)) {
        exitCancelled();
      }
    }

    // The standby's own sizes, resolved as the HA effects resolve them: a
    // type on record for the standby is kept (a redeploy never resizes or
    // refuses an existing env; deploy -server-type re-sizes both, and then
    // the record gives way). Otherwise each primary type where the standby
    // location stocks it, else that role's cheapest stocked pick of at least
    // the same RAM. Null means nothing fits there: refuse now, before the S3
    // keys or any write, naming the cheapest nearby locations other than the
    // primary (B6).
    let resolved;
    if (isComposeDeploy) {
      const standbyOnRecord =
        !args.serverType &&
        (envConfig.servers ?? []).some(
          (sv) =>
            sv?.serverType &&
            composeHaStackOf(sv, projectConfig.projectName, environment) === 'standby',
        );
      resolved = {
        compose: standbyOnRecord
          ? undefined
          : Provider.resolveServerTypeForRegion(serverType, secondaryRegion, 'compose'),
      };
    } else {
      const standby = k8sStandbyTypes({
        Provider,
        standbyRegion: secondaryRegion,
        primary: { master: masterServerType, db: dbServerType, worker: workerServerType },
        recorded: haStacksFrom(envConfig)?.standby,
        requested: Boolean(args.serverType),
      });
      resolved = { master: standby.masterServerType, db: standby.dbServerType };
      // The worker is only recorded when something is stocked for it.
      standbyServerTypes = {
        masterServerType: standby.masterServerType,
        dbServerType: standby.dbServerType,
        ...(standby.workerServerType ? { workerServerType: standby.workerServerType } : {}),
      };
    }
    const unplaceable = standbyRoles.find((role) => resolved[role] === null);
    if (unplaceable) {
      const minRamGb = Object.fromEntries(
        standbyRoles.map((role) => [
          role,
          Math.max(ROLE_MIN_RAM_GB[role], Provider.SERVER_TYPES?.[primaryTypes[role]]?.ram ?? 0),
        ]),
      );
      const { line, hint } = unorderableDefaultRefusal(
        Provider,
        secondaryRegion,
        unplaceable,
        standbyRoles,
        environment,
        { standby: true, exclude: [region], minRamGb, primaryTypes },
      );
      p.log.error(line);
      p.log.info(hint);
      process.exit(1);
    }
  }

  // Object-storage keys come right after the API token. Only the prompt-free
  // server-type resolution and, for HA, the standby question above sit
  // between them: on every provider both are generated in the same console
  // visit (Hetzner: project, then Security, then API tokens / S3
  // credentials), so asking for them back to back saves the operator a
  // second trip before the DNS questions.
  const providerId = providerIdFor(envConfig);

  // S3 (Standardized)
  let s3AccessKey = args.s3AccessKey || envConfig.s3?.accessKey;
  let s3SecretKey = args.s3SecretKey || null;
  // Env-var override (Provider.S3_REGION_ENV — e.g. HETZNER_STORAGE_REGION,
  // DIGITALOCEAN_STORAGE_REGION) sits between explicit CLI flag and project
  // config so operators can route the Pulumi-state + backup buckets to a
  // different object-storage region during a regional incident without
  // editing .vibecarbon.json. Mirrors TOKEN_ENV's role for the cloud API.
  // Surfaced after 2026-04-29 nbg1 OS degradation killed both HA scenarios
  // on Pulumi backend ops (lock delete 503, history save 504, checkpoint
  // read conn-reset) — polymorphic over Provider since B6 so it applies to
  // every registered provider, not just Hetzner.
  let s3CredentialSource = args.s3AccessKey ? 'the -s3-access-key flag' : '.vibecarbon.json';
  // deferSave: pasted keys are written to .env.local only after the S3 check
  // below accepts them (or cannot reach the endpoint), never before. A wrong
  // pair saved up front came straight back on the next run.
  let saveS3Credentials = null;
  if (!s3AccessKey) {
    const credentials = await Provider.promptObjectStorageCredentials(projectConfig.projectName, {
      deferSave: true,
    });
    s3AccessKey = credentials.accessKey;
    s3SecretKey = credentials.secretKey;
    s3CredentialSource = credentials.source ?? 'what you pasted';
    saveS3Credentials = credentials.save ?? null;
  }

  // ORDERING IS LOAD-BEARING: resolved AFTER promptObjectStorageCredentials,
  // whose guided flows write Provider.S3_REGION_ENV into process.env when
  // the operator supplies a region (in-process coherence — see the guided
  // setups' identical A2 comments). Vultr made this ordering observable
  // (2026-08-08, caught in the configure-wiring review): its storage keys
  // are per-SUBSCRIPTION, so the cluster the operator pastes during the
  // prompt IS the only region those keys authenticate to — resolving
  // beforehand froze the compute-region default and produced an opaque
  // auth failure against the wrong cluster. Account-wide-key providers
  // (Hetzner/DO/Linode) are indifferent to this order.
  const resolveStorageRegion = async () =>
    args.s3Region ||
    readOperatorVar(Provider.S3_REGION_ENV).value ||
    envConfig.s3?.region ||
    (await resolveS3RegionFor(providerId, region));
  let s3Region = await resolveStorageRegion();
  let s3Provider = await getObjectStorageProvider(providerId, s3AccessKey, s3SecretKey, s3Region);

  // Verify the keys NOW, the way the API token was just verified. Wrong keys
  // used to sail through here and fail at bucket creation with a message
  // about the bucket name (excitingai, 2026-10-16). Only a rejection by S3
  // itself re-asks; an endpoint we cannot reach is not proof the keys are
  // wrong, so that case says so and carries on.
  for (;;) {
    const { verdict, reason } = await verifyObjectStorageKeys(s3Provider, s3CredentialSource);
    if (verdict !== 'rejected') {
      if (saveS3Credentials) await saveS3Credentials();
      break;
    }
    if (args.yes || !process.stdin.isTTY) {
      p.log.error(
        `Deploy stopped before creating anything: S3 rejected the keys from ${s3CredentialSource} ` +
          `(${reason}). ` +
          `Put this project's keys in ${Provider.OBJECT_STORAGE_ENV.join(' and ') || 'the provider key variables'} ` +
          '(in .env.local or your shell), then deploy again.',
      );
      process.exit(1);
    }
    const again = await Provider.promptObjectStorageCredentials(projectConfig.projectName, {
      force: true,
      deferSave: true,
    });
    s3AccessKey = again.accessKey;
    s3SecretKey = again.secretKey;
    s3CredentialSource = again.source ?? 'what you pasted';
    saveS3Credentials = again.save ?? null;
    s3Region = await resolveStorageRegion();
    s3Provider = await getObjectStorageProvider(providerId, s3AccessKey, s3SecretKey, s3Region);
  }

  // DNS provider selection — registry-derived from DNS_PROVIDERS.
  //
  // Default is the compute provider's NATIVE DNS backend when one is
  // registered: the compute API token already administers that cloud's DNS
  // zones (same-token rule), so there is zero extra setup — one account,
  // zero to deployed. Cloudflare (and any other backend) is a cross-cloud
  // opt-in whose token resolves from its own env var, with Cloudflare's
  // guided onboarding when absent. Manual skips DNS automation entirely.
  //
  // Under --yes the native default applies without prompting. The
  // pre-convergence behavior defaulted to *Hetzner DNS on every compute
  // provider* — a cross-cloud surprise on DO/Linode/Vultr deploys (their
  // operators rarely hold a HETZNER_API_TOKEN, so the deploy warmed up
  // against a zone lookup that could never succeed).
  const nativeDnsId = Object.hasOwn(DNS_PROVIDERS, providerId) ? providerId : null;
  let dnsProvider = args.dnsProvider || envConfig.dnsProvider;
  let domain = args.domain || envConfig.domain || null;
  let dnsZoneId = envConfig.dns?.zoneId || null;
  let dnsToken = null;

  const reaskManualDns = shouldReaskManualDns(args, dnsProvider, domain);
  if (reaskManualDns) dnsProvider = null;

  if (!dnsProvider) {
    if (args.yes) {
      dnsProvider = nativeDnsId ?? 'manual';
    } else {
      const nativeOption = nativeDnsId
        ? [
            {
              value: nativeDnsId,
              label: `${DNS_PROVIDERS[nativeDnsId].name} (native)`,
              hint: 'Uses your compute API token (no extra setup)',
            },
          ]
        : [];
      const crossCloudOptions = Object.keys(DNS_PROVIDERS)
        .filter((id) => id !== nativeDnsId)
        .sort()
        .map((id) => ({
          value: id,
          label: DNS_PROVIDERS[id].name,
          hint: readOperatorVar(DNS_PROVIDERS[id].tokenEnv).value
            ? 'API token found'
            : `Needs ${DNS_PROVIDERS[id].tokenEnv}`,
        }));
      const choice = await p.select({
        message: 'DNS provider:',
        options: [
          ...nativeOption,
          ...crossCloudOptions,
          {
            value: 'manual',
            label: 'Manual',
            hint: 'Skip DNS automation: configure records yourself',
          },
        ],
        initialValue: reaskManualDns ? 'manual' : (nativeDnsId ?? 'manual'),
      });
      if (p.isCancel(choice)) {
        exitCancelled();
      }
      dnsProvider = choice;
    }
  }

  // Gate 2b (operator config hygiene, spec §3): the DNS pick is now final —
  // refuse a MALFORMED DNS credential (`presence: false`, same reasoning as
  // Gate 2a) before resolveDnsToken/the DNS backend's own guided setup
  // (getApiToken) or a live zone lookup reads it. operatorConfigForDns
  // mirrors resolveDnsToken's own same-token comparison exactly: nothing to
  // check for the same-token-rule case (already covered by Gate 2a's
  // provider scope), the DNS backend's own scope when it holds its own
  // credential (Cloudflare), or just its one token env var for a
  // cross-cloud NATIVE DNS pick (e.g. DigitalOcean compute + Hetzner DNS) —
  // never the whole sibling provider's scope, which would wrongly demand
  // that OTHER cloud's S3/object-storage keys too.
  {
    const dns = operatorConfigForDns(dnsProvider, providerId);
    if (dns.scopes.length > 0 || dns.keys.length > 0) {
      assertOperatorConfig(dns.scopes, { presence: false, keys: dns.keys });
    }
  }

  // Token resolution: same-token rule first (native DNS = compute token),
  // then the row's env var. A cross-cloud pick with no token gets the
  // provider's guided onboarding when it has one (Cloudflare's deep-linked
  // guide + verify-and-retry loop + save offer — the same module the
  // Providers menu (B2) drives), else a fall back to manual. Under --yes we
  // cannot prompt; fall back to manual with a clear warning.
  if (hasAutomatedDns(dnsProvider)) {
    const dnsRow = DNS_PROVIDERS[dnsProvider];
    dnsToken = resolveDnsToken(dnsProvider, {
      computeProviderId: providerId,
      computeToken: apiToken,
    });
    if (!dnsToken) {
      const guidedSetup = args.yes ? null : await getDnsGuidedSetup(dnsProvider);
      if (guidedSetup) {
        dnsToken = await guidedSetup.getApiToken(projectConfig.projectName);
      }
      if (!dnsToken) {
        p.log.warn(
          `${dnsRow.name} selected but no API token found. Set ${dnsRow.tokenEnv} in your ` +
            "shell or the project's .env.local. Falling back to manual DNS.",
        );
        dnsProvider = 'manual';
      }
    }
  }

  if (hasAutomatedDns(dnsProvider) && dnsToken) {
    const dnsRow = DNS_PROVIDERS[dnsProvider];
    const { getZones } = await getDnsProvider(dnsProvider);

    // Auto-discover the zone when a domain is already configured
    // (config-driven re-deploys land here without prompting).
    if (domain && !dnsZoneId) {
      try {
        // Label-boundary + most-specific match (see findZoneForDomain) —
        // the old find(endsWith) was order-dependent when an account held
        // both a parent zone and a delegated child.
        const zone = findZoneForDomain(await getZones(dnsToken), domain);
        if (zone) dnsZoneId = String(zone.id);
      } catch {
        /* ignore — the interactive path below (or manual fallback) covers it */
      }
    }

    // Interactive zone-and-domain selection when no domain is configured
    // yet. Skipped under --yes (only the auto-discovery above runs).
    if (!args.yes && !dnsZoneId) {
      try {
        const zones = await fetchZonesWithRetry(() => getZones(dnsToken), dnsRow.name);
        if (zones.length === 0) {
          // A backend that can adopt an unmanaged domain gets to say so before
          // we write the account off as empty (capability sniff — see
          // offerDomainOnboarding). It cannot finish inside this run either
          // way, so the fallback below is unconditional.
          await offerDomainOnboarding(dnsProvider, dnsToken, domain);
          p.log.warn(`No ${dnsRow.name} zones found on this account. Falling back to manual DNS.`);
          dnsProvider = 'manual';
        } else {
          const result = await selectZoneAndDomain(zones, dnsRow.name, domain);
          domain = result.domain;
          dnsZoneId = String(result.zone.id);
        }
      } catch (err) {
        p.log.warn(`${dnsRow.name} unavailable (${err.message}). Falling back to manual DNS.`);
        dnsProvider = 'manual';
      }
    }
  }

  // A mid-flow fallback to manual leaves no automated-DNS credentials behind.
  if (!hasAutomatedDns(dnsProvider)) {
    dnsToken = null;
    dnsZoneId = null;
  }

  let storage;
  try {
    storage = resolveEnvStorage(config.environment, envConfig, projectConfig);
  } catch (err) {
    if (!(err instanceof StorageBucketMismatchError)) throw err;
    p.log.error(err.message);
    process.exit(1);
  }
  // Before Pulumi creates anything: a malformed schedule or a retention of 0 or
  // NaN stops the deploy here, not at the k8s apply after the servers exist.
  let backupConfig;
  try {
    backupConfig = resolveBackupConfig(args, envConfig);
  } catch (err) {
    p.log.error(`deploy: ${err.message}`);
    process.exit(1);
  }

  const branchName = getBranchName(config.environment);

  // What this run actually ships vs. what's live — identical redeploys, big
  // jumps, and uncommitted edits are all invisible otherwise. Best-effort:
  // empty outside a git repo.
  const deltaLines = formatDeployDeltaLines(collectDeployDelta(envConfig), {
    sha: c.boldCyan,
    count: c.success,
    subject: c.dim,
    warn: c.warning,
    alert: c.danger,
  });

  if (!args.yes && !resuming) {
    // note() pads the box with a blank row top and bottom itself — leading or
    // trailing newlines in the content double them up.
    p.note(
      [
        `Env:      ${c.bold(config.environment)}`,
        `Region:   ${c.bold(region)}${ha ? ` + ${secondaryRegion}` : ''}`,
        `Stack:    ${c.bold(isComposeDeploy ? 'Docker Compose' : 'Kubernetes (k3s)')}`,
        `Domain:   ${c.bold(domain || 'None')}`,
        ...(deltaLines.length ? ['', ...deltaLines] : []),
      ].join('\n'),
      'Deployment Summary',
    );

    const confirmed = await p.confirm({ message: 'Proceed?', initialValue: true });
    // Ctrl-C/ESC and an explicit "no" are different answers: one is an
    // interrupt, the other a considered refusal. Both stop the run.
    if (p.isCancel(confirmed)) {
      exitCancelled();
    }
    if (!confirmed) {
      exitDeclined();
    }
  } else if (deltaLines.length) {
    // --yes and resumed runs skip the interactive summary, but the operator
    // (and the deploy log) still deserve to see what this run ships.
    p.note(deltaLines.join('\n'), 'Changes');
  }

  return {
    projectConfig,
    envConfig,
    environment,
    resuming,
    config,
    apiToken,
    region,
    secondaryRegion,
    serverType,
    masterServerType,
    dbServerType,
    workerServerType,
    ...(standbyServerTypes ? { standbyServerTypes } : {}),
    minWorkers: args.minWorkers ?? DEFAULT_WORKER_MIN,
    maxWorkers: args.maxWorkers ?? DEFAULT_WORKER_MAX,
    domain,
    dnsProvider,
    dnsZoneId,
    dnsToken,
    s3CredentialSource,
    s3Config: {
      accessKey: s3AccessKey,
      secretKey: s3SecretKey,
      bucket: storage.bucket,
      // Carried so the post-deploy save keeps the pin (E6 escape hatch).
      ...(envConfig.s3?.bucketPin && { bucketPin: envConfig.s3.bucketPin }),
      // The persisted Pulumi state bucket, so resolveStateBucketName's first
      // rule (the env's PERSISTED name) answers. Deriving it fresh on a
      // redeploy picks an EMPTY bucket wherever an older CLI derived it
      // differently (main derived from `<project>-<salt>-storage-<sgen>`),
      // and Pulumi would then plan from empty state. A destroyed env's seed
      // never carries it (env-identity), so a rebuild derives as before.
      ...(envConfig.s3?.stateBucket && { stateBucket: envConfig.s3.stateBucket }),
      walgPrefix: storage.walgPrefix,
      region: s3Region,
      endpoint: s3Provider.getEndpoint(),
    },
    backupS3Config: {
      bucket: storage.backupBucket,
      region: s3Region,
      endpoint: s3Provider.getEndpoint(),
    },
    backupConfig,
    services,
    branchName,
  };
}
