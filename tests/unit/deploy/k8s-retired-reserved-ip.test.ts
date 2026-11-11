/**
 * A DigitalOcean k8s cluster made before 2026-11 holds a reserved IP its
 * domain pointed at. Every up and preview takes it out of the stack's state
 * (lib/iac/retired-resources.js), so it stays assigned to the master and
 * keeps serving; the deploy releases it by address only once nothing in DNS
 * points at it, because a released address goes back to DigitalOcean's pool
 * and whoever gets it next could serve on any name still resolving to it.
 *
 * Review focus:
 *   - managed DNS: no DELETE while the domain's own nameservers still answer
 *     the old address, or do not answer the new one, or the record's TTL has
 *     not passed since the write that moved it; a DELETE once all hold;
 *   - DNS kept by hand: never released on the deploy that finds it still in
 *     DNS (the user is told the old and the new address); released only by a
 *     later deploy, at least the TTL (an hour at least) after a deploy first
 *     saw DNS without it;
 *   - a lookup that could not run, or no domain, keeps it;
 *   - the release itself goes through the real provider method (a DELETE by
 *     address on the wire), a released address leaves the record, a failed
 *     one stays (so the next deploy or destroy's backstop still finds it);
 *   - nothing is ever released on a provider whose clusters still take
 *     traffic at their floating IP.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args) };
});

import {
  MANUAL_DNS_MIN_WAIT_SECONDS,
  releaseRetiredReservedIps,
  releaseVerdict,
  retiredReservedIps,
} from '../../../src/lib/deploy/k8s/retired-reserved-ip.js';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';

// A block body on purpose: mockReset returns the mock, and vitest calls a
// function returned from beforeEach as the test's teardown, which would run
// the throwing implementation below once more after the test.
beforeEach(() => {
  fetchWithRetryMock.mockReset();
});

const DOMAIN = 'app.example.com';
const OLD = '203.0.113.9';
const OLD_STANDBY = '203.0.113.10';
const MASTER = '198.51.100.7';
const NOW = Date.parse('2026-11-11T12:00:00Z');
const NAMESERVERS = ['192.0.2.1', '192.0.2.2', '192.0.2.3'];

type Env = Record<string, unknown>;
type Answer = {
  name: string;
  server: string;
  host: string;
  addresses: string[];
  ttl: number | null;
};

/** Every nameserver answers `apex` for the apex and `wildcard` for `*.domain`. */
function served(
  apex: string[],
  wildcard: string[] = apex,
  ttl = 60,
): { ok: true; zone: string; answers: Answer[] } {
  const answers = NAMESERVERS.flatMap((server, i) => [
    {
      name: DOMAIN,
      server,
      host: `ns${i + 1}.example.net`,
      addresses: apex,
      ttl: apex.length ? ttl : null,
    },
    {
      name: `*.${DOMAIN}`,
      server,
      host: `ns${i + 1}.example.net`,
      addresses: wildcard,
      ttl: wildcard.length ? ttl : null,
    },
  ]);
  return { ok: true, zone: 'example.com', answers };
}

/** An in-memory project config the release reads and writes. */
const store = (env: Env) => {
  const config = { environments: { prod: structuredClone(env) } };
  return {
    config,
    readConfig: () => config,
    updateConfig: vi.fn((fn: (c: typeof config) => void) => fn(config)),
  };
};
const logger = () => ({ info: vi.fn(), warn: vi.fn() });
const deleteUrls = () =>
  fetchWithRetryMock.mock.calls
    .filter(([, init]) => init?.method === 'DELETE')
    .map(([url]) => url as string);
/** Every DELETE answers with `status`. */
const deletesAnswer = (status: number) =>
  fetchWithRetryMock.mockImplementation(async () => ({ ok: status < 300, status }));

/** Managed DNS: this run's writer put the records at MASTER `ago` seconds before NOW. */
const managed = (ago = 600) => ({ target: MASTER, changedAt: NOW - ago * 1000 });

function release(
  env: Env,
  {
    Provider = DigitalOceanProvider as never,
    lookup = served([MASTER]) as unknown,
    dnsWrite = managed() as { target: string; changedAt: number } | null,
    domain = DOMAIN as string | null,
    now = NOW,
  } = {},
) {
  const s = store(env);
  const log = logger();
  const lookupFn = vi.fn(async () => lookup);
  const run = releaseRetiredReservedIps({
    environment: 'prod',
    Provider,
    provider: new (Provider as typeof DigitalOceanProvider)('token'),
    log,
    domain,
    dnsWrite,
    newAddress: MASTER,
    lookup: lookupFn as never,
    now: () => now,
    readConfig: s.readConfig,
    updateConfig: s.updateConfig,
  });
  return { s, log, run, lookupFn };
}

