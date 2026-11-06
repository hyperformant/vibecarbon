import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';

function providerWith(statuses: string[]) {
  const p = new LinodeProvider('token');
  let i = 0;
  p.apiRequest = vi.fn(async () => {
    const status = statuses[Math.min(i++, statuses.length - 1)];
    return { ok: true, json: async () => ({ status, ipv4: ['203.0.113.7'] }) };
  }) as never;
  return p;
}

describe('Linode waitForServer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fails as soon as the instance settles offline, not after the full timeout', async () => {
    const p = providerWith(['provisioning', 'booting', 'offline', 'offline']);
    const result = p.waitForServer(1, 600_000).catch((e) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await result;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/did not boot: it is offline/);
    expect((p.apiRequest as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
  });

  it('does not mistake one offline read for a failed boot', async () => {
    const p = providerWith(['offline', 'booting', 'running']);
    const result = p.waitForServer(1, 600_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(result).resolves.toMatchObject({ status: 'running' });
  });
});
