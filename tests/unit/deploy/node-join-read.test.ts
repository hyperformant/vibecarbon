/**
 * A server that never registered, whose private address answered port 22 in
 * the probe from the k3s server, is read from the inside at the join
 * deadline: one ssh to its private address through the k3s server, bounded
 * at 25 s, for its boot marks, cloud-init's status, its interfaces and
 * default route, whether it reaches the internet, and its boot script's
 * failure lines (node-join-read.js).
 *
 * Vultr run 45994716507 (2026-11-27 14:21Z): the k8s-ha standby's database
 * node answered ping and port 22 on its VPC address from the k3s server, and
 * nothing on its public one, and never registered. Only the guest itself can
 * tell a public interface with no address or route from a provider network
 * that drops its traffic, or from a boot script that stopped for its own
 * reason, and the rig is destroyed at teardown.
 *
 * Here `run` and the ssh spawn are faked. The tests that run shell text do so
 * under stub `ip`, `curl`, `getent`, `timeout`, `cloud-init` and `networkctl`
 * (and a stub `ssh` for the ProxyCommand) in a temp dir, with nothing else on
 * PATH but local text tools: nothing reaches this machine's network.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  awaitNodesJoined,
  NODE_JOIN_BUDGET_MS,
  NodesNeverJoinedError,
} from '../../../src/lib/deploy/k8s/node-join.js';
import { clusterProbe } from '../../../src/lib/deploy/k8s/node-join-probe.js';
import {
  NODE_READ_BUDGET_MS,
  nodeRead,
  nodeReadArgv,
  nodeReadFacts,
  nodeReadOverSsh,
  nodeReadScript,
  nodeReadSentence,
  parseNodeRead,
  redactNodeRead,
} from '../../../src/lib/deploy/k8s/node-join-read.js';
import { buildHostKeyOptsForPath, SSH_MUX_DIR } from '../../../src/lib/host-keys.js';
import { cleanupAllTempDirs, createTempDir } from '../../_shared/temp-dir.js';

const DASHES = /[–—]/;
const PUBLIC = '66.42.120.170';
const PRIVATE = '10.159.218.4';
const MASTER = '45.32.5.6';
const TOKEN = 'a3f1c0de9b8e7d6c5b4a39281706f5e4d3c2b1a0918273645f6e7d8c9b0a1f2e';
const LABEL = 'the database node p-civ4-standby-db (66.42.120.170)';

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await cleanupAllTempDirs();
});

/** What the read prints on a node whose public network is set up and silent (the Vultr shape). */
const VULTR_SILENT = [
  'mark p',
  'mark n',
  'mark w',
  'mark k',
  'cloud-init running',
  'cloud-init-json {  "errors": [],  "extended_status": "running",  "status": "running"}',
  'link lo UNKNOWN 00:00:00:00:00:00 <LOOPBACK,UP,LOWER_UP>',
  'link enp1s0 UP 56:00:05:aa:bb:cc <BROADCAST,MULTICAST,UP,LOWER_UP>',
  'link enp6s0 UP 5a:00:05:aa:bb:cd <BROADCAST,MULTICAST,UP,LOWER_UP>',
  'addr lo UNKNOWN 127.0.0.1/8',
  `addr enp1s0 UP ${PUBLIC}/23`,
  `addr enp6s0 UP ${PRIVATE}/20`,
  `route default via 66.42.120.1 dev enp1s0 proto dhcp src ${PUBLIC} metric 100`,
  'networkctl 1 lo loopback carrier unmanaged',
  'networkctl 2 enp1s0 ether routable configured',
  'networkctl 3 enp6s0 ether routable configured',
  'log k3s database node install attempt 1 failed (likely transient GitHub/CDN issue), retrying in 20s...',
  'tcp443 timeout',
  'dns rc=0 3.33.1.1',
  'https rc=28 curl: (28) Connection timed out after 5002 milliseconds 000',
  'metadata rc=0 200',
  'read done',
].join('\n');

const facts = (text: string) => parseNodeRead(text);
const say = (text: string, publicIp: string | null = PUBLIC) =>
  nodeReadSentence(facts(text), { publicIp, privateIp: PRIVATE });

/** VULTR_SILENT with some lines swapped: each `[prefix, replacement]` replaces the lines that start with prefix. */
function variant(changes: Array<[string, string | string[]]>): string {
  let lines = VULTR_SILENT.split('\n');
  for (const [prefix, next] of changes) {
    const at = lines.findIndex((l) => l.startsWith(prefix));
    const rest = lines.filter((l) => !l.startsWith(prefix));
    const add = Array.isArray(next) ? next : next ? [next] : [];
    rest.splice(at < 0 ? rest.length : at, 0, ...add);
    lines = rest;
  }
  return lines.join('\n');
}

describe('nodeReadScript', () => {
  it('reads the named facts only, each outbound check under timeout, the metadata body never printed', () => {
    const script = nodeReadScript();
    expect(script).toContain("log='/var/log/vcboot'");
    expect(script).toContain("out='/var/log/cloud-init-output.log'");
    expect(script).toContain('ip -br -4 addr');
    expect(script).toContain('ip -4 route show default');
    expect(script).toContain('networkctl list --no-pager --no-legend');
    expect(script).toContain("timeout 3 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443'");
    expect(script).toContain('timeout 3 getent hosts get.k3s.io');
    expect(script).toContain(
      "timeout 6 curl -sS -o /dev/null -m 5 -w '%{http_code}' https://get.k3s.io",
    );
    expect(script).toContain(
      "timeout 3 curl -sS -o /dev/null -w '%{http_code}' http://169.254.169.254/",
    );
    expect(script).toContain(
      'grep -a -E \'install attempt|install failed|FATAL|ERROR|Warning: Master|curl:\' "$out" | tail -n 10',
    );
    // Nothing the read runs writes on the node, and nothing it runs talks on stderr.
    expect(script.split('\n')[0]).toBe('exec 2>/dev/null');
    expect(script).not.toMatch(/>\s*\/(tmp|var|etc)/);
    expect(script).not.toMatch(/\brm\b|\breboot\b|systemctl|k3s-agent|k3s-(un)?install|\bkill\b/);
  });
});

