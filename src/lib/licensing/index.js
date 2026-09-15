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
 * always wins when it holds a valid v1 key. It honors NOTHING else: a v2
 * key parked there is ignored by getLicense(), because a project key is
 * scoped to one project and the global slot cannot express that. See
 * getLicense() below for the full precedence rule.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spinner } from '../cli/progress.js';
import { c } from '../colors.js';
import { ensureProjectId, loadManifest, manifestExists } from '../project.js';
import { checkLicense } from './check.js';
import { evaluateDeployEntitlement, requiredTierFor } from './entitlement.js';
import { getTier, TIERS } from './tiers.js';
import { printDeployUpsell, printDeployWarning } from './upsell.js';
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
 * Write the project license file: `{ key, activatedAt, source }`, 2-space
 * indent, trailing newline. Tracked in git on purpose (see
 * carbon/_gitignore), so no restrictive file mode.
 *
 * Nothing but the key is load-bearing. The tier, the project id and the
 * subscription's state are all derived from signed material at read time
 * (the key itself, and the verdict the deploy gate fetches), so mirroring
 * them into the file would only create a second, editable copy of facts
 * that are already authoritative elsewhere.
 */
function writeProjectLicenseFile(data, projectDir) {
  const ordered = {
    key: data.key,
    activatedAt: data.activatedAt,
    source: data.source,
  };
  writeFileSync(projectLicensePath(projectDir), `${JSON.stringify(ordered, null, 2)}\n`);
}

/**
 * @param {string|null} [storedProjectId] - When a cryptographically VALID v2
 *   key was found on disk but belongs to a different project, that key's own
 *   project id. Purely informational: the result stays inactive and Graphite,
 *   exactly as if no key existed. It lets the deploy gate say "the stored
 *   key belongs to project a" instead of the generic "no license". See
 *   evaluateDeployEntitlement's 'wrong-project' reason.
 */
function noLicenseResult(storedProjectId = null) {
  return {
    tier: 'graphite',
    ...TIERS.graphite,
    storedProjectId,
    active: false,
    customerId: undefined,
    activatedAt: undefined,
    format: null,
    isLifetime: false,
    projectId: null,
    key: undefined,
    verified: undefined,
    slot: null,
    storedAt: null,
    message: 'No license activated. Using Graphite tier.',
  };
}

