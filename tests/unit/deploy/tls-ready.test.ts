/**
 * The TLS-ready deploy gate: a compose(-ha) deploy is not done until the
 * apex domain serves a certificate the platform trust store accepts.
 *
 * Why this exists (2026-08-29, run 33252884427): compose fired Traefik/lego
 * ACME issuance asynchronously and declared the deploy done — on
 * DigitalOcean DNS the apex cert routinely wasn't issued yet, so the domain
 * served a self-signed default (compose) or an apex-less wildcard
 * (compose-ha) and the strict e2e ssl_valid check failed 15 minutes from
 * the cause. The k8s path was green on the same provider because it AWAITS
 * cert-manager; this module gives compose the same contract.
 *
 * Pattern: pure decision function + injectable-deps poll loop
 * (waitForNewPrimaryApi / assertReplicationStreamingOrDegraded shape) —
 * no sockets in unit tests.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  assertTlsReadyOrDegraded,
  TLS_READY_BUDGET_MS,
  TLS_READY_MANUAL_BUDGET_MS,
  TLS_READY_POLL_MS,
  waitForTrustedTls,
} from '../../../src/lib/deploy/tls-ready.js';

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

describe('assertTlsReadyOrDegraded', () => {
  it('returns non-degraded when trusted', () => {
    expect(assertTlsReadyOrDegraded({ trusted: true, managedDns: true })).toEqual({
      degraded: false,
    });
  });

  it('throws an actionable error on managed DNS: reason, served cert, log tail, re-run guidance', () => {
    let thrown: Error | undefined;
    try {
      assertTlsReadyOrDegraded({
        trusted: false,
        managedDns: true,
        reason: 'self-signed certificate',
        served: { subject: 'TRAEFIK DEFAULT CERT', issuer: 'TRAEFIK DEFAULT CERT' },
        traefikLogTail: 'time="..." level=error msg="unable to obtain ACME certificate"',
        fixHint: 'Check the DNS-01 token for digitalocean.',
      });
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeDefined();
    const msg = thrown?.message ?? '';
    expect(msg).toContain('self-signed certificate');
    expect(msg).toContain('TRAEFIK DEFAULT CERT');
    expect(msg).toContain('unable to obtain ACME certificate');
    expect(msg).toContain('Check the DNS-01 token for digitalocean.');
    expect(msg).toContain('vibecarbon deploy');
  });

  it('degrades instead of throwing on manual DNS — the customer may not have pointed DNS yet', () => {
    const result = assertTlsReadyOrDegraded({
      trusted: false,
      managedDns: false,
      reason: 'getaddrinfo ENOTFOUND example.com',
    });

    expect(result.degraded).toBe(true);
    expect(result.reason).toContain('ENOTFOUND');
  });
});

describe('budget constants', () => {
  it('pins the gate budget and poll interval', () => {
    // 480s mirrors CERT_MANAGER_READY_BUDGET_MS on the k8s path: DNS-01
    // propagation on DigitalOcean's anycast POPs is the slow tail this gate
    // exists to absorb. 5s polling matches the house TLS retry cadence.
    expect(TLS_READY_BUDGET_MS).toBe(480_000);
    expect(TLS_READY_POLL_MS).toBe(5_000);
    // Manual DNS can't gate hard (the customer may not have pointed the
    // domain yet) — one short courtesy window, then degrade with a warning.
    expect(TLS_READY_MANUAL_BUDGET_MS).toBe(60_000);
  });
});
