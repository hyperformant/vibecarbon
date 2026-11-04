/**
 * Unit tests for waitForDNSPropagation.
 *
 * Each public resolver is asked on its own (c-ares never tries the next server
 * after an NXDOMAIN or a stale answer, so a two-server list is a one-server
 * check). The resolver factory is injected, so no test touches the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { waitForDNSPropagation } from '../../../src/lib/dns-propagation.js';

type Answer = string[] | 'NXDOMAIN';
type Cb = (err: Error | null, addresses?: string[]) => void;

/** A factory whose resolver for each server answers per `answers[server]()`. */
function factory(answers: Record<string, () => Answer>) {
  const asked: string[] = [];
  const makeResolver = (server: string) => ({
    resolve4(_host: string, cb: Cb) {
      asked.push(server);
      const a = answers[server]();
      if (a === 'NXDOMAIN') cb(Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' }));
      else cb(null, a);
    },
    cancel() {},
  });
  return { makeResolver, asked };
}

const both = (a: () => Answer, b: () => Answer = a) => ({ '1.1.1.1': a, '8.8.8.8': b });

describe('waitForDNSPropagation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns true on the first poll when 1.1.1.1 says NXDOMAIN and 8.8.8.8 has the IP', async () => {
    const f = factory(
      both(
        () => 'NXDOMAIN',
        () => ['1.2.3.4'],
      ),
    );
    const result = await waitForDNSPropagation('example.com', '1.2.3.4', 5_000, f);
    expect(result).toBe(true);
    expect(f.asked.sort()).toEqual(['1.1.1.1', '8.8.8.8']);
  });

  it('returns true on the first poll when the resolver already sees the IP', async () => {
    const f = factory(both(() => ['1.2.3.4']));
    expect(await waitForDNSPropagation('example.com', '1.2.3.4', 5_000, f)).toBe(true);
  });

  it('finds the IP on 8.8.8.8 even when 1.1.1.1 answers a stale address', async () => {
    const f = factory(
      both(
        () => ['9.9.9.9'],
        () => ['1.2.3.4'],
      ),
    );
    expect(await waitForDNSPropagation('example.com', '1.2.3.4', 5_000, f)).toBe(true);
  });

  it('returns false (fail-open) when both resolvers answer a stale IP until the deadline', async () => {
    const f = factory(both(() => ['9.9.9.9']));
    const promise = waitForDNSPropagation('example.com', '1.2.3.4', 12_000, f);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await promise).toBe(false);
  });

  it('does not count the 0.0.0.0 warm-up placeholder as a match', async () => {
    const f = factory(both(() => ['0.0.0.0']));
    const promise = waitForDNSPropagation('example.com', '0.0.0.0', 6_000, f);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await promise).toBe(false);
  });

  it('returns false when the domain raises NXDOMAIN on both resolvers for the entire budget', async () => {
    const f = factory(both(() => 'NXDOMAIN'));
    const promise = waitForDNSPropagation('example.com', '1.2.3.4', 10_000, f);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await promise).toBe(false);
  });

  it('returns true once the resolvers flip from NXDOMAIN to the expected IP', async () => {
    let polls = 0;
    const f = factory(
      both(() => {
        polls++;
        return polls <= 4 ? 'NXDOMAIN' : ['1.2.3.4'];
      }),
    );
    const promise = waitForDNSPropagation('example.com', '1.2.3.4', 30_000, f);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await promise).toBe(true);
  });

  it('accepts a record that returns multiple IPs as long as the expected one is included', async () => {
    const f = factory(both(() => ['198.51.100.10', '1.2.3.4', '203.0.113.5']));
    expect(await waitForDNSPropagation('example.com', '1.2.3.4', 5_000, f)).toBe(true);
  });
});
