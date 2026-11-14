/**
 * The unit tier's network guard (tests/_shared/no-real-network.ts, installed
 * by tests/setup/no-real-network.ts): every connect and DNS query a unit test
 * makes stays on this machine, and one that does not fails the test.
 *
 * This file never installs the guard itself: the first block proves the unit
 * project did. Every target it refuses is a reserved name (.invalid) or a
 * documentation address (192.0.2.0/24), so even a broken guard sends nothing
 * anywhere that answers.
 */
import dgram from 'node:dgram';
import dns, { lookup as namedLookup } from 'node:dns';
import { once } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { join } from 'node:path';
import tls from 'node:tls';
import { fetch as undiciFetch } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertNoRefusals,
  isLocalAddress,
  isTestDnsServerList,
  NO_REAL_NETWORK_CODE,
  takeRefusals,
} from '../../_shared/no-real-network.js';
import { createTempDir } from '../../_shared/temp-dir.js';

const REMOTE = 'refused.example.invalid';

/** Resolve once the event loop has run one full turn: no timer, no I/O round trip. */
const oneTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The error a socket (or request) emits, within one turn of the loop, or null. */
async function errorWithinOneTurn(emitter: NodeJS.EventEmitter): Promise<unknown> {
  let seen: unknown = null;
  emitter.once('error', (err) => {
    seen = err;
  });
  await oneTurn();
  return seen;
}

let lookupSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // net resolves a name through this property; a refusal never gets that far.
  lookupSpy = vi.spyOn(dns, 'lookup');
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the unit project installs the guard', () => {
  it('wraps the one connect every TCP client uses, and every DNS entry point', () => {
    vi.restoreAllMocks();
    expect(net.Socket.prototype.connect.name).toBe('connectGuardedByNoRealNetwork');
    const dnsEntryPoints = [
      dns.lookup,
      dns.lookupService,
      dns.resolve4,
      dns.resolveTxt,
      dns.reverse,
      dns.promises.lookup,
      dns.promises.resolve4,
      dns.Resolver.prototype.resolve4,
      dns.Resolver.prototype.resolveAny,
      dns.promises.Resolver.prototype.resolve6,
    ];
    for (const fn of dnsEntryPoints) expect(fn.name).toBe('dnsGuardedByNoRealNetwork');
    // An ESM named import reads the guarded export too.
    expect(namedLookup.name).toBe('dnsGuardedByNoRealNetwork');
  });
});

describe('a connect to another host fails at once, before any lookup, naming host and port', () => {
  function expectRefused(err: unknown, target: string) {
    expect(err).toMatchObject({ code: NO_REAL_NETWORK_CODE });
    expect(String((err as Error).message)).toContain(`connects to ${target}`);
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(takeRefusals()).toEqual([`connects to ${target}`]);
  }

  it('net.connect', async () => {
    const socket = net.connect({ host: REMOTE, port: 443 });
    expectRefused(await errorWithinOneTurn(socket), `${REMOTE}:443`);
  });

  it('socket.connect(port, host), the unnormalized call', async () => {
    const socket = new net.Socket().connect(5432, REMOTE);
    expectRefused(await errorWithinOneTurn(socket), `${REMOTE}:5432`);
  });

  it('an IP literal that is not loopback', async () => {
    const socket = net.connect({ host: '192.0.2.1', port: 22 });
    expectRefused(await errorWithinOneTurn(socket), '192.0.2.1:22');
  });

  it('tls.connect', async () => {
    const socket = tls.connect({ host: REMOTE, port: 443, servername: REMOTE });
    expectRefused(await errorWithinOneTurn(socket), `${REMOTE}:443`);
  });

  it('http.get', async () => {
    const req = http.get(`http://${REMOTE}/`);
    expectRefused(await errorWithinOneTurn(req), `${REMOTE}:80`);
  });

  it('https.get', async () => {
    const req = https.get(`https://${REMOTE}/`);
    expectRefused(await errorWithinOneTurn(req), `${REMOTE}:443`);
  });

  it("Node's fetch", async () => {
    const err = await fetch(`https://${REMOTE}/`).catch((e: Error) => e);
    expectRefused((err as Error).cause, `${REMOTE}:443`);
  });

  it("the undici package's fetch", async () => {
    const err = await undiciFetch(`https://${REMOTE}:8443/`).catch((e: Error) => e);
    expectRefused((err as Error).cause, `${REMOTE}:8443`);
  });

  it('a custom lookup that answers a remote address', async () => {
    const socket = net.connect({
      host: 'app.probe.invalid',
      port: 443,
      lookup: (_host, opts, cb) =>
        opts.all ? cb(null, [{ address: '192.0.2.7', family: 4 }]) : cb(null, '192.0.2.7', 4),
    });
    const err = await errorWithinOneTurn(socket);
    expect(err).toMatchObject({ code: NO_REAL_NETWORK_CODE });
    expect(takeRefusals()).toEqual([
      'connects to app.probe.invalid:443 (its lookup answered 192.0.2.7)',
    ]);
  });

  it('a custom lookup whose answers mix loopback with a remote address', async () => {
    const socket = net.connect({
      host: 'app.probe.invalid',
      port: 443,
      autoSelectFamily: true,
      lookup: (_host, _opts, cb) =>
        cb(null, [
          { address: '127.0.0.1', family: 4 },
          { address: '192.0.2.8', family: 4 },
        ]),
    });
    expect(await errorWithinOneTurn(socket)).toMatchObject({ code: NO_REAL_NETWORK_CODE });
    expect(takeRefusals()).toEqual([
      'connects to app.probe.invalid:443 (its lookup answered 192.0.2.8)',
    ]);
  });

  // The setup file's afterEach is what fails it: this test body passes on
  // its own, and `fails` inverts the verdict, so it is green only while that
  // hook runs.
  it.fails('a test that leaves a refused connect unreported fails after it ends', async () => {
    const socket = net.connect({ host: REMOTE, port: 443 });
    socket.on('error', () => {});
    await oneTurn();
  });

  it('a test whose code caught the error still fails, naming the target and the test', async () => {
    const socket = net.connect({ host: REMOTE, port: 443 });
    socket.on('error', () => {});
    await oneTurn();
    expect(() => assertNoRefusals()).toThrow(
      new RegExp(
        `connects to ${REMOTE}:443 \\(during ".*a test whose code caught the error still fails`,
      ),
    );
    // The check clears what it reported.
    expect(() => assertNoRefusals()).not.toThrow();
  });
});