describe('retiredReservedIps', () => {
  it('DigitalOcean: every recorded floating IP, each once', () => {
    expect(
      retiredReservedIps(DigitalOceanProvider, {
        floatingIp: OLD,
        ha: { primary: { floatingIp: OLD }, standby: { floatingIp: OLD_STANDBY } },
      }),
    ).toEqual([OLD, OLD_STANDBY]);
  });

  it('DigitalOcean: an environment on the current program has none', () => {
    expect(retiredReservedIps(DigitalOceanProvider, { ingressIp: MASTER })).toEqual([]);
    expect(retiredReservedIps(DigitalOceanProvider, undefined)).toEqual([]);
  });

  it('Hetzner and Linode: never, their floating IP is the live ingress', () => {
    const env = { floatingIp: OLD, ha: { standby: { floatingIp: OLD_STANDBY } } };
    expect(retiredReservedIps(HetznerProvider, env)).toEqual([]);
    expect(retiredReservedIps(LinodeProvider, env)).toEqual([]);
  });
});

describe('releaseVerdict: managed DNS', () => {
  const verdict = (lookup: unknown, over: Record<string, unknown> = {}) =>
    releaseVerdict({
      address: OLD,
      lookup: lookup as never,
      dnsWrite: managed(),
      clearSince: null,
      domain: DOMAIN,
      now: NOW,
      ...over,
    });

  it('old address gone, new one served everywhere, TTL passed: release', () => {
    expect(verdict(served([MASTER]))).toEqual({ release: true, kind: 'release' });
  });

  it('the old address still answered for any name, on any nameserver: keep', () => {
    expect(verdict(served([MASTER], [OLD]))).toMatchObject({
      release: false,
      kind: 'still-answered',
      names: [`*.${DOMAIN}`],
    });
    const oneServer = served([MASTER]);
    oneServer.answers[4].addresses = [OLD];
    expect(verdict(oneServer)).toMatchObject({ release: false, kind: 'still-answered' });
  });

  it('a nameserver without the new address (another zone, or not caught up): keep', () => {
    const lagging = served([MASTER]);
    lagging.answers[2].addresses = [];
    expect(verdict(lagging)).toMatchObject({ release: false, kind: 'not-moved' });
    expect(verdict(served(['192.0.2.200']))).toMatchObject({ kind: 'not-moved' });
    expect(verdict({ ok: true, zone: 'example.com', answers: [] })).toMatchObject({
      kind: 'not-moved',
    });
  });

  it('within the TTL of the write that moved it: keep, saying how long is left', () => {
    expect(verdict(served([MASTER], [MASTER], 300), { dnsWrite: managed(120) })).toEqual({
      release: false,
      kind: 'settling',
      waitSeconds: 300,
      remainingSeconds: 180,
    });
    // The longest TTL any answer carries is the one that counts.
    const mixed = served([MASTER], [MASTER], 60);
    mixed.answers[1].ttl = 900;
    expect(verdict(mixed)).toMatchObject({ kind: 'settling', waitSeconds: 900 });
  });

  it('a lookup that could not run: keep', () => {
    expect(verdict({ ok: false, reason: 'no answer for app.example.com at ns1' })).toEqual({
      release: false,
      kind: 'unchecked',
      reason: 'no answer for app.example.com at ns1',
    });
  });

  it('never releases the address the records were written to', () => {
    expect(verdict(served([OLD]), { dnsWrite: { target: OLD, changedAt: 0 } })).toMatchObject({
      release: false,
    });
  });
});

