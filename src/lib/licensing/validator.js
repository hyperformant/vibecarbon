/**
 * License key validator for Vibecarbon
 *
 * One key format and one verdict format share one Ed25519 keypair:
 *
 *   key (per-project subscription; project binding lives on vibecarbon.com):
 *     vc-<license_id_16hex>-<signature>
 *     signed message: <license_id_16hex>
 *     Carries no tier, date, email, or project. `vibecarbon activate` binds
 *     it to the current project through the API; the deploy gate asks the
 *     API whether the binding matches and gets a signed verdict back.
 *
 *   verdict token (server -> CLI, cached per machine):
 *     vcv-<project_id_32hex>-<status>-<tier>-<yyyymmdd periodEnd>-<yyyymmdd issued>-<signature>
 *     signed message: v-<project_id_32hex>-<status>-<tier>-<periodEnd>-<issued>
 *     status: active | past_due | canceled | unbound | wrong_project | none
 *     tier: graphene | fullerene | none
 *
 * - project_id_32hex: the project's UUID with hyphens stripped, lowercase,
 *   re-hyphenated to 8-4-4-4-12 on parse.
 * - signature: Ed25519, lowercase hex, always 128 chars.
 * - The `v-` prefix in the verdict message keeps a key signature and a
 *   verdict signature from ever being replayed as one another.
 *
 * Keys are case-insensitive on input (lowercased before parsing) and
 * whitespace-trimmed. Entitlement (tier/status/periodEnd) comes only from a
 * verified verdict token, never from the key or the wall clock alone.
 */

import { createPublicKey, verify } from 'node:crypto';

