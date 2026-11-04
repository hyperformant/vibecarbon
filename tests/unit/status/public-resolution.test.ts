/**
 * `vibecarbon status` resolves the app domain the way deploy does: through
 * public DNS (makePublicDnsLookup), never the operator's system resolver.
 *
 * Why (DO k8s-ha e2e, 2026-11-02): deploy's health and TLS probes passed, and
 * seconds later `status -json` failed `readiness probe failed: fetch failed;
 * tls untrusted: getaddrinfo ENOTFOUND d4.do.appcarbon.dev`. The record was
 * live on the authoritative nameservers and on 8.8.8.8. The operator's system
 * resolver still held the NXDOMAIN it cached during the previous run's
 * destroy, for the zone's SOA minimum (1800s on DigitalOcean). A customer
 * who destroys and redeploys within 30 minutes would see `status` call a
 * healthy domain unreachable.
 *
 * The domain here is under `.invalid` (RFC 6761), so the real system resolver
 * answers ENOTFOUND for it, exactly like the poisoned cache did. Only the
 * injected public lookup knows where the server is; the injected fallback is
 * the system resolver's ENOTFOUND, which a correct probe never reaches.
 */
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  makePublicDnsLookup,
  PUBLIC_DNS_BUDGET_MS,
} from '../../../src/lib/deploy/public-dns-lookup.js';
import { checkTls } from '../../../src/lib/status/tls-row.js';
import { checkRemoteHealth } from '../../../src/status.js';
import { makeCert } from '../deploy/_tls-fixtures.js';

const DOMAIN = 'd4.do.appcarbon.invalid';

const enotfound = (hostname: string, _opts: unknown, cb: (err: Error) => void) => {
  const err = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
    code: 'ENOTFOUND',
  });
  cb(err);
};

/** Public DNS has the record; the system resolver holds a stale NXDOMAIN. */
const publicKnows = () =>
  makePublicDnsLookup({
    resolver: {
      resolve4: (_h: string, cb: (e: null, a: string[]) => void) => cb(null, ['127.0.0.1']),
    },
    fallback: enotfound,
  });

/** Public DNS unreachable too: the probe falls to the poisoned system answer. */
const nobodyKnows = () =>
  makePublicDnsLookup({
    resolver: { resolve4: (_h: string, cb: (e: Error) => void) => cb(new Error('ECONNREFUSED')) },
    fallback: enotfound,
  });

let server: https.Server;
let port: number;
let ca: string;

beforeAll(async () => {
  const fixture = makeCert([DOMAIN]);
  ca = fixture.ca as string;
  server = https.createServer({ cert: fixture.cert, key: fixture.key }, (req, res) => {
    res.writeHead(req.url === '/api/health/ready' ? 200 : 404, {
      'content-type': 'application/json',
    });
    res.end(JSON.stringify({ status: 'ready', services: { database: 'connected' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe('status readiness probe', () => {
  it('reaches the domain through the public lookup while the system resolver says ENOTFOUND', async () => {
    const out = await checkRemoteHealth(DOMAIN, { lookup: publicKnows(), port, ca: [ca] });
    expect(out.error).toBeUndefined();
    expect(out.ok).toBe(true);
    expect(out.status).toBe(200);
    expect(out.data.services.database).toBe('connected');
  });

  it('public DNS silently dropped: falls back to the system answer inside the 5s abort', async () => {
    // Only the lookup's own timer is faked; the probe's 5s abort stays real,
    // so a lookup that outlived it would fail this test.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const lookup = makePublicDnsLookup({
        resolver: { resolve4: () => {} },
        fallback: (_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) =>
          opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4),
      });
      const pending = checkRemoteHealth(DOMAIN, { lookup, port, ca: [ca] });
      await vi.advanceTimersByTimeAsync(PUBLIC_DNS_BUDGET_MS);
      vi.useRealTimers();
      const out = await pending;
      expect(out.error).toBeUndefined();
      expect(out.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('only the system resolver left: fails ENOTFOUND (the control)', async () => {
    const out = await checkRemoteHealth(DOMAIN, { lookup: nobodyKnows(), port, ca: [ca] });
    expect(out.ok).toBe(false);
  });
});

describe('status TLS row', () => {
  it('verifies the chain through the public lookup while the system resolver says ENOTFOUND', async () => {
    const tls = await checkTls(
      DOMAIN,
      { envName: 'prod', envConfig: { deployMode: 'k8s-ha', domain: DOMAIN }, projectName: 'demo' },
      { lookup: publicKnows(), port, ca: [ca] },
    );
    expect(tls.state).toBe('trusted');
  });

  it('only the system resolver left: names ENOTFOUND (the control)', async () => {
    const tls = await checkTls(
      DOMAIN,
      { envName: 'prod', envConfig: { deployMode: 'k8s-ha', domain: DOMAIN }, projectName: 'demo' },
      { lookup: nobodyKnows(), port, ca: [ca] },
    );
    expect(tls.state).toBe('untrusted');
    expect(tls.reason).toContain('ENOTFOUND');
  });
});
