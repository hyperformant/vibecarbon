/**
 * The unit tier never reaches the real network. Five unit files sent real
 * requests to provider endpoints with fake credentials (an S3 DELETE to
 * fsn1.your-objectstorage.com, calls to api.hetzner.cloud and api.linode.com,
 * 2026-11-14), and a sixth asked 1.1.1.1 and 8.8.8.8 for a made-up name. Every
 * one passed, because the code under test caught the error. Each request cost
 * a DNS lookup and a TLS handshake, one took 0.9 s and hit the 5 s test timeout
 * under parallel load, and the results depended on the machine's network.
 *
 * So every outbound connect and every DNS query in a unit test file goes
 * through a check. Every TCP client in Node connects through
 * net.Socket.prototype.connect: net, http, https, tls, and fetch (undici's
 * connector calls net.connect and tls.connect), so wrapping that one method
 * covers them all. DNS is the `node:dns` module: lookup (the system resolver),
 * the resolve family and reverse (c-ares, which sends its own UDP), and
 * lookupService. tests/unit/lib/no-real-network.test.ts proves each one.
 *
 * - A unix socket, `localhost`, or a loopback or unspecified IP literal
 *   (127.0.0.0/8, ::1, 0.0.0.0, ::) connects as usual: none can leave the
 *   machine.
 * - A connect with its own `lookup` (a test pointing a made-up name at a local
 *   server) connects only if that lookup answers with one of those addresses.
 * - A lookup of `localhost` or of an IP literal answers as usual (neither asks
 *   a resolver). A resolver query goes through only when every server it
 *   would ask is a loopback address on a port other than 53: a test's own DNS
 *   server. Port 53 on loopback is the machine's resolver (systemd-resolved,
 *   dnsmasq), which forwards to the network.
 * - Anything else fails at once, before any DNS lookup, with an error that
 *   names what was asked for (host and port, or the name and the servers).
 *   It fails asynchronously, the way a refused connection or a failed lookup
 *   does, so the code under test handles it as it would a real failure.
 * - A test that attempted one fails, naming it, even when the code under test
 *   caught the error (as every one of the six did). Stub the client or module
 *   that made the call: an S3 client (mock getObjectStorageProvider, as
 *   fake-state-store.ts does, or pass a seam such as removeStackBackup's
 *   `s3`), fetch, a provider method, or a resolver (resolvePublicA takes
 *   `resolver`, `makeResolver` and `fallback`).
 *
 * Not covered: `node:dgram`, which nothing under src/ uses (an integration
 * test runs a fake DNS server with it), and child processes (no-real-ssh.ts
 * covers ssh, scp and ssh-keyscan).
 *
 * tests/setup/no-real-network.ts installs these checks in every unit test
 * file and fails a test that tripped one; only the unit project lists it
 * (vitest.config.ts), since the integration tier may run servers and real
 * Pulumi, and e2e is the real network.
 */
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { expect } from 'vitest';

/** The code a refused call fails with, so a test can tell it from a real failure. */
export const NO_REAL_NETWORK_CODE = 'ERR_UNIT_NO_REAL_NETWORK';

const LOCAL = new net.BlockList();
LOCAL.addSubnet('127.0.0.0', 8, 'ipv4');
LOCAL.addAddress('0.0.0.0', 'ipv4');
LOCAL.addAddress('::1', 'ipv6');
LOCAL.addAddress('::', 'ipv6');

/**
 * True for an address a connect cannot leave the machine through: loopback
 * (127.0.0.0/8, ::1, and their IPv4-mapped forms) or unspecified (0.0.0.0,
 * ::, which Linux connects to the local host). False for any other address
 * and for anything that is not an IP literal.
 */
export function isLocalAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return false;
  return LOCAL.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** `localhost` resolves through /etc/hosts, never through a resolver. */
function isLocalhostName(host: string): boolean {
  return /^localhost\.?$/i.test(host);
}

/**
 * True when every DNS server in `servers` (as getServers() spells them:
 * `1.2.3.4`, `1.2.3.4:5353`, `::1`, `[::1]:5353`) is a loopback address on an
 * explicit port other than 53, which only a test's own server listens on.
 */
export function isTestDnsServerList(servers: string[]): boolean {
  return (
    servers.length > 0 &&
    servers.every((server) => {
      const m = /^\[(.+)\]:(\d+)$/.exec(server) ?? /^([^:]+):(\d+)$/.exec(server);
      return m !== null && Number(m[2]) !== 53 && isLocalAddress(m[1]);
    })
  );
}

