import { describe, expect, it } from 'vitest';
import { buildDnsProviderSecret } from '../../../src/lib/deploy/k8s/k3s.js';
import { DNS01_PROVIDERS } from '../../../src/lib/dns-provider.js';

/**
 * cert-manager Secret name + key each provider's DNS-01 solver reads, pinned
 * as literals (not derived from DNS01_PROVIDERS — a test that re-reads its
 * subject guards nothing):
 *  - cloudflare: cert-manager core `dns01.cloudflare.apiTokenSecretRef`.
 *  - hetzner: the cert-manager-webhook-hetzner chart's tokenSecretKeyRef.
 *  - digitalocean: cert-manager core `dns01.digitalocean.tokenSecretRef`,
 *    whose documented Secret is `digitalocean-dns` / key `access-token`
 *    (cert-manager.io/docs/configuration/acme/dns01/digitalocean/).
 *  - linode/vultr/scaleway: compose-only tiers — no ClusterIssuer references
 *    these, so the names are conventional placeholders, exercised here only to
 *    pin that the row shape stays uniform.
 */
const SECRET_SHAPE: Record<string, { name: string; key: string }> = {
  cloudflare: { name: 'cloudflare-api-token', key: 'api-token' },
  hetzner: { name: 'hetzner', key: 'token' },
  digitalocean: { name: 'digitalocean-dns', key: 'access-token' },
  linode: { name: 'linode-dns', key: 'token' },
  vultr: { name: 'vultr-dns', key: 'api-key' },
  scaleway: { name: 'scaleway-dns', key: 'secret-key' },
};

describe('buildDnsProviderSecret', () => {
  it('cloudflare → renders Secret/cloudflare-api-token in cert-manager namespace', () => {
    const result = buildDnsProviderSecret({
      dnsProvider: 'cloudflare',
      dnsToken: 'cf-token-abc',
    });
    expect(result?.name).toBe('cloudflare-api-token');
    expect(result?.yaml).toContain('kind: Secret');
    expect(result?.yaml).toContain('name: cloudflare-api-token');
    expect(result?.yaml).toContain('namespace: cert-manager');
    expect(result?.yaml).toContain('api-token: "cf-token-abc"');
    // Another provider's data must NOT leak into the Cloudflare Secret.
    expect(result?.yaml).not.toContain('hetzner');
  });

  it('hetzner → renders Secret/hetzner with key `token` (matches official chart)', () => {
    const result = buildDnsProviderSecret({
      dnsProvider: 'hetzner',
      dnsToken: 'hetz-cloud-xyz',
    });
    expect(result?.name).toBe('hetzner');
    expect(result?.yaml).toContain('kind: Secret');
    expect(result?.yaml).toContain('name: hetzner');
    expect(result?.yaml).toContain('namespace: cert-manager');
    expect(result?.yaml).toContain('token: "hetz-cloud-xyz"');
  });

  it('digitalocean → renders Secret/digitalocean-dns with key `access-token` (cert-manager core solver)', () => {
    const result = buildDnsProviderSecret({
      dnsProvider: 'digitalocean',
      dnsToken: 'dop_v1_abc',
    });
    expect(result?.name).toBe('digitalocean-dns');
    expect(result?.yaml).toContain('kind: Secret');
    expect(result?.yaml).toContain('name: digitalocean-dns');
    expect(result?.yaml).toContain('namespace: cert-manager');
    expect(result?.yaml).toContain('access-token: "dop_v1_abc"');
  });

  it('manual → returns null (HTTP-01 needs no Secret)', () => {
    const result = buildDnsProviderSecret({ dnsProvider: 'manual' });
    expect(result).toBeNull();
  });

  it('unknown provider → returns null (treated as manual; HTTP-01 needs no Secret)', () => {
    const result = buildDnsProviderSecret({ dnsProvider: 'route53' });
    expect(result).toBeNull();
  });

  it('cloudflare without token → throws with actionable error', () => {
    expect(() => buildDnsProviderSecret({ dnsProvider: 'cloudflare', dnsToken: '' })).toThrow(
      /CLOUDFLARE_API_TOKEN/,
    );
  });

  it('cloudflare without any token → mentions the .env.local fallback', () => {
    expect(() => buildDnsProviderSecret({ dnsProvider: 'cloudflare' })).toThrow(/\.env\.local/);
  });

  it('hetzner without token → names HETZNER_API_TOKEN env var', () => {
    expect(() => buildDnsProviderSecret({ dnsProvider: 'hetzner' })).toThrow(/HETZNER_API_TOKEN/);
  });

  it('digitalocean without token → names DIGITALOCEAN_TOKEN env var', () => {
    expect(() => buildDnsProviderSecret({ dnsProvider: 'digitalocean' })).toThrow(
      /DIGITALOCEAN_TOKEN/,
    );
  });

  it('escapes special characters in tokens via JSON.stringify', () => {
    const result = buildDnsProviderSecret({
      dnsProvider: 'cloudflare',
      dnsToken: 'token-with-"quotes"-and-\\backslash',
    });
    // JSON.stringify produces a properly-escaped YAML string literal so
    // the token can never break out of its YAML field.
    expect(result?.yaml).toContain('api-token: "token-with-\\"quotes\\"-and-\\\\backslash"');
  });
});

describe('buildDnsProviderSecret census — every DNS01_PROVIDERS row', () => {
  it('covers exactly the providers pinned above', () => {
    expect(Object.keys(DNS01_PROVIDERS).sort()).toEqual(Object.keys(SECRET_SHAPE).sort());
  });

  it('renders the pinned Secret name + key in the cert-manager namespace', () => {
    for (const [provider, { name, key }] of Object.entries(SECRET_SHAPE)) {
      const result = buildDnsProviderSecret({ dnsProvider: provider, dnsToken: 'tok' });
      expect(result?.name).toBe(name);
      expect(result?.yaml).toContain(`  name: ${name}`);
      expect(result?.yaml).toContain('  namespace: cert-manager');
      expect(result?.yaml).toContain(`  ${key}: "tok"`);
    }
  });

  it('throws its own actionable error when the token is missing', () => {
    for (const provider of Object.keys(SECRET_SHAPE)) {
      // Deploy-start failure beats an ACME Order pinned Pending 20 min in.
      expect(() => buildDnsProviderSecret({ dnsProvider: provider })).toThrow(
        DNS01_PROVIDERS[provider].missingTokenError,
      );
      expect(() => buildDnsProviderSecret({ dnsProvider: provider, dnsToken: '' })).toThrow(
        DNS01_PROVIDERS[provider].missingTokenError,
      );
    }
  });
});
