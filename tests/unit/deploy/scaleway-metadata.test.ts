/**
 * carbon/cloud-init/k3s/_scaleway-metadata.sh, the node identity every
 * Scaleway k8s boot script includes, run under bash on a fake host
 * (tests/_shared/scaleway-host.ts): a fake metadata service (`curl`), a fake
 * kernel (`ip`) and the include's system roots moved into a temp directory.
 *
 * Scaleway's metadata says nothing about the Private Network NIC, so the
 * include finds it by its MAC prefix 02:00:00, waits for it (Pulumi attaches
 * it after power-on), and writes a start-time script that finds it again
 * before every k3s start, because its name can change across a reboot
 * (Review Focus 5).
 */
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Nic,
  PUBLIC_NIC,
  SCALEWAY_SYSTEM_ROOTS,
  type ScalewayHost,
  scalewayHost,
} from '../../_shared/scaleway-host.js';
import { readRepoFile } from '../../_shared/source-files.js';

const INCLUDE = readRepoFile('carbon/cloud-init/k3s/_scaleway-metadata.sh');
const UUID = '6a3b5f0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const METADATA = {
  id: UUID,
  hostname: 'acme-prod-master',
  location: { zone_id: 'fr-par-1' },
  public_ip: { address: '203.0.113.10' },
  public_ips_v4: [{ address: '203.0.113.10' }],
};
const PN_NIC: Nic = { name: 'ens5', mac: '02:00:00:aa:bb:cc', cidr: '10.130.5.3/24' };
const DROP_IN = '/etc/systemd/system/k3s-agent.service.d/10-flannel-iface.conf';
const FLANNEL_IFACE = '/etc/rancher/k3s/config.yaml.d/50-flannel-iface.yaml';
const START_SCRIPT = '/usr/local/sbin/vc-flannel-iface';

let host: ScalewayHost | undefined;
afterEach(() => {
  host?.cleanup();
  host = undefined;
});

/**
 * Run the include as a k3s agent's boot script does (K3S_UNIT set first),
 * then print the six values it sets.
 */
function run(metadata: object | string | null, nics: Nic[]) {
  host = scalewayHost('vc-scaleway-metadata-');
  host.setMetadata(metadata);
  host.setNics(nics);
  return host.run(
    `set -euo pipefail\nK3S_UNIT=k3s-agent\n${host.sandbox(INCLUDE)}\n` +
      'echo "$PUBLIC_IP $PRIVATE_IP $PRIVATE_IFACE $NODE_ID $NODE_ZONE $NODE_NAME"\n',
  );
}