/** The real binary for a local text tool, for the stub PATH. */
function realBinary(name: string): string {
  for (const dir of String(process.env.PATH).split(delimiter)) {
    const p = join(dir, name);
    if (existsSync(p) && !dir.includes('no-real-ssh')) return p;
  }
  throw new Error(`no ${name} on PATH`);
}

function stub(dir: string, name: string, body: string) {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}`);
  chmodSync(join(dir, name), 0o755);
}

describe('the read script, run under stub tools (never the real network or this host)', () => {
  it('prints each fact on its own line the way the parser reads them', () => {
    const dir = createTempDir('vc-node-read-stub-');
    for (const tool of ['sed', 'awk', 'cat', 'grep', 'tail', 'tr', 'head']) {
      symlinkSync(realBinary(tool), join(dir, tool));
    }
    // A boot log and a cloud-init output log of our own: the script reads
    // the paths it is given, never this machine's /var/log.
    writeFileSync(
      join(dir, 'vcboot'),
      'p 1764253286.1\nn 1764253287.2\nw 1764253290.3\nk 1764253301.4\n',
    );
    writeFileSync(
      join(dir, 'cloud-init-output.log'),
      [
        'Installing k3s version: v1.37.2+k3s1',
        'curl: (28) Failed to connect to get.k3s.io port 443 after 120002 ms: Timeout was reached',
        'k3s database node install attempt 1 failed (likely transient GitHub/CDN issue), retrying in 20s...',
        'nothing to see here',
      ].join('\n'),
    );
    // Runs what it is given, except the TCP connect, which it answers as
    // bash's /dev/tcp would (and never runs bash).
    stub(
      dir,
      'timeout',
      `echo "timeout $*" >> "$STUB/calls"
shift
if [ "$1" = bash ]; then exit 124; fi
exec "$@"
`,
    );
    stub(
      dir,
      'ip',
      `echo "ip $*" >> "$STUB/calls"
case "$*" in
  "-br link") printf 'lo               UNKNOWN        00:00:00:00:00:00 <LOOPBACK,UP,LOWER_UP>\\nenp1s0           UP             56:00:05:aa:bb:cc <BROADCAST,MULTICAST,UP,LOWER_UP>\\nenp6s0           UP             5a:00:05:aa:bb:cd <BROADCAST,MULTICAST,UP,LOWER_UP>\\n' ;;
  "-br -4 addr") printf 'lo               UNKNOWN        127.0.0.1/8 \\nenp1s0           UP             66.42.120.170/23 \\nenp6s0           UP             10.159.218.4/20 \\n' ;;
  "-4 route show default") echo 'default via 66.42.120.1 dev enp1s0 proto dhcp src 66.42.120.170 metric 100' ;;
  *) echo "stub ip: unexpected $*" >&2; exit 2 ;;
esac
`,
    );
    stub(
      dir,
      'cloud-init',
      `echo "cloud-init $*" >> "$STUB/calls"
if [ "$2" = --format ]; then printf '{\\n  "errors": [],\\n  "extended_status": "running",\\n  "status": "running"\\n}\\n'; exit 0; fi
echo 'status: running'
`,
    );
    stub(
      dir,
      'networkctl',
      `echo "networkctl $*" >> "$STUB/calls"
echo '  1 lo     loopback carrier    unmanaged'
echo '  2 enp1s0 ether    routable    configured'
echo '  3 enp6s0 ether    routable    configured'
`,
    );
    stub(dir, 'getent', `echo "getent $*" >> "$STUB/calls"\necho '3.33.1.1        get.k3s.io'\n`);
    // curl as it fails: the error on stderr, the -w code on stdout last.
    stub(
      dir,
      'curl',
      `echo "curl $*" >> "$STUB/calls"
for a; do url=$a; done
case $url in
  https://get.k3s.io) echo 'curl: (28) Connection timed out after 5002 milliseconds' >&2; printf 000; exit 28 ;;
  http://169.254.169.254/) printf 200; exit 0 ;;
