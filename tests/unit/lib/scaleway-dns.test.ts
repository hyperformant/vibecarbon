/**
 * Unit coverage for the Scaleway DNS backend (src/lib/scaleway-dns.js).
 *
 * Same mocking conventions as linode-dns.test.ts / vultr-dns.test.ts:
 * `globalThis.fetch` stubbed per-test, restored in afterEach.
 *
 * Three things make Scaleway the odd one out among the DNS backends, and all
 * three are pinned here:
 *   1. Zone identity is the ZONE NAME, split across `domain` + `subdomain` on
 *      the wire and rejoined by getZones — so a sub-zone must come back as
 *      "s1.example.com", not "example.com".
 *   2. There is NO per-record endpoint. Create, update and delete are one
 *      PATCH of /dns-zones/{zone}/records carrying a `changes` array, which
 *      means a multi-record delete is ONE call, not one per record, and a
 *      "delete" never appears on the wire as an HTTP DELETE.
 *   3. Zone and record calls 403 "domain not found" for a domain the account
 *      does not own. That is an onboarding gap, not an auth failure, so the
 *      error carries the pointer that says so — and the external-domain
 *      primitives that close the gap live in this module.
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
/** A single-page `/records` listing. */
function records(rows: unknown[]): Response {
  return ok({ records: rows, total_count: rows.length });
}
/** The PATCH response: the records the change touched. */
function patched(rows: unknown[]): Response {
  return ok({ records: rows });
}

const MOD = '../../../src/lib/scaleway-dns.js';
const ZONE = 'example.com';
const RECORDS_URL = `https://api.scaleway.com/domain/v2beta1/dns-zones/${ZONE}/records`;

/** The body of the nth fetch call, parsed. */
function bodyOf(call: number): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[call][1].body);
}

describe('scaleway-dns getZones', () => {
  it('rejoins {domain, subdomain} into the zone name and uses it as the id', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        dns_zones: [
          { domain: 'example.com', subdomain: '', status: 'active' },
          { domain: 'example.com', subdomain: 's1', status: 'active' },
          { domain: 'carbonstack.dev', subdomain: '', status: 'active' },
        ],
        total_count: 3,
      }),
    );

    const { getZones } = await import(MOD);
    const zones = await getZones('secret');

    expect(zones).toEqual([
      { id: 'example.com', name: 'example.com' },
      // A sub-zone is a first-class zone here — collapsing it to the parent
      // would write records into a zone the child's nameservers never serve.
      { id: 's1.example.com', name: 's1.example.com' },
      { id: 'carbonstack.dev', name: 'carbonstack.dev' },
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://api.scaleway.com/domain/v2beta1/dns-zones?page=1&page_size=100',
    );
  });

  it('authenticates with X-Auth-Token, never a Bearer header', async () => {
    fetchMock.mockResolvedValueOnce(ok({ dns_zones: [], total_count: 0 }));

    const { getZones } = await import(MOD);
    await getZones('secret');

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['X-Auth-Token']).toBe('secret');
    expect(headers.Authorization).toBeUndefined();
  });

  it('walks pages until a SHORT page (no reliance on total_count)', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      domain: `z${i}.example`,
      subdomain: '',
    }));
    fetchMock.mockResolvedValueOnce(ok({ dns_zones: full }));
    fetchMock.mockResolvedValueOnce(ok({ dns_zones: [{ domain: 'last.example', subdomain: '' }] }));

    const { getZones } = await import(MOD);
    const zones = await getZones('secret');

    expect(zones).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('page=2');
  });

  it("surfaces Scaleway's {message} envelope without echoing the secret key", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'denied authentication' }), { status: 401 }),
    );

    const { getZones } = await import(MOD);
    await expect(getZones('super-secret-key')).rejects.toThrow(
      /Scaleway DNS API error: denied authentication/,
    );
    await expect(getZones('super-secret-key')).rejects.not.toThrow(/super-secret-key/);
  });

  it('turns 403 "domain not found" into onboarding guidance, not an auth message', async () => {
    // The single most confusing failure this backend can produce: the
    // credential is fine, the account simply does not own the domain.
    // A fresh Response per call: a body can only be read once, and both
    // assertions below drive a full request.
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: 'domain not found' }), { status: 403 }),
      ),
    );

    const { getZones } = await import(MOD);
    await expect(getZones('secret')).rejects.toThrow(/_scaleway-challenge/);
    await expect(getZones('secret')).rejects.toThrow(/external domain/i);
  });
});

