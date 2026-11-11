/**
 * lookupAuthoritativeA (lib/dns-authoritative.js) through the real node:dns
 * Resolver, against a DNS server on a local UDP port: the queries that go on
 * the wire, and the answers c-ares hands back, are the ones the deploy relies
 * on before it releases a reserved IP.
 *
 *   - the wildcard is asked as the literal name `*.<domain>` (the record a
 *     DNS backend wrote), and its own TTL comes back;
 *   - NXDOMAIN and NOERROR-without-records are empty answers;
 *   - a server that never answers fails the lookup, inside its bound
 *     (AUTHORITATIVE_QUERY_TIMEOUT_MS, two tries).
 *
 * One local server plays both the public resolver and the zone's nameserver
 * (ns1's address is 127.0.0.1); each resolver gets the test's port appended,
 * otherwise each is the module's own (publicResolver, authoritativeResolver).
 */
import dgram from 'node:dgram';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publicResolver } from '../../../src/lib/deploy/public-dns-lookup.js';
import {
  AUTHORITATIVE_QUERY_TIMEOUT_MS,
  authoritativeResolver,
  lookupAuthoritativeA,
  managedRecordNames,
} from '../../../src/lib/dns-authoritative.js';

const A = 1;
const NS = 2;

type Rr =
  | { type: typeof A; address: string; ttl: number }
  | { type: typeof NS; host: string; ttl: number };
/** Lower-cased name -> records; a name absent here is NXDOMAIN. */
let zone: Record<string, Rr[]> = {};
/** Names the server never answers. */
let silent = new Set<string>();
const received: { name: string; type: number }[] = [];

function encodeName(name: string): Buffer {
  const parts = name
    .replace(/\.$/, '')
    .split('.')
    .map((l) => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)]));
  return Buffer.concat([...parts, Buffer.from([0])]);
}

function readQuestion(msg: Buffer) {
  const labels: string[] = [];
  let off = 12;
  while (msg[off] !== 0) {
    const len = msg[off];
    labels.push(msg.subarray(off + 1, off + 1 + len).toString());
    off += 1 + len;
  }
  off += 1;
  return { name: labels.join('.'), type: msg.readUInt16BE(off), end: off + 4 };
}

function answer(msg: Buffer): Buffer | null {
  const q = readQuestion(msg);
  received.push({ name: q.name, type: q.type });
  const key = q.name.toLowerCase();
  if (silent.has(key)) return null;
  const known = zone[key];
  const records = (known ?? []).filter((r) => r.type === q.type);
  const header = Buffer.alloc(12);
  msg.copy(header, 0, 0, 2); // id
  // QR, AA, RD copied; RCODE 3 (NXDOMAIN) for a name the zone lacks.
  header.writeUInt16BE(0x8400 | (msg.readUInt16BE(2) & 0x0100) | (known ? 0 : 3), 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(records.length, 6);
  const rrs = records.map((r) => {
    const rdata = r.type === A ? Buffer.from(r.address.split('.').map(Number)) : encodeName(r.host);
    const fixed = Buffer.alloc(12);
    fixed.writeUInt16BE(0xc00c, 0); // the question's name
    fixed.writeUInt16BE(r.type, 2);
    fixed.writeUInt16BE(1, 4); // IN
    fixed.writeUInt32BE(r.ttl, 6);
    fixed.writeUInt16BE(rdata.length, 10);
    return Buffer.concat([fixed, rdata]);
  });
  return Buffer.concat([header, msg.subarray(12, q.end), ...rrs]);
}

const server = dgram.createSocket('udp4');
let port = 0;
beforeAll(async () => {
  server.on('message', (msg, rinfo) => {
    const out = answer(msg);
    if (out) server.send(out, rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => server.bind(0, '127.0.0.1', () => r()));
  port = server.address().port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const onPort = (make: (s: string[]) => unknown) => (servers: string[]) =>
  make(servers.map((s) => `${s}:${port}`));
const lookup = (domain: string) =>
  lookupAuthoritativeA(managedRecordNames(domain), {
    domain,
    makePublicResolver: onPort(publicResolver) as never,
    makeAuthoritativeResolver: onPort(authoritativeResolver) as never,
    publicServers: ['127.0.0.1'],
  });

describe('authoritative A lookup over the wire (local DNS server)', () => {
  it('finds the zone, asks its nameserver for the apex and the literal wildcard, with TTLs', async () => {
    zone = {
      'app.example.test': [{ type: A, address: '198.51.100.7', ttl: 300 }],
      '*.app.example.test': [{ type: A, address: '198.51.100.7', ttl: 120 }],
      'example.test': [{ type: NS, host: 'ns1.example.test', ttl: 3600 }],
      'ns1.example.test': [{ type: A, address: '127.0.0.1', ttl: 3600 }],
    };
    silent = new Set();
    received.length = 0;
    const res = await lookup('app.example.test');
    if (!res.ok) throw new Error(res.reason);
    expect(res.zone).toBe('example.test');
    expect(res.answers).toEqual([
      {
        name: 'app.example.test',
        server: '127.0.0.1',
        host: 'ns1.example.test',
        addresses: ['198.51.100.7'],
        ttl: 300,
      },
      {
        name: '*.app.example.test',
        server: '127.0.0.1',
        host: 'ns1.example.test',
        addresses: ['198.51.100.7'],
        ttl: 120,
      },
    ]);
    expect(received).toContainEqual({ name: '*.app.example.test', type: A });
    // The walk: NS of the name itself first (NOERROR, no NS), then its parent.
    const nsAsked = received.filter((q) => q.type === NS).map((q) => q.name);
    expect(nsAsked.slice(0, 2)).toEqual(['app.example.test', 'example.test']);
  });

  it('no wildcard record (NXDOMAIN) is an empty answer', async () => {
    zone = {
      'app.example.test': [{ type: A, address: '198.51.100.7', ttl: 300 }],
      'example.test': [{ type: NS, host: 'ns1.example.test', ttl: 3600 }],
      'ns1.example.test': [{ type: A, address: '127.0.0.1', ttl: 3600 }],
    };
    silent = new Set();
    const res = await lookup('app.example.test');
    if (!res.ok) throw new Error(res.reason);
    expect(res.answers.map((a) => [a.name, a.addresses, a.ttl])).toEqual([
      ['app.example.test', ['198.51.100.7'], 300],
      ['*.app.example.test', [], null],
    ]);
  });

  it('a nameserver that never answers fails the lookup within its bound', async () => {
    zone = {
      'app.example.test': [{ type: A, address: '198.51.100.7', ttl: 300 }],
      '*.app.example.test': [{ type: A, address: '198.51.100.7', ttl: 300 }],
      'example.test': [{ type: NS, host: 'ns1.example.test', ttl: 3600 }],
      'ns1.example.test': [{ type: A, address: '127.0.0.1', ttl: 3600 }],
    };
    silent = new Set(['*.app.example.test']);
    const started = Date.now();
    const res = await lookup('app.example.test');
    const took = Date.now() - started;
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toMatch(
      /^no answer for \*\.app\.example\.test at ns1\.example\.test \(127\.0\.0\.1\): ETIMEOUT$/,
    );
    // c-ares backs off between tries: bounded, not open-ended.
    expect(took).toBeLessThan(AUTHORITATIVE_QUERY_TIMEOUT_MS * 4);
  }, 20_000);
});
