/**
 * Self-enforcing retirement (HA-correctness Task 6, R7).
 *
 * A failover can finish with the old primary unreachable and un-demoted (that
 * is usually why it ran). When that node comes back it still believes it is
 * the primary: its app and add-ons write, its WAL archiver and nightly base
 * backup push into the shared prefix the new primary owns, and
 * `wal-g delete retain` can prune the new primary's backups. So the retired
 * side is fenced by markers it enforces itself, and every HA command (status,
 * failover, deploy) re-applies it on any reachable side the persisted roles
 * call retired:
 *   - a marker each backup script refuses on (k8s: VIBECARBON_ROLE=retired in
 *     vibecarbon-config; compose: <remoteDir>/.vibecarbon-retired; both: a
 *     `vibecarbon-retired` file in PGDATA, the only marker the db container's
 *     archive_command can see);
 *   - its database read-only (default_transaction_read_only via ALTER SYSTEM,
 *     every writer covered), unless it is in recovery;
 *   - its writers at zero (k8s: `kubectl scale`, never a patch that rolls pods,
 *     after suspending any Flux Kustomization that would scale it back);
 *   - WALG_ROLE=standby.
 * The reconciler reads first and writes only what is missing, so a fenced side
 * costs no writes.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { failoverFenceServices } from '../../../src/lib/deploy/compose/ha.js';
import {
  clearRetiredFence,
  FLUX_SUSPENDED_BY,
  isRetiredSide,
  RETIRED_DB_MARKER,
  RETIRED_DB_STATE_SQL,
  RETIRED_HOST_MARKER,
  RETIRED_REFUSAL,
  RETIRED_ROLE,
  RETIRED_ROLE_KEY,
  reconcileRetiredFence,
  retiredSides,
} from '../../../src/lib/deploy/retired-fence.js';
import { liftStrandedWriteFence } from '../../../src/lib/deploy/write-fence.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const RETIRED_IP = '10.0.0.1';
const PROMOTED_IP = '10.0.0.9';
const WAL_BYTES = 3 * 1024 * 1024 * 1024;

/** A k8s-ha env right after a failover: ha.standby is the old primary. */
const k8sSwapped = (over: Record<string, unknown> = {}) => ({
  deployMode: 'kubernetes',
  deployedAt: '2026-10-01T00:00:00.000Z',
  lastFailover: '2026-10-02T00:00:00.000Z',
  ha: {
    enabled: true,
    primary: { masterIp: PROMOTED_IP },
    standby: { masterIp: RETIRED_IP },
  },
  ...over,
});

/** A compose-ha env right after a failover: the -primary stack's node is role standby. */
const composeSwapped = (over: Record<string, unknown> = {}) => ({
  deployMode: 'compose-ha',
  deployedAt: '2026-10-01T00:00:00.000Z',
  lastFailover: '2026-10-02T00:00:00.000Z',
  servers: [
    { name: 'myapp-prod-primary', role: 'standby', ip: RETIRED_IP },
    { name: 'myapp-prod-standby', role: 'primary', ip: PROMOTED_IP },
  ],
  ha: { enabled: true },
  ...over,
});

const quiet = { log: () => {}, warn: () => {} };

type Db = {
  up: boolean;
  inRecovery: boolean;
  readOnly: boolean;
  /** default_transaction_read_only is in postgresql.auto.conf */
  fileSetting: boolean;
};

/** A fake postgres behind the tier's psql runner, recording its writes. */
function fakeDb(db: Db, writes: string[]) {
  return () => async (sql: string, o?: { readWrite?: boolean }) => {
    if (!db.up) throw new Error('psql: could not connect to server');
    if (sql === RETIRED_DB_STATE_SQL) {
      return `${db.inRecovery ? 't' : 'f'}|${db.readOnly ? 'on' : 'off'}|${WAL_BYTES}`;
    }
    if (/^ALTER SYSTEM SET default_transaction_read_only = on$/.test(sql)) {
      db.fileSetting = true;
      writes.push('readOnly');
      return '';
    }
    if (/^ALTER SYSTEM RESET default_transaction_read_only$/.test(sql)) {
      expect(o?.readWrite).toBe(true);
      db.fileSetting = false;
      writes.push('clearReadOnly');
      return '';
    }
    if (sql === 'SELECT pg_reload_conf()') {
      db.readOnly = db.fileSetting;
      return 't';
    }
    if (sql.includes("current_setting('default_transaction_read_only')")) {
      return db.readOnly ? 'on' : 'off';
    }
    if (sql === 'SELECT pg_is_in_recovery()') return db.inRecovery ? 't' : 'f';
    if (sql.includes('pg_terminate_backend')) return '';
    if (sql.includes('pg_file_settings')) return db.fileSetting ? '1' : '0';
    throw new Error(`unexpected sql ${sql}`);
  };
}