describe('scaleway-dns createDNSRecord', () => {
  it('adds the apex with an EMPTY relative name at ttl 60', async () => {
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(
      patched([{ id: 'r1', name: '', type: 'A', data: '1.2.3.4', ttl: 60 }]),
    );

    const { createDNSRecord } = await import(MOD);
    const rec = await createDNSRecord('secret', ZONE, {
      type: 'A',
      name: 'example.com',
      value: '1.2.3.4',
    });

    expect(rec).toEqual({ id: 'r1', name: '', type: 'A', data: '1.2.3.4', ttl: 60 });

    const patch = fetchMock.mock.calls[1];
    expect(String(patch[0])).toBe(RECORDS_URL);
    expect(patch[1].method).toBe('PATCH');
    expect(bodyOf(1)).toEqual({
      changes: [{ add: { records: [{ name: '', type: 'A', ttl: 60, data: '1.2.3.4' }] } }],
    });
  });

  it('converts a wildcard FQDN to "*" and a subdomain to its label', async () => {
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(patched([]));
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(patched([]));

    const { createDNSRecord } = await import(MOD);
    await createDNSRecord('secret', ZONE, {
      type: 'A',
      name: '*.example.com',
      value: '1.2.3.4',
    });
    await createDNSRecord('secret', ZONE, {
      type: 'A',
      name: 'e1.example.com',
      value: '1.2.3.4',
    });

    expect((bodyOf(1).changes as never[])[0]).toEqual({
      add: { records: [{ name: '*', type: 'A', ttl: 60, data: '1.2.3.4' }] },
    });
    expect((bodyOf(3).changes as never[])[0]).toEqual({
      add: { records: [{ name: 'e1', type: 'A', ttl: 60, data: '1.2.3.4' }] },
    });
  });

  it('SETs the existing record id instead of stacking a second A record', async () => {
    fetchMock.mockResolvedValueOnce(
      records([{ id: 'existing', name: '', type: 'A', data: '9.9.9.9', ttl: 3600 }]),
    );
    fetchMock.mockResolvedValueOnce(
      patched([{ id: 'existing', name: '', type: 'A', data: '1.2.3.4', ttl: 60 }]),
    );

    const { createDNSRecord } = await import(MOD);
    await createDNSRecord('secret', ZONE, { type: 'A', name: 'example.com', value: '1.2.3.4' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(1)).toEqual({
      changes: [
        {
          set: {
            id: 'existing',
            records: [{ name: '', type: 'A', ttl: 60, data: '1.2.3.4' }],
          },
        },
      ],
    });
  });

  it('quotes TXT payloads (and leaves an already-quoted one alone)', async () => {
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(patched([]));
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(patched([]));

    const { createDNSRecord } = await import(MOD);
    await createDNSRecord('secret', ZONE, {
      type: 'TXT',
      name: '_probe.example.com',
      value: 'tok',
    });
    await createDNSRecord('secret', ZONE, {
      type: 'TXT',
      name: '_probe.example.com',
      value: '"tok"',
    });

    expect(
      (bodyOf(1).changes as [{ add: { records: [{ data: string }] } }])[0].add.records[0].data,
    ).toBe('"tok"');
    expect(
      (bodyOf(3).changes as [{ add: { records: [{ data: string }] } }])[0].add.records[0].data,
    ).toBe('"tok"');
  });

  it('falls back to the record it wrote when the PATCH answers no usable body', async () => {
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));

    const { createDNSRecord } = await import(MOD);
    const rec = await createDNSRecord('secret', ZONE, {
      type: 'A',
      name: 'example.com',
      value: '1.2.3.4',
    });

    expect(rec).toEqual({ name: '', type: 'A', ttl: 60, data: '1.2.3.4' });
  });

  it('throws with the create/update prefix when the PATCH is rejected', async () => {
    fetchMock.mockResolvedValueOnce(records([]));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'invalid argument' }), { status: 400 }),
    );

    const { createDNSRecord } = await import(MOD);
    await expect(
      createDNSRecord('secret', ZONE, { type: 'A', name: 'example.com', value: '1.2.3.4' }),
    ).rejects.toThrow(/Failed to create DNS record: invalid argument/);
  });
});

