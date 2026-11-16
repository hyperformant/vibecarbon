import { describe, expect, it, vi } from 'vitest';
import { listUpdateTargets } from '../../../src/lib/update/inventory.js';
import { DB_LABELS, MASTER_LABELS } from '../../_shared/fake-nodes.js';

type Node = { name: string; labels?: Record<string, string>; ip?: string };

const nodeList = (nodes: Node[]) =>
  JSON.stringify({
    items: nodes.map((n) => ({
      metadata: { name: n.name, labels: n.labels ?? {} },
      status: { addresses: n.ip ? [{ type: 'ExternalIP', address: n.ip }] : [] },
    })),
  });

describe('listUpdateTargets', () => {
  it('compose gives the one server, named master', async () => {
    const cfg = { deployMode: 'compose', servers: [{ name: 'master', ip: '1.1.1.1' }] };
    const r = await listUpdateTargets('prod', cfg, { sshKubectl: vi.fn() });
    expect(r.tier).toBe('compose');
    expect(r.targets).toEqual([
      { name: 'master', ip: '1.1.1.1', side: 'primary', role: 'server', kind: 'compose' },
    ]);
    expect(r.skipped).toEqual([]);
  });

  it('compose-ha gives primary and standby', async () => {
    const cfg = {
      deployMode: 'compose-ha',
      servers: [
        { name: 'p', ip: '1.1.1.1', role: 'primary' },
        { name: 's', ip: '2.2.2.2', role: 'standby' },
      ],
    };
    const r = await listUpdateTargets('prod', cfg, { sshKubectl: vi.fn() });
    expect(r.targets.map((t) => [t.name, t.side])).toEqual([
      ['p', 'primary'],
      ['s', 'standby'],
    ]);
  });

  it('k8s reads roles from node labels and the ip from ExternalIP', async () => {
    const sshKubectl = vi.fn().mockResolvedValue(
      nodeList([
        { name: 'm', labels: MASTER_LABELS, ip: '1.1.1.1' },
        { name: 'w', ip: '1.1.1.2' },
        { name: 'd', labels: DB_LABELS, ip: '1.1.1.3' },
      ]),
    );
    const cfg = { deployMode: 'kubernetes', servers: [{ name: 'master', ip: '1.1.1.1' }] };
    const r = await listUpdateTargets('prod', cfg, { sshKubectl });
    expect(r.tier).toBe('k8s');
    expect(r.targets.map((t) => [t.name, t.role, t.ip, t.masterIp, t.kind])).toEqual([
      ['m', 'master', '1.1.1.1', '1.1.1.1', 'k8s'],
      ['w', 'worker', '1.1.1.2', '1.1.1.1', 'k8s'],
      ['d', 'db', '1.1.1.3', '1.1.1.1', 'k8s'],
    ]);
    expect(sshKubectl).toHaveBeenCalledWith(
      '1.1.1.1',
      expect.any(String),
      ['get', 'nodes', '-o', 'json'],
      { timeout: 20_000 },
    );
  });

  it('a node without an ExternalIP is skipped', async () => {
    const sshKubectl = vi
      .fn()
      .mockResolvedValue(
        nodeList([{ name: 'm', labels: MASTER_LABELS, ip: '1.1.1.1' }, { name: 'w' }]),
      );
    const cfg = { deployMode: 'kubernetes', servers: [{ name: 'master', ip: '1.1.1.1' }] };
    const r = await listUpdateTargets('prod', cfg, { sshKubectl });
    expect(r.targets.map((t) => t.name)).toEqual(['m']);
    expect(r.skipped).toEqual([{ name: 'w', ip: null, reason: 'no public address' }]);
  });

  it('k8s-ha asks both masters and marks the sides', async () => {
    const sshKubectl = vi.fn(async (ip: string) =>
      nodeList([{ name: `m-${ip}`, labels: MASTER_LABELS, ip }]),
    );
    const cfg = {
      deployMode: 'kubernetes',
      ha: { enabled: true, primary: { masterIp: '1.1.1.1' }, standby: { masterIp: '2.2.2.2' } },
      servers: [
        { name: 'a', ip: '1.1.1.1', role: 'primary' },
        { name: 'b', ip: '2.2.2.2', role: 'standby' },
      ],
    };
    const r = await listUpdateTargets('prod', cfg, { sshKubectl });
    expect(r.tier).toBe('k8s-ha');
    expect(sshKubectl.mock.calls.map((c) => c[0])).toEqual(['1.1.1.1', '2.2.2.2']);
    expect(r.targets.map((t) => [t.ip, t.side, t.masterIp])).toEqual([
      ['1.1.1.1', 'primary', '1.1.1.1'],
      ['2.2.2.2', 'standby', '2.2.2.2'],
    ]);
  });

  it('a master that cannot be read skips its whole cluster, naming the master', async () => {
    const sshKubectl = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { timedOut: true }));
    const cfg = { deployMode: 'kubernetes', servers: [{ name: 'master', ip: '1.1.1.1' }] };
    const r = await listUpdateTargets('prod', cfg, { sshKubectl });
    expect(r.targets).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toBe('could not list nodes through 1.1.1.1: ssh timeout');
  });

  it('a compose or compose-ha entry with no ip is skipped, not omitted', async () => {
    const compose = await listUpdateTargets(
      'prod',
      { deployMode: 'compose', servers: [{ name: 'master' }] },
      { sshKubectl: vi.fn() },
    );
    expect(compose.targets).toEqual([]);
    expect(compose.skipped).toEqual([{ name: 'master', ip: null, reason: 'no public address' }]);
    const ha = await listUpdateTargets(
      'prod',
      {
        deployMode: 'compose-ha',
        servers: [
          { name: 'p', ip: '1.1.1.1', role: 'primary' },
          { name: 's', role: 'standby' },
        ],
      },
      { sshKubectl: vi.fn() },
    );
    expect(ha.targets.map((t) => t.name)).toEqual(['p']);
    expect(ha.skipped).toEqual([{ name: 's', ip: null, reason: 'no public address' }]);
  });
});