describe('a connect that stays on this machine goes through', () => {
  let server: http.Server;
  let port: number;
  beforeEach(async () => {
    server = http.createServer((_req, res) => res.end('ok'));
    // No host: both 127.0.0.1 and ::1 reach it.
    server.listen(0);
    await once(server, 'listening');
    port = (server.address() as net.AddressInfo).port;
  });
  afterEach(async () => {
    server.close();
    await once(server, 'close');
  });

  async function get(options: http.RequestOptions): Promise<string> {
    const req = http.get({ port, ...options });
    const [res] = (await once(req, 'response')) as [http.IncomingMessage];
    let body = '';
    for await (const chunk of res) body += chunk;
    return body;
  }

  it('127.0.0.1, localhost and a made-up name a lookup points at loopback', async () => {
    expect(await get({ host: '127.0.0.1' })).toBe('ok');
    expect(await get({ host: 'localhost' })).toBe('ok');
    expect(
      await get({
        host: 'app.probe.invalid',
        lookup: (_host, opts, cb) =>
          opts.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4),
      }),
    ).toBe('ok');
    expect(takeRefusals()).toEqual([]);
  });

  it('fetch to a loopback address', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe('ok');
    expect(takeRefusals()).toEqual([]);
  });

  it('a unix socket', async () => {
    const path = join(createTempDir('no-real-network-sock-'), 's.sock');
    const unix = net.createServer((s) => s.end('ok'));
    unix.listen(path);
    await once(unix, 'listening');
    try {
      const socket = new net.Socket().connect(path);
      let body = '';
      for await (const chunk of socket) body += chunk;
      expect(body).toBe('ok');
      expect(takeRefusals()).toEqual([]);
    } finally {
      unix.close();
    }
  });
});

describe('which addresses never leave the machine', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.255.255.254', true],
    ['::1', true],
    ['0:0:0:0:0:0:0:1', true],
    ['::ffff:127.0.0.1', true],
    ['0.0.0.0', true],
    ['::', true],
    ['10.0.0.1', false],
    ['192.0.2.1', false],
    ['::ffff:192.0.2.1', false],
    ['2001:db8::1', false],
    ['localhost', false],
    ['', false],
  ])('%s: %s', (address, local) => {
    expect(isLocalAddress(address)).toBe(local);
  });
});

