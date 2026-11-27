/**
 * A server that never registered is probed from its own k3s server at the
 * join deadline (node-join-probe.js): ping and port 22 on its private and
 * public addresses, and the k3s server's ARP entry for the private one.
 *
 * Vultr run 45956890734 (2026-11-27 08:16Z): the k8s-ha standby's database
 * node never answered ssh and never registered while Vultr said it was
 * running. The provider's view cannot tell a server that never booted from
 * one whose public network is broken, and the rig is destroyed at teardown,
 * so the facts that do are read on the failure path.
 *
 * The probe script runs on the remote k3s server only. Here `run` is faked,
 * and the one test that runs the script text does so under stub `ping`, `ip`
 * and `timeout` in a temp dir, with nothing else on PATH but `sed`, `awk`
 * and `cat`: nothing reaches this machine's network.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLUSTER_PROBE_BUDGET_MS,
  clusterProbe,
  clusterProbeScript,
  parseProbeOutput,
  probeSentence,
} from '../../../src/lib/deploy/k8s/node-join-probe.js';
import { cleanupAllTempDirs, createTempDir } from '../../_shared/temp-dir.js';

const DASHES = /[–—]/;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await cleanupAllTempDirs();
});

type Result = ReturnType<typeof parseProbeOutput>[number];
const priv = (o: Partial<Result>): Result => ({
  kind: 'private',
  address: '10.1.96.4',
  pings: 0,
  port22: 'timeout',
  neighbour: null,
  ...o,
});
const pub = (o: Partial<Result>): Result => ({
  kind: 'public',
  address: '137.220.58.74',
  pings: 0,
  port22: 'timeout',
  neighbour: null,
  ...o,
});

describe('clusterProbeScript', () => {
  it('probes every address at once, each as its own job, and waits for all', () => {
    const script = clusterProbeScript([
      { kind: 'private', address: '10.1.96.4' },
      { kind: 'public', address: '137.220.58.74' },
    ]);
    expect(script).toContain("probe private '10.1.96.4' &");
    expect(script).toContain("probe public '137.220.58.74' &");
    expect(script.trim().split('\n').at(-1)).toBe('wait');
    expect(script).toContain('ping -c 2 -W 2 -q "$addr"');
    expect(script).toContain(`timeout 3 bash -c 'exec 3<>"/dev/tcp/$1/22"' probe "$addr"`);
    expect(script).toContain('ip neigh show "$addr"');
  });

  it('refuses an address that is not an IPv4 literal: nothing else reaches the shell text', () => {
    expect(() => clusterProbeScript([{ kind: 'public', address: '1.2.3.4; reboot' }])).toThrow(
      /not an IPv4 address/,
    );
    expect(() => clusterProbeScript([{ kind: 'weird' as 'public', address: '1.2.3.4' }])).toThrow(
      /kind/,
    );
  });
});

/** The real binary for a local text tool, for the stub PATH. */
function realBinary(name: string): string {
  for (const dir of String(process.env.PATH).split(delimiter)) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  throw new Error(`no ${name} on PATH`);
}

function stub(dir: string, name: string, body: string) {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}`);
  chmodSync(join(dir, name), 0o755);
}

describe('the probe script, run under stub ping, ip and timeout (never the real network)', () => {
  it('reads the replies, the port 22 outcome and the ARP state the way the k3s server reports them', () => {
    const dir = createTempDir('vc-probe-stub-');
    for (const tool of ['sed', 'awk', 'cat']) symlinkSync(realBinary(tool), join(dir, tool));
    // iputils-ping's summary; a missing answer file is a ping that cannot run.
    stub(
      dir,
      'ping',
      `for a; do addr=$a; done
echo "ping $*" >> "$STUB/calls"
f="$STUB/ping-$addr"
if [ ! -f "$f" ]; then echo "ping: connect: Network is unreachable" >&2; exit 2; fi
read -r n < "$f"
echo "PING $addr ($addr) 56(84) bytes of data."
echo "--- $addr ping statistics ---"
if [ "$n" = 0 ]; then echo "2 packets transmitted, 0 received, +2 errors, 100% packet loss, time 1001ms"; exit 1; fi
echo "2 packets transmitted, $n received, 0% packet loss, time 1001ms"
`,
    );
    // Never runs its command: it answers as bash's /dev/tcp connect would.
    stub(
      dir,
      'timeout',
      `for a; do addr=$a; done