type Kustomization = { name: string; suspend?: boolean; annotations?: Record<string, string> };

/** A fake k8s cluster behind `kubectl`, recording every mutating call. */
function fakeCluster(
  init: { replicas?: number; walg?: string; role?: string; flux?: Kustomization[] } = {},
) {
  const state = {
    role: init.role ?? '',
    replicas: init.replicas ?? 2,
    walg: init.walg ?? 'primary',
    dbMarker: false,
    reachable: true,
    flux: init.flux,
  };
  const db: Db = { up: true, inRecovery: false, readOnly: false, fileSetting: false };
  const writes: string[] = [];
  const argvs: string[][] = [];
  const kubectl = async (ip: string, argv: string[]) => {
    expect(ip).toBe(RETIRED_IP);
    if (!state.reachable) throw new Error('ssh: connect to host 10.0.0.1 port 22: timed out');
    argvs.push(argv);
    const a = argv.join(' ');
    if (a.includes('kustomizations.kustomize.toolkit.fluxcd.io')) {
      if (!state.flux) {
        throw new Error('error: the server doesn\'t have a resource type "kustomizations"');
      }
      if (argv.includes('get')) {
        return JSON.stringify({
          items: state.flux.map((k) => ({
            metadata: { name: k.name, annotations: k.annotations ?? {} },
            spec: { suspend: !!k.suspend },
          })),
        });
      }
      const name = argv[argv.indexOf('patch') + 2];
      const body = JSON.parse(argv[argv.indexOf('-p') + 1]);
      const k = state.flux.find((x) => x.name === name) as Kustomization;
      k.suspend = body.spec.suspend;
      k.annotations = { ...(k.annotations ?? {}) };
      const ann = body.metadata.annotations[FLUX_SUSPENDED_BY];
      if (ann === null) delete k.annotations[FLUX_SUSPENDED_BY];
      else k.annotations[FLUX_SUSPENDED_BY] = ann;
      writes.push(`flux ${body.spec.suspend ? 'suspend' : 'resume'} ${name}`);
      return '';
    }
    if (argv.includes('rollout')) {
      db.up = true;
      return 'statefulset rolling update complete';
    }
    if (argv.includes('get')) {
      return JSON.stringify({
        kind: 'List',
        items: [
          {
            kind: 'ConfigMap',
            metadata: { name: 'vibecarbon-config' },
            data: {
              SITE_URL: 'https://x',
              ...(state.role ? { [RETIRED_ROLE_KEY]: state.role } : {}),
            },
          },
          { kind: 'Deployment', metadata: { name: 'app' }, spec: { replicas: state.replicas } },
          {
            kind: 'StatefulSet',
            metadata: { name: 'db' },
            spec: {
              template: {
                spec: {
                  containers: [{ name: 'db', env: [{ name: 'WALG_ROLE', value: state.walg }] }],
                },
              },
            },
          },
        ],
      });
    }
    if (argv.includes('exec') && !db.up) throw new Error('pod db-0 is not running');
    if (argv.includes('exec') && a.includes('[ -f')) return state.dbMarker ? 'present' : 'absent';
    if (argv.includes('exec') && a.includes('pg_drop_replication_slot')) {
      writes.push('dropInactiveSlots');
      return '';
    }
    if (argv.includes('patch') && argv.includes('configmap')) {
      const body = JSON.parse(argv[argv.indexOf('-p') + 1]);
      const v = body.data[RETIRED_ROLE_KEY];
      state.role = v ?? '';
      writes.push(v === null ? 'clearMarker' : `marker=${v}`);
      return '';
    }
    if (argv.includes('exec') && a.includes('touch')) {
      state.dbMarker = true;
      writes.push('dbMarker');
      return 'OK';
    }
    if (argv.includes('exec') && a.includes('rm -f')) {
      state.dbMarker = false;
      writes.push('clearDbMarker');
      return 'OK';
    }
    if (argv.includes('scale')) {
      state.replicas = Number(a.match(/--replicas=(\d+)/)?.[1]);
      writes.push(`scale ${argv[argv.indexOf('scale') + 2]} ${state.replicas}`);
      return '';
    }
    if (argv.includes('set') && argv.includes('env')) {
      state.walg = a.match(/WALG_ROLE=(\w+)/)?.[1] ?? state.walg;
      writes.push(`walg=${state.walg}`);
      return '';
    }
    throw new Error(`unexpected kubectl ${a}`);
  };
  return { state, db, writes, argvs, kubectl, psql: fakeDb(db, writes) };
}

