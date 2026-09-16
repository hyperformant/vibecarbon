/**
 * License management for Vibecarbon
 *
 * One storage slot: <projectDir>/.vibecarbon.license, JSON
 * `{ key, activatedAt, source }`, committed to git so everyone on the project
 * shares it. The key carries no project: which project it is bound to lives
 * on vibecarbon.com, set by `activate` (POST /bind) and cleared by the
 * emailed link `deactivate` requests (POST /release). Only `key` is
 * cryptographically checked; the other fields are display-only.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spinner } from '../cli/progress.js';
import { c } from '../colors.js';
import { ensureProjectId, loadManifest, manifestExists } from '../project.js';
import { bindLicense, requestRelease } from './bind.js';
import { checkLicense } from './check.js';
import { evaluateDeployEntitlement, requiredTierFor } from './entitlement.js';
import { TIERS } from './tiers.js';
import { printDeployUpsell, printDeployWarning } from './upsell.js';
import { validateLicenseKey } from './validator.js';

const LICENSE_FILENAME = '.vibecarbon.license';

export function licensePath(projectDir = process.cwd()) {
  return join(projectDir, LICENSE_FILENAME);
}

/**
 * Read and parse a JSON file, tolerating a missing or corrupt file by
 * returning null rather than throwing — a stored license that fails to
 * parse must degrade to "no license", never crash the CLI.
 * @returns {object|null}
 */
function readJsonFileOrNull(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeProjectId(id) {
  return typeof id === 'string' && id.trim() ? id.trim().toLowerCase() : null;
}

/** The current project's id from .vibecarbon.json, or null (no/corrupt manifest never throws). */
function currentManifestProjectId(projectDir) {
  if (!manifestExists(projectDir)) return null;
  try {
    return normalizeProjectId(loadManifest(projectDir)?.projectId);
  } catch {
    return null;
  }
}

/**
 * Write the license file: `{ key, activatedAt, source }`, 2-space indent,
 * trailing newline. Tracked in git on purpose (see carbon/_gitignore), so no
 * restrictive file mode.
 *
 * Nothing but the key is load-bearing. The tier, the bound project and the
 * subscription's state are all derived from signed material at read time
 * (the key itself, and the verdict the deploy gate fetches), so mirroring
 * them into the file would only create a second, editable copy of facts that
 * are already authoritative elsewhere.
 */
function writeLicenseFile(data, projectDir) {
  writeFileSync(licensePath(projectDir), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o644 });
}

function noLicenseResult() {
  return {
    tier: 'graphite',
    ...TIERS.graphite,
    active: false,
    key: undefined,
    licenseId: null,
    activatedAt: undefined,
    storedAt: null,
    message: 'No license activated. Using Graphite tier.',
  };
}

/**
 * The stored key, re-verified. Active means "a key that verifies is on
 * disk"; whether it is bound to THIS project and paid up is a server
 * verdict fetched at deploy time, so `tier` is always null here.
 * @param {{ projectDir?: string, publicKeyPem?: string }} [options]
 */
export function getLicense({ projectDir = process.cwd(), publicKeyPem } = {}) {
  const path = licensePath(projectDir);
  const stored = readJsonFileOrNull(path);
  if (!stored?.key) return noLicenseResult();
  const validation = validateLicenseKey(stored.key, { publicKeyPem });
  if (!validation.valid) return noLicenseResult();
  return {
    tier: null,
    active: true,
    key: String(stored.key).trim(),
    licenseId: validation.licenseId,
    activatedAt: stored.activatedAt,
    storedAt: path,
  };
}

/**
 * Presence, not validity: an unverifiable file must still be removable.
 * @param {{ projectDir?: string }} [options]
 */
export function hasStoredLicense({ projectDir = process.cwd() } = {}) {
  return existsSync(licensePath(projectDir));
}

/**
 * Validate the key locally, bind it to this project on vibecarbon.com, and
 * only then write the file. Nothing is written on any refusal or when the
 * server cannot be reached: there is no offline activate.
 * @param {string} key
 * @param {{ projectDir?: string, publicKeyPem?: string, env?: object, fetchImpl?: Function, source?: string }} [options]
 * @returns {Promise<object>} `{ success: true, projectId, tier, status, periodEnd, path } | { success: false, error, reason? }`
 */
