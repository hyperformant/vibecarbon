import { describe, expect, it } from 'vitest';
import { getBranchName, normalizeEnvName } from '../../../src/deploy.js';

describe('normalizeEnvName', () => {
  it('converts to lowercase', () => {
    expect(normalizeEnvName('PROD')).toBe('prod');
    expect(normalizeEnvName('Staging')).toBe('staging');
    expect(normalizeEnvName('DEV')).toBe('dev');
  });

  it('converts "production" to "prod"', () => {
    expect(normalizeEnvName('production')).toBe('prod');
    expect(normalizeEnvName('Production')).toBe('prod');
    expect(normalizeEnvName('PRODUCTION')).toBe('prod');
  });

  it('preserves other environment names', () => {
    expect(normalizeEnvName('staging')).toBe('staging');
    expect(normalizeEnvName('dev')).toBe('dev');
    expect(normalizeEnvName('qa')).toBe('qa');
    expect(normalizeEnvName('test')).toBe('test');
  });

  it('handles edge cases', () => {
    expect(normalizeEnvName('prod')).toBe('prod');
    expect(normalizeEnvName('Prod')).toBe('prod');
  });
});

describe('getBranchName', () => {
  it('returns "main" for prod environment', () => {
    expect(getBranchName('prod')).toBe('main');
  });

  it('returns environment name for other environments', () => {
    expect(getBranchName('staging')).toBe('staging');
    expect(getBranchName('dev')).toBe('dev');
    expect(getBranchName('qa')).toBe('qa');
    expect(getBranchName('test')).toBe('test');
    expect(getBranchName('feature-x')).toBe('feature-x');
  });

  it('does not return main for "production" (should be normalized first)', () => {
    // Note: In practice, normalizeEnvName should be called first
    // This test documents the current behavior
    expect(getBranchName('production')).toBe('production');
  });
});
