/**
 * Unit coverage for the DigitalOcean DNS backend (src/lib/digitalocean-dns.js).
 *
 * Mirrors the mocking conventions of dns-ownership.test.ts and
 * dns-apex-wildcard.test.ts: `globalThis.fetch` is stubbed per-test and
 * restored in afterEach, so every assertion pins the exact wire calls the
 * module makes (URL, method, body) rather than trusting a hand-rolled client.
 *
 * The behaviors under test are the ones the DNS-backend contract makes
 * load-bearing across every provider:
 *   - getZones maps DO's name-keyed zones onto {id, name} and walks pages
 *   - createDNSRecord is update-or-create, never blind-create
 *   - FQDN → zone-relative conversion (apex is `@` on DO, wildcard `*`)
 *   - deleteDNSRecord's ownership filter (the 2026-05-16 blast-radius bug)
 *   - deleteApexAndWildcard deletes BOTH halves of the pair deploy creates
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
/** A single-page `/records` listing (no further pages). */
function records(rows: unknown[]): Response {
  return ok({ domain_records: rows, links: {}, meta: { total: rows.length } });
}

const MOD = '../../../src/lib/digitalocean-dns.js';

describe('digitalocean-dns getZones', () => {
  it('maps each domain onto {id, name} with the domain NAME as the id', async () => {
    // DO has no numeric zone id — the domain name IS the zone identity, and
    // it is what every downstream /domains/{name}/records call interpolates.
    fetchMock.mockResolvedValueOnce(
      ok({
        domains: [
          { name: 'example.com', ttl: 1800 },
          { name: 'carbonstack.dev', ttl: 1800 },
        ],
        links: {},
        meta: { total: 2 },
      }),
    );

    const { getZones } = await import(MOD);
    const zones = await getZones('tok');

    expect(zones).toEqual([
      { id: 'example.com', name: 'example.com' },
      { id: 'carbonstack.dev', name: 'carbonstack.dev' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/v2/domains?per_page=200&page=1');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('walks links.pages.next to completion (multi-page fixture)', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        domains: [{ name: 'one.example' }],
        links: { pages: { next: 'https://api.digitalocean.com/v2/domains?page=2' } },
      }),
    );
    fetchMock.mockResolvedValueOnce(ok({ domains: [{ name: 'two.example' }], links: {} }));

    const { getZones } = await import(MOD);
    const zones = await getZones('tok');

    expect(zones.map((z: { name: string }) => z.name)).toEqual(['one.example', 'two.example']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('page=2');
  });

  it('throws a DO-shaped error message without echoing the token', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'unauthorized', message: 'Unable to authenticate you' }), {
        status: 401,
      }),
    );

    const { getZones } = await import(MOD);
    await expect(getZones('super-secret-token')).rejects.toThrow(
      /DigitalOcean DNS API error: Unable to authenticate you/,
    );
    await expect(getZones('super-secret-token')).rejects.not.toThrow(/super-secret-token/);
  });
});

