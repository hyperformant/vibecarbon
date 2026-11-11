/**
 * lookupAuthoritativeA (lib/dns-authoritative.js): what a domain's own
 * nameservers answer, asked one server address at a time. The deploy releases
 * a DigitalOcean reserved IP only when this says no answer names it, so any
 * part it could not ask must fail the whole lookup, never shrink it.
 *
 * Fake resolvers stand in for node:dns: each is pinned to the servers it was
 * made with and answers from a table, so the tests see which server was asked
 * for which name. tests/integration/dns/authoritative-lookup.test.ts runs the
 * real node:dns Resolver against a local DNS server.
 */
import dns from 'node:dns';
import { describe, expect, it } from 'vitest';
import { lookupAuthoritativeA, managedRecordNames } from '../../../src/lib/dns-authoritative.js';

type Answer = string[] | { address: string; ttl: number }[] | { code: string };
/** server -> "METHOD name" -> answer. */
type Table = Record<string, Record<string, Answer>>;

function fakes(table: Table) {
  const asked: { server: string; method: string; name: string; options?: unknown }[] = [];
  const made: string[][] = [];
  const make = (servers: string[]) => {
    made.push(servers);
    expect(servers, 'one server per resolver').toHaveLength(1);
    const [server] = servers;
    const answer =
      (method: string) =>
      (name: string, ...rest: unknown[]) => {
        const cb = rest.pop() as (err: unknown, value?: unknown) => void;
        asked.push({ server, method, name, options: rest[0] });
        const a = table[server]?.[`${method} ${name}`] ?? { code: dns.NOTFOUND };
        if (!Array.isArray(a)) {
          const err = Object.assign(new Error(a.code), { code: a.code });
          setImmediate(() => cb(err));
        } else setImmediate(() => cb(null, a));
      };
    return { resolveNs: answer('NS'), resolve4: answer('A'), resolveCname: answer('CNAME') };
  };
  return { asked, made, make };
}

const PUBLIC = ['1.1.1.1', '8.8.8.8'];
const ZONE: Table = {
  '1.1.1.1': {
    'NS app.example.com': { code: dns.NODATA },
    'NS example.com': ['ns1.dns.test.', 'NS2.dns.test'],
    'A ns1.dns.test': ['192.0.2.1'],
    'A ns2.dns.test': ['192.0.2.2', '192.0.2.3'],
  },
  '8.8.8.8': { 'NS app.example.com': { code: dns.NODATA } },
};
const served = (address: string, ttl: number) => ({
  'A app.example.com': [{ address, ttl }],
  'A *.app.example.com': [{ address, ttl }],
});

describe('managedRecordNames', () => {
  it('the apex and the wildcard, as setupSimple and setupHA write them', () => {
    expect(managedRecordNames('app.example.com')).toEqual(['app.example.com', '*.app.example.com']);
  });
});

