/**
 * The compose(-ha) TLS verdict: a deploy reports its TLS state; it does not
 * wait out a CA. It looks for a trusted apex certificate for a bounded
 * first-look window, then finishes trusted or pending.
 *
 * Why this exists (2026-08-29, run 33252884427): compose fired Traefik/lego
 * ACME issuance asynchronously and declared the deploy done — on
 * DigitalOcean DNS the apex cert routinely wasn't issued yet, so the domain
 * served a self-signed default (compose) or an apex-less wildcard
 * (compose-ha) and the strict e2e ssl_valid check failed 15 minutes from
 * the cause. The gate then waited up to 480s and failed the deploy; a slow
 * CA failed deploys whose app was healthy. Now the verdict is recorded
 * (envConfig.tls) and the server's tls-retry cron finishes issuance.
 *
 * Pattern: pure decision function + injectable-deps poll loop
 * (waitForNewPrimaryApi / assertReplicationStreamingOrDegraded shape) —
 * no sockets in unit tests.
 */
import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import { describe, expect, it, vi } from 'vitest';
import {
  probeTlsTrustOnce,
  TLS_FIRST_LOOK_BUDGET_MS,
  TLS_READY_MANUAL_BUDGET_MS,
  TLS_READY_POLL_MS,
  tlsVerdict,
  waitForTrustedTls,
} from '../../../src/lib/deploy/tls-ready.js';

import { makeCert } from './_tls-fixtures.js';

const noSleep = () => Promise.resolve();

/** A fake clock advancing `stepMs` per now() call after the first. */
function fakeNow(stepMs: number) {
  let t = 0;
  return () => {
    const v = t;
    t += stepMs;
    return v;
  };
}

