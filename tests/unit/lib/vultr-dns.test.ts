/**
 * Unit coverage for the Vultr DNS backend (src/lib/vultr-dns.js).
 *
 * Same mocking conventions as dns-ownership.test.ts / dns-apex-wildcard.test.ts:
 * `globalThis.fetch` stubbed per-test, restored in afterEach.
 *
 * Vultr-specific behavior pinned here:
 *   - CURSOR pagination (`meta.links.next`), not page numbers — an empty
 *     string means "no more pages", which is easy to mistake for a present
 *     cursor if you only null-check.
 *   - Updates are PATCH and answer 204 No Content, so the module must not try
 *     to parse a body off them.
 *   - Vultr's own API reference is internally inconsistent about whether a
 *     listed record's `name` is relative (`www`, as the create example uses)
 *     or fully qualified (`foo.example.com`, as the list example shows), so
 *     the module matches either spelling. Both are covered below.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}
function created(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 201 });
}
function noContent(): Response {
  return new Response(null, { status: 204 });
}
/** A terminal `/records` page — empty `next` cursor means no more pages. */
function records(rows: unknown[]): Response {
  return ok({ records: rows, meta: { total: rows.length, links: { next: '', prev: '' } } });
}

const MOD = '../../../src/lib/vultr-dns.js';

describe('vultr-dns getZones', () => {
  it('maps each domain onto {id, name} with the domain NAME as the id', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        domains: [{ domain: 'example.com' }, { domain: 'carbonstack.dev' }],
        meta: { total: 2, links: { next: '', prev: '' } },
      }),
    );

    const { getZones } = await import(MOD);
    const zones = await getZones('tok');

    expect(zones).toEqual([
      { id: 'example.com', name: 'example.com' },
      { id: 'carbonstack.dev', name: 'carbonstack.dev' },
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/v2/domains?per_page=500');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('follows meta.links.next as a cursor until it comes back empty', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        domains: [{ domain: 'one.example' }],
        meta: { links: { next: 'CURSOR_TWO', prev: '' } },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      ok({
        domains: [{ domain: 'two.example' }],
        meta: { links: { next: '', prev: 'CURSOR_ONE' } },
      }),
    );

    const { getZones } = await import(MOD);
    const zones = await getZones('tok');

    expect(zones.map((z: { name: string }) => z.name)).toEqual(['one.example', 'two.example']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The first page carries no cursor; the second carries the one page 1 handed back.
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('cursor=');
    expect(String(fetchMock.mock.calls[1][0])).toContain('cursor=CURSOR_TWO');
  });

  it("surfaces Vultr's {error} envelope without echoing the token", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Invalid API key', status: 401 }), { status: 401 }),
    );

    const { getZones } = await import(MOD);
    await expect(getZones('super-secret-token')).rejects.toThrow(
      /Vultr DNS API error: Invalid API key/,
    );
    await expect(getZones('super-secret-token')).rejects.not.toThrow(/super-secret-token/);
  });
});

describe('vultr-dns createDNSRecord', () => {
  it('creates the apex with an EMPTY relative name at ttl 60', async () => {
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(created({ record: { id: 'rec-1', name: '' } }));

    const { createDNSRecord } = await import(MOD);
    const rec = await createDNSRecord('tok', 'example.com', {
      type: 'A',
      name: 'example.com',
      value: '1.2.3.4',
    });

    expect(rec).toEqual({ id: 'rec-1', name: '' });
    const create = fetchMock.mock.calls[1];
    expect(String(create[0])).toBe('https://api.vultr.com/v2/domains/example.com/records');
    expect(create[1].method).toBe('POST');
    expect(JSON.parse(create[1].body)).toEqual({
      type: 'A',
      name: '',
      data: '1.2.3.4',
      ttl: 60,
    });
  });

  it('converts a wildcard FQDN to "*" and a subdomain to its label', async () => {
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(created({ record: {} }));
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(created({ record: {} }));

    const { createDNSRecord } = await import(MOD);
    await createDNSRecord('tok', 'example.com', {
      type: 'A',
      name: '*.example.com',
      value: '1.2.3.4',
    });
    await createDNSRecord('tok', 'example.com', {
      type: 'A',
      name: 'e1.example.com',
      value: '1.2.3.4',
    });

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).name).toBe('*');
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).name).toBe('e1');
  });

  it('PATCHes the existing record id and tolerates the 204 empty body', async () => {
    fetchMock.mockResolvedValueOnce(
      records([{ id: 'rec-9', type: 'A', name: '', data: '9.9.9.9', ttl: 300 }]),
    );
    fetchMock.mockResolvedValueOnce(noContent());

    const { createDNSRecord } = await import(MOD);
    const rec = await createDNSRecord('tok', 'example.com', {
      type: 'A',
      name: 'example.com',
      value: '1.2.3.4',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const update = fetchMock.mock.calls[1];
    expect(String(update[0])).toBe('https://api.vultr.com/v2/domains/example.com/records/rec-9');
    expect(update[1].method).toBe('PATCH');
    expect(JSON.parse(update[1].body)).toEqual({ name: '', data: '1.2.3.4', ttl: 60 });
    // 204 carries no body — the module reports the record it just wrote.
    expect(rec).toEqual({ id: 'rec-9', type: 'A', name: '', data: '1.2.3.4', ttl: 60 });
  });

  it('matches an existing record stored under its FQDN spelling', async () => {
    // Vultr's list example returns "foo.example.com" where create takes "www".
    // Either spelling must resolve to an update, never a duplicate create.
    fetchMock.mockResolvedValueOnce(
      records([{ id: 'rec-fq', type: 'A', name: 'e1.example.com', data: '9.9.9.9' }]),
    );
    fetchMock.mockResolvedValueOnce(noContent());

    const { createDNSRecord } = await import(MOD);
    await createDNSRecord('tok', 'example.com', {
      type: 'A',
      name: 'e1.example.com',
      value: '1.2.3.4',
    });

    expect(fetchMock.mock.calls[1][1].method).toBe('PATCH');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/records/rec-fq');
  });

  it('honours an explicit ttl', async () => {
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(created({ record: {} }));

    const { createDNSRecord } = await import(MOD);
    await createDNSRecord('tok', 'example.com', {
      type: 'A',
      name: 'example.com',
      value: '1.2.3.4',
      ttl: 120,
    });

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).ttl).toBe(120);
  });
});