/** A fake compose node behind the compose ssh runner (false = remote failure). */
function fakeNode(init: { walg?: string; running?: string[] } = {}) {
  const state = {
    hostMarker: false,
    dbMarker: false,
    walg: init.walg ?? 'primary',
    running: init.running ?? ['myapp-app', 'myapp-n8n'],
    reachable: true,
  };
  const db: Db = { up: true, inRecovery: false, readOnly: false, fileSetting: false };
  const writes: string[] = [];
  const commands: string[] = [];
  const run = async (ip: string, command: string) => {
    expect(ip).toBe(RETIRED_IP);
    if (!state.reachable) return false;
    commands.push(command);
    if (command.includes('PROBE_DONE')) {
      return [
        `HOST_MARKER=${state.hostMarker ? 1 : 0}`,
        `WALG_ROLE=${state.walg}`,
        `DB_MARKER=${db.up ? (state.dbMarker ? 'present' : 'absent') : 'unknown'}`,
        ...state.running.map((c) => `RUNNING ${c}`),
        'PROBE_DONE',
      ].join('\n');
    }
    if (command.includes(`touch /opt/myapp/${RETIRED_HOST_MARKER}`)) {
      state.hostMarker = true;
      writes.push('hostMarker');
      return 'OK';
    }
    if (command.includes('docker exec') && command.includes('touch')) {
      if (!db.up) return false;
      state.dbMarker = true;
      writes.push('dbMarker');
      return 'OK';
    }
    if (command.includes('rm -f')) {
      state.hostMarker = false;
      state.dbMarker = false;
      writes.push('clear');
      return 'CLEARED';
    }
    throw new Error(`unexpected command ${command}`);
  };
  const zeroWorkloads = async (ip: string) => {
    expect(ip).toBe(RETIRED_IP);
    writes.push('zeroWorkloads');
    state.running = [];
    return true;
  };
  const demoteWalgRole = async (ip: string) => {
    expect(ip).toBe(RETIRED_IP);
    writes.push('walg=standby');
    state.walg = 'standby';
    db.up = true;
    return true;
  };
  return {
    state,
    db,
    writes,
    commands,
    run,
    zeroWorkloads,
    demoteWalgRole,
    psql: fakeDb(db, writes),
  };
}

describe('retiredSides: only a side the persisted roles call retired', () => {
  it('nothing is retired while no failover has swapped the roles', () => {
    expect(
      retiredSides({ tier: 'k8s-ha', envConfig: k8sSwapped({ lastFailover: undefined }) }),
    ).toEqual([]);
    expect(
      retiredSides({
        tier: 'k8s-ha',
        envConfig: k8sSwapped({ deployedAt: '2026-10-03T00:00:00.000Z' }),
      }),
    ).toEqual([]);
  });

  it('after a swap, the k8s standby cluster and the compose role-standby node', () => {
    expect(retiredSides({ tier: 'k8s-ha', envConfig: k8sSwapped() })).toEqual([{ ip: RETIRED_IP }]);
    expect(retiredSides({ tier: 'compose-ha', envConfig: composeSwapped() })).toEqual([
      { ip: RETIRED_IP, name: 'myapp-prod-primary' },
    ]);
    expect(isRetiredSide(composeSwapped(), RETIRED_IP)).toBe(true);
    expect(isRetiredSide(composeSwapped(), PROMOTED_IP)).toBe(false);
  });
});

