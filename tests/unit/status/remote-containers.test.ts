import { describe, expect, it, vi } from 'vitest';
import {
  checkRemoteContainers,
  classifyPod,
  nodeReadiness,
  planContainerTargets,
  podDisplayName,
  rowsFromPods,
} from '../../../src/lib/status/remote-containers.js';

describe('planContainerTargets', () => {
  it('compose: the single server, kind compose', () => {
    expect(
      planContainerTargets({ deployMode: 'compose', servers: [{ name: 'prod', ip: '1.1.1.1' }] }),
    ).toEqual([{ serverName: 'prod', ip: '1.1.1.1', kind: 'compose' }]);
  });

  // Shapes below are what the product writes, not invented ones:
  //   compose-ha (effects/compose-ha.js)   { name: '<proj>-<env>-primary', ip, role: 'primary' }
  //   compose-ha (orchestrator.js ~1452)   { name: 'primary', ip, region, serverType }   (no role)
  //   kubernetes-ha (orchestrator.js ~1440) { name: 'primary', ip, supabaseIp, region }  (no role)
  //                                        + ha.primary.masterIp / ha.standby.masterIp
  it('compose-ha (effects shape): role-tagged primary and standby, both compose', () => {
    expect(
      planContainerTargets({
        deployMode: 'compose-ha',
        servers: [
          { name: 'letsgo-prod-primary', id: 1, ip: '1.1.1.1', region: 'fsn1', role: 'primary' },
          { name: 'letsgo-prod-standby', id: 2, ip: '2.2.2.2', region: 'hel1', role: 'standby' },
        ],
      }),
    ).toEqual([
      { serverName: 'letsgo-prod-primary', ip: '1.1.1.1', kind: 'compose' },
      { serverName: 'letsgo-prod-standby', ip: '2.2.2.2', kind: 'compose' },
    ]);
  });

  it('compose-ha (orchestrator shape): name-only primary and standby', () => {
    expect(
      planContainerTargets({
        deployMode: 'compose-ha',
        ha: { enabled: true, failoverRegion: 'hel1' },
        servers: [
          { name: 'primary', ip: '1.1.1.1', region: 'fsn1', serverType: 'cpx31' },
          { name: 'standby', ip: '2.2.2.2', region: 'hel1', serverType: 'cpx31' },
        ],
      }),
    ).toEqual([
      { serverName: 'primary', ip: '1.1.1.1', kind: 'compose' },
      { serverName: 'standby', ip: '2.2.2.2', kind: 'compose' },
    ]);
  });

  it('compose-ha after failover: role wins over the (unchanged) name suffix', () => {
    // failoverComposeHA flips `role` in place and never renames (ha.js ~1831).
    expect(
      planContainerTargets({
        deployMode: 'compose-ha',
        servers: [
          { name: 'letsgo-prod-primary', ip: '1.1.1.1', role: 'standby' },
          { name: 'letsgo-prod-standby', ip: '2.2.2.2', role: 'primary' },
        ],
      }),
    ).toEqual([
      { serverName: 'letsgo-prod-standby', ip: '2.2.2.2', kind: 'compose' },
      { serverName: 'letsgo-prod-primary', ip: '1.1.1.1', kind: 'compose' },
    ]);
  });

  it('kubernetes: only the master, kind k8s; workers and supabase omitted', () => {
    expect(
      planContainerTargets({
        deployMode: 'kubernetes',
        servers: [
          { name: 'master', ip: '1.1.1.1', supabaseIp: '3.3.3.3', role: 'master' },
          { name: 'supabase', ip: '3.3.3.3', role: 'supabase' },
          { name: 'worker-1', ip: '4.4.4.4', role: 'worker' },
        ],
      }),
    ).toEqual([{ serverName: 'master', ip: '1.1.1.1', kind: 'k8s' }]);
  });

  it('kubernetes with no roles recorded: falls back to servers[0]', () => {
    expect(
      planContainerTargets({
        deployMode: 'kubernetes',
        servers: [{ name: 'prod', ip: '1.1.1.1' }],
      }),
    ).toEqual([{ serverName: 'prod', ip: '1.1.1.1', kind: 'k8s' }]);
  });

  it('kubernetes-ha: name-only primary and standby cluster masters, kind k8s', () => {
    expect(
      planContainerTargets({
        deployMode: 'kubernetes-ha',
        servers: [
          { name: 'primary', ip: '1.1.1.1', supabaseIp: '3.3.3.3', region: 'fsn1' },
          { name: 'standby', ip: '2.2.2.2', supabaseIp: '4.4.4.4', region: 'hel1' },
        ],
      }),
    ).toEqual([
      { serverName: 'primary', ip: '1.1.1.1', kind: 'k8s' },
      { serverName: 'standby', ip: '2.2.2.2', kind: 'k8s' },
    ]);
  });

  it('kubernetes-ha after failover: ha.primary.masterIp picks the promoted entry first', () => {
    // swapHaRoles (failover.js) swaps ha.primary/ha.standby, never servers[].
    expect(
      planContainerTargets({
        deployMode: 'kubernetes-ha',
        ha: {
          enabled: true,
          primary: { masterIp: '2.2.2.2', supabaseIp: '4.4.4.4', region: 'hel1' },
          standby: { masterIp: '1.1.1.1', supabaseIp: '3.3.3.3', region: 'fsn1' },
        },
        servers: [
          { name: 'primary', ip: '1.1.1.1', supabaseIp: '3.3.3.3', region: 'fsn1' },
          { name: 'standby', ip: '2.2.2.2', supabaseIp: '4.4.4.4', region: 'hel1' },
        ],
      }),
    ).toEqual([
      { serverName: 'standby', ip: '2.2.2.2', kind: 'k8s' },
      { serverName: 'primary', ip: '1.1.1.1', kind: 'k8s' },
    ]);
  });

  it('returns [] with no servers', () => {
    expect(planContainerTargets({ deployMode: 'compose', servers: [] })).toEqual([]);
    expect(planContainerTargets({ deployMode: 'compose' })).toEqual([]);
  });
});

