/**
 * carbon/cloud-init/k3s/_vultr-metadata.sh, the node identity every Vultr k8s
 * boot script includes, run under bash with a fake metadata service (`curl`)
 * and a fake kernel (`ip`). Vultr's cloud-init configures the private (VPC)
 * interface from metadata, but its kernel name and its place in the
 * interfaces list are not pinned, so the include matches interfaces by
 * network-type and takes the kernel interface that holds the VPC address.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRepoFile } from '../../_shared/source-files.js';
import { createTempDir } from '../../_shared/temp-dir.js';

const INCLUDE = readRepoFile('carbon/cloud-init/k3s/_vultr-metadata.sh');
const UUID = '6a3b5f0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const PUBLIC = { 'network-type': 'public', ipv4: { address: '203.0.113.10' } };
const PRIVATE = { 'network-type': 'private', ipv4: { address: '10.130.5.3' } };

type Kernel = { iface: string; cidr: string }[];

let tmp = '';
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = '';
});

/**
 * Run the include under the boot scripts' shell options, then print what it
 * set. `metadata` is the /v1.json body, or null for a service that never
 * answers (curl -f exits 22).
 */
function run(metadata: object | null, kernel: Kernel) {
  tmp = createTempDir('vc-vultr-metadata-');
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  const shim = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const json = join(tmp, 'v1.json');
  if (metadata) writeFileSync(json, JSON.stringify(metadata));
  shim('curl', metadata ? `cat ${json}` : 'exit 22');
  const lines = kernel.map(
    ({ iface, cidr }, i) =>
      `${i + 1}: ${iface}    inet ${cidr} brd 10.255.255.255 scope global ${iface}\\       valid_lft forever preferred_lft forever`,
  );
  shim('ip', `[ "$*" = "-o -4 addr show" ] || exit 1\ncat <<'EOF'\n${lines.join('\n')}\nEOF`);
  // The interface wait loop sleeps between passes; the test does not.
  shim('sleep', 'exit 0');
  const script = `set -euo pipefail\n${INCLUDE}\necho "$PUBLIC_IP $PRIVATE_IP $PRIVATE_IFACE $NODE_ID"\n`;
  const r = spawnSync('bash', ['-c', script], {
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

const KERNEL: Kernel = [
  { iface: 'lo', cidr: '127.0.0.1/8' },
  { iface: 'enp1s0', cidr: '203.0.113.10/23' },
  { iface: 'enp8s0', cidr: '10.130.5.3/24' },
];

describe('_vultr-metadata.sh (executed)', () => {
  it('public first, private second: exports the five values', () => {
    const r = run(
      { 'instance-v2-id': UUID, hostname: 'acme-prod-master', interfaces: [PUBLIC, PRIVATE] },
      KERNEL,
    );
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`203.0.113.10 10.130.5.3 enp8s0 ${UUID}`);
  });

  it('private listed first: still matched by network-type', () => {
    const r = run(
      { 'instance-v2-id': UUID, hostname: 'acme-prod-master', interfaces: [PRIVATE, PUBLIC] },
      KERNEL,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`203.0.113.10 10.130.5.3 enp8s0 ${UUID}`);
  });

  it('no private interface: FATAL, exit 1', () => {
    const r = run(
      { 'instance-v2-id': UUID, hostname: 'acme-prod-master', interfaces: [PUBLIC] },
      KERNEL,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FATAL: no private (VPC) address in Vultr metadata');
    expect(r.stdout).toBe('');
  });

  it('private address on no kernel interface: FATAL', () => {
    const r = run(
      { 'instance-v2-id': UUID, hostname: 'acme-prod-master', interfaces: [PUBLIC, PRIVATE] },
      KERNEL.filter(({ iface }) => iface !== 'enp8s0'),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FATAL: no interface holds the VPC address 10.130.5.3');
    expect(r.stdout).toBe('');
  });

  it('metadata never answers: FATAL on the public address', () => {
    const r = run(null, KERNEL);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FATAL: no public address in Vultr metadata');
    expect(r.stdout).toBe('');
  });
});
