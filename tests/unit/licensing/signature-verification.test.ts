/**
 * Ed25519 signature-path coverage for the license validator.
 *
 * Before this, no automated test exercised verifySignature's real crypto
 * (the harness set VIBECARBON_DEV_LICENSE=true, which skipped it), so a broken
 * PUBLIC_KEY_PEM or an accept-anything regression would ship undetected and be
 * discovered by a paying customer. These tests inject an ephemeral keypair to
 * cover both the accept and reject branches, and also assert the REAL embedded
 * key rejects a garbage signature (guards the accept-anything direction).
 */

import { sign as edSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseLicenseKey,
  validateLicenseKey,
  verifySignature,
} from '../../../src/lib/licensing/validator.js';

// A signature has to survive parseLicenseKey (>=10 chars, lowercase hex);
// Ed25519 signatures are 64 bytes / 128 hex chars, so that always holds.
function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
  };
}

function signKey(privateKey: ReturnType<typeof makeKeypair>['privateKey'], customerId: string) {
  const message = `f-${customerId}`; // tierChar-customerId, matches validator
  const signatureHex = edSign(null, Buffer.from(message), privateKey).toString('hex');
  return `vc-f-${customerId}-${signatureHex}`;
}

describe('verifySignature (real Ed25519 path)', () => {
  const customerId = 'a1b2c3d4';

  it('accepts a key signed by the matching private key', () => {
    const { publicKeyPem, privateKey } = makeKeypair();
    const parsed = parseLicenseKey(signKey(privateKey, customerId));
    const result = verifySignature(parsed, { publicKeyPem });
    expect(result.valid).toBe(true);
    expect(result.verified).toBe(true);
  });

  it('rejects a key whose signature was tampered with', () => {
    const { publicKeyPem, privateKey } = makeKeypair();
    const key = signKey(privateKey, customerId);
    // Flip the last hex char of the signature.
    const last = key.at(-1) === '0' ? '1' : '0';
    const tampered = key.slice(0, -1) + last;
    const parsed = parseLicenseKey(tampered);
    const result = verifySignature(parsed, { publicKeyPem });
    expect(result.valid).toBe(false);
  });

  it('rejects a key signed by a different private key', () => {
    const signer = makeKeypair();
    const verifier = makeKeypair(); // different public key
    const parsed = parseLicenseKey(signKey(signer.privateKey, customerId));
    const result = verifySignature(parsed, { publicKeyPem: verifier.publicKeyPem });
    expect(result.valid).toBe(false);
  });

  it('the embedded production key rejects a well-formed but bogus signature', () => {
    // 128 hex chars of zeros — parses fine, must fail real verification.
    const bogus = `vc-f-${customerId}-${'0'.repeat(128)}`;
    const parsed = parseLicenseKey(bogus);
    expect(parsed.valid).toBe(true);
    // No publicKeyPem override → uses the embedded PUBLIC_KEY_PEM.
    const result = verifySignature(parsed);
    expect(result.valid).toBe(false);
  });

  it('validateLicenseKey rejects a well-formed key with a bad signature', () => {
    // Unconditional now. This assertion used to branch on
    // VIBECARBON_DEV_LICENSE because that variable could turn the whole chain
    // into an accept-anything — which is precisely why it no longer exists.
    const bogus = `vc-f-${customerId}-${'0'.repeat(128)}`;
    expect(validateLicenseKey(bogus).valid).toBe(false);
  });
});
