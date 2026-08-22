/**
 * Coverage for `upsertApexAndWildcard(auth, domain, ip)` — the shared
 * apex+wildcard A record upsert extracted (C6b) from the near-identical
 * bodies that used to live inline in scale.js's `updateDNS` and
 * failover.js's `HA_DNS_STRATEGIES[*].updateDns`.
 *
 * Both call sites keep their own logging/fallback-warn messages; this test
 * only pins the wire calls this function itself makes (order + shape).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('cloudflare upsertApexAndWildcard', () => {
  it('creates apex then wildcard A records, both proxied:false', async () => {
    // Each createDNSRecord call does list-then-create when no record exists.
    fetchMock.mockResolvedValueOnce(ok({ result: [] })); // list apex
    fetchMock.mockResolvedValueOnce(ok({ result: { id: 'r1' } })); // create apex
    fetchMock.mockResolvedValueOnce(ok({ result: [] })); // list wildcard
    fetchMock.mockResolvedValueOnce(ok({ result: { id: 'r2' } })); // create wildcard

    const { upsertApexAndWildcard } = await import('../../../src/lib/cloudflare-dns.js');
    await upsertApexAndWildcard({ token: 'tok', zoneId: 'zone' }, 'e1.example.com', '1.2.3.4');

    expect(fetchMock).toHaveBeenCalledTimes(4);

    const apexCreate = fetchMock.mock.calls[1];
    expect(apexCreate[1].method).toBe('POST');
    expect(JSON.parse(apexCreate[1].body)).toEqual({
      type: 'A',
      name: 'e1.example.com',
      content: '1.2.3.4',
      proxied: false,
      ttl: 1, // createDNSRecord's default — neither call site overrides it
    });

    const wildcardList = fetchMock.mock.calls[2];
    expect(String(wildcardList[0])).toContain('name=*.e1.example.com');

    const wildcardCreate = fetchMock.mock.calls[3];
    expect(wildcardCreate[1].method).toBe('POST');
    expect(JSON.parse(wildcardCreate[1].body)).toEqual({
      type: 'A',
      name: '*.e1.example.com',
      content: '1.2.3.4',
      proxied: false,
      ttl: 1,
    });

    // Every call carries the token this function was handed.
    for (const call of fetchMock.mock.calls) {
      expect(call[1].headers.Authorization).toBe('Bearer tok');
    }
  });
});

describe('hetzner-dns upsertApexAndWildcard', () => {
  it('fetches the zone name once, then creates apex + wildcard rrsets at ttl:60', async () => {
    // Zone name matches the domain (the common case — the DNS zone is
    // the deploy's own apex), so the apex resolves to "@" and the
    // wildcard to "*".
    fetchMock.mockResolvedValueOnce(ok({ zone: { id: 'zone', name: 'e1.example.com' } })); // getZone
    fetchMock.mockResolvedValueOnce(ok({ rrsets: [], meta: { pagination: {} } })); // list apex (createDNSRecord's existing-check)
    fetchMock.mockResolvedValueOnce(ok({ rrset: { name: '@', type: 'A' } })); // create apex
    fetchMock.mockResolvedValueOnce(ok({ rrsets: [], meta: { pagination: {} } })); // list wildcard
    fetchMock.mockResolvedValueOnce(ok({ rrset: { name: '*', type: 'A' } })); // create wildcard

    const { upsertApexAndWildcard } = await import('../../../src/lib/hetzner-dns.js');
    await upsertApexAndWildcard({ token: 'tok', zoneId: 'zone' }, 'e1.example.com', '1.2.3.4');

    expect(fetchMock).toHaveBeenCalledTimes(5);

    const getZoneCall = fetchMock.mock.calls[0];
    expect(String(getZoneCall[0])).toContain('/zones/zone');

    const apexCreate = fetchMock.mock.calls[2];
    expect(apexCreate[1].method).toBe('POST');
    expect(JSON.parse(apexCreate[1].body)).toEqual({
      name: '@',
      type: 'A',
      ttl: 60,
      records: [{ value: '1.2.3.4' }],
    });

    const wildcardCreate = fetchMock.mock.calls[4];
    expect(wildcardCreate[1].method).toBe('POST');
    expect(JSON.parse(wildcardCreate[1].body)).toEqual({
      name: '*',
      type: 'A',
      ttl: 60,
      records: [{ value: '1.2.3.4' }],
    });

    // Every call carries the token this function was handed.
    for (const call of fetchMock.mock.calls) {
      expect(call[1].headers.Authorization).toBe('Bearer tok');
    }
  });
});
