/**
 * Cloud Provider Registry
 *
 * Provides a unified interface for accessing cloud providers.
 * Providers differ only by which deploy tiers they implement, never by
 * standing: Hetzner covers all four, DigitalOcean covers compose/compose-ha/
 * k8s, and Linode/Vultr/Scaleway are compose-only (see assertTierSupported
 * below). No provider is a default or gates a release.
 *
 * To add a new provider:
 * 1. Create a new provider class extending BaseProvider
 * 2. Import and register it in PROVIDERS below
 */

import { BaseProvider } from './base.js';
import { DigitalOceanProvider } from './digitalocean.js';
import { HetznerProvider } from './hetzner.js';
import { LinodeProvider } from './linode.js';
import { ScalewayProvider } from './scaleway.js';
import { VultrProvider } from './vultr.js';

/**
 * Registry of available cloud providers
 * @type {Object<string, typeof BaseProvider>}
 */
export const PROVIDERS = {
  hetzner: HetznerProvider,
  digitalocean: DigitalOceanProvider,
  linode: LinodeProvider,
  vultr: VultrProvider,
  scaleway: ScalewayProvider,
};

/**
 * Get a provider instance
 * @param {string} providerName - Provider name (e.g., 'hetzner')
 * @param {string} apiToken - API token for authentication
 * @returns {BaseProvider} Provider instance
 * @throws {Error} If provider not found
 */
export function getProvider(providerName, apiToken) {
  const Provider = PROVIDERS[providerName.toLowerCase()];

  if (!Provider) {
    const available = Object.keys(PROVIDERS).join(', ');
    throw new Error(`Unknown provider: ${providerName}. Available providers: ${available}`);
  }

  return new Provider(apiToken);
}

/**
 * Get a provider class (not instantiated)
 * @param {string} providerName - Provider name
 * @returns {typeof BaseProvider} Provider class
 * @throws {Error} If provider not found
 */
export function getProviderClass(providerName) {
  const Provider = PROVIDERS[providerName.toLowerCase()];

  if (!Provider) {
    const available = Object.keys(PROVIDERS).join(', ');
    throw new Error(`Unknown provider: ${providerName}. Available providers: ${available}`);
  }

  return Provider;
}

/**
 * Resolve the catalog Provider class for an envConfig-shaped object. THE
 * single home of the `?? 'hetzner'` default for catalog call sites
 * (scale.js, deploy/prompts.js, deploy/effects/k8s-ha.js, ...), which
 * resolve their Provider class through this function instead of
 * hand-rolling the fallback or importing HetznerProvider directly.
 * `buildEnv` (src/lib/iac/index.js) carries NO default of its own — every
 * Pulumi stack-op call site resolves the provider id explicitly (via
 * `providerIdFor` below when a default is appropriate) and passes it in;
 * see that function's JSDoc for the RCA.
 *
 * @param {{provider?: string}|null|undefined} [envConfig] - Any object
 *   carrying an optional `provider` field (a `.vibecarbon.json` environment
 *   entry, an in-flight deploy `config`/`options` object, etc).
 * @returns {typeof BaseProvider} Provider class
 * @throws {Error} If envConfig.provider names an unknown provider
 */
export function providerFor(envConfig) {
  return getProviderClass(envConfig?.provider ?? 'hetzner');
}

/**
 * Resolve the provider id (not the class) for an envConfig-shaped object —
 * the id-flavored twin of `providerFor`, sharing the same single home of the
 * `?? 'hetzner'` default. Command-level token lookups
 * (`resolveProviderToken(providerIdFor(envConfig), ...)`) route through this
 * instead of hand-rolling the fallback inline at each call site.
 *
 * @param {{provider?: string}|null|undefined} [envConfig] - Any object
 *   carrying an optional `provider` field (a `.vibecarbon.json` environment
 *   entry, an in-flight deploy `config`/`options` object, etc).
 * @returns {string} Provider id (e.g. 'hetzner')
 */
export function providerIdFor(envConfig) {
  return envConfig?.provider ?? 'hetzner';
}

/**
 * Guard a provider class against deploying a tier it doesn't support (see
 * `ProviderClass.SUPPORTED_TIERS`, base.js). Enforced at deploy-mode
 * selection (deploy/prompts.js, which also pre-filters the interactive
 * select) and again at orchestrator entry, right after `resolveTier()` —
 * belt-and-suspenders so a flag-supplied mode that skips the interactive
 * select still gets caught.
 *
 * @param {typeof BaseProvider} ProviderClass - Provider class (not instance)
 * @param {string} tier - Tier id from `src/lib/deploy/tier-registry.js`
 *   (`compose` | `compose-ha` | `k8s` | `k8s-ha`)
 * @throws {Error} If `tier` is not in `ProviderClass.SUPPORTED_TIERS`
 */
export function assertTierSupported(ProviderClass, tier) {
  if (ProviderClass.SUPPORTED_TIERS.includes(tier)) return;

  const supported = ProviderClass.SUPPORTED_TIERS.join(', ');
  const k8sHaHetznerOnlyNote =
    ProviderClass !== HetznerProvider && tier === 'k8s-ha' ? ' (k8s-ha is Hetzner-only)' : '';

  throw new Error(
    `${ProviderClass.NAME} does not support the '${tier}' deploy tier. Supported: ${supported}.${k8sHaHetznerOnlyNote}`,
  );
}

