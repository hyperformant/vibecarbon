/**
 * License key validator for Vibecarbon
 *
 * Two key formats share one Ed25519 keypair, distinguished by prefix:
 *
 *   v1 (legacy, lifetime, global):
 *     vc-<tier>-<customer_id>-<signature>
 *     signed message: <tier>-<customer_id>
 *     tier: f (Fullerene) — the only tier v1 ever issued.
 *
 *   v2 (per-project, subscription):
 *     vc2-<customer_id>-<project_id_32hex>-<signature>
 *     signed message: 2-<customer_id>-<project_id_32hex>
 *     Carries no tier and no date. Tier and subscription status live on
 *     vibecarbon.com and reach the CLI as a signed verdict token (below),
 *     so the key never rotates and a committed .vibecarbon.license stays
 *     stable for the life of the project.
 *
 *   verdict token (server -> CLI, cached per machine):
 *     vcv-<project_id_32hex>-<status>-<tier>-<yyyymmdd periodEnd>-<yyyymmdd issued>-<signature>
 *     signed message: v-<project_id_32hex>-<status>-<tier>-<periodEnd>-<issued>
 *     status: active | past_due | canceled | none.  tier: graphene | fullerene | none.
 *
 * - customer_id: 8-character hex identifier.
 * - project_id_32hex: the project's UUID with hyphens stripped, lowercase.
 *   Re-hyphenated to canonical 8-4-4-4-12 for `projectId` on parse. A
 *   dashed projectId inside the key would collide with the `-` separator,
 *   so it splits into the wrong number of parts and is rejected.
 * - signature: Ed25519 signature encoded as lowercase hex.
 * - The leading `2-` in the v2 signed message (and `v-` in the verdict
 *   message) keeps a v1 signature, a v2 signature, and a verdict signature
 *   from ever being replayed as one another.
 *
 * Keys are case-insensitive on input (lowercased before parsing) and
 * whitespace-trimmed.
 *
 * Licenses never expire for v1 (isLifetime: true). v2 carries no
 * paidThrough of its own: entitlement (tier/status/periodEnd) comes only
 * from a verified verdict token, never from the key or the wall clock
 * alone.
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

// Tier character mapping for v1, the only format that still carries a tier
// char in the key itself. v2 tier lives in the verdict token instead.
const V1_TIER_MAP = { f: 'fullerene' };

// Exported so scripts/generate-license.js's signVerdictToken can validate
// against the exact same sets it is verified against here, rather than
// keeping a second hand-copied list that could drift.
export const VERDICT_STATUSES = new Set(['active', 'past_due', 'canceled', 'none']);
export const VERDICT_TIERS = new Set(['graphene', 'fullerene', 'none']);
const SIG_RE = /^[a-f0-9]{128}$/;

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
 * Parse a v1 key: vc-<tierChar>-<customerId>-<signature>. Must split into
 * exactly 4 parts.
 */
function parseV1(parts, originalKey) {
  if (parts.length !== 4) {
    return { valid: false, error: 'Invalid license key format' };
  }

  const [, tierChar, customerId, signature] = parts;

  const tier = V1_TIER_MAP[tierChar];
  if (!tier) {
    return { valid: false, error: 'Invalid license tier' };
  }

  if (!/^[a-f0-9]{8}$/.test(customerId)) {
    return { valid: false, error: 'Invalid customer ID format' };
  }

  // Ed25519 signatures are always 64 bytes, hex-encoded to exactly 128
  // lowercase hex characters, for both key formats.
  if (!signature || !SIG_RE.test(signature)) {
    return { valid: false, error: 'Invalid signature' };
  }

  return {
    valid: true,
    format: 'v1',
    tier,
    tierChar,
    customerId,
    projectId: null,
    paidThrough: null,
    isLifetime: true,
    signature,
    originalKey: originalKey.trim(),
  };
}

/** vc2-<customerId>-<projectId32>-<signature>: exactly 4 parts. */
function parseV2(parts, originalKey) {
  if (parts.length !== 4) {
    return { valid: false, error: 'Invalid license key format' };
  }
  const [, customerId, projectId32, signature] = parts;
  if (!/^[a-f0-9]{8}$/.test(customerId)) {
    return { valid: false, error: 'Invalid customer ID format' };
  }
  if (!/^[a-f0-9]{32}$/.test(projectId32)) {
    return { valid: false, error: 'Invalid project ID format' };
  }
  if (!signature || !SIG_RE.test(signature)) {
    return { valid: false, error: 'Invalid signature' };
  }
  return {
    valid: true,
    format: 'v2',
    tier: null,
    tierChar: null,
    customerId,
    projectId: reHyphenateProjectId(projectId32),
    paidThrough: null,
    isLifetime: false,
    signature,
    originalKey: originalKey.trim(),
  };
}

/**
 * Parse a license key, dispatching on prefix: `vc-` to the v1 parser,
 * `vc2-` to the v2 parser, anything else is an invalid prefix.
 * @param {string} key - The license key string
 * @returns {object} Parsed key components or error
 */
export function parseLicenseKey(key) {
  if (!key || typeof key !== 'string') {
    return { valid: false, error: 'License key is required' };
  }

  const trimmedKey = key.trim().toLowerCase();
  const parts = trimmedKey.split('-');
  const prefix = parts[0];

  if (prefix === 'vc2') {
    return parseV2(parts, key);
  }
  if (prefix === 'vc') {
    return parseV1(parts, key);
  }
  return { valid: false, error: 'Invalid license key prefix' };
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
 * @param {{ format: string, tierChar?: string, customerId?: string, projectId?: string, status?: string, tier?: string, periodEnd?: string, issued?: string }} parsed
 * @returns {string}
 */
export function signedMessage(parsed) {
  if (parsed.format === 'verdict') {
    const projectId32 = parsed.projectId.replace(/-/g, '');
    return `v-${projectId32}-${parsed.status}-${parsed.tier}-${parsed.periodEnd.replace(/-/g, '')}-${parsed.issued.replace(/-/g, '')}`;
  }
  if (parsed.format === 'v2') {
    const projectId32 = parsed.projectId.replace(/-/g, '');
    return `2-${parsed.customerId}-${projectId32}`;
  }
  return `${parsed.tierChar}-${parsed.customerId}`;
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
 * @returns {object} `{ valid, verified, format, tier, tierChar, customerId,
 *   projectId, paidThrough, isLifetime, error? }`
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
    format: parsed.format,
    tier: parsed.tier,
    tierChar: parsed.tierChar,
    customerId: parsed.customerId,
    projectId: parsed.projectId,
    paidThrough: parsed.paidThrough,
    isLifetime: parsed.isLifetime,
  };
}
