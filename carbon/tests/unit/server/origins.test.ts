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

  it('normalizes each entry to its origin (trailing slash, default port, case)', () => {
    process.env.SITE_URL = 'https://App.Example.com/';
    process.env.CORS_ORIGINS = 'https://a.example.com:443, http://b.example.com:80/path';
    expect(allowedOrigins()).toEqual(
      expect.arrayContaining([
        'https://app.example.com',
        'https://a.example.com',
        'http://b.example.com',
      ])
    );
    expect(allowedOrigins()).not.toContain('https://App.Example.com/');
  });

  it('refuses an entry that is not a URL, naming the variable', () => {
    process.env.SITE_URL = 'https://app.example.com';
    process.env.CORS_ORIGINS = 'app.example.com';
    expect(() => allowedOrigins()).toThrow(/CORS_ORIGINS.*app\.example\.com/);
  });

  it('refuses a wildcard in SITE_URL too', () => {
    process.env.SITE_URL = 'https://*.example.com';
    delete process.env.CORS_ORIGINS;
    expect(() => allowedOrigins()).toThrow(/SITE_URL.*wildcard/);
  });
});
