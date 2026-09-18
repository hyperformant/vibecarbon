import { describe, expect, it } from 'vitest';
import {
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

  it('compose-ha: primary and standby, both compose', () => {
    expect(
      planContainerTargets({
        deployMode: 'compose-ha',
        servers: [
          { name: 'prod-primary', ip: '1.1.1.1', role: 'primary' },
          { name: 'prod-standby', ip: '2.2.2.2', role: 'standby' },
        ],
      }),
    ).toEqual([
      { serverName: 'prod-primary', ip: '1.1.1.1', kind: 'compose' },
      { serverName: 'prod-standby', ip: '2.2.2.2', kind: 'compose' },
    ]);
  });

  it('kubernetes: only the master, kind k8s; workers and supabase omitted', () => {
    expect(
      planContainerTargets({
        deployMode: 'kubernetes',
        servers: [
          { name: 'prod', ip: '1.1.1.1', role: 'master' },
          { name: 'supabase', ip: '3.3.3.3', role: 'supabase' },
          { name: 'worker-1', ip: '4.4.4.4', role: 'worker' },
        ],
      }),
    ).toEqual([{ serverName: 'prod', ip: '1.1.1.1', kind: 'k8s' }]);
  });

  it('kubernetes with no roles recorded: falls back to servers[0]', () => {
    expect(
      planContainerTargets({
        deployMode: 'kubernetes',
        servers: [{ name: 'prod', ip: '1.1.1.1' }],
      }),
    ).toEqual([{ serverName: 'prod', ip: '1.1.1.1', kind: 'k8s' }]);
  });

  it('kubernetes-ha: primary and standby cluster masters, kind k8s', () => {
    expect(
      planContainerTargets({
        deployMode: 'kubernetes-ha',
        servers: [
          { name: 'prod-primary', ip: '1.1.1.1', role: 'primary' },
          { name: 'prod-standby', ip: '2.2.2.2', role: 'standby' },
          { name: 'worker-1', ip: '4.4.4.4', role: 'worker' },
        ],
      }),
    ).toEqual([
      { serverName: 'prod-primary', ip: '1.1.1.1', kind: 'k8s' },
      { serverName: 'prod-standby', ip: '2.2.2.2', kind: 'k8s' },
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
          name: 'supabase-realtime-1a2b3c-q',
          namespace: 'vibecarbon',
          ownerReferences: [{ kind: 'ReplicaSet', name: 'supabase-realtime-1a2b3c' }],
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