// Minimal pod fixtures: only the fields classifyPod/rowsFromPods read.
const pod = (over: Record<string, unknown>) => ({
  metadata: {
    name: 'app-7d9f8b5c6-abcde',
    namespace: 'vibecarbon',
    ownerReferences: [{ kind: 'ReplicaSet', name: 'app-7d9f8b5c6' }],
  },
  status: {
    phase: 'Running',
    containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }],
  },
  ...over,
});

describe('classifyPod', () => {
  it('Running with every container ready → healthy', () => {
    expect(classifyPod(pod({}))).toEqual({ health: 'healthy', label: 'healthy', detail: '' });
  });

  it('Running with a container not ready and no waiting reason → starting with ready count', () => {
    const p = pod({
      status: {
        phase: 'Running',
        containerStatuses: [
          { ready: true, restartCount: 0, state: { running: {} } },
          { ready: false, restartCount: 0, state: { running: {} } },
        ],
      },
    });
    expect(classifyPod(p)).toEqual({ health: 'starting', label: 'starting', detail: 'ready 1/2' });
  });

  it('Running with no containerStatuses reported yet → starting, ready 0/0', () => {
    // kubelet has accepted the pod as Running but hasn't populated
    // containerStatuses yet — a brief kubelet-accepted-but-unreported window.
    const p = pod({
      status: {
        phase: 'Running',
        containerStatuses: [],
      },
    });
    expect(classifyPod(p)).toEqual({ health: 'starting', label: 'starting', detail: 'ready 0/0' });
  });

  it('a waiting reason becomes the label; restarts become the detail', () => {
    const p = pod({
      status: {
        phase: 'Running',
        containerStatuses: [
          { ready: false, restartCount: 12, state: { waiting: { reason: 'CrashLoopBackOff' } } },
        ],
      },
    });
    expect(classifyPod(p)).toEqual({
      health: 'unhealthy',
      label: 'CrashLoopBackOff',
      detail: 'restarts 12',
    });
  });

  it('ImagePullBackOff with zero restarts has an empty detail', () => {
    const p = pod({
      status: {
        phase: 'Pending',
        containerStatuses: [
          { ready: false, restartCount: 0, state: { waiting: { reason: 'ImagePullBackOff' } } },
        ],
      },
    });
    expect(classifyPod(p)).toEqual({ health: 'unhealthy', label: 'ImagePullBackOff', detail: '' });
  });

  it('ContainerCreating / PodInitializing / ErrImagePull are transient → starting', () => {
    for (const reason of ['ContainerCreating', 'PodInitializing', 'ErrImagePull']) {
      const p = pod({
        status: {
          phase: 'Pending',
          containerStatuses: [{ ready: false, restartCount: 0, state: { waiting: { reason } } }],
        },
      });
      expect(classifyPod(p)).toEqual({ health: 'starting', label: reason, detail: '' });
    }
  });

  it('a transient waiting reason still carries restarts in the detail', () => {
    const p = pod({
      status: {
        phase: 'Running',
        containerStatuses: [
          { ready: false, restartCount: 2, state: { waiting: { reason: 'PodInitializing' } } },
        ],
      },
    });
    expect(classifyPod(p)).toEqual({
      health: 'starting',
      label: 'PodInitializing',
      detail: 'restarts 2',
    });
  });

  it('Succeeded with a lingering waiting status → done', () => {
    const p = pod({
      status: {
        phase: 'Succeeded',
        containerStatuses: [
          { ready: false, restartCount: 0, state: { waiting: { reason: 'ContainerCreating' } } },
        ],
      },
    });
    expect(classifyPod(p)).toEqual({ health: 'done', label: 'done', detail: '' });
  });

  it('Pending without a waiting reason → starting/pending with the scheduling message', () => {
    const p = pod({
      status: {
        phase: 'Pending',
        conditions: [{ type: 'PodScheduled', status: 'False', message: '0/3 nodes are available' }],
      },
    });
    expect(classifyPod(p)).toEqual({
      health: 'starting',
      label: 'pending',
      detail: '0/3 nodes are available',
    });
  });

  it('Succeeded → done', () => {
    expect(classifyPod(pod({ status: { phase: 'Succeeded' } }))).toEqual({
      health: 'done',
      label: 'done',
      detail: '',
    });
  });

  it('Failed → unhealthy/failed with the terminated reason', () => {
    const p = pod({
      status: {
        phase: 'Failed',
        containerStatuses: [
          { ready: false, restartCount: 0, state: { terminated: { reason: 'Error' } } },
        ],
      },
    });
    expect(classifyPod(p)).toEqual({ health: 'unhealthy', label: 'failed', detail: 'Error' });
  });

  it('Unknown → unknown', () => {
    expect(classifyPod(pod({ status: { phase: 'Unknown' } }))).toEqual({
      health: 'unknown',
      label: 'unknown',
      detail: '',
    });
  });
});

