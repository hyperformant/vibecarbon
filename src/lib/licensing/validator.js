/**
 * License key validator for Vibecarbon
 *
 * Key format:
 * vc-<tier>-<customer_id>-<signature>
 *
 * Example: vc-f-a7f2b9c1-x8kd9mwp2v4n...
 *
 * - vc: prefix
 * - tier: single character — f (Fullerene)
 * - customer_id: 8-character hex identifier
 * - signature: Ed25519 signature encoded as lowercase hex
 *
 * Licenses never expire.
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

// Tier character mapping
const TIER_MAP = { f: 'fullerene' };

/**
 * Parse a license key: vc-<tier>-<customer_id>-<signature>
 * @param {string} key - The license key string
 * @returns {object} Parsed key components or error
 */
export function parseLicenseKey(key) {
  if (!key || typeof key !== 'string') {
    return { valid: false, error: 'License key is required' };
  }

  const trimmedKey = key.trim().toLowerCase();
  const parts = trimmedKey.split('-');

  // Must have at least 4 parts: vc, tier, customer_id, signature
  if (parts.length < 4) {
    return { valid: false, error: 'Invalid license key format' };
  }

  const [prefix, tierChar, customerId, ...signatureParts] = parts;
  const signature = signatureParts.join('-');

  // Validate prefix
  if (prefix !== 'vc') {
    return { valid: false, error: 'Invalid license key prefix' };
  }

  // Validate tier character
  const tier = TIER_MAP[tierChar];
  if (!tier) {
    return { valid: false, error: 'Invalid license tier' };
  }

  // Validate customer ID (8 hex characters)
  if (!/^[a-f0-9]{8}$/.test(customerId)) {
    return { valid: false, error: 'Invalid customer ID format' };
  }

  // Validate signature exists and has minimum length
  if (!signature || signature.length < 10) {
    return { valid: false, error: 'Invalid signature' };
  }

  return {
    valid: true,
    tier,
    tierChar,
    customerId,
    isLifetime: true,
    signature,
    originalKey: key.trim(),
  };
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

    // Signed message: <tierChar>-<customerId>
    const message = `${parsedKey.tierChar}-${parsedKey.customerId}`;
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
 * @returns {object} Complete validation result
 */
export function validateLicenseKey(key) {
  // Parse the key
  const parsed = parseLicenseKey(key);
  if (!parsed.valid) {
    return parsed;
  }

  // Verify signature
  const signatureResult = verifySignature(parsed);
  if (!signatureResult.valid) {
    return signatureResult;
  }

  return {
    valid: true,
    tier: parsed.tier,
    customerId: parsed.customerId,
    isLifetime: true,
    verified: signatureResult.verified,
  };
}