describe('scaleway-dns deleteDNSRecord (ownership-aware)', () => {
  it('deletes only records whose data is in ownedIps, in ONE PATCH', async () => {
    fetchMock.mockResolvedValueOnce(
      records([
        { id: 'a', name: 'e1', type: 'A', data: '1.2.3.4' }, // ours
        { id: 'b', name: 'e1', type: 'A', data: '5.6.7.8' }, // theirs
        { id: 'c', name: 'e1', type: 'A', data: '1.2.3.5' }, // ours
      ]),
    );
    fetchMock.mockResolvedValueOnce(patched([]));

    const { deleteDNSRecord } = await import(MOD);
    const result = await deleteDNSRecord('secret', ZONE, 'e1.example.com', ['1.2.3.4', '1.2.3.5']);

    expect(result).toEqual({ deleted: 2, skipped: 1, total: 3, skippedTargets: ['5.6.7.8'] });
    // Two records removed, ONE round trip — there is no per-record endpoint.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].method).toBe('PATCH');
    expect(bodyOf(1)).toEqual({
      changes: [{ delete: { id: 'a' } }, { delete: { id: 'c' } }],
    });
  });

  it('refuses to delete anything when ownedIps is empty (safer default)', async () => {
    fetchMock.mockResolvedValueOnce(records([{ id: 'a', name: 'e1', type: 'A', data: '1.2.3.4' }]));

    const { deleteDNSRecord } = await import(MOD);
    const result = await deleteDNSRecord('secret', ZONE, 'e1.example.com', []);

    expect(result).toEqual({ deleted: 0, skipped: 1, total: 1, skippedTargets: ['1.2.3.4'] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports deleted:0 when the zone update is rejected', async () => {
    fetchMock.mockResolvedValueOnce(records([{ id: 'a', name: 'e1', type: 'A', data: '1.2.3.4' }]));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'conflict' }), { status: 409 }),
    );

    const { deleteDNSRecord } = await import(MOD);
    const result = await deleteDNSRecord('secret', ZONE, 'e1.example.com', ['1.2.3.4']);

    expect(result).toEqual({ deleted: 0, skipped: 0, total: 1, skippedTargets: [] });
  });

  it('returns total=0 when the record does not exist', async () => {
    fetchMock.mockResolvedValueOnce(
      records([{ id: 'a', name: 'other', type: 'A', data: '1.2.3.4' }]),
    );

    const { deleteDNSRecord } = await import(MOD);
    const result = await deleteDNSRecord('secret', ZONE, 'absent.example.com', ['1.2.3.4']);

    expect(result).toEqual({ deleted: 0, skipped: 0, total: 0, skippedTargets: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('matches the apex by its EMPTY relative name, not the FQDN', async () => {
    fetchMock.mockResolvedValueOnce(records([{ id: 'a', name: '', type: 'A', data: '1.2.3.4' }]));
    fetchMock.mockResolvedValueOnce(patched([]));

    const { deleteDNSRecord } = await import(MOD);
    const result = await deleteDNSRecord('secret', ZONE, 'example.com', ['1.2.3.4']);

    expect(result.deleted).toBe(1);
  });
});

describe('scaleway-dns deleteApexAndWildcard', () => {
  it('deletes both halves SEQUENTIALLY (one zone serial at a time)', async () => {
    fetchMock
      .mockResolvedValueOnce(records([{ id: 'root', name: '', type: 'A', data: '1.2.3.4' }]))
      .mockResolvedValueOnce(patched([]))
      .mockResolvedValueOnce(records([{ id: 'star', name: '*', type: 'A', data: '1.2.3.4' }]))
      .mockResolvedValueOnce(patched([]));

    const { deleteApexAndWildcard } = await import(MOD);
    const result = await deleteApexAndWildcard('secret', ZONE, 'example.com', ['1.2.3.4']);

    expect(result).toEqual({ deletedAny: true, preservedTargets: [] });
    // Read, write, read, write — the second read only starts once the first
    // PATCH has landed, so two updates never race on the zone's serial.
    expect(fetchMock.mock.calls.map((c) => c[1]?.method ?? 'GET')).toEqual([
      'GET',
      'PATCH',
      'GET',
      'PATCH',
    ]);
    expect(bodyOf(1)).toEqual({ changes: [{ delete: { id: 'root' } }] });
    expect(bodyOf(3)).toEqual({ changes: [{ delete: { id: 'star' } }] });
  });

  it('preserves foreign targets from BOTH halves in preservedTargets', async () => {
    fetchMock
      .mockResolvedValueOnce(records([{ id: 'root', name: '', type: 'A', data: '5.5.5.5' }]))
      .mockResolvedValueOnce(records([{ id: 'star', name: '*', type: 'A', data: '6.6.6.6' }]));

    const { deleteApexAndWildcard } = await import(MOD);
    const result = await deleteApexAndWildcard('secret', ZONE, 'example.com', ['1.2.3.4']);

    expect(result).toEqual({ deletedAny: false, preservedTargets: ['5.5.5.5', '6.6.6.6'] });
  });
});

describe('scaleway-dns deleteChallengeRecords', () => {
  it('removes every accumulated token under the exact challenge name, in one PATCH', async () => {
    fetchMock.mockResolvedValueOnce(
      records([
        { id: 't1', name: '_acme-challenge.e1', type: 'TXT', data: '"one"' },
        { id: 't2', name: '_acme-challenge.e1', type: 'TXT', data: '"two"' },
        // A neighbour's challenge record in the same zone — never ours.
        { id: 't3', name: '_acme-challenge.e2', type: 'TXT', data: '"other"' },
      ]),
    );
    fetchMock.mockResolvedValueOnce(patched([]));

    const { deleteChallengeRecords } = await import(MOD);
    const result = await deleteChallengeRecords('secret', ZONE, 'e1.example.com');

    expect(result).toEqual({ deleted: 2, names: ['_acme-challenge.e1.example.com'] });
    expect(bodyOf(1)).toEqual({
      changes: [{ delete: { id: 't1' } }, { delete: { id: 't2' } }],
    });
  });
});

describe('scaleway-dns upsertApexAndWildcard', () => {
  it('repoints both records at the new IP at ttl 60', async () => {
    fetchMock
      .mockResolvedValueOnce(records([{ id: 'root', name: '', type: 'A', data: '9.9.9.9' }]))
      .mockResolvedValueOnce(patched([]))
      .mockResolvedValueOnce(records([{ id: 'star', name: '*', type: 'A', data: '9.9.9.9' }]))
      .mockResolvedValueOnce(patched([]));

    const { upsertApexAndWildcard } = await import(MOD);
    await upsertApexAndWildcard({ token: 'secret', zoneId: ZONE }, 'example.com', '1.2.3.4');

    expect(bodyOf(1)).toEqual({
      changes: [
        { set: { id: 'root', records: [{ name: '', type: 'A', ttl: 60, data: '1.2.3.4' }] } },
      ],
    });
    expect(bodyOf(3)).toEqual({
      changes: [
        { set: { id: 'star', records: [{ name: '*', type: 'A', ttl: 60, data: '1.2.3.4' }] } },
      ],
    });
    for (const call of fetchMock.mock.calls) {
      expect(call[1].headers['X-Auth-Token']).toBe('secret');
    }
  });
});

describe('scaleway-dns external-domain onboarding', () => {
  it('reports a domain the account already manages', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        domains: [
          { domain: 'other.dev', status: 'active', is_external: false },
          {
            domain: 'example.com',
            status: 'checking',
            is_external: true,
            external_domain_registration_status: { validation_token: 'tok-123' },
          },
        ],
        total_count: 2,
      }),
    );

    const { getExternalDomainRegistration } = await import(MOD);
    const result = await getExternalDomainRegistration('secret', 'Example.com.');

    expect(result).toEqual({
      found: true,
      status: 'checking',
      isExternal: true,
      validationToken: 'tok-123',
      createdAt: null,
    });
  });

  it('reports found:false for a domain the account has never seen', async () => {
    fetchMock.mockResolvedValueOnce(ok({ domains: [], total_count: 0 }));

    const { getExternalDomainRegistration } = await import(MOD);
    expect(await getExternalDomainRegistration('secret', 'example.com')).toEqual({
      found: false,
      status: null,
      isExternal: false,
      validationToken: null,
      createdAt: null,
    });
  });

  it('registers an external domain at the SDK path and returns the validation token', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        domain: 'example.com',
        organization_id: 'org-1',
        project_id: 'proj-1',
        validation_token: 'tok-abc',
        created_at: '2026-08-12T00:00:00Z',
      }),
    );

    const { registerExternalDomain } = await import(MOD);
    const result = await registerExternalDomain('secret', 'example.com', 'proj-1');

    expect(result).toEqual({
      domain: 'example.com',
      validationToken: 'tok-abc',
      projectId: 'proj-1',
      createdAt: '2026-08-12T00:00:00Z',
    });
    // The path the Go SDK's RegistrarAPI.RegisterExternalDomain uses. The
    // plausible-looking alternatives (/domains/external, /domains/{d}/…) are
    // 405/404 — pinned so nobody "tidies" it back to one of them.
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://api.scaleway.com/domain/v2beta1/external-domains',
    );
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(bodyOf(0)).toEqual({ domain: 'example.com', project_id: 'proj-1' });
  });

  it('refuses to register without a Project ID, naming the env var that supplies it', async () => {
    const { registerExternalDomain } = await import(MOD);
    await expect(registerExternalDomain('secret', 'example.com', undefined)).rejects.toThrow(
      /SCALEWAY_DEFAULT_PROJECT_ID/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exposes the ownership record name and nameservers as data, not prose', async () => {
    const { EXTERNAL_DOMAIN_CHALLENGE_NAME, NAMESERVERS } = await import(MOD);
    expect(EXTERNAL_DOMAIN_CHALLENGE_NAME).toBe('_scaleway-challenge');
    expect(NAMESERVERS).toEqual(['ns0.dom.scw.cloud', 'ns1.dom.scw.cloud']);
  });

  it('carries created_at through both reads so the 48h window can be shown absolutely', async () => {
    const createdAt = '2026-08-12T10:00:00Z';
    fetchMock.mockResolvedValueOnce(
      ok({
        domains: [{ domain: 'example.com', status: 'checking', created_at: createdAt }],
        total_count: 1,
      }),
    );

    const { getExternalDomainRegistration, validationDeadline } = await import(MOD);
    const registration = await getExternalDomainRegistration('secret', 'example.com');

    expect(registration.createdAt).toBe(createdAt);
    // "48 hours" is useless to someone returning tomorrow; the deadline is a
    // moment, and registration + 48h is where it lands.
    expect(validationDeadline(createdAt)?.toISOString()).toBe('2026-08-14T10:00:00.000Z');
  });

  it('reports an unknown deadline as null rather than inventing one', async () => {
    const { validationDeadline } = await import(MOD);
    expect(validationDeadline(null)).toBeNull();
    expect(validationDeadline(undefined)).toBeNull();
    expect(validationDeadline('not-a-date')).toBeNull();
  });
});

