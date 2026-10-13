import { afterEach, describe, expect, it } from 'vitest';
import { allowedOrigins } from '@server/lib/origins';

const saved = { SITE_URL: process.env.SITE_URL, CORS_ORIGINS: process.env.CORS_ORIGINS };

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('allowedOrigins', () => {
  it('lists SITE_URL and each CORS_ORIGINS entry', () => {
    process.env.SITE_URL = 'https://app.example.com';
    process.env.CORS_ORIGINS = 'https://a.example.com, https://b.example.com';
    expect(allowedOrigins()).toEqual(
      expect.arrayContaining([
        'https://app.example.com',
        'https://a.example.com',
        'https://b.example.com',
      ])
    );
  });

  it.each([
    'https://*.example.com',
    'https://app?.example.com',
  ])('refuses a wildcard entry (%s): auth would treat it as a glob, CORS as a literal', (entry) => {
    process.env.SITE_URL = 'https://app.example.com';
    process.env.CORS_ORIGINS = `https://ok.example.com,${entry}`;
    expect(() => allowedOrigins()).toThrow(/CORS_ORIGINS.*wildcard/);
  });

  it('refuses a wildcard in SITE_URL too', () => {
    process.env.SITE_URL = 'https://*.example.com';
    delete process.env.CORS_ORIGINS;
    expect(() => allowedOrigins()).toThrow(/SITE_URL.*wildcard/);
  });
});