describe('waitForTrustedTls', () => {
  it('returns trusted on the first successful probe without sleeping', async () => {
    const probe = vi.fn().mockResolvedValue({ trusted: true });
    const sleep = vi.fn(noSleep);

    const result = await waitForTrustedTls('cid1.do.example.dev', { probe, sleep });

    expect(result.trusted).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries untrusted probes at the poll interval until trust appears', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ trusted: false, reason: 'self-signed certificate' })
      .mockResolvedValueOnce({ trusted: false, reason: 'self-signed certificate' })
      .mockResolvedValue({ trusted: true });
    const sleep = vi.fn(noSleep);

    const result = await waitForTrustedTls('cid1.do.example.dev', { probe, sleep });

    expect(result.trusted).toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(TLS_READY_POLL_MS);
  });

  it('treats a thrown probe (connection refused, DNS not yet propagated) as retryable', async () => {
    const probe = vi
      .fn()
      .mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND cid1.do.example.dev'))
      .mockResolvedValue({ trusted: true });

    const result = await waitForTrustedTls('cid1.do.example.dev', { probe, sleep: noSleep });

    expect(result.trusted).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('gives up at the budget, preserving the last probe outcome for the error message', async () => {
    const probe = vi.fn().mockResolvedValue({
      trusted: false,
      reason: "Hostname/IP does not match certificate's altnames",
      served: { subject: '*.cid2.do.example.dev', issuer: '(STAGING) Wannabe Watercress R11' },
    });

    const result = await waitForTrustedTls('cid2.do.example.dev', {
      probe,
      sleep: noSleep,
      budgetMs: 30_000,
      intervalMs: 10_000,
      now: fakeNow(10_000),
    });

    expect(result.trusted).toBe(false);
    expect(result.reason).toContain('does not match');
    expect(result.served).toEqual({
      subject: '*.cid2.do.example.dev',
      issuer: '(STAGING) Wannabe Watercress R11',
    });
    // fakeNow steps 10s per check against a 30s budget — a bounded number
    // of attempts, not one, not unbounded.
    expect(probe.mock.calls.length).toBeGreaterThan(1);
    expect(probe.mock.calls.length).toBeLessThanOrEqual(4);
  });
});

describe('tlsVerdict', () => {
  it('is trusted when the probe trusted the chain', () => {
    expect(tlsVerdict({ trusted: true })).toEqual({ state: 'trusted' });
  });

  it('is pending, never a throw, on managed DNS: the deploy reports its TLS state', () => {
    let verdict: ReturnType<typeof tlsVerdict> | undefined;
    expect(() => {
      verdict = tlsVerdict({ trusted: false, managedDns: true, reason: 'x' });
    }).not.toThrow();
    expect(verdict).toMatchObject({ state: 'pending', reason: 'x' });
  });

  it('carries the served cert, the fix hint and the log tail in its detail', () => {
    const verdict = tlsVerdict({
      trusted: false,
      managedDns: true,
      reason: 'self-signed certificate',
      served: { subject: 'TRAEFIK DEFAULT CERT', issuer: 'TRAEFIK DEFAULT CERT' },
      traefikLogTail: 'time="..." level=error msg="unable to obtain ACME certificate"',
      fixHint: 'Check the DNS-01 token for digitalocean.',
    });

    expect(verdict.state).toBe('pending');
    expect(verdict.reason).toBe('self-signed certificate');
    const detail = verdict.detail ?? '';
    expect(detail).toContain('TRAEFIK DEFAULT CERT');
    expect(detail).toContain('unable to obtain ACME certificate');
    expect(detail).toContain('Check the DNS-01 token for digitalocean.');
  });

  it('is pending on manual DNS too: the customer may not have pointed DNS yet', () => {
    const verdict = tlsVerdict({
      trusted: false,
      managedDns: false,
      reason: 'getaddrinfo ENOTFOUND example.com',
    });

    expect(verdict.state).toBe('pending');
    expect(verdict.reason).toContain('ENOTFOUND');
  });
});

describe('budget constants', () => {
  it('pins the first-look budget and poll interval', () => {
    // 180s: the DNS-01 settle floor puts healthy issuance at about 120s
    // (2026-10-20 trials: wildcard 119s, apex 124s). A slower CA no longer
    // holds the deploy open: it finishes with TLS pending and the server's
    // tls-retry cron takes over. 5s polling matches the house TLS cadence.
    expect(TLS_FIRST_LOOK_BUDGET_MS).toBe(180_000);
    expect(TLS_READY_POLL_MS).toBe(5_000);
    // Manual DNS: one short courtesy window, then pending.
    expect(TLS_READY_MANUAL_BUDGET_MS).toBe(60_000);
  });

  it('uses the first-look budget when the caller names none', async () => {
    const probe = vi.fn().mockResolvedValue({ trusted: false, reason: 'self-signed certificate' });
    const result = await waitForTrustedTls('cid3.do.example.dev', {
      probe,
      sleep: noSleep,
      intervalMs: 60_000,
      now: fakeNow(60_000),
    });

    expect(result.trusted).toBe(false);
    // The fake clock steps 60s per read (the start read included), so 180s
    // allows 3 probes; the old 480s default would have allowed 8.
    expect(probe).toHaveBeenCalledTimes(3);
  });
});

describe('probeTlsTrustOnce', () => {
  /** A local TLS server presenting `cert`; resolves its port. */
  async function serve(cert: string, key: string) {
    const server = tls.createServer({ cert, key }, (s) => s.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, port: (server.address() as { port: number }).port };
  }

  it('a trusted handshake names the expiry and serial it verified, nothing more', async () => {
    const { cert, key, ca } = makeCert(['localhost'], 30);
    const { server, port } = await serve(cert, key);
    try {
      const result = await probeTlsTrustOnce('localhost', { port, ca: [ca as string] });
      const x509 = new X509Certificate(cert);
      expect(result).toEqual({
        trusted: true,
        validTo: new Date(x509.validTo).toISOString(),
        serialNumber: x509.serialNumber,
      });
    } finally {
      server.close();
    }
  });

  it('an untrusted chain is not trusted and names what was served', async () => {
    const { cert, key } = makeCert(['localhost'], { selfSigned: true });
    const other = makeCert(['localhost']);
    const { server, port } = await serve(cert, key);
    try {
      const result = await probeTlsTrustOnce('localhost', { port, ca: [other.ca as string] });
      expect(result.trusted).toBe(false);
      expect(result).toMatchObject({ served: { subject: 'localhost', issuer: 'localhost' } });
      expect(result).not.toHaveProperty('serialNumber');
    } finally {
      server.close();
    }
  });
});