describe('reconcileRetiredFence (k8s-ha)', () => {
  const projectConfig = { projectName: 'myapp' };
  const argsFor = (
    cluster: ReturnType<typeof fakeCluster>,
    deps: Record<string, unknown> = {},
  ) => ({
    environment: 'prod',
    envConfig: k8sSwapped(),
    projectConfig,
    tier: 'k8s-ha' as const,
    deps: { ...quiet, sshKeyPath: '/k', kubectl: cluster.kubectl, psql: cluster.psql, ...deps },
  });

  it('an unswapped env makes no call at all', async () => {
    const cluster = fakeCluster();
    const result = await reconcileRetiredFence({
      ...argsFor(cluster),
      envConfig: k8sSwapped({ lastFailover: undefined }),
    });
    expect(result).toEqual({ fenced: [], unreachable: [], nodes: [] });
    expect(cluster.argvs).toEqual([]);
  });

  it('fences a reachable retired cluster (app 2, WALG_ROLE=primary, writable db); a second run writes nothing', async () => {
    const cluster = fakeCluster({ replicas: 2, walg: 'primary' });
    const first = await reconcileRetiredFence(argsFor(cluster));
    expect(first.fenced).toEqual([RETIRED_IP]);
    expect(first.unreachable).toEqual([]);
    expect(first.nodes[0]).toMatchObject({ ip: RETIRED_IP, fenced: true, walBytes: WAL_BYTES });
    expect(first.nodes[0].wrote.length).toBeGreaterThan(0);
    expect(cluster.writes).toEqual([
      `marker=${RETIRED_ROLE}`,
      'dbMarker',
      'readOnly',
      'scale app 0',
      // demoteK8sWalgRole: nobody streams from the retired side's slot.
      'dropInactiveSlots',
      'walg=standby',
    ]);
    expect(cluster.db.readOnly).toBe(true);
    // The app is zeroed with `kubectl scale`, never a patch or set image that
    // would roll its pods.
    const appWrites = cluster.argvs.filter((a) => a.join(' ').includes('app'));
    for (const a of appWrites) {
      expect(a).not.toContain('patch');
      expect(a).not.toContain('image');
    }

    cluster.writes.length = 0;
    const second = await reconcileRetiredFence(argsFor(cluster));
    expect(second.fenced).toEqual([RETIRED_IP]);
    expect(second.nodes[0].wrote).toEqual([]);
    expect(cluster.writes).toEqual([]);
  });

  it('a db in recovery is not made read-only (a replica cannot write)', async () => {
    const cluster = fakeCluster();
    cluster.db.inRecovery = true;
    const result = await reconcileRetiredFence(argsFor(cluster));
    expect(result.fenced).toEqual([RETIRED_IP]);
    expect(cluster.writes).not.toContain('readOnly');
  });

  it('suspends the vibecarbon Flux Kustomizations before zeroing the app, and leaves an operator-suspended one alone', async () => {
    const cluster = fakeCluster({
      flux: [
        { name: 'vibecarbon-base' },
        { name: 'vibecarbon-production-nbg1', suspend: true },
        { name: 'flux-system' },
      ],
    });
    const result = await reconcileRetiredFence(argsFor(cluster));
    expect(result.fenced).toEqual([RETIRED_IP]);
    expect(cluster.writes).toEqual([
      `marker=${RETIRED_ROLE}`,
      'dbMarker',
      'readOnly',
      'flux suspend vibecarbon-base',
      'scale app 0',
      'dropInactiveSlots',
      'walg=standby',
    ]);
    cluster.writes.length = 0;
    await reconcileRetiredFence(argsFor(cluster));
    expect(cluster.writes).toEqual([]);

    // The clear resumes only what the fence suspended, once the side is a replica.
    cluster.db.fileSetting = true;
    cluster.db.inRecovery = true;
    await clearRetiredFence({
      tier: 'k8s-ha',
      ip: RETIRED_IP,
      projectName: 'myapp',
      deps: { sshKeyPath: '/k', kubectl: cluster.kubectl, psql: cluster.psql },
    });
    expect(cluster.writes).toEqual([
      'clearMarker',
      'clearDbMarker',
      'clearReadOnly',
      'flux resume vibecarbon-base',
    ]);
    expect(cluster.state.flux?.find((k) => k.name === 'vibecarbon-production-nbg1')?.suspend).toBe(
      true,
    );
  });

  it('a db pod down at the first read: waits for the db rollout, then fences it in the same run', async () => {
    const cluster = fakeCluster();
    cluster.db.up = false;
    const result = await reconcileRetiredFence(argsFor(cluster));
    expect(result.fenced).toEqual([RETIRED_IP]);
    // The db is down, so the slot drop fails (best-effort); the role still lands.
    expect(cluster.writes).toEqual([
      `marker=${RETIRED_ROLE}`,
      'scale app 0',
      'walg=standby',
      'dbMarker',
      'readOnly',
    ]);
    const rollout = cluster.argvs.findIndex((a) => a.includes('rollout'));
    const touch = cluster.argvs.findIndex((a) => a.join(' ').includes('touch'));
    expect(rollout).toBeGreaterThan(-1);
    expect(rollout).toBeLessThan(touch);
  });

  it('an unreachable retired cluster is reported, and nothing is written', async () => {
    const cluster = fakeCluster();
    cluster.state.reachable = false;
    const warned: string[] = [];
    const result = await reconcileRetiredFence(
      argsFor(cluster, { warn: (l: string) => warned.push(l) }),
    );
    expect(result.fenced).toEqual([]);
    expect(result.unreachable).toEqual([RETIRED_IP]);
    expect(cluster.writes).toEqual([]);
    expect(warned.join('\n')).toMatch(/10\.0\.0\.1/);
  });

  it('a zeroWorkloads seam replaces the app-only default (the add-ons plan extends it)', async () => {
    const cluster = fakeCluster();
    const zeroed: string[] = [];
    await reconcileRetiredFence(
      argsFor(cluster, {
        zeroWorkloads: async (ip: string) => {
          zeroed.push(ip);
          return true;
        },
      }),
    );
    expect(zeroed).toEqual([RETIRED_IP]);
    expect(cluster.writes).not.toContain('scale app 0');
  });

  it('the fence log says the domain is down while DNS still points at the node', async () => {
    const cluster = fakeCluster();
    const logged: string[] = [];
    await reconcileRetiredFence({
      ...argsFor(cluster, { log: (l: string) => logged.push(l) }),
      envConfig: k8sSwapped({ domain: 'app.example.com' }),
    });
    expect(logged.join('\n')).toMatch(
      /if app\.example\.com still points at it, the site is down until its A records move/,
    );
  });

  it('clearRetiredFence removes the markers and the read-only setting, and throws when it cannot', async () => {
    const cluster = fakeCluster({ role: RETIRED_ROLE });
    cluster.state.dbMarker = true;
    cluster.db.fileSetting = true;
    cluster.db.readOnly = true;
    cluster.db.inRecovery = true;
    const deps = { sshKeyPath: '/k', kubectl: cluster.kubectl, psql: cluster.psql };
    expect(
      await clearRetiredFence({ tier: 'k8s-ha', ip: RETIRED_IP, projectName: 'myapp', deps }),
    ).toEqual({ cleared: true });
    expect(cluster.writes).toEqual(['clearMarker', 'clearDbMarker', 'clearReadOnly']);
    expect(cluster.db.fileSetting).toBe(false);
    cluster.state.reachable = false;
    await expect(
      clearRetiredFence({ tier: 'k8s-ha', ip: RETIRED_IP, projectName: 'myapp', deps }),
    ).rejects.toThrow(/retired/);
  });
});

