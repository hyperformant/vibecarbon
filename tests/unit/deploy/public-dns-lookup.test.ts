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

  it('one lookup timing out never cancels a concurrent one (a Resolver per call)', async () => {
    // Status runs its readiness and TLS probes together. With one shared
    // Resolver, the first lookup's budget expiry cancelled every in-flight
    // query, forcing the other onto the system resolver: the stale-NXDOMAIN
    // path this lookup exists to avoid.
    vi.useFakeTimers();
    /** A Resolver stub whose cancel() fails ITS pending queries, like c-ares. */
    const stub = (answerAfterMs: number | null) => {
      const pending: Array<(e: Error | null, a?: string[]) => void> = [];
      return {
        resolve4: vi.fn((_h: string, cb: (e: Error | null, a?: string[]) => void) => {
          pending.push(cb);
          if (answerAfterMs !== null) setTimeout(() => cb(null, ['1.2.3.4']), answerAfterMs);
        }),
        cancel: vi.fn(() => {
          for (const cb of pending.splice(0))
            cb(Object.assign(new Error('cancelled'), { code: 'ECANCELLED' }));
        }),
      };
    };
    // One Resolver per server per lookup: the first lookup's two are silent,
    // the second's two answer 600ms into its own budget.
    const silentResolver = stub(null);
    const silentResolver2 = stub(null);
    const answeringResolver = stub(600);
    const answeringResolver2 = stub(600);
    const made = [silentResolver, silentResolver2, answeringResolver, answeringResolver2];
    const fallback = systemAnswer();
    const lookup = makePublicDnsLookup({ makeResolver: () => made.shift(), fallback });

    const first = vi.fn();
    const second = vi.fn();
    lookup('e4.example.dev', {}, first);
    await vi.advanceTimersByTimeAsync(1_000);
    lookup('e4.example.dev', {}, second);
    // t=1500: the first lookup's budget expires and cancels its own query.
    await vi.advanceTimersByTimeAsync(500);
    expect(first).toHaveBeenCalledExactlyOnceWith(null, '10.0.0.3', 4);
    expect(silentResolver.cancel).toHaveBeenCalled();
    expect(silentResolver2.cancel).toHaveBeenCalled();
    // The first lookup's expiry never touched the second lookup's resolvers.
    expect(answeringResolver.cancel).not.toHaveBeenCalled();
    expect(answeringResolver2.cancel).not.toHaveBeenCalled();
    // t=1600: the second's public answer, 600ms into its own budget.
    await vi.advanceTimersByTimeAsync(100);
    expect(second).toHaveBeenCalledExactlyOnceWith(null, '1.2.3.4', 4);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('resolvePublicA falls back at the budget too', async () => {
    vi.useFakeTimers();
    const p = resolvePublicA('e4.example.dev', { resolver: silent(), fallback: systemAnswer() });
    await vi.advanceTimersByTimeAsync(PUBLIC_DNS_BUDGET_MS);
    expect(await p).toEqual(['10.0.0.3']);
  });
});

describe('each public resolver answers on its own', () => {
  // A stale NXDOMAIN on one public resolver is a final answer from that
  // server: asked as one server list, c-ares never tries the next. Live on
  // 2026-11-04 after an e2e destroy and restore on the same name: 1.1.1.1
  // said NXDOMAIN, 8.8.8.8 and the authoritative servers had the record.
  const nxdomain = () =>
    Object.assign(new Error('queryA ENOTFOUND rd3d4.example.dev'), { code: 'ENOTFOUND' });
  const perServer = (answers: Record<string, string[] | Error>) => (server: string) => ({
    resolve4: vi.fn((_h: string, cb: (err: Error | null, addrs?: string[]) => void) => {
      const a = answers[server];
      if (a instanceof Error) cb(a);
      else cb(null, a);
    }),
    cancel: vi.fn(),
  });

  it('a positive answer from any resolver wins over another one cached NXDOMAIN', async () => {
    const fallback = vi.fn();
    const lookup = makePublicDnsLookup({
      makeResolver: perServer({ '1.1.1.1': nxdomain(), '8.8.8.8': ['209.38.8.152'] }),
      fallback,
    });
    const result = await new Promise((resolve) => {
      lookup('rd3d4.example.dev', {}, (...args: unknown[]) => resolve(args));
    });
    expect(result).toEqual([null, '209.38.8.152', 4]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('resolvePublicA does the same', async () => {
    const fallback = vi.fn();
    await expect(
      resolvePublicA('rd3d4.example.dev', {
        makeResolver: perServer({ '1.1.1.1': nxdomain(), '8.8.8.8': ['209.38.8.152'] }),
        fallback,
      }),
    ).resolves.toEqual(['209.38.8.152']);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('every resolver empty: the system resolver answers, as before', async () => {
    const fallback = vi.fn((_h: string, _o: object, cb: (e: null, a: string, f: number) => void) =>
      cb(null, '10.0.0.1', 4),
    );
    const lookup = makePublicDnsLookup({
      makeResolver: perServer({ '1.1.1.1': nxdomain(), '8.8.8.8': nxdomain() }),
      fallback,
    });
    const result = await new Promise((resolve) => {
      lookup('gone.example.dev', {}, (...args: unknown[]) => resolve(args));
    });
    expect(result).toEqual([null, '10.0.0.1', 4]);
  });

  it('asks every server in PUBLIC_DNS_SERVERS, one resolver each', async () => {
    const seen: string[] = [];
    const lookup = makePublicDnsLookup({
      makeResolver: (server: string) => {
        seen.push(server);
        return perServer({ [server]: ['1.2.3.4'] })(server);
      },
      fallback: vi.fn(),
    });
    await new Promise((resolve) => lookup('x.example.dev', {}, resolve));
    expect(seen.sort()).toEqual([...PUBLIC_DNS_SERVERS].sort());
  });
});

describe('the 0.0.0.0 warm-up placeholder is not an answer', () => {
  // The deploy plants 0.0.0.0 while it provisions; one resolver can still
  // serve it after the real IP lands on another.
  const answers = (byServer: Record<string, string[]>) => (server: string) => ({
    resolve4: vi.fn((_h: string, cb: (err: Error | null, addrs?: string[]) => void) =>
      cb(null, byServer[server]),
    ),
    cancel: vi.fn(),
  });

  it('a resolver still serving 0.0.0.0 loses to one with the real IP', async () => {
    await expect(
      resolvePublicA('d4.example.dev', {
        makeResolver: answers({ '1.1.1.1': ['0.0.0.0'], '8.8.8.8': ['203.0.113.9'] }),
        fallback: vi.fn(),
      }),
    ).resolves.toEqual(['203.0.113.9']);
  });

  it('only the placeholder anywhere: nothing resolved yet, the fallback answers', async () => {
    const fallback = vi.fn((_h: string, _o: object, cb: (e: null, a: object[]) => void) =>
      cb(null, []),
    );
    await expect(
      resolvePublicA('d4.example.dev', {
        makeResolver: answers({ '1.1.1.1': ['0.0.0.0'], '8.8.8.8': ['0.0.0.0'] }),
        fallback,
      }),
    ).resolves.toEqual([]);
    expect(fallback).toHaveBeenCalledOnce();
  });
});