describe('releaseVerdict: DNS kept by hand', () => {
  const verdict = (lookup: unknown, clearSince: number | null) =>
    releaseVerdict({
      address: OLD,
      lookup: lookup as never,
      dnsWrite: null,
      clearSince,
      domain: DOMAIN,
      now: NOW,
    });

  it('first deploy to see DNS moved: keep, and start the clock', () => {
    expect(verdict(served([MASTER]), null)).toEqual({
      release: false,
      kind: 'settling',
      waitSeconds: MANUAL_DNS_MIN_WAIT_SECONDS,
      remainingSeconds: MANUAL_DNS_MIN_WAIT_SECONDS,
      clearSince: NOW,
    });
  });

  it('a later deploy, an hour (and the TTL) after: release', () => {
    expect(verdict(served([MASTER]), NOW - MANUAL_DNS_MIN_WAIT_SECONDS * 1000)).toEqual({
      release: true,
      kind: 'release',
    });
    expect(verdict(served([MASTER]), NOW - 60_000)).toMatchObject({ kind: 'settling' });
    // A record TTL longer than the floor raises the wait.
    expect(verdict(served([MASTER], [], 7200), NOW - 3600_000)).toMatchObject({
      kind: 'settling',
      waitSeconds: 7200,
      remainingSeconds: 3600,
    });
  });

  it('anywhere the records point is fine, as long as it is not the old address', () => {
    expect(verdict(served(['192.0.2.77'], []), NOW - 7200_000)).toMatchObject({ release: true });
  });

  it('still answered: keep, and clear any clock', () => {
    expect(verdict(served([OLD]), NOW - 7200_000)).toMatchObject({
      release: false,
      kind: 'still-answered',
      clearSince: null,
    });
  });

  it('no A record at the apex on some nameserver: keep (nothing says these serve the domain)', () => {
    expect(verdict(served([]), NOW - 7200_000)).toMatchObject({ kind: 'no-answer' });
    const partial = served([MASTER]);
    partial.answers[2].addresses = [];
    expect(verdict(partial, NOW - 7200_000)).toMatchObject({ kind: 'no-answer' });
  });
});

