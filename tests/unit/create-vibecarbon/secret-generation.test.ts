import { describe, expect, it } from 'vitest';
import { generatePassword } from '../../../src/create.js';

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
