import { describe, expect, it } from 'vitest';
import {
  parseLicenseKey,
  parseVerdictToken,
  validateLicenseKey,
} from '../../../src/lib/licensing/validator.js';

describe('License Validator', () => {
  describe('parseLicenseKey', () => {
    it('parses a valid Fullerene license key', () => {
      const result = parseLicenseKey(
        'vc-f-a7f2b9c1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      );

      expect(result.valid).toBe(true);
      expect(result.tier).toBe('fullerene');
      expect(result.tierChar).toBe('f');
      expect(result.customerId).toBe('a7f2b9c1');
      expect(result.isLifetime).toBe(true);
    });

    it('keys are case-insensitive', () => {
      const result = parseLicenseKey(
        'VC-F-A7F2B9C1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      );

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
      const parsed = parseLicenseKey(
        'vc-f-a7f2b9c1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      );
      expect(parsed.valid).toBe(true);
      expect(parsed.tier).toBe('fullerene');
      expect(parsed.isLifetime).toBe(true);
    });

    it('rejects obviously invalid keys', () => {
      const result = validateLicenseKey('not-a-valid-key');
      expect(result.valid).toBe(false);
    });
  });

  describe('v2 key parsing (stable project credential)', () => {
    const sig = 'a'.repeat(128);
    const pid32 = '11111111222233334444555555555555';

    it('parses vc2-<customer>-<project32>-<sig> into customerId and hyphenated projectId', () => {
      const r = parseLicenseKey(`vc2-a1b2c3d4-${pid32}-${sig}`);
      expect(r.valid).toBe(true);
      expect(r.format).toBe('v2');
      expect(r.customerId).toBe('a1b2c3d4');
      expect(r.projectId).toBe('11111111-2222-3333-4444-555555555555');
      expect(r.tier).toBeNull();
      expect(r.paidThrough).toBeNull();
      expect(r.isLifetime).toBe(false);
    });

    it('rejects the retired 6-part dated form', () => {
      const r = parseLicenseKey(`vc2-g-a1b2c3d4-${pid32}-20270131-${sig}`);
      expect(r.valid).toBe(false);
      expect(r.error).toBe('Invalid license key format');
    });

    it('rejects a hyphenated projectId (wrong part count)', () => {
      const r = parseLicenseKey(`vc2-a1b2c3d4-11111111-2222-3333-4444-555555555555-${sig}`);
      expect(r.valid).toBe(false);
    });

    it('rejects a non-128-hex signature', () => {
      expect(parseLicenseKey(`vc2-a1b2c3d4-${pid32}-${'a'.repeat(127)}`).valid).toBe(false);
      expect(parseLicenseKey(`vc2-a1b2c3d4-${pid32}-${'z'.repeat(128)}`).valid).toBe(false);
    });
  });

  describe('verdict token parsing', () => {
    const sig = 'b'.repeat(128);
    const pid32 = '11111111222233334444555555555555';

    it('parses every field', () => {
      const r = parseVerdictToken(`vcv-${pid32}-past_due-graphene-20260930-20260914-${sig}`);
      expect(r).toMatchObject({
        valid: true,
        projectId: '11111111-2222-3333-4444-555555555555',
        status: 'past_due',
        tier: 'graphene',
        periodEnd: '2026-09-30',
        issued: '2026-09-14',
      });
    });

    it('accepts none/none', () => {
      const r = parseVerdictToken(`vcv-${pid32}-none-none-20260914-20260914-${sig}`);
      expect(r.valid).toBe(true);
      expect(r.status).toBe('none');
      expect(r.tier).toBe('none');
    });

    it.each([
      [`vcv-${pid32}-paused-graphene-20260930-20260914-${sig}`, 'Invalid verdict status'],
      [`vcv-${pid32}-active-graphite-20260930-20260914-${sig}`, 'Invalid verdict tier'],
      [`vcv-${pid32}-active-graphene-20260230-20260914-${sig}`, 'Invalid verdict date'],
      [`vcv-${pid32}-active-graphene-20260930-${sig}`, 'Invalid verdict token format'],
      [`vcv-${pid32}-active-graphene-20260930-20260914-${'b'.repeat(100)}`, 'Invalid signature'],
    ])('rejects %s', (token, error) => {
      const r = parseVerdictToken(token);
      expect(r.valid).toBe(false);
      expect(r.error).toBe(error);
    });
  });

  describe('v1 fixtures stay unchanged under the dispatching parser', () => {
    it('still parses a valid Fullerene v1 key', () => {
      const result = parseLicenseKey(
        'vc-f-a7f2b9c1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      );
      expect(result.valid).toBe(true);
      expect(result.format).toBe('v1');
      expect(result.tier).toBe('fullerene');
      expect(result.isLifetime).toBe(true);
      expect(result.projectId).toBeNull();
      expect(result.paidThrough).toBeNull();
    });
  });
});
