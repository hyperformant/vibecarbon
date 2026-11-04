/**
 * One cluster snapshot per cluster per `vibecarbon status` run.
 *
 * The three remote reads of an environment (replication, containers/pods,
 * backups) run together through checkEnvironmentRemote and share one snapshot
 * of each cluster: a single `kubectl get nodes,pods,jobs -A -o json` over ssh.
 * Every row is built from it, and only the execs that must run inside the db
 * pod (psql, log reads, the gap record) make their own call, against the pod
 * the snapshot named.
 *
 * Calls are counted through the ssh seam (the injected sshKubectl/sshRun every
 * check takes), so a probe that lists anything itself shows up here.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildPrimaryLagQuery,
  buildStandbyReplayQuery,
} from '../../../src/lib/deploy/replication.js';
import { REPLICATION_SLOT_HEALTH_SQL } from '../../../src/lib/deploy/replication-slot.js';
import { ARCHIVER_SQL } from '../../../src/lib/status/backup-health.js';
import { SNAPSHOT_ARGV } from '../../../src/lib/status/cluster-snapshot.js';
import {
  checkEnvironmentRemote,
  isEnvironmentUnhealthy,
  isEnvironmentUnreadable,
} from '../../../src/status.js';
import { withSshContract } from '../../_shared/ssh-contract.js';

const P = '10.0.0.1';
const S = '10.0.0.2';
const LINEAGE = '7000000000000000001';
const WAL = '000000010000000000000010';
// checkReplication checks the key on disk: any file that exists will do.
const KEY = __filename;

const envConfig = () => ({
  deployMode: 'kubernetes-ha',
  provider: 'hetzner',
  backup: { lineage: LINEAGE, schedule: '0 3 * * *' },
  ha: { enabled: true, primary: { masterIp: P }, standby: { masterIp: S } },
  servers: [
    { name: 'primary', ip: P, role: 'primary' },
    { name: 'standby', ip: S, role: 'standby' },
  ],
});

const running = (name: string, namespace: string, labels: Record<string, string> = {}) => ({
  kind: 'Pod',
  metadata: { name, namespace, labels },
  status: {
    phase: 'Running',
    containerStatuses: [
      { name: 'db', ready: true, restartCount: 0, state: { running: { startedAt: '' } } },
    ],
  },
});
const node = (ready: boolean) => ({
  kind: 'Node',
  status: { conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] },
});
const CLUSTERS: Record<string, object[]> = {
  [P]: [
    node(true),
    node(true),
    node(false),
    running('db-7', 'vibecarbon', { app: 'vibecarbon-db' }),
    running('traefik-x', 'kube-system'),
    {
      kind: 'Job',
      metadata: { name: 'backup-9', namespace: 'vibecarbon', creationTimestamp: 'z' },
      status: { conditions: [{ type: 'Failed', status: 'True' }] },
    },
  ],
  [S]: [node(true), running('db-3', 'vibecarbon', { app: 'vibecarbon-db' })],
};

/** A fake cluster behind the ssh seam: answers by argv, records every call. */
function cluster({ failSnapshotOn }: { failSnapshotOn?: string } = {}) {
  const calls: Array<{ ip: string; argv: string[] }> = [];
  const sshKubectl = vi.fn(
    async (ip: string, _key: string, argv: string[], opts: { input?: string } = {}) => {
      calls.push({ ip, argv });
      if (argv[0] === 'get') {
        if (ip === failSnapshotOn) {
          throw Object.assign(new Error('Command failed: ssh'), { timedOut: true, stderr: '' });
        }
        return JSON.stringify({ apiVersion: 'v1', kind: 'List', items: CLUSTERS[ip] });
      }
      if (argv.includes('psql')) {
        const sql = argv.includes('-tAc') ? argv[argv.length - 1] : opts.input;
        if (sql === ARCHIVER_SQL) return `60|${WAL}|${WAL}|f`;
        if (sql === buildPrimaryLagQuery()) return 'streaming|0.4';
        if (sql === buildStandbyReplayQuery()) return 't|0/3000060|0';
        if (sql === REPLICATION_SLOT_HEALTH_SQL) return 'reserved|1048576';
        if (sql?.startsWith('SHOW')) return 'off';
        return 'streaming|1024';
      }
      if (argv.includes('--previous')) throw new Error('previous terminated container not found');
      if (argv[0] === 'logs') return '';
      if (argv.includes('sh')) return 'VC_OK';
      throw new Error(`unexpected kubectl ${argv.join(' ')}`);
    },
  );
  const deps = {
    sshKubectl,
    sshRun: withSshContract(vi.fn()),
    getSSHKeyPath: () => KEY,
    existsSync: () => true,
    readBases: async () => ({
      s3Config: { bucket: 'b' },
      lineage: LINEAGE,
      backups: [{ name: 'base_1', finishTime: new Date() }],
    }),
  };
  return { calls, deps };
}