describe('reconcileRetiredFence (compose-ha)', () => {
  const projectConfig = { projectName: 'myapp' };
  const argsFor = (node: ReturnType<typeof fakeNode>) => ({
    environment: 'prod',
    envConfig: composeSwapped(),
    projectConfig,
    tier: 'compose-ha' as const,
    deps: {
      ...quiet,
      sshKeyPath: '/k',
      run: node.run,
      psql: node.psql,
      zeroWorkloads: node.zeroWorkloads,
      demoteWalgRole: node.demoteWalgRole,
    },
  });

  it('fences a returning old primary: markers, db read-only, writers down before the db recreate; then idempotent', async () => {
    const node = fakeNode({ walg: 'primary', running: ['myapp-app', 'myapp-n8n'] });
    const first = await reconcileRetiredFence(argsFor(node));
    expect(first.fenced).toEqual([RETIRED_IP]);
    expect(node.writes).toEqual([
      'hostMarker',
      'dbMarker',
      'readOnly',
      'zeroWorkloads',
      'walg=standby',
    ]);
    expect(node.db.readOnly).toBe(true);

    node.writes.length = 0;
    const second = await reconcileRetiredFence(argsFor(node));
    expect(second.fenced).toEqual([RETIRED_IP]);
    expect(node.writes).toEqual([]);
  });

  it('the probe watches every writer the planned fence stops (the app and the enabled primary-only add-ons)', async () => {
    const envConfig = composeSwapped({ n8n: true });
    const writers = failoverFenceServices(envConfig);
    expect(writers).toEqual(['app', 'n8n']);
    const node = fakeNode();
    await reconcileRetiredFence({ ...argsFor(node), envConfig });
    const probe = node.commands.find((c) => c.includes('PROBE_DONE')) ?? '';
    for (const svc of writers) expect(probe).toContain(`myapp-${svc}`);
    expect(probe).not.toContain('myapp-metabase');
  });

  it('the compose tier refuses to fence without an envConfig (it would shrink the writers to the app)', async () => {
    const node = fakeNode();
    const { fenceRetiredNode } = await import('../../../src/lib/deploy/retired-fence.js');
    await expect(
      fenceRetiredNode({
        tier: 'compose-ha',
        ip: RETIRED_IP,
        projectName: 'myapp',
        sshKeyPath: '/k',
        deps: { ...quiet, run: node.run, psql: node.psql },
      }),
    ).rejects.toThrow(/needs envConfig/);
  });

  it('a db that is down gets its PGDATA marker and read-only fence once the role recreate brings it up', async () => {
    const node = fakeNode({ walg: 'primary', running: [] });
    node.db.up = false;
    const result = await reconcileRetiredFence(argsFor(node));
    expect(result.fenced).toEqual([RETIRED_IP]);
    expect(node.writes).toEqual(['hostMarker', 'walg=standby', 'dbMarker', 'readOnly']);
  });

  it('a db in recovery is not made read-only', async () => {
    const node = fakeNode({ running: [] });
    node.db.inRecovery = true;
    await reconcileRetiredFence(argsFor(node));
    expect(node.writes).not.toContain('readOnly');
  });

  it('an unreachable node is reported with no write', async () => {
    const node = fakeNode();
    node.state.reachable = false;
    const result = await reconcileRetiredFence(argsFor(node));
    expect(result.fenced).toEqual([]);
    expect(result.unreachable).toEqual([RETIRED_IP]);
    expect(node.writes).toEqual([]);
  });

  it('a fence step that fails leaves the node out of `fenced`', async () => {
    const node = fakeNode();
    const result = await reconcileRetiredFence({
      ...argsFor(node),
      deps: { ...argsFor(node).deps, zeroWorkloads: async () => false },
    });
    expect(result.fenced).toEqual([]);
    expect(result.unreachable).toEqual([RETIRED_IP]);
  });

  it('clearRetiredFence removes the host and PGDATA markers and the read-only setting, and throws when it cannot', async () => {
    const node = fakeNode();
    node.state.hostMarker = true;
    node.db.fileSetting = true;
    node.db.inRecovery = true;
    const deps = { sshKeyPath: '/k', run: node.run, psql: node.psql };
    expect(
      await clearRetiredFence({ tier: 'compose-ha', ip: RETIRED_IP, projectName: 'myapp', deps }),
    ).toEqual({ cleared: true });
    expect(node.writes).toEqual(['clear', 'clearReadOnly']);
    expect(node.state.hostMarker).toBe(false);
    expect(node.db.fileSetting).toBe(false);
    node.state.reachable = false;
    await expect(
      clearRetiredFence({ tier: 'compose-ha', ip: RETIRED_IP, projectName: 'myapp', deps }),
    ).rejects.toThrow(/retired/);
  });
});

