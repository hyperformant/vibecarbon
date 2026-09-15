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
import { beforeEach, describe, expect, it } from 'vitest';
import {
  derivePublicKeyPem,
  mintV1Key,
  mintV2Key,
  signVerdictToken,
} from '../../../scripts/generate-license.js';
import {
  parseLicenseKey,
  validateLicenseKey,
  verifySignature,
  verifyVerdictToken,
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

// mintV2Key/signVerdictToken need a PEM-encoded private key (not a KeyObject),
// so this pairs with derivePublicKeyPem the same way generate-license.test.ts does.
function ephemeralPrivateKeyPem() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
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

describe('v2 key signature', () => {
  const PROJECT_ID = '11111111-2222-3333-4444-555555555555';
  let privateKeyPem: string;
  let publicKeyPem: string;
  let otherPublicKeyPem: string;

  beforeEach(() => {
    privateKeyPem = ephemeralPrivateKeyPem();
    publicKeyPem = derivePublicKeyPem(privateKeyPem);
    otherPublicKeyPem = derivePublicKeyPem(ephemeralPrivateKeyPem());
  });

  it('accepts a key minted by the generator and rejects every tampered field', () => {
    const key = mintV2Key(privateKeyPem, { customerId: 'a1b2c3d4', projectId: PROJECT_ID });
    expect(validateLicenseKey(key, { publicKeyPem }).valid).toBe(true);
    const [, cid, pid32, sig] = key.split('-');
    expect(validateLicenseKey(`vc2-ffffffff-${pid32}-${sig}`, { publicKeyPem }).valid).toBe(false);
    expect(validateLicenseKey(`vc2-${cid}-${'0'.repeat(32)}-${sig}`, { publicKeyPem }).valid).toBe(
      false,
    );
    expect(validateLicenseKey(key, { publicKeyPem: otherPublicKeyPem }).valid).toBe(false);
  });

  it('a v1 signature can never be replayed as v2 (message prefix differs)', () => {
    const v1 = mintV1Key(privateKeyPem, { customerId: 'a1b2c3d4' });
    const v1sig = v1.split('-')[3];
    expect(
      validateLicenseKey(`vc2-a1b2c3d4-${PROJECT_ID.replace(/-/g, '')}-${v1sig}`, { publicKeyPem })
        .valid,
    ).toBe(false);
  });
});

describe('verdict token signature', () => {
  const PROJECT_ID = '11111111-2222-3333-4444-555555555555';
  const fields = {
    projectId: PROJECT_ID,
    status: 'active',
    tier: 'graphene',
    periodEnd: '2026-09-30',
    issued: '2026-09-14',
  };
  let privateKeyPem: string;
  let publicKeyPem: string;

  beforeEach(() => {
    privateKeyPem = ephemeralPrivateKeyPem();
    publicKeyPem = derivePublicKeyPem(privateKeyPem);
  });

  it('verifies a token signed by the generator and returns only signed fields', () => {
    const token = signVerdictToken(privateKeyPem, fields);
    expect(verifyVerdictToken(token, { publicKeyPem })).toEqual({ valid: true, ...fields });
  });

  it.each(['status', 'tier', 'periodEnd', 'issued', 'projectId'] as const)(
    'rejects a tampered %s',
    (field) => {
      const token = signVerdictToken(privateKeyPem, fields);
      const parts = token.split('-');
      const idx = { projectId: 1, status: 2, tier: 3, periodEnd: 4, issued: 5 }[field];
      const replacement = {
        projectId: '0'.repeat(32),
        status: 'canceled',
        tier: 'fullerene',
        periodEnd: '20991231',
        issued: '20991231',
      }[field];
      parts[idx] = replacement;
      expect(verifyVerdictToken(parts.join('-'), { publicKeyPem }).valid).toBe(false);
    },
  );

  it('a v2 key signature cannot be replayed as a verdict', () => {
    const key = mintV2Key(privateKeyPem, { customerId: 'a1b2c3d4', projectId: PROJECT_ID });
    const sig = key.split('-')[3];
    const pid32 = PROJECT_ID.replace(/-/g, '');
    expect(
      verifyVerdictToken(`vcv-${pid32}-active-fullerene-20991231-20260914-${sig}`, {
        publicKeyPem,
      }).valid,
    ).toBe(false);
  });
});
