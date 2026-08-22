import { describe, expect, it } from 'vitest';
import { pickIssuerName } from '../../../src/lib/deploy/k8s/k3s.js';
import { DNS01_PROVIDERS } from '../../../src/lib/dns-provider.js';

const STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';
const PROD = 'https://acme-v02.api.letsencrypt.org/directory';

describe('pickIssuerName', () => {
  it('cloudflare + staging → letsencrypt-staging-cloudflare', () => {
    expect(pickIssuerName({ dnsProvider: 'cloudflare', acmeServer: STAGING })).toBe(
      'letsencrypt-staging-cloudflare',
    );
  });

  it('cloudflare + prod → letsencrypt-prod-cloudflare', () => {
    expect(pickIssuerName({ dnsProvider: 'cloudflare', acmeServer: PROD })).toBe(
      'letsencrypt-prod-cloudflare',
    );
  });

  it('hetzner + staging → letsencrypt-staging-hetzner', () => {
    expect(pickIssuerName({ dnsProvider: 'hetzner', acmeServer: STAGING })).toBe(
      'letsencrypt-staging-hetzner',
    );
  });

  it('hetzner + prod → letsencrypt-prod-hetzner', () => {
    expect(pickIssuerName({ dnsProvider: 'hetzner', acmeServer: PROD })).toBe(
      'letsencrypt-prod-hetzner',
    );
  });

  it('digitalocean + staging → letsencrypt-staging-digitalocean', () => {
    expect(pickIssuerName({ dnsProvider: 'digitalocean', acmeServer: STAGING })).toBe(
      'letsencrypt-staging-digitalocean',
    );
  });

  it('digitalocean + prod → letsencrypt-prod-digitalocean', () => {
    expect(pickIssuerName({ dnsProvider: 'digitalocean', acmeServer: PROD })).toBe(
      'letsencrypt-prod-digitalocean',
    );
  });

  it('manual + staging → letsencrypt-staging-manual', () => {
    expect(pickIssuerName({ dnsProvider: 'manual', acmeServer: STAGING })).toBe(
      'letsencrypt-staging-manual',
    );
  });

  it('manual + prod → letsencrypt-prod-manual', () => {
    expect(pickIssuerName({ dnsProvider: 'manual', acmeServer: PROD })).toBe(
      'letsencrypt-prod-manual',
    );
  });

  it('unknown provider falls back to manual (so future enum values do not deploy a Certificate referencing a non-existent issuer)', () => {
    expect(pickIssuerName({ dnsProvider: 'route53', acmeServer: PROD })).toBe(
      'letsencrypt-prod-manual',
    );
  });

  it('no provider + no server → letsencrypt-prod-manual (safe default)', () => {
    expect(pickIssuerName({})).toBe('letsencrypt-prod-manual');
  });

  it('provider null + acmeServer null → manual prod', () => {
    expect(pickIssuerName({ dnsProvider: null, acmeServer: null })).toBe('letsencrypt-prod-manual');
  });
});

describe('pickIssuerName census — every DNS01_PROVIDERS row gets its own suffix', () => {
  // The suffix is the provider id verbatim, for every row in the table.
  // Providers that reach the k8s tier must therefore ship a matching
  // cluster-issuers-<id>.yaml; that side of the contract is guarded in
  // tests/integration/template/manifest-dry-run.test.ts.
  it('maps each provider to letsencrypt-{stage}-{provider} in both stages', () => {
    for (const provider of Object.keys(DNS01_PROVIDERS)) {
      expect(pickIssuerName({ dnsProvider: provider, acmeServer: PROD })).toBe(
        `letsencrypt-prod-${provider}`,
      );
      expect(pickIssuerName({ dnsProvider: provider, acmeServer: STAGING })).toBe(
        `letsencrypt-staging-${provider}`,
      );
    }
  });
});
