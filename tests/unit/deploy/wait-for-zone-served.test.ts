import { describe, expect, it, vi } from 'vitest';

import { waitForZoneServed } from '../../../src/lib/dns-propagation.js';

/**
 * `waitForZoneServed` — the gate that keeps DNS-01 from starting against a
 * zone the provider's own nameservers do not answer for yet.
 *
 * THE FAILURE IT PREVENTS. Linode serves DNS only for accounts holding at
 * least one active Linode. Create the zone before the instance and every
 * ns1-5.linode.com returns REFUSED while the Linode API cheerfully reports
 * `"status": "active"` — `status` is a user-settable render flag, not a
 * published-to-nameservers signal, and no API field exposes the account-level
 * gate. So the zone passes every API-shaped check, DNS-01 starts, and the
 * deploy discovers the truth ~20 minutes later when ACME gives up.
 *
 * Preflight cannot catch this: preflight runs before the instance exists,
 * which is precisely the state that produces REFUSED. The gate has to sit at
 * cert-issuance time, after the instance is up.
 *
 * WHY POLL RATHER THAN SLEEP. Linode's publish cadence is undocumented. The
 * widely-cited "~15 minutes" traces back to retired GUI text, and Linode
 * Support has quoted 30. A fixed sleep would be both too long for the common
 * case and too short for the bad one; polling the wire ends exactly when the
 * wire says it can.
 *
 * FAIL-OPEN, ALWAYS. This gate is an optimization that trades a short wait for
 * a 20-minute ACME failure. It must never be the reason a healthy deploy
 * fails, so it returns `served: false` on timeout and the caller proceeds
 * anyway. Only an explicit REFUSED/SERVFAIL — the provider answering "I do not
 * serve this" — keeps it waiting; every inconclusive state (no NS yet,
 * unresolvable NS, timeouts) also keeps it waiting but can never harden into a
 * failure.
 */

/** Build injectable resolver deps with per-call scripted behaviour. */
function deps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    resolveNs: vi.fn(async (zone: string) =>
      zone === 'example.com' ? ['ns1.linode.com'] : Promise.reject(withCode('ENODATA')),
    ),
    resolveAddr: vi.fn(async () => ['198.51.100.1']),
    soaFrom: vi.fn(async () => ({ nsname: 'ns1.linode.com' })),
    ...overrides,
  };
}

function withCode(code: string) {
  const err = new Error(code) as Error & { code: string };
  err.code = code;
  return err;
}

