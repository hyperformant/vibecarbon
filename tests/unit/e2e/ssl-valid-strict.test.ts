/**
 * checkSslValid: AN UNTRUSTED CERT IS A FAILURE (d4 runs 5 + 7, 2026-08-28).
 *
 * The harness trusts the Let's Encrypt STAGING roots explicitly, so the only
 * certs that fail the trusted attempt are genuinely untrustworthy — the
 * Traefik default cert and the pilot-standby's self-signed cert. The old
 * pass-with-a-note fallback let verify-failover grade GREEN twice while the
 * promoted cluster served exactly those. The insecure attempt now exists
 * only to NAME the served cert in the failure message.
 */
import { describe, expect, it, vi } from 'vitest';
import { checkSslValid } from '../../../tests/e2e/checks/health.js';

type Attempt = {
  status: 'pass' | 'fail' | 'retry';
  checkName: string;
  responseTimeMs: number;
  details?: Record<string, unknown>;
  errorMessage?: string;
};

const trustedPass: Attempt = {
  checkName: 'ssl_valid',
  status: 'pass',
  responseTimeMs: 42,
  details: { subject: 'd4.do.appcarbon.dev', issuer: "(STAGING) Let's Encrypt" },
};
const certError: Attempt = {
  checkName: 'ssl_valid',
  status: 'retry',
  responseTimeMs: 40,
  errorMessage: 'SSL validation failed: self-signed certificate',
};
const servedDefault: Attempt = {
  checkName: 'ssl_valid',
  status: 'pass',
  responseTimeMs: 41,
  details: { subject: 'TRAEFIK DEFAULT CERT', issuer: 'TRAEFIK DEFAULT CERT' },
};

describe('checkSslValid strict trust policy', () => {
  it('passes immediately on a trusted chain', async () => {
    const attemptFn = vi.fn(async () => trustedPass);
    const res = await checkSslValid('d4.example.test', { attemptFn, sleep: async () => {} });
    expect(res.status).toBe('pass');
    expect(attemptFn).toHaveBeenCalledTimes(1);
  });

  it('NEVER passes on an untrusted cert — fails naming what was served', async () => {
    const attemptFn = vi.fn(async (rejectUnauthorized: boolean) =>
      rejectUnauthorized ? certError : servedDefault,
    );
    const res = await checkSslValid('d4.example.test', { attemptFn, sleep: async () => {} });
    expect(res.status).toBe('fail');
    expect(res.errorMessage).toContain('certificate not trusted');
    expect(res.errorMessage).toContain('TRAEFIK DEFAULT CERT');
    // The insecure attempt was diagnostics, not a verdict: no pass escaped.
  });

  it('rides through the issuance window: cert error then trusted pass', async () => {
    let calls = 0;
    const attemptFn = vi.fn(async (rejectUnauthorized: boolean) => {
      if (!rejectUnauthorized) return servedDefault;
      calls += 1;
      return calls >= 3 ? trustedPass : certError;
    });
    const res = await checkSslValid('d4.example.test', { attemptFn, sleep: async () => {} });
    expect(res.status).toBe('pass');
    expect(calls).toBe(3);
  });

  it('a hard failure (timeout shape) surfaces as fail, not retry', async () => {
    const attemptFn = vi.fn(async () => ({
      checkName: 'ssl_valid',
      status: 'fail' as const,
      responseTimeMs: 10_000,
      errorMessage: 'SSL connection timed out after 10000ms',
    }));
    const res = await checkSslValid('d4.example.test', { attemptFn, sleep: async () => {} });
    expect(res.status).toBe('fail');
    expect(res.errorMessage).toContain('timed out');
  });
});