esac
exit 3
`,
    );

    const out = execFileSync('/bin/sh', ['-s'], {
      input: nodeReadScript({
        bootLog: join(dir, 'vcboot'),
        outputLog: join(dir, 'cloud-init-output.log'),
      }),
      env: { PATH: dir, STUB: dir },
      encoding: 'utf-8',
    });
    const f = parseNodeRead(out);
    expect(f.done).toBe(true);
    expect(f.marks).toEqual(['p', 'n', 'w', 'k']);
    expect(f.cloudInit).toEqual({ status: 'running', extended: 'running', errors: [] });
    expect(f.interfaces).toEqual([
      { name: 'lo', state: 'UNKNOWN', addrs: ['127.0.0.1/8'] },
      { name: 'enp1s0', state: 'UP', addrs: [`${PUBLIC}/23`] },
      { name: 'enp6s0', state: 'UP', addrs: [`${PRIVATE}/20`] },
    ]);
    expect(f.routes).toEqual([{ via: '66.42.120.1', dev: 'enp1s0' }]);
    expect(f.networkctl).toEqual([
      { link: 'lo', operational: 'carrier', setup: 'unmanaged' },
      { link: 'enp1s0', operational: 'routable', setup: 'configured' },
      { link: 'enp6s0', operational: 'routable', setup: 'configured' },
    ]);
    expect(f.tcp443).toBe('timeout');
    expect(f.dns).toEqual({ rc: 0, address: '3.33.1.1' });
    expect(f.https).toEqual({
      rc: 28,
      code: '000',
      error: 'curl: (28) Connection timed out after 5002 milliseconds',
    });
    expect(f.metadata).toEqual({ rc: 0, code: '200' });
    expect(f.outputLines).toEqual([
      'curl: (28) Failed to connect to get.k3s.io port 443 after 120002 ms: Timeout was reached',
      'k3s database node install attempt 1 failed (likely transient GitHub/CDN issue), retrying in 20s...',
    ]);
    const calls = readFileSync(join(dir, 'calls'), 'utf-8');
    expect(calls).toContain('timeout 3 bash -c exec 3<>/dev/tcp/1.1.1.1/443');
    expect(calls).toContain('timeout 3 getent hosts get.k3s.io');
    expect(calls).toContain(
      'timeout 6 curl -sS -o /dev/null -m 5 -w %{http_code} https://get.k3s.io',
    );
    expect(calls).toContain(
      'timeout 3 curl -sS -o /dev/null -w %{http_code} http://169.254.169.254/',
    );
    expect(calls).toContain('timeout 3 networkctl list --no-pager --no-legend');
  });

  it('says so when the boot log, cloud-init and networkctl are not there, and when there is no default route', () => {
    const dir = createTempDir('vc-node-read-stub-');
    for (const tool of ['sed', 'awk', 'cat', 'grep', 'tail', 'tr', 'head']) {
      symlinkSync(realBinary(tool), join(dir, tool));
    }
    stub(
      dir,
      'timeout',
      'shift\nif [ "$1" = bash ]; then echo "bash: connect: Network is unreachable" >&2; exit 1; fi\nexec "$@"\n',
    );
    stub(
      dir,
      'ip',
      `case "$*" in
  "-br link") echo 'enp1s0           UP             56:00:05:aa:bb:cc <BROADCAST,MULTICAST,UP,LOWER_UP>' ;;
  "-br -4 addr") : ;;
  "-4 route show default") : ;;
