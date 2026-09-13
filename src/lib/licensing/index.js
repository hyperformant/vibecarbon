/**
 * License management for Vibecarbon
 *
 * Handles license storage, retrieval, activation, and validation.
 *
 * Two storage slots:
 *   - Legacy: ~/.vibecarbon/license (or `stateDir`/license when overridden
 *     for tests). One v1 key, global across every project on the machine.
 *     Unchanged path, permissions, and JSON shape from before per-project
 *     licensing.
 *   - Project: <projectDir>/.vibecarbon.license. A v2 key scoped to one
 *     project (matched by the UUID in .vibecarbon.json), committed to git
 *     so everyone working on the project shares it.
 *
 * The legacy slot is strictly broader (global, never expires), so it
 * always wins when it holds a valid v1 key — see getLicense() below for
 * the full precedence rule.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { c } from '../colors.js';
import { ensureProjectId, loadManifest, manifestExists } from '../project.js';
import { VERSION } from '../version.js';
import { evaluateEntitlement } from './entitlement.js';
import { getReleaseDate } from './release-date.js';
import { getTier, TIERS } from './tiers.js';
import { printProvisionUpsell } from './upsell.js';
import { validateLicenseKey } from './validator.js';

// Default license storage location. Overridable per-call via `stateDir` so
// tests never touch the real ~/.vibecarbon.
const CONFIG_DIR = join(homedir(), '.vibecarbon');
const PROJECT_LICENSE_FILENAME = '.vibecarbon.license';

function resolveStateDir(stateDir) {
  return stateDir || CONFIG_DIR;
}

function legacyLicensePath(stateDir) {
  return join(resolveStateDir(stateDir), 'license');
}

function projectLicensePath(projectDir) {
  return join(projectDir || process.cwd(), PROJECT_LICENSE_FILENAME);
}

/**
 * Ensure the state directory exists
 */