describe('scaleway-dns waitForExternalDomainActive', () => {
  it('resolves active as soon as the status flips', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ domains: [{ domain: 'example.com', status: 'active' }], total_count: 1 }),
    );

    const { waitForExternalDomainActive } = await import(MOD);
    expect(await waitForExternalDomainActive('secret', 'example.com', { timeoutMs: 0 })).toEqual({
      active: true,
      status: 'active',
    });
  });

  it('times out reporting the last status seen — a slow check is not a failure', async () => {
    // Live observation: still `checking` nine minutes in. Timing out is the
    // expected outcome, which is why the caller reports it beside the deadline
    // instead of treating it as an error.
    fetchMock.mockResolvedValueOnce(
      ok({ domains: [{ domain: 'example.com', status: 'checking' }], total_count: 1 }),
    );

    const { waitForExternalDomainActive } = await import(MOD);
    expect(await waitForExternalDomainActive('secret', 'example.com', { timeoutMs: 0 })).toEqual({
      active: false,
      status: 'checking',
    });
  });

  it('swallows a mid-poll API blip instead of aborting the wait', async () => {
    // A non-transient rejection: fetchWithRetry gives up immediately rather
    // than sleeping through its backoff ladder inside a unit test.
    fetchMock.mockRejectedValueOnce(new Error('boom'));

    const { waitForExternalDomainActive } = await import(MOD);
    expect(await waitForExternalDomainActive('secret', 'example.com', { timeoutMs: 0 })).toEqual({
      active: false,
      status: null,
    });
  });
});

