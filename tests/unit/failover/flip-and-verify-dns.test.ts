/**
 * flipAndVerifyDns: the records the flip wrote are judged by the provider's
 * answer to the write, never by its record list; the list only finds A
 * records the write did not name.
 *
 * 2026-11-19 (run 44463077640, linode/compose-ha): Linode's record list read
 * the old target in the same second the account event log recorded the
 * update to the new one, and the failover exited "FAILOVER COMPLETED, DNS DID NOT" over a flip that had
 * landed (the account event log shows the update). The last block replays it
 * through the real Linode backend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flipAndVerifyDns } from '../../../src/lib/deploy/failover-guard.js';
import { listedFlip, writtenFlip } from '../../_shared/dns-flip-fake.js';

const DOMAIN = 'app.example.com';
const IP = '203.0.113.9';
const OLD = '198.51.100.1';

const args = (over: Record<string, unknown> = {}) => ({
  update: async () => writtenFlip(DOMAIN, IP),
  read: async (name: string) => listedFlip(name, IP),
  domain: DOMAIN,
  ip: IP,
  ...over,
});

describe('flipAndVerifyDns', () => {
  it('both writes answering exactly [ip], nothing else listed, is ok', async () => {
    await expect(flipAndVerifyDns(args())).resolves.toEqual({ ok: true });
  });

  it('a list that lags the write (the written records still at the old address) is ok', async () => {
    const r = await flipAndVerifyDns(args({ read: async (name: string) => listedFlip(name, OLD) }));
    expect(r).toEqual({ ok: true });
  });

  it('a list that does not show a just-created record yet is ok', async () => {
    const r = await flipAndVerifyDns(args({ read: async () => [] }));
    expect(r).toEqual({ ok: true });
  });

  it('another record at the name, at the old address, is not flipped and is named', async () => {
    const r = await flipAndVerifyDns(
      args({
        read: async (name: string) =>
          name.startsWith('*.')
            ? [...listedFlip(name, IP), { id: 'stale-7', value: OLD }]
            : listedFlip(name, IP),
      }),
    );
    expect(r).toEqual({
      ok: false,
      reason: `*.${DOMAIN} still has another A record, ${OLD} (record stale-7), which keeps sending part of the traffic there`,
    });
  });

  it('another record at the promoted address itself sends traffic nowhere else: ok', async () => {
    const r = await flipAndVerifyDns(
      args({ read: async (name: string) => [...listedFlip(name, IP), { id: 'twin', value: IP }] }),
    );
    expect(r).toEqual({ ok: true });
  });

  it('a write whose response holds another address is not flipped', async () => {
    const r = await flipAndVerifyDns(
      args({
        update: async () => ({
          ...writtenFlip(DOMAIN, IP),
          [DOMAIN]: [{ id: 'apex', value: OLD }],
        }),
      }),
    );
    expect(r).toEqual({
      ok: false,
      reason: `the DNS provider says ${DOMAIN} now holds ${OLD}, not only ${IP}`,
    });
  });

  it('an rrset write whose response holds a second value is not flipped', async () => {
    const r = await flipAndVerifyDns(
      args({
        update: async () => ({
          ...writtenFlip(DOMAIN, IP),
          [`*.${DOMAIN}`]: [
            { id: '*/A', value: IP },
            { id: '*/A', value: OLD },
          ],
        }),
      }),
    );
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining(`${IP}, ${OLD}`) });
  });

  it.each([
    ['no answer at all', async () => undefined],
    ['no answer for the wildcard', async () => ({ [DOMAIN]: [{ id: 'apex', value: IP }] })],
    ['an empty answer', async () => ({ ...writtenFlip(DOMAIN, IP), [DOMAIN]: [] })],
    [
      'an answer without an id',
      async () => ({ ...writtenFlip(DOMAIN, IP), [DOMAIN]: [{ value: IP }] }),
    ],
  ])('a write response that is missing (%s) is not flipped', async (_why, update) => {
    const r = await flipAndVerifyDns(args({ update }));
    expect(r).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/answer to the .* write did not say what the record holds/),
    });
  });

  it('a throwing update is not flipped, with the cause', async () => {
    const r = await flipAndVerifyDns(
      args({
        update: async () => {
          throw new Error('HTTP 403');
        },
      }),
    );
    expect(r).toEqual({ ok: false, reason: 'the DNS update failed: HTTP 403' });
  });

  it('a list read that throws is not flipped, with the cause', async () => {
    const r = await flipAndVerifyDns(
      args({
        read: async () => {
          throw new Error('timeout');
        },
      }),
    );
    expect(r).toEqual({
      ok: false,
      reason: `could not list the A records at ${DOMAIN}: timeout`,
    });
  });

  it('never throws', async () => {
    await expect(
      flipAndVerifyDns(
        args({
          update: async () => {
            throw new Error('boom');
          },
          read: async () => {
            throw new Error('boom');
          },
        }),
      ),
    ).resolves.toMatchObject({ ok: false });
  });
});

describe('flipAndVerifyDns through the Linode backend (the 2026-11-19 replay)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  /** The zone holds apex (id 11) and wildcard (id 12) at `listed`; each PUT answers with `answered`. */
  function linode({
    listed,
    answered,
    extra = [],
  }: {
    listed: string;
    answered: string;
    extra?: object[];
  }) {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url);
      if (init?.method === 'PUT') {
        const id = Number(u.split('/').at(-1));
        const sent = JSON.parse(String(init.body));
        return ok({ id, type: 'A', name: sent.name, target: answered, ttl_sec: 300 });
      }
      if (u.includes('/domains/42/records')) {
        return ok({
          data: [
            { id: 11, type: 'A', name: '', target: listed },
            { id: 12, type: 'A', name: '*', target: listed },
            ...extra,
          ],
          page: 1,
          pages: 1,
        });
      }
      if (u.endsWith('/domains/42')) return ok({ id: 42, domain: DOMAIN });
      return new Response('{}', { status: 404 });
    });
  }

  async function flip() {
    const dns = await import('../../../src/lib/linode-dns.js');
    const auth = { token: 't', zoneId: '42' };
    return flipAndVerifyDns({
      update: () => dns.upsertApexAndWildcard(auth, DOMAIN, IP),
      read: (name) => dns.readARecords(auth.token, auth.zoneId, name),
      domain: DOMAIN,
      ip: IP,
    });
  }

  it('the PUTs answer with the new target while the list still reads the old one: flipped', async () => {
    linode({ listed: OLD, answered: IP });
    await expect(flip()).resolves.toEqual({ ok: true });
  });

  it('a stale second record at the old target is still caught', async () => {
    linode({
      listed: IP,
      answered: IP,
      extra: [{ id: 99, type: 'A', name: '', target: OLD }],
    });
    await expect(flip()).resolves.toEqual({
      ok: false,
      reason: `${DOMAIN} still has another A record, ${OLD} (record 99), which keeps sending part of the traffic there`,
    });
  });
});
