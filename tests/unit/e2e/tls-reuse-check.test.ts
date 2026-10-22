/**
 * e2e `tls_reused`: after a restore, a scale or a failover the domain must
 * serve the SAME certificate it served at verify-deploy (the snapshot put
 * back), not a new one. A fresh issuance would also pass ssl_valid, so only
 * the serial tells reuse from re-issuance. Never a hollow pass: no recorded
 * serial, or no served certificate, fails.
 *
 * `certificate_request_unchanged` (k8s tiers): a redeploy or a promotion
 * must not create a cert-manager CertificateRequest, the object every
 * issuance (and every Let's Encrypt order) starts from.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  checkNoNewCertificateRequest,
  checkTlsReused,
  parseCertificateRequestUids,
} from '../../e2e/checks/tls-reuse.js';

const D = 'app.example.com';
const served = (serialNumber: string) => async () => ({
  serialNumber,
  fingerprint256: 'AA:BB',
  validTo: '2026-12-30T08:15:00.000Z',
});

describe('checkTlsReused', () => {
  it('the same serial passes', async () => {
    const r = await checkTlsReused('04A1B2', D, { readServed: served('04A1B2') });
    expect(r.checkName).toBe('tls_reused');
    expect(r.status).toBe('pass');
    expect(r.details).toMatchObject({ previousSerial: '04A1B2', servedSerial: '04A1B2' });
  });

  it('a different serial fails, naming both and the re-issue', async () => {
    const r = await checkTlsReused('04A1B2', D, { readServed: served('0FFFFF') });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toContain('04A1B2');
    expect(r.errorMessage).toContain('0FFFFF');
    expect(r.errorMessage).toContain('re-issued instead of reused');
    // The new serial still comes back so the next step compares against it.
    expect(r.details).toMatchObject({ servedSerial: '0FFFFF' });
  });

  it('serials compare case-insensitively (hex)', async () => {
    const r = await checkTlsReused('04a1b2', D, { readServed: served('04A1B2') });
    expect(r.status).toBe('pass');
  });

  it('an empty previous serial fails without reading anything', async () => {
    const readServed = vi.fn(served('04A1B2'));
    const r = await checkTlsReused('', D, { readServed });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/no certificate serial was recorded/);
    expect(readServed).not.toHaveBeenCalled();
  });

  it('a served certificate that cannot be read (untrusted, refused) fails', async () => {
    const r = await checkTlsReused('04A1B2', D, {
      readServed: async () => {
        throw new Error('self-signed certificate');
      },
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toContain('self-signed certificate');
  });

  it('a served certificate with no serial fails', async () => {
    const r = await checkTlsReused('04A1B2', D, { readServed: served('') });
    expect(r.status).toBe('fail');
  });
});

describe('checkNoNewCertificateRequest', () => {
  it('no new CertificateRequest passes (one removed by GC is fine)', () => {
    const r = checkNoNewCertificateRequest({ before: ['u1', 'u2'], after: ['u2'], where: 'e3' });
    expect(r.checkName).toBe('certificate_request_unchanged');
    expect(r.status).toBe('pass');
  });

  it('a CertificateRequest that was not there before fails, naming it', () => {
    const r = checkNoNewCertificateRequest({ before: ['u1'], after: ['u1', 'u9'], where: 'e3' });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toContain('u9');
    expect(r.errorMessage).toContain('re-issued instead of reused');
  });

  it('a new one fails even when another was garbage-collected (same count)', () => {
    const r = checkNoNewCertificateRequest({ before: ['u1'], after: ['u9'], where: 'e3' });
    expect(r.status).toBe('fail');
  });

  it('an unread listing (before or after) fails', () => {
    expect(checkNoNewCertificateRequest({ before: null, after: [], where: 'e3' }).status).toBe(
      'fail',
    );
    expect(checkNoNewCertificateRequest({ before: [], after: null, where: 'e3' }).status).toBe(
      'fail',
    );
  });
});

describe('parseCertificateRequestUids', () => {
  it('reads the uids of a kubectl list', () => {
    expect(
      parseCertificateRequestUids(
        JSON.stringify({ items: [{ metadata: { uid: 'u1' } }, { metadata: { uid: 'u2' } }] }),
      ),
    ).toEqual(['u1', 'u2']);
  });

  it('an empty namespace is an empty list, not unread', () => {
    expect(parseCertificateRequestUids('{"items":[]}')).toEqual([]);
  });

  it('output that is not a kubectl list is unread (null)', () => {
    expect(parseCertificateRequestUids('error: the server could not find')).toBeNull();
    expect(parseCertificateRequestUids('{"kind":"Status"}')).toBeNull();
  });
});
