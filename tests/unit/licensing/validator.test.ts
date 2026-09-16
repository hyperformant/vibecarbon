import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseLicenseKey,
  parseVerdictToken,
  signedMessage,
  VERDICT_STATUSES,
  validateLicenseKey,
  verifyVerdictToken,
} from '../../../src/lib/licensing/validator.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const LICENSE_ID = '0123456789abcdef';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

function mint(licenseId = LICENSE_ID, key = privateKey): string {
  const sig = sign(null, Buffer.from(licenseId), key).toString('hex');
  return `vc-${licenseId}-${sig}`;
}

describe('parseLicenseKey', () => {
  it('parses vc-<16 hex>-<128 hex>, lowercased and trimmed', () => {
    const parsed = parseLicenseKey(`  ${mint().toUpperCase()} `);
    expect(parsed).toMatchObject({ valid: true, format: 'key', licenseId: LICENSE_ID });
    expect((parsed as { signature: string }).signature).toHaveLength(128);
  });

  it('rejects the retired formats by name', () => {
    expect(parseLicenseKey(`vc-f-deadbeef-${'a'.repeat(128)}`)).toEqual({
      valid: false,
      error: 'Invalid license key format',
    });
    expect(parseLicenseKey(`vc2-deadbeef-${'0'.repeat(32)}-${'a'.repeat(128)}`)).toEqual({
      valid: false,
      error: 'Invalid license key prefix',
    });
  });

  it('rejects wrong lengths, bad prefix, empty', () => {
    expect(parseLicenseKey('').valid).toBe(false);
    expect(parseLicenseKey(`vc-${LICENSE_ID}-${'a'.repeat(127)}`).error).toBe('Invalid signature');
    expect(parseLicenseKey(`vc-${LICENSE_ID.slice(1)}-${'a'.repeat(128)}`).error).toBe(
      'Invalid license ID format',
    );
    expect(parseLicenseKey(`xx-${LICENSE_ID}-${'a'.repeat(128)}`).error).toBe(
      'Invalid license key prefix',
    );
  });
});

describe('signedMessage', () => {
  it('signs the bare licenseId for a key', () => {
    expect(signedMessage({ format: 'key', licenseId: LICENSE_ID })).toBe(LICENSE_ID);
  });
  it('still signs v-… for a verdict', () => {
    expect(
      signedMessage({
        format: 'verdict',
        projectId: PROJECT_ID,
        status: 'active',
        tier: 'graphene',
        periodEnd: '2026-12-31',
        issued: '2026-09-15',
      }),
    ).toBe(`v-${PROJECT_ID.replace(/-/g, '')}-active-graphene-20261231-20260915`);
  });
});

describe('validateLicenseKey', () => {
  it('accepts a key signed by the injected pair and returns only licenseId', () => {
    expect(validateLicenseKey(mint(), { publicKeyPem: PUBLIC_PEM })).toEqual({
      valid: true,
      verified: true,
      licenseId: LICENSE_ID,
    });
  });
  it('rejects a key signed by another pair or with a tampered licenseId', () => {
    const { privateKey: other } = generateKeyPairSync('ed25519');
    expect(validateLicenseKey(mint(LICENSE_ID, other), { publicKeyPem: PUBLIC_PEM }).valid).toBe(
      false,
    );
    const tampered = mint().replace(LICENSE_ID, 'fedcba9876543210');
    expect(validateLicenseKey(tampered, { publicKeyPem: PUBLIC_PEM }).valid).toBe(false);
  });
  it('never returns valid for the embedded production key with a test signature', () => {
    expect(validateLicenseKey(mint()).valid).toBe(false);
  });
});

describe('verdict tokens', () => {
  it('accepts the two new statuses', () => {
    expect(VERDICT_STATUSES.has('unbound')).toBe(true);
    expect(VERDICT_STATUSES.has('wrong_project')).toBe(true);
    const pid32 = PROJECT_ID.replace(/-/g, '');
    const parsed = parseVerdictToken(
      `vcv-${pid32}-unbound-none-20260915-20260915-${'a'.repeat(128)}`,
    );
    expect(parsed).toMatchObject({
      valid: true,
      status: 'unbound',
      tier: 'none',
      projectId: PROJECT_ID,
    });
  });
  it('verifies a token signed over v-… with the injected pair', () => {
    const pid32 = PROJECT_ID.replace(/-/g, '');
    const msg = `v-${pid32}-wrong_project-none-20260915-20260915`;
    const sig = sign(null, Buffer.from(msg), privateKey).toString('hex');
    expect(
      verifyVerdictToken(`vcv-${pid32}-wrong_project-none-20260915-20260915-${sig}`, {
        publicKeyPem: PUBLIC_PEM,
      }),
    ).toMatchObject({
      valid: true,
      status: 'wrong_project',
      projectId: PROJECT_ID,
    });
  });
  it('verifies an unbound verdict signed over v-… with the injected pair', () => {
    const pid32 = PROJECT_ID.replace(/-/g, '');
    const msg = `v-${pid32}-unbound-none-20260915-20260915`;
    const sig = sign(null, Buffer.from(msg), privateKey).toString('hex');
    const token = `vcv-${pid32}-unbound-none-20260915-20260915-${sig}`;
    expect(verifyVerdictToken(token, { publicKeyPem: PUBLIC_PEM })).toMatchObject({
      valid: true,
      status: 'unbound',
      tier: 'none',
      projectId: PROJECT_ID,
    });
    expect(verifyVerdictToken(token).valid).toBe(false);
  });
});
