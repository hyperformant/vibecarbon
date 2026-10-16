/**
 * The docker smoke's port probe (tests/_shared/docker-utils.ts). A non-root
 * user gets EACCES binding :80 whether or not it is free, and the probe used
 * to read that as "busy", so the Traefik smoke never ran for a normal user
 * (final review M8). EACCES now falls back to asking the port.
 */
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchWithTimeout, isPortAvailable, nothingListensOn } from '../../_shared/docker-utils.js';

let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

const listen = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    server = s;
    s.listen(0, '0.0.0.0', () => resolve((s.address() as { port: number }).port));
  });

describe('nothingListensOn', () => {
  it('false when something listens, true once it is gone', async () => {
    const port = await listen();
    expect(await nothingListensOn(port)).toBe(false);
    await new Promise<void>((r) => server?.close(() => r()));
    server = null;
    expect(await nothingListensOn(port)).toBe(true);
  });
});

describe('isPortAvailable', () => {
  it('a port someone holds is not available', async () => {
    const port = await listen();
    expect(await isPortAvailable(port)).toBe(false);
  });

  const unprivilegedStart = (() => {
    try {
      return Number(readFileSync('/proc/sys/net/ipv4/ip_unprivileged_port_start', 'utf8'));
    } catch {
      return 0;
    }
  })();
  const nonRootLowPort = process.getuid?.() !== 0 && unprivilegedStart > 80;

  it.runIf(nonRootLowPort)(
    'non-root: EACCES on a free :80 still reads as available (Docker publishes it as root)',
    async () => {
      if (!(await nothingListensOn(80))) return; // something real holds :80 here
      expect(await isPortAvailable(80)).toBe(true);
    },
  );
});

// fetch drops a caller's Host header, so the smoke's Host-routed Traefik
// cases (traefik.localhost) silently hit the localhost router instead.
describe('fetchWithTimeout', () => {
  it('sends the Host header it is given', async () => {
    const http = createHttpServer((req, res) => res.end(req.headers.host));
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    const { port } = http.address() as { port: number };
    try {
      const r = await fetchWithTimeout(`http://127.0.0.1:${port}/`, 2000, {
        headers: { Host: 'traefik.localhost' },
      });
      expect(r).toEqual({ ok: true, status: 200, body: 'traefik.localhost' });
    } finally {
      await new Promise<void>((r) => http.close(() => r()));
    }
  });

  it('a refused connection is status 0, never a throw', async () => {
    const port = await listen();
    await new Promise<void>((r) => server?.close(() => r()));
    server = null;
    expect(await fetchWithTimeout(`http://127.0.0.1:${port}/`, 2000)).toEqual({
      ok: false,
      status: 0,
      body: '',
    });
  });
});
