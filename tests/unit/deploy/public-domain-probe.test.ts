/**
 * The one way the CLI reaches an app's public domain: public DNS
 * (makePublicDnsLookup), SNI pinned to the domain, the staging-aware trust
 * policy. Deploy, status and the deploy failure diagnostics all go through
 * src/lib/deploy/public-domain-probe.js; the census next door keeps it so.
 */
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  connectPublicTls,
  fetchPublicDomain,
  PUBLIC_PROBE_MAX_BODY_BYTES,
  publicCurlResolveArgs,
  publicProbeConnect,
} from '../../../src/lib/deploy/public-domain-probe.js';
import { makeCert } from './_tls-fixtures.js';

const DOMAIN = 'app.probe.invalid';
const toLocal = vi.fn((_h: string, opts: unknown, cb: (...a: unknown[]) => void) => {
  if ((opts as { all?: boolean })?.all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
  else cb(null, '127.0.0.1', 4);
});

// Fixed routes to constant sizes: no request value ever reaches an allocation.
const BYTE_ROUTES: Record<string, number> = {
  '/bytes/at-cap': PUBLIC_PROBE_MAX_BODY_BYTES,
  '/bytes/over-cap': PUBLIC_PROBE_MAX_BODY_BYTES + 1,
};

let server: https.Server;
let port: number;
let ca: string;

beforeAll(async () => {
  const fixture = makeCert([DOMAIN]);
  ca = fixture.ca as string;
  server = https.createServer({ cert: fixture.cert, key: fixture.key }, (req, res) => {
    const size = BYTE_ROUTES[req.url ?? ''];
    if (size !== undefined) {
      // Chunked, no content-length: the cap must hold while streaming.
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(Buffer.alloc(size, 0x61));
      return;
    }
    if (req.url === '/empty') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, host: req.headers.host }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe('publicProbeConnect', () => {
  it('pins SNI to the domain and resolves through public DNS by default', () => {
    const on = publicProbeConnect(DOMAIN);
    expect(on.servername).toBe(DOMAIN);
    expect(typeof on.lookup).toBe('function');
    expect(on.rejectUnauthorized).toBeUndefined();
  });

  it('verifyTls false is the one opt-out, and it keeps public DNS and SNI', () => {
    const off = publicProbeConnect(DOMAIN, { verifyTls: false });
    expect(off.rejectUnauthorized).toBe(false);
    expect(off.servername).toBe(DOMAIN);
    expect(typeof off.lookup).toBe('function');
  });

  it('an injected lookup and trust store are used as given', () => {
    const opts = publicProbeConnect(DOMAIN, { lookup: toLocal, ca: ['x'] });
    expect(opts.lookup).toBe(toLocal);
    expect(opts.ca).toEqual(['x']);
  });
});

describe('fetchPublicDomain', () => {
  it('dials the address the lookup gives, keeps the domain as Host and SNI, and buffers the body', async () => {
    toLocal.mockClear();
    const res = await fetchPublicDomain(
      `https://${DOMAIN}:${port}/api/health`,
      {},
      {
        lookup: toLocal,
        ca: [ca],
      },
    );
    expect(toLocal).toHaveBeenCalled();
    expect(toLocal.mock.calls[0][0]).toBe(DOMAIN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: '/api/health', host: `${DOMAIN}:${port}` });
  });

  it('a no-content answer comes back as a response, not a throw', async () => {
    const res = await fetchPublicDomain(
      `https://${DOMAIN}:${port}/empty`,
      {},
      {
        lookup: toLocal,
        ca: [ca],
      },
    );
    expect(res.status).toBe(204);
    expect(res.ok).toBe(true);
  });

  it('caps the buffered body: a health-sized answer is fine, past the cap it errors', async () => {
    expect(PUBLIC_PROBE_MAX_BODY_BYTES).toBe(1024 * 1024);
    const at = await fetchPublicDomain(
      `https://${DOMAIN}:${port}/bytes/at-cap`,
      {},
      { lookup: toLocal, ca: [ca] },
    );
    expect((await at.arrayBuffer()).byteLength).toBe(PUBLIC_PROBE_MAX_BODY_BYTES);
    await expect(
      fetchPublicDomain(
        `https://${DOMAIN}:${port}/bytes/over-cap`,
        {},
        { lookup: toLocal, ca: [ca] },
      ),
    ).rejects.toThrow(/over 1 MB/);
  });

  it('verification stays on: an unknown chain fails', async () => {
    await expect(
      fetchPublicDomain(`https://${DOMAIN}:${port}/api/health`, {}, { lookup: toLocal }),
    ).rejects.toThrow();
  });
});

describe('connectPublicTls', () => {
  it('resolves the host through the given lookup', async () => {
    toLocal.mockClear();
    const authorized = await new Promise<boolean>((resolve, reject) => {
      const socket = connectPublicTls(
        { host: DOMAIN, port, servername: DOMAIN, ca: [ca] },
        () => {
          resolve(socket.authorized);
          socket.destroy();
        },
        { lookup: toLocal },
      );
      socket.on('error', reject);
    });
    expect(authorized).toBe(true);
    expect(toLocal.mock.calls[0][0]).toBe(DOMAIN);
  });
});

describe('publicCurlResolveArgs', () => {
  it('pins curl to the public answer', async () => {
    const args = await publicCurlResolveArgs(DOMAIN, { resolve: async () => ['203.0.113.7'] });
    expect(args).toEqual(['--resolve', `${DOMAIN}:443:203.0.113.7`]);
  });

  it('nothing resolves: no pin, curl reports its own failure', async () => {
    expect(await publicCurlResolveArgs(DOMAIN, { resolve: async () => [] })).toEqual([]);
  });
});
