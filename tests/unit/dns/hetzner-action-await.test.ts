/**
 * Hetzner DNS writes return an async Cloud API Action (HA-correctness Task 4,
 * R5). The record is not changed until the action succeeds, so a write only
 * counts, and a read-back is only meaningful, once the action is done.
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

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const { createDNSRecord } = await import('../../../src/lib/hetzner-dns.js');
const RECORD = { type: 'A', name: 'app.carbonstack.dev', value: '203.0.113.9', ttl: 60 };

/**
 * Route by URL (the zone-name lookup is cached per process, so a fixed queue
 * would drift): an existing 60s rrset makes the write a set_records action,
 * whose response and each action poll come from `writes` in order.
 */
function route(writes: Response[]) {
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes('/rrsets?')) {
      return ok({
        rrsets: [{ name: 'app', type: 'A', ttl: 60, records: [{ value: '198.51.100.1' }] }],
        meta: { pagination: { next_page: null } },
      });
    }
    if (u.includes('/actions')) return writes.shift() as Response;
    return ok({ zone: { id: 'z1', name: 'carbonstack.dev' } });
  });
}

describe('hetzner createDNSRecord awaits the write action', () => {
  it('a running action is polled until it succeeds before the write returns', async () => {
    route([
      ok({ action: { id: 7, status: 'running' } }, 201),
      ok({ action: { id: 7, status: 'running' } }),
      ok({ action: { id: 7, status: 'success' } }),
    ]);
    await createDNSRecord('t', 'z1', RECORD);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.endsWith('/actions/7'))).toHaveLength(2);
  });

  it('an action that ends in error fails the write', async () => {
    route([
      ok({ action: { id: 8, status: 'running' } }, 201),
      ok({ action: { id: 8, status: 'error', error: { message: 'zone locked' } } }),
    ]);
    await expect(createDNSRecord('t', 'z1', RECORD)).rejects.toThrow(
      /action 8 failed: zone locked/,
    );
  });

  it('an already-successful action needs no poll', async () => {
    route([ok({ action: { id: 9, status: 'success' } }, 201)]);
    await createDNSRecord('t', 'z1', RECORD);
    const polls = fetchMock.mock.calls.filter((c) => /\/actions\/9$/.test(String(c[0])));
    expect(polls).toHaveLength(0);
  });
});
