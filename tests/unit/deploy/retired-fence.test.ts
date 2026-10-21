/**
 * Self-enforcing retirement (HA-correctness Task 6, R7).
 *
 * A failover can finish with the old primary unreachable and un-demoted (that
 * is usually why it ran). When that node comes back it still believes it is
 * the primary: its app serves, its WAL archiver and nightly base backup push
 * into the shared prefix the new primary owns, and `wal-g delete retain` can
 * prune the new primary's backups. So the retired side is fenced by a marker it
 * enforces itself, and every HA command (status, failover, deploy) re-applies
 * it on any reachable side the persisted roles call retired:
 *   - a marker each backup script refuses on (k8s: VIBECARBON_ROLE=retired in
 *     vibecarbon-config; compose: <remoteDir>/.vibecarbon-retired; both: a
 *     `vibecarbon-retired` file in PGDATA, the only marker the db container's
 *     archive_command can see);
 *   - its writers at zero (k8s: `kubectl scale`, never a patch that rolls pods);
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
import { FAILOVER_FENCE_SERVICES } from '../../../src/lib/deploy/compose/ha.js';
import {
  clearRetiredFence,
  RETIRED_DB_MARKER,
  RETIRED_HOST_MARKER,
  RETIRED_REFUSAL,
  RETIRED_ROLE,
  RETIRED_ROLE_KEY,
  reconcileRetiredFence,
  retiredSides,
} from '../../../src/lib/deploy/retired-fence.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const RETIRED_IP = '10.0.0.1';
const PROMOTED_IP = '10.0.0.9';

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

/** A fake k8s cluster behind `kubectl`, recording every mutating call. */
function fakeCluster(init: { replicas?: number; walg?: string; role?: string } = {}) {
  const state = {
    role: init.role ?? '',
    replicas: init.replicas ?? 2,
    walg: init.walg ?? 'primary',
    dbMarker: false,
    reachable: true,
  };
  const writes: string[] = [];
  const argvs: string[][] = [];
  const kubectl = async (ip: string, argv: string[]) => {
    expect(ip).toBe(RETIRED_IP);
    if (!state.reachable) throw new Error('ssh: connect to host 10.0.0.1 port 22: timed out');
    argvs.push(argv);
    const a = argv.join(' ');
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
    if (argv.includes('exec') && a.includes('[ -f')) return state.dbMarker ? 'present' : 'absent';
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
  return { state, writes, argvs, kubectl };
}

/** A fake compose node behind the compose ssh runner (false = remote failure). */
function fakeNode(init: { walg?: string; running?: string[] } = {}) {
  const state = {
    hostMarker: false,
    dbMarker: false,
    walg: init.walg ?? 'primary',
    running: init.running ?? ['myapp-app', 'myapp-n8n'],
    reachable: true,
    dbUp: true,
  };
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
        `DB_MARKER=${state.dbUp ? (state.dbMarker ? 'present' : 'absent') : 'unknown'}`,
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
      if (!state.dbUp) return false;
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
    state.dbUp = true;
    return true;
  };
  return { state, writes, commands, run, zeroWorkloads, demoteWalgRole };
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
  });
});

