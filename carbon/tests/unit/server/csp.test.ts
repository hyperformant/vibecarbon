import { describe, expect, it } from 'vitest';
import { buildConnectSrc } from '@server/lib/csp';

const base = {
  siteUrl: 'https://app.example.com',
  supabaseUrl: undefined,
  s3Endpoint: undefined,
  plausibleOrigin: null,
};

describe('buildConnectSrc', () => {
  it('includes the S3 endpoint origin when S3_ENDPOINT is set', () => {
    const src = buildConnectSrc({ ...base, s3Endpoint: 'https://fsn1.your-objectstorage.com/' });
    expect(src).toContain('https://fsn1.your-objectstorage.com');
  });

  it('uses the origin only, dropping any path on the endpoint', () => {
    const src = buildConnectSrc({ ...base, s3Endpoint: 'https://s3.example.com:9000/some/path' });
    expect(src).toContain('https://s3.example.com:9000');
    expect(src.some((s) => s.includes('/some/path'))).toBe(false);
  });

  it('omits any S3 origin when S3_ENDPOINT is unset', () => {
    expect(buildConnectSrc(base)).toEqual([
      "'self'",
      'https://app.example.com',
      'https://cloudflareinsights.com',
      'https://api.github.com',
    ]);
  });

  it('ignores an unparseable S3 endpoint instead of throwing', () => {
    expect(buildConnectSrc({ ...base, s3Endpoint: 'not a url' })).toHaveLength(4);
  });

  it('falls back to SUPABASE_URL and appends the plausible origin', () => {
    const src = buildConnectSrc({
      ...base,
      siteUrl: undefined,
      supabaseUrl: 'https://api.example.com',
      plausibleOrigin: 'https://plausible.io',
    });
    expect(src).toContain('https://api.example.com');
    expect(src).toContain('https://plausible.io');
  });
});
