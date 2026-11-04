import { describe, expect, it } from 'vitest';
import { renderTraefikDefaultCert } from '../../../src/lib/deploy/bundle.js';

const domain = 'e1.carbonstack.dev';
const all = { observability: true, n8n: true, metabase: true };

describe('renderTraefikDefaultCert (HTTP-01, explicit names)', () => {
  it('main is traefik.<domain> and the sans are grafana, n8n, metabase in that order', () => {
    const yaml = renderTraefikDefaultCert({ domain, features: all });
    expect(yaml).toContain(`main: "traefik.${domain}"`);
    const sans = [...yaml.matchAll(/^\s+- "([^"]+)"$/gm)].map((m) => m[1]);
    expect(sans).toEqual([`grafana.${domain}`, `n8n.${domain}`, `metabase.${domain}`]);
  });

  it('has no wildcard, no dashboard host and no prometheus host', () => {
    const yaml = renderTraefikDefaultCert({ domain, features: all });
    expect(yaml).not.toContain('*');
    expect(yaml).not.toContain('dashboard.');
    expect(yaml).not.toContain('prometheus');
  });

  it('covers only traefik.<domain> without any add-on (no sans key)', () => {
    const yaml = renderTraefikDefaultCert({ domain });
    expect(yaml).toContain(`main: "traefik.${domain}"`);
    expect(yaml).not.toContain('sans:');
  });

  it.each([
    ['observability', 'grafana'],
    ['n8n', 'n8n'],
    ['metabase', 'metabase'],
  ])('lists %s only when it is enabled', (feature, host) => {
    expect(renderTraefikDefaultCert({ domain, features: { [feature]: true } })).toContain(
      `"${host}.${domain}"`,
    );
    expect(renderTraefikDefaultCert({ domain, features: {} })).not.toContain(`${host}.${domain}`);
  });

  it('keeps the bare apex out (the app router owns the apex certificate)', () => {
    const yaml = renderTraefikDefaultCert({ domain, features: all });
    expect(yaml).not.toContain(`main: "${domain}"`);
    expect(yaml).not.toContain(`- "${domain}"`);
  });

  it('is a Traefik tls.stores.default.defaultGeneratedCert on the letsencrypt resolver', () => {
    const yaml = renderTraefikDefaultCert({ domain });
    for (const key of ['tls:', 'stores:', 'default:', 'defaultGeneratedCert:']) {
      expect(yaml).toContain(key);
    }
    expect(yaml).toContain('resolver: letsencrypt');
  });
});
