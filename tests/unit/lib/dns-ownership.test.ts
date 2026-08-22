/**
 * Regression coverage for the DNS-delete blast-radius bug surfaced by the
 * 2026-05-16 e2e matrix run, where compose-ha's destroy zeroed
 * compose's e1.carbonstack.dev mid-verify-deploy because both scenarios
 * shared the same root zone.
 *
 * The contract under test: `deleteDNSRecord` only deletes records whose
 * target IP belongs to the caller's stack. Anything pointing elsewhere is
 * preserved with a `skipped` signal so callers can surface what survived.
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

describe('cloudflare deleteDNSRecord (ownership-aware)', () => {
  it('deletes only records whose content is in ownedIps', async () => {
    // Zone has 3 A records for the same name — one ours, two someone else's.
    fetchMock.mockResolvedValueOnce(
      ok({
        result: [
          { id: 'r1', name: 'e1.example.com', type: 'A', content: '1.2.3.4' }, // ours
          { id: 'r2', name: 'e1.example.com', type: 'A', content: '5.6.7.8' }, // theirs
          { id: 'r3', name: 'e1.example.com', type: 'A', content: '9.10.11.12' }, // theirs
        ],
      }),
    );
    fetchMock.mockResolvedValueOnce(ok({ success: true })); // delete r1

    const { deleteDNSRecord } = await import('../../../src/lib/cloudflare-dns.js');
    const result = await deleteDNSRecord('token', 'zone', 'e1.example.com', ['1.2.3.4']);

    expect(result).toEqual({
      deleted: 1,
      skipped: 2,
      total: 3,
      skippedTargets: ['5.6.7.8', '9.10.11.12'],
    });
    // Exactly 2 fetches: the list + a single DELETE for r1.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const deleteCall = fetchMock.mock.calls[1];
    expect(deleteCall[0]).toContain('/dns_records/r1');
    expect(deleteCall[1].method).toBe('DELETE');
  });

  it('deletes every record when all targets are owned', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        result: [
          { id: 'r1', name: 'e1.example.com', type: 'A', content: '1.2.3.4' },
          { id: 'r2', name: 'e1.example.com', type: 'A', content: '1.2.3.5' },
        ],
      }),
    );
    fetchMock.mockResolvedValueOnce(ok({ success: true }));
    fetchMock.mockResolvedValueOnce(ok({ success: true }));

    const { deleteDNSRecord } = await import('../../../src/lib/cloudflare-dns.js');
    const result = await deleteDNSRecord('token', 'zone', 'e1.example.com', ['1.2.3.4', '1.2.3.5']);

    expect(result).toEqual({ deleted: 2, skipped: 0, total: 2, skippedTargets: [] });
  });

  it('refuses to delete anything when ownedIps is empty (safer default)', async () => {
    // This is the "envConfig has no servers" case — historically the blast
    // radius hit hardest because destroy ran the API call with no filter
    // and wiped whatever was there.
    fetchMock.mockResolvedValueOnce(
      ok({
        result: [{ id: 'r1', name: 'e1.example.com', type: 'A', content: '1.2.3.4' }],
      }),
    );

    const { deleteDNSRecord } = await import('../../../src/lib/cloudflare-dns.js');
    const result = await deleteDNSRecord('token', 'zone', 'e1.example.com', []);

    expect(result).toEqual({
      deleted: 0,
      skipped: 1,
      total: 1,
      skippedTargets: ['1.2.3.4'],
    });
    // No DELETE call should have been issued — only the list.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns total=0 when the record does not exist', async () => {
    fetchMock.mockResolvedValueOnce(ok({ result: [] }));

    const { deleteDNSRecord } = await import('../../../src/lib/cloudflare-dns.js');
    const result = await deleteDNSRecord('token', 'zone', 'absent.example.com', ['1.2.3.4']);

    expect(result).toEqual({ deleted: 0, skipped: 0, total: 0, skippedTargets: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // M3 Task 9f regression: a k8s A record points at the cluster's
  // floating/reserved ingress IP, never at any server's own IP. Before
  // planDestroyTargets folded the floating IP into ownedIps, this exact
  // shape (server IPs present, but NOT the record's actual target) always
  // fell into the "preserved" branch — reproducing the live evidence
  // ("DNS record preserved (1 unowned target(s): 129.212.153.70)").
  it('deletes a k8s record pointing at the floating IP once ownedIps includes it (post-fix shape)', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ result: [{ id: 'r1', name: 'e1.example.com', type: 'A', content: '129.212.153.70' }] }),
    );
    fetchMock.mockResolvedValueOnce(ok({ success: true }));

    const { deleteDNSRecord } = await import('../../../src/lib/cloudflare-dns.js');
    // ownedIps as planDestroyTargets now builds it: server IP + floatingIp.
    const ownedIps = ['10.0.1.1', '129.212.153.70'];
    const result = await deleteDNSRecord('token', 'zone', 'e1.example.com', ownedIps);

    expect(result).toEqual({ deleted: 1, skipped: 0, total: 1, skippedTargets: [] });
  });
});

describe('hetzner-dns deleteDNSRecord (ownership-aware)', () => {
  // Uniform-contract signature: (token, zoneId, name, ownedIps, type) —
  // the zone NAME is resolved internally (one getZone per zoneId, cached
  // for the process lifetime). Each test uses a distinct zoneId so the
  // module-level cache can't leak fixtures between tests, and each test's
  // FIRST mocked fetch is the getZone response.
  function zoneOk(name = 'example.com'): Response {
    return ok({ zone: { id: 'z', name } });
  }

  it('deletes the rrset when every value is owned', async () => {
    fetchMock.mockResolvedValueOnce(zoneOk());
    // getRrsets (paginated) — one page, one match.
    fetchMock.mockResolvedValueOnce(
      ok({
        rrsets: [{ name: 'e1', type: 'A', records: [{ value: '1.2.3.4' }] }],
        meta: { pagination: {} },
      }),
    );
    fetchMock.mockResolvedValueOnce(ok({}));

    const { deleteDNSRecord } = await import('../../../src/lib/hetzner-dns.js');
    const result = await deleteDNSRecord('token', 'zone-own-a', 'e1.example.com', ['1.2.3.4']);

    expect(result).toEqual({ deleted: 1, skipped: 0, total: 1, skippedTargets: [] });

    const deleteCall = fetchMock.mock.calls[2];
    expect(deleteCall[0]).toContain('/rrsets/e1/A');
    expect(deleteCall[1].method).toBe('DELETE');
  });

  it('preserves the rrset if any value belongs to someone else', async () => {
    fetchMock.mockResolvedValueOnce(zoneOk());
    fetchMock.mockResolvedValueOnce(
      ok({
        rrsets: [{ name: 'e1', type: 'A', records: [{ value: '1.2.3.4' }, { value: '5.6.7.8' }] }],
        meta: { pagination: {} },
      }),
    );

    const { deleteDNSRecord } = await import('../../../src/lib/hetzner-dns.js');
    const result = await deleteDNSRecord('token', 'zone-own-b', 'e1.example.com', ['1.2.3.4']);

    // Hetzner rrsets are all-or-nothing: one unowned value preserves the
    // whole rrset, so deleted stays 0 even though '1.2.3.4' is ours.
    expect(result).toEqual({ deleted: 0, skipped: 1, total: 2, skippedTargets: ['5.6.7.8'] });
    // No DELETE call should have been issued — getZone + list only.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves when ownedIps is empty (safer default)', async () => {
    fetchMock.mockResolvedValueOnce(zoneOk());
    fetchMock.mockResolvedValueOnce(
      ok({
        rrsets: [{ name: 'e1', type: 'A', records: [{ value: '1.2.3.4' }] }],
        meta: { pagination: {} },
      }),
    );

    const { deleteDNSRecord } = await import('../../../src/lib/hetzner-dns.js');
    const result = await deleteDNSRecord('token', 'zone-own-c', 'e1.example.com', []);

    expect(result).toEqual({ deleted: 0, skipped: 1, total: 1, skippedTargets: ['1.2.3.4'] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns total=0 when the rrset is missing', async () => {
    fetchMock.mockResolvedValueOnce(zoneOk());
    fetchMock.mockResolvedValueOnce(ok({ rrsets: [], meta: { pagination: {} } }));

    const { deleteDNSRecord } = await import('../../../src/lib/hetzner-dns.js');
    const result = await deleteDNSRecord('token', 'zone-own-d', 'absent.example.com', ['1.2.3.4']);

    expect(result).toEqual({ deleted: 0, skipped: 0, total: 0, skippedTargets: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // M3 Task 9f regression — Hetzner e3 evidence: "Hetzner DNS records
  // preserved (unowned targets: 116.203.2.205 x2)". Same root cause as the
  // Cloudflare case above: the rrset's value IS the floating IP, which
  // planDestroyTargets now folds into ownedIps.
  it('deletes a k8s rrset pointing at the floating IP once ownedIps includes it (post-fix shape)', async () => {
    fetchMock.mockResolvedValueOnce(zoneOk());
    fetchMock.mockResolvedValueOnce(
      ok({
        rrsets: [{ name: 'e3', type: 'A', records: [{ value: '116.203.2.205' }] }],
        meta: { pagination: {} },
      }),
    );
    fetchMock.mockResolvedValueOnce(ok({}));

    const { deleteDNSRecord } = await import('../../../src/lib/hetzner-dns.js');
    const ownedIps = ['10.0.1.1', '116.203.2.205'];
    const result = await deleteDNSRecord('token', 'zone-own-e', 'e3.example.com', ownedIps);

    expect(result.deleted).toBe(1);
    expect(result.skipped).toBe(0);
  });
});

describe('hetzner-dns deleteApexAndWildcard (uniform-contract twin)', () => {
  // The pair helper existing on EVERY backend is the fix for the wildcard
  // orphan class (M3 Task 9i) — these mirror the cloudflare cases in
  // delete-apex-and-wildcard.test.ts at the hetzner rrset granularity.
  it('deletes both the apex and wildcard rrsets when owned', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/zones/zone-pair-a/rrsets') && init?.method === 'DELETE') {
        return Promise.resolve(ok({}));
      }
      if (url.includes('/zones/zone-pair-a/rrsets')) {
        return Promise.resolve(
          ok({
            rrsets: [
              { name: '@', type: 'A', records: [{ value: '1.2.3.4' }] },
              { name: '*', type: 'A', records: [{ value: '1.2.3.4' }] },
            ],
            meta: { pagination: {} },
          }),
        );
      }
      // getZone
      return Promise.resolve(ok({ zone: { id: 'zone-pair-a', name: 'example.com' } }));
    });

    const { deleteApexAndWildcard } = await import('../../../src/lib/hetzner-dns.js');
    const result = await deleteApexAndWildcard('token', 'zone-pair-a', 'example.com', ['1.2.3.4']);

    expect(result).toEqual({ deletedAny: true, preservedTargets: [] });
    const deleteCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');
    expect(deleteCalls.map(([url]) => String(url).split('/rrsets/')[1]).sort()).toEqual([
      '*/A',
      '@/A',
    ]);
  });

  it('preserves unowned targets and reports them', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/zones/zone-pair-b/rrsets')) {
        return Promise.resolve(
          ok({
            rrsets: [
              { name: '@', type: 'A', records: [{ value: '5.6.7.8' }] },
              { name: '*', type: 'A', records: [{ value: '5.6.7.8' }] },
            ],
            meta: { pagination: {} },
          }),
        );
      }
      return Promise.resolve(ok({ zone: { id: 'zone-pair-b', name: 'example.com' } }));
    });

    const { deleteApexAndWildcard } = await import('../../../src/lib/hetzner-dns.js');
    const result = await deleteApexAndWildcard('token', 'zone-pair-b', 'example.com', ['1.2.3.4']);

    expect(result.deletedAny).toBe(false);
    expect(result.preservedTargets.sort()).toEqual(['5.6.7.8', '5.6.7.8']);
    const deleteCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');
    expect(deleteCalls).toHaveLength(0);
  });
});
