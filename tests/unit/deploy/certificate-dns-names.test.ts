import { describe, expect, it } from 'vitest';
import { certificateDnsNames } from '../../../src/lib/deploy/k8s/k3s.js';
import { DNS01_PROVIDERS } from '../../../src/lib/dns-provider.js';

const domain = 'e1.carbonstack.dev';

describe('certificateDnsNames', () => {
  it('returns [domain, *.domain] for a hetzner (DNS-01) issuer', () => {
    expect(certificateDnsNames(domain, 'letsencrypt-prod-hetzner')).toEqual([
      domain,
      `*.${domain}`,
    ]);
  });

  it('returns [domain, *.domain] for a cloudflare (DNS-01) issuer', () => {
    expect(certificateDnsNames(domain, 'letsencrypt-prod-cloudflare')).toEqual([
      domain,
      `*.${domain}`,
    ]);
  });

  it('returns [domain, *.domain] for a digitalocean (DNS-01) issuer', () => {
    expect(certificateDnsNames(domain, 'letsencrypt-prod-digitalocean')).toEqual([
      domain,
      `*.${domain}`,
    ]);
  });

  it('returns [domain, *.domain] for a staging-hetzner issuer (DNS-01 in staging)', () => {
    expect(certificateDnsNames(domain, 'letsencrypt-staging-hetzner')).toEqual([
      domain,
      `*.${domain}`,
    ]);
  });

  it('returns [domain, *.domain] for a staging-cloudflare issuer', () => {
    expect(certificateDnsNames(domain, 'letsencrypt-staging-cloudflare')).toEqual([
      domain,
      `*.${domain}`,
    ]);
  });

  it('returns [domain] only for a manual issuer (HTTP-01 cannot issue wildcards)', () => {
    expect(certificateDnsNames(domain, 'letsencrypt-prod-manual')).toEqual([domain]);
  });

  it('returns [domain] only for a staging-manual issuer', () => {
    expect(certificateDnsNames(domain, 'letsencrypt-staging-manual')).toEqual([domain]);
  });

  it('defaults to [domain] only for an unrecognised issuer name (safe fallback)', () => {
    expect(certificateDnsNames(domain, 'some-future-issuer')).toEqual([domain]);
  });
});

describe('certificateDnsNames census — wildcard for every DNS-01 issuer', () => {
  it('grants a wildcard SAN to every DNS01_PROVIDERS issuer in both stages', () => {
    for (const provider of Object.keys(DNS01_PROVIDERS)) {
      for (const stage of ['prod', 'staging']) {
        expect(certificateDnsNames(domain, `letsencrypt-${stage}-${provider}`)).toEqual([
          domain,
          `*.${domain}`,
        ]);
      }
    }
  });

  it('never grants a wildcard to a manual (HTTP-01) issuer', () => {
    for (const stage of ['prod', 'staging']) {
      expect(certificateDnsNames(domain, `letsencrypt-${stage}-manual`)).toEqual([domain]);
    }
  });
});
