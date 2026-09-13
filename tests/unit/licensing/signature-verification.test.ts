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
  signedMessage,
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

describe('verifySignature (real Ed25519 path, v2)', () => {
  const customerId = 'a1b2c3d4';
  const projectId32 = '11112222333344445555666677778888';
  const projectId = '11112222-3333-4444-5555-666677778888';
  const paidThrough = '2027-12-31';
  const yyyymmdd = '20271231';

  function signV2Key(
    privateKey: ReturnType<typeof makeKeypair>['privateKey'],
    overrides: {
      tierChar?: string;
      customerId?: string;
      projectId32?: string;
      yyyymmdd?: string;
    } = {},
  ) {
    const tierChar = overrides.tierChar ?? 'g';
    const cid = overrides.customerId ?? customerId;
    const pid32 = overrides.projectId32 ?? projectId32;
    const date = overrides.yyyymmdd ?? yyyymmdd;
    const message = signedMessage({
      format: 'v2',
      tierChar,
      customerId: cid,
      projectId: pid32, // signedMessage strips dashes, so a bare 32-hex works too
      paidThrough: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
    });
    const signatureHex = edSign(null, Buffer.from(message), privateKey).toString('hex');
    return `vc2-${tierChar}-${cid}-${pid32}-${date}-${signatureHex}`;
  }

  it('accepts a v2 key signed by the matching private key', () => {
    const { publicKeyPem, privateKey } = makeKeypair();
    const parsed = parseLicenseKey(signV2Key(privateKey));
    expect(parsed.valid).toBe(true);
    expect(parsed.projectId).toBe(projectId);
    expect(parsed.paidThrough).toBe(paidThrough);
    const result = verifySignature(parsed, { publicKeyPem });
    expect(result.valid).toBe(true);
    expect(result.verified).toBe(true);
  });

  it('rejects when the tier char is tampered after signing', () => {
    const { publicKeyPem, privateKey } = makeKeypair();
    const key = signV2Key(privateKey, { tierChar: 'g' });
    const tampered = key.replace('vc2-g-', 'vc2-f-');
    const parsed = parseLicenseKey(tampered);
    expect(parsed.valid).toBe(true); // parses fine, 'f' is a valid v2 tier char
    const result = verifySignature(parsed, { publicKeyPem });
    expect(result.valid).toBe(false);
  });

  it('rejects when the paid-through date is tampered after signing', () => {
    const { publicKeyPem, privateKey } = makeKeypair();
    const key = signV2Key(privateKey);
    const tampered = key.replace(`-${yyyymmdd}-`, '-20271230-');
    const parsed = parseLicenseKey(tampered);
    expect(parsed.valid).toBe(true);
    const result = verifySignature(parsed, { publicKeyPem });
    expect(result.valid).toBe(false);
  });

  it('rejects when the projectId is tampered after signing', () => {
    const { publicKeyPem, privateKey } = makeKeypair();
    const key = signV2Key(privateKey);
    const tamperedProjectId32 = `${'9'.repeat(8)}${projectId32.slice(8)}`;
    const tampered = key.replace(projectId32, tamperedProjectId32);
    const parsed = parseLicenseKey(tampered);
    expect(parsed.valid).toBe(true);
    const result = verifySignature(parsed, { publicKeyPem });
    expect(result.valid).toBe(false);
  });

  it('rejects a v1 signature transplanted into a v2 shell (the leading 2- guards against replay)', () => {
    const { publicKeyPem, privateKey } = makeKeypair();
    // Sign the v1 message for the same tier char and customer id...
    const v1Message = `g-${customerId}`;
    const v1SignatureHex = edSign(null, Buffer.from(v1Message), privateKey).toString('hex');
    // ...then splice that signature into an otherwise well-formed v2 key.
    const transplanted = `vc2-g-${customerId}-${projectId32}-${yyyymmdd}-${v1SignatureHex}`;
    const parsed = parseLicenseKey(transplanted);
    expect(parsed.valid).toBe(true);
    const result = verifySignature(parsed, { publicKeyPem });
    expect(result.valid).toBe(false);
  });

  it('the embedded production key rejects a well-formed but bogus v2 signature', () => {
    const bogus = `vc2-g-${customerId}-${projectId32}-${yyyymmdd}-${'0'.repeat(128)}`;
    const parsed = parseLicenseKey(bogus);
    expect(parsed.valid).toBe(true);
    const result = verifySignature(parsed);
    expect(result.valid).toBe(false);
  });

  it('validateLicenseKey accepts a genuinely signed v2 key end to end', () => {
    const { publicKeyPem, privateKey } = makeKeypair();
    const key = signV2Key(privateKey);
    const result = validateLicenseKey(key, { publicKeyPem });
    expect(result.valid).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('v2');
    expect(result.tier).toBe('graphene');
    expect(result.projectId).toBe(projectId);
    expect(result.paidThrough).toBe(paidThrough);
  });
});
