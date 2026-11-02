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
import { checkServedIsSecret, parseSecretCertificateSerial } from '../../e2e/checks/tls-reuse.js';
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