// Ed25519 public key for license verification (embedded for offline validation)
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAUrn80IKtISxTCpGjc5rf2ZZhhhu+SktK4L2GEWrjT6Q=
-----END PUBLIC KEY-----`;

// NO ESCAPE HATCH LIVES HERE, AND NONE MAY BE ADDED.
//
// The npm package is this tree verbatim — `files: [src, carbon, services]`
// with `bin -> ./src/cli.js`, no build step — so a debug branch added here
// ships to every customer with no way to strip it. Two used to: an env read
// (`VIBECARBON_DEV_LICENSE=true`) and a compile-time `LICENSING_DISABLED`
// constant, either of which granted Fullerene to anyone who read this file.
//
// Tests do not need one. Unit tests inject an ephemeral keypair via the
// `publicKeyPem` option below; the integration and e2e harnesses activate a
// genuine signed key from VIBECARBON_TEST_LICENSE_KEY, which is the same path
// a customer walks. tests/unit/licensing/no-dev-bypass.test.ts fails if a
// switch reappears in this directory.

// Exported so scripts/generate-license.js's signVerdictToken can validate
// against the exact same sets it is verified against here, rather than
// keeping a second hand-copied list that could drift.
export const VERDICT_STATUSES = new Set([
  'active',
  'past_due',
  'canceled',
  'unbound',
  'wrong_project',
  'none',
]);
export const VERDICT_TIERS = new Set(['graphene', 'fullerene', 'none']);
const SIG_RE = /^[a-f0-9]{128}$/;
const LICENSE_ID_RE = /^[a-f0-9]{16}$/;

/** Re-hyphenate a bare 32-hex-char id into canonical 8-4-4-4-12 lowercase. */
function reHyphenateProjectId(pid32) {
  return [
    pid32.slice(0, 8),
    pid32.slice(8, 12),
    pid32.slice(12, 16),
    pid32.slice(16, 20),
    pid32.slice(20),
  ].join('-');
}

/** True when year/month/day form a real calendar date (rejects e.g. month 13, Feb 30). */
function isRealCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** Parse an 8-digit yyyymmdd into 'YYYY-MM-DD', or null if malformed/not a real date. */
function parseYmd(yyyymmdd) {
  if (!/^\d{8}$/.test(yyyymmdd)) return null;
  const year = Number(yyyymmdd.slice(0, 4));
  const month = Number(yyyymmdd.slice(4, 6));
  const day = Number(yyyymmdd.slice(6, 8));
  if (!isRealCalendarDate(year, month, day)) return null;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/**
 * Parse a license key: vc-<licenseId>-<signature>, exactly 3 parts.
 * Pure shape check; verifySignature() is what makes it trustworthy.
 * @param {string} key
 * @returns {object} `{ valid: true, format: 'key', licenseId, signature, originalKey } | { valid: false, error }`
 */
export function parseLicenseKey(key) {
  if (!key || typeof key !== 'string') {
    return { valid: false, error: 'License key is required' };
  }
  const trimmedKey = key.trim().toLowerCase();
  const parts = trimmedKey.split('-');
  if (parts[0] !== 'vc') {
    return { valid: false, error: 'Invalid license key prefix' };
  }
  if (parts.length !== 3) {
    return { valid: false, error: 'Invalid license key format' };
  }
  const [, licenseId, signature] = parts;
  if (!LICENSE_ID_RE.test(licenseId)) {
    return { valid: false, error: 'Invalid license ID format' };
  }
  if (!signature || !SIG_RE.test(signature)) {
    return { valid: false, error: 'Invalid signature' };
  }
  return { valid: true, format: 'key', licenseId, signature, originalKey: key.trim() };
}

/**
 * Parse a verdict token. Pure shape check; verifyVerdictToken() is the
 * only thing that makes its fields trustworthy.
 * @param {string} token
 * @returns {object}
 */
export function parseVerdictToken(token) {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'Verdict token is required' };
  }
  const parts = token.trim().toLowerCase().split('-');
  if (parts.length !== 7 || parts[0] !== 'vcv') {
    return { valid: false, error: 'Invalid verdict token format' };
  }
  const [, projectId32, status, tier, periodEndRaw, issuedRaw, signature] = parts;
  if (!/^[a-f0-9]{32}$/.test(projectId32)) {
    return { valid: false, error: 'Invalid project ID format' };
  }
  if (!VERDICT_STATUSES.has(status)) return { valid: false, error: 'Invalid verdict status' };
  if (!VERDICT_TIERS.has(tier)) return { valid: false, error: 'Invalid verdict tier' };
  const periodEnd = parseYmd(periodEndRaw);
  const issued = parseYmd(issuedRaw);
  if (!periodEnd || !issued) return { valid: false, error: 'Invalid verdict date' };
  if (!signature || !SIG_RE.test(signature)) return { valid: false, error: 'Invalid signature' };
  return {
    valid: true,
    format: 'verdict',
    projectId: reHyphenateProjectId(projectId32),
    status,
    tier,
    periodEnd,
    issued,
    signature,
  };
}

/**
 * The single source of truth for what gets signed, for every format.
 * Imported by scripts/generate-license.js so minting and verifying can
 * never drift apart.
 * @param {{ format: string, licenseId?: string, projectId?: string, status?: string, tier?: string, periodEnd?: string, issued?: string }} parsed
 * @returns {string}
 */
export function signedMessage(parsed) {
  if (parsed.format === 'verdict') {
    const projectId32 = parsed.projectId.replace(/-/g, '');
    return `v-${projectId32}-${parsed.status}-${parsed.tier}-${parsed.periodEnd.replace(/-/g, '')}-${parsed.issued.replace(/-/g, '')}`;
  }
  return parsed.licenseId;
}

/**
 * Verify the cryptographic signature of a license key or verdict token.
 *
 * Parameterized purely for testability: production callers pass no options and
 * get the embedded public key. Tests inject an ephemeral keypair
 * (`publicKeyPem`) to exercise the real Ed25519 accept/reject branches without
 * needing the production private key. There is no mode in which this function
 * returns valid without a signature that verifies — see the note at the top of
 * this file.
 *
 * @param {object} parsedKey - Parsed license key or verdict token
 * @param {{ publicKeyPem?: string }} [options]
 * @returns {object} Verification result
 */
export function verifySignature(parsedKey, { publicKeyPem = PUBLIC_KEY_PEM } = {}) {
  if (!parsedKey.valid) {
    return { valid: false, error: parsedKey.error };
  }

  try {
    const publicKey = createPublicKey(publicKeyPem);

    const message = signedMessage(parsedKey);
    const signatureBuffer = Buffer.from(parsedKey.signature, 'hex');

    const isValid = verify(null, Buffer.from(message), publicKey, signatureBuffer);

    if (!isValid) {
      return { valid: false, error: 'Invalid license signature' };
    }

    return { valid: true, verified: true };
  } catch (error) {
    return { valid: false, error: `Signature verification failed: ${error.message}` };
  }
}

/**
 * Verify a verdict token and return ONLY its signed fields. Callers must
 * never read status/tier/periodEnd from anywhere else (the cache file's JSON
 * mirror is for display).
 * @param {string} token
 * @param {{ publicKeyPem?: string }} [options]
 * @returns {object} `{ valid: true, projectId, status, tier, periodEnd, issued } | { valid: false, error }`
 */
export function verifyVerdictToken(token, { publicKeyPem } = {}) {
  const parsed = parseVerdictToken(token);
  if (!parsed.valid) return parsed;
  const sig = verifySignature(parsed, { publicKeyPem });
  if (!sig.valid) return { valid: false, error: sig.error };
  const { projectId, status, tier, periodEnd, issued } = parsed;
  return { valid: true, projectId, status, tier, periodEnd, issued };
}

/**
 * Validate a complete license key
 * @param {string} key - The license key string
 * @param {{ publicKeyPem?: string }} [options] - passthrough to
 *   verifySignature; tests inject an ephemeral keypair here. Production
 *   callers pass nothing and get the embedded key.
 * @returns {object} `{ valid: true, verified: true, licenseId } | { valid: false, error }`
 */
export function validateLicenseKey(key, { publicKeyPem } = {}) {
  // Parse the key
  const parsed = parseLicenseKey(key);
  if (!parsed.valid) {
    return parsed;
  }

  // Verify signature
  const signatureResult = verifySignature(parsed, { publicKeyPem });
  if (!signatureResult.valid) {
    return signatureResult;
  }

  return {
    valid: true,
    verified: signatureResult.verified,
    licenseId: parsed.licenseId,
  };
}