describe('checkEnvironmentRemote: one cluster snapshot per cluster per run', () => {
  it('sends exactly one listing call to each cluster, and it is the snapshot', async () => {
    const { calls, deps } = cluster();
    await checkEnvironmentRemote('prod', envConfig(), 'proj', deps);
    for (const ip of [P, S]) {
      const listings = calls.filter((c) => c.ip === ip && c.argv[0] === 'get');
      expect(listings.map((c) => c.argv)).toEqual([SNAPSHOT_ARGV]);
    }
    // The primary: the snapshot, four replication reads, the archiver, the
    // current and previous db log, the gap record. Was 16 calls, 8 of them
    // listings. The standby: the snapshot and its replay read (was 4).
    expect(calls.filter((c) => c.ip === P)).toHaveLength(9);
    expect(calls.filter((c) => c.ip === S)).toHaveLength(2);
  });

  it('builds every row from that snapshot', async () => {
    const { calls, deps } = cluster();
    const r = await checkEnvironmentRemote('prod', envConfig(), 'proj', deps);
    const containers = r.containers.status === 'fulfilled' ? r.containers.value : null;
    // Node readiness and the pod rollups.
    expect(containers?.primary).toMatchObject({
      kind: 'k8s',
      nodes: { ready: 2, total: 3 },
      platform: { 'kube-system': { healthy: 1, total: 1 } },
    });
    expect(containers?.primary.rows.map((row: { name: string }) => row.name)).toEqual(['db-7']);
    expect(containers?.standby).toMatchObject({ nodes: { ready: 1, total: 1 } });
    // The backup Job.
    const backups = r.backups.status === 'fulfilled' ? r.backups.value : null;
    expect(backups?.lastJob).toEqual({ name: 'backup-9', failed: true, retentionFailed: false });
    // Every exec targets the db pod the snapshot named, on its own cluster.
    const execs = calls.filter((c) => c.argv[0] !== 'get');
    expect(execs.length).toBeGreaterThan(0);
    for (const c of execs) expect(c.argv).toContain(c.ip === P ? 'db-7' : 'db-3');
    // Replication read through the same pods.
    const repl = r.replication.status === 'fulfilled' ? r.replication.value : null;
    expect(repl).toMatchObject({ streaming: true, lagBytes: 1024, writeFenced: 'off' });
    expect(repl?.standbyRow).toMatchObject({ inRecovery: true });
  });

  it('a failed snapshot makes its rows unreadable with one reason, never unhealthy', async () => {
    const { calls, deps } = cluster({ failSnapshotOn: P });
    const r = await checkEnvironmentRemote('prod', envConfig(), 'proj', deps);
    const reason = 'cluster snapshot failed: ssh timeout';
    // Nothing else is sent to a cluster whose snapshot failed.
    expect(calls.filter((c) => c.ip === P)).toHaveLength(1);

    const containers = r.containers.status === 'fulfilled' ? r.containers.value : null;
    expect(containers?.primary).toEqual({ kind: 'k8s', ip: P, rows: [], error: reason });
    // The other cluster is read as usual.
    expect(containers?.standby.error).toBeUndefined();

    const repl = r.replication.status === 'fulfilled' ? r.replication.value : null;
    expect(repl).toMatchObject({ streaming: false, state: 'unknown', error: reason });

    const backups = r.backups.status === 'fulfilled' ? r.backups.value : null;
    expect(backups?.level).toBe('warn');
    expect(backups?.text.split(reason)).toHaveLength(2);

    const entry = { checks: { remoteHealth: { ok: true }, containers } };
    expect(isEnvironmentUnhealthy(entry)).toBe(false);
    expect(isEnvironmentUnreadable(entry)).toBe(true);
  });
});
