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
 *   - managed DNS: no DELETE while any A record in the zone has the address
 *     (a record the user added, a proxied origin), or the zone cannot be
 *     listed;
 *   - a lookup that could not run, or no domain, keeps it;
 *   - just before the DELETE, every stack that may still list the address
 *     lets go of it (a warm redeploy ran no up); a stack that cannot keeps
 *     it, because a stack listing a released address fails every destroy;
 *   - the lines name what was checked and what was not: a record in another
 *     zone, a proxy's or CDN's origin;
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
  createDropRetired,
  MANUAL_DNS_MIN_WAIT_SECONDS,
  recordRetiredReservedIps,
  releaseRetiredReservedIps,
  releaseVerdict,
  retiredReservedIpStacks,
  retiredReservedIps,
  zoneVerdict,
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
/**
 * Every DELETE answers with `status`; the read by address that follows
 * answers `read`: 404 (gone), 'listed' (DigitalOcean still has it, in nyc3),
 * or another status.
 */
const deletesAnswer = (status: number, read: number | 'listed' = 404) =>
  fetchWithRetryMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (init?.method === 'DELETE') return { ok: status < 300, status };
    if (read === 'listed') {
      const ip = url.split('/').pop();
      return {
        ok: true,
        status: 200,
        json: async () => ({ reserved_ip: { ip, region: { slug: 'nyc3' }, droplet: null } }),
      };
    }
    return { ok: read < 300, status: read, json: async () => ({}) };
  });

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
    dropRetired = vi.fn(async (_stack: string) => {}),
    zoneRecordsAt = vi.fn(async (_address: string) => [] as string[]) as
      | ((address: string) => Promise<string[]>)
      | null,
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
    dropRetired,
    zoneRecordsAt,
    lookup: lookupFn as never,
    now: () => now,
    readConfig: s.readConfig,
    updateConfig: s.updateConfig,
  });
  return { s, log, run, lookupFn, dropRetired, zoneRecordsAt };
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
      source: 'nameservers',
      reason: 'no answer for app.example.com at ns1',
    });
  });

  it('not moved: says what each nameserver that missed the new address served', () => {
    const lagging = served([MASTER]);
    lagging.answers[2].addresses = ['192.0.2.200'];
    lagging.answers[3].addresses = [];
    expect(verdict(lagging)).toEqual({
      release: false,
      kind: 'not-moved',
      names: [DOMAIN, `*.${DOMAIN}`],
      served: [
        { name: DOMAIN, host: 'ns2.example.net', server: '192.0.2.2', addresses: ['192.0.2.200'] },
        { name: `*.${DOMAIN}`, host: 'ns2.example.net', server: '192.0.2.2', addresses: [] },
      ],
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
    expect(line).toContain(`could not check what ${DOMAIN}'s nameservers answer`);
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

  it('a DELETE that answers 404 is released once the read by address agrees', async () => {
    deletesAnswer(404);
    const { s, run } = release({ ingressIp: MASTER, floatingIp: OLD });
    expect((await run).released).toEqual([OLD]);
    expect(s.config.environments.prod).not.toHaveProperty('floatingIp');
  });

  // DigitalOcean has answered a DELETE with success and kept the address.
  it('a DELETE DigitalOcean accepts but still lists: kept, and a warning naming the address, region and bill', async () => {
    deletesAnswer(204, 'listed');
    const { s, log, run } = release({ ingressIp: MASTER, floatingIp: OLD });
    const out = await run;
    expect(out.released).toEqual([]);
    expect(out.kept).toEqual([
      { address: OLD, reason: 'DigitalOcean still lists it after the delete' },
    ]);
    // Still on record: the next deploy and destroy's backstop both read it.
    expect(s.config.environments.prod).toHaveProperty('floatingIp', OLD);
    expect(s.updateConfig).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('released the reserved IP'));
    const [line] = log.warn.mock.calls[0];
    expect(line).toContain(`the reserved IP ${OLD}, but it is not released`);
    expect(line).toContain('DigitalOcean still lists it after the delete');
    expect(line).toContain('still on your DigitalOcean account in nyc3');
    expect(line).toContain('bills a reserved IP while it is not assigned to a droplet');
    expect(line).toContain('The next deploy tries again');
    expect(line).toContain('`vibecarbon destroy prod`');
    expect(line).not.toContain('—');
  });

  it('a 404 DELETE whose read still lists the address is kept too', async () => {
    deletesAnswer(404, 'listed');
    const { s, run } = release({ ingressIp: MASTER, floatingIp: OLD });
    expect((await run).released).toEqual([]);
    expect(s.config.environments.prod).toHaveProperty('floatingIp', OLD);
  });

  it('a read that fails proves nothing: kept, and the warning says it cannot tell', async () => {
    deletesAnswer(204, 503);
    const { s, log, run } = release({ ingressIp: MASTER, floatingIp: OLD });
    expect((await run).kept).toEqual([
      { address: OLD, reason: 'the read-back after the delete failed (HTTP 503)' },
    ]);
    expect(s.config.environments.prod).toHaveProperty('floatingIp', OLD);
    const [line] = log.warn.mock.calls[0];
    expect(line).toContain(
      `the reserved IP ${OLD}, but vibecarbon cannot tell whether it was released`,
    );
    expect(line).toContain('the read-back after the delete failed (HTTP 503)');
    expect(line).toContain('If it was not, it is still on your DigitalOcean account');
    expect(line).toContain('The next deploy checks again');
    expect(line).not.toContain('—');
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
    deletesAnswer(500, 'listed');
    const { s, log, run } = release({ ingressIp: MASTER, floatingIp: OLD });
    const out = await run;
    expect(out.released).toEqual([]);
    expect(out.kept).toEqual([
      { address: OLD, reason: 'DigitalOcean refused the delete (HTTP 500)' },
    ]);
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

describe('releaseRetiredReservedIps: the stacks let go first', () => {
  // A warm redeploy runs no up, so the stack can still list the IP and its
  // assignment. Released while listed, every destroy after fails on it.
  it('single k8s: the environment stack drops it, then the DELETE', async () => {
    const order: string[] = [];
    fetchWithRetryMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      order.push(`${init?.method ?? 'GET'} ${url.split('/').pop()}`);
      return init?.method === 'DELETE' ? { ok: true, status: 204 } : { ok: false, status: 404 };
    });
    const dropRetired = vi.fn(async (stack: string) => {
      order.push(`drop ${stack}`);
    });
    const { run } = release({ ingressIp: MASTER, floatingIp: OLD }, { dropRetired });
    expect((await run).released).toEqual([OLD]);
    expect(order).toEqual(['drop prod', `DELETE ${OLD}`, `GET ${OLD}`]);
  });

  it('a stack that cannot let go keeps the address: no DELETE, a warning, the next deploy retries', async () => {
    const dropRetired = vi.fn(async () => {
      throw new Error(
        'Stack "prod" is in use by another run: someone@laptop (pid 1), started now.\nmore',
      );
    });
    const { s, log, run } = release({ ingressIp: MASTER, floatingIp: OLD }, { dropRetired });
    const out = await run;
    expect(out.released).toEqual([]);
    expect(out.kept).toEqual([
      {
        address: OLD,
        reason:
          'stack prod: Stack "prod" is in use by another run: someone@laptop (pid 1), started now.',
      },
    ]);
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
    expect(s.config.environments.prod).toHaveProperty('floatingIp', OLD);
    const [line] = log.warn.mock.calls[0];
    expect(line).toContain(`could not take it out of stack prod's Pulumi state`);
    expect(line).toContain('`vibecarbon destroy prod` fail on it');
    expect(line).toContain('the next deploy tries again');
    expect(line).not.toContain('—');
  });

  it('k8s-ha: each address leaves its own side stack, by .stack, else by role', async () => {
    deletesAnswer(204);
    const dropRetired = vi.fn(async (_stack: string) => {});
    const { run } = release(
      {
        ha: {
          // The stack name a side records wins over its role.
          primary: { stack: 'prod', floatingIp: OLD },
          // Recorded before sides carried their stack.
          standby: { floatingIp: OLD_STANDBY },
        },
      },
      { dropRetired },
    );
    expect((await run).released).toEqual([OLD, OLD_STANDBY]);
    expect(dropRetired.mock.calls.map(([stack]) => stack)).toEqual(['prod', 'prod-standby']);
  });

  it('each stack is asked once, however many of its addresses go', async () => {
    deletesAnswer(204);
    const dropRetired = vi.fn(async (_stack: string) => {});
    const { run } = release(
      {
        floatingIp: OLD,
        ha: { primary: { stack: 'prod', floatingIp: OLD_STANDBY }, standby: { stack: 'prod-b' } },
      },
      { dropRetired },
    );
    expect((await run).released).toEqual([OLD, OLD_STANDBY]);
    expect(dropRetired.mock.calls.map(([stack]) => stack).sort()).toEqual(['prod', 'prod-b']);
  });

  it('an address that stays is never dropped from its stack', async () => {
    const { run, dropRetired } = release(
      { ingressIp: MASTER, floatingIp: OLD },
      { lookup: served([OLD]) },
    );
    expect((await run).released).toEqual([]);
    expect(dropRetired).not.toHaveBeenCalled();
  });

  it('without a way to open the stack, nothing is released', async () => {
    const s = store({ ingressIp: MASTER, floatingIp: OLD });
    const out = await releaseRetiredReservedIps({
      environment: 'prod',
      Provider: DigitalOceanProvider,
      provider: new DigitalOceanProvider('token'),
      log: logger(),
      domain: DOMAIN,
      dnsWrite: managed(),
      newAddress: MASTER,
      zoneRecordsAt: async () => [],
      lookup: (async () => served([MASTER])) as never,
      now: () => NOW,
      readConfig: s.readConfig,
      updateConfig: s.updateConfig,
    });
    expect(out.released).toEqual([]);
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
  });
});

describe("createDropRetired: the deploy's drop records what the surgery takes out", () => {
  // An environment-level address on k8s-ha names both side stacks, and each
  // side's surgery takes out every retired address that stack holds. The
  // other side's own address, recorded nowhere, has to land on that side's
  // record, or it leaves the stack with no record and is never released.
  it("k8s-ha, an environment-level address: the other side's own address is recorded on that side", async () => {
    deletesAnswer(204);
    const s = store({
      floatingIp: OLD,
      ha: {
        primary: { stack: 'prod', ingressIp: MASTER },
        standby: { stack: 'prod-standby', ingressIp: '198.51.100.8' },
      },
    });
    const held: Record<string, string[]> = { prod: [OLD], 'prod-standby': [OLD_STANDBY] };
    const opened: string[] = [];
    const dropRetired = createDropRetired({
      environment: 'prod',
      openStack: async (stackName: string) => {
        opened.push(stackName);
        return { name: stackName };
      },
      // dropRetiredStackResources's contract: the addresses it takes out go
      // to recordAddresses, when it is given one, before the import.
      drop: async (
        stack: { name: string },
        { recordAddresses }: { recordAddresses?: (a: string[]) => unknown } = {},
      ) => {
        await recordAddresses?.(held[stack.name]);
      },
      updateConfig: s.updateConfig,
    });
    const out = await releaseRetiredReservedIps({
      environment: 'prod',
      Provider: DigitalOceanProvider,
      provider: new DigitalOceanProvider('token'),
      log: logger(),
      domain: DOMAIN,
      dnsWrite: managed(),
      newAddress: MASTER,
      dropRetired,
      zoneRecordsAt: async () => [],
      lookup: (async () => served([MASTER])) as never,
      now: () => NOW,
      readConfig: s.readConfig,
      updateConfig: s.updateConfig,
    });
    expect(out.released).toEqual([OLD]);
    expect(opened).toEqual(['prod', 'prod-standby']);
    expect(s.config.environments.prod).toEqual({
      ha: {
        primary: { stack: 'prod', ingressIp: MASTER },
        // Out of its stack, onto its record: the next deploy releases it.
        standby: { stack: 'prod-standby', ingressIp: '198.51.100.8', floatingIp: OLD_STANDBY },
      },
    });
  });

  it('a stack that cannot be opened fails the drop, so nothing is released', async () => {
    const dropRetired = createDropRetired({
      environment: 'prod',
      openStack: async () => {
        throw new Error('no stack named prod');
      },
      drop: vi.fn(),
    });
    await expect(dropRetired('prod')).rejects.toThrow('no stack named prod');
  });
});

describe('releaseRetiredReservedIps: every A record in a managed zone', () => {
  it('a record the user added at the old address keeps it, and the warning names it', async () => {
    const zoneRecordsAt = vi.fn(async () => [`legacy.${DOMAIN}`]);
    const { s, log, run, dropRetired } = release(
      { ingressIp: MASTER, floatingIp: OLD },
      { zoneRecordsAt },
    );
    expect((await run).kept).toEqual([{ address: OLD, reason: 'zone-record' }]);
    expect(zoneRecordsAt).toHaveBeenCalledWith(OLD);
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
    expect(dropRetired).not.toHaveBeenCalled();
    expect(s.config.environments.prod).toHaveProperty('floatingIp', OLD);
    const [line] = log.warn.mock.calls[0];
    expect(line).toContain(`legacy.${DOMAIN} in ${DOMAIN}'s DNS zone still points at ${OLD}`);
    expect(line).toContain(`point it at ${MASTER}, or remove it`);
    expect(line).not.toContain('—');
  });

  it('while resolvers catch up too: the record is named rather than the wait', async () => {
    const { log, run } = release(
      { floatingIp: OLD },
      { dnsWrite: managed(20), zoneRecordsAt: async () => [DOMAIN, `old.${DOMAIN}`] },
    );
    expect((await run).kept).toEqual([{ address: OLD, reason: 'zone-record' }]);
    expect(log.warn.mock.calls[0][0]).toContain(`${DOMAIN} and old.${DOMAIN} in ${DOMAIN}'s`);
  });

  it('a zone it cannot list keeps it, saying so and what it costs', async () => {
    const { log, run } = release(
      { ingressIp: MASTER, floatingIp: OLD },
      {
        zoneRecordsAt: async () => {
          throw new Error('DigitalOcean DNS API error: Unable to authenticate you\nstack');
        },
      },
    );
    expect((await run).kept).toEqual([{ address: OLD, reason: 'unchecked' }]);
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
    const [line] = log.warn.mock.calls[0];
    expect(line).toContain(
      `could not list the A records in ${DOMAIN}'s DNS zone (DigitalOcean DNS API error: Unable to authenticate you)`,
    );
    expect(line).toContain('bills it whenever it is not assigned to a droplet');
  });

  it('managed DNS with no way to list the zone releases nothing', async () => {
    const { run } = release({ floatingIp: OLD }, { zoneRecordsAt: null });
    expect((await run).kept).toEqual([{ address: OLD, reason: 'unchecked' }]);
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
  });

  it('not asked with DNS kept by hand, nor when the nameservers already keep it', async () => {
    const byHand = release({ floatingIp: OLD }, { dnsWrite: null });
    await byHand.run;
    expect(byHand.zoneRecordsAt).not.toHaveBeenCalled();
    const answered = release({ floatingIp: OLD }, { lookup: served([OLD]) });
    await answered.run;
    expect(answered.zoneRecordsAt).not.toHaveBeenCalled();
  });
});

describe('zoneVerdict', () => {
  const release = { release: true, kind: 'release' } as const;
  it('no record at the address: the verdict stands', () => {
    expect(zoneVerdict(release, { ok: true, names: [] })).toBe(release);
  });
  it('a record at the address, or a listing that failed: keep', () => {
    expect(zoneVerdict(release, { ok: true, names: ['a.example.com'] })).toEqual({
      release: false,
      kind: 'zone-record',
      names: ['a.example.com'],
    });
    expect(zoneVerdict(release, { ok: false, reason: '403' })).toEqual({
      release: false,
      kind: 'unchecked',
      source: 'zone',
      reason: '403',
    });
  });
  it('a verdict that keeps it already passes through', () => {
    const kept = { release: false, kind: 'still-answered', names: [DOMAIN] } as const;
    expect(zoneVerdict(kept, { ok: false, reason: 'x' })).toBe(kept);
  });
});

describe('the lines say what was checked and what was not', () => {
  it('managed: the kept line names the apex, the wildcard and the zone, and what else must move', async () => {
    const { log, run } = release({ floatingIp: OLD }, { dnsWrite: managed(20) });
    await run;
    const [line] = log.info.mock.calls[0];
    expect(line).toContain(
      `vibecarbon checks ${DOMAIN} and *.${DOMAIN} at ${DOMAIN}'s nameservers, and every A record in its DNS zone`,
    );
    expect(line).toContain(`Anything else that points at ${OLD} has to move to ${MASTER} first`);
    expect(line).toContain('a record in another zone');
    expect(line).not.toContain('—');
  });

  it("by hand: no zone listing, and a proxy's or CDN's origin has to move too", async () => {
    const { log, run } = release({ floatingIp: OLD }, { dnsWrite: null });
    await run;
    const [line] = log.info.mock.calls[0];
    expect(line).toContain(
      `vibecarbon checks ${DOMAIN} and *.${DOMAIN} at ${DOMAIN}'s nameservers.`,
    );
    expect(line).not.toContain('every A record');
    expect(line).toContain(
      `the origin of a proxy or CDN in front of ${DOMAIN} (Cloudflare's orange cloud, say), which the nameservers do not show`,
    );
  });

  it('the release line names what was checked', async () => {
    deletesAnswer(204);
    const { log, run } = release({ floatingIp: OLD });
    await run;
    const [line] = log.info.mock.calls[0];
    expect(line).toContain(`released the reserved IP ${OLD}`);
    expect(line).toContain(
      `vibecarbon checked ${DOMAIN} and *.${DOMAIN} at ${DOMAIN}'s nameservers, and every A record in its DNS zone and none points at it`,
    );
    expect(line).toContain(`needs to point at ${MASTER} now`);
    expect(line).not.toContain('—');
  });

  it('not moved: names the nameservers that missed the new address and what they served', async () => {
    const lagging = served([MASTER]);
    lagging.answers[4].addresses = ['192.0.2.200'];
    const { log, run } = release({ floatingIp: OLD }, { lookup: lagging });
    expect((await run).kept).toEqual([{ address: OLD, reason: 'not-moved' }]);
    expect(log.info.mock.calls[0][0]).toContain(
      `do not answer ${MASTER} for every name yet (ns3.example.net (192.0.2.3) answered 192.0.2.200 for ${DOMAIN})`,
    );
  });
});

describe('retiredReservedIpStacks', () => {
  it('single k8s: the environment is the stack', () => {
    expect(retiredReservedIpStacks('prod', { floatingIp: OLD })).toEqual(
      new Map([[OLD, ['prod']]]),
    );
  });
  it('k8s-ha: each side by its .stack, else its role', () => {
    expect(
      retiredReservedIpStacks('prod', {
        ha: {
          primary: { stack: 'prod-standby', floatingIp: OLD },
          standby: { floatingIp: OLD_STANDBY },
        },
      }),
    ).toEqual(
      new Map([
        [OLD, ['prod-standby']],
        [OLD_STANDBY, ['prod-standby']],
      ]),
    );
    expect(
      retiredReservedIpStacks('prod', { ha: { primary: { floatingIp: OLD }, standby: {} } }),
    ).toEqual(new Map([[OLD, ['prod-primary']]]));
  });
  it('an environment-level address on k8s-ha could be either side', () => {
    expect(
      retiredReservedIpStacks('prod', {
        floatingIp: OLD,
        ha: { primary: { stack: 'prod' }, standby: { stack: 'prod-standby' } },
      }),
    ).toEqual(new Map([[OLD, ['prod', 'prod-standby']]]));
  });
});

describe('recordRetiredReservedIps', () => {
  const record = (env: Env | undefined, stackName: string, addresses = [OLD]) => {
    const config = { environments: env ? { prod: structuredClone(env) } : {} };
    recordRetiredReservedIps({
      environment: 'prod',
      stackName,
      addresses,
      updateConfig: (fn: (c: typeof config) => void) => fn(config),
    });
    return config.environments.prod as Env | undefined;
  };

  it('single k8s: onto the environment, where it names none', () => {
    expect(record({ ingressIp: MASTER }, 'prod')).toEqual({ ingressIp: MASTER, floatingIp: OLD });
    expect(record({ floatingIp: '203.0.113.50' }, 'prod')).toEqual({ floatingIp: '203.0.113.50' });
  });

  it('k8s-ha: onto the side whose stack it is, else by role', () => {
    expect(
      record({ ha: { primary: { stack: 'prod-standby' }, standby: { stack: 'prod' } } }, 'prod'),
    ).toEqual({
      ha: { primary: { stack: 'prod-standby' }, standby: { stack: 'prod', floatingIp: OLD } },
    });
    expect(record({ ha: { standby: { masterIp: MASTER } } }, 'prod-standby')).toEqual({
      ha: { standby: { masterIp: MASTER, floatingIp: OLD } },
    });
    // No side on record yet: one is made, carrying its stack.
    expect(record({ ha: {} }, 'prod-primary')).toEqual({
      ha: { primary: { stack: 'prod-primary', floatingIp: OLD } },
    });
  });

  it('a stack the environment does not own, or no environment: nothing written', () => {
    expect(record({ ingressIp: MASTER }, 'staging')).toEqual({ ingressIp: MASTER });
    expect(record(undefined, 'prod')).toBeUndefined();
    expect(record({ ingressIp: MASTER }, 'prod', [])).toEqual({ ingressIp: MASTER });
  });
});