function buildLicenseResult({ validation, stored, format, projectId, slot, storedAt }) {
  const tierDef = getTier(validation.tier) || {};
  return {
    tier: validation.tier,
    ...tierDef,
    // Only meaningful on an inactive result — see noLicenseResult().
    storedProjectId: null,
    active: true,
    customerId: validation.customerId ?? stored.customerId,
    activatedAt: stored.activatedAt,
    format,
    isLifetime: format === 'v1',
    projectId: format === 'v2' ? (projectId ?? null) : null,
    // The raw key, because the deploy-time check posts it to prove
    // possession. It is the string that just verified, not whatever else
    // the file happens to hold.
    key: stored.key,
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
 * A v2-shaped key found in the LEGACY slot is ignored outright. That slot
 * is the global, lifetime one; a project key cannot be global, and honoring
 * it there would mean two places to look for the same project's key.
 * listStoredLicenses() still reports it so activate/deactivate can see it.
 *
 * Entitlement fields (`projectId`, `tier`) are ALWAYS derived from the
 * verified `validation`, never from the stored file's own fields. The stored
 * file is untrusted input: only `key` is cryptographically checked, so
 * `activatedAt`/`source` may be read from it for display, but nothing that
 * feeds evaluateDeployEntitlement() may come from anywhere but a key that
 * just verified.
 *
 * @param {{ projectDir?: string, stateDir?: string, publicKeyPem?: string }} [options]
 * @returns {object} License information with tier and features
 */
export function getLicense({ projectDir = process.cwd(), stateDir, publicKeyPem } = {}) {
  const currentProjectId = currentManifestProjectId(projectDir);

  // A valid v2 key found on disk that belongs to SOME OTHER project. It
  // never grants anything (the fall-through below is unchanged), but the
  // deploy gate can name it instead of claiming there is no key at
  // all — the common shape is a `.vibecarbon.license` copied or forked in
  // from another project, where "no license" would be actively misleading.
  // Recorded only for a key that verifies, so a hand-written file can never
  // put arbitrary text on an operator's screen.
  let mismatchedProjectId = null;

  const legacyPath = legacyLicensePath(stateDir);
  const legacyStored = readJsonFileOrNull(legacyPath);
  if (legacyStored?.key) {
    const validation = validateLicenseKey(legacyStored.key, { publicKeyPem });
    // v1 only. A v2 key here is not a mismatch to report either: it is
    // simply in the wrong file, and naming another project would be
    // misleading when the key may well be this project's own.
    if (validation.valid && (validation.format ?? 'v1') === 'v1') {
      return buildLicenseResult({
        validation,
        stored: legacyStored,
        format: 'v1',
        slot: 'legacy',
        storedAt: legacyPath,
      });
    }
  }

  const projectPath = projectLicensePath(projectDir);
  const projectStored = readJsonFileOrNull(projectPath);
  if (projectStored?.key) {
    const validation = validateLicenseKey(projectStored.key, { publicKeyPem });
    if (validation.valid && validation.format === 'v2') {
      const keyProjectId = normalizeProjectId(validation.projectId);
      if (keyProjectId && keyProjectId === currentProjectId) {
        return buildLicenseResult({
          validation,
          stored: projectStored,
          format: 'v2',
          projectId: keyProjectId,
          slot: 'project',
          storedAt: projectPath,
        });
      }
      // Routing is unchanged: this key still grants nothing. The id named
      // comes from the SIGNED key, not the file's own projectId field, so an
      // edited file cannot choose what the upsell prints.
      mismatchedProjectId ??= keyProjectId;
    }
  }

  return noLicenseResult(mismatchedProjectId);
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
      // The raw stored string, whatever it is — validation doesn't carry it,
      // and a caller needs the actual key text (to post it, or to clear the
      // file) rather than just whether it currently verifies.
      key: legacyStored.key,
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
      key: projectStored.key,
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
      activatedAt: new Date().toISOString(),
      source,
    };

    try {
      writeProjectLicenseFile(licenseData, projectDir);
    } catch (error) {
      return { success: false, error: `Failed to save license: ${error.message}` };
    }

    // A v2 key names no tier: which plan this project is on lives on
    // vibecarbon.com and arrives as a signed verdict at deploy time. So
    // there is nothing to look up in tiers.js here, and nothing honest to
    // print beyond "this is a project license".
    return {
      success: true,
      tier: null,
      tierName: 'Project license',
      isLifetime: false,
      format: 'v2',
      projectId: keyProjectId,
      slot: 'project',
      path: projectLicensePath(projectDir),
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

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * How each checkLicense() outcome reads on the spinner: `[message, code]`,
 * where code 1 is clack's failure styling. A cached verdict is a real answer
 * and reads as one; only 'none' (nothing reached, nothing cached) and
 * 'rejected' (the server answered and does not know this key) are failures,
 * and they are different failures, so they say different things.
 */
const CHECK_STOP = {
  live: ['Subscription checked', 0],
  cache: ['Subscription check used the cached verdict', 0],
  none: ['Subscription check skipped', 1],
  rejected: ['Subscription check refused this key', 1],
};

/**
 * Guard for every deploy into a paid mode: verify the project's subscription
 * with vibecarbon.com (or the cached verdict), warn inside grace, refuse
 * after it. Compose deploys and legacy lifetime keys return immediately.
 *
 * This runs on EVERY deploy whose resolved tier costs money, first one and
 * redeploy alike. A subscription is a subscription: the previous rule, which
 * only checked when standing a new environment up, meant a cancelled plan
 * kept shipping releases to production indefinitely.
 *
 * What stays free is unchanged and deliberate: single-server Compose, and
 * backup / restore / failover / scale in every mode. Asking someone for
 * money in the middle of a disaster recovery is the worst possible moment.
 *
 * Exits 1 rather than 0 on refusal: a gated command run without an
 * entitlement is a failed invocation, not a silent no-op. Scripted and CI
 * callers must see a real failure.
 *
 * @param {object} options
 * @param {string} options.deployTier - The resolved deploy tier
 *   (resolveTier(...) from src/lib/deploy/tier-registry.js)
 * @param {object} [options.projectConfig] - The already-loaded project config;
 *   its project id is backfilled when missing (see ensureProjectId)
 * @param {string} [options.projectDir]
 * @param {string} [options.stateDir]
 * @param {Function} [options.fetchImpl] - Injection point for the check client
 * @param {object} [options.env] - Injection point for the check client
 * @param {string} [options.publicKeyPem] - Test-only injection point, threaded
 *   through to getLicense/checkLicense; production callers never pass this.
 * @param {string} [options.now] - 'YYYY-MM-DD', UTC. Only ever compared
 *   against a server-signed periodEnd.
 * @returns {Promise<void>}
 */
export async function requireDeployEntitlement({
  deployTier,
  projectConfig,
  projectDir = process.cwd(),
  stateDir,
  fetchImpl,
  env,
  publicKeyPem,
  now = todayUtc(),
} = {}) {
  const requiredTier = requiredTierFor(deployTier);
  if (requiredTier === 'graphite') return;

  // ensureProjectId() returns whatever case the manifest happens to carry
  // (or projectConfig.projectId verbatim); license.projectId and every
  // verdict.projectId are always lowercase (normalizeProjectId() in
  // getLicense(), .toLowerCase() in checkLicense()/verifyVerdictToken()).
  // Without normalizing here too, a mixed-case manifest id compares unequal
  // to both and false-blocks an otherwise valid, matching license.
  const projectId = normalizeProjectId(ensureProjectId(projectConfig, projectDir));
  const license = getLicense({ projectDir, stateDir, publicKeyPem });

  // Only a v2 project key has a subscription to check. No key at all is
  // decided offline (there is nothing to ask about), and a v1 lifetime key
  // is entitled to everything forever, so neither path touches the network.
  let check = { source: 'none', verdict: null };
  if (license.active && license.format === 'v2') {
    const s = spinner();
    s.start("Checking this project's subscription");
    check = await checkLicense({
      key: license.key,
      projectId,
      stateDir,
      env,
      fetchImpl,
      publicKeyPem,
    });
    const [stopMessage, stopCode] = CHECK_STOP[check.source] ?? CHECK_STOP.none;
    s.stop(stopMessage, stopCode);
  }

  const verdict = evaluateDeployEntitlement({ license, deployTier, projectId, check, now });
  if (verdict.ok) {
    if (verdict.warning)
      printDeployWarning(
        { warning: verdict.warning, projectId, requiredTier: verdict.requiredTier },
        { c },
      );
    return;
  }

  printDeployUpsell(
    { verdict, deployTier, projectName: projectConfig?.projectName, projectId },
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
 * somewhere to plug in. It renders through the same upsell as the deploy
 * gate, so upsell copy exists in exactly one place.
 *
 * @param {string} _commandName - The command that requires a license. Kept
 *   in the signature (cli.js passes it) but not printed: the deploy upsell
 *   frames the refusal around the environment, and there is no second
 *   wording to maintain until a command is actually classified 'paid'.
 */
export function requireLicense(_commandName) {
  const license = getLicense();

  if (license.active) return;

  printDeployUpsell(
    { verdict: { reason: 'no-license', requiredTier: 'fullerene' }, projectId: license.projectId },
    { c },
  );
  process.exit(1);
}

// Re-export tier utilities
export { compareTiers, getTier, TIERS } from './tiers.js';
export { validateLicenseKey } from './validator.js';
