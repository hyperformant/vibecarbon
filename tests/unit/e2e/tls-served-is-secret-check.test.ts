/**
 * e2e `tls_served_is_secret` (k8s tiers, verify-deploy): the domain must serve
 * the certificate Secret/vibecarbon-tls holds. That Secret is what the TLS
 * snapshot saves and every restore puts back, so a domain serving another
 * certificate for the same name (the observability add-on's old grafana-tls,
 * DigitalOcean k8s-ha verify-restore `tls_reused`) turns a correct restore
 * into a failure later. This check catches the second certificate at deploy,
 * where it is loaded, not at the restore it breaks.
 *
 * Never a hollow pass: no served serial (ssl_valid did not pass), no
 * kubeconfig, or an unread Secret fails.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  checkOneCertificatePerName,
  checkServedIsSecret,
  coversDomain,
  parseCertificateInventory,
  parseSecretCertificateSerial,
  parseTlsSecretInventory,
} from '../../e2e/checks/tls-reuse.js';
import { k8sSecretJson } from '../deploy/_tls-fixtures.ts';

const KC = '/proj/.vibecarbon/kubeconfig-e1';
const LIVE = k8sSecretJson({ dnsNames: ['app.example.com', '*.app.example.com'] });
const CRT_B64 = JSON.parse(LIVE).data['tls.crt'] as string;

describe('parseSecretCertificateSerial', () => {
  it("reads the leaf's serial from base64 tls.crt, in one spelling", () => {
    const serial = parseSecretCertificateSerial(CRT_B64);
    expect(serial).toMatch(/^[1-9A-F][0-9A-F]*$/);
  });

  it('null for an empty or non-certificate value', () => {
    expect(parseSecretCertificateSerial('')).toBeNull();
    expect(parseSecretCertificateSerial('bm90IGEgY2VydA==')).toBeNull();
  });
});

describe('checkServedIsSecret', () => {
  const serial = parseSecretCertificateSerial(CRT_B64) as string;

  it('passes when the domain serves the Secret certificate (any serial spelling)', () => {
    const readSecretSerial = vi.fn(() => serial);
    const r = checkServedIsSecret(`00${serial.toLowerCase()}`, KC, { readSecretSerial });
    expect(r.checkName).toBe('tls_served_is_secret');
    expect(r.status).toBe('pass');
    expect(readSecretSerial).toHaveBeenCalledWith(KC);
    expect(r.details).toMatchObject({ secretSerial: serial });
  });

  it('fails naming both serials and the second certificate when they differ', () => {
    const r = checkServedIsSecret('0FFFFF', KC, { readSecretSerial: () => serial });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toContain('FFFFF');
    expect(r.errorMessage).toContain(serial);
    expect(r.errorMessage).toContain('another certificate for the same name');
  });

  it('fails without a served serial, and never reads the Secret', () => {
    const readSecretSerial = vi.fn(() => serial);
    const r = checkServedIsSecret('', KC, { readSecretSerial });
    expect(r.status).toBe('fail');
    expect(readSecretSerial).not.toHaveBeenCalled();
  });

  it('fails without a kubeconfig or with an unread Secret', () => {
    expect(checkServedIsSecret('0FFFFF', null, { readSecretSerial: () => serial }).status).toBe(
      'fail',
    );
    const r = checkServedIsSecret('0FFFFF', KC, { readSecretSerial: () => null });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toContain('vibecarbon-tls');
  });
});

/**
 * The deterministic half. The served serial is one sample: with two
 * certificates for the name, Traefik can happen to serve the right one at
 * verify-deploy and the other after a restart. So the primary's whole
 * inventory is read too: no cert-manager Certificate and no
 * `kubernetes.io/tls` Secret other than vibecarbon/vibecarbon-tls may cover
 * the domain, in any namespace.
 */
describe('coversDomain', () => {
  it('an exact name or a one-label wildcard covers the domain', () => {
    expect(coversDomain(['app.example.com'], 'app.example.com')).toBe(true);
    expect(coversDomain(['*.example.com'], 'app.example.com')).toBe(true);
    expect(coversDomain(['*.app.example.com'], 'app.example.com')).toBe(false);
    expect(coversDomain(['*.com'], 'app.example.com')).toBe(false);
    expect(coversDomain(['other.example.com'], 'app.example.com')).toBe(false);
    expect(coversDomain(['APP.example.com'], 'app.EXAMPLE.com')).toBe(true);
  });
});

describe('parseCertificateInventory / parseTlsSecretInventory', () => {
  it('reads namespace, name and dnsNames from a Certificate list', () => {
    const json = JSON.stringify({
      items: [
        {
          metadata: { namespace: 'vibecarbon', name: 'vibecarbon-tls' },
          spec: { dnsNames: ['app.example.com', '*.app.example.com'] },
        },
      ],
    });
    expect(parseCertificateInventory(json)).toEqual([
      {
        namespace: 'vibecarbon',
        name: 'vibecarbon-tls',
        dnsNames: ['app.example.com', '*.app.example.com'],
      },
    ]);
    expect(parseCertificateInventory('not json')).toBeNull();
    expect(parseCertificateInventory('{}')).toBeNull();
  });

  it('reads the SAN names of each tls.crt, one Secret per line', () => {
    const lines = [`vibecarbon\tvibecarbon-tls\t${CRT_B64}`, 'other\tempty\t', ''].join('\n');
    expect(parseTlsSecretInventory(lines)).toEqual([
      {
        namespace: 'vibecarbon',
        name: 'vibecarbon-tls',
        dnsNames: ['app.example.com', '*.app.example.com'],
      },
      { namespace: 'other', name: 'empty', dnsNames: [] },
    ]);
  });
});

describe('checkOneCertificatePerName', () => {
  const D = 'app.example.com';
  const base = { namespace: 'vibecarbon', name: 'vibecarbon-tls', dnsNames: [D, `*.${D}`] };

  it('passes when only vibecarbon/vibecarbon-tls covers the domain', () => {
    const r = checkOneCertificatePerName({
      domain: D,
      certificates: [base, { namespace: 'x', name: 'other', dnsNames: ['other.org'] }],
      secrets: [base],
    });
    expect(r.checkName).toBe('tls_one_certificate_per_name');
    expect(r.status).toBe('pass');
  });

  it('fails naming a second Certificate that covers the domain, in any namespace', () => {
    const r = checkOneCertificatePerName({
      domain: D,
      certificates: [
        base,
        { namespace: 'vibecarbon-observability', name: 'grafana-tls', dnsNames: [D] },
      ],
      secrets: [base],
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toContain('Certificate vibecarbon-observability/grafana-tls');
  });

  it('fails naming a second TLS Secret (a wildcard covers it too)', () => {
    const r = checkOneCertificatePerName({
      domain: D,
      certificates: [base],
      secrets: [base, { namespace: 'vibecarbon', name: 'leftover', dnsNames: ['*.example.com'] }],
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toContain('Secret vibecarbon/leftover');
  });

  it('fails without a read inventory or without the base Secret (never a hollow pass)', () => {
    for (const args of [
      { certificates: null, secrets: [base] },
      { certificates: [base], secrets: null },
      { certificates: [base], secrets: [] },
    ]) {
      expect(checkOneCertificatePerName({ domain: D, ...args }).status).toBe('fail');
    }
  });
});
