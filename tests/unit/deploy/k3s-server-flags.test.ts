import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { k3sServerFlags } from '../../_shared/k3s-server-flags.js';

const script = readFileSync('carbon/cloud-init/k3s/master-init.sh', 'utf8');
const VARS = {
  k3s_token: 'token',
  floating_ip: '10.0.1.1',
  PUBLIC_IP: '10.0.1.1',
  PRIVATE_IFACE: 'eth0',
};

describe('k3sServerFlags', () => {
  it('reads every flag of the install line, in order, and stops where it ends', () => {
    const flags = k3sServerFlags(script, VARS);
    expect(flags.slice(0, 3)).toEqual([
      '--disable-default-registry-endpoint',
      '--cluster-init',
      '--token',
    ]);
    expect(flags.at(-1)).toBe('--write-kubeconfig-mode=600');
    expect(flags).toEqual(expect.arrayContaining(['--flannel-backend=wireguard-native']));
    expect(flags).not.toContain('then');
    expect(flags).not.toContain('\\');
  });

  it('keeps the flags the mirror depends on, with their values', () => {
    const flags = k3sServerFlags(script, VARS);
    const flagValue = (flag: string) => flags[flags.indexOf(flag) + 1];
    expect(flagValue('--system-default-registry')).toBe('vibecarbon-system.invalid');
    expect(flagValue('--flannel-iface')).toBe('eth0');
    expect(flagValue('--node-ip')).toBe('10.0.1.1');
    expect(flags).toContain('--kubelet-arg=cloud-provider=external');
    expect(flags.filter((flag) => flag === '--tls-san')).toHaveLength(3);
  });

  describe('Linode scripts', () => {
    const LINODE_VARS = {
      k3s_token: 'token',
      k3s_version: 'v1',
      master_ip: '10.0.1.2',
      PUBLIC_IP: '203.0.113.9',
      PRIVATE_IP: '10.0.1.2',
      NODE_ID: '777',
    };
    const linode = (role: string) =>
      readFileSync(`carbon/cloud-init/k3s/linode-${role}-init.sh`, 'utf8');
    const flagArg = (flags: string[], flag: string) => flags[flags.indexOf(flag) + 1];

    it.each([
      ['master', 'server'],
      ['worker', 'agent'],
      ['db', 'agent'],
    ] as const)(
      '%s runs k3s on the VPC with a Linode provider-id and no cloud controller',
      (role, kind) => {
        const flags = k3sServerFlags(linode(role), LINODE_VARS, kind);
        expect(flagArg(flags, '--node-ip')).toBe('10.0.1.2');
        expect(flagArg(flags, '--node-external-ip')).toBe('203.0.113.9');
        expect(flagArg(flags, '--flannel-iface')).toBe('eth1');
        expect(flags).toContain('--kubelet-arg=provider-id=linode://777');
        expect(flags).not.toContain('--disable-cloud-controller');
        expect(flags).not.toContain('--kubelet-arg=cloud-provider=external');
      },
    );

    it('only the master advertises the private address and carries the mirror flags', () => {
      const flags = k3sServerFlags(linode('master'), LINODE_VARS);
      expect(flagArg(flags, '--advertise-address')).toBe('10.0.1.2');
      expect(flagArg(flags, '--system-default-registry')).toBe('vibecarbon-system.invalid');
      for (const role of ['worker', 'db']) {
        const agent = k3sServerFlags(linode(role), LINODE_VARS, 'agent');
        expect(agent).not.toContain('--advertise-address');
      }
    });
  });

  it('refuses a variable it was not given, so a new one cannot run as literal text', () => {
    const { PRIVATE_IFACE: _left, ...rest } = VARS;
    expect(() => k3sServerFlags(script, rest as never)).toThrow(/PRIVATE_IFACE/);
  });

  it('refuses a script with no install line', () => {
    expect(() => k3sServerFlags('echo hi\n', VARS)).toThrow(/no k3s server install line/);
  });
});
