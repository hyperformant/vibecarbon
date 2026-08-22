import { describe, expect, it } from 'vitest';
import { generateJWT, generatePassword } from '../../../src/create.js';

describe('generatePassword', () => {
  it('generates password of default length (32)', () => {
    const password = generatePassword();
    expect(password.length).toBe(32);
  });

  it('generates password of specified length', () => {
    expect(generatePassword(16).length).toBe(16);
    expect(generatePassword(64).length).toBe(64);
    expect(generatePassword(8).length).toBe(8);
  });

  it('generates different passwords each time', () => {
    const passwords = new Set<string>();
    for (let i = 0; i < 100; i++) {
      passwords.add(generatePassword());
    }
    // All 100 passwords should be unique
    expect(passwords.size).toBe(100);
  });

  it('replaces unsafe base64 characters with x', () => {
    // Generate many passwords and verify none contain +, /, or =
    for (let i = 0; i < 50; i++) {
      const password = generatePassword();
      expect(password).not.toContain('+');
      expect(password).not.toContain('/');
      expect(password).not.toContain('=');
    }
  });

  it('generates alphanumeric-safe characters only', () => {
    // Generate many passwords and verify they only contain safe characters
    for (let i = 0; i < 50; i++) {
      const password = generatePassword();
      expect(password).toMatch(/^[A-Za-z0-9x]+$/);
    }
  });
});

describe('generateJWT', () => {
  const testSecret = 'test-jwt-secret-key-for-testing';

  it('generates valid JWT structure (header.payload.signature)', () => {
    const jwt = generateJWT(testSecret, { role: 'anon' });
    const parts = jwt.split('.');
    expect(parts.length).toBe(3);
  });

  it('includes correct header', () => {
    const jwt = generateJWT(testSecret, { role: 'anon' });
    const [headerPart] = jwt.split('.');
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString());
    expect(header.alg).toBe('HS256');
    expect(header.typ).toBe('JWT');
  });

  it('includes payload fields from input', () => {
    const jwt = generateJWT(testSecret, { role: 'anon', iss: 'supabase', ref: 'test-project' });
    const [, payloadPart] = jwt.split('.');
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());
    expect(payload.role).toBe('anon');
    expect(payload.iss).toBe('supabase');
    expect(payload.ref).toBe('test-project');
  });

  it('includes iat (issued at) timestamp', () => {
    const beforeTime = Math.floor(Date.now() / 1000);
    const jwt = generateJWT(testSecret, { role: 'test' });
    const afterTime = Math.floor(Date.now() / 1000);

    const [, payloadPart] = jwt.split('.');
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());

    expect(payload.iat).toBeDefined();
    expect(payload.iat).toBeGreaterThanOrEqual(beforeTime);
    expect(payload.iat).toBeLessThanOrEqual(afterTime);
  });

  it('includes exp (expiration) timestamp', () => {
    const jwt = generateJWT(testSecret, { role: 'test' });
    const [, payloadPart] = jwt.split('.');
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());

    expect(payload.exp).toBeDefined();
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it('sets default expiration time of ~10 years', () => {
    const jwt = generateJWT(testSecret, { role: 'test' });
    const [, payloadPart] = jwt.split('.');
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());

    // Default exp is 315360000 seconds (~10 years)
    const expectedDiff = 315360000;
    const actualDiff = payload.exp - payload.iat;
    expect(actualDiff).toBe(expectedDiff);
  });

  it('accepts custom expiration time', () => {
    const customExp = 3600; // 1 hour
    const jwt = generateJWT(testSecret, { role: 'test' }, customExp);
    const [, payloadPart] = jwt.split('.');
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());

    const actualDiff = payload.exp - payload.iat;
    expect(actualDiff).toBe(customExp);
  });

  it('produces verifiable signature', () => {
    const jwt = generateJWT(testSecret, { role: 'anon' });
    const [header, payload, signature] = jwt.split('.');

    // Manually verify the signature
    const { createHmac } = require('node:crypto');
    const expectedSignature = createHmac('sha256', testSecret)
      .update(`${header}.${payload}`)
      .digest('base64url');

    expect(signature).toBe(expectedSignature);
  });

  it('generates different signatures for different secrets', () => {
    const payload = { role: 'anon' };
    const jwt1 = generateJWT('secret1', payload);
    const jwt2 = generateJWT('secret2', payload);

    const [, , sig1] = jwt1.split('.');
    const [, , sig2] = jwt2.split('.');

    expect(sig1).not.toBe(sig2);
  });

  it('generates different JWTs for different payloads', () => {
    const jwt1 = generateJWT(testSecret, { role: 'anon' });
    const jwt2 = generateJWT(testSecret, { role: 'service_role' });

    expect(jwt1).not.toBe(jwt2);
  });
});