describe('releaseRetiredReservedIps: managed DNS', () => {
  it('single k8s: asks the apex and wildcard, DELETEs by address, forgets it', async () => {
    deletesAnswer(204);
    const { s, log, run, lookupFn } = release({
      deployMode: 'kubernetes',
      ingressIp: MASTER,
      floatingIp: OLD,
    });
    expect(await run).toEqual({ released: [OLD], kept: [] });
    expect(lookupFn).toHaveBeenCalledWith([DOMAIN, `*.${DOMAIN}`], { domain: DOMAIN });
    expect(deleteUrls()).toEqual([`https://api.digitalocean.com/v2/reserved_ips/${OLD}`]);
    expect(s.config.environments.prod).toEqual({ deployMode: 'kubernetes', ingressIp: MASTER });
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining(`released the reserved IP ${OLD}`),
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('old address still answered: no DELETE, record kept, and a warning naming both', async () => {
    const { s, log, run } = release(
      { ingressIp: MASTER, floatingIp: OLD },
      { lookup: served([MASTER], [OLD]) },
    );
    expect(await run).toEqual({ released: [], kept: [{ address: OLD, reason: 'still-answered' }] });
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
    expect(s.config.environments.prod).toHaveProperty('floatingIp', OLD);
    const [line] = log.warn.mock.calls[0];
    expect(line).toContain(`*.${DOMAIN} still answers ${OLD}`);
    expect(line).toContain(MASTER);
    expect(line).not.toContain('—');
  });

  it('gone, but the TTL has not passed since the write: no DELETE, next deploy', async () => {
    const { s, log, run } = release(
      { ingressIp: MASTER, floatingIp: OLD },
      { dnsWrite: managed(20) },
    );
    expect((await run).released).toEqual([]);
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
    expect(s.config.environments.prod).toHaveProperty('floatingIp', OLD);
    expect(s.updateConfig).not.toHaveBeenCalled();
    expect(log.info.mock.calls[0][0]).toContain('up to 40 s more');
  });

  it('a lookup that could not run: no DELETE, a warning that the next deploy checks again', async () => {
    const { s, log, run } = release(
      { floatingIp: OLD },
      { lookup: { ok: false, reason: 'the NS lookup of example.com failed (1.1.1.1 ETIMEOUT)' } },
    );
    expect((await run).kept).toEqual([{ address: OLD, reason: 'unchecked' }]);
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
    expect(s.config.environments.prod).toHaveProperty('floatingIp', OLD);
    const [line] = log.warn.mock.calls[0];
    // Why it stays: the nameservers did not answer, and the reason.
    expect(line).toContain(`could not get an answer from ${DOMAIN}'s nameservers`);
    expect(line).toContain('1.1.1.1 ETIMEOUT');
    // What it costs while it stays.
    expect(line).toContain(
      'still a reserved IP on your DigitalOcean account, which bills it whenever it is not assigned to a droplet',
    );
    expect(line).toContain('The next deploy checks again');
    expect(line).toContain('`vibecarbon destroy prod`');
    expect(line).not.toContain('—');
  });

  it('a lookup that throws: no DELETE, the record kept, a warning, and the deploy goes on', async () => {
    const s = store({ ingressIp: MASTER, floatingIp: OLD });
    const log = logger();
    const out = await releaseRetiredReservedIps({
      environment: 'prod',
      Provider: DigitalOceanProvider,
      provider: new DigitalOceanProvider('token'),
      log,
      domain: DOMAIN,
      dnsWrite: managed(),
      newAddress: MASTER,
      lookup: (async () => {
        throw new Error('setServers: invalid IP address');
      }) as never,
      now: () => NOW,
      readConfig: s.readConfig,
      updateConfig: s.updateConfig,
    });
    expect(out).toEqual({ released: [], kept: [{ address: OLD, reason: 'unchecked' }] });
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
    expect(s.config.environments.prod).toHaveProperty('floatingIp', OLD);
    expect(log.warn.mock.calls[0][0]).toContain('setServers: invalid IP address');
  });

  it('already gone (404) counts as released', async () => {
    deletesAnswer(404);
    const { s, run } = release({ ingressIp: MASTER, floatingIp: OLD });
    expect((await run).released).toEqual([OLD]);
    expect(s.config.environments.prod).not.toHaveProperty('floatingIp');
  });

  it('k8s-ha: releases both sides, each by its own address, with one lookup', async () => {
    deletesAnswer(204);
    const { s, run, lookupFn } = release({
      ha: {
        primary: { stack: 'prod', ingressIp: MASTER, floatingIp: OLD },
        standby: { stack: 'prod-standby', ingressIp: '198.51.100.8', floatingIp: OLD_STANDBY },
      },
    });
    expect((await run).released).toEqual([OLD, OLD_STANDBY]);
    expect(lookupFn).toHaveBeenCalledOnce();
    expect(deleteUrls()).toEqual([
      `https://api.digitalocean.com/v2/reserved_ips/${OLD}`,
      `https://api.digitalocean.com/v2/reserved_ips/${OLD_STANDBY}`,
    ]);
    expect(s.config.environments.prod).toEqual({
      ha: {
        primary: { stack: 'prod', ingressIp: MASTER },
        standby: { stack: 'prod-standby', ingressIp: '198.51.100.8' },
      },
    });
  });

  it('a refused DELETE keeps the record and warns with every way it still gets released', async () => {
    deletesAnswer(500);
    const { s, log, run } = release({ ingressIp: MASTER, floatingIp: OLD });
    const out = await run;
    expect(out.released).toEqual([]);
    expect(out.kept).toEqual([{ address: OLD, reason: 'DigitalOcean did not accept the delete' }]);
    // Still on record: the next deploy and destroy's backstop both read it.
    expect(s.config.environments.prod).toHaveProperty('floatingIp', OLD);
    expect(s.updateConfig).not.toHaveBeenCalled();
    const [line] = log.warn.mock.calls[0];
    expect(line).toContain(OLD);
    expect(line).toContain('bills a reserved IP while it is not assigned to a droplet');
    expect(line).toContain('The next deploy tries again');
    expect(line).toContain('`vibecarbon destroy prod`');
    expect(line).toContain('Networking, Reserved IPs');
    expect(line).not.toContain('—');
  });

  it('a DELETE that throws is kept on record too, and the deploy carries on', async () => {
    fetchWithRetryMock.mockImplementation(async () => {
      throw new Error('socket hang up');
    });
    const { s, log, run } = release({ floatingIp: OLD });
    expect((await run).kept).toEqual([{ address: OLD, reason: 'socket hang up' }]);
    expect(s.config.environments.prod).toHaveProperty('floatingIp', OLD);
    expect(log.warn).toHaveBeenCalledOnce();
  });
});

describe('releaseRetiredReservedIps: DNS kept by hand', () => {
  it('the deploy that moves the cluster never releases: it prints the old and the new address', async () => {
    const { s, log, run } = release(
      { ingressIp: MASTER, floatingIp: OLD },
      { dnsWrite: null, lookup: served([OLD]) },
    );
    expect((await run).released).toEqual([]);
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
    expect(s.config.environments.prod).toHaveProperty('floatingIp', OLD);
    const [line] = log.warn.mock.calls[0];
    expect(line).toContain(`still answers ${OLD}`);
    expect(line).toContain(`Point the A records for ${DOMAIN} and *.${DOMAIN} at ${MASTER}`);
    expect(line).toContain('keeps serving');
    expect(line).not.toContain('—');
  });

  it('a deploy that first sees DNS moved stamps the time and keeps it; a later one releases it', async () => {
    const first = release(
      { ingressIp: MASTER, floatingIp: OLD },
      { dnsWrite: null, lookup: served([MASTER]) },
    );
    expect((await first.run).released).toEqual([]);
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
    const stamped = first.s.config.environments.prod as Env;
    expect(stamped.retiredIpDnsClearSince).toEqual({ [OLD]: new Date(NOW).toISOString() });
    expect(first.log.info.mock.calls[0][0]).toContain('next deploy after that releases it');

    // A deploy within the wait keeps it and leaves the stamp alone.
    const soon = release(stamped, { dnsWrite: null, lookup: served([MASTER]), now: NOW + 60_000 });
    expect((await soon.run).released).toEqual([]);
    expect(soon.s.updateConfig).not.toHaveBeenCalled();

    deletesAnswer(204);
    const later = release(stamped, {
      dnsWrite: null,
      lookup: served([MASTER]),
      now: NOW + MANUAL_DNS_MIN_WAIT_SECONDS * 1000,
    });
    expect((await later.run).released).toEqual([OLD]);
    expect(deleteUrls()).toEqual([`https://api.digitalocean.com/v2/reserved_ips/${OLD}`]);
    // Forgotten with its stamp.
    expect(later.s.config.environments.prod).toEqual({ ingressIp: MASTER });
  });

  it('a lookup that could not run still says where to point the records', async () => {
    const { s, log, run } = release(
      { ingressIp: MASTER, floatingIp: OLD },
      { dnsWrite: null, lookup: { ok: false, reason: 'no nameservers found for app.example.com' } },
    );
    expect((await run).kept).toEqual([{ address: OLD, reason: 'unchecked' }]);
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
    expect(s.config.environments.prod).toHaveProperty('floatingIp', OLD);
    const [line] = log.warn.mock.calls[0];
    expect(line).toContain(`point them at ${MASTER}`);
    expect(line).toContain(`${DOMAIN} and *.${DOMAIN} still point at ${OLD}`);
    expect(line).not.toContain('—');
  });

  it('DNS pointed back at the old address clears the stamp', async () => {
    const { s, run } = release(
      {
        ingressIp: MASTER,
        floatingIp: OLD,
        retiredIpDnsClearSince: { [OLD]: new Date(NOW - 7200_000).toISOString() },
      },
      { dnsWrite: null, lookup: served([OLD]) },
    );
    expect((await run).released).toEqual([]);
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
    expect(s.config.environments.prod).not.toHaveProperty('retiredIpDnsClearSince');
  });
});

describe('releaseRetiredReservedIps: what it never touches', () => {
  it('no domain: no lookup, no DELETE, and a line saying how to release it', async () => {
    const { log, run, lookupFn } = release({ floatingIp: OLD }, { domain: null });
    expect((await run).kept).toEqual([{ address: OLD, reason: 'no domain on record' }]);
    expect(lookupFn).not.toHaveBeenCalled();
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
    expect(log.info.mock.calls[0][0]).toContain('`vibecarbon destroy prod` releases it');
  });

  it('an environment on the current program makes no lookup and no API call', async () => {
    const { run, lookupFn } = release({ deployMode: 'kubernetes', ingressIp: MASTER });
    expect(await run).toEqual({ released: [], kept: [] });
    expect(lookupFn).not.toHaveBeenCalled();
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
  });

  it('Hetzner and Linode: a recorded floating IP is left alone, no lookup, no API call', async () => {
    for (const Provider of [HetznerProvider, LinodeProvider]) {
      const { s, run, lookupFn } = release({ floatingIp: OLD }, { Provider: Provider as never });
      expect(await run).toEqual({ released: [], kept: [] });
      expect(lookupFn).not.toHaveBeenCalled();
      expect(s.config.environments.prod).toHaveProperty('floatingIp', OLD);
    }
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
  });
});
