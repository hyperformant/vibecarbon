import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — JS module without types
import {
  makePublicDnsLookup,
  PUBLIC_DNS_BUDGET_MS,
  PUBLIC_DNS_SERVERS,
  resolvePublicA,
} from '../../../src/lib/deploy/public-dns-lookup.js';

// The deploy's public health probe must not trust the operator's system
// resolver for a record it just created: a stale negative entry (NXDOMAIN
// cached for the zone's SOA minimum TTL — an hour on Hetzner) fails the
// probe's whole budget against a healthy deploy. This lookup pins the
// probe's resolution to public DNS and falls back to the system resolver
// only when public DNS itself cannot answer.

const resolverWith = (addresses: string[] | Error) => ({
  resolve4: vi.fn((_host: string, cb: (err: Error | null, addrs?: string[]) => void) => {
    if (addresses instanceof Error) cb(addresses);
    else cb(null, addresses);
  }),
});

describe('makePublicDnsLookup', () => {
  it('answers from the injected resolver, net.connect single-address shape', async () => {
    const lookup = makePublicDnsLookup({ resolver: resolverWith(['94.130.188.95']) });
    const result = await new Promise((resolve) => {
      lookup('e4.example.dev', {}, (...args: unknown[]) => resolve(args));
    });
    expect(result).toEqual([null, '94.130.188.95', 4]);
  });

  it('supports options.all (list-of-objects shape)', async () => {
    const lookup = makePublicDnsLookup({ resolver: resolverWith(['1.2.3.4', '5.6.7.8']) });
    const result = await new Promise((resolve) => {
      lookup('e4.example.dev', { all: true }, (...args: unknown[]) => resolve(args));
    });
    expect(result).toEqual([
      null,
      [
        { address: '1.2.3.4', family: 4 },
        { address: '5.6.7.8', family: 4 },
      ],
    ]);
  });

  it('supports the (hostname, callback) two-arg signature', async () => {
    const lookup = makePublicDnsLookup({ resolver: resolverWith(['9.9.9.9']) });
    const result = await new Promise((resolve) => {
      lookup('e4.example.dev', (...args: unknown[]) => resolve(args));
    });
    expect(result).toEqual([null, '9.9.9.9', 4]);
  });

  it('falls back to the system lookup when public DNS errors (egress-filtered networks)', async () => {
    const fallback = vi.fn((_h: string, _o: object, cb: (e: null, a: string, f: number) => void) =>
      cb(null, '10.0.0.1', 4),
    );
    const lookup = makePublicDnsLookup({
      resolver: resolverWith(new Error('ETIMEOUT')),
      fallback,
    });
    const result = await new Promise((resolve) => {
      lookup('e4.example.dev', {}, (...args: unknown[]) => resolve(args));
    });
    expect(fallback).toHaveBeenCalledOnce();
    expect(result).toEqual([null, '10.0.0.1', 4]);
  });

  it('falls back when public DNS answers empty', async () => {
    const fallback = vi.fn((_h: string, _o: object, cb: (e: null, a: string, f: number) => void) =>
      cb(null, '10.0.0.2', 4),
    );
    const lookup = makePublicDnsLookup({ resolver: resolverWith([]), fallback });
    await new Promise((resolve) => {
      lookup('e4.example.dev', {}, resolve);
    });
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('defaults to the well-known public resolver pair', () => {
    expect(PUBLIC_DNS_SERVERS).toEqual(['1.1.1.1', '8.8.8.8']);
  });
});

describe('probePublicHealth wiring', () => {
  // The no-op regression this module replaces: dns.setServers() only
  // redirects dns.resolve*(), never fetch's dns.lookup()/getaddrinfo path.
  // The probe fetches through public-domain-probe.js, which puts this
  // lookup on the socket (public-domain-probe-census.test.ts covers every
  // other probe of the domain).
  it('orchestrator probes through fetchPublicDomain, not dns.setServers', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../../../src/lib/deploy/orchestrator.js', import.meta.url),
      'utf8',
    );
    expect(src).toContain('fetchPublicDomain(');
    expect(src).not.toMatch(/dns\.setServers\(/);
  });
});

// Egress filters that silently DROP UDP to 1.1.1.1/8.8.8.8 never answer, they
// just time out. The public lookup must give up inside a short total budget
// and take the system answer, well inside the smallest caller timeout
// (status readiness aborts at 5s, deploy's probe at 8s, the TLS probe at 10s).
describe('public DNS budget: a resolver that never answers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const silent = () => ({ resolve4: vi.fn(), cancel: vi.fn() });
  const systemAnswer = () =>
    vi.fn((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) =>
      opts?.all ? cb(null, [{ address: '10.0.0.3', family: 4 }]) : cb(null, '10.0.0.3', 4),
    );

  it('fits well inside the smallest caller timeout', () => {
    expect(PUBLIC_DNS_BUDGET_MS).toBeLessThanOrEqual(1_500);
  });

  it('lookup falls back to the system resolver at the budget, not before', async () => {
    vi.useFakeTimers();
    const resolver = silent();
    const fallback = systemAnswer();
    const lookup = makePublicDnsLookup({ resolver, fallback });
    const cb = vi.fn();
    lookup('e4.example.dev', {}, cb);
    await vi.advanceTimersByTimeAsync(PUBLIC_DNS_BUDGET_MS - 1);
    expect(cb).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fallback).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledExactlyOnceWith(null, '10.0.0.3', 4);
    expect(resolver.cancel).toHaveBeenCalled();
  });

  it('a public answer that arrives after the budget is ignored (one callback)', async () => {
    vi.useFakeTimers();
    let late: ((e: null, a: string[]) => void) | undefined;
    const resolver = {
      resolve4: vi.fn((_h: string, cb: (e: null, a: string[]) => void) => {
        late = cb;
      }),
    };
    const lookup = makePublicDnsLookup({ resolver, fallback: systemAnswer() });
    const cb = vi.fn();
    lookup('e4.example.dev', {}, cb);
    await vi.advanceTimersByTimeAsync(PUBLIC_DNS_BUDGET_MS);
    late?.(null, ['1.2.3.4']);
    expect(cb).toHaveBeenCalledExactlyOnceWith(null, '10.0.0.3', 4);
  });

  it('resolvePublicA falls back at the budget too', async () => {
    vi.useFakeTimers();
    const p = resolvePublicA('e4.example.dev', { resolver: silent(), fallback: systemAnswer() });
    await vi.advanceTimersByTimeAsync(PUBLIC_DNS_BUDGET_MS);
    expect(await p).toEqual(['10.0.0.3']);
  });
});
