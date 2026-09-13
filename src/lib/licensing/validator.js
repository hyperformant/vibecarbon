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
 *     vc2-<tier>-<customer_id>-<project_id_32hex>-<yyyymmdd>-<signature>
 *     signed message: 2-<tier>-<customer_id>-<project_id_32hex>-<yyyymmdd>
 *     tier: g (Graphene) | f (Fullerene)
 *
 * - customer_id: 8-character hex identifier.
 * - project_id_32hex: the project's UUID with hyphens stripped, lowercase.
 *   Re-hyphenated to canonical 8-4-4-4-12 for `projectId` on parse. A
 *   dashed projectId inside the key would collide with the `-` separator,
 *   so it splits into the wrong number of parts and is rejected.
 * - yyyymmdd: the paid-through date, must be a real calendar date. Parses
 *   to `paidThrough: 'YYYY-MM-DD'`.
 * - signature: Ed25519 signature encoded as lowercase hex.
 * - The leading `2-` in the v2 signed message means a v1 signature can
 *   never be replayed as v2, or vice versa.
 *
 * Keys are case-insensitive on input (lowercased before parsing) and
 * whitespace-trimmed.
 *
 * Licenses never expire for v1 (isLifetime: true). v2 licenses expire at
 * paidThrough; v2 Fullerene still reports tier: 'fullerene' — what
 * distinguishes legacy is `format`/`isLifetime`, not the tier char.
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

// Tier character mappings, one table per format — v1 only ever issued
// Fullerene; v2 also issues Graphene.
const V1_TIER_MAP = { f: 'fullerene' };
const V2_TIER_MAP = { g: 'graphene', f: 'fullerene' };

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
  if (!signature || !/^[a-f0-9]{128}$/.test(signature)) {
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

/**
 * Parse a v2 key:
 * vc2-<tierChar>-<customerId>-<projectId32>-<yyyymmdd>-<signature>. Must
 * split into exactly 6 parts — a dashed projectId would produce more parts
 * and is rejected here, not specially detected.
 */
function parseV2(parts, originalKey) {
  if (parts.length !== 6) {
    return { valid: false, error: 'Invalid license key format' };
  }

  const [, tierChar, customerId, projectId32, yyyymmdd, signature] = parts;

  const tier = V2_TIER_MAP[tierChar];
  if (!tier) {
    return { valid: false, error: 'Invalid license tier' };
  }

  if (!/^[a-f0-9]{8}$/.test(customerId)) {
    return { valid: false, error: 'Invalid customer ID format' };
  }

  if (!/^[a-f0-9]{32}$/.test(projectId32)) {
    return { valid: false, error: 'Invalid project ID format' };
  }

  if (!/^\d{8}$/.test(yyyymmdd)) {
    return { valid: false, error: 'Invalid paid-through date' };
  }

  const year = Number(yyyymmdd.slice(0, 4));
  const month = Number(yyyymmdd.slice(4, 6));
  const day = Number(yyyymmdd.slice(6, 8));
  if (!isRealCalendarDate(year, month, day)) {
    return { valid: false, error: 'Invalid paid-through date' };
  }

  // Ed25519 signatures are always 64 bytes, hex-encoded to exactly 128
  // lowercase hex characters, for both key formats.
  if (!signature || !/^[a-f0-9]{128}$/.test(signature)) {
    return { valid: false, error: 'Invalid signature' };
  }

  return {
    valid: true,
    format: 'v2',
    tier,
    tierChar,
    customerId,
    projectId: reHyphenateProjectId(projectId32),
    paidThrough: `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`,
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
 * The single source of truth for what gets signed, for both formats.
 * Imported by scripts/generate-license.js so minting and verifying can
 * never drift apart.
 * @param {{ format: string, tierChar: string, customerId: string, projectId?: string, paidThrough?: string }} parsed
 * @returns {string}
 */
export function signedMessage(parsed) {
  if (parsed.format === 'v2') {
    const projectId32 = parsed.projectId.replace(/-/g, '');
    const yyyymmdd = parsed.paidThrough.replace(/-/g, '');
    return `2-${parsed.tierChar}-${parsed.customerId}-${projectId32}-${yyyymmdd}`;
  }
  return `${parsed.tierChar}-${parsed.customerId}`;
}

/**
 * Verify the cryptographic signature of a license key.
 *
 * Parameterized purely for testability: production callers pass no options and
 * get the embedded public key. Tests inject an ephemeral keypair
 * (`publicKeyPem`) to exercise the real Ed25519 accept/reject branches without
 * needing the production private key. There is no mode in which this function
 * returns valid without a signature that verifies — see the note at the top of
 * this file.
 *
 * @param {object} parsedKey - Parsed license key from parseLicenseKey()
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