describe('the fence comes off only a proven replica (a degraded deploy keeps it)', () => {
  it('k8s: a rebuilt side not in recovery keeps the fence: no RESET, Flux stays suspended, the marker stays', async () => {
    const cluster = fakeCluster({ flux: [{ name: 'vibecarbon-base' }] });
    await reconcileRetiredFence({
      environment: 'prod',
      envConfig: k8sSwapped(),
      projectConfig: { projectName: 'myapp' },
      tier: 'k8s-ha',
      deps: { ...quiet, sshKeyPath: '/k', kubectl: cluster.kubectl, psql: cluster.psql },
    });
    cluster.writes.length = 0;
    const warned: string[] = [];
    const result = await clearRetiredFence({
      tier: 'k8s-ha',
      ip: RETIRED_IP,
      projectName: 'myapp',
      deps: {
        sshKeyPath: '/k',
        kubectl: cluster.kubectl,
        psql: cluster.psql,
        warn: (l: string) => warned.push(l),
      },
    });
    expect(result).toEqual({ cleared: false });
    expect(cluster.writes).toEqual([]);
    expect(cluster.db.fileSetting).toBe(true);
    expect(cluster.state.role).toBe(RETIRED_ROLE);
    expect(cluster.state.flux?.[0].suspend).toBe(true);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/^retired side not yet a replica; fence kept/);

    // Once it is a replica the same clear goes through.
    cluster.db.inRecovery = true;
    expect(
      await clearRetiredFence({
        tier: 'k8s-ha',
        ip: RETIRED_IP,
        projectName: 'myapp',
        deps: { sshKeyPath: '/k', kubectl: cluster.kubectl, psql: cluster.psql, warn: () => {} },
      }),
    ).toEqual({ cleared: true });
    expect(cluster.writes).toEqual([
      'clearMarker',
      'clearDbMarker',
      'clearReadOnly',
      'flux resume vibecarbon-base',
    ]);
  });

  it('compose: a side not in recovery keeps the fence with no write; an unreadable db keeps it too', async () => {
    const node = fakeNode();
    node.state.hostMarker = true;
    node.db.fileSetting = true;
    const deps = { sshKeyPath: '/k', run: node.run, psql: node.psql, warn: () => {} };
    expect(
      await clearRetiredFence({ tier: 'compose-ha', ip: RETIRED_IP, projectName: 'myapp', deps }),
    ).toEqual({ cleared: false });
    node.db.up = false;
    expect(
      await clearRetiredFence({ tier: 'compose-ha', ip: RETIRED_IP, projectName: 'myapp', deps }),
    ).toEqual({ cleared: false });
    expect(node.writes).toEqual([]);
    expect(node.state.hostMarker).toBe(true);
  });
});

