import { describe, expect, it, vi } from 'vitest';
import { hostReporterScript } from '../../../src/lib/host-reporter.js';
import { HOST_STATE_ANNOTATION } from '../../../src/lib/host-state.js';
import { checkHostStates, hostStateRows } from '../../../src/lib/status/host-states.js';

const due = (host: string, since = '2026-11-15T03:12:00Z') => ({
  host,
  rebootRequired: true,
  since,
  packages: ['libc6', 'linux-image-6.8.0-90-generic'],
});
const clear = (host: string) => ({ host, rebootRequired: false, since: null, packages: [] });

describe('hostStateRows', () => {
  it('one due server reads in the singular, with the kernel package and a UTC date', () => {
    expect(
      hostStateRows('production', [{ name: 'master', reporting: true, state: due('master') }]),
    ).toEqual([
      {
        label: 'Restart due',
        text: 'master needs a restart for linux-image-6.8.0-90-generic (since Nov 15), run vibecarbon update production to install it',
      },
    ]);
  });

  it('the date is the UTC day, whatever the operator time zone', () => {
    const rows = hostStateRows('production', [
      { name: 'master', reporting: true, state: due('master', '2026-11-15T23:59:00Z') },
    ]);
    expect(rows[0].text).toContain('(since Nov 15)');
  });

  it('several due servers are listed and take the plural verb', () => {
    const rows = hostStateRows('production', [
      { name: 'master', reporting: true, state: due('master') },
      { name: 'worker-1', reporting: true, state: due('worker-1') },
      { name: 'worker-2', reporting: true, state: clear('worker-2') },
    ]);
    expect(rows).toEqual([
      {
        label: 'Restart due',
        text: 'master, worker-1 need a restart for linux-image-6.8.0-90-generic (since Nov 15), run vibecarbon update production to install it',
      },
    ]);
  });

  it('a server that is not reporting gets the Restart check row', () => {
    expect(
      hostStateRows('production', [
        { name: 'worker-1', reporting: false, state: null },
        { name: 'worker-2', reporting: false, state: null, error: 'ssh timeout' },
      ]),
    ).toEqual([
      {
        label: 'Restart check',
        text: 'worker-1, worker-2 not reporting yet, run vibecarbon update production once to set it up',
      },
    ]);
  });

  it('shows both rows when one server is due and another is silent', () => {
    const rows = hostStateRows('production', [
      { name: 'master', reporting: true, state: due('master') },
      { name: 'worker-1', reporting: false, state: null },
    ]);
    expect(rows.map((r) => r.label)).toEqual(['Restart due', 'Restart check']);
  });

  it('shows nothing when nothing is due and every server reports', () => {
    expect(
      hostStateRows('production', [{ name: 'master', reporting: true, state: clear('master') }]),
    ).toEqual([]);
    expect(hostStateRows('production', [])).toEqual([]);
  });
});

const KEY = __filename;
const node = (name: string, state?: object) => ({
  kind: 'Node',
  metadata: {
    name,
    annotations: state ? { [HOST_STATE_ANNOTATION]: JSON.stringify({ v: 1, ...state }) } : {},
  },
});

describe('checkHostStates', () => {
  it('compose: runs the reporter over ssh with --print, unretried, and parses it', async () => {
    const sshRun = vi.fn(async () => JSON.stringify({ v: 1, ...due('prod-1') }));
    const hosts = await checkHostStates(
      'production',
      { deployMode: 'compose', servers: [{ name: 'prod-1', ip: '1.1.1.1' }] },
      { sshRun, sshKeyPathFor: () => KEY, existsSync: () => true },
    );
    expect(sshRun).toHaveBeenCalledTimes(1);
    const [ip, key, argv, opts] = sshRun.mock.calls[0] as unknown as [
      string,
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(ip).toBe('1.1.1.1');
    expect(key).toBe(KEY);
    expect(argv).toEqual(['sh', '-s', '--', '--print']);
    expect(opts).toMatchObject({
      input: hostReporterScript(),
      timeout: 10_000,
      transportRetry: false,
    });
    expect(hosts).toEqual([{ name: 'prod-1', reporting: true, state: due('prod-1') }]);
  });

  it('compose: an unreachable or unparseable server is not reporting, never a throw', async () => {
    const sshRun = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('x'), { timedOut: true }))
      .mockResolvedValueOnce('not json');
    const hosts = await checkHostStates(
      'production',
      {
        deployMode: 'compose-ha',
        ha: { enabled: true },
        servers: [
          { name: 'a', ip: '1.1.1.1', role: 'primary' },
          { name: 'b', ip: '2.2.2.2', role: 'standby' },
        ],
      },
      { sshRun, sshKeyPathFor: () => KEY, existsSync: () => true },
    );
    expect(hosts.map((h) => [h.name, h.reporting, h.state])).toEqual([
      ['a', false, null],
      ['b', false, null],
    ]);
    expect(hosts[0].error).toBe('ssh timeout');
    expect(hosts[1].error).toBeTruthy();
  });

  it('k8s: reads only the shared snapshot, by node name, with no ssh call', async () => {
    const sshRun = vi.fn();
    const sshKubectl = vi.fn();
    const snapshots = {
      get: vi.fn(async () => ({
        nodes: [node('master', due('master')), node('worker-1')],
        pods: [],
        jobs: [],
      })),
    };
    const hosts = await checkHostStates(
      'production',
      { deployMode: 'kubernetes', servers: [{ name: 'prod-master', ip: '1.1.1.1' }] },
      { sshRun, sshKubectl, snapshots, sshKeyPathFor: () => KEY, existsSync: () => true },
    );
    expect(sshRun).not.toHaveBeenCalled();
    expect(sshKubectl).not.toHaveBeenCalled();
    expect(snapshots.get).toHaveBeenCalledWith('1.1.1.1');
    expect(hosts).toEqual([
      { name: 'master', reporting: true, state: due('master') },
      { name: 'worker-1', reporting: false, state: null },
    ]);
  });

  it('k8s-ha: reads both masters, and an unreadable standby is flagged, never clear', async () => {
    const snapshots = {
      get: vi.fn(async (ip: string) => {
        if (ip === '2.2.2.2') throw new Error('cluster snapshot failed: ssh timeout');
        return { nodes: [node('master', clear('master'))], pods: [], jobs: [] };
      }),
    };
    const hosts = await checkHostStates(
      'production',
      {
        deployMode: 'kubernetes-ha',
        ha: { enabled: true, primary: { masterIp: '1.1.1.1' }, standby: { masterIp: '2.2.2.2' } },
        servers: [
          { name: 'p', ip: '1.1.1.1', role: 'primary' },
          { name: 's', ip: '2.2.2.2', role: 'standby' },
        ],
      },
      { snapshots, sshKeyPathFor: () => KEY, existsSync: () => true },
    );
    expect(hosts).toEqual([
      { name: 'master', reporting: true, state: clear('master') },
      {
        name: 'standby cluster',
        reporting: false,
        state: null,
        error: 'standby cluster: could not read nodes',
      },
    ]);
    expect(hostStateRows('production', hosts).map((r) => r.label)).toEqual(['Restart check']);
  });

  it('no servers: nothing to check', async () => {
    expect(await checkHostStates('production', { deployMode: 'compose' }, {})).toEqual([]);
  });
});