describe('vultr-dns deleteDNSRecord (ownership-aware)', () => {
  it('deletes only records whose data is in ownedIps', async () => {
    fetchMock.mockResolvedValueOnce(
      records([
        { id: 'a', type: 'A', name: 'e1', data: '1.2.3.4' }, // ours
        { id: 'b', type: 'A', name: 'e1', data: '5.6.7.8' }, // theirs
        { id: 'c', type: 'A', name: 'e1', data: '9.10.11.12' }, // theirs
      ]),
    );
    fetchMock.mockResolvedValueOnce(noContent());

    const { deleteDNSRecord } = await import(MOD);
    const result = await deleteDNSRecord('tok', 'example.com', 'e1.example.com', ['1.2.3.4']);

    expect(result).toEqual({
      deleted: 1,
      skipped: 2,
      total: 3,
      skippedTargets: ['5.6.7.8', '9.10.11.12'],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('/records/a');
    expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
  });

  it('deletes every record when all targets are owned', async () => {
    fetchMock.mockResolvedValueOnce(
      records([
        { id: 'a', type: 'A', name: 'e1', data: '1.2.3.4' },
        { id: 'b', type: 'A', name: 'e1', data: '1.2.3.5' },
      ]),
    );
    fetchMock.mockResolvedValueOnce(noContent());
    fetchMock.mockResolvedValueOnce(noContent());

    const { deleteDNSRecord } = await import(MOD);
    const result = await deleteDNSRecord('tok', 'example.com', 'e1.example.com', [
      '1.2.3.4',
      '1.2.3.5',
    ]);

    expect(result).toEqual({ deleted: 2, skipped: 0, total: 2, skippedTargets: [] });
  });

  it('refuses to delete anything when ownedIps is empty (safer default)', async () => {
    fetchMock.mockResolvedValueOnce(records([{ id: 'a', type: 'A', name: 'e1', data: '1.2.3.4' }]));

    const { deleteDNSRecord } = await import(MOD);
    const result = await deleteDNSRecord('tok', 'example.com', 'e1.example.com', []);

    expect(result).toEqual({ deleted: 0, skipped: 1, total: 1, skippedTargets: ['1.2.3.4'] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns total=0 when the record does not exist', async () => {
    fetchMock.mockResolvedValueOnce(
      records([{ id: 'a', type: 'A', name: 'other', data: '1.2.3.4' }]),
    );

    const { deleteDNSRecord } = await import(MOD);
    const result = await deleteDNSRecord('tok', 'example.com', 'absent.example.com', ['1.2.3.4']);

    expect(result).toEqual({ deleted: 0, skipped: 0, total: 0, skippedTargets: [] });
  });

  it('matches the apex by its EMPTY relative name, not the FQDN', async () => {
    fetchMock.mockResolvedValueOnce(records([{ id: 'z', type: 'A', name: '', data: '1.2.3.4' }]));
    fetchMock.mockResolvedValueOnce(noContent());

    const { deleteDNSRecord } = await import(MOD);
    const result = await deleteDNSRecord('tok', 'example.com', 'example.com', ['1.2.3.4']);

    expect(result.deleted).toBe(1);
  });

  it('walks every cursor page before deciding what is deletable', async () => {
    // The owned record lives on page 2 — a single-page walk would silently
    // leave it behind on destroy.
    fetchMock.mockResolvedValueOnce(
      ok({
        records: [{ id: 'p1', type: 'A', name: 'e1', data: '5.6.7.8' }],
        meta: { links: { next: 'PAGE2', prev: '' } },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      ok({
        records: [{ id: 'p2', type: 'A', name: 'e1', data: '1.2.3.4' }],
        meta: { links: { next: '', prev: '' } },
      }),
    );
    fetchMock.mockResolvedValueOnce(noContent());

    const { deleteDNSRecord } = await import(MOD);
    const result = await deleteDNSRecord('tok', 'example.com', 'e1.example.com', ['1.2.3.4']);

    expect(result).toEqual({
      deleted: 1,
      skipped: 1,
      total: 2,
      skippedTargets: ['5.6.7.8'],
    });
    expect(String(fetchMock.mock.calls[2][0])).toContain('/records/p2');
  });
});

describe('vultr-dns deleteApexAndWildcard', () => {
  it('deletes both halves of the pair and reports deletedAny', async () => {
    fetchMock
      .mockResolvedValueOnce(records([{ id: 'a', type: 'A', name: '', data: '1.2.3.4' }]))
      .mockResolvedValueOnce(records([{ id: 'b', type: 'A', name: '*', data: '1.2.3.4' }]))
      .mockResolvedValue(noContent());

    const { deleteApexAndWildcard } = await import(MOD);
    const result = await deleteApexAndWildcard('tok', 'example.com', 'example.com', ['1.2.3.4']);

    expect(result).toEqual({ deletedAny: true, preservedTargets: [] });
  });

  it('preserves foreign targets from BOTH halves in preservedTargets', async () => {
    fetchMock
      .mockResolvedValueOnce(records([{ id: 'a', type: 'A', name: '', data: '5.5.5.5' }]))
      .mockResolvedValueOnce(records([{ id: 'b', type: 'A', name: '*', data: '6.6.6.6' }]));

    const { deleteApexAndWildcard } = await import(MOD);
    const result = await deleteApexAndWildcard('tok', 'example.com', 'example.com', ['1.2.3.4']);

    expect(result).toEqual({ deletedAny: false, preservedTargets: ['5.5.5.5', '6.6.6.6'] });
  });
});

describe('vultr-dns upsertApexAndWildcard', () => {
  it('is idempotent — PATCHes both existing records rather than creating duplicates', async () => {
    fetchMock.mockResolvedValueOnce(records([{ id: 'ap', type: 'A', name: '', data: '9.9.9.9' }]));
    fetchMock.mockResolvedValueOnce(noContent());
    fetchMock.mockResolvedValueOnce(records([{ id: 'wc', type: 'A', name: '*', data: '9.9.9.9' }]));
    fetchMock.mockResolvedValueOnce(noContent());

    const { upsertApexAndWildcard } = await import(MOD);
    await upsertApexAndWildcard({ token: 'tok', zoneId: 'example.com' }, 'example.com', '1.2.3.4');

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1][1].method).toBe('PATCH');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      name: '',
      data: '1.2.3.4',
      ttl: 60,
    });
    expect(fetchMock.mock.calls[3][1].method).toBe('PATCH');
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({
      name: '*',
      data: '1.2.3.4',
      ttl: 60,
    });
    for (const call of fetchMock.mock.calls) {
      expect(call[1].headers.Authorization).toBe('Bearer tok');
    }
  });
});

describe('vultr-dns setupSimple', () => {
  it('creates the apex + wildcard pair at ttl 60 and returns the simple-mode shape', async () => {
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(created({ record: { id: 'rec-1', name: '' } }));
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(created({ record: { id: 'rec-2', name: '*' } }));

    const { setupSimple } = await import(MOD);
    const result = await setupSimple('tok', 'example.com', 'example.com', '1.2.3.4', {
      onProgress: () => {},
    });

    expect(result).toEqual({ success: true, mode: 'simple', record: { id: 'rec-1', name: '' } });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).name).toBe('');
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).name).toBe('*');
  });

  it('returns {success:false, error} instead of throwing when the API rejects', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Domain not found', status: 404 }), { status: 404 }),
    );

    const { setupSimple } = await import(MOD);
    const result = await setupSimple('tok', 'example.com', 'example.com', '1.2.3.4', {
      onProgress: () => {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Domain not found/);
  });

  // Structural pin for the concurrent-spinner guard enforced across every DNS
  // backend by tests/unit/deploy/preplan-spinner-coverage.test.ts.
  it('uses the shared `onProgress ? null : spinner()` guard literal', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../src/lib/vultr-dns.js', import.meta.url)),
      'utf8',
    );
    expect(src).toMatch(/const s = onProgress \? null : spinner\(\)/);
  });
});

describe('vultr-dns setupHA', () => {
  it('points apex + wildcard at the PRIMARY (first) server and reports both IPs', async () => {
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(created({ record: {} }));
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(created({ record: {} }));

    const { setupHA } = await import(MOD);
    const result = await setupHA('tok', 'example.com', 'example.com', [
      { name: 'primary', ip: '1.2.3.4', region: 'ewr' },
      { name: 'standby', ip: '5.6.7.8', region: 'lax' },
    ]);

    expect(result).toEqual({
      success: true,
      mode: 'dns',
      primaryIp: '1.2.3.4',
      standbyIp: '5.6.7.8',
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).data).toBe('1.2.3.4');
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).data).toBe('1.2.3.4');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).ttl).toBe(60);
  });
});