describe('podDisplayName', () => {
  it('strips the ReplicaSet hash for Deployment pods', () => {
    expect(podDisplayName(pod({}))).toBe('app');
    expect(
      podDisplayName(
        pod({
          metadata: {
            name: 'supabase-kong-5f6d7c8b9-xyz12',
            namespace: 'vibecarbon',
            ownerReferences: [{ kind: 'ReplicaSet', name: 'supabase-kong-5f6d7c8b9' }],
          },
        }),
      ),
    ).toBe('supabase-kong');
  });

  it('keeps the ordinal for StatefulSet pods', () => {
    expect(
      podDisplayName(
        pod({
          metadata: {
            name: 'supabase-db-0',
            namespace: 'vibecarbon',
            ownerReferences: [{ kind: 'StatefulSet', name: 'supabase-db' }],
          },
        }),
      ),
    ).toBe('supabase-db-0');
  });

  it('falls back to the pod name with no owner', () => {
    expect(podDisplayName(pod({ metadata: { name: 'lonely', namespace: 'vibecarbon' } }))).toBe(
      'lonely',
    );
  });

  it('strips a real (non-hex) pod-template hash via the label', () => {
    const p = pod({
      metadata: {
        name: 'app-5b8f9c7dxz-q2w4r',
        namespace: 'vibecarbon',
        labels: { 'pod-template-hash': '5b8f9c7dxz' },
        ownerReferences: [{ kind: 'ReplicaSet', name: 'app-5b8f9c7dxz' }],
      },
    });
    expect(podDisplayName(p)).toBe('app');
  });

  it('strips a non-hex hash by alphabet when the label is missing', () => {
    const p = pod({
      metadata: {
        name: 'traefik-7xk9pq2mvs-abc',
        namespace: 'vibecarbon',
        ownerReferences: [{ kind: 'ReplicaSet', name: 'traefik-7xk9pq2mvs' }],
      },
    });
    expect(podDisplayName(p)).toBe('traefik');
  });

  it('does not strip a short non-hash suffix', () => {
    const p = pod({
      metadata: {
        name: 'web-abc-x',
        namespace: 'vibecarbon',
        ownerReferences: [{ kind: 'ReplicaSet', name: 'web-abc' }],
      },
    });
    expect(podDisplayName(p)).toBe('web-abc');
  });

  it('collapses the Helm release/chart double prefix for ReplicaSet-owned pods', () => {
    const p = pod({
      metadata: {
        name: 'supabase-supabase-kong-5b8f9c7dxz-q2w4r',
        namespace: 'vibecarbon',
        labels: { 'pod-template-hash': '5b8f9c7dxz' },
        ownerReferences: [{ kind: 'ReplicaSet', name: 'supabase-supabase-kong-5b8f9c7dxz' }],
      },
    });
    expect(podDisplayName(p)).toBe('supabase-kong');
  });

  it('collapses the Helm release/chart double prefix for StatefulSet-owned pods', () => {
    const p = pod({
      metadata: {
        name: 'supabase-supabase-db-0',
        namespace: 'vibecarbon',
        ownerReferences: [{ kind: 'StatefulSet', name: 'supabase-supabase-db' }],
      },
    });
    expect(podDisplayName(p)).toBe('supabase-db-0');
  });

  it('leaves a single supabase- prefix unchanged', () => {
    const p = pod({
      metadata: {
        name: 'supabase-db-0',
        namespace: 'vibecarbon',
        ownerReferences: [{ kind: 'StatefulSet', name: 'supabase-db' }],
      },
    });
    expect(podDisplayName(p)).toBe('supabase-db-0');
  });
});

