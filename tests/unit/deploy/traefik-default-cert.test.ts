import { describe, expect, it } from 'vitest';
import { renderTraefikDefaultCert } from '../../../src/lib/deploy/bundle.js';

const domain = 'e1.carbonstack.dev';

describe('renderTraefikDefaultCert', () => {
  describe('DNS-01 path (managed DNS — cloudflare / hetzner)', () => {
    it('uses the wildcard as the main cert entry (apex is a separate router cert)', () => {
      const yaml = renderTraefikDefaultCert({ domain, dnsChallenge: true });
      expect(yaml).toContain(`main: "*.${domain}"`);
    });

    it('does NOT include the bare apex domain (the app router owns the apex cert)', () => {
      const yaml = renderTraefikDefaultCert({ domain, dnsChallenge: true });
      // the wildcard line is `*.domain`; the bare apex must not appear as its own entry
      expect(yaml).not.toContain(`main: "${domain}"`);
      expect(yaml).not.toContain(`- "${domain}"`);
    });

    it('does NOT contain explicit subdomain sans (one wildcard is enough)', () => {
      const yaml = renderTraefikDefaultCert({
        domain,
        dnsChallenge: true,
        features: { observability: true, n8n: true, metabase: true },
      });
      expect(yaml).not.toContain(`api.${domain}`);
      expect(yaml).not.toContain(`studio.${domain}`);
      expect(yaml).not.toContain(`grafana.${domain}`);
      expect(yaml).not.toContain(`n8n.${domain}`);
    });

    it('references the letsencrypt resolver', () => {
      const yaml = renderTraefikDefaultCert({ domain, dnsChallenge: true });
      expect(yaml).toContain('resolver: letsencrypt');
    });

    it('is a valid Traefik dynamic config structure (tls.stores.default.defaultGeneratedCert)', () => {
      const yaml = renderTraefikDefaultCert({ domain, dnsChallenge: true });
      expect(yaml).toContain('tls:');
      expect(yaml).toContain('stores:');
      expect(yaml).toContain('default:');
      expect(yaml).toContain('defaultGeneratedCert:');
    });
  });

  describe('HTTP-01 path (manual DNS)', () => {
    it('does NOT contain a wildcard san', () => {
      const yaml = renderTraefikDefaultCert({ domain, dnsChallenge: false });
      expect(yaml).not.toContain('*.');
    });

    it('contains the core subdomain sans (studio, dashboard) without any add-ons', () => {
      const yaml = renderTraefikDefaultCert({ domain, dnsChallenge: false, features: {} });
      expect(yaml).toContain(`studio.${domain}`);
      expect(yaml).toContain(`dashboard.${domain}`);
      // Single-origin: Kong is path-routed on the apex — no api. host exists.
      expect(yaml).not.toContain(`api.${domain}`);
    });

    it('includes grafana and prometheus when observability is enabled', () => {
      const yaml = renderTraefikDefaultCert({
        domain,
        dnsChallenge: false,
        features: { observability: true },
      });
      expect(yaml).toContain(`grafana.${domain}`);
      expect(yaml).toContain(`prometheus.${domain}`);
    });

    it('does NOT include grafana when observability is disabled', () => {
      const yaml = renderTraefikDefaultCert({ domain, dnsChallenge: false, features: {} });
      expect(yaml).not.toContain(`grafana.${domain}`);
      expect(yaml).not.toContain(`prometheus.${domain}`);
    });

    it('includes n8n subdomain when n8n is enabled', () => {
      const yaml = renderTraefikDefaultCert({
        domain,
        dnsChallenge: false,
        features: { n8n: true },
      });
      expect(yaml).toContain(`n8n.${domain}`);
    });

    it('does NOT include n8n when it is disabled', () => {
      const yaml = renderTraefikDefaultCert({ domain, dnsChallenge: false, features: {} });
      expect(yaml).not.toContain(`n8n.${domain}`);
    });

    it('includes metabase subdomain when metabase is enabled', () => {
      const yaml = renderTraefikDefaultCert({
        domain,
        dnsChallenge: false,
        features: { metabase: true },
      });
      expect(yaml).toContain(`metabase.${domain}`);
    });

    it('does NOT include metabase when it is disabled', () => {
      const yaml = renderTraefikDefaultCert({ domain, dnsChallenge: false, features: {} });
      expect(yaml).not.toContain(`metabase.${domain}`);
    });

    it('combines all enabled add-ons correctly', () => {
      const yaml = renderTraefikDefaultCert({
        domain,
        dnsChallenge: false,
        features: { observability: true, n8n: true, metabase: true },
      });
      expect(yaml).toContain(`studio.${domain}`);
      expect(yaml).toContain(`grafana.${domain}`);
      expect(yaml).toContain(`prometheus.${domain}`);
      expect(yaml).toContain(`n8n.${domain}`);
      expect(yaml).toContain(`metabase.${domain}`);
      expect(yaml).not.toContain('*.');
    });

    it('references the letsencrypt resolver', () => {
      const yaml = renderTraefikDefaultCert({ domain, dnsChallenge: false });
      expect(yaml).toContain('resolver: letsencrypt');
    });

    it('uses studio.<domain> as main (apex app + Kong share the router cert)', () => {
      const yaml = renderTraefikDefaultCert({ domain, dnsChallenge: false });
      expect(yaml).toContain(`main: "studio.${domain}"`);
      // the bare apex must not be in the default cert
      expect(yaml).not.toContain(`main: "${domain}"`);
    });
  });

  describe('traefik subdomain (dashboard) is excluded from sans', () => {
    // traefik.domain is Traefik's own dashboard. It is NOT included in the cert
    // sans list — Traefik serves the wildcard cert for *.domain via SNI so it
    // is automatically covered. On HTTP-01 the wildcard isn't available, but
    // the traefik dashboard is an internal tool not requiring a separate SAN.
    it('does not inject traefik.domain as an explicit SAN', () => {
      const yaml = renderTraefikDefaultCert({
        domain,
        dnsChallenge: false,
        features: { observability: true },
      });
      expect(yaml).not.toContain(`traefik.${domain}`);
    });
  });
});