describe('_scaleway-metadata.sh (executed)', () => {
  it('the sandbox moves every system root the include writes', () => {
    for (const root of SCALEWAY_SYSTEM_ROOTS) {
      expect(INCLUDE).toContain(root);
    }
    const sandboxed = scalewayHost('vc-scaleway-sandbox-');
    try {
      expect(() => sandboxed.sandbox('mkdir -p /etc/ssh/sshd_config.d\n')).toThrow(/\/etc\/ssh/);
    } finally {
      sandboxed.cleanup();
    }
  });

  it('exports the six values', () => {
    const r = run(METADATA, [PUBLIC_NIC, PN_NIC]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`203.0.113.10 10.130.5.3 ens5 ${UUID} fr-par-1 acme-prod-master`);
  });

  it('falls back to public_ip.address when public_ips_v4 is empty', () => {
    const r = run({ ...METADATA, public_ips_v4: [] }, [PUBLIC_NIC, PN_NIC]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`203.0.113.10 10.130.5.3 ens5 ${UUID} fr-par-1 acme-prod-master`);
  });

  it('a NIC attached after boot starts is found on a later pass', () => {
    host = scalewayHost('vc-scaleway-metadata-');
    host.setMetadata(METADATA);
    host.setNics([PUBLIC_NIC]);
    host.attachAfterFirstSleep([PUBLIC_NIC, PN_NIC]);
    const r = host.run(
      `set -euo pipefail\nK3S_UNIT=k3s-agent\n${host.sandbox(INCLUDE)}\necho "$PRIVATE_IFACE $PRIVATE_IP"\n`,
    );
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('ens5 10.130.5.3');
  });

  it('no 02:00:00 NIC: FATAL after the wait', () => {
    const r = run(METADATA, [PUBLIC_NIC]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'FATAL: no single Private Network interface (MAC 02:00:00:...) with an address after 180 s',
    );
    expect(r.stdout).toBe('');
    // 90 passes, two seconds apart on a real host.
    expect(host?.linkReads()).toBe(90);
  });

  it('two 02:00:00 NICs: FATAL', () => {
    const second: Nic = { name: 'ens6', mac: '02:00:00:dd:ee:ff', cidr: '10.140.0.4/24' };
    const r = run(METADATA, [PUBLIC_NIC, PN_NIC, second]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FATAL: no single Private Network interface');
    expect(r.stdout).toBe('');
  });

  it('the NIC holds no IPv4 yet: FATAL', () => {
    const r = run(METADATA, [PUBLIC_NIC, { ...PN_NIC, cidr: undefined }]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FATAL: no single Private Network interface');
    expect(r.stdout).toBe('');
  });

  it('metadata never answers: FATAL on the public address', () => {
    const r = run(null, [PUBLIC_NIC, PN_NIC]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FATAL: no public address in Scaleway metadata');
    expect(r.stdout).toBe('');
  });

  it.each([
    ['no server id', { ...METADATA, id: undefined }, 'FATAL: no server id in Scaleway metadata'],
    ['no zone', { ...METADATA, location: {} }, 'FATAL: no zone in Scaleway metadata'],
    [
      'no public address at all',
      { ...METADATA, public_ip: null, public_ips_v4: [] },
      'FATAL: no public address in Scaleway metadata',
    ],
  ])('%s: FATAL, so no node joins without its identity', (_what, metadata, fatal) => {
    const r = run(metadata, [PUBLIC_NIC, PN_NIC]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(fatal);
    expect(r.stdout).toBe('');
  });

  // A body that is not a JSON object stops on the first check.
  it.each([
    ['a JSON array', '[]'],
    ['not JSON', '<html>502 Bad Gateway</html>'],
  ])('%s body: FATAL on the public address', (_what, body) => {
    const r = run(body, [PUBLIC_NIC, PN_NIC]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FATAL: no public address in Scaleway metadata');
  });

  it('the drop-in names the unit and the start-time script', () => {
    const r = run(METADATA, [PUBLIC_NIC, PN_NIC]);
    expect(r.status).toBe(0);
    expect(host?.read(DROP_IN)).toBe(`[Service]\nExecStartPre=${START_SCRIPT}\n`);
    expect(existsSync(host?.path('/etc/systemd/system/k3s.service.d') ?? '')).toBe(false);
    // The boot ran the start-time script once already, before k3s installs.
    expect(host?.read(FLANNEL_IFACE)).toBe('flannel-iface: ens5\n');
  });

  it('vc-flannel-iface finds the NIC by MAC after a rename', () => {
    const r = run(METADATA, [PUBLIC_NIC, PN_NIC]);
    expect(r.status).toBe(0);
    // A reboot: the kernel names the same Private Network NIC ens6.
    host?.setNics([PUBLIC_NIC, { ...PN_NIC, name: 'ens6' }]);
    const start = host?.runFile(START_SCRIPT);
    expect(start?.stderr).toBe('');
    expect(start?.status).toBe(0);
    expect(host?.read(FLANNEL_IFACE)).toBe('flannel-iface: ens6\n');
  });

  it('vc-flannel-iface stops k3s from starting when the NIC is gone', () => {
    const r = run(METADATA, [PUBLIC_NIC, PN_NIC]);
    expect(r.status).toBe(0);
    host?.setNics([PUBLIC_NIC]);
    const start = host?.runFile(START_SCRIPT);
    expect(start?.status).toBe(1);
    expect(start?.stderr).toContain('FATAL: no Private Network interface');
    // The last good name stays; ExecStartPre failing keeps k3s down.
    expect(host?.read(FLANNEL_IFACE)).toBe('flannel-iface: ens5\n');
  });
});