esac
`,
    );
    stub(dir, 'getent', 'exit 2\n');
    stub(
      dir,
      'curl',
      `echo 'curl: (6) Could not resolve host: get.k3s.io' >&2; printf 000; exit 6\n`,
    );
    const out = execFileSync('/bin/sh', ['-s'], {
      input: nodeReadScript({ bootLog: join(dir, 'none'), outputLog: join(dir, 'none.log') }),
      env: { PATH: dir },
      encoding: 'utf-8',
    });
    const f = parseNodeRead(out);
    expect(f.marks).toBeNull();
    expect(f.cloudInit).toBeNull();
    expect(f.networkctl).toBeNull();
    expect(f.interfaces).toEqual([{ name: 'enp1s0', state: 'UP', addrs: [] }]);
    expect(f.routes).toEqual([]);
    expect(f.tcp443).toBe('unreachable');
    expect(f.dns).toEqual({ rc: 2, address: null });
    expect(f.outputLines).toEqual([]);
  });
});

describe('parseNodeRead', () => {
  it('ignores what is not a fact line, and reads a curl code printed first', () => {
    const f = parseNodeRead(
      [
        "Warning: Permanently added '10.159.218.4' (ED25519) to the list of known hosts.",
        'mark p',
        'tcp443 bogus',
        'https rc=6 000curl: (6) Could not resolve host: get.k3s.io',
        'metadata rc=124 ',
        'something else entirely',
      ].join('\n'),
    );
    expect(f.done).toBe(false);
    expect(f.marks).toEqual(['p']);
    expect(f.tcp443).toBeUndefined();
    expect(f.https).toEqual({
      rc: 6,
      code: '000',
      error: 'curl: (6) Could not resolve host: get.k3s.io',
    });
    expect(f.metadata).toEqual({ rc: 124, code: null });
    // Unreported is not the same as reported missing.
    expect(f.routes).toBeUndefined();
    expect(f.cloudInit).toBeUndefined();
  });

  it('reads the cloud-init errors from the JSON form, and keeps the word when the JSON is unreadable', () => {
    expect(
      parseNodeRead(
        'cloud-init error\ncloud-init-json {"status": "error", "extended_status": "error", "errors": ["(\'scripts_user\', RuntimeError(\'Runparts: 1 failures (part-001) in 1 attempted commands\'))"]}',
      ).cloudInit,
    ).toEqual({
      status: 'error',
      extended: 'error',
      errors: [
        "('scripts_user', RuntimeError('Runparts: 1 failures (part-001) in 1 attempted commands'))",
      ],
    });
    expect(parseNodeRead('cloud-init done\ncloud-init-json {"status": "do').cloudInit).toEqual({
      status: 'done',
      errors: [],
    });
  });
});

describe('redactNodeRead: nothing secret reaches a log line', () => {
  it("replaces the cluster's k3s token and anything K10-shaped, and drops every password line", () => {
    const raw = [
      `log + K3S_TOKEN=${TOKEN} sh -s - agent`,
      `log token was ${TOKEN} here and ${TOKEN} again`,
      'log [INFO]  token K10f00dcafe0123456789abcdef0123456789abcdef::server:s3cr3tpart in use',
      'log chpasswd: root Password changed',
      'log the PASSWORD is hunter2',
      'mark k',
    ].join('\n');
    const out = redactNodeRead(raw, [TOKEN]);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toMatch(/K10[0-9a-f]{20,}/);
    expect(out).not.toContain('s3cr3tpart');
    expect(out).not.toMatch(/password/i);
    expect(out).not.toContain('hunter2');
    expect(out.split('\n')).toEqual([
      'log + K3S_TOKEN=<redacted> sh -s - agent',
      'log token was <redacted> here and <redacted> again',
      'log [INFO]  token <redacted> in use',
      'mark k',
    ]);
  });

  it('a missing or empty token redacts the patterns still', () => {
    expect(redactNodeRead('log K10abcdef0123456789abcdef0123 x', [undefined, ''])).toBe(
      'log <redacted> x',
    );
  });
});

describe('nodeReadSentence: one sentence, chosen from the facts and claiming no more', () => {
  it('the public address is on no interface: the guest never set it up', () => {
    expect(say(variant([[`addr enp1s0`, '']]))).toBe(
      `On the node itself, no interface holds its public address ${PUBLIC} (enp1s0 is UP with ` +
        'no IPv4 address), so the guest never set up its public address.',
    );
    expect(
      say(
        variant([
          ['link enp1s0', ''],
          ['addr enp1s0', ''],
        ]),
      ),
    ).toBe(
      `On the node itself, no interface holds its public address ${PUBLIC} (it has no interface ` +
        'but the private one), so the guest never set up its public address.',
    );
  });

  it('the address is there and there is no default route', () => {
    expect(say(variant([['route ', 'route none']]))).toBe(
      `On the node itself, enp1s0 holds ${PUBLIC} but there is no default IPv4 route, so it ` +
        'cannot reach the internet.',
    );
  });

  it('the default route goes via the private interface, or another one', () => {
    expect(say(variant([['route ', 'route default via 10.159.208.1 dev enp6s0 proto dhcp']]))).toBe(
      `On the node itself, enp1s0 holds ${PUBLIC} but the default route is via enp6s0, the ` +
        `private interface (${PRIVATE}), so its internet traffic goes out on the private network.`,
    );
    expect(say(variant([['route ', 'route default dev wg0 scope link']]))).toBe(
      `On the node itself, enp1s0 holds ${PUBLIC} but the default route is via wg0, not enp1s0, ` +
        'so its internet traffic does not leave by the public interface.',
    );
  });

  it('address and route are set up and nothing outside answers: the traffic is lost past the guest', () => {
    expect(say(VULTR_SILENT)).toBe(
      `On the node itself, enp1s0 holds ${PUBLIC} with the default route via 66.42.120.1 there, ` +
        'but it cannot reach the internet (a TCP connect to 1.1.1.1:443 got no answer in 3s, ' +
        'get.k3s.io resolves to 3.33.1.1 and https://get.k3s.io failed with curl: (28) Connection ' +
        'timed out after 5002 milliseconds), so its own network is set up and its traffic goes ' +
        'unanswered outside it.',
    );
  });

  it('without the public address to look for, it does not claim the network is set up', () => {
    expect(say(VULTR_SILENT, null)).toBe(
      'On the node itself, the default route is via 66.42.120.1 on enp1s0, but it cannot reach ' +
        'the internet (a TCP connect to 1.1.1.1:443 got no answer in 3s, get.k3s.io resolves to ' +
        '3.33.1.1 and https://get.k3s.io failed with curl: (28) Connection timed out after 5002 ' +
        'milliseconds).',
    );
  });

  it('it reaches the internet but get.k3s.io does not resolve, or does not answer', () => {
    expect(
      say(
        variant([
          ['tcp443', 'tcp443 open'],
          ['dns ', 'dns rc=2 '],
          ['https ', 'https rc=6 curl: (6) Could not resolve host: get.k3s.io 000'],
        ]),
      ),
    ).toBe(
      'On the node itself, it reaches the internet (a TCP connect to 1.1.1.1:443 opened) but ' +
        'get.k3s.io does not resolve (getent exit 2), so the k3s install cannot download.',
    );
    expect(
      say(
        variant([
          ['tcp443', 'tcp443 open'],
          ['https ', 'https rc=60 curl: (60) SSL certificate problem: certificate has expired 000'],
        ]),
      ),
    ).toBe(
      'On the node itself, it reaches the internet and get.k3s.io resolves to 3.33.1.1, but ' +
        'https://get.k3s.io failed with curl: (60) SSL certificate problem: certificate has ' +
        'expired, so the k3s install cannot download.',
    );
    expect(
      say(
        variant([
          ['tcp443', 'tcp443 open'],
          ['https ', 'https rc=0 503'],
        ]),
      ),
    ).toMatch(
      /but https:\/\/get\.k3s\.io answered HTTP 503, so the k3s install cannot download\.$/,
    );
  });

  const works: Array<[string, string | string[]]> = [
    ['tcp443', 'tcp443 open'],
    ['https ', 'https rc=0 200'],
  ];

  it('outbound works and the boot stopped after mark k, with its install failure line', () => {
    expect(
      say(
        variant([
          ...works,
          ['cloud-init ', 'cloud-init error'],
          ['cloud-init-json', ''],
          [
            'log ',
            [
              'log k3s database node install attempt 5 failed (likely transient GitHub/CDN issue), retrying in 20s...',
              'log k3s database node install failed after 5 attempts -- check GitHub CDN status',
            ],
          ],
        ]),
      ),
    ).toBe(
      'On the node itself, outbound works and the boot stopped after mark `k` (installing ' +
        'Kubernetes); its cloud-init output says "k3s database node install failed after 5 ' +
        'attempts -- check GitHub CDN status".',
    );
    // cloud-init still running: the boot has not stopped, it is still there.
    expect(say(variant([...works, ['log ', '']]))).toBe(
      'On the node itself, outbound works and the boot is still running after mark `k` ' +
        '(installing Kubernetes).',
    );
  });

  it('outbound works and the boot never reached mark k', () => {
    expect(
      say(
        variant([
          ...works,
          ['mark w', ''],
          ['mark k', ''],
          ['cloud-init ', 'cloud-init error'],
          ['cloud-init-json', ''],
          ['log ', 'log FATAL: Vultr hostname "Bad_Name" is not a valid Kubernetes node name'],
        ]),
      ),
    ).toBe(
      'On the node itself, outbound works and the boot never reached mark `k` (installing ' +
        'Kubernetes): its last mark is `n` (setting up the network); its cloud-init output says ' +
        '"FATAL: Vultr hostname "Bad_Name" is not a valid Kubernetes node name".',
    );
  });

  it('a boot still running, or one cloud-init did not report on, is not said to have stopped', () => {
    expect(say(variant([...works, ['mark w', ''], ['mark k', ''], ['log ', '']]))).toBe(
      'On the node itself, outbound works and the boot is still running and has not reached ' +
        'mark `k` (installing Kubernetes): its last mark is `n` (setting up the network).',
    );
    expect(
      say(variant([...works, ['cloud-init ', ''], ['cloud-init-json', ''], ['log ', '']])),
    ).toBe(
      'On the node itself, outbound works and the boot got as far as mark `k` (installing Kubernetes).',
    );
    expect(say(variant([...works, ['mark ', 'marks none'], ['log ', '']]))).toBe(
      'On the node itself, outbound works, but /var/log/vcboot holds no boot marks, so its boot ' +
        'script has not started; cloud-init says running.',
    );
  });

  it('outbound works and there are no boot marks: the boot script never started', () => {
    expect(
      say(
        variant([
          ...works,
          ['mark ', 'marks none'],
          ['log ', ''],
          ['cloud-init ', 'cloud-init error'],
          [
            'cloud-init-json',
            'cloud-init-json {"status": "error", "errors": ["(\'config-runcmd\', OSError(\'boom\'))"]}',
          ],
        ]),
      ),
    ).toBe(
      'On the node itself, outbound works, but /var/log/vcboot holds no boot marks, so its boot ' +
        "script never started; cloud-init says error (\"('config-runcmd', OSError('boom'))\").",
    );
  });

  it('outbound works and the boot finished: k3s installed, though the node never registered', () => {
    expect(say(variant([...works, ['mark k', ['mark k', 'mark e']], ['log ', '']]))).toBe(
      'On the node itself, outbound works and the boot finished (mark `e`), so the k3s install ' +
        'succeeded, though the node never registered.',
    );
  });

  it('with no public address to look for, it reads the route alone', () => {
    expect(say(variant([['route ', 'route none']]), null)).toBe(
      'On the node itself, there is no default IPv4 route, so it cannot reach the internet.',
    );
  });

  it('a read that stopped before its outbound checks says only what it read', () => {
    const cut = VULTR_SILENT.split('\n')
      .filter((l) => !/^(tcp443|dns|https|metadata|read done)/.test(l))
      .join('\n');
    expect(say(cut)).toBe(
      'On the node itself, the boot is still running after mark `k` (installing Kubernetes); its ' +
        'cloud-init output says "k3s database node install attempt 1 failed (likely transient ' +
        'GitHub/CDN issue), retrying in 20s...".',
    );
    expect(say('')).toBeNull();
  });

  it('every sentence keeps the CLI voice: no em or en dashes', () => {
    const texts = [
      VULTR_SILENT,
      variant([['addr enp1s0', '']]),
      variant([['route ', 'route none']]),
      variant([['route ', 'route default via 10.159.208.1 dev enp6s0']]),
      variant(works),
      variant([...works, ['mark ', 'marks none']]),
    ];
    for (const t of texts)
      for (const ip of [PUBLIC, null]) expect(say(t, ip) ?? '').not.toMatch(DASHES);
  });
});

describe('nodeReadFacts: one named fact a line, never a raw dump', () => {
  it('names each fact the read printed', () => {
    expect(nodeReadFacts(facts(VULTR_SILENT))).toEqual([
      'boot marks p n w k; the last is k, installing Kubernetes',
      'cloud-init status running',
      `interface enp1s0 UP, IPv4 ${PUBLIC}/23`,
      `interface enp6s0 UP, IPv4 ${PRIVATE}/20`,
      'default route via 66.42.120.1 dev enp1s0',
      'networkctl enp1s0: routable, configured',
      'networkctl enp6s0: routable, configured',
      'TCP connect to 1.1.1.1:443: no answer in 3s',
      'get.k3s.io resolves to 3.33.1.1',
      'https://get.k3s.io: curl: (28) Connection timed out after 5002 milliseconds',
      'metadata service http://169.254.169.254/: answered HTTP 200',
      'cloud-init output: k3s database node install attempt 1 failed (likely transient GitHub/CDN issue), retrying in 20s...',
    ]);
    expect(
      nodeReadFacts(
        facts(
          [
            'marks none',
            'cloud-init -',
            'cloud-init-json ',
            'link enp1s0 DOWN 56:00:05:aa:bb:cc <BROADCAST,MULTICAST>',
            'route none',
            'networkctl -',
            'tcp443 refused',
            'dns rc=124 ',
            'https rc=124 ',
            'metadata rc=7 000',
          ].join('\n'),
        ),
      ),
    ).toEqual([
      'boot marks: none (/var/log/vcboot is not there)',
      'cloud-init: not on this node',
      'interface enp1s0 DOWN, no IPv4 address',
      'no default IPv4 route',
      'networkctl: not on this node',
      'TCP connect to 1.1.1.1:443: refused',
      'get.k3s.io: no answer in 3s',
      'https://get.k3s.io: no answer in 6s',
      'metadata service http://169.254.169.254/: no answer (curl exit 7)',
    ]);
  });
});

describe('nodeReadArgv: one ssh to the private address, through the k3s server', () => {
  const keyPath = '/home/op/my project/.vibecarbon/deploy_key_prod';
  const khPath = '/home/op/my project/.vibecarbon/known_hosts_prod';
  const argvFor = (knownHostsFile = '/tmp/vc-node-read-x/known_hosts') =>
    nodeReadArgv({
      sshKeyPath: keyPath,
      hostKeyOpts: buildHostKeyOptsForPath(khPath),
      masterIp: MASTER,
      address: PRIVATE,
      knownHostsFile,
    });
  const opt = (argv: string[], name: string) =>
    argv.filter((a, i) => argv[i - 1] === '-o' && a.startsWith(`${name}=`));

  it("the inner hop pins into a throwaway known_hosts, never the env's, and never multiplexes", () => {
    const argv = argvFor();
    expect(argv[0]).toBe('ssh');
    expect(argv.slice(-3)).toEqual(['--', `root@${PRIVATE}`, 'sh -s']);
    expect(argv.slice(1, 3)).toEqual(['-i', keyPath]);
    expect(opt(argv, 'UserKnownHostsFile')).toEqual([
      'UserKnownHostsFile=/tmp/vc-node-read-x/known_hosts',
    ]);
    expect(opt(argv, 'StrictHostKeyChecking')).toEqual(['StrictHostKeyChecking=accept-new']);
    expect(opt(argv, 'GlobalKnownHostsFile')).toEqual(['GlobalKnownHostsFile=/dev/null']);
    expect(opt(argv, 'BatchMode')).toEqual(['BatchMode=yes']);
    expect(opt(argv, 'ConnectTimeout')).toEqual(['ConnectTimeout=10']);
    // VPC addresses repeat across clusters: a shared mux socket keyed on
    // root@10.x:22 could hand this read another cluster's server.
    expect(opt(argv, 'ControlMaster')).toEqual(['ControlMaster=no']);
    expect(opt(argv, 'ControlPath')).toEqual(['ControlPath=none']);
    expect(argv).not.toContain('-J');
    expect(argv.some((a) => /ProxyJump/.test(a))).toBe(false);
    expect(opt(argv, 'UserKnownHostsFile').join(' ')).not.toContain(khPath);
  });

  it("the outer hop is the command's own ssh to the k3s server: its key, known_hosts and options", () => {
    const [proxy] = opt(argvFor(), 'ProxyCommand');
    expect(proxy).toBe(
      `ProxyCommand='ssh' '-i' '${keyPath}' ${buildHostKeyOptsForPath(khPath)
        .map((t) => `'${t.replaceAll('%', '%%')}'`)
        .join(' ')} '-W' %h:%p 'root@${MASTER}'`,
    );
    // The mux socket path's own %C reaches the outer ssh as written.
    expect(proxy).toContain(`'ControlPath=${SSH_MUX_DIR}/%%C'`);
  });

  it('refuses an address that is not an IPv4 literal: %h reaches a shell', () => {
    expect(() =>
      nodeReadArgv({
        sshKeyPath: keyPath,
        hostKeyOpts: [],
        masterIp: MASTER,
        address: '10.0.0.1;reboot',
        knownHostsFile: '/x',
      }),
    ).toThrow(/not an IPv4 address/);
  });

  /**
   * What ssh does with a ProxyCommand: expand its % tokens (an unknown one is
   * fatal), then run `exec <command>` with $SHELL -c (sshconnect.c). Then the
   * command runs here under /bin/sh with a stub `ssh` first on PATH that
   * records the argv it got: the shell's word split is real, the hop is not.
   */
  function runProxyCommand(proxy: string, host: string, port: number): string[] {
    const expanded = proxy.replace(/%(.)/g, (_m, k: string) => {
      if (k === '%') return '%';
      if (k === 'h') return host;
      if (k === 'p') return String(port);
      if (k === 'r') return 'root';
      throw new Error(`percent_expand: unknown key %${k}`);
    });
    const dir = createTempDir('vc-node-read-proxy-');
    stub(dir, 'ssh', `for a; do printf '%s\\n' "$a"; done > "$STUB/argv"\n`);
    execFileSync('/bin/sh', ['-c', `exec ${expanded}`], { env: { PATH: dir, STUB: dir } });
    return readFileSync(join(dir, 'argv'), 'utf-8').split('\n').slice(0, -1);
  }

  it('the ProxyCommand text reaches the outer ssh as exactly its argv, spaces and % included', () => {
    const [proxy] = opt(argvFor(), 'ProxyCommand');
    expect(runProxyCommand(proxy.slice('ProxyCommand='.length), PRIVATE, 22)).toEqual([
      '-i',
      keyPath,
      ...buildHostKeyOptsForPath(khPath),
      '-W',
      `${PRIVATE}:22`,
      `root@${MASTER}`,
    ]);
  });
});

describe('nodeReadOverSsh: the run, with its throwaway known_hosts', () => {
  it('spawns the argv with the script on stdin, killed at its bound, and removes the known_hosts dir afterwards', async () => {
    let seen: { argv: string[]; opts: Record<string, unknown>; dirExisted: boolean } | null = null;
    const runArgv = vi.fn(async (argv: string[], opts: Record<string, unknown>) => {
      const file = String(
        argv.find((a, i) => argv[i - 1] === '-o' && a.startsWith('UserKnownHostsFile=')),
      ).slice('UserKnownHostsFile='.length);
      seen = { argv, opts, dirExisted: existsSync(dirname(file)) };
      // ssh writes the node's key there with accept-new.
      writeFileSync(file, `${PRIVATE} ssh-ed25519 AAAA\n`);
      (opts.onStdoutLine as (l: string) => void)?.('mark p');
      return 'mark p\n';
    });
    const run = nodeReadOverSsh({
      sshKeyPath: '/k/deploy_key_prod',
      hostKeyOpts: buildHostKeyOptsForPath('/k/known_hosts_prod'),
      masterIp: MASTER,
      runArgv,
    });
    const out = await run(PRIVATE, 'echo hi\n', { timeoutMs: 25_000 });
    expect(out).toBe('mark p\n');
    expect(runArgv).toHaveBeenCalledTimes(1);
    const { argv, opts, dirExisted } = seen as never;
    expect(dirExisted).toBe(true);
    const file = String(
      (argv as string[]).find(
        (a, i) => argv[i - 1] === '-o' && a.startsWith('UserKnownHostsFile='),
      ),
    ).slice('UserKnownHostsFile='.length);
    expect(file).toMatch(/vc-node-read-[^/]+\/known_hosts$/);
    expect(existsSync(dirname(file))).toBe(false);
    // The outer hop's own known_hosts rides in the ProxyCommand.
    expect((argv as string[]).find((a) => a.startsWith('ProxyCommand='))).toContain(
      "'UserKnownHostsFile=/k/known_hosts_prod'",
    );
    expect(opts).toMatchObject({
      silent: true,
      input: 'echo hi\n',
      timeout: 25_000,
      // A failed read's stdout is never echoed raw in CI: only redacted facts are logged.
      secret: true,
    });
    // ssh runs the ProxyCommand with $SHELL: a POSIX one, whatever the operator's is.
    expect((opts as { env: Record<string, string> }).env.SHELL).toBe('/bin/sh');
  });

  it('a run that fails or times out keeps what it printed, and still removes the dir', async () => {
    let file = '';
    const runArgv = vi.fn(async (argv: string[], opts: Record<string, unknown>) => {
      file = String(
        argv.find((a, i) => argv[i - 1] === '-o' && a.startsWith('UserKnownHostsFile=')),
      ).slice('UserKnownHostsFile='.length);
      const line = opts.onStdoutLine as (l: string) => void;
      line('mark p');
      line('mark n');
      throw Object.assign(new Error('Command failed: ssh ...'), {
        timedOut: true,
        status: null,
        stderr: 'Warning: Permanently added x\n',
      });
    });
    const err = await nodeReadOverSsh({
      sshKeyPath: '/k/deploy_key_prod',
      hostKeyOpts: [],
      masterIp: MASTER,
      runArgv,
    })(PRIVATE, 'x', { timeoutMs: 1000 }).catch((e) => e);
    expect(err.timedOut).toBe(true);
    expect(err.stdout).toBe('mark p\nmark n');
    expect(err.stderr).toBe('Warning: Permanently added x\n');
    expect(existsSync(dirname(file))).toBe(false);
  });
});

describe('nodeRead', () => {
  const node = { role: 'db' as const, ip: PUBLIC, state: 'unregistered' as const };
  const target = { node, label: LABEL, privateIp: PRIVATE, publicIp: PUBLIC };

  it('one bounded run per node, a log line per fact (redacted), and the sentence', async () => {
    const lines: string[] = [];
    const run = vi.fn(
      async (_a: string, _s: string, _o: { timeoutMs: number }) =>
        `${VULTR_SILENT}\nlog + K3S_TOKEN=${TOKEN} sh -s\nlog chpasswd: root password set\n`,
    );
    const sentences = await nodeRead({ run, secrets: [TOKEN], log: (l) => lines.push(l) })([
      target,
    ] as never);
    expect(run).toHaveBeenCalledTimes(1);
    const [address, script, opts] = run.mock.calls[0];
    expect(address).toBe(PRIVATE);
    expect(script).toBe(nodeReadScript());
    expect(opts).toEqual({ timeoutMs: NODE_READ_BUDGET_MS });
    expect(NODE_READ_BUDGET_MS).toBe(25_000);
    expect(lines[0]).toBe(
      `[node-join] on the node itself: ${LABEL}: boot marks p n w k; the last is k, installing Kubernetes`,
    );
    for (const l of lines)
      expect(l.startsWith(`[node-join] on the node itself: ${LABEL}: `)).toBe(true);
    expect(lines).toContain(
      `[node-join] on the node itself: ${LABEL}: cloud-init output: + K3S_TOKEN=<redacted> sh -s`,
    );
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(lines.join('\n')).not.toMatch(/password/i);
    expect(sentences.get(node as never)).toBe(say(VULTR_SILENT));
  });

  it('a read its bound stopped keeps what it printed, and says it stopped', async () => {
    const lines: string[] = [];
    const printed = VULTR_SILENT.split('\n').slice(0, 13).join('\n');
    const run = async () => {
      throw Object.assign(new Error('Command failed: ssh'), {
        timedOut: true,
        stdout: printed,
        stderr: '',
      });
    };
    const sentences = await nodeRead({ run, log: (l) => lines.push(l) })([target] as never);
    expect(lines.at(-1)).toBe(
      `[node-join] the read of ${LABEL} from the inside stopped after 25s; what it had printed is above`,
    );
    expect(lines).toContain(
      `[node-join] on the node itself: ${LABEL}: default route via 66.42.120.1 dev enp1s0`,
    );
    expect(sentences.get(node as never)).toBe(
      'On the node itself, the boot is still running after mark `k` (installing Kubernetes).',
    );
  });

  it('a read that fails is one log line, redacted, and no sentence; it never throws', async () => {
    const lines: string[] = [];
    const run = async () => {
      throw Object.assign(
        new Error('Command failed: ssh -i /k/deploy_key root@10.159.218.4 sh -s'),
        {
          status: 255,
          stdout: '',
          stderr: `Warning: Permanently added x\nchannel 0: open failed: connect failed: ${TOKEN}\n`,
        },
      );
    };
    const sentences = await nodeRead({ run, secrets: [TOKEN], log: (l) => lines.push(l) })([
      target,
    ] as never);
    expect(sentences.size).toBe(0);
    expect(lines).toEqual([
      `[node-join] could not read ${LABEL} from the inside: channel 0: open failed: connect failed: <redacted>`,
    ]);
  });

  it('a run that never settles is stopped at its bound', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const done = nodeRead({ run: () => new Promise(() => {}), log: (l) => lines.push(l) })([
      target,
    ] as never);
    await vi.advanceTimersByTimeAsync(NODE_READ_BUDGET_MS + 5_000);
    expect((await done).size).toBe(0);
    expect(lines).toEqual([
      `[node-join] could not read ${LABEL} from the inside: it did not finish within 25s`,
    ]);
  });

  it('never reads an address that is not an IPv4 literal', async () => {
    const run = vi.fn(async () => '');
    const lines: string[] = [];
    await nodeRead({ run, log: (l) => lines.push(l) })([
      { ...target, privateIp: '10.0.0.1;reboot' },
    ] as never);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('clusterProbe reads from the inside only the nodes whose private port 22 was open', () => {
  const db = { role: 'db' as const, ip: PUBLIC, state: 'unregistered' as const };
  const worker = { role: 'worker' as const, ip: '45.76.1.2', state: 'unregistered' as const };
  const lost = { role: 'worker' as const, ip: '45.76.1.3', state: 'unregistered' as const };
  const views = new Map<object, object>([
    [db, { name: 'p-civ4-standby-db', line: 'x', publicIp: PUBLIC, privateIp: PRIVATE }],
    [worker, { line: 'y', publicIp: '45.76.1.2', privateIp: '10.159.218.5' }],
    [lost, { line: 'z', publicIp: '45.76.1.3', privateIp: '10.159.218.6' }],
  ]);
  const probeOut = [
    `probe private ${PRIVATE} ping=2 tcp22=open neigh=DELAY`,
    `probe public ${PUBLIC} ping=0 tcp22=timeout neigh=-`,
    // Answers ping but port 22 refused: not read.
    'probe private 10.159.218.5 ping=2 tcp22=refused neigh=REACHABLE',
    'probe public 45.76.1.2 ping=0 tcp22=timeout neigh=-',
    // No result for 10.159.218.6 at all: not read.
  ].join('\n');

  it('reads the open one, appends its sentence, and leaves the others as the probe said', async () => {
    const readNode = vi.fn(
      async (targets: Array<{ node: object }>) =>
        new Map(targets.map((t) => [t.node, 'On the node itself, X.'])),
    );
    const sentences = await clusterProbe({
      run: async () => probeOut,
      providerName: 'Vultr',
      log: () => {},
      readNode,
    })([db, worker, lost] as never, views as never);
    expect(readNode).toHaveBeenCalledTimes(1);
    expect(readNode.mock.calls[0][0]).toEqual([
      {
        node: db,
        label: 'the database node p-civ4-standby-db (66.42.120.170)',
        privateIp: PRIVATE,
        publicIp: PUBLIC,
      },
    ]);
    expect(sentences.get(db as never)).toMatch(
      /^From the k3s server, its private address 10\.159\.218\.4 answers .* is the problem\. On the node itself, X\.$/,
    );
    expect(sentences.get(worker as never)).not.toContain('On the node itself');
    expect(sentences.get(lost as never)).not.toContain('On the node itself');
  });

  it('a probe that failed reads nothing', async () => {
    const readNode = vi.fn(async () => new Map());
    await clusterProbe({
      run: async () => {
        throw Object.assign(new Error('x'), {
          stderr: 'ssh: connect to host x port 22: Connection timed out',
        });
      },
      providerName: 'Vultr',
      log: () => {},
      readNode,
    })([db] as never, views as never);
    expect(readNode).not.toHaveBeenCalled();
  });

  it('a read that throws is one log line, and the probe sentence stands', async () => {
    const lines: string[] = [];
    const sentences = await clusterProbe({
      run: async () => probeOut,
      providerName: 'Vultr',
      log: (l) => lines.push(l),
      readNode: async () => {
        throw new Error('boom\nmore');
      },
    })([db] as never, views as never);
    expect(lines.at(-1)).toBe('[node-join] could not read from the inside: boom');
    expect(sentences.get(db as never)).toMatch(/is the problem\.$/);
  });
});

describe('a failing read changes nothing in the failure', () => {
  const DB_IP = PUBLIC;
  const expected = [
    { role: 'master' as const, ip: MASTER },
    { role: 'db' as const, ip: DB_IP },
  ];
  const nodeList = JSON.stringify({
    items: [
      {
        metadata: { name: 'p-master', labels: { 'node-role.kubernetes.io/control-plane': 'true' } },
        status: {
          addresses: [{ type: 'ExternalIP', address: MASTER }],
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      },
    ],
  });
  const views = async (missing: object[]) =>
    new Map(
      missing.map((n) => [
        n,
        { line: 'Vultr says it is ok.', publicIp: PUBLIC, privateIp: PRIVATE },
      ]),
    );
  const probeRun = async () =>
    `probe private ${PRIVATE} ping=2 tcp22=open neigh=DELAY\nprobe public ${PUBLIC} ping=0 tcp22=timeout neigh=-\n`;

  async function failure(readNode?: ReturnType<typeof nodeRead>) {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return awaitNodesJoined({
      expected,
      readNodes: async () => nodeList,
      deadline: Date.now(),
      budgetS: NODE_JOIN_BUDGET_MS / 1000,
      describeServers: views as never,
      probeFromCluster: clusterProbe({
        run: probeRun,
        providerName: 'Vultr',
        log: () => {},
        ...(readNode && { readNode }),
      }),
    }).catch((e) => e);
  }

  it('the NodesNeverJoinedError is the one the probe alone gives', async () => {
    const lines: string[] = [];
    const without = await failure();
    const withFailingRead = await failure(
      nodeRead({
        run: async () => {
          throw Object.assign(new Error('Command failed: ssh'), {
            status: 255,
            stdout: '',
            stderr: 'kex_exchange_identification: Connection closed by remote host\n',
          });
        },
        log: (l) => lines.push(l),
      }),
    );
    expect(without).toBeInstanceOf(NodesNeverJoinedError);
    expect(withFailingRead).toBeInstanceOf(NodesNeverJoinedError);
    expect(withFailingRead.message).toBe(without.message);
    expect(withFailingRead.missing).toEqual(without.missing);
    expect(lines).toEqual([
      `[node-join] could not read the database node at ${PUBLIC} from the inside: ` +
        'kex_exchange_identification: Connection closed by remote host',
    ]);
  });

  it('a read that works ends the node line with its sentence', async () => {
    const err = await failure(nodeRead({ run: async () => VULTR_SILENT, log: () => {} }));
    expect(err.message.split('\n')[0]).toMatch(
      /is the problem\. On the node itself, enp1s0 holds 66\.42\.120\.170 .* unanswered outside it\.$/,
    );
    expect(err.message).not.toMatch(DASHES);
  });
});