describe('waitForZoneServed', () => {
  it('returns served as soon as an authoritative SOA answers', async () => {
    const d = deps();
    const out = await waitForZoneServed('e1.example.com', { timeoutMs: 60_000, deps: d });

    expect(out.served).toBe(true);
    expect(d.soaFrom).toHaveBeenCalledTimes(1);
  });

  it('finds the enclosing zone by walking up labels', async () => {
    // The deploy knows the FQDN, not the zone. `e1.example.com` is a record in
    // zone `example.com`, so NS must be sought at the parent.
    const d = deps();
    await waitForZoneServed('e1.example.com', { timeoutMs: 60_000, deps: d });

    expect(d.resolveNs).toHaveBeenCalledWith('e1.example.com');
    expect(d.resolveNs).toHaveBeenCalledWith('example.com');
    // Probes the zone it actually found, not the bare FQDN.
    expect(d.soaFrom).toHaveBeenCalledWith('198.51.100.1', 'example.com');
  });

  it('prefers a delegated child zone over its parent', async () => {
    // do.appcarbon.dev is delegated; records for d1.do.appcarbon.dev are only
    // served there. Walking up must stop at the FIRST zone that answers.
    const d = deps({
      resolveNs: vi.fn(async (zone: string) =>
        zone === 'do.appcarbon.dev'
          ? ['ns1.digitalocean.com']
          : Promise.reject(withCode('ENODATA')),
      ),
    });
    await waitForZoneServed('d1.do.appcarbon.dev', { timeoutMs: 60_000, deps: d });

    expect(d.soaFrom).toHaveBeenCalledWith('198.51.100.1', 'do.appcarbon.dev');
  });

  it('keeps polling through REFUSED and returns served once it clears', async () => {
    // The Linode shape exactly: REFUSED until the account gate opens.
    const soaFrom = vi
      .fn()
      .mockRejectedValueOnce(withCode('REFUSED'))
      .mockRejectedValueOnce(withCode('REFUSED'))
      .mockResolvedValueOnce({ nsname: 'ns1.linode.com' });
    const d = deps({ soaFrom });

    const out = await waitForZoneServed('e1.example.com', {
      timeoutMs: 60_000,
      pollIntervalMs: 1,
      deps: d,
    });

    expect(out.served).toBe(true);
    expect(soaFrom).toHaveBeenCalledTimes(3);
  });

  it('keeps polling through SERVFAIL', async () => {
    const soaFrom = vi
      .fn()
      .mockRejectedValueOnce(withCode('SERVFAIL'))
      .mockResolvedValueOnce({ nsname: 'ns1.linode.com' });
    const d = deps({ soaFrom });

    const out = await waitForZoneServed('e1.example.com', {
      timeoutMs: 60_000,
      pollIntervalMs: 1,
      deps: d,
    });

    expect(out.served).toBe(true);
    expect(soaFrom).toHaveBeenCalledTimes(2);
  });

  it('keeps polling while delegation is not visible yet, then succeeds', async () => {
    // "No NS records anywhere" is the earliest state of a brand-new zone —
    // indistinguishable from a broken one, so it must not end the wait early.
    let attempt = 0;
    const d = deps({
      resolveNs: vi.fn(async (zone: string) => {
        if (zone !== 'example.com') throw withCode('ENODATA');
        attempt += 1;
        if (attempt < 3) throw withCode('ENOTFOUND');
        return ['ns1.linode.com'];
      }),
    });

    const out = await waitForZoneServed('e1.example.com', {
      timeoutMs: 60_000,
      pollIntervalMs: 1,
      deps: d,
    });

    expect(out.served).toBe(true);
  });

  it('gives up at the timeout and reports NOT served, without throwing', async () => {
    // Fail-open: the caller proceeds anyway. A throw here would convert a
    // slow-publishing zone into a failed deploy — strictly worse than the
    // 20-minute ACME failure this gate exists to avoid.
    const d = deps({ soaFrom: vi.fn().mockRejectedValue(withCode('REFUSED')) });

    const out = await waitForZoneServed('e1.example.com', {
      timeoutMs: 30,
      pollIntervalMs: 1,
      deps: d,
    });

    expect(out.served).toBe(false);
    expect(out.detail).toMatch(/REFUSED/);
  });

  it('never throws even when every resolver call rejects', async () => {
    const d = deps({
      resolveNs: vi.fn().mockRejectedValue(new Error('boom')),
      resolveAddr: vi.fn().mockRejectedValue(new Error('boom')),
      soaFrom: vi.fn().mockRejectedValue(new Error('boom')),
    });

    const out = await waitForZoneServed('e1.example.com', {
      timeoutMs: 30,
      pollIntervalMs: 1,
      deps: d,
    });

    expect(out.served).toBe(false);
  });

  it('reports elapsed time so the caller can log a real number', async () => {
    const d = deps();
    const out = await waitForZoneServed('e1.example.com', { timeoutMs: 60_000, deps: d });
    expect(typeof out.waitedMs).toBe('number');
    expect(out.waitedMs).toBeGreaterThanOrEqual(0);
  });

  it('does not probe below a public suffix', async () => {
    // Walking up must not end up asking for the SOA of `com`. With no zone
    // found at any level the probe stays inconclusive and the gate times out
    // rather than probing a TLD.
    const d = deps({ resolveNs: vi.fn().mockRejectedValue(withCode('ENODATA')) });

    const out = await waitForZoneServed('e1.example.com', {
      timeoutMs: 30,
      pollIntervalMs: 1,
      deps: d,
    });

    expect(out.served).toBe(false);
    for (const call of (d.resolveNs as ReturnType<typeof vi.fn>).mock.calls) {
      expect(String(call[0]).split('.').length).toBeGreaterThanOrEqual(2);
    }
  });
});
