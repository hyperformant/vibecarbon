/**
 * A missing DNS token in a non-interactive failover fails with the variable to
 * export (HA-correctness Task 4). It used to open a prompt that an EOF stdin
 * never answers, which cancels and exits 0 before anything is promoted.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/dns-provider.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, resolveDnsToken: () => undefined };
});

const { dnsStrategyFor } = await import('../../../src/failover.js');

describe('dnsStrategyFor getAuth', () => {
  const original = process.stdin.isTTY;
  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
  });

  it('a missing token off a TTY throws a one-line cause naming the env var', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const err = await dnsStrategyFor('cloudflare')
      .getAuth({ dns: { zoneId: 'z' } })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('CLOUDFLARE_API_TOKEN');
    expect((err as Error).message).toMatch(/not a TTY/);
  });
});
