/**
 * Unit coverage for the Linode DNS backend (src/lib/linode-dns.js).
 *
 * Same mocking conventions as dns-ownership.test.ts / dns-apex-wildcard.test.ts:
 * `globalThis.fetch` stubbed per-test, restored in afterEach.
 *
 * Two things make Linode the odd one out among the DNS backends, and both are
 * pinned here:
 *   1. Zone identity is a NUMERIC domain id, so every public entry point has
 *      to resolve the domain's name before it can turn an FQDN into Linode's
 *      relative form (apex = empty string). That costs one extra GET, and the
 *      call-count assertions below are what stop it becoming one-per-record.
 *   2. `ttl_sec` is an enum with a floor of 300 — the project-wide TTL of 60
 *      is NOT achievable on Linode. The API silently rounds to the nearest
 *      allowed value, so we round the same way client-side and send what
 *      Linode will actually store.
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
/** GET /v4/domains/{id} — the domain object sits at the top level. */
function domain(name: string): Response {
  return ok({ id: 4321, domain: name, type: 'master' });
}
/** A single-page `/records` listing (page 1 of 1). */
function records(rows: unknown[]): Response {
  return ok({ data: rows, page: 1, pages: 1, results: rows.length });
}

const MOD = '../../../src/lib/linode-dns.js';

describe('linode-dns getZones', () => {
  it('maps {id: String(d.id), name: d.domain}', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        data: [
          { id: 4321, domain: 'example.com' },
          { id: 8765, domain: 'carbonstack.dev' },
        ],
        page: 1,
        pages: 1,
        results: 2,
      }),
    );

    const { getZones } = await import(MOD);
    const zones = await getZones('tok');

    expect(zones).toEqual([
      { id: '4321', name: 'example.com' },
      { id: '8765', name: 'carbonstack.dev' },
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/v4/domains?page=1');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('walks the page/pages envelope to completion (multi-page fixture)', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ data: [{ id: 1, domain: 'one.example' }], page: 1, pages: 3, results: 3 }),
    );
    fetchMock.mockResolvedValueOnce(
      ok({ data: [{ id: 2, domain: 'two.example' }], page: 2, pages: 3, results: 3 }),
    );
    fetchMock.mockResolvedValueOnce(
      ok({ data: [{ id: 3, domain: 'three.example' }], page: 3, pages: 3, results: 3 }),
    );

    const { getZones } = await import(MOD);
    const zones = await getZones('tok');

    expect(zones.map((z: { name: string }) => z.name)).toEqual([
      'one.example',
      'two.example',
      'three.example',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toContain('page=3');
  });

  it("surfaces Linode's errors[].reason envelope without echoing the token", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ reason: 'Invalid Token' }] }), { status: 401 }),
    );

    const { getZones } = await import(MOD);
    await expect(getZones('super-secret-token')).rejects.toThrow(
      /Linode DNS API error: Invalid Token/,
    );
    await expect(getZones('super-secret-token')).rejects.not.toThrow(/super-secret-token/);
  });
});

