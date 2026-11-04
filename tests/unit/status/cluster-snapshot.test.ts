import { describe, expect, it, vi } from 'vitest';
import {
  createClusterSnapshots,
  dbPod,
  parseClusterSnapshot,
  SNAPSHOT_ARGV,
  SNAPSHOT_TIMEOUT_MS,
} from '../../../src/lib/status/cluster-snapshot.js';

const node = (ready: boolean) => ({
  kind: 'Node',
  metadata: { name: `n-${ready}` },
  status: { conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] },
});
const pod = (name: string, namespace: string, labels: Record<string, string> = {}) => ({
  kind: 'Pod',
  metadata: { name, namespace, labels },
  status: { phase: 'Running' },
});
const job = (name: string) => ({ kind: 'Job', metadata: { name, namespace: 'vibecarbon' } });
const list = (items: object[]) => JSON.stringify({ apiVersion: 'v1', kind: 'List', items });

describe('the snapshot read', () => {
  it('is one kubectl call that lists nodes, pods and jobs across every namespace', () => {
    expect(SNAPSHOT_ARGV).toEqual(['get', 'nodes,pods,jobs', '-A', '-o', 'json']);
  });

  it('is bounded at 20 s: one call carrying the three lists the old 10 s calls read apart', () => {
    expect(SNAPSHOT_TIMEOUT_MS).toBe(20_000);
  });
});

describe('parseClusterSnapshot', () => {
  it('splits the one List into nodes, pods and jobs by kind', () => {
    const snap = parseClusterSnapshot(
      list([node(true), node(false), pod('app-x', 'vibecarbon'), job('backup-1')]),
    );
    expect(snap.nodes).toHaveLength(2);
    expect(snap.pods.map((p) => p.metadata.name)).toEqual(['app-x']);
    expect(snap.jobs.map((j) => j.metadata.name)).toEqual(['backup-1']);
  });

  it('refuses output that is not a kubectl List', () => {
    expect(() => parseClusterSnapshot('error: You must be logged in')).toThrow(
      'kubectl output unparseable',
    );
    expect(() => parseClusterSnapshot('{"kind":"Pod"}')).toThrow('kubectl output unparseable');
  });
});

describe('createClusterSnapshots', () => {
  const seams = (sshKubectl: (...a: never[]) => unknown) => ({
    sshKubectl,
    sshKeyPathFor: vi.fn(() => '/k'),
    existsSync: vi.fn(() => true),
  });

  it('reads each cluster once, however many rows ask', async () => {
    const sshKubectl = vi.fn(async () => list([]));
    const snaps = createClusterSnapshots('prod', seams(sshKubectl));
    await Promise.all([
      snaps.get('1.1.1.1'),
      snaps.get('1.1.1.1'),
      snaps.get('2.2.2.2'),
      snaps.get('1.1.1.1'),
    ]);
    expect(sshKubectl).toHaveBeenCalledTimes(2);
    expect(sshKubectl.mock.calls[0]).toEqual([
      '1.1.1.1',
      '/k',
      SNAPSHOT_ARGV,
      { silent: true, timeout: SNAPSHOT_TIMEOUT_MS, transportRetry: false },
    ]);
  });

  it('a failed read is one clear reason for every row that asks, and is never retried', async () => {
    const sshKubectl = vi.fn(async () => {
      throw Object.assign(new Error('Command failed: ssh -i /k -- root@1.1.1.1 env ...'), {
        timedOut: true,
        stderr: '',
      });
    });
    const snaps = createClusterSnapshots('prod', seams(sshKubectl));
    const reasons = await Promise.all(
      [1, 2, 3].map(() => snaps.get('1.1.1.1').catch((e: Error) => e.message)),
    );
    expect(reasons).toEqual(Array(3).fill('cluster snapshot failed: ssh timeout'));
    expect(sshKubectl).toHaveBeenCalledTimes(1);
  });

  it('names what the remote said, never the ssh invocation', async () => {
    const snaps = createClusterSnapshots(
      'prod',
      seams(async () => {
        throw Object.assign(new Error('Command failed: ssh -i /secret/key -- root@1.1.1.1'), {
          stderr:
            "Warning: Permanently added '1.1.1.1' (ED25519) to the list of known hosts.\n" +
            'The connection to the server 127.0.0.1:6443 was refused',
        });
      }),
    );
    await expect(snaps.get('1.1.1.1')).rejects.toThrow(
      'cluster snapshot failed: The connection to the server 127.0.0.1:6443 was refused',
    );
  });

  it('unparseable output is a failed snapshot', async () => {
    const snaps = createClusterSnapshots(
      'prod',
      seams(async () => 'not json'),
    );
    await expect(snaps.get('1.1.1.1')).rejects.toThrow(
      'cluster snapshot failed: kubectl output unparseable',
    );
  });

  it('is bounded even when the call never returns', async () => {
    const snaps = createClusterSnapshots('prod', {
      ...seams(() => new Promise(() => {})),
      snapshotTimeoutMs: 20,
    });
    await expect(snaps.get('1.1.1.1')).rejects.toThrow('cluster snapshot failed: ssh timeout');
  });

  it('without an ssh key it fails without touching the network', async () => {
    const sshKubectl = vi.fn();
    const snaps = createClusterSnapshots('prod', {
      ...seams(sshKubectl),
      existsSync: vi.fn(() => false),
    });
    await expect(snaps.get('1.1.1.1')).rejects.toThrow(
      'cluster snapshot failed: no ssh key for this environment',
    );
    expect(sshKubectl).not.toHaveBeenCalled();
  });
});

describe('dbPod', () => {
  it('is the vibecarbon pod labelled app=vibecarbon-db, as the label lookup chose it', () => {
    const snap = parseClusterSnapshot(
      list([
        pod('db-0', 'other', { app: 'vibecarbon-db' }),
        pod('app-x', 'vibecarbon', { app: 'app' }),
        pod('db-0', 'vibecarbon', { app: 'vibecarbon-db' }),
      ]),
    );
    expect(dbPod(snap).metadata).toMatchObject({ name: 'db-0', namespace: 'vibecarbon' });
  });

  it('a cluster with no db pod says so', () => {
    expect(() => dbPod(parseClusterSnapshot(list([])))).toThrow(
      'no app=vibecarbon-db pod in namespace vibecarbon',
    );
  });
});