describe('the db settle is only for db-side parts', () => {
  it('an unreadable Flux API is reported missing without the rollout wait', async () => {
    const cluster = fakeCluster({ flux: [{ name: 'vibecarbon-base' }] });
    const kubectl = async (ip: string, argv: string[]) => {
      if (argv.join(' ').includes('kustomizations') && argv.includes('get')) {
        throw new Error('Unable to connect to the server: net/http: TLS handshake timeout');
      }
      return cluster.kubectl(ip, argv);
    };
    const result = await reconcileRetiredFence({
      environment: 'prod',
      envConfig: k8sSwapped(),
      projectConfig: { projectName: 'myapp' },
      tier: 'k8s-ha',
      deps: { ...quiet, sshKeyPath: '/k', kubectl, psql: cluster.psql },
    });
    expect(result.unreachable).toEqual([RETIRED_IP]);
    expect(cluster.argvs.some((a) => a.includes('rollout'))).toBe(false);
  });
});

describe('the stranded-fence lifter never lifts a retired node', () => {
  it('a write-fence marker naming the retired node is never acted on as the primary', async () => {
    const lifted: string[] = [];
    const verdict = await liftStrandedWriteFence({
      environment: 'prod',
      envConfig: composeSwapped({ ha: { enabled: true, writeFence: { ip: RETIRED_IP } } }),
      rolePrimary: { ip: RETIRED_IP },
      exec: async () => '',
      log: () => {},
      deps: {
        unfence: async () => {
          lifted.push('unfence');
          return true;
        },
        clearMarker: () => {},
      },
    });
    expect(verdict).toBe('retired');
    expect(lifted).toEqual([]);
  });

  it('on the role primary the lifter still works as before', async () => {
    const lifted: string[] = [];
    const verdict = await liftStrandedWriteFence({
      environment: 'prod',
      envConfig: composeSwapped({ ha: { enabled: true, writeFence: { ip: PROMOTED_IP } } }),
      rolePrimary: { ip: PROMOTED_IP },
      exec: async () => '',
      log: () => {},
      deps: {
        unfence: async () => {
          lifted.push('unfence');
          return true;
        },
        clearMarker: () => {},
      },
    });
    expect(verdict).toBe('lifted');
    expect(lifted).toEqual(['unfence']);
  });
});

// ---------------------------------------------------------------------------
// The backup scripts refuse on the marker, before any wal-g (or psql/docker/
// kubectl) call. Each runs for real under bash with stub binaries on PATH that
// record whether they were invoked.
// ---------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), 'retired-fence-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function stubBin(dir: string, names: string[]) {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  for (const name of names) {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 0\n`);
    chmodSync(path, 0o755);
  }
  return () => readFileSync(log, 'utf-8');
}

