/**
 * Unit tests for waitForDNSPropagation.
 *
 * The function polls a DNS resolver (1.1.1.1 / 8.8.8.8) until the domain
 * resolves to the expected IP, with a timeout. We mock node:dns's
 * Resolver class so tests stay hermetic — no real network calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hold a single mutable resolve4 implementation that each test rewrites.
// vi.hoisted lets the mock factory reference it without TDZ issues.
const state = vi.hoisted(() => ({
  resolve4Impl: async (_domain: string): Promise<string[]> => {
    throw new Error('resolve4 not configured for this test');
  },
}));

vi.mock('node:dns', () => {
  class Resolver {
    setServers() {}
    async resolve4(domain: string) {
      return state.resolve4Impl(domain);
    }
  }
  return { default: { promises: { Resolver } }, promises: { Resolver } };
});

// Import after the mock is registered.
const { waitForDNSPropagation } = await import('../../../src/lib/dns-propagation.js');

describe('waitForDNSPropagation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    state.resolve4Impl = async () => {
      throw new Error('resolve4 not configured for this test');
    };
  });

  it('returns true on the first poll when the resolver already sees the IP', async () => {
    state.resolve4Impl = async () => ['1.2.3.4'];
    const result = await waitForDNSPropagation('example.com', '1.2.3.4', 5_000);
    expect(result).toBe(true);
  });

  it('returns false when the resolver never returns the expected IP within the budget', async () => {
    state.resolve4Impl = async () => ['9.9.9.9']; // wrong IP forever
    const promise = waitForDNSPropagation('example.com', '1.2.3.4', 12_000);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await promise).toBe(false);
  });

  it('returns false when the domain raises NXDOMAIN for the entire budget', async () => {
    state.resolve4Impl = async () => {
      const err = new Error('queryA ENOTFOUND example.com') as Error & { code?: string };
      err.code = 'ENOTFOUND';
      throw err;
    };
    const promise = waitForDNSPropagation('example.com', '1.2.3.4', 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await promise).toBe(false);
  });

  it('returns true once the resolver flips from NXDOMAIN to the expected IP', async () => {
    let calls = 0;
    state.resolve4Impl = async () => {
      calls++;
      if (calls < 3) {
        const err = new Error('queryA ENOTFOUND example.com') as Error & { code?: string };
        err.code = 'ENOTFOUND';
        throw err;
      }
      return ['1.2.3.4'];
    };
    const promise = waitForDNSPropagation('example.com', '1.2.3.4', 30_000);
    // Each NXDOMAIN attempt sleeps min(5s, remaining); advance through 2
    // failed polls + the next successful poll.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await promise).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('accepts a record that returns multiple IPs as long as the expected one is included', async () => {
    state.resolve4Impl = async () => ['198.51.100.10', '1.2.3.4', '203.0.113.5'];
    const result = await waitForDNSPropagation('example.com', '1.2.3.4', 5_000);
    expect(result).toBe(true);
  });
});