interface Refusal {
  what: string;
  test: string | undefined;
}

interface GuardState {
  refused: Refusal[];
}

// On globalThis, so the record is one per worker however many copies of this
// module are loaded (the setup file's and a test file's).
const STATE_KEY = Symbol.for('vibecarbon.tests.no-real-network');
const WRAPPED = Symbol.for('vibecarbon.tests.no-real-network.wrapped');
const holder = globalThis as typeof globalThis & { [STATE_KEY]?: GuardState };
const state: GuardState = holder[STATE_KEY] ?? { refused: [] };
holder[STATE_KEY] = state;

function currentTest(): string | undefined {
  try {
    return expect.getState().currentTestName;
  } catch {
    return undefined;
  }
}

/** Record `what` (a phrase after "a unit test never") and the error the caller gets. */
function refusal(what: string): Error {
  state.refused.push({ what, test: currentTest() });
  const err = new Error(
    `a unit test never ${what} (tests/_shared/no-real-network.ts): ` +
      'stub the client or module that made this call',
  ) as NodeJS.ErrnoException;
  err.code = NO_REAL_NETWORK_CODE;
  return err;
}

/** What was refused since the last call, and forget it. */
export function takeRefusals(): string[] {
  return state.refused.splice(0).map((r) => r.what);
}

/**
 * Throw, naming every refused call and the test it happened in, when any
 * happened since the last check; clears the record either way.
 */
export function assertNoRefusals(): void {
  const refused = state.refused.splice(0);
  if (refused.length === 0) return;
  const lines = refused.map((r) => `  ${r.what}${r.test ? ` (during "${r.test}")` : ''}`);
  throw new Error(
    'This test tried to reach the network, which the unit tier never does ' +
      '(tests/_shared/no-real-network.ts). Stub the client or module that made the call ' +
      `(an S3 client, fetch, a provider module, a DNS resolver). A unit test never:\n${lines.join('\n')}`,
  );
}

// ── Connects ──

type LookupCallback = (err: Error | null, address?: unknown, family?: number) => void;
type LookupFn = (hostname: string, ...rest: unknown[]) => unknown;

/** The addresses a lookup answered with, in either of its callback shapes. */
function answeredAddresses(address: unknown): string[] {
  if (Array.isArray(address)) {
    return address.map((a) => String((a as { address: string }).address));
  }
  return [String(address)];
}

/**
 * `lookup`, except that an answer naming any address that is not local fails
 * the connect instead (the socket gets the error, as with a failed lookup).
 */
function guardedLookup(lookup: LookupFn, host: string, port: unknown): LookupFn {
  return function lookupGuardedByNoRealNetwork(this: unknown, hostname: string, ...rest) {
    const cbIndex = rest.findIndex((a) => typeof a === 'function');
    const callback = rest[cbIndex] as LookupCallback;
    rest[cbIndex] = (err: Error | null, address?: unknown, family?: number) => {
      if (err) return callback(err, address, family);
      const remote = answeredAddresses(address).find((a) => !isLocalAddress(a));
      if (remote !== undefined) {
        return callback(refusal(`connects to ${host}:${port} (its lookup answered ${remote})`));
      }
      return callback(null, address, family);
    };
    return lookup.call(this, hostname, ...rest);
  };
}

interface ConnectOptions {
  host?: string;
  port?: unknown;
  path?: string;
  lookup?: LookupFn;
}