function ensureStateDir(stateDir) {
  const dir = resolveStateDir(stateDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Read and parse a JSON file, tolerating a missing or corrupt file by
 * returning null rather than throwing — a stored license that fails to
 * parse must degrade to "no license", never crash the CLI.
 * @returns {object|null}
 */
function readJsonFileOrNull(path) {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Normalize a project id for case-insensitive comparison: trim, lowercase,
 * and (defensively) reflow a bare 32-hex-character id into standard
 * 8-4-4-4-12 UUID hyphenation. Every projectId Vibecarbon generates
 * (randomUUID() in create.js) is already hyphenated; this only guards
 * against an id that lost its hyphens some other way.
 * @param {string|null|undefined} id
 * @returns {string|null}
 */
function normalizeProjectId(id) {
  if (!id || typeof id !== 'string') {
    return null;
  }
  const trimmed = id.trim().toLowerCase();
  if (/^[0-9a-f]{32}$/.test(trimmed)) {
    return [
      trimmed.slice(0, 8),
      trimmed.slice(8, 12),
      trimmed.slice(12, 16),
      trimmed.slice(16, 20),
      trimmed.slice(20),
    ].join('-');
  }
  return trimmed;
}

/**
 * The current project's id, from .vibecarbon.json, normalized — or null
 * when projectDir isn't a Vibecarbon project, has no projectId yet, OR its
 * manifest is unreadable/malformed JSON. loadManifest() does an unguarded
 * JSON.parse; before per-project licensing, getLicense() never touched the
 * manifest at all, so a corrupt .vibecarbon.json must still degrade to "no
 * project" here rather than crash license resolution for everyone,
 * including the legacy-key path, which has nothing to do with the
 * manifest.
 */
function currentManifestProjectId(projectDir) {
  if (!manifestExists(projectDir)) {
    return null;
  }
  try {
    return normalizeProjectId(loadManifest(projectDir)?.projectId);
  } catch {
    return null;
  }
}

/**
 * Write the legacy license file. Byte-compatible with the pre-B3 shape:
 * `{ key, tier, customerId, activatedAt }`, no trailing newline, mode 0600.
 */
function writeLegacyLicenseFile(data, stateDir) {
  ensureStateDir(stateDir);
  writeFileSync(legacyLicensePath(stateDir), JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Write the project license file: `{ key, format: "v2", tier, customerId,
 * projectId, paidThrough, activatedAt, source }`, 2-space indent, trailing
 * newline. Tracked in git on purpose (see carbon/_gitignore), so no
 * restrictive file mode.
 */
function writeProjectLicenseFile(data, projectDir) {
  const ordered = {
    key: data.key,
    format: 'v2',
    tier: data.tier,
    customerId: data.customerId,
    projectId: data.projectId,
    paidThrough: data.paidThrough,
    activatedAt: data.activatedAt,
    source: data.source,
  };
  writeFileSync(projectLicensePath(projectDir), `${JSON.stringify(ordered, null, 2)}\n`);
}

function noLicenseResult() {
  return {
    tier: 'graphite',
    ...TIERS.graphite,
    active: false,
    customerId: undefined,
    activatedAt: undefined,
    format: null,
    isLifetime: false,
    projectId: null,
    paidThrough: null,
    verified: undefined,
    slot: null,
    storedAt: null,
    message: 'No license activated. Using Graphite tier.',
  };
}

function buildLicenseResult({
  validation,
  stored,
  format,
  projectId,
  paidThrough,
  slot,
  storedAt,
}) {
  const tierDef = getTier(validation.tier) || {};
  return {
    tier: validation.tier,
    ...tierDef,
    active: true,
    customerId: validation.customerId ?? stored.customerId,
    activatedAt: stored.activatedAt,
    format,
    isLifetime: format === 'v1',
    projectId: format === 'v2' ? (projectId ?? null) : null,
    paidThrough: format === 'v2' ? (paidThrough ?? null) : null,
    verified: validation.verified,
    slot,
    storedAt,
  };
}

/**
 * Get the current license status.
 *
 * Precedence: the legacy v1 key wins outright when present and valid — it
 * is global and never expires, strictly broader than any project key.
 * Failing that, the project key wins when present, valid, `format: "v2"`,
 * and its `projectId` matches this project's manifest. Otherwise, no
 * license (Graphite).
 *
 * A v2-shaped key found in the LEGACY slot (validator.js defaults to
 * format 'v1' until B4's parser ships) is never treated as global — it
 * only counts for its own project, same as the project slot.
 *
 * @param {{ projectDir?: string, stateDir?: string, publicKeyPem?: string }} [options]
 * @returns {object} License information with tier and features
 */
export function getLicense({ projectDir = process.cwd(), stateDir, publicKeyPem } = {}) {
  const currentProjectId = currentManifestProjectId(projectDir);

  const legacyPath = legacyLicensePath(stateDir);
  const legacyStored = readJsonFileOrNull(legacyPath);
  if (legacyStored?.key) {
    const validation = validateLicenseKey(legacyStored.key, { publicKeyPem });
    if (validation.valid) {
      const format = validation.format ?? 'v1';
      if (format === 'v1') {
        return buildLicenseResult({
          validation,
          stored: legacyStored,
          format,
          slot: 'legacy',
          storedAt: legacyPath,
        });
      }
      const keyProjectId = normalizeProjectId(validation.projectId);
      if (keyProjectId && keyProjectId === currentProjectId) {
        return buildLicenseResult({
          validation,
          stored: legacyStored,
          format,
          projectId: keyProjectId,
          paidThrough: validation.paidThrough,
          slot: 'legacy',
          storedAt: legacyPath,
        });
      }
    }
  }

  const projectPath = projectLicensePath(projectDir);
  const projectStored = readJsonFileOrNull(projectPath);
  if (projectStored?.key && projectStored.format === 'v2') {
    const storedProjectId = normalizeProjectId(projectStored.projectId);
    if (storedProjectId && storedProjectId === currentProjectId) {
      const validation = validateLicenseKey(projectStored.key, { publicKeyPem });
      if (validation.valid) {
        return buildLicenseResult({
          validation,
          stored: projectStored,
          format: 'v2',
          projectId: storedProjectId,
          paidThrough: projectStored.paidThrough ?? null,
          slot: 'project',
          storedAt: projectPath,
        });
      }
    }
  }

  return noLicenseResult();
}

/**
 * Every stored license file, legacy and project, re-validated — for
 * activate/deactivate UX (listing what's currently on disk, valid or not).
 * @param {{ projectDir?: string, stateDir?: string }} [options]
 * @returns {Array<object>} `{ slot, path, projectId, valid, ...validation }`
 */
export function listStoredLicenses({ projectDir = process.cwd(), stateDir } = {}) {
  const entries = [];

  const legacyPath = legacyLicensePath(stateDir);
  const legacyStored = readJsonFileOrNull(legacyPath);
  if (legacyStored) {
    const validation = legacyStored.key
      ? validateLicenseKey(legacyStored.key)
      : { valid: false, error: 'No key stored' };
    entries.push({
      slot: 'legacy',
      path: legacyPath,
      projectId: normalizeProjectId(validation.projectId ?? legacyStored.projectId),
      valid: validation.valid,
      ...validation,
    });
  }

  const projectPath = projectLicensePath(projectDir);
  const projectStored = readJsonFileOrNull(projectPath);
  if (projectStored) {
    const validation = projectStored.key
      ? validateLicenseKey(projectStored.key)
      : { valid: false, error: 'No key stored' };
    entries.push({
      slot: 'project',
      path: projectPath,
      projectId: normalizeProjectId(validation.projectId ?? projectStored.projectId),
      valid: validation.valid,
      ...validation,
    });
  }

  return entries;
}

/**
 * Whether a license file exists on disk at all, in EITHER slot — valid,
 * expired-format, corrupt or otherwise.
 *
 * Distinct from `getLicense().active`, which is false for BOTH "no license"
 * and "license present but does not verify". `deactivate` needs the
 * difference: a stored key that fails verification must still be removable,
 * or a customer whose file got corrupted has no way to clear it and every
 * subsequent `activate` fights a file they cannot delete from the CLI.
 *
 * @param {{ projectDir?: string, stateDir?: string }} [options]
 * @returns {boolean}
 */
export function hasStoredLicense({ projectDir = process.cwd(), stateDir } = {}) {
  return existsSync(legacyLicensePath(stateDir)) || existsSync(projectLicensePath(projectDir));
}

/**
 * Activate a license key. Routes by the key's validated format: a v1 key
 * goes to the legacy (global) slot, unchanged from before per-project
 * licensing. A v2 key requires a Vibecarbon project in `projectDir` whose
 * manifest projectId matches the key's — otherwise rejected, since a
 * project key activated in the wrong directory would silently do nothing.
 *
 * @param {string} key - The license key to activate
 * @param {{ projectDir?: string, stateDir?: string, publicKeyPem?: string, source?: string }} [options]
 * @returns {object} Activation result
 */
export function activateLicense(
  key,
  { projectDir = process.cwd(), stateDir, publicKeyPem, source = 'manual' } = {},
) {
  if (!key || typeof key !== 'string') {
    return { success: false, error: 'License key is required' };
  }

  const validation = validateLicenseKey(key.trim(), { publicKeyPem });

  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const format = validation.format ?? 'v1';

  if (format === 'v2') {
    if (!manifestExists(projectDir)) {
      return {
        success: false,
        error: 'Run vibecarbon activate inside the project this key was issued for.',
      };
    }

    // currentManifestProjectId() re-checks manifestExists and swallows a
    // corrupt/unreadable manifest into null (never throws), so a malformed
    // .vibecarbon.json here just falls into the mismatch error below
    // instead of crashing activation.
    const currentProjectId = currentManifestProjectId(projectDir);
    const keyProjectId = normalizeProjectId(validation.projectId);

    if (!keyProjectId || keyProjectId !== currentProjectId) {
      return {
        success: false,
        error: `This key is for project ${validation.projectId}; run vibecarbon activate inside that project.`,
      };
    }

    const licenseData = {
      key: key.trim(),
      tier: validation.tier,
      customerId: validation.customerId,
      projectId: keyProjectId,
      paidThrough: validation.paidThrough ?? null,
      activatedAt: new Date().toISOString(),
      source,
    };

    try {
      writeProjectLicenseFile(licenseData, projectDir);
    } catch (error) {
      return { success: false, error: `Failed to save license: ${error.message}` };
    }

    const tier = getTier(validation.tier);

    return {
      success: true,
      tier: validation.tier,
      tierName: tier.displayName,
      features: tier.features,
      isLifetime: false,
      format: 'v2',
      projectId: keyProjectId,
      paidThrough: licenseData.paidThrough,
      slot: 'project',
    };
  }

  const licenseData = {
    key: key.trim(),
    tier: validation.tier,
    customerId: validation.customerId,
    activatedAt: new Date().toISOString(),
  };

  try {
    writeLegacyLicenseFile(licenseData, stateDir);
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
    format: 'v1',
    slot: 'legacy',
  };
}

/**
 * Deactivate (remove) the current license.
 *
 * Default precedence removes the project file when present, else the
 * legacy file — the project slot is the one usually being managed from
 * inside a project directory. `all: true` removes both, regardless of
 * precedence.
 *
 * @param {{ projectDir?: string, stateDir?: string, all?: boolean }} [options]
 * @returns {object} `{ success, removed: string[], message?, error? }`
 */
export function deactivateLicense({ projectDir = process.cwd(), stateDir, all = false } = {}) {
  const legacyPath = legacyLicensePath(stateDir);
  const projectPath = projectLicensePath(projectDir);

  if (all) {
    const removed = [];
    for (const path of [projectPath, legacyPath]) {
      if (existsSync(path)) {
        try {
          unlinkSync(path);
          removed.push(path);
        } catch (error) {
          return { success: false, error: `Failed to remove license: ${error.message}`, removed };
        }
      }
    }
    return {
      success: true,
      removed,
      message: removed.length
        ? 'License deactivated. Using Graphite tier.'
        : 'No license was activated',
    };
  }

  const target = existsSync(projectPath) ? projectPath : existsSync(legacyPath) ? legacyPath : null;

  if (!target) {
    return { success: true, removed: [], message: 'No license was activated' };
  }

  try {
    unlinkSync(target);
    return {
      success: true,
      removed: [target],
      message: 'License deactivated. Using Graphite tier.',
    };
  } catch (error) {
    return { success: false, error: `Failed to remove license: ${error.message}`, removed: [] };
  }
}

/**
 * The verdict seam.
 *
 * Everything the gate decides funnels through this one call, so a later task
 * can insert an online refresh for a v2 key whose paid-through date has
 * lapsed (fetch a renewed key, re-store it, re-evaluate) without touching
 * any call site. `fetchImpl` and `env` are threaded here for exactly that
 * and are unused today: the evaluation is currently pure.
 *
 * @param {object} args
 * @returns {Promise<object>} an evaluateEntitlement() verdict
 */
async function resolveVerdict({ license, deployTier, projectId, releaseDate }) {
  return evaluateEntitlement({ license, deployTier, projectId, releaseDate });
}

/**
 * Guard: require an entitlement to PROVISION `deployTier` for this project,
 * or print the upsell and exit non-zero.
 *
 * Only provisioning consults the license. Redeploying, backing up,
 * restoring, failing over and scaling an environment that already exists
 * never call this — see src/lib/licensing/gate.js for why, and
 * isProvisioningDeploy() in src/lib/deploy/prompts.js for how `deploy`
 * decides which of the two it is doing.
 *
 * Exits 1 rather than 0 on refusal: a gated command run without an
 * entitlement is a failed invocation, not a silent no-op. Scripted and CI
 * callers must see a real failure.
 *
 * @param {object} options
 * @param {string} options.deployTier - The resolved deploy tier being provisioned
 *   (resolveTier(...) from src/lib/deploy/tier-registry.js)
 * @param {object} [options.projectConfig] - The already-loaded project config;
 *   its project id is backfilled when missing (see ensureProjectId)
 * @param {string} [options.projectDir]
 * @param {string} [options.stateDir]
 * @param {Function} [options.fetchImpl] - Reserved for the refresh seam above
 * @param {object} [options.env] - Reserved for the refresh seam above
 * @returns {Promise<void>}
 */
export async function requireProvisionEntitlement({
  deployTier,
  projectConfig,
  projectDir = process.cwd(),
  stateDir,
  fetchImpl,
  env,
} = {}) {
  const projectId = ensureProjectId(projectConfig, projectDir);
  const license = getLicense({ projectDir, stateDir });
  const releaseDate = getReleaseDate();

  const verdict = await resolveVerdict({
    license,
    deployTier,
    projectId,
    releaseDate,
    projectDir,
    stateDir,
    fetchImpl,
    env,
  });

  if (verdict.ok) return;

  printProvisionUpsell(
    {
      verdict,
      deployTier,
      projectName: projectConfig?.projectName,
      projectId,
      version: VERSION,
      releaseDate,
    },
    { c },
  );
  process.exit(1);
}

/**
 * Guard for the command-wide 'paid' classification in gate.js: require any
 * active license, or print the upsell and exit non-zero.
 *
 * No command is classified 'paid' today, but the cli.js pre-dispatch
 * chokepoint stays wired up so a future command-wide paid feature has
 * somewhere to plug in. It renders through the same upsell as the
 * provisioning gate, so upsell copy exists in exactly one place.
 *
 * @param {string} commandName - The command that requires a license
 */
export function requireLicense(commandName) {
  const license = getLicense();

  if (license.active) return;

  printProvisionUpsell(
    {
      commandName,
      projectId: license.projectId,
      version: VERSION,
      releaseDate: getReleaseDate(),
    },
    { c },
  );
  process.exit(1);
}

// Re-export tier utilities
export { compareTiers, getTier, TIERS } from './tiers.js';
export { validateLicenseKey } from './validator.js';