describe('linode-dns createDNSRecord', () => {
  it('creates the apex with an EMPTY relative name and ttl_sec clamped to 300', async () => {
    fetchMock.mockResolvedValueOnce(domain('example.com'));
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(ok({ id: 99, name: '', target: '1.2.3.4' }));

    const { createDNSRecord } = await import(MOD);
    const rec = await createDNSRecord('tok', '4321', {
      type: 'A',
      name: 'example.com',
      value: '1.2.3.4',
    });

    expect(rec).toEqual({ id: 99, name: '', target: '1.2.3.4' });
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.linode.com/v4/domains/4321');

    const create = fetchMock.mock.calls[2];
    expect(String(create[0])).toBe('https://api.linode.com/v4/domains/4321/records');
    expect(create[1].method).toBe('POST');
    expect(JSON.parse(create[1].body)).toEqual({
      type: 'A',
      name: '',
      target: '1.2.3.4',
      // The contract asks for 60; Linode's enum floor is 300 and the API
      // rounds anything else to the nearest member, so we send 300.
      ttl_sec: 300,
    });
  });

  it('converts a wildcard FQDN to "*" and a subdomain to its label', async () => {
    fetchMock.mockResolvedValueOnce(domain('example.com'));
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(ok({ id: 1 }));
    fetchMock.mockResolvedValueOnce(domain('example.com'));
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(ok({ id: 2 }));

    const { createDNSRecord } = await import(MOD);
    await createDNSRecord('tok', '4321', {
      type: 'A',
      name: '*.example.com',
      value: '1.2.3.4',
    });
    await createDNSRecord('tok', '4321', {
      type: 'A',
      name: 'e1.example.com',
      value: '1.2.3.4',
    });

    expect(JSON.parse(fetchMock.mock.calls[2][1].body).name).toBe('*');
    expect(JSON.parse(fetchMock.mock.calls[5][1].body).name).toBe('e1');
  });

  it('PUTs the existing record id instead of creating a duplicate', async () => {
    fetchMock.mockResolvedValueOnce(domain('example.com'));
    fetchMock.mockResolvedValueOnce(
      records([{ id: 55, type: 'A', name: '', target: '9.9.9.9', ttl_sec: 3600 }]),
    );
    fetchMock.mockResolvedValueOnce(ok({ id: 55, target: '1.2.3.4' }));

    const { createDNSRecord } = await import(MOD);
    await createDNSRecord('tok', '4321', {
      type: 'A',
      name: 'example.com',
      value: '1.2.3.4',
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const update = fetchMock.mock.calls[2];
    expect(String(update[0])).toBe('https://api.linode.com/v4/domains/4321/records/55');
    expect(update[1].method).toBe('PUT');
    expect(JSON.parse(update[1].body)).toEqual({
      type: 'A',
      name: '',
      target: '1.2.3.4',
      ttl_sec: 300,
    });
  });

  it('rounds a requested ttl to the NEAREST allowed enum member, as Linode does', async () => {
    // 4000 sits between 3600 and 7200 — nearest is 3600.
    fetchMock.mockResolvedValueOnce(domain('example.com'));
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(ok({}));

    const { createDNSRecord } = await import(MOD);
    await createDNSRecord('tok', '4321', {
      type: 'A',
      name: 'example.com',
      value: '1.2.3.4',
      ttl: 4000,
    });

    expect(JSON.parse(fetchMock.mock.calls[2][1].body).ttl_sec).toBe(3600);
  });
});

describe('linode-dns deleteDNSRecord (ownership-aware)', () => {
  it('deletes only records whose target is in ownedIps', async () => {
    fetchMock.mockResolvedValueOnce(domain('example.com'));
    fetchMock.mockResolvedValueOnce(
      records([
        { id: 1, type: 'A', name: 'e1', target: '1.2.3.4' }, // ours
        { id: 2, type: 'A', name: 'e1', target: '5.6.7.8' }, // theirs
        { id: 3, type: 'A', name: 'e1', target: '9.10.11.12' }, // theirs
      ]),
    );
    fetchMock.mockResolvedValueOnce(ok({}));

    const { deleteDNSRecord } = await import(MOD);
    const result = await deleteDNSRecord('tok', '4321', 'e1.example.com', ['1.2.3.4']);

    expect(result).toEqual({
      deleted: 1,
      skipped: 2,
      total: 3,
      skippedTargets: ['5.6.7.8', '9.10.11.12'],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toBe(
      'https://api.linode.com/v4/domains/4321/records/1',
    );
    expect(fetchMock.mock.calls[2][1].method).toBe('DELETE');
  });

  it('deletes every record when all targets are owned', async () => {
    fetchMock.mockResolvedValueOnce(domain('example.com'));
    fetchMock.mockResolvedValueOnce(
      records([
        { id: 1, type: 'A', name: 'e1', target: '1.2.3.4' },
        { id: 2, type: 'A', name: 'e1', target: '1.2.3.5' },
      ]),
    );
    fetchMock.mockResolvedValueOnce(ok({}));
    fetchMock.mockResolvedValueOnce(ok({}));

    const { deleteDNSRecord } = await import(MOD);
    const result = await deleteDNSRecord('tok', '4321', 'e1.example.com', ['1.2.3.4', '1.2.3.5']);

    expect(result).toEqual({ deleted: 2, skipped: 0, total: 2, skippedTargets: [] });
  });

  it('refuses to delete anything when ownedIps is empty (safer default)', async () => {
    fetchMock.mockResolvedValueOnce(domain('example.com'));
    fetchMock.mockResolvedValueOnce(records([{ id: 1, type: 'A', name: 'e1', target: '1.2.3.4' }]));

    const { deleteDNSRecord } = await import(MOD);
    const result = await deleteDNSRecord('tok', '4321', 'e1.example.com', []);

    expect(result).toEqual({ deleted: 0, skipped: 1, total: 1, skippedTargets: ['1.2.3.4'] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns total=0 when the record does not exist', async () => {
    fetchMock.mockResolvedValueOnce(domain('example.com'));
    fetchMock.mockResolvedValueOnce(
      records([{ id: 1, type: 'A', name: 'other', target: '1.2.3.4' }]),
    );

    const { deleteDNSRecord } = await import(MOD);
    const result = await deleteDNSRecord('tok', '4321', 'absent.example.com', ['1.2.3.4']);

    expect(result).toEqual({ deleted: 0, skipped: 0, total: 0, skippedTargets: [] });
  });

  it('matches the apex by its EMPTY relative name, not the FQDN', async () => {
    fetchMock.mockResolvedValueOnce(domain('example.com'));
    fetchMock.mockResolvedValueOnce(records([{ id: 7, type: 'A', name: '', target: '1.2.3.4' }]));
    fetchMock.mockResolvedValueOnce(ok({}));

    const { deleteDNSRecord } = await import(MOD);
    const result = await deleteDNSRecord('tok', '4321', 'example.com', ['1.2.3.4']);

    expect(result.deleted).toBe(1);
  });
});

describe('linode-dns deleteApexAndWildcard', () => {
  it('resolves the domain name ONCE, then deletes both halves of the pair', async () => {
    fetchMock.mockResolvedValueOnce(domain('example.com'));
    fetchMock
      .mockResolvedValueOnce(records([{ id: 1, type: 'A', name: '', target: '1.2.3.4' }]))
      .mockResolvedValueOnce(records([{ id: 2, type: 'A', name: '*', target: '1.2.3.4' }]))
      .mockResolvedValue(ok({}));

    const { deleteApexAndWildcard } = await import(MOD);
    const result = await deleteApexAndWildcard('tok', '4321', 'example.com', ['1.2.3.4']);

    expect(result).toEqual({ deletedAny: true, preservedTargets: [] });
    // Exactly one /domains/4321 lookup — not one per half.
    const zoneLookups = fetchMock.mock.calls.filter(
      (c) => String(c[0]) === 'https://api.linode.com/v4/domains/4321',
    );
    expect(zoneLookups).toHaveLength(1);
  });

  it('preserves foreign targets from BOTH halves in preservedTargets', async () => {
    fetchMock.mockResolvedValueOnce(domain('example.com'));
    fetchMock
      .mockResolvedValueOnce(records([{ id: 1, type: 'A', name: '', target: '5.5.5.5' }]))
      .mockResolvedValueOnce(records([{ id: 2, type: 'A', name: '*', target: '6.6.6.6' }]));

    const { deleteApexAndWildcard } = await import(MOD);
    const result = await deleteApexAndWildcard('tok', '4321', 'example.com', ['1.2.3.4']);

    expect(result).toEqual({ deletedAny: false, preservedTargets: ['5.5.5.5', '6.6.6.6'] });
  });
});

describe('linode-dns upsertApexAndWildcard', () => {
  it('resolves the domain name once, then PUTs both existing records (idempotent)', async () => {
    fetchMock.mockResolvedValueOnce(domain('example.com'));
    fetchMock.mockResolvedValueOnce(records([{ id: 10, type: 'A', name: '', target: '9.9.9.9' }]));
    fetchMock.mockResolvedValueOnce(ok({ id: 10 }));
    fetchMock.mockResolvedValueOnce(records([{ id: 11, type: 'A', name: '*', target: '9.9.9.9' }]));
    fetchMock.mockResolvedValueOnce(ok({ id: 11 }));

    const { upsertApexAndWildcard } = await import(MOD);
    await upsertApexAndWildcard({ token: 'tok', zoneId: '4321' }, 'example.com', '1.2.3.4');

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[2][1].method).toBe('PUT');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      type: 'A',
      name: '',
      target: '1.2.3.4',
      ttl_sec: 300,
    });
    expect(fetchMock.mock.calls[4][1].method).toBe('PUT');
    expect(JSON.parse(fetchMock.mock.calls[4][1].body)).toEqual({
      type: 'A',
      name: '*',
      target: '1.2.3.4',
      ttl_sec: 300,
    });
    for (const call of fetchMock.mock.calls) {
      expect(call[1].headers.Authorization).toBe('Bearer tok');
    }
  });
});

describe('linode-dns setupSimple', () => {
  it('creates the apex + wildcard pair and returns the simple-mode shape', async () => {
    fetchMock.mockResolvedValueOnce(domain('example.com'));
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(ok({ id: 1, name: '' }));
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(ok({ id: 2, name: '*' }));

    const { setupSimple } = await import(MOD);
    const result = await setupSimple('tok', '4321', 'example.com', '1.2.3.4', {
      onProgress: () => {},
    });

    expect(result).toEqual({ success: true, mode: 'simple', record: { id: 1, name: '' } });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).name).toBe('');
    expect(JSON.parse(fetchMock.mock.calls[4][1].body).name).toBe('*');
  });

  it('returns {success:false, error} instead of throwing when the API rejects', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ reason: 'Not found' }] }), { status: 404 }),
    );

    const { setupSimple } = await import(MOD);
    const result = await setupSimple('tok', '4321', 'example.com', '1.2.3.4', {
      onProgress: () => {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Not found/);
  });

  // Structural pin for the concurrent-spinner guard enforced across every DNS
  // backend by tests/unit/deploy/preplan-spinner-coverage.test.ts.
  it('uses the shared `onProgress ? null : spinner()` guard literal', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../src/lib/linode-dns.js', import.meta.url)),
      'utf8',
    );
    expect(src).toMatch(/const s = onProgress \? null : spinner\(\)/);
  });
});

describe('linode-dns setupHA', () => {
  it('points apex + wildcard at the PRIMARY (first) server and reports both IPs', async () => {
    fetchMock.mockResolvedValueOnce(domain('example.com'));
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(ok({}));
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(ok({}));

    const { setupHA } = await import(MOD);
    const result = await setupHA('tok', '4321', 'example.com', [
      { name: 'primary', ip: '1.2.3.4', region: 'us-east' },
      { name: 'standby', ip: '5.6.7.8', region: 'us-west' },
    ]);

    expect(result).toEqual({
      success: true,
      mode: 'dns',
      primaryIp: '1.2.3.4',
      standbyIp: '5.6.7.8',
    });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).target).toBe('1.2.3.4');
    expect(JSON.parse(fetchMock.mock.calls[4][1].body).target).toBe('1.2.3.4');
  });
});
