import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The private-NIC wait loop of the Hetzner k3s init scripts, run against REAL
 * dhcpcd and a REAL DHCP server.
 *
 * The bug this pins: dhcpcd's ARP duplicate-address probe takes 6-7 s, so
 * `dhcpcd -1 -t 4` timed out before any lease could finish and every attempt
 * restarted from zero (5 of 5 failed on dhcpcd 10.0.6). `-1 -A -t 4` skips the
 * probe and leased in 0.1-1.8 s. The unit tests shim dhcpcd, which cannot see
 * this; only the real client can.
 *
 * One throwaway ubuntu:24.04 container (the Hetzner image family that ships
 * dhcpcd 10.0.6) holds a veth pair: `enp7s0` in the root namespace is the
 * private NIC, and its peer sits in a `srv` namespace where dnsmasq answers
 * DHCP the way Hetzner does (/32 address, classless static routes, mtu 1450).
 * No ports are published. The loop is cut out of the real init scripts, so
 * what runs is what ships.
 */
const shouldRunDocker = process.env.DOCKER_INTEGRATION === 'true';
const describeDocker = shouldRunDocker ? describe : describe.skip;

const ROOT = process.cwd();
const IMAGE = 'ubuntu:24.04';
const NAME = `vctest-dhcpwait-${process.pid}`;
const START = 'echo "Waiting for private network interface..."';
const END = 'echo "Private interface: $PRIVATE_IFACE"';

const docker = (args: string[], timeout = 120_000) =>
  execFileSync('docker', args, { encoding: 'utf-8', stdio: 'pipe', timeout });

function loopOf(file: string): string {
  const text = readFileSync(join(ROOT, 'carbon/cloud-init/k3s', file), 'utf-8');
  const from = text.indexOf(START);
  const to = text.indexOf(END);
  expect(from, `${file}: loop start`).toBeGreaterThan(-1);
  expect(to, `${file}: loop end`).toBeGreaterThan(from);
  return text.slice(from, to + END.length);
}

// dhcpcd writes per-interface sysctls, and a container mounts /proc/sys read-only.
const SETUP = `set -eu
mount -o remount,rw /proc/sys
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq dhcpcd-base iproute2 dnsmasq-base procps >/dev/null 2>&1
ip netns add srv
ip link add v0 type veth peer name enp7s0
ip link set v0 netns srv
ip netns exec srv ip addr add 10.0.0.1/8 dev v0
ip netns exec srv ip link set v0 up
ip netns exec srv ip link set lo up
ip netns exec srv dnsmasq --port=0 --interface=v0 \\
  --dhcp-range=10.0.1.10,10.0.1.200,255.0.0.0,86400 \\
  --dhcp-option=option:netmask,255.255.255.255 \\
  --dhcp-option=option:router,10.0.0.1 \\
  --dhcp-option=option:classless-static-route,10.0.0.1/32,0.0.0.0,10.0.0.0/8,10.0.0.1 \\
  --dhcp-option=option:mtu,1450 --dhcp-leasefile=/tmp/leases
`;

// A veth end is listed as `enp7s0@if4`; Hetzner's virtio NIC is listed as plain
// `enp7s0`. This wrapper drops the veth suffix from the link listing so the
// shipped loop sees the name it sees on Hetzner. Nothing else is altered.
const NIC_NAME = `ip() {
  if [ "$1 $2 $3" = "-o link show" ]; then command ip "$@" | sed 's,@[^:]*:,:,'; else command ip "$@"; fi
}
`;

// Back to a NIC with no lease and no client, between runs.
const RESET = `pkill dhcpcd 2>/dev/null || true
sleep 0.3
ip addr flush dev enp7s0
rm -f /var/lib/dhcpcd/*.lease*
ip link set enp7s0 down
`;

describeDocker('private-NIC wait loop against real dhcpcd', () => {
  let tmp = '';

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'vcdhcp-'));
    docker([
      'run',
      '-d',
      '--name',
      NAME,
      '--cap-add',
      'NET_ADMIN',
      '--cap-add',
      'SYS_ADMIN',
      '--security-opt',
      'apparmor=unconfined',
      IMAGE,
      'sleep',
      '3600',
    ]);
    writeFileSync(join(tmp, 'setup.sh'), SETUP);
    docker(['cp', join(tmp, 'setup.sh'), `${NAME}:/setup.sh`]);
    docker(['exec', NAME, 'bash', '/setup.sh'], 300_000);
  }, 360_000);

  afterAll(() => {
    try {
      docker(['rm', '-f', '-v', NAME]);
    } catch {
      // already gone
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  function runLoop(loop: string, maxRetries: number) {
    writeFileSync(join(tmp, 'reset.sh'), RESET);
    writeFileSync(
      join(tmp, 'loop.sh'),
      `set -euo pipefail\n${NIC_NAME}PRIVATE_IFACE=""\nRETRY_COUNT=0\nMAX_RETRIES=${maxRetries}\n${loop}\n`,
    );
    docker(['cp', join(tmp, 'reset.sh'), `${NAME}:/reset.sh`]);
    docker(['cp', join(tmp, 'loop.sh'), `${NAME}:/loop.sh`]);
    docker(['exec', NAME, 'bash', '/reset.sh']);
    const started = Date.now();
    let status = 0;
    let out = '';
    try {
      out = docker(['exec', NAME, 'bash', '/loop.sh'], 120_000);
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      status = err.status ?? 1;
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    const addr = docker(['exec', NAME, 'ip', '-4', '-o', 'addr', 'show', 'enp7s0']);
    return { status, out, addr, seconds: (Date.now() - started) / 1000 };
  }

  it.each(['master-init.sh', 'worker-init.sh', 'db-init.sh'])(
    '%s: leases the private address',
    (f) => {
      const r = runLoop(loopOf(f), 12);
      expect(r.out).toContain('Private interface: enp7s0');
      expect(r.out).not.toContain('FATAL');
      expect(r.addr).toMatch(/inet 10\.0\.1\.\d+/);
      expect(r.status).toBe(0);
    },
    150_000,
  );

  it('the old `dhcpcd -1 -t 4` never leases: the ARP probe outlasts the limit', () => {
    const loop = loopOf('worker-init.sh');
    const old = loop.replace('dhcpcd -1 -A -t 4', 'dhcpcd -1 -t 4');
    expect(old, 'the substitution found the command').not.toBe(loop);
    const r = runLoop(old, 4);
    expect(r.out).toContain('FATAL: Private network interface not found after 4 retries');
    expect(r.addr).not.toMatch(/inet 10\.0\./);
    expect(r.status).toBe(1);
  }, 150_000);
});