export async function activateLicense(
  key,
  { projectDir = process.cwd(), publicKeyPem, env, fetchImpl, source = 'manual' } = {},
) {
  if (!key || typeof key !== 'string') {
    return { success: false, error: 'License key is required', reason: 'invalid' };
  }
  const validation = validateLicenseKey(key.trim(), { publicKeyPem });
  if (!validation.valid) {
    return { success: false, error: validation.error, reason: 'invalid' };
  }
  const projectId = currentManifestProjectId(projectDir);
  if (!projectId) {
    return {
      success: false,
      reason: 'no-project',
      error: 'No project here. Run vibecarbon create first, then activate inside it.',
    };
  }

  const bound = await bindLicense({ key: key.trim(), projectId, env, fetchImpl });
  if (!bound.ok) {
    return {
      success: false,
      reason: bound.reason,
      error: bindErrorMessage(bound),
      switchPlan: bound.switchPlan,
    };
  }

  try {
    writeLicenseFile(
      { key: key.trim(), activatedAt: new Date().toISOString(), source },
      projectDir,
    );
  } catch (error) {
    return { success: false, reason: 'write', error: `Failed to save license: ${error.message}` };
  }
  return {
    success: true,
    projectId: bound.projectId,
    tier: bound.tier,
    status: bound.status,
    periodEnd: bound.periodEnd,
    path: licensePath(projectDir),
  };
}

function bindErrorMessage(bound) {
  switch (bound.reason) {
    case 'bound_to_other_project':
      return 'This key is already bound to another project. Run vibecarbon deactivate in that project, or release it from https://vibecarbon.com/license, then activate again.';
    case 'project_already_licensed':
      return bound.message || 'This project already has an active subscription.';
    case 'subscription_inactive':
      return 'This subscription is no longer active. Renew it from https://vibecarbon.com/license.';
    case 'unknown_key':
      return 'This key is not recognised by vibecarbon.com. Check the key from your purchase email.';
    case 'bad_signature':
      return "This key's signature is not valid. Check the key from your purchase email.";
    case 'unreachable':
      return `Activation needs a connection to vibecarbon.com (${bound.detail ?? 'unreachable'}). Nothing was changed.`;
    default:
      return `vibecarbon.com refused this activation (${bound.detail ?? bound.reason}).`;
  }
}

/**
 * Ask vibecarbon.com to email the buyer a release link. The file is LEFT IN
 * PLACE: a released key is harmless on disk (the deploy gate answers
 * `unbound`, and activate overwrites it), and deleting it before the buyer
 * confirms would strand a project whose link is never clicked.
 * @param {{ projectDir?: string, key?: string, env?: object, fetchImpl?: Function }} [options]
 * @returns {Promise<object>} `{ success: true, sent: true } | { success: false, error, reason }`
 */
export async function deactivateLicense({ projectDir = process.cwd(), key, env, fetchImpl } = {}) {
  const stored = readJsonFileOrNull(licensePath(projectDir));
  const useKey = (key ?? stored?.key ?? '').trim();
  if (!useKey) {
    return {
      success: false,
      reason: 'no-key',
      error: 'No license here. Pass the key: vibecarbon deactivate <key>.',
    };
  }
  const r = await requestRelease({ key: useKey, env, fetchImpl });
  if (!r.ok) {
    const error =
      r.reason === 'unreachable'
        ? `Could not reach vibecarbon.com (${r.detail ?? 'unreachable'}); the key is still bound.`
        : r.reason === 'unknown_key'
          ? 'This key is not recognised by vibecarbon.com.'
          : `vibecarbon.com refused the request (${r.detail ?? r.reason}).`;
    return { success: false, reason: r.reason, error };
  }
  return { success: true, sent: true };
}

/**
 * Delete the local file only. No request.
 * @param {{ projectDir?: string }} [options]
 * @returns {object} `{ success, removed: string[], error? }`
 */
export function removeLicenseFile({ projectDir = process.cwd() } = {}) {
  const path = licensePath(projectDir);
  if (!existsSync(path)) return { success: true, removed: [] };
  try {
    unlinkSync(path);
    return { success: true, removed: [path] };
  } catch (error) {
    return { success: false, removed: [], error: `Failed to remove license: ${error.message}` };
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
 * after it. Compose deploys return immediately; a key on disk is always
 * checked with the server.
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
  // (or projectConfig.projectId verbatim); every verdict.projectId is always
  // lowercase (.toLowerCase() in checkLicense()/verifyVerdictToken()).
  // Without normalizing here too, a mixed-case manifest id compares unequal
  // to it and false-blocks an otherwise valid, matching license.
  const projectId = normalizeProjectId(ensureProjectId(projectConfig, projectDir));
  // getLicense() reads the project's own file; `stateDir` below is only the
  // verdict cache's home, which is per-machine, not per-project.
  const license = getLicense({ projectDir, publicKeyPem });

  // Any key on disk is checked with the server: the key names no project and
  // no plan, so whether it is bound here and paid up is only ever a verdict.
  // No key at all is decided offline — there is nothing to ask about.
  let check = { source: 'none', verdict: null };
  if (license.active) {
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
    { verdict: { reason: 'no-license', requiredTier: 'fullerene' }, projectId: null },
    { c },
  );
  process.exit(1);
}

// Re-export tier utilities
export { compareTiers, getTier, TIERS } from './tiers.js';
export { validateLicenseKey } from './validator.js';