describe('rowsFromPods', () => {
  const list = {
    items: [
      pod({}),
      pod({
        metadata: {
          name: 'supabase-db-0',
          namespace: 'vibecarbon',
          ownerReferences: [{ kind: 'StatefulSet', name: 'supabase-db' }],
        },
      }),
      pod({
        metadata: {
          name: 'supabase-realtime-9b7c2z-q',
          namespace: 'vibecarbon',
          ownerReferences: [{ kind: 'ReplicaSet', name: 'supabase-realtime-9b7c2z' }],
        },
        status: {
          phase: 'Running',
          containerStatuses: [
            { ready: false, restartCount: 12, state: { waiting: { reason: 'CrashLoopBackOff' } } },
          ],
        },
      }),
      pod({
        metadata: {
          name: 'source-controller-x',
          namespace: 'flux-system',
          ownerReferences: [{ kind: 'ReplicaSet', name: 'source-controller' }],
        },
      }),
      pod({
        metadata: {
          name: 'kustomize-controller-x',
          namespace: 'flux-system',
          ownerReferences: [{ kind: 'ReplicaSet', name: 'kustomize-controller' }],
        },
        status: { phase: 'Pending' },
      }),
      pod({ metadata: { name: 'cert-manager-x', namespace: 'cert-manager' } }),
      pod({
        metadata: { name: 'helm-install-traefik-abc', namespace: 'kube-system' },
        status: { phase: 'Succeeded' },
      }),
      pod({ metadata: { name: 'coredns-x', namespace: 'kube-system' } }),
    ],
  };

  it('puts vibecarbon-namespace pods in app rows, sorted by name, with the row shape', () => {
    const { app } = rowsFromPods(list);
    expect(app).toEqual([
      {
        name: 'app',
        container: 'app',
        health: 'healthy',
        label: 'healthy',
        detail: '',
        latencyMs: 0,
      },
      {
        name: 'supabase-db-0',
        container: 'supabase-db-0',
        health: 'healthy',
        label: 'healthy',
        detail: '',
        latencyMs: 0,
      },
      {
        name: 'supabase-realtime',
        container: 'supabase-realtime',
        health: 'unhealthy',
        label: 'CrashLoopBackOff',
        detail: 'restarts 12',
        latencyMs: 0,
      },
    ]);
  });

  it('rolls other namespaces up as healthy/total, excluding done pods from both', () => {
    const { platform } = rowsFromPods(list);
    expect(platform).toEqual({
      'flux-system': { healthy: 1, total: 2 },
      'cert-manager': { healthy: 1, total: 1 },
      'kube-system': { healthy: 1, total: 1 },
    });
  });

  it('handles an empty list', () => {
    expect(rowsFromPods({ items: [] })).toEqual({ app: [], platform: {} });
  });
});