/** The options a connect was called with, in any of net's call shapes. */
function connectOptions(args: unknown[]): ConnectOptions {
  // net.connect passes its already-normalized [options, cb] pair as one array.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first !== null && typeof first === 'object') return first as ConnectOptions;
  // (path[, cb]): a string that is not a port number names a pipe.
  if (typeof first === 'string' && !(Number(first) >= 0)) return { path: first };
  // (port[, host][, cb])
  return { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
}

type Connect = (this: net.Socket, ...args: unknown[]) => net.Socket;

// ── DNS ──

type AnyFn = ((this: unknown, ...args: unknown[]) => unknown) & { [WRAPPED]?: true };
type Patchable = Record<string, unknown>;

/** Fail a refused DNS call the way its API fails: a rejection, or the callback. */
function fail(args: unknown[], err: Error, promises: boolean): unknown {
  if (promises) return Promise.reject(err);
  const callback = args.findLast((a) => typeof a === 'function') as
    | ((e: Error) => void)
    | undefined;
  if (!callback) throw err;
  process.nextTick(() => callback(err));
  return undefined;
}

/**
 * Replace each `methods` entry on `target` with a check: `refuse` returns the
 * phrase to refuse with, or null to let the real call through.
 */
function guardMethods(
  target: Patchable,
  methods: readonly string[],
  promises: boolean,
  refuse: (self: unknown, method: string, args: unknown[]) => string | null,
): void {
  for (const method of methods) {
    const real = target[method] as AnyFn | undefined;
    if (typeof real !== 'function' || real[WRAPPED]) continue;
    const guarded: AnyFn = function dnsGuardedByNoRealNetwork(this: unknown, ...args: unknown[]) {
      const what = refuse(this, method, args);
      if (what === null) return real.apply(this, args);
      return fail(args, refusal(what), promises);
    };
    guarded[WRAPPED] = true;
    target[method] = guarded;
  }
}

/** The system resolver answers `localhost` and IP literals without a query. */
function refuseLookup(_self: unknown, method: string, args: unknown[]): string | null {
  const [first, port] = args;
  if (method === 'lookupService') {
    return isLocalAddress(String(first)) ? null : `looks up the name of ${first}:${port}`;
  }
  // Anything that is not a name (empty, not a string) gets Node's own answer.
  if (typeof first !== 'string' || first === '') return null;
  if (isLocalhostName(first) || net.isIP(first) !== 0) return null;
  return `looks up ${first}`;
}

const RESOLVER_METHODS = [
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCaa',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTlsa',
  'resolveTxt',
  'reverse',
] as const;

/** A resolver query asks the servers `serversOf` names; only a test's own may answer. */
function refuseQuery(serversOf: (self: unknown) => string[]) {
  return (self: unknown, method: string, args: unknown[]): string | null => {
    const servers = serversOf(self);
    if (isTestDnsServerList(servers)) return null;
    return `asks a DNS server (${servers.join(', ') || 'none set'}) to ${method} ${args[0]}`;
  };
}

/**
 * Wrap net.Socket.prototype.connect and the `node:dns` methods with the checks
 * above. Idempotent: a second call wraps nothing again.
 */
export function installNoRealNetwork(): void {
  const proto = net.Socket.prototype as net.Socket & { [WRAPPED]?: true };
  if (!proto[WRAPPED]) {
    const realConnect = proto.connect as unknown as Connect;
    const guardedConnect: Connect = function connectGuardedByNoRealNetwork(...args) {
      const options = connectOptions(args);
      if (options.path) return realConnect.apply(this, args);
      // net connects to localhost when no host is given.
      const host = options.host || 'localhost';
      const port = options.port;
      if (net.isIP(host) !== 0) {
        // net skips any lookup for an IP literal.
        if (isLocalAddress(host)) return realConnect.apply(this, args);
      } else if (typeof options.lookup === 'function') {
        const lookup = guardedLookup(options.lookup, host, port);
        // The connect callback: second in net's normalized pair, else the
        // argument after the options.
        const rest = Array.isArray(args[0]) ? [args[0][1]].filter(Boolean) : args.slice(1);
        return realConnect.call(this, { ...options, lookup }, ...rest);
      } else if (isLocalhostName(host)) {
        return realConnect.apply(this, args);
      }
      const err = refusal(`connects to ${host}:${port}`);
      process.nextTick(() => this.destroy(err));
      return this;
    };
    proto.connect = guardedConnect as unknown as net.Socket['connect'];
    proto[WRAPPED] = true;
  }

  const serversOfResolver = (self: unknown) => (self as dns.Resolver).getServers();
  guardMethods(dns as unknown as Patchable, ['lookup', 'lookupService'], false, refuseLookup);
  guardMethods(
    dns.promises as unknown as Patchable,
    ['lookup', 'lookupService'],
    true,
    refuseLookup,
  );
  guardMethods(
    dns as unknown as Patchable,
    RESOLVER_METHODS,
    false,
    refuseQuery(() => dns.getServers()),
  );
  guardMethods(
    dns.promises as unknown as Patchable,
    RESOLVER_METHODS,
    true,
    refuseQuery(() => dns.promises.getServers()),
  );
  guardMethods(
    dns.Resolver.prototype as unknown as Patchable,
    RESOLVER_METHODS,
    false,
    refuseQuery(serversOfResolver),
  );
  guardMethods(
    dns.promises.Resolver.prototype as unknown as Patchable,
    RESOLVER_METHODS,
    true,
    refuseQuery(serversOfResolver),
  );
  // `import { lookup } from 'node:dns'` reads a copy of each export made at
  // load; this updates those copies to the checks.
  syncBuiltinESMExports();
}
