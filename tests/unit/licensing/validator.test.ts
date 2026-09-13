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

  describe('parseLicenseKey (v2)', () => {
    const PROJECT_ID32 = '11112222333344445555666677778888';
    const SIG = 'a'.repeat(128);

    it('parses a valid Graphene v2 key (happy path)', () => {
      const result = parseLicenseKey(`vc2-g-a7f2b9c1-${PROJECT_ID32}-20271231-${SIG}`);

      expect(result.valid).toBe(true);
      expect(result.format).toBe('v2');
      expect(result.tier).toBe('graphene');
      expect(result.tierChar).toBe('g');
      expect(result.customerId).toBe('a7f2b9c1');
      expect(result.projectId).toBe('11112222-3333-4444-5555-666677778888');
      expect(result.paidThrough).toBe('2027-12-31');
      expect(result.isLifetime).toBe(false);
    });

    it('parses a valid Fullerene v2 key, still reporting tier fullerene', () => {
      const result = parseLicenseKey(`vc2-f-a7f2b9c1-${PROJECT_ID32}-20271231-${SIG}`);

      expect(result.valid).toBe(true);
      expect(result.format).toBe('v2');
      expect(result.tier).toBe('fullerene');
      expect(result.isLifetime).toBe(false);
    });

    it('rejects a key with too few parts (5)', () => {
      // Missing the date segment.
      const result = parseLicenseKey(`vc2-g-a7f2b9c1-${PROJECT_ID32}-${SIG}`);
      expect(result.valid).toBe(false);
    });

    it('rejects a key with too many parts (7)', () => {
      const result = parseLicenseKey(`vc2-g-a7f2b9c1-${PROJECT_ID32}-20271231-extra-${SIG}`);
      expect(result.valid).toBe(false);
    });

    it('rejects an invalid v2 tier character', () => {
      const result = parseLicenseKey(`vc2-x-a7f2b9c1-${PROJECT_ID32}-20271231-${SIG}`);
      expect(result.valid).toBe(false);
    });

    it('rejects an invalid calendar date (month 13)', () => {
      const result = parseLicenseKey(`vc2-g-a7f2b9c1-${PROJECT_ID32}-20271301-${SIG}`);
      expect(result.valid).toBe(false);
    });

    it('rejects a dashed projectId inside the key (collides with the separator)', () => {
      const dashed = '11112222-3333-4444-5555-666677778888';
      const result = parseLicenseKey(`vc2-g-a7f2b9c1-${dashed}-20271231-${SIG}`);
      expect(result.valid).toBe(false);
    });

    it('accepts uppercase input, case-insensitively', () => {
      const result = parseLicenseKey(
        `VC2-G-A7F2B9C1-${PROJECT_ID32.toUpperCase()}-20271231-${SIG.toUpperCase()}`,
      );
      expect(result.valid).toBe(true);
      expect(result.tier).toBe('graphene');
      expect(result.projectId).toBe('11112222-3333-4444-5555-666677778888');
      expect(result.paidThrough).toBe('2027-12-31');
    });
  });

  describe('v1 fixtures stay unchanged under the dispatching parser', () => {
    it('still parses a valid Fullerene v1 key', () => {
      const result = parseLicenseKey('vc-f-a7f2b9c1-x8kd9mwp2v4n');
      expect(result.valid).toBe(true);
      expect(result.format).toBe('v1');
      expect(result.tier).toBe('fullerene');
      expect(result.isLifetime).toBe(true);
      expect(result.projectId).toBeNull();
      expect(result.paidThrough).toBeNull();
    });
  });
});