describe('wal-archive.sh refuses on a retired node', () => {
  const script = join(repoRoot, 'carbon/volumes/db/wal-archive.sh');
  const runArchive = (marker: boolean) => {
    const base = mkdtempSync(join(scratch, 'wal-'));
    const pgdata = join(base, 'pgdata');
    mkdirSync(pgdata);
    if (marker) writeFileSync(join(pgdata, RETIRED_DB_MARKER), '');
    const calls = stubBin(join(base, 'bin'), ['wal-g', 'psql']);
    const r = spawnSync('bash', [script, 'pg_wal/000000010000000000000001'], {
      encoding: 'utf-8',
      env: {
        PATH: `${join(base, 'bin')}:${process.env.PATH}`,
        PGDATA: pgdata,
        WALG_S3_PREFIX: 's3://bucket/backups/acme',
        WALG_ROLE: 'primary',
        WAL_ARCHIVE_RETRIES: '1',
        WAL_ARCHIVE_SLEEP: '0',
      },
      timeout: 10_000,
    });
    return { ...r, calls: calls() };
  };

  it('with the PGDATA marker: exit 1, one line, no psql and no wal-g', () => {
    const r = runArchive(true);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(RETIRED_REFUSAL);
    expect(r.stderr).not.toContain('WAL_ARCHIVE_FAILED');
    expect(r.calls).toBe('');
  });

  it('without it the script carries on to the recovery probe and wal-g (control)', () => {
    const r = runArchive(false);
    expect(r.stderr).not.toContain(RETIRED_REFUSAL);
    expect(r.calls).toContain('psql');
    expect(r.stderr).toContain('WAL_ARCHIVE_FAILED');
  });
});

describe('compose-backup.sh refuses on a retired node', () => {
  const script = join(repoRoot, 'carbon/backup/compose-backup.sh');
  const runBackup = (marker: boolean) => {
    const base = mkdtempSync(join(scratch, 'cb-'));
    if (marker) writeFileSync(join(base, RETIRED_HOST_MARKER), '');
    const calls = stubBin(join(base, 'bin'), ['docker', 'wal-g']);
    const r = spawnSync('bash', [script], {
      cwd: base,
      encoding: 'utf-8',
      env: { PATH: `${join(base, 'bin')}:${process.env.PATH}`, RETAIN: '3' },
      timeout: 10_000,
    });
    return { ...r, calls: calls() };
  };

  it('with the host marker: exit 1 naming the refusal, docker never invoked', () => {
    const r = runBackup(true);
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain(RETIRED_REFUSAL);
    expect(r.calls).toBe('');
  });

  it('without it the backup reaches docker compose exec (control)', () => {
    const r = runBackup(false);
    expect(r.status).toBe(0);
    expect(r.calls).toContain('docker compose exec');
  });
});

describe('the k8s backup CronJob refuses on a retired cluster', () => {
  const cron = loadYaml(
    readFileSync(join(repoRoot, 'carbon/k8s/base/backup/cronjob.yaml'), 'utf-8'),
  ) as {
    spec: {
      jobTemplate: {
        spec: {
          template: {
            spec: {
              containers: Array<{
                command: string[];
                env: Array<{
                  name: string;
                  valueFrom?: { configMapKeyRef?: Record<string, unknown> };
                }>;
              }>;
            };
          };
        };
      };
    };
  };
  const container = cron.spec.jobTemplate.spec.template.spec.containers[0];
  const body = container.command[2];

  it('reads the marker from vibecarbon-config per job (optional, so an older cluster still runs)', () => {
    const env = container.env.find((e) => e.name === RETIRED_ROLE_KEY);
    expect(env?.valueFrom?.configMapKeyRef).toEqual({
      name: 'vibecarbon-config',
      key: RETIRED_ROLE_KEY,
      optional: true,
    });
  });

  const runJob = (role: string | undefined) => {
    const base = mkdtempSync(join(scratch, 'cj-'));
    const calls = stubBin(join(base, 'bin'), ['kubectl', 'wal-g']);
    const r = spawnSync('bash', ['-c', body], {
      encoding: 'utf-8',
      env: {
        PATH: `${join(base, 'bin')}:${process.env.PATH}`,
        ...(role !== undefined && { [RETIRED_ROLE_KEY]: role }),
      },
      timeout: 10_000,
    });
    return { ...r, calls: calls() };
  };

  it(`with ${RETIRED_ROLE_KEY}=${RETIRED_ROLE}: exit 1 before kubectl exec reaches wal-g`, () => {
    const r = runJob(RETIRED_ROLE);
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain(RETIRED_REFUSAL);
    expect(r.calls).toBe('');
  });

  it('unset or empty, the job execs into the db pod as before (control)', () => {
    for (const role of [undefined, '']) {
      const r = runJob(role);
      expect(r.status).toBe(0);
      expect(r.calls).toContain('kubectl exec');
    }
  });
});
