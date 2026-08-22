import { describe, expect, it } from 'vitest';
import { parseLicenseKey, validateLicenseKey } from '../../../src/lib/licensing/validator.js';

describe('License Validator', () => {
  describe('parseLicenseKey', () => {
    it('parses a valid Fullerene license key', () => {
      const result = parseLicenseKey('vc-f-a7f2b9c1-x8kd9mwp2v4n');

      expect(result.valid).toBe(true);
      expect(result.tier).toBe('fullerene');
      expect(result.tierChar).toBe('f');
      expect(result.customerId).toBe('a7f2b9c1');
      expect(result.isLifetime).toBe(true);
    });

    it('keys are case-insensitive', () => {
      const result = parseLicenseKey('VC-F-A7F2B9C1-X8KD9MWP2V4N');

      expect(result.valid).toBe(true);
      expect(result.tier).toBe('fullerene');
      expect(result.customerId).toBe('a7f2b9c1');
    });

    it('rejects the retired Diamond tier character', () => {
      expect(parseLicenseKey('vc-d-a7f2b9c1-signature1234').valid).toBe(false);
    });

    it('rejects key with invalid tier character', () => {
      expect(parseLicenseKey('vc-x-a7f2b9c1-signature1234').valid).toBe(false);
      expect(parseLicenseKey('vc-p-a7f2b9c1-signature1234').valid).toBe(false);
    });

    it('rejects key with invalid customer ID (not 8 hex chars)', () => {
      expect(parseLicenseKey('vc-f-short-signature1234').valid).toBe(false);
      expect(parseLicenseKey('vc-f-ZZZZZZZZ-signature1234').valid).toBe(false);
    });

    it('rejects key with missing or short signature', () => {
      expect(parseLicenseKey('vc-f-a7f2b9c1').valid).toBe(false);
      expect(parseLicenseKey('vc-f-a7f2b9c1-abc').valid).toBe(false);
    });

    it('rejects null or undefined input', () => {
      expect(parseLicenseKey(null as unknown as string).valid).toBe(false);
      expect(parseLicenseKey(undefined as unknown as string).valid).toBe(false);
      expect(parseLicenseKey('').valid).toBe(false);
    });

    it('rejects invalid prefix', () => {
      const result = parseLicenseKey('INVALID-f-a7f2b9c1-SIGNATURE');
      expect(result.valid).toBe(false);
    });

    it('rejects legacy CARBON- format (no longer supported)', () => {
      const result = parseLicenseKey('CARBON-PRO-ABC12345-20270115-SIGNATURE123');
      expect(result.valid).toBe(false);
    });
  });

  describe('validateLicenseKey', () => {
    it('validates key format correctly for Fullerene', () => {
      const parsed = parseLicenseKey('vc-f-a7f2b9c1-x8kd9mwp2v4n');
      expect(parsed.valid).toBe(true);
      expect(parsed.tier).toBe('fullerene');
      expect(parsed.isLifetime).toBe(true);
    });

    it('rejects obviously invalid keys', () => {
      const result = validateLicenseKey('not-a-valid-key');
      expect(result.valid).toBe(false);
    });
  });
});
