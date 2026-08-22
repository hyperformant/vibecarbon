/**
 * Shared env-summary module tests — ensuring masking logic is consistent
 * across configure.js and configure-providers.js.
 */
import { describe, expect, it } from 'vitest';
import { envSummaryLines, maskEnvValue } from '../../../src/lib/env-summary.js';

describe('maskEnvValue', () => {
  const isSecret = (key: string) => key.includes('SECRET') || key.includes('TOKEN');

  it('returns unmasked value for non-secret keys', () => {
    expect(maskEnvValue('PROJECT_NAME', 'my-project', isSecret)).toBe('my-project');
  });

  it('masks secret values with 4 leading chars + padding', () => {
    expect(maskEnvValue('API_TOKEN', 'abcdefghijklmnop', isSecret)).toBe('abcd••••••••');
  });

  it('masks short secret values (≤4 chars) as ••••', () => {
    expect(maskEnvValue('SECRET_KEY', 'abcd', isSecret)).toBe('••••');
    expect(maskEnvValue('SECRET_KEY', 'ab', isSecret)).toBe('••••');
  });
});

describe('envSummaryLines', () => {
  const isSecret = (key: string) => key.includes('SECRET') || key.includes('TOKEN');

  it('returns formatted lines for set values', () => {
    const env = {
      STRIPE_SECRET_KEY: 'sk_test_123456789',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PASS: 'password123',
    };
    const lines = envSummaryLines(env, ['STRIPE_SECRET_KEY', 'SMTP_HOST', 'SMTP_PASS'], isSecret);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/STRIPE_SECRET_KEY/);
    expect(lines[0]).toMatch(/sk_t/); // masked
    expect(lines[1]).toMatch(/SMTP_HOST.*smtp.example.com/); // unmasked (not secret)
    expect(lines[2]).toMatch(/SMTP_PASS/);
  });

  it('skips undefined values', () => {
    const env = { STRIPE_SECRET_KEY: undefined };
    const lines = envSummaryLines(env, ['STRIPE_SECRET_KEY'], isSecret);
    expect(lines).toEqual([]);
  });

  it('skips empty string values', () => {
    const env = { STRIPE_SECRET_KEY: '' };
    const lines = envSummaryLines(env, ['STRIPE_SECRET_KEY'], isSecret);
    expect(lines).toEqual([]);
  });

  it('handles mixed presence of keys', () => {
    const env = { STRIPE_SECRET_KEY: 'sk_test_123' };
    const lines = envSummaryLines(env, ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'], isSecret);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/STRIPE_SECRET_KEY/);
  });

  it('returns empty array when no keys are set', () => {
    const env = { UNRELATED_VAR: 'value' };
    const lines = envSummaryLines(env, ['STRIPE_SECRET_KEY'], isSecret);
    expect(lines).toEqual([]);
  });
});
