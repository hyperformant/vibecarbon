/**
 * createDNSRecord must update an EXISTING rrset atomically via
 * POST .../rrsets/{name}/{type}/actions/set_records — never delete + create.
 *
 * The delete + create rewrite (the module's original shape, justified by
 * "PUT returns 422") left the authoritative servers answering NODATA for the
 * name between the DELETE and the POST. Any resolver that queried inside
 * that window cached the nothing-answer for the zone's SOA minimum TTL
 * (3600s on Hetzner) — e4 2026-08-29: an intermediary resolver poisoned
 * mid-verify served NODATA for an hour and failed the browser check against
 * a healthy deploy. set_records replaces the values in place (live-verified:
 * 201, command set_rrset_records, TTL kept), so the name never stops
 * answering. Delete + create survives ONLY as the fallback for a failed
 * action or a TTL change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/cli/progress.js', () => ({
  spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
  progressLog: () => {},
}));

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const MOD = '../../../src/lib/hetzner-dns.js';

/** Queue the zone-name + rrset-listing responses every createDNSRecord makes. */
function queuePreamble(zoneId: string, rrsets: unknown[]) {
  fetchMock
    .mockResolvedValueOnce(ok({ zone: { id: zoneId, name: 'carbonstack.dev' } }))
    .mockResolvedValueOnce(ok({ rrsets, meta: { pagination: { next_page: null } } }));
}

describe('hetzner createDNSRecord — atomic update', () => {
  it('existing rrset, same TTL: ONE set_records action, no DELETE anywhere', async () => {
    vi.resetModules();
    const { createDNSRecord } = await import(MOD);
    queuePreamble('z-atomic', [
      { name: 'e4', type: 'A', ttl: 60, records: [{ value: '1.1.1.1' }] },
    ]);
    fetchMock.mockResolvedValueOnce(ok({ action: { id: 1, command: 'set_rrset_records' } }, 201));

    await createDNSRecord('tok', 'z-atomic', {
      type: 'A',
      name: 'e4.carbonstack.dev',
      value: '9.9.9.9',
      ttl: 60,
    });

    const calls = fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`);
    expect(calls.some((c) => c.includes('/actions/set_records'))).toBe(true);
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
    const setCall = fetchMock.mock.calls.find(([url]) => String(url).includes('set_records'));
    expect(JSON.parse(setCall?.[1]?.body as string)).toEqual({ records: [{ value: '9.9.9.9' }] });
  });

  it('set_records failure falls back to delete + create (gap over hard failure)', async () => {
    vi.resetModules();
    const { createDNSRecord } = await import(MOD);
    queuePreamble('z-fallback', [
      { name: 'e4', type: 'A', ttl: 60, records: [{ value: '1.1.1.1' }] },
    ]);
    fetchMock
      .mockResolvedValueOnce(ok({ error: { message: 'nope' } }, 422)) // set_records rejected
      .mockResolvedValueOnce(ok({ action: {} }, 201)) // DELETE old rrset
      .mockResolvedValueOnce(ok({ rrset: { name: 'e4', type: 'A' } }, 201)); // POST create

    await createDNSRecord('tok', 'z-fallback', {
      type: 'A',
      name: 'e4.carbonstack.dev',
      value: '9.9.9.9',
      ttl: 60,
    });

    const calls = fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`);
    expect(calls.some((c) => c.startsWith('DELETE') && c.includes('/rrsets/e4/A'))).toBe(true);
    expect(calls.at(-1)).toContain('POST');
  });

  it('TTL change takes the delete + create path (set_records cannot change TTL)', async () => {
    vi.resetModules();
    const { createDNSRecord } = await import(MOD);
    queuePreamble('z-ttl', [{ name: 'e4', type: 'A', ttl: 300, records: [{ value: '1.1.1.1' }] }]);
    fetchMock
      .mockResolvedValueOnce(ok({ action: {} }, 201)) // DELETE old rrset
      .mockResolvedValueOnce(ok({ rrset: { name: 'e4', type: 'A' } }, 201)); // POST create

    await createDNSRecord('tok', 'z-ttl', {
      type: 'A',
      name: 'e4.carbonstack.dev',
      value: '9.9.9.9',
      ttl: 60,
    });

    const calls = fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`);
    expect(calls.some((c) => c.includes('set_records'))).toBe(false);
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(true);
  });

  it('no existing rrset: plain create, no action, no delete', async () => {
    vi.resetModules();
    const { createDNSRecord } = await import(MOD);
    queuePreamble('z-fresh', []);
    fetchMock.mockResolvedValueOnce(ok({ rrset: { name: 'e4', type: 'A' } }, 201));

    await createDNSRecord('tok', 'z-fresh', {
      type: 'A',
      name: 'e4.carbonstack.dev',
      value: '9.9.9.9',
      ttl: 60,
    });

    const calls = fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`);
    expect(calls.some((c) => c.includes('set_records'))).toBe(false);
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });
});