describe('digitalocean-dns createDNSRecord', () => {
  it('creates the apex as relative name "@" when no record exists', async () => {
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(created({ domain_record: { id: 1, name: '@' } }));

    const { createDNSRecord } = await import(MOD);
    const rec = await createDNSRecord('tok', 'example.com', {
      type: 'A',
      name: 'example.com',
      value: '1.2.3.4',
    });

    expect(rec).toEqual({ id: 1, name: '@' });
    const create = fetchMock.mock.calls[1];
    expect(String(create[0])).toBe('https://api.digitalocean.com/v2/domains/example.com/records');
    expect(create[1].method).toBe('POST');
    expect(JSON.parse(create[1].body)).toEqual({
      type: 'A',
      name: '@',
      data: '1.2.3.4',
      ttl: 60,
    });
  });

  it('converts a wildcard FQDN to "*" and a subdomain to its label', async () => {
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(created({ domain_record: { id: 2 } }));
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(created({ domain_record: { id: 3 } }));

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

  it('PUTs the existing record id instead of creating a duplicate', async () => {
    fetchMock.mockResolvedValueOnce(
      records([{ id: 42, type: 'A', name: '@', data: '9.9.9.9', ttl: 1800 }]),
    );
    fetchMock.mockResolvedValueOnce(ok({ domain_record: { id: 42, data: '1.2.3.4' } }));

    const { createDNSRecord } = await import(MOD);
    await createDNSRecord('tok', 'example.com', {
      type: 'A',
      name: 'example.com',
      value: '1.2.3.4',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const update = fetchMock.mock.calls[1];
    expect(String(update[0])).toBe(
      'https://api.digitalocean.com/v2/domains/example.com/records/42',
    );
    expect(update[1].method).toBe('PUT');
    expect(JSON.parse(update[1].body)).toEqual({
      type: 'A',
      name: '@',
      data: '1.2.3.4',
      ttl: 60,
    });
  });

  it('honours an explicit ttl and defaults to 60 otherwise', async () => {
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(created({ domain_record: {} }));

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

describe('digitalocean-dns deleteDNSRecord (ownership-aware)', () => {
  it('deletes only records whose data is in ownedIps', async () => {
    fetchMock.mockResolvedValueOnce(
      records([
        { id: 1, type: 'A', name: 'e1', data: '1.2.3.4' }, // ours
        { id: 2, type: 'A', name: 'e1', data: '5.6.7.8' }, // theirs
        { id: 3, type: 'A', name: 'e1', data: '9.10.11.12' }, // theirs
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
    expect(String(fetchMock.mock.calls[1][0])).toContain('/records/1');
    expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
  });

  it('deletes every record when all targets are owned', async () => {
    fetchMock.mockResolvedValueOnce(
      records([
        { id: 1, type: 'A', name: 'e1', data: '1.2.3.4' },
        { id: 2, type: 'A', name: 'e1', data: '1.2.3.5' },
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
    fetchMock.mockResolvedValueOnce(records([{ id: 1, type: 'A', name: 'e1', data: '1.2.3.4' }]));

    const { deleteDNSRecord } = await import(MOD);
    const result = await deleteDNSRecord('tok', 'example.com', 'e1.example.com', []);

    expect(result).toEqual({ deleted: 0, skipped: 1, total: 1, skippedTargets: ['1.2.3.4'] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns total=0 when the record does not exist', async () => {
    fetchMock.mockResolvedValueOnce(
      records([{ id: 1, type: 'A', name: 'other', data: '1.2.3.4' }]),
    );

    const { deleteDNSRecord } = await import(MOD);
    const result = await deleteDNSRecord('tok', 'example.com', 'absent.example.com', ['1.2.3.4']);

    expect(result).toEqual({ deleted: 0, skipped: 0, total: 0, skippedTargets: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('matches the apex by its relative "@" form, not the FQDN', async () => {
    fetchMock.mockResolvedValueOnce(records([{ id: 7, type: 'A', name: '@', data: '1.2.3.4' }]));
    fetchMock.mockResolvedValueOnce(noContent());

    const { deleteDNSRecord } = await import(MOD);
    const result = await deleteDNSRecord('tok', 'example.com', 'example.com', ['1.2.3.4']);

    expect(result.deleted).toBe(1);
  });

  it('ignores records of a different type at the same name', async () => {
    fetchMock.mockResolvedValueOnce(
      records([
        { id: 1, type: 'AAAA', name: 'e1', data: '::1' },
        { id: 2, type: 'A', name: 'e1', data: '1.2.3.4' },
      ]),
    );
    fetchMock.mockResolvedValueOnce(noContent());

    const { deleteDNSRecord } = await import(MOD);
    const result = await deleteDNSRecord('tok', 'example.com', 'e1.example.com', ['1.2.3.4']);

    expect(result).toEqual({ deleted: 1, skipped: 0, total: 1, skippedTargets: [] });
  });
});

describe('digitalocean-dns deleteApexAndWildcard', () => {
  it('deletes both halves of the pair and reports deletedAny', async () => {
    // Two independent listings (apex + wildcard) run in parallel; mock
    // resolution order follows call order.
    fetchMock
      .mockResolvedValueOnce(records([{ id: 1, type: 'A', name: '@', data: '1.2.3.4' }]))
      .mockResolvedValueOnce(records([{ id: 2, type: 'A', name: '*', data: '1.2.3.4' }]))
      .mockResolvedValue(noContent());

    const { deleteApexAndWildcard } = await import(MOD);
    const result = await deleteApexAndWildcard('tok', 'example.com', 'example.com', ['1.2.3.4']);

    expect(result).toEqual({ deletedAny: true, preservedTargets: [] });
  });

  it('preserves foreign targets from BOTH halves in preservedTargets', async () => {
    fetchMock
      .mockResolvedValueOnce(records([{ id: 1, type: 'A', name: '@', data: '5.5.5.5' }]))
      .mockResolvedValueOnce(records([{ id: 2, type: 'A', name: '*', data: '6.6.6.6' }]));

    const { deleteApexAndWildcard } = await import(MOD);
    const result = await deleteApexAndWildcard('tok', 'example.com', 'example.com', ['1.2.3.4']);

    expect(result).toEqual({ deletedAny: false, preservedTargets: ['5.5.5.5', '6.6.6.6'] });
  });
});

describe('digitalocean-dns upsertApexAndWildcard', () => {
  it('is idempotent — PUTs both existing records rather than creating duplicates', async () => {
    fetchMock.mockResolvedValueOnce(records([{ id: 10, type: 'A', name: '@', data: '9.9.9.9' }]));
    fetchMock.mockResolvedValueOnce(ok({ domain_record: { id: 10 } }));
    fetchMock.mockResolvedValueOnce(records([{ id: 11, type: 'A', name: '*', data: '9.9.9.9' }]));
    fetchMock.mockResolvedValueOnce(ok({ domain_record: { id: 11 } }));

    const { upsertApexAndWildcard } = await import(MOD);
    await upsertApexAndWildcard({ token: 'tok', zoneId: 'example.com' }, 'example.com', '1.2.3.4');

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1][1].method).toBe('PUT');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      type: 'A',
      name: '@',
      data: '1.2.3.4',
      ttl: 60,
    });
    expect(fetchMock.mock.calls[3][1].method).toBe('PUT');
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({
      type: 'A',
      name: '*',
      data: '1.2.3.4',
      ttl: 60,
    });
    for (const call of fetchMock.mock.calls) {
      expect(call[1].headers.Authorization).toBe('Bearer tok');
    }
  });
});

describe('digitalocean-dns setupSimple', () => {
  it('creates the apex + wildcard pair at ttl 60 and returns the simple-mode shape', async () => {
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(created({ domain_record: { id: 1, name: '@' } }));
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(created({ domain_record: { id: 2, name: '*' } }));

    const { setupSimple } = await import(MOD);
    const result = await setupSimple('tok', 'example.com', 'example.com', '1.2.3.4', {
      onProgress: () => {},
    });

    expect(result).toEqual({ success: true, mode: 'simple', record: { id: 1, name: '@' } });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).name).toBe('@');
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).name).toBe('*');
  });

  it('returns {success:false, error} instead of throwing when the API rejects', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'forbidden', message: 'write scope required' }), {
        status: 403,
      }),
    );

    const { setupSimple } = await import(MOD);
    const result = await setupSimple('tok', 'example.com', 'example.com', '1.2.3.4', {
      onProgress: () => {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/write scope required/);
  });

  it('routes progress through onProgress when provided', async () => {
    fetchMock.mockResolvedValue(records([]));
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(created({ domain_record: {} }));
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(created({ domain_record: {} }));

    const beats: string[] = [];
    const { setupSimple } = await import(MOD);
    await setupSimple('tok', 'example.com', 'example.com', '1.2.3.4', {
      onProgress: (m: string) => beats.push(m),
    });

    expect(beats.length).toBeGreaterThan(0);
  });

  // Structural pin for the concurrent-spinner guard enforced across every DNS
  // backend by tests/unit/deploy/preplan-spinner-coverage.test.ts.
  it('uses the shared `onProgress ? null : spinner()` guard literal', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../src/lib/digitalocean-dns.js', import.meta.url)),
      'utf8',
    );
    expect(src).toMatch(/const s = onProgress \? null : spinner\(\)/);
  });
});

describe('digitalocean-dns setupHA', () => {
  it('points apex + wildcard at the PRIMARY (first) server and reports both IPs', async () => {
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(created({ domain_record: {} }));
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(created({ domain_record: {} }));

    const { setupHA } = await import(MOD);
    const result = await setupHA('tok', 'example.com', 'example.com', [
      { name: 'primary', ip: '1.2.3.4', region: 'nyc3' },
      { name: 'standby', ip: '5.6.7.8', region: 'sfo3' },
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