describe('scaleway-dns setupSimple', () => {
  it('creates the apex + wildcard pair and returns the simple-mode shape', async () => {
    fetchMock
      .mockResolvedValueOnce(records([]))
      .mockResolvedValueOnce(patched([{ id: 'r1', name: '', type: 'A', data: '1.2.3.4', ttl: 60 }]))
      .mockResolvedValueOnce(records([]))
      .mockResolvedValueOnce(
        patched([{ id: 'r2', name: '*', type: 'A', data: '1.2.3.4', ttl: 60 }]),
      );

    const { setupSimple } = await import(MOD);
    const result = await setupSimple('secret', ZONE, 'example.com', '1.2.3.4', {
      onProgress: () => {},
    });

    expect(result).toEqual({
      success: true,
      mode: 'simple',
      record: { id: 'r1', name: '', type: 'A', data: '1.2.3.4', ttl: 60 },
    });
    expect(
      (bodyOf(1).changes as [{ add: { records: [{ name: string }] } }])[0].add.records[0].name,
    ).toBe('');
    expect(
      (bodyOf(3).changes as [{ add: { records: [{ name: string }] } }])[0].add.records[0].name,
    ).toBe('*');
  });

  it('returns {success:false, error} instead of throwing when the API rejects', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'domain not found' }), { status: 403 }),
    );

    const { setupSimple } = await import(MOD);
    const result = await setupSimple('secret', ZONE, 'example.com', '1.2.3.4', {
      onProgress: () => {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/domain not found/);
  });

  // Structural pin for the concurrent-spinner guard enforced across every DNS
  // backend by tests/unit/deploy/preplan-spinner-coverage.test.ts.
  it('uses the shared `onProgress ? null : spinner()` guard literal', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../src/lib/scaleway-dns.js', import.meta.url)),
      'utf8',
    );
    expect(src).toMatch(/const s = onProgress \? null : spinner\(\)/);
  });
});

describe('scaleway-dns setupHA', () => {
  it('points apex + wildcard at the PRIMARY (first) server and reports both IPs', async () => {
    fetchMock
      .mockResolvedValueOnce(records([]))
      .mockResolvedValueOnce(patched([]))
      .mockResolvedValueOnce(records([]))
      .mockResolvedValueOnce(patched([]));

    const { setupHA } = await import(MOD);
    const result = await setupHA('secret', ZONE, 'example.com', [
      { name: 'primary', ip: '1.2.3.4', region: 'fr-par-1' },
      { name: 'standby', ip: '5.6.7.8', region: 'nl-ams-1' },
    ]);

    expect(result).toEqual({
      success: true,
      mode: 'dns',
      primaryIp: '1.2.3.4',
      standbyIp: '5.6.7.8',
    });
    for (const call of [1, 3]) {
      const change = (
        bodyOf(call).changes as [{ add: { records: [{ data: string; ttl: number }] } }]
      )[0];
      expect(change.add.records[0].data).toBe('1.2.3.4');
      expect(change.add.records[0].ttl).toBe(60);
    }
  });
});
