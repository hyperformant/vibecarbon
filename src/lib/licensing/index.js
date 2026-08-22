/**
 * License management for Vibecarbon
 *
 * Handles license storage, retrieval, activation, and validation.
 * Licenses are stored at ~/.vibecarbon/license
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { c } from '../colors.js';
import { isPaidTier } from './gate.js';
import { getTier, TIERS } from './tiers.js';
import { validateLicenseKey } from './validator.js';

// License storage location
const CONFIG_DIR = join(homedir(), '.vibecarbon');
const LICENSE_FILE = join(CONFIG_DIR, 'license');

// Display names for deploy-mode tiers, used only to name the mode in the
// upsell message below — not a tier/pricing definition (that lives in
// tiers.js and is out of scope for this gate).
const TIER_LABELS = {
  'compose-ha': 'Docker Compose HA',
  k8s: 'Kubernetes',
  'k8s-ha': 'Kubernetes HA',
};

/**
 * Ensure the config directory exists
 */
function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Read the stored license file
 * @returns {object|null} License data or null if not found
 */
function _readLicenseFile() {
  if (!existsSync(LICENSE_FILE)) {
    return null;
  }

  try {
    const content = readFileSync(LICENSE_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Write license data to file
 * @param {object} data - License data to store
 */
function writeLicenseFile(data) {
  ensureConfigDir();
  writeFileSync(LICENSE_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Get the current license status
 * @returns {object} License information with tier and features
 */
export function getLicense() {
  const stored = _readLicenseFile();

  // No license file → Graphite tier (free)
  if (!stored?.key) {
    return {
      tier: 'graphite',
      ...TIERS.graphite,
      active: false,
      message: 'No license activated. Using Graphite tier.',
    };
  }

  // Re-validate the stored key
  const validation = validateLicenseKey(stored.key);

  if (!validation.valid) {
    // Stored key is no longer valid (corrupted, etc.)
    return {
      tier: 'graphite',
      ...TIERS.graphite,
      active: false,
      message: `License invalid: ${validation.error}. Reverted to Graphite tier.`,
    };
  }

  const tier = getTier(validation.tier);

  return {
    tier: validation.tier,
    ...tier,
    active: true,
    customerId: validation.customerId || stored.customerId,
    activatedAt: stored.activatedAt,
    isLifetime: true,
    verified: validation.verified,
  };
}

/**
 * Whether a license file exists on disk at all — valid, expired-format,
 * corrupt or otherwise.
 *
 * Distinct from `getLicense().active`, which is false for BOTH "no license"
 * and "license present but does not verify". `deactivate` needs the
 * difference: a stored key that fails verification must still be removable,
 * or a customer whose file got corrupted has no way to clear it and every
 * subsequent `activate` fights a file they cannot delete from the CLI.
 *
 * @returns {boolean}
 */
export function hasStoredLicense() {
  return existsSync(LICENSE_FILE);
}

/**
 * Activate a license key
 * @param {string} key - The license key to activate
 * @returns {object} Activation result
 */
export function activateLicense(key) {
  if (!key || typeof key !== 'string') {
    return { success: false, error: 'License key is required' };
  }

  const validation = validateLicenseKey(key.trim());

  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const licenseData = {
    key: key.trim(),
    tier: validation.tier,
    customerId: validation.customerId,
    activatedAt: new Date().toISOString(),
  };

  try {
    writeLicenseFile(licenseData);
  } catch (error) {
    return { success: false, error: `Failed to save license: ${error.message}` };
  }

  const tier = getTier(validation.tier);

  return {
    success: true,
    tier: validation.tier,
    tierName: tier.displayName,
    features: tier.features,
    isLifetime: true,
  };
}

/**
 * Deactivate (remove) the current license
 * @returns {object} Deactivation result
 */
export function deactivateLicense() {
  if (!existsSync(LICENSE_FILE)) {
    return { success: true, message: 'No license was activated' };
  }

  try {
    unlinkSync(LICENSE_FILE);
    return { success: true, message: 'License deactivated. Using Graphite tier.' };
  } catch (error) {
    return { success: false, error: `Failed to remove license: ${error.message}` };
  }
}

/**
 * Guard function: require any paid license or exit with upgrade message
 * @param {string} commandName - The command that requires a license
 * @param {string} [tier] - The resolved deploy-mode tier that triggered the
 *   gate, when known (see requirePaidTier). Names the specific mode in the
 *   upsell instead of the generic message, and makes clear that
 *   single-server Compose stays free. Omitted by command-wide callers
 *   (e.g. `configure cicd`) that aren't gating a deploy-mode tier.
 */
export function requireLicense(commandName, tier) {
  const license = getLicense();

  if (license.active) return;

  console.log('');
  console.log(`  ${c.warning('License required')}`);
  console.log('');
  if (tier) {
    const tierLabel = TIER_LABELS[tier] || tier;
    const line =
      commandName === 'deploy'
        ? `Single-server Compose deploys are free; ${c.bold(tierLabel)} requires ${c.bold('Fullerene')} — ${c.success('$149 one-time')}.`
        : `${c.bold(commandName)} on ${c.bold(tierLabel)} requires ${c.bold('Fullerene')} — ${c.success('$149 one-time')}.`;
    console.log(`  ${c.dim(line)}`);
  } else {
    console.log(
      `  ${c.dim(`The ${c.bold(commandName)} command requires a license.`)} ${c.dim('(create, up, down, reset, status, and single-server Compose deploys are always free)')}`,
    );
  }
  console.log('');
  console.log(
    `  ${c.bold('Vibecarbon Fullerene')} — ${c.success('$149 one-time')}${c.dim(', all deploy modes, HA, GitOps CI/CD')}`,
  );
  console.log(`  ${c.dim('Agencies & client work: see TERMS or contact us.')}`);
  console.log('');
  console.log(`  ${c.dim('Purchase:')} ${c.info('https://vibecarbon.com/#pricing')}`);
  console.log(`  ${c.dim('Activate:')} ${c.info('vibecarbon activate <key>')}`);
  console.log(`  ${c.dim('Terms:')}    ${c.dim('TERMS.md or https://vibecarbon.com/terms')}`);
  console.log('');
  // Exit non-zero: a gated command run without a license is a failed
  // invocation, not a success. Exiting 0 made scripted/CI `deploy`, `scale`,
  // `backup`, etc. look like they succeeded while doing nothing (the test
  // harnesses had to activate a license to dodge this). Callers and CI now
  // see a real failure.
  process.exit(1);
}

/**
 * Guard function for deploy-mode-gated commands (deploy/backup/restore/
 * failover/scale): single-server Compose is free, every other tier
 * requires a paid license. Fails closed via isPaidTier — an unknown or
 * missing tier is treated as paid.
 *
 * @param {string} commandName - The command that requires a license
 * @param {string} tier - The resolved deploy-mode tier (resolveTier(envConfig))
 */
export function requirePaidTier(commandName, tier) {
  if (!isPaidTier(tier)) return;
  requireLicense(commandName, tier);
}

// Re-export tier utilities
export { compareTiers, getTier, TIERS } from './tiers.js';
export { validateLicenseKey } from './validator.js';