echo "timeout $*" >> "$STUB/calls"
what=timeout
[ -f "$STUB/tcp-$addr" ] && read -r what < "$STUB/tcp-$addr"
case $what in
  open) exit 0 ;;
  refused) echo "bash: connect: Connection refused" >&2; echo "bash: line 1: /dev/tcp/$addr/22: Connection refused" >&2; exit 1 ;;
  noroute) echo "bash: connect: No route to host" >&2; exit 1 ;;
  *) exit 124 ;;
esac
`,
    );
    stub(
      dir,
      'ip',
      `echo "ip $*" >> "$STUB/calls"
[ "$1 $2" = "neigh show" ] || { echo "stub ip: unexpected $*" >&2; exit 2; }
[ -f "$STUB/neigh-$3" ] && cat "$STUB/neigh-$3"
exit 0
`,
    );
    const answers: Record<string, string> = {
      'ping-10.0.1.3': '2',
      'tcp-10.0.1.3': 'open',
      'neigh-10.0.1.3': '10.0.1.3 dev enp8s0 lladdr 5a:01:02:03:04:05 REACHABLE',
      'ping-10.0.1.4': '0',
      'tcp-10.0.1.4': 'noroute',
      'neigh-10.0.1.4': '10.0.1.4 dev enp8s0 FAILED',
      'ping-10.0.1.5': '0',
      'tcp-203.0.113.9': 'refused',
    };
    for (const [f, v] of Object.entries(answers)) writeFileSync(join(dir, f), `${v}\n`);

    const script = clusterProbeScript([
      { kind: 'private', address: '10.0.1.3' },
      { kind: 'private', address: '10.0.1.4' },
      { kind: 'private', address: '10.0.1.5' },
      { kind: 'public', address: '203.0.113.9' },
    ]);
    const out = execFileSync('/bin/sh', ['-s'], {
      input: script,
      env: { PATH: dir, STUB: dir },
      encoding: 'utf-8',
    });
    const byAddress = Object.fromEntries(parseProbeOutput(out).map((r) => [r.address, r]));
    expect(byAddress).toEqual({
      '10.0.1.3': {
        kind: 'private',
        address: '10.0.1.3',
        pings: 2,
        port22: 'open',
        neighbour: 'REACHABLE',
      },
      '10.0.1.4': {
        kind: 'private',
        address: '10.0.1.4',
        pings: 0,
        port22: 'unreachable',
        neighbour: 'FAILED',
      },
      '10.0.1.5': {
        kind: 'private',
        address: '10.0.1.5',
        pings: 0,
        port22: 'timeout',
        neighbour: null,
      },
      '203.0.113.9': {
        kind: 'public',
        address: '203.0.113.9',
        pings: null,
        port22: 'refused',
        neighbour: null,
      },
    });
    const calls = readFileSync(join(dir, 'calls'), 'utf-8');
    expect(calls).toContain('ping -c 2 -W 2 -q 10.0.1.3');
    expect(calls).toContain('timeout 3 bash -c exec 3<>"/dev/tcp/$1/22" probe 10.0.1.4');
    expect(calls).toContain('ip neigh show 10.0.1.4');
    // ARP is read for the private address only.
    expect(calls).not.toContain('ip neigh show 203.0.113.9');
  });
});

describe('parseProbeOutput', () => {
  it('reads only well-formed probe lines', () => {
    expect(
      parseProbeOutput(
        [
          'Warning: Permanently added 10.0.0.9 to the list of known hosts.',
          'probe private 10.0.1.3 ping=1 tcp22=refused neigh=STALE',
          'probe public 1.2.3.4 ping=error tcp22=error neigh=-',
          'probe public 1.2.3.4; reboot ping=2 tcp22=open neigh=-',
          'probe private 10.0.1.4 ping=0 tcp22=bogus neigh=none',
        ].join('\n'),
      ),
    ).toEqual([
      { kind: 'private', address: '10.0.1.3', pings: 1, port22: 'refused', neighbour: 'STALE' },
      { kind: 'public', address: '1.2.3.4', pings: null, port22: 'error', neighbour: null },
    ]);
  });
});

describe('probeSentence: what the facts say, and only that', () => {
  const say = (p: { priv?: Result; pub?: Result }) =>
    probeSentence({ ...p, providerName: 'Vultr' });

  it('the private address answers: the server is up, so its public network or its boot is the problem', () => {
    expect(say({ priv: priv({ pings: 2, port22: 'open' }), pub: pub({}) })).toBe(
      'From the k3s server, its private address 10.1.96.4 answers (2 of 2 pings came back and ' +
        'port 22 is open), so the server is up: its public network or its boot is the problem.',
    );
    // A refused connection is the guest's own kernel answering.
    expect(say({ priv: priv({ port22: 'refused', neighbour: 'REACHABLE' }) })).toBe(
      'From the k3s server, its private address 10.1.96.4 answers (no ping came back, port 22 ' +
        'refused the connection and ARP for it is REACHABLE), so the server is up: its public ' +
        'network or its boot is the problem.',
    );
  });

  it('no answer and ARP incomplete or failed: nothing on the private network holds that address', () => {
    expect(say({ priv: priv({ port22: 'unreachable', neighbour: 'INCOMPLETE' }) })).toBe(
      'From the k3s server, its private address 10.1.96.4 does not answer (no ping came back, ' +
        'there is no route to it and ARP for it is INCOMPLETE): nothing on the private network ' +
        'holds that address, so the server never brought up its network or never booted.',
    );
    expect(say({ priv: priv({ neighbour: 'FAILED' }) })).toMatch(/nothing on the private network/);
  });

  it('no answer and no ARP entry (a routed network, as on Hetzner): the firewall admits it, so it is not up there', () => {
    expect(say({ priv: priv({}), pub: pub({}) })).toBe(
      'From the k3s server, its private address 10.1.96.4 does not answer (no ping came back and ' +
        'port 22 gave no answer in 3s), though the cluster firewall lets ping and port 22 through ' +
        'there, so the server never booted or never brought up its private network.',
    );
  });

  it('no answer though ARP resolves: a machine holds the address, but nothing on it answers', () => {
    expect(say({ priv: priv({ neighbour: 'STALE' }) })).toBe(
      'From the k3s server, its private address 10.1.96.4 does not answer (no ping came back, ' +
        'port 22 gave no answer in 3s and ARP for it is STALE), though the cluster firewall lets ' +
        'ping and port 22 through there: a machine holds the address, but nothing on it answers.',
    );
  });

  it('the public address answers and the private one does not: the private network is the problem', () => {
    expect(say({ priv: priv({ neighbour: 'INCOMPLETE' }), pub: pub({ pings: 2 }) })).toBe(
      'From the k3s server, its public address 137.220.58.74 answers (2 of 2 pings came back and ' +
        'port 22 gave no answer in 3s) but its private address 10.1.96.4 does not (no ping came ' +
        'back, port 22 gave no answer in 3s and ARP for it is INCOMPLETE), so the server is up and ' +
        'its private network is the problem.',
    );
  });

  it('no private address: a silent public one is what the firewall does anyway, so it claims nothing', () => {
    expect(say({ pub: pub({}) })).toBe(
      'Vultr lists no private address for it, and its public address 137.220.58.74 does not ' +
        'answer the k3s server (no ping came back and port 22 gave no answer in 3s), which the ' +
        'cluster firewall would cause anyway (it drops ping there and admits port 22 only from ' +
        'the addresses `vibecarbon access` lists), so this cannot tell whether the server is up.',
    );
    expect(say({ pub: pub({ port22: 'refused' }) })).toBe(
      'Vultr lists no private address for it, and its public address 137.220.58.74 answers the ' +
        'k3s server (no ping came back and port 22 refused the connection), so the server is up.',
    );
    expect(say({})).toBeNull();
  });

  it('a check that could not run its tools shows nothing', () => {
    expect(say({ priv: priv({ pings: null, port22: 'error' }) })).toBe(
      'From the k3s server, the check of its private address 10.1.96.4 could not run (ping could ' +
        'not run and the port 22 check could not run), so it shows nothing.',
    );
  });

  it('every sentence keeps the CLI voice: no em or en dashes', () => {
    const results = [
      priv({}),
      priv({ pings: 2 }),
      priv({ neighbour: 'INCOMPLETE' }),
      priv({ neighbour: 'REACHABLE' }),
      priv({ pings: null, port22: 'error' }),
    ];
    for (const r of results) {
      for (const p of [undefined, pub({}), pub({ pings: 1 })]) {
        expect(say({ priv: r, pub: p }) ?? '').not.toMatch(DASHES);
        expect(say({ pub: p }) ?? '').not.toMatch(DASHES);
      }
    }
  });
});

describe('clusterProbe', () => {
  const db = { role: 'db' as const, ip: '137.220.58.74', state: 'unregistered' as const };
  const worker = { role: 'worker' as const, ip: '45.76.1.2', state: 'unregistered' as const };
  const master = { role: 'master' as const, ip: '45.76.9.9', state: 'unregistered' as const };
  const views = new Map<object, object>([
    [
      db,
      { name: 'p-civ4-standby-db', line: 'x', publicIp: '137.220.58.74', privateIp: '10.1.96.4' },
    ],
    [worker, { line: 'y', publicIp: '45.76.1.2', privateIp: null }],
  ]);

  it('one bounded run on the k3s server for every address, a log line each, and a sentence per node', async () => {
    const lines: string[] = [];
    const run = vi.fn(
      async (_script: string, _opts: { timeoutMs: number }) =>
        'probe private 10.1.96.4 ping=0 tcp22=timeout neigh=INCOMPLETE\n' +
        'probe public 137.220.58.74 ping=0 tcp22=timeout neigh=-\n' +
        'probe public 45.76.1.2 ping=0 tcp22=timeout neigh=-\n',
    );
    const probe = clusterProbe({ run, providerName: 'Vultr', log: (l) => lines.push(l) });
    const sentences = await probe([db, worker, master] as never, views as never);
    expect(run).toHaveBeenCalledTimes(1);
    const [script, opts] = run.mock.calls[0];
    expect(opts).toEqual({ timeoutMs: CLUSTER_PROBE_BUDGET_MS });
    expect(CLUSTER_PROBE_BUDGET_MS).toBe(20_000);
    // The k3s server is not probed from itself.
    expect(script).not.toContain('45.76.9.9');
    expect(script).toContain("probe private '10.1.96.4' &");
    expect(lines).toEqual([
      '[node-join] from the k3s server: the database node p-civ4-standby-db (137.220.58.74), ' +
        'private address 10.1.96.4: ping 0/2, port 22 timeout, neighbour INCOMPLETE',
      '[node-join] from the k3s server: the database node p-civ4-standby-db (137.220.58.74), ' +
        'public address 137.220.58.74: ping 0/2, port 22 timeout',
      '[node-join] from the k3s server: the worker at 45.76.1.2, public address 45.76.1.2: ' +
        'ping 0/2, port 22 timeout',
    ]);
    expect(sentences.get(db as never)).toMatch(
      /^From the k3s server, its private address 10\.1\.96\.4 does not answer .*never booted\.$/,
    );
    expect(sentences.get(worker as never)).toMatch(/^Vultr lists no private address for it/);
    expect(sentences.has(master as never)).toBe(false);
  });

  it("uses the deploy's recorded private address when the provider lists none, and says so", async () => {
    const lines: string[] = [];
    const recorded = { ...db, privateIp: '172.16.4.2' };
    const run = vi.fn(async () => 'probe private 172.16.4.2 ping=2 tcp22=open neigh=REACHABLE\n');
    const sentences = await clusterProbe({
      run,
      providerName: 'Scaleway',
      log: (l) => lines.push(l),
    })(
      [recorded] as never,
      new Map([[recorded, { line: 'x', publicIp: null, privateIp: null }]]) as never,
    );
    expect(lines[0]).toBe(
      '[node-join] from the k3s server: the database node at 137.220.58.74, private address ' +
        '172.16.4.2 (recorded by the deploy): ping 2/2, port 22 open, neighbour REACHABLE',
    );
    // No public address from the provider: the one the command waited on.
    expect(String(run.mock.calls[0][0])).toContain("probe public '137.220.58.74' &");
    expect(lines[1]).toContain('public address 137.220.58.74: the probe reported nothing');
    expect(sentences.get(recorded as never)).toMatch(/answers .* so the server is up/);
  });

  it('a run that fails is one log line and no sentence; it never throws', async () => {
    const lines: string[] = [];
    const err = Object.assign(
      new Error('Command failed: ssh -i /k/deploy_key root@45.76.9.9 sh -s'),
      {
        status: 255,
        stdout: '',
        stderr:
          'Warning: Permanently added 45.76.9.9 to the list of known hosts.\n' +
          'ssh: connect to host 45.76.9.9 port 22: Connection timed out\n',
      },
    );
    const sentences = await clusterProbe({
      run: async () => {
        throw err;
      },
      providerName: 'Vultr',
      log: (l) => lines.push(l),
    })([db] as never, views as never);
    expect(sentences.size).toBe(0);
    expect(lines).toEqual([
      '[node-join] could not probe from the k3s server: ssh: connect to host 45.76.9.9 port 22: Connection timed out',
    ]);
  });

  it('a run its bound stopped keeps what it printed, and says it stopped', async () => {
    const lines: string[] = [];
    const err = Object.assign(new Error('Command failed: ssh'), {
      timedOut: true,
      stdout: 'probe private 10.1.96.4 ping=0 tcp22=timeout neigh=INCOMPLETE\n',
      stderr: '',
    });
    const sentences = await clusterProbe({
      run: async () => {
        throw err;
      },
      providerName: 'Vultr',
      log: (l) => lines.push(l),
    })([db] as never, views as never);
    expect(lines).toEqual([
      expect.stringContaining(
        'private address 10.1.96.4: ping 0/2, port 22 timeout, neighbour INCOMPLETE',
      ),
      expect.stringContaining('public address 137.220.58.74: the probe reported nothing'),
      '[node-join] the probe from the k3s server stopped after 20s; what it had answered is above',
    ]);
    expect(sentences.get(db as never)).toMatch(/nothing on the private network holds that address/);
  });

  it('a run that never settles is stopped at its bound', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const done = clusterProbe({
      run: () => new Promise(() => {}),
      providerName: 'Vultr',
      log: (l) => lines.push(l),
    })([db] as never, views as never);
    await vi.advanceTimersByTimeAsync(CLUSTER_PROBE_BUDGET_MS + 5_000);
    expect((await done).size).toBe(0);
    expect(lines).toEqual([
      '[node-join] could not probe from the k3s server: it did not finish within 20s',
    ]);
  });

  it('a node with no address known is said once, and nothing runs', async () => {
    const lines: string[] = [];
    const run = vi.fn();
    const bare = { role: 'worker' as const, state: 'unregistered' as const };
    const sentences = await clusterProbe({ run, providerName: 'Vultr', log: (l) => lines.push(l) })(
      [bare] as never,
      new Map() as never,
    );
    expect(run).not.toHaveBeenCalled();
    expect(sentences.size).toBe(0);
    expect(lines).toEqual([
      '[node-join] nothing to probe from the k3s server: no address is known for a worker',
    ]);
  });

  it('an address that is not an IPv4 literal is never probed', async () => {
    const lines: string[] = [];
    const run = vi.fn(async () => '');
    const odd = { role: 'db' as const, ip: '1.2.3.4;reboot', state: 'unregistered' as const };
    await clusterProbe({ run, providerName: 'Vultr', log: (l) => lines.push(l) })(
      [odd] as never,
      new Map() as never,
    );
    expect(run).not.toHaveBeenCalled();
  });

  // Vultr reports main_ip 0.0.0.0 until it assigns one. A ping to it, or to a
  // loopback address, reaches the k3s server itself and would read as the
  // node answering.
  it('an unspecified or loopback address is never probed: it would answer from the k3s server itself', async () => {
    const lines: string[] = [];
    const run = vi.fn(async () => '');
    const placeholder = { role: 'db' as const, ip: '0.0.0.0', state: 'unregistered' as const };
    await clusterProbe({ run, providerName: 'Vultr', log: (l) => lines.push(l) })(
      [placeholder] as never,
      new Map([[placeholder, { line: 'x', publicIp: null, privateIp: '127.0.0.1' }]]) as never,
    );
    expect(run).not.toHaveBeenCalled();
    expect(lines).toEqual([
      '[node-join] nothing to probe from the k3s server: no address is known for the database node at 0.0.0.0',
    ]);
    expect(() => clusterProbeScript([{ kind: 'public', address: '0.0.0.0' }])).toThrow(
      /not an address the k3s server can probe/,
    );
  });
});
