import { describe, expect, it } from 'vitest';
import { flipAndVerifyDns } from '../../../src/lib/deploy/failover-guard.js';

const IP = '203.0.113.9';
const args = (over: Record<string, unknown> = {}) => ({
  update: async () => {},
  read: async () => [IP],
  domain: 'app.example.com',
  ip: IP,
  ...over,
});

describe('flipAndVerifyDns', () => {
  it('apex and wildcard both reading exactly [ip] is ok', async () => {
    await expect(flipAndVerifyDns(args())).resolves.toEqual({ ok: true });
  });

  it('a throwing update is not flipped, with the cause', async () => {
    const r = await flipAndVerifyDns(
      args({
        update: async () => {
          throw new Error('HTTP 403');
        },
      }),
    );
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('HTTP 403') });
  });

  it('a read that throws is not flipped', async () => {
    const r = await flipAndVerifyDns(
      args({
        read: async () => {
          throw new Error('timeout');
        },
      }),
    );
    expect(r).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/could not read.*timeout/),
    });
  });

  it('apex right, wildcard wrong is not flipped, naming the wildcard', async () => {
    const r = await flipAndVerifyDns(
      args({ read: async (n: string) => (n.startsWith('*.') ? ['198.51.100.1'] : [IP]) }),
    );
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('*.app.example.com') });
  });

  it('a stale second A record is not flipped', async () => {
    const r = await flipAndVerifyDns(args({ read: async () => [IP, '198.51.100.1'] }));
    expect(r.ok).toBe(false);
  });

  it('no record at all is not flipped', async () => {
    const r = await flipAndVerifyDns(args({ read: async () => [] }));
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('nothing') });
  });
});
