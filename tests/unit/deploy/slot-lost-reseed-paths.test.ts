/**
 * A lost replication slot leads to a reseed, on both tiers, through the probe
 * (HA-correctness Task 7 ledger MUST FIX, final review I6).
 *
 * A lost slot can never stream again, so the standby reads as not streaming:
 * the deploy's streaming probe answers false and the deploy takes the reseed
 * (pg_basebackup), with the lost slot dropped and recreated on the primary
 * first (ensureReplicationSlotSql). slot-lost-reseed.test.ts pins the SQL and
 * the compose reseed's own ensure; this drives each deploy path from the
 * probe's false into the basebackup:
 *
 *   - compose-ha: haConfigureReplication;
 *   - k8s-ha: setupReplication (primary-init carries the ensure, then the
 *     probe, then the staged basebackup on the standby).
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Array<{ cmd: string; input?: string; file?: string }> = [];

// k8s transport: every ssh is runCommandAsync argv; scp carries primary-init.sql.
vi.mock('../../../src/lib/command.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  runCommandAsync: vi.fn(async (argv: string[], opts: { input?: string } = {}) => {
    // The reseed's remote kubectl is shEscaped token by token: match it unquoted.
    const cmd = argv[argv.length - 1].replace(/'\\''/g, "'").replace(/'/g, '');
    const target = argv.find((a) => a.startsWith('root@')) ?? '';
    calls.push({ cmd, input: opts.input });
    // The lost slot: nothing streams from the primary.
    if (cmd.includes('pg_stat_replication')) return '';
    // The primary db StatefulSet, created with its replication hostPort.
    if (cmd.includes('get statefulset db -n vibecarbon -o json')) {
      return JSON.stringify({
        spec: {
          template: {
            spec: {
              containers: [{ name: 'db', ports: [{ containerPort: 5432, hostPort: 5433 }] }],
            },
          },
        },
      });
    }
    // The standby db pod, running the in-place reseed wrapper (db-guard.sh).
    if (cmd.includes('get pod db-0') && cmd.includes('-o json')) {
      return JSON.stringify({
        metadata: { uid: 'u1' },
        status: {
          phase: 'Running',
          containerStatuses: [
            { name: 'db', restartCount: 0, containerID: 'c1', ready: true, state: { running: {} } },
          ],
        },
        spec: {
          containers: [
            {
              name: 'db',
              command: ['sh', '/usr/local/bin/db-guard.sh'],
              volumeMounts: [
                { name: 'w', mountPath: '/usr/local/bin/db-guard.sh', subPath: 'db-guard.sh' },
                { name: 'data', mountPath: '/var/lib/vibecarbon/role', subPath: 'vibecarbon-role' },
              ],
              env: [
                {
                  name: 'VC_WALG_ROLE_INTENT',
                  valueFrom: {
                    configMapKeyRef: { name: 'vibecarbon-db-role', key: 'VC_WALG_ROLE_INTENT' },
                  },
                },
              ],
            },
          ],
        },
      });
    }
    if (cmd.includes('configmap vibecarbon-db-role')) {
      return target === 'root@10.1.0.1' ? 'primary' : 'standby';
    }
    if (cmd.includes('vc-reseed-protocol') && cmd.includes('grep -c'))
      return '1\nin_recovery=f\nslots=0\nident=7000000000000000001|00000001';
    if (cmd.includes('VC_DISCARD_GONE')) return 'VC_DISCARD_GONE';
    if (cmd.includes('pg_database_size')) return '1048576|7412345678901234567|00000001';
    // Stop the run once the basebackup stage has been sent.
    if (opts.input?.includes('pg_basebackup')) throw new Error('stop after stage (test)');
    return '';
  }),
}));
vi.mock('../../../src/lib/ssh.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  scpWithRetry: vi.fn(async (args: string[]) => {
    calls.push({ cmd: 'scp', file: readFileSync(args[args.length - 2], 'utf-8') });
  }),
}));
vi.mock('../../../src/lib/host-keys.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  seedKnownHosts: vi.fn(async () => {}),
}));

// compose transport: the mocked compose ssh layer.
const composeCalls: Array<{ command: string; input?: string }> = [];
vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const rec = async (_ip: string, _k: string, command: unknown, options?: { input?: string }) => {
    const c = String(command);
    composeCalls.push({ command: c, input: options?.input });
    // The lost slot: the primary sees no streaming standby.
    if (c.includes('pg_stat_replication') && c.includes('ORDER BY')) return '';
    if (c.includes('pg_is_in_recovery')) return 't';
    if (c.includes('SHOW hba_file')) return '/var/lib/postgresql/data/pg_hba.conf';
    if (c.includes('pg_isready')) return 'accepting connections';
    if (options?.input?.includes('pg_basebackup')) return 'COMPOSE_RESEED_STAGED';
    if (c.includes('IPAM')) return '172.19.0.0/16 ';
    if (c.includes('.Mounts')) return '/var/lib/docker/volumes/myapp_db_data/_data';
    if (options?.input?.includes('RESEED_SWAPPED')) return 'RESEED_SWAPPED';
    return '';
  };
  return { ...actual, sshRun: vi.fn(rec), sshRunAsync: vi.fn(rec), sshRunChecked: vi.fn(rec) };
});
vi.mock('../../../src/lib/deploy/wireguard.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  exchangeAndBringUpTunnel: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../../src/lib/deploy/replication.js', async (orig) => {
  const actual = (await orig()) as Record<string, (o: object) => unknown>;
  // No real waits between probe reads.
  return {
    ...actual,
    probeStreaming: (o: object) =>
      actual.probeStreaming({ ...o, attempts: 1, sleep: async () => {} }),
  };
});

const { ensureReplicationSlotSql } = await import('../../../src/lib/deploy/replication-slot.js');
const { setupReplication } = await import('../../../src/lib/deploy/k8s/ha/index.js');
const { COMPOSE_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/compose-ha.js');

beforeEach(() => {
  process.env.REPL_PASSWORD = 'testreplpass';
  calls.length = 0;
  composeCalls.length = 0;
});

describe('k8s-ha: a lost slot reseeds through the probe', () => {
  it('primary-init (dropping the lost slot) runs, the probe reads no stream, and the basebackup is staged', async () => {
    await expect(
      setupReplication({
        primaryIp: '10.1.0.1',
        standbyIp: '10.2.0.1',
        sshKeyPath: '/tmp/never-used-key',
        primaryDbPrivateIp: '10.0.1.2',
        standbyDbPrivateIp: '10.0.1.2',
        transportPrepared: true,
      }),
    ).rejects.toThrow(/stop after stage/);
    const init = calls.findIndex(
      (c) => c.cmd === 'scp' && c.file?.includes(ensureReplicationSlotSql()),
    );
    const probe = calls.findIndex((c) => c.cmd.includes('pg_stat_replication'));
    const stage = calls.findIndex((c) => c.input?.includes('pg_basebackup'));
    expect(init).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(init);
    expect(stage).toBeGreaterThan(probe);
    expect(calls[stage].cmd).toContain('kubectl -n vibecarbon exec -i db-0 -c db -- sh');
  });
});

describe('compose-ha: a lost slot reseeds through the probe', () => {
  it('the probe reads no stream, so the deploy re-ensures the slot and runs the basebackup', async () => {
    await COMPOSE_HA_EFFECTS.haConfigureReplication({
      projectConfig: { projectName: 'myapp' },
      environment: 'prod',
      primary: { ip: '1.1.1.1', stack: 'primary' },
      standby: { ip: '2.2.2.2', stack: 'standby' },
      sshKeyPath: '/tmp/never-used-key',
      onProgress: () => {},
    } as never);
    const sqlOf = (c: { command: string; input?: string }) => [
      c.input ?? '',
      ...[...c.command.matchAll(/echo (\S+) \| base64 -d/g)].map((m) =>
        Buffer.from(m[1], 'base64').toString('utf-8'),
      ),
    ];
    const probe = composeCalls.findIndex(
      (c) => c.command.includes('pg_stat_replication') && c.command.includes('ORDER BY'),
    );
    const ensure = composeCalls.findIndex(
      (c, i) => i > probe && sqlOf(c).some((s) => s.includes(ensureReplicationSlotSql())),
    );
    const basebackup = composeCalls.findIndex((c) => c.input?.includes('pg_basebackup'));
    expect(probe).toBeGreaterThan(-1);
    expect(ensure).toBeGreaterThan(probe);
    expect(basebackup).toBeGreaterThan(ensure);
  });
});
