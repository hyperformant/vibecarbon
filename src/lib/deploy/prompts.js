/**
 * Deployment Prompts
 * Interactive CLI flow for gathering deployment configuration
 */

import * as p from '@clack/prompts';
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
  resolveDnsToken,
} from '../dns-provider.js';
import { requirePaidTier } from '../licensing/index.js';
import {
  getObjectStorageProvider,
  listProviders,
  providerFor,
  providerIdFor,
  resolveS3RegionFor,
} from '../providers/index.js';
import { deriveProjectBucketName } from '../providers/s3-base.js';
import { validateDomain } from '../validators.js';
import { VERSION } from '../version.js';
import { collectDeployDelta, formatDeployDeltaLines } from './delta.js';
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
const MODE_OPTION_TIER = {
  compose: 'compose',
  'compose-ha': 'compose-ha',
  kubernetes: 'k8s',
  'kubernetes-ha': 'k8s-ha',
};

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
      hint: '1 VPS - Best for startups and internal tools',
    },
    {
      value: 'compose-ha',
      label: 'Docker Compose HA (Auto Failover)',
      hint: '2 VPS - Simple failover without K8s complexity - requires Fullerene',
    },
    {
      value: 'kubernetes',
      label: 'Kubernetes (Auto Scaling)',
      hint: 'k3s + Autoscaling - Best for high-traffic apps - requires Fullerene',
    },
    {
      value: 'kubernetes-ha',
      label: 'Kubernetes HA (Auto Scaling + Failover)',
      hint: 'Multi-region cluster - Maximum availability - requires Fullerene',
    },
  ];
  const options = allOptions.filter((opt) =>
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
export async function gatherDeploymentConfig(args) {
  console.clear();
  printBanner();
  p.intro(`${c.bold('vibecarbon deploy')} ${c.dim(`v${VERSION}`)}`);

  const projectConfig = loadProjectConfig();
  if (!projectConfig) {
    p.log.error('No Vibecarbon project found. Run this command from your project directory.');
    process.exit(1);
  }

  const services = projectConfig.services || {};
  const environment = normalizeEnvName(args.env || 'prod');
  let envConfig = projectConfig.environments?.[environment] || {};
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
  // Re-run the -region guard: a region valid for the provider resolved
  // above (before any selection could happen) may not be valid for the one
  // just chosen — e.g. `-region hel1` is a real Hetzner region but unknown
  // to DigitalOcean.
  assertValidRegionFlag(args, Provider);

  const { deployMode, ha } = await resolveDeployMode(args, envConfig);

  // Gate immediately after the deploy mode is known — for `deploy` this can
  // only happen mid-command (the architecture may be chosen interactively
  // above), so the upsell must live here rather than pre-dispatch. Fires
  // before any region/DNS/credential prompts so an unlicensed operator
  // never gets deep into the flow before hitting the wall.
  requirePaidTier('deploy', resolveTier({ deployMode, ha }));

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

  let secondaryRegion = null;
  if (ha) {
    const standbyDefault = Provider.getDefaultStandbyRegion(region);
    secondaryRegion = args.secondaryRegion || envConfig.secondaryRegion || standbyDefault;
    // HA spans TWO regions, but the prompt above only picks the primary. Ask
    // for the standby too (same-continent partner pre-selected, so the common
    // case is one Enter) — otherwise a non-EU primary like `ash` silently fails
    // over across the Atlantic to `nbg1`. Skipped when set via -standby-region,
    // saved config, or -y.
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
  }

  const apiToken = await Provider.promptApiToken(projectConfig.projectName);
  if (!apiToken) {
    p.log.error('API token required');
    process.exit(1);
  }

  await Provider.fetchServerTypes(apiToken);
  const regionDefaults = Provider.getRegionDefaults(region);

  // Server Type Selection (Streamlined)
  let serverType, masterServerType, workerServerType, supabaseServerType;

  if (isComposeDeploy) {
    // Compose = single-host Supabase stack, so use the medium-tier default
    // (2+ vCPU, 4+ GB) for the whole box. regionDefaults.supabaseType is
    // live-catalog-derived so it avoids retired SKUs like cpx21 in EU.
    serverType = args.serverType || envConfig.serverType || regionDefaults.supabaseType;
    masterServerType = workerServerType = supabaseServerType = serverType;
  } else {
    // `args.serverType` acts as a blanket fallback for all three node roles
    // when a role-specific value isn't set. Matches the compose case's simpler
    // mental model and lets e2e pin the whole cluster to a single known-good
    // SKU. (There is no `-type` deploy flag — see src/deploy.js's SPEC; these
    // arrive from `.vibecarbon.json` / the interactive prompt / a programmatic
    // caller. `scale` is the command that takes `-type`.)
    const blanket = args.serverType || envConfig.serverType;
    masterServerType =
      args.masterServerType || envConfig.masterServerType || blanket || regionDefaults.masterType;
    supabaseServerType =
      args.supabaseServerType ||
      envConfig.supabaseServerType ||
      blanket ||
      regionDefaults.supabaseType;
    workerServerType =
      args.workerServerType || envConfig.workerServerType || blanket || regionDefaults.workerType;
    serverType = workerServerType;
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
    ['supabaseServerType', supabaseServerType],
    ['workerServerType', workerServerType],
  ]) {
    try {
      Provider.assertAmd64ServerType(value, `.vibecarbon.json ${label}`);
    } catch (err) {
      p.log.error(err.message);
      process.exit(1);
    }
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
  const providerId = providerIdFor(envConfig);
  const nativeDnsId = Object.hasOwn(DNS_PROVIDERS, providerId) ? providerId : null;
  let dnsProvider = args.dnsProvider || envConfig.dnsProvider;
  let domain = args.domain || envConfig.domain || null;
  let dnsZoneId = envConfig.dns?.zoneId || null;
  let dnsToken = null;

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
          hint: process.env[DNS_PROVIDERS[id].tokenEnv]
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
        initialValue: nativeDnsId ?? 'manual',
      });
      if (p.isCancel(choice)) {
        exitCancelled();
      }
      dnsProvider = choice;
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
  if (!s3AccessKey) {
    const credentials = await Provider.promptObjectStorageCredentials(projectConfig.projectName);
    s3AccessKey = credentials.accessKey;
    s3SecretKey = credentials.secretKey;
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
  const s3Region =
    args.s3Region ||
    process.env[Provider.S3_REGION_ENV] ||
    envConfig.s3?.region ||
    (await resolveS3RegionFor(providerId, region));

  const s3Provider = await getObjectStorageProvider(providerId, s3AccessKey, s3SecretKey, s3Region);
  // Persisted names first: once an environment has deployed, its bucket
  // names are frozen in .vibecarbon.json and renaming the project (or adding
  // a salt to an old project) must not silently re-point wal-g/Pulumi at
  // buckets that don't exist. Fresh derivations embed the per-project
  // bucketSalt (created projects since 2026-08) to keep names globally
  // unique across customers.
  const bucketName = envConfig.s3?.bucket || deriveProjectBucketName(projectConfig);
  const backupBucketName =
    envConfig.backupS3?.bucket || deriveProjectBucketName(projectConfig, 'backups');
  const backupConfig = {
    schedule: args.backupSchedule || envConfig.backup?.schedule || '0 */6 * * *',
    retentionDays: Number.parseInt(
      args.backupRetentionDays || envConfig.backup?.retentionDays || '30',
      10,
    ),
  };

  const branchName = getBranchName(config.environment);

  // What this run actually ships vs. what's live — identical redeploys, big
  // jumps, and uncommitted edits are all invisible otherwise. Best-effort:
  // empty outside a git repo.
  const deltaLines = formatDeployDeltaLines(collectDeployDelta(envConfig));

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
    supabaseServerType,
    workerServerType,
    minWorkers: args.minWorkers ?? DEFAULT_WORKER_MIN,
    maxWorkers: args.maxWorkers ?? DEFAULT_WORKER_MAX,
    domain,
    dnsProvider,
    dnsZoneId,
    dnsToken,
    s3Config: {
      accessKey: s3AccessKey,
      secretKey: s3SecretKey,
      bucket: bucketName,
      region: s3Region,
      endpoint: s3Provider.getEndpoint(),
    },
    backupS3Config: {
      bucket: backupBucketName,
      region: s3Region,
      endpoint: s3Provider.getEndpoint(),
    },
    backupConfig,
    services,
    branchName,
  };
}