describe('lookupAuthoritativeA', () => {
  const names = managedRecordNames('app.example.com');

  it('finds the zone by walking up, then asks every nameserver address for every name', async () => {
    const pub = fakes(ZONE);
    const auth = fakes({
      '192.0.2.1': served('198.51.100.7', 300),
      '192.0.2.2': served('198.51.100.7', 300),
      '192.0.2.3': served('198.51.100.7', 300),
    });
    const res = await lookupAuthoritativeA(names, {
      domain: 'app.example.com',
      makePublicResolver: pub.make,
      makeAuthoritativeResolver: auth.make,
      publicServers: PUBLIC,
    });
    expect(res).toMatchObject({ ok: true, zone: 'example.com' });
    if (!res.ok) throw new Error(res.reason);
    // Three addresses x two names, every one asked on its own resolver.
    expect(res.answers).toHaveLength(6);
    const pairs = auth.asked.map((q) => `${q.server} ${q.name}`).sort();
    expect(pairs).toEqual(
      [
        '192.0.2.1 app.example.com',
        '192.0.2.1 *.app.example.com',
        '192.0.2.2 app.example.com',
        '192.0.2.2 *.app.example.com',
        '192.0.2.3 app.example.com',
        '192.0.2.3 *.app.example.com',
      ].sort(),
    );
    // With the TTL, and the wildcard asked as the literal name.
    expect(auth.asked.every((q) => (q.options as { ttl?: boolean })?.ttl === true)).toBe(true);
    expect(
      res.answers.find((a) => a.name === '*.app.example.com' && a.server === '192.0.2.3'),
    ).toEqual({
      name: '*.app.example.com',
      server: '192.0.2.3',
      host: 'ns2.dns.test',
      addresses: ['198.51.100.7'],
      ttl: 300,
    });
  });

  it('several A records: every address, and the longest TTL', async () => {
    const pub = fakes(ZONE);
    const both = [
      { address: '203.0.113.9', ttl: 1800 },
      { address: '198.51.100.7', ttl: 60 },
    ];
    const table = Object.fromEntries(
      ['192.0.2.1', '192.0.2.2', '192.0.2.3'].map((ip) => [
        ip,
        { 'A app.example.com': both, 'A *.app.example.com': both },
      ]),
    );
    const res = await lookupAuthoritativeA(names, {
      domain: 'app.example.com',
      makePublicResolver: pub.make,
      makeAuthoritativeResolver: fakes(table).make,
      publicServers: PUBLIC,
    });
    if (!res.ok) throw new Error(res.reason);
    expect(res.answers[0]).toMatchObject({ addresses: ['203.0.113.9', '198.51.100.7'], ttl: 1800 });
  });

  it('no such name, or no A record, is an empty answer, not a failure', async () => {
    const auth = fakes({
      '192.0.2.1': { 'A app.example.com': { code: dns.NODATA } },
      '192.0.2.2': { 'A app.example.com': { code: dns.NOTFOUND } },
      '192.0.2.3': {},
    });
    const res = await lookupAuthoritativeA(names, {
      domain: 'app.example.com',
      makePublicResolver: fakes(ZONE).make,
      makeAuthoritativeResolver: auth.make,
      publicServers: PUBLIC,
    });
    if (!res.ok) throw new Error(res.reason);
    expect(res.answers).toHaveLength(6);
    for (const a of res.answers) expect(a).toMatchObject({ addresses: [], ttl: null });
  });

  // A nameserver answers an A query for a CNAME whose target is in another
  // zone with the CNAME alone: c-ares reads that as "no A record". The target
  // could be the very address about to be released.
  it('"no A record" that is a CNAME fails the lookup: it is not followed', async () => {
    const auth = fakes({
      '192.0.2.1': served('198.51.100.7', 300),
      '192.0.2.2': served('198.51.100.7', 300),
      '192.0.2.3': {
        'A app.example.com': [{ address: '198.51.100.7', ttl: 300 }],
        'A *.app.example.com': { code: dns.NODATA },
        'CNAME *.app.example.com': ['edge.cdn.test'],
      },
    });
    const res = await lookupAuthoritativeA(names, {
      domain: 'app.example.com',
      makePublicResolver: fakes(ZONE).make,
      makeAuthoritativeResolver: auth.make,
      publicServers: PUBLIC,
    });
    expect(res).toEqual({
      ok: false,
      reason:
        '*.app.example.com at ns2.dns.test (192.0.2.3) is a CNAME to edge.cdn.test, ' +
        'which this check does not follow',
    });
    // Asked of the same server that answered "no A record".
    expect(auth.asked).toContainEqual(
      expect.objectContaining({ server: '192.0.2.3', method: 'CNAME', name: '*.app.example.com' }),
    );
  });

  // Node 24's c-ares spells that answer as an empty list, not ENODATA.
  it('an empty A answer that is a CNAME fails the lookup the same way', async () => {
    const auth = fakes({
      '192.0.2.1': {
        'A app.example.com': [],
        'CNAME app.example.com': ['app.example.com.cdn.test'],
      },
    });
    const res = await lookupAuthoritativeA(['app.example.com'], {
      domain: 'app.example.com',
      makePublicResolver: fakes({
        '1.1.1.1': { 'NS app.example.com': ['ns1.dns.test'], 'A ns1.dns.test': ['192.0.2.1'] },
      }).make,
      makeAuthoritativeResolver: auth.make,
      publicServers: PUBLIC,
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toContain('is a CNAME to app.example.com.cdn.test');
  });

  it('a CNAME query that fails after "no A record" fails the lookup too', async () => {
    const auth = fakes({
      '192.0.2.1': served('198.51.100.7', 300),
      '192.0.2.2': served('198.51.100.7', 300),
      '192.0.2.3': {
        ...served('198.51.100.7', 300),
        'A app.example.com': { code: dns.NODATA },
        'CNAME app.example.com': { code: dns.TIMEOUT },
      },
    });
    const res = await lookupAuthoritativeA(names, {
      domain: 'app.example.com',
      makePublicResolver: fakes(ZONE).make,
      makeAuthoritativeResolver: auth.make,
      publicServers: PUBLIC,
    });
    expect(res).toEqual({
      ok: false,
      reason: `no answer for app.example.com's CNAME at ns2.dns.test (192.0.2.3): ${dns.TIMEOUT}`,
    });
  });

  it('"no A record" and no CNAME either is an empty answer', async () => {
    const auth = fakes({
      '192.0.2.1': {
        'A app.example.com': { code: dns.NODATA },
        'CNAME app.example.com': { code: dns.NODATA },
      },
    });
    const res = await lookupAuthoritativeA(['app.example.com'], {
      domain: 'app.example.com',
      makePublicResolver: fakes({
        '1.1.1.1': { 'NS app.example.com': ['ns1.dns.test'], 'A ns1.dns.test': ['192.0.2.1'] },
      }).make,
      makeAuthoritativeResolver: auth.make,
      publicServers: PUBLIC,
    });
    if (!res.ok) throw new Error(res.reason);
    expect(res.answers).toEqual([
      {
        name: 'app.example.com',
        server: '192.0.2.1',
        host: 'ns1.dns.test',
        addresses: [],
        ttl: null,
      },
    ]);
  });

  it('one nameserver address that does not answer fails the whole lookup', async () => {
    const auth = fakes({
      '192.0.2.1': served('198.51.100.7', 300),
      '192.0.2.2': served('198.51.100.7', 300),
      '192.0.2.3': { 'A *.app.example.com': { code: dns.TIMEOUT } },
    });
    const res = await lookupAuthoritativeA(names, {
      domain: 'app.example.com',
      makePublicResolver: fakes(ZONE).make,
      makeAuthoritativeResolver: auth.make,
      publicServers: PUBLIC,
    });
    expect(res).toEqual({
      ok: false,
      reason: `no answer for *.app.example.com at ns2.dns.test (192.0.2.3): ${dns.TIMEOUT}`,
    });
  });

  it('a nameserver with no IPv4 address fails it', async () => {
    const pub = fakes({
      ...ZONE,
      '1.1.1.1': { ...ZONE['1.1.1.1'], 'A ns2.dns.test': { code: dns.NODATA } },
    });
    const res = await lookupAuthoritativeA(names, {
      domain: 'app.example.com',
      makePublicResolver: pub.make,
      makeAuthoritativeResolver: fakes({}).make,
      publicServers: PUBLIC,
    });
    expect(res).toEqual({ ok: false, reason: 'no IPv4 address for nameserver ns2.dns.test' });
  });

  it('a resolver that fails the address lookup of a nameserver fails it, never reads as "no address"', async () => {
    // SECURITY: a timeout is not an answer. The resolver that timed out could
    // have named a server still answering with the address about to go.
    const pub = fakes({
      ...ZONE,
      '1.1.1.1': { ...ZONE['1.1.1.1'], 'A ns2.dns.test': { code: dns.TIMEOUT } },
      '8.8.8.8': { ...ZONE['8.8.8.8'], 'A ns2.dns.test': { code: dns.NODATA } },
    });
    const res = await lookupAuthoritativeA(names, {
      domain: 'app.example.com',
      makePublicResolver: pub.make,
      makeAuthoritativeResolver: fakes({}).make,
      publicServers: PUBLIC,
    });
    expect(res).toEqual({
      ok: false,
      reason: `the address lookup of nameserver ns2.dns.test failed (1.1.1.1 ${dns.TIMEOUT})`,
    });
  });

  it('a failed resolver does not matter when another names the nameserver', async () => {
    const pub = fakes({
      ...ZONE,
      '1.1.1.1': { ...ZONE['1.1.1.1'], 'A ns2.dns.test': { code: dns.SERVFAIL } },
      '8.8.8.8': { ...ZONE['8.8.8.8'], 'A ns2.dns.test': ['192.0.2.2'] },
    });
    const res = await lookupAuthoritativeA(names, {
      domain: 'app.example.com',
      makePublicResolver: pub.make,
      makeAuthoritativeResolver: fakes({
        '192.0.2.1': served('198.51.100.7', 300),
        '192.0.2.2': served('198.51.100.7', 300),
      }).make,
      publicServers: PUBLIC,
    });
    if (!res.ok) throw new Error(res.reason);
    expect(new Set(res.answers.map((a) => a.server))).toEqual(new Set(['192.0.2.1', '192.0.2.2']));
  });

  it('a query that throws before it is sent fails the lookup instead of rejecting', async () => {
    const throwing = () => ({
      resolve4: () => {
        throw Object.assign(new Error('bad name'), { code: 'EBADNAME' });
      },
    });
    const res = await lookupAuthoritativeA(names, {
      domain: 'app.example.com',
      makePublicResolver: fakes(ZONE).make,
      makeAuthoritativeResolver: throwing as never,
      publicServers: PUBLIC,
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toContain('EBADNAME');
  });

  it('a public resolver that fails the NS lookup stops the walk there', async () => {
    // It could have named the zone at this label: asking the parent's
    // servers instead would read A records from a zone that does not hold them.
    const pub = fakes({
      '1.1.1.1': { 'NS app.example.com': { code: dns.TIMEOUT } },
      '8.8.8.8': { 'NS app.example.com': { code: dns.NODATA } },
    });
    const res = await lookupAuthoritativeA(names, {
      domain: 'app.example.com',
      makePublicResolver: pub.make,
      makeAuthoritativeResolver: fakes({}).make,
      publicServers: PUBLIC,
    });
    expect(res).toEqual({
      ok: false,
      reason: `the NS lookup of app.example.com failed (1.1.1.1 ${dns.TIMEOUT})`,
    });
    expect(pub.asked.map((q) => q.name)).not.toContain('example.com');
  });

  it('the second public resolver is asked when the first has no NS', async () => {
    const pub = fakes({
      '1.1.1.1': { 'NS example.com': { code: dns.NODATA } },
      '8.8.8.8': { 'NS example.com': ['ns1.dns.test'], 'A ns1.dns.test': ['192.0.2.1'] },
    });
    const res = await lookupAuthoritativeA(['example.com'], {
      domain: 'example.com',
      makePublicResolver: pub.make,
      makeAuthoritativeResolver: fakes({ '192.0.2.1': { 'A example.com': [] } }).make,
      publicServers: PUBLIC,
    });
    expect(res).toMatchObject({ ok: true, zone: 'example.com' });
  });

  it('no nameservers anywhere up to the registrable name fails it', async () => {
    const pub = fakes({});
    const res = await lookupAuthoritativeA(names, {
      domain: 'app.example.com',
      makePublicResolver: pub.make,
      makeAuthoritativeResolver: fakes({}).make,
      publicServers: PUBLIC,
    });
    expect(res).toEqual({ ok: false, reason: 'no nameservers found for app.example.com' });
    // Never asks a top-level domain's servers.
    expect(pub.asked.map((q) => q.name)).not.toContain('com');
  });
});