/**
 * Resolve a provider's API token, replacing the hand-rolled per-command
 * `process.env.HETZNER_API_TOKEN || ...` idioms with one implementation.
 *
 * Env-only: `process.env[Provider.TOKEN_ENV]`, populated either by the
 * operator's shell/CI or by `bootstrapOperatorEnv` folding the project's
 * `.env.local` into `process.env` at CLI startup (see project.js) — real
 * env always wins. There is no separate credentials-file fallback to
 * choose between, so this takes no options.
 *
 * @param {string} providerId - Provider id (e.g. 'hetzner')
 * @returns {string|null} The resolved token, or null if not found
 * @throws {Error} If providerId is not a known provider
 */
export function resolveProviderToken(providerId) {
  const Provider = getProviderClass(providerId);
  return process.env[Provider.TOKEN_ENV] || null;
}

/**
 * Get an object-storage (S3-compatible) provider instance for the given
 * provider id — the one dispatch point every callsite routes through
 * instead of importing/instantiating a provider's S3 class directly (see
 * hetzner-s3.js's HetznerS3Provider). Resolves the class lazily via the
 * compute provider's `getObjectStorageProviderClass()` static (a dynamic
 * import under the hood — see hetzner.js), then constructs it.
 *
 * Deliberately does nothing but `new Class(...)` here — no other statics
 * are read off the resolved class — so this stays safe to call against a
 * bare-stub mock class (see tests/unit/destroy/state-bucket-delete.test.ts,
 * which replaces HetznerS3Provider with a constructor-only stub via
 * `vi.mock`).
 *
 * @param {string} providerId - Provider id (e.g. 'hetzner')
 * @param {string} accessKeyId - Object-storage access key
 * @param {string} secretAccessKey - Object-storage secret key
 * @param {string} region - Object-storage region
 * @returns {Promise<object>} Object-storage provider instance
 * @throws {Error} If providerId is not a known provider
 */
export async function getObjectStorageProvider(providerId, accessKeyId, secretAccessKey, region) {
  const Provider = getProviderClass(providerId);
  const S3Class = await Provider.getObjectStorageProviderClass();
  return new S3Class(accessKeyId, secretAccessKey, region);
}

/**
 * Resolve the object-storage region for a given provider + candidate
 * region. Thin reader over the provider's S3 class static (e.g.
 * `HetznerS3Provider.resolveS3Region`) — necessarily async because the S3
 * class is only reachable through the lazy `getObjectStorageProviderClass()`
 * import; the compute provider class deliberately mirrors no S3
 * region-map data of its own (see base.js's object-storage dispatch block).
 *
 * @param {string} providerId - Provider id (e.g. 'hetzner')
 * @param {string} region - Candidate deploy region
 * @returns {Promise<string>} Resolved object-storage region
 * @throws {Error} If providerId is not a known provider
 */
export async function resolveS3RegionFor(providerId, region) {
  const Provider = getProviderClass(providerId);
  const S3Class = await Provider.getObjectStorageProviderClass();
  return S3Class.resolveS3Region(region);
}

/**
 * List all available providers with their details
 * @returns {Array<{id: string, name: string, regions: object, serverTypes: object}>}
 */
export function listProviders() {
  return Object.entries(PROVIDERS).map(([id, Provider]) => ({
    id,
    name: Provider.NAME,
    regions: Provider.REGIONS,
    serverTypes: Provider.SERVER_TYPES,
    defaultType: Provider.DEFAULT_TYPE,
    haRegions: Provider.HA_REGIONS,
  }));
}

/**
 * Check if a provider exists
 * @param {string} providerName - Provider name to check
 * @returns {boolean}
 */
export function hasProvider(providerName) {
  return providerName.toLowerCase() in PROVIDERS;
}

/**
 * Validate provider configuration
 * @param {string} providerName - Provider name
 * @param {object} config - Configuration to validate
 * @param {string} [config.region] - Region to validate
 * @param {string} [config.serverType] - Server type to validate
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateProviderConfig(providerName, config) {
  const errors = [];

  const Provider = PROVIDERS[providerName.toLowerCase()];
  if (!Provider) {
    return { valid: false, errors: [`Unknown provider: ${providerName}`] };
  }

  if (config.region && !(config.region in Provider.REGIONS)) {
    const available = Object.keys(Provider.REGIONS).join(', ');
    errors.push(`Invalid region "${config.region}". Available regions: ${available}`);
  }

  if (config.serverType && !(config.serverType in Provider.SERVER_TYPES)) {
    const available = Object.keys(Provider.SERVER_TYPES).join(', ');
    errors.push(`Invalid server type "${config.serverType}". Available types: ${available}`);
  }

  return { valid: errors.length === 0, errors };
}

// Re-export base class and providers for direct access
export { BaseProvider } from './base.js';
export { DigitalOceanProvider } from './digitalocean.js';
export { HetznerProvider } from './hetzner.js';
export { LinodeProvider } from './linode.js';
export { ScalewayProvider } from './scaleway.js';
export { VultrProvider } from './vultr.js';