describe('nodeReadiness', () => {
  it('counts Ready=True nodes over all nodes', () => {
    const nodes = {
      items: [
        { status: { conditions: [{ type: 'Ready', status: 'True' }] } },
        { status: { conditions: [{ type: 'Ready', status: 'False' }] } },
        { status: { conditions: [{ type: 'MemoryPressure', status: 'False' }] } },
      ],
    };
    expect(nodeReadiness(nodes)).toEqual({ ready: 1, total: 3 });
  });

  it('handles an empty list', () => {
    expect(nodeReadiness({ items: [] })).toEqual({ ready: 0, total: 0 });
  });
});

describe('checkRemoteContainers', () => {
  // effects/compose-ha.js shape, names shortened for the assertions below
  const composeHa = {
    deployMode: 'compose-ha',
    servers: [
      { name: 'p', id: 1, ip: '1.1.1.1', region: 'fsn1', role: 'primary' },
      { name: 's', id: 2, ip: '2.2.2.2', region: 'hel1', role: 'standby' },
    ],
  };
  const base = () => ({
    getSSHKeyPath: vi.fn(() => '/tmp/key'),
    existsSync: vi.fn(() => true),
    sshKubectl: vi.fn(async () => '{}'),
  });

  it('returns null with no project name or no servers', async () => {
    expect(await checkRemoteContainers('prod', composeHa, undefined, base())).toBeNull();
    expect(
      await checkRemoteContainers('prod', { deployMode: 'compose', servers: [] }, 'letsgo', base()),
    ).toBeNull();
  });

  it('reports "no ssh key" for every server without touching the network', async () => {
    const deps = { ...base(), existsSync: vi.fn(() => false), sshRun: vi.fn() };
    const out = await checkRemoteContainers('prod', composeHa, 'letsgo', deps);
    expect(out).toEqual({
      p: { kind: 'compose', ip: '1.1.1.1', rows: [], error: 'no ssh key' },
      s: { kind: 'compose', ip: '2.2.2.2', rows: [], error: 'no ssh key' },
    });
    expect(deps.sshRun).not.toHaveBeenCalled();
  });

  it('compose: runs docker ps -a per server and classifies rows', async () => {
    const sshRun = vi.fn(async (ip: string) =>
      ip === '1.1.1.1'
        ? 'letsgo-db\trunning\tUp 1h (healthy)\nletsgo-kong\trunning\tUp 1h (healthy)\n'
        : 'letsgo-db\trunning\tUp 1h (healthy)\nletsgo-kong\texited\tExited (128) 3 hours ago\n',
    );
    const out = await checkRemoteContainers('prod', composeHa, 'letsgo', { ...base(), sshRun });
    expect(sshRun).toHaveBeenCalledTimes(2);
    expect(sshRun.mock.calls[0][2]).toEqual([
      'docker',
      'ps',
      '-a',
      '--filter',
      'name=^letsgo-',
      '--format',
      '{{.Names}}\t{{.State}}\t{{.Status}}',
    ]);
    expect(sshRun.mock.calls[0][3]).toEqual({
      silent: true,
      timeout: 10_000,
      transportRetry: false,
    });
    expect(out).not.toBeNull();
    expect(out?.p).toEqual({
      kind: 'compose',
      ip: '1.1.1.1',
      rows: [
        {
          name: 'PostgreSQL',
          container: 'db',
          health: 'healthy',
          label: 'healthy',
          detail: '',
          latencyMs: 0,
        },
        {
          name: 'Kong Gateway',
          container: 'kong',
          health: 'healthy',
          label: 'healthy',
          detail: '',
          latencyMs: 0,
        },
      ],
    });
    expect(out?.s.rows[1]).toMatchObject({
      container: 'kong',
      health: 'unhealthy',
      label: 'exited',
      detail: 'Exited (128) 3 hours ago',
    });
  });

  it('one server failing does not affect the other', async () => {
    const sshRun = vi.fn(async (ip: string) => {
      if (ip === '2.2.2.2') {
        throw Object.assign(
          new Error(
            'Command failed: ssh -i /k -- root@2.2.2.2 docker ps\nssh: connect to host 2.2.2.2 port 22: Connection timed out',
          ),
          { stderr: 'ssh: connect to host 2.2.2.2 port 22: Connection timed out\nmore' },
        );
      }
      return 'letsgo-db\trunning\tUp 1h (healthy)\n';
    });
    const out = await checkRemoteContainers('prod', composeHa, 'letsgo', { ...base(), sshRun });
    expect(out).not.toBeNull();
    expect(out?.p.error).toBeUndefined();
    expect(out?.p.rows).toHaveLength(1);
    expect(out?.s).toEqual({
      kind: 'compose',
      ip: '2.2.2.2',
      rows: [],
      error: 'ssh: connect to host 2.2.2.2 port 22: Connection timed out',
    });
  });

  it('skips ssh warning/banner lines in stderr and reports the real reason', async () => {
    const sshRun = vi.fn(async (ip: string) => {
      if (ip === '2.2.2.2') {
        throw Object.assign(new Error('Command failed: ssh -i /k -- root@2.2.2.2 docker ps'), {
          stderr:
            "Warning: Permanently added '2.2.2.2' (ED25519) to the list of known hosts.\n" +
            'ssh: connect to host 2.2.2.2 port 22: Connection refused',
        });
      }
      return 'letsgo-db\trunning\tUp 1h (healthy)\n';
    });
    const out = await checkRemoteContainers('prod', composeHa, 'letsgo', { ...base(), sshRun });
    expect(out).not.toBeNull();
    expect(out?.s.error).toBe('ssh: connect to host 2.2.2.2 port 22: Connection refused');
  });

  it('falls through to the message when stderr is only warnings', async () => {
    const sshRun = vi.fn(async () => {
      throw Object.assign(new Error('Command failed: ssh -i /k -- root@1.1.1.1 docker ps'), {
        stderr:
          '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n' +
          "Warning: Permanently added '1.1.1.1' (ED25519) to the list of known hosts.\n",
      });
    });
    const out = await checkRemoteContainers(
      'prod',
      { deployMode: 'compose', servers: [{ name: 'p', ip: '1.1.1.1' }] },
      'letsgo',
      { ...base(), sshRun },
    );
    expect(out).not.toBeNull();
    expect(out?.p.error).toBe('Command failed: ssh -i /k -- root@1.1.1.1 docker ps');
  });

  it('a timed-out server (wrapper timeout, empty stderr) reports "ssh timeout"', async () => {
    const sshRun = vi.fn(async (ip: string) => {
      if (ip === '2.2.2.2') {
        throw Object.assign(new Error('Command failed: ssh -i /k -- root@2.2.2.2 docker ps'), {
          timedOut: true,
          stderr: '',
        });
      }
      return 'letsgo-db\trunning\tUp 1h (healthy)\n';
    });
    const out = await checkRemoteContainers('prod', composeHa, 'letsgo', { ...base(), sshRun });
    expect(out).not.toBeNull();
    expect(out?.s).toEqual({ kind: 'compose', ip: '2.2.2.2', rows: [], error: 'ssh timeout' });
  });

  it('a server with no ip is reported, not queried', async () => {
    const sshRun = vi.fn();
    const out = await checkRemoteContainers(
      'prod',
      { deployMode: 'compose', servers: [{ name: 'p' }] },
      'letsgo',
      { ...base(), sshRun },
    );
    expect(out).toEqual({ p: { kind: 'compose', ip: '', rows: [], error: 'no ip recorded' } });
    expect(sshRun).not.toHaveBeenCalled();
  });

  it('bounds each server by timeoutMs', async () => {
    const sshRun = vi.fn(() => new Promise(() => {}));
    const out = await checkRemoteContainers(
      'prod',
      { deployMode: 'compose', servers: [{ name: 'p', ip: '1.1.1.1' }] },
      'letsgo',
      {
        ...base(),
        sshRun,
        timeoutMs: 20,
      },
    );
    expect(out).not.toBeNull();
    expect(out?.p.error).toBe('ssh timeout');
  });

  it('k8s: pods + nodes on the master, app rows and platform rollups', async () => {
    const pods = {
      items: [
        {
          metadata: {
            name: 'app-bcd12-x',
            namespace: 'vibecarbon',
            ownerReferences: [{ kind: 'ReplicaSet', name: 'app-bcd12' }],
          },
          status: {
            phase: 'Running',
            containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }],
          },
        },
        {
          metadata: { name: 'source-controller-x', namespace: 'flux-system' },
          status: {
            phase: 'Running',
            containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }],
          },
        },
      ],
    };
    const nodes = { items: [{ status: { conditions: [{ type: 'Ready', status: 'True' }] } }] };
    const sshKubectl = vi.fn(async (_ip: string, _key: string, argv: string[]) =>
      argv[1] === 'pods' ? JSON.stringify(pods) : JSON.stringify(nodes),
    );
    const out = await checkRemoteContainers(
      'prod',
      { deployMode: 'kubernetes', servers: [{ name: 'm', ip: '1.1.1.1', role: 'master' }] },
      'letsgo',
      {
        ...base(),
        sshKubectl,
        sshRun: vi.fn(),
      },
    );
    expect(sshKubectl.mock.calls.map((c) => c[2])).toEqual([
      ['get', 'pods', '-A', '-o', 'json'],
      ['get', 'nodes', '-o', 'json'],
    ]);
    expect(sshKubectl.mock.calls[0][3]).toMatchObject({ transportRetry: false });
    expect(out).not.toBeNull();
    expect(out?.m).toEqual({
      kind: 'k8s',
      ip: '1.1.1.1',
      rows: [
        {
          name: 'app',
          container: 'app',
          health: 'healthy',
          label: 'healthy',
          detail: '',
          latencyMs: 0,
        },
      ],
      platform: { 'flux-system': { healthy: 1, total: 1 } },
      nodes: { ready: 1, total: 1 },
    });
  });

  it('k8s: unparseable kubectl output is an error row', async () => {
    const out = await checkRemoteContainers(
      'prod',
      { deployMode: 'kubernetes', servers: [{ name: 'm', ip: '1.1.1.1', role: 'master' }] },
      'letsgo',
      {
        ...base(),
        sshKubectl: vi.fn(async () => 'error: You must be logged in'),
        sshRun: vi.fn(),
      },
    );
    expect(out).not.toBeNull();
    expect(out?.m).toEqual({
      kind: 'k8s',
      ip: '1.1.1.1',
      rows: [],
      error: 'kubectl output unparseable',
    });
  });
});