describe('reconcileRetiredFence (k8s-ha)', () => {
  const projectConfig = { projectName: 'myapp' };

  it('an unswapped env makes no call at all', async () => {
    const cluster = fakeCluster();
    const result = await reconcileRetiredFence({
      environment: 'prod',
      envConfig: k8sSwapped({ lastFailover: undefined }),
      projectConfig,
      tier: 'k8s-ha',
      deps: { ...quiet, sshKeyPath: '/k', kubectl: cluster.kubectl },
    });
    expect(result).toEqual({ fenced: [], unreachable: [] });
    expect(cluster.argvs).toEqual([]);
  });

  it('fences a reachable retired cluster (app 2, WALG_ROLE=primary); a second run writes nothing', async () => {
    const cluster = fakeCluster({ replicas: 2, walg: 'primary' });
    const args = {
      environment: 'prod',
      envConfig: k8sSwapped(),
      projectConfig,
      tier: 'k8s-ha' as const,
      deps: { ...quiet, sshKeyPath: '/k', kubectl: cluster.kubectl },
    };
    const first = await reconcileRetiredFence(args);
    expect(first).toEqual({ fenced: [RETIRED_IP], unreachable: [] });
    expect(cluster.writes).toEqual([
      `marker=${RETIRED_ROLE}`,
      'dbMarker',
      'scale app 0',
      'walg=standby',
    ]);
    // The app is zeroed with `kubectl scale`, never a patch or set image that
    // would roll its pods.
    const appWrites = cluster.argvs.filter((a) => a.join(' ').includes('app'));
    for (const a of appWrites) {
      expect(a).not.toContain('patch');
      expect(a).not.toContain('image');
    }

    cluster.writes.length = 0;
    const second = await reconcileRetiredFence(args);
    expect(second).toEqual({ fenced: [RETIRED_IP], unreachable: [] });
    expect(cluster.writes).toEqual([]);
  });

  it('an unreachable retired cluster is reported, and nothing is written', async () => {
    const cluster = fakeCluster();
    cluster.state.reachable = false;
    const warned: string[] = [];
    const result = await reconcileRetiredFence({
      environment: 'prod',
      envConfig: k8sSwapped(),
      projectConfig,
      tier: 'k8s-ha',
      deps: {
        log: () => {},
        warn: (l: string) => warned.push(l),
        sshKeyPath: '/k',
        kubectl: cluster.kubectl,
      },
    });
    expect(result).toEqual({ fenced: [], unreachable: [RETIRED_IP] });
    expect(cluster.writes).toEqual([]);
    expect(warned.join('\n')).toMatch(/10\.0\.0\.1/);
  });

  it('a zeroWorkloads seam replaces the app-only default (the add-ons plan extends it)', async () => {
    const cluster = fakeCluster();
    const zeroed: string[] = [];
    await reconcileRetiredFence({
      environment: 'prod',
      envConfig: k8sSwapped(),
      projectConfig,
      tier: 'k8s-ha',
      deps: {
        ...quiet,
        sshKeyPath: '/k',
        kubectl: cluster.kubectl,
        zeroWorkloads: async (ip: string) => {
          zeroed.push(ip);
          return true;
        },
      },
    });
    expect(zeroed).toEqual([RETIRED_IP]);
    expect(cluster.writes).not.toContain('scale app 0');
  });

  it('clearRetiredFence removes both markers, and throws when it cannot', async () => {
    const cluster = fakeCluster({ role: RETIRED_ROLE });
    cluster.state.dbMarker = true;
    await clearRetiredFence({
      tier: 'k8s-ha',
      ip: RETIRED_IP,
      projectName: 'myapp',
      deps: { sshKeyPath: '/k', kubectl: cluster.kubectl },
    });
    expect(cluster.writes).toEqual(['clearMarker', 'clearDbMarker']);
    cluster.state.reachable = false;
    await expect(
      clearRetiredFence({
        tier: 'k8s-ha',
        ip: RETIRED_IP,
        projectName: 'myapp',
        deps: { sshKeyPath: '/k', kubectl: cluster.kubectl },
      }),
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
      zeroWorkloads: node.zeroWorkloads,
      demoteWalgRole: node.demoteWalgRole,
    },
  });

  it('fences a returning old primary: marker first, writers down before the db recreate; then idempotent', async () => {
    const node = fakeNode({ walg: 'primary', running: ['myapp-app', 'myapp-n8n'] });
    const first = await reconcileRetiredFence(argsFor(node));
    expect(first).toEqual({ fenced: [RETIRED_IP], unreachable: [] });
    expect(node.writes).toEqual(['hostMarker', 'dbMarker', 'zeroWorkloads', 'walg=standby']);

    node.writes.length = 0;
    const second = await reconcileRetiredFence(argsFor(node));
    expect(second).toEqual({ fenced: [RETIRED_IP], unreachable: [] });
    expect(node.writes).toEqual([]);
  });

  it('the probe watches every writer the planned fence stops (app, n8n, metabase)', async () => {
    expect(FAILOVER_FENCE_SERVICES).toEqual(expect.arrayContaining(['app', 'n8n', 'metabase']));
    const node = fakeNode();
    await reconcileRetiredFence(argsFor(node));
    const probe = node.commands.find((c) => c.includes('PROBE_DONE')) ?? '';
    for (const svc of FAILOVER_FENCE_SERVICES) expect(probe).toContain(`myapp-${svc}`);
  });

  it('a db that is down gets its PGDATA marker once the role recreate brings it up', async () => {
    const node = fakeNode({ walg: 'primary', running: [] });
    node.state.dbUp = false;
    const result = await reconcileRetiredFence(argsFor(node));
    expect(result.fenced).toEqual([RETIRED_IP]);
    expect(node.writes).toEqual(['hostMarker', 'walg=standby', 'dbMarker']);
  });

  it('an unreachable node is reported with no write', async () => {
    const node = fakeNode();
    node.state.reachable = false;
    const result = await reconcileRetiredFence(argsFor(node));
    expect(result).toEqual({ fenced: [], unreachable: [RETIRED_IP] });
    expect(node.writes).toEqual([]);
  });

  it('a fence step that fails leaves the node out of `fenced`', async () => {
    const node = fakeNode();
    const result = await reconcileRetiredFence({
      ...argsFor(node),
      deps: { ...argsFor(node).deps, zeroWorkloads: async () => false },
    });
    expect(result).toEqual({ fenced: [], unreachable: [RETIRED_IP] });
  });

  it('clearRetiredFence removes the host and PGDATA markers, and throws when it cannot', async () => {
    const node = fakeNode();
    node.state.hostMarker = true;
    await clearRetiredFence({
      tier: 'compose-ha',
      ip: RETIRED_IP,
      projectName: 'myapp',
      deps: { sshKeyPath: '/k', run: node.run },
    });
    expect(node.writes).toEqual(['clear']);
    expect(node.state.hostMarker).toBe(false);
    node.state.reachable = false;
    await expect(
      clearRetiredFence({
        tier: 'compose-ha',
        ip: RETIRED_IP,
        projectName: 'myapp',
        deps: { sshKeyPath: '/k', run: node.run },
      }),
    ).rejects.toThrow(/retired/);
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