describe('DNS: a lookup of a name and any query to a real resolver fail, naming what was asked', () => {
  const callbackError = (call: (cb: (err: unknown) => void) => void) =>
    new Promise((resolve) => call((err) => resolve(err)));

  it('dns.lookup and dns.promises.lookup of a name', async () => {
    lookupSpy.mockRestore();
    expect(await callbackError((cb) => dns.lookup(REMOTE, cb))).toMatchObject({
      code: NO_REAL_NETWORK_CODE,
    });
    await expect(dns.promises.lookup(REMOTE, { all: true })).rejects.toMatchObject({
      code: NO_REAL_NETWORK_CODE,
    });
    expect(takeRefusals()).toEqual([`looks up ${REMOTE}`, `looks up ${REMOTE}`]);
  });

  it('dns.lookupService of a remote address', async () => {
    expect(await callbackError((cb) => dns.lookupService('192.0.2.1', 22, cb))).toMatchObject({
      code: NO_REAL_NETWORK_CODE,
    });
    expect(takeRefusals()).toEqual(['looks up the name of 192.0.2.1:22']);
  });

  it('a Resolver pointed at a public server, callback and promise forms', async () => {
    const resolver = new dns.Resolver({ timeout: 200, tries: 1 });
    resolver.setServers(['192.0.2.53']);
    const err = await callbackError((cb) => resolver.resolve4(REMOTE, cb));
    expect(err).toMatchObject({ code: NO_REAL_NETWORK_CODE });
    expect(String((err as Error).message)).toContain(
      `asks a DNS server (192.0.2.53) to resolve4 ${REMOTE}`,
    );
    const promised = new dns.promises.Resolver({ timeout: 200, tries: 1 });
    promised.setServers(['192.0.2.53']);
    await expect(promised.resolveTxt(REMOTE)).rejects.toMatchObject({
      code: NO_REAL_NETWORK_CODE,
    });
    expect(takeRefusals()).toEqual([
      `asks a DNS server (192.0.2.53) to resolve4 ${REMOTE}`,
      `asks a DNS server (192.0.2.53) to resolveTxt ${REMOTE}`,
    ]);
  });

  it("the machine's own resolver, on loopback port 53, is still the network", async () => {
    const resolver = new dns.Resolver({ timeout: 200, tries: 1 });
    resolver.setServers(['127.0.0.53']);
    expect(await callbackError((cb) => resolver.resolve4(REMOTE, cb))).toMatchObject({
      code: NO_REAL_NETWORK_CODE,
    });
    expect(takeRefusals()).toEqual([`asks a DNS server (127.0.0.53) to resolve4 ${REMOTE}`]);
  });

  it("the module's resolve family and reverse ask the system resolver", async () => {
    expect(await callbackError((cb) => dns.resolve4(REMOTE, cb))).toMatchObject({
      code: NO_REAL_NETWORK_CODE,
    });
    expect(await callbackError((cb) => dns.reverse('192.0.2.1', cb))).toMatchObject({
      code: NO_REAL_NETWORK_CODE,
    });
    await expect(dns.promises.resolveSrv(`_x._tcp.${REMOTE}`)).rejects.toMatchObject({
      code: NO_REAL_NETWORK_CODE,
    });
    expect(takeRefusals().map((r) => r.replace(/\(.*\)/, '(...)'))).toEqual([
      `asks a DNS server (...) to resolve4 ${REMOTE}`,
      'asks a DNS server (...) to reverse 192.0.2.1',
      `asks a DNS server (...) to resolveSrv _x._tcp.${REMOTE}`,
    ]);
  });

  it('localhost and an IP literal answer without asking a resolver', async () => {
    lookupSpy.mockRestore();
    const local = await dns.promises.lookup('localhost');
    expect(isLocalAddress(local.address)).toBe(true);
    expect((await dns.promises.lookup('192.0.2.1')).address).toBe('192.0.2.1');
    expect(takeRefusals()).toEqual([]);
  });

  it("a query to a test's own server on a loopback port goes through", async () => {
    const server = dgram.createSocket('udp4');
    server.bind(0, '127.0.0.1');
    await once(server, 'listening');
    const resolver = new dns.Resolver({ timeout: 1_000, tries: 1 });
    try {
      resolver.setServers([`127.0.0.1:${server.address().port}`]);
      const received = once(server, 'message');
      const answered = callbackError((cb) => resolver.resolve4('own.example.invalid', cb));
      await received;
      resolver.cancel();
      expect(await answered).toMatchObject({ code: dns.CANCELLED });
      expect(takeRefusals()).toEqual([]);
    } finally {
      server.close();
    }
  });

  it.each([
    [['127.0.0.1:5353'], true],
    [['[::1]:5300', '127.0.0.2:1053'], true],
    [['127.0.0.1'], false],
    [['127.0.0.53:53'], false],
    [['[::1]:53'], false],
    [['127.0.0.1:5353', '192.0.2.53:5353'], false],
    [['1.1.1.1'], false],
    [[], false],
  ])("%j is a test's own DNS server list: %s", (servers, own) => {
    expect(isTestDnsServerList(servers)).toBe(own);
  });
});
