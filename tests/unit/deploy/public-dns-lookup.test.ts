import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error — JS module without types
import {
  makePublicDnsLookup,
  PUBLIC_DNS_SERVERS,
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
  // Pin that the probe's source wires the custom lookup into the undici
  // Agent connect options (and no longer carries the setServers call).
  it('orchestrator builds its probe Agent with the public-DNS lookup, not dns.setServers', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../../../src/lib/deploy/orchestrator.js', import.meta.url),
      'utf8',
    );
    expect(src).toContain('makePublicDnsLookup');
    expect(src).toMatch(/connect:\s*connectOpts/);
    expect(src).not.toMatch(/dns\.setServers\(/);
  });
});
