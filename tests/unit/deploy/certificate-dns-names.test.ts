import { describe, expect, it } from 'vitest';
import {
  certificateDnsNames,
  observabilityCertificateDnsNames,
} from '../../../src/lib/deploy/k8s/k3s.js';
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

/**
 * Two Certificates, one ClusterIssuer, one ACME account: `vibecarbon-tls` in
 * the `vibecarbon` namespace and the observability add-on's `grafana-tls` in
 * `vibecarbon-observability` (Traefik cannot read a TLS Secret across
 * namespaces, so the second cert is structural, not incidental).
 *
 * Boulder hands the SAME order to two new-order requests from one account
 * with an IDENTICAL identifier set, and cert-manager v1.20.2 marks the
 * finalize loser terminally Errored (403 orderNotReady, "Order was already
 * processing" — cert-manager#8960). That is the 2026-08-11 e2e hetzner/k8s
 * restore failure. Keeping the two identifier sets distinct is what makes
 * the shared-order race unreachable, so it is asserted, not assumed.
 */
describe('observabilityCertificateDnsNames — no shared ACME order with the app cert', () => {
  it('is apex-only — grafana routes on PathPrefix, never a Host() of its own', () => {
    expect(observabilityCertificateDnsNames(domain)).toEqual([domain]);
  });

  it('never matches the app cert identifier set on a DNS-01 issuer', () => {
    for (const provider of Object.keys(DNS01_PROVIDERS)) {
      for (const stage of ['prod', 'staging']) {
        const issuer = `letsencrypt-${stage}-${provider}`;
        expect(observabilityCertificateDnsNames(domain)).not.toEqual(
          certificateDnsNames(domain, issuer),
        );
      }
    }
  });

  it('takes the domain ALONE — no issuer parameter to reintroduce the wildcard', () => {
    // Structural, not behavioural: the app cert varies by issuer and this one
    // must not. Pinning the arity is what stops a future edit from growing an
    // `issuerName` argument and quietly making these two sets equal again on
    // some issuer — the exact shape of the bug this whole change fixes.
    expect(observabilityCertificateDnsNames).toHaveLength(1);
    expect(certificateDnsNames).toHaveLength(2);
  });

  it('returns a fresh array each call — no shared list a caller could mutate', () => {
    const first = observabilityCertificateDnsNames(domain);
    first.push(`*.${domain}`);
    expect(observabilityCertificateDnsNames(domain)).toEqual([domain]);
  });
});
