/**
 * k8s `deploy -restore` restores (C1).
 *
 * Before: the flag travelled to applyK3sManifests, which documented it as
 * "accepted for the caller's input hash and ignored here". Nothing set the
 * restore marker, so the fresh db pod's walg-restore init booted an empty
 * database and the deploy reported success.
 *
 * Now (C5): the orchestrator resolves the exact base backup from the bucket's
 * stop sentinels (resolveDeployRestorePoint, the same resolution `vibecarbon
 * restore` uses) and passes options.restore = { backup, target, recoveryConf,
 * sizeBytes }. deployK3s asserts it is complete before anything runs;
 * applyK3sManifests writes the marker into vibecarbon-infra-secrets before the
 * db StatefulSet applies, waits for the db with the size-scaled budget (C13),
 * proves the restored primary promoted and takes writes, and only then
 * retires the previous cluster, clears the marker and rolls the app.
 *
 * The applyK3sManifests cases drive the real function with only node's
 * `spawn` mocked (the same seam as k3s-apply-manifests-ordering.test.ts).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: vi.fn() };
});

const k3s = await import('../../../src/lib/deploy/k8s/k3s.js');
const {
  buildInfraSecretData,
  applyK3sManifests,
  assertDeployRestorePoint,
  assertRestoreMarkerState,
  deployK3s,
  DB_ROLLOUT_TIMEOUT_S,
} = k3s;
const { RESTORE_MARKER_KEYS, restoreMarkerStringData } = await import(
  '../../../src/lib/walg/restore-layout.js'
);
const { assertDeployRestoreAllowed, NoRestorePointError, resolveDeployRestorePoint } = await import(
  '../../../src/lib/walg/restore-base.js'
);
const { buildRecoveryConfig, renderRecoveryConf } = await import(
  '../../../src/lib/walg/recovery-config.js'
);
const { restoreRolloutTimeoutS } = await import('../../../src/lib/deploy/replication.js');

const BACKUP = 'base_000000010000000000000003';
const LINEAGE = '7699032860122738725';
const RESTORE = {
  backup: BACKUP,
  target: 'latest',
  recoveryConf: renderRecoveryConf(buildRecoveryConfig({ target: 'latest', lineage: LINEAGE })),
  sizeBytes: 50 * 1024 ** 3,
  attempt: '0f1e2d3c-0000-4000-8000-00000000000a',
  lineage: LINEAGE,
};

// ---------------------------------------------------------------------------
// buildInfraSecretData
// ---------------------------------------------------------------------------

describe('buildInfraSecretData carries the restore marker', () => {
  it('writes all three marker keys with a restore point', () => {
    const data = buildInfraSecretData({ envLocal: {}, restore: RESTORE });
    expect(data.RESTORE_BACKUP).toBe(BACKUP);
    expect(data.RESTORE_TARGET).toBe('latest');
    expect(data.RESTORE_RECOVERY_CONF).toBe(RESTORE.recoveryConf);
    expect(data.RESTORE_ATTEMPT).toBe(RESTORE.attempt);
    expect(data.RESTORE_ORIGIN).toBe('deploy');
    expect(data.RESTORE_LINEAGE).toBe(LINEAGE);
  });

  it('writes none without one, so an apply leaves a `vibecarbon restore` marker alone', () => {
    for (const restore of [undefined, null]) {
      const data = buildInfraSecretData({ envLocal: {}, restore });
      for (const k of RESTORE_MARKER_KEYS) expect(data).not.toHaveProperty(k);
    }
  });
});

// ---------------------------------------------------------------------------
// The orchestrator's resolution (resolveDeployRestorePoint)
// ---------------------------------------------------------------------------

/**
 * A fake S3 that answers sentinel listings, and records every command it saw.
 * The bases sit in one lineage folder (LINEAGE): the base listing (Delimiter,
 * at the env prefix) answers it as a CommonPrefix.
 */
function fakeS3(names: Array<{ name: string; finish: string; size?: number }>) {
  const seen: string[] = [];
  return {
    seen,
    async send(cmd: { constructor: { name: string }; input: { Key?: string; Prefix?: string } }) {
      seen.push(cmd.constructor.name);
      if (cmd.constructor.name === 'ListObjectsV2Command') {
        if (cmd.input.Prefix === 'backups/proj/prod/walg/') {
          return { CommonPrefixes: [{ Prefix: `backups/proj/prod/walg/${LINEAGE}/` }] };
        }
        return {
          Contents: names.map((b) => ({
            Key: `backups/proj/prod/walg/${LINEAGE}/basebackups_005/${b.name}_backup_stop_sentinel.json`,
          })),
        };
      }
      const b = names.find((x) => cmd.input.Key?.includes(x.name));
      return {
        Body: {
          transformToString: async () =>
            JSON.stringify({
              FinishTime: b?.finish,
              CompressedSize: b?.size ?? 1000,
              UncompressedSize: 4000,
            }),
        },
      };
    },
  };
}

const S3 = {
  bucket: 'proj-storage',
  endpoint: 'https://fsn1.example.test',
  region: 'fsn1',
  accessKey: 'AK',
  secretKey: 'SK',
  walgPrefix: 'backups/proj/prod/walg',
};

describe('resolveDeployRestorePoint', () => {
  const two = [
    { name: 'base_000000010000000000000002', finish: '2026-10-19T10:00:00Z', size: 111 },
    { name: BACKUP, finish: '2026-10-20T10:00:00Z', size: 222 },
  ];
  const resolve = (restore: string | null, s3 = fakeS3(two), extra = {}) =>
    resolveDeployRestorePoint({
      restore,
      k8s: true,
      s3Config: S3,
      backupBucketName: 'proj-backups',
      credentialVars: 'HETZNER_S3_ACCESS_KEY and HETZNER_S3_SECRET_KEY',
      makeClient: async () => s3,
      ...extra,
    });

  it('is null for a deploy without -restore', async () => {
    expect(await resolve(null)).toBeNull();
  });

  it('latest: the newest base, with its recovery config and size', async () => {
    const point = await resolve('latest');
    expect(point).toEqual({ ...RESTORE, sizeBytes: 222, attempt: expect.any(String) });
    // A new attempt every time: the init container's repeat guard keys on it.
    const again = await resolve('latest');
    expect(again?.attempt).toMatch(/^[0-9a-f-]{36}$/);
    expect(again?.attempt).not.toBe(point?.attempt);
  });

  it('an exact base name restores that base and replays all WAL', async () => {
    const point = await resolve('base_000000010000000000000002');
    expect(point?.backup).toBe('base_000000010000000000000002');
    expect(point?.target).toBe('latest');
  });

  it('a point in time picks the newest base that finished before it', async () => {
    const point = await resolve('2026-10-19T12:00:00Z');
    expect(point?.backup).toBe('base_000000010000000000000002');
    expect(point?.recoveryConf).toContain("recovery_target_time = '2026-10-19T12:00:00Z'");
  });

  it('lists the wal-g prefix in the backup bucket, read-only', async () => {
    const s3 = fakeS3(two);
    await resolve('latest', s3);
    expect(new Set(s3.seen)).toEqual(new Set(['ListObjectsV2Command', 'GetObjectCommand']));
  });

  it('no base backup at all: NoRestorePointError naming where it looked', async () => {
    const err = await resolve('latest', fakeS3([])).catch((e) => e);
    expect(err).toBeInstanceOf(NoRestorePointError);
    expect(err.message).toContain('s3://proj-backups/backups/proj/prod/walg');
  });

  it('refuses a restore point that is not latest, a base name or an instant', async () => {
    await expect(resolve('yesterday')).rejects.toThrow(/not a restore point/);
  });

  it('refuses compose: deploy -restore is k8s and k8s-ha only', async () => {
    await expect(resolve('latest', fakeS3(two), { k8s: false })).rejects.toThrow(
      /k8s and k8s-ha only/,
    );
  });

  it('names the credential variables, never a value, when credentials are missing', async () => {
    const err = await resolve('latest', fakeS3(two), {
      s3Config: { ...S3, accessKey: '', secretKey: '' },
    }).catch((e) => e);
    expect(err.message).toContain('HETZNER_S3_ACCESS_KEY and HETZNER_S3_SECRET_KEY');
  });
});

// ---------------------------------------------------------------------------
// The orchestrator's first refusals (M1), before anything is saved or minted
// ---------------------------------------------------------------------------

describe('assertDeployRestoreAllowed', () => {
  const allowed = (extra = {}) =>
    assertDeployRestoreAllowed({
      restore: 'latest',
      k8s: true,
      environment: 'prod',
      deployedAt: null,
      ...extra,
    });

  it('passes no -restore, and -restore onto a destroyed or fresh environment', () => {
    expect(() => allowed({ restore: null, deployedAt: '2026-10-20T10:00:00Z' })).not.toThrow();
    expect(() => allowed()).not.toThrow();
  });

  it('refuses an environment with a completed deploy on record, naming it', () => {
    expect(() => allowed({ deployedAt: '2026-10-20T10:00:00Z' })).toThrow(
      /prod already runs a database[\s\S]*\n {2}vibecarbon restore prod -source latest\n/,
    );
  });

  it('refuses compose', () => {
    expect(() => allowed({ k8s: false })).toThrow(/k8s and k8s-ha only/);
  });

  it('the orchestrator calls it before the first skeleton save', () => {
    const src = readFileSync(join(__dirname, '../../../src/lib/deploy/orchestrator.js'), 'utf-8');
    const call = src.indexOf('assertDeployRestoreAllowed({');
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(src.indexOf('  saveSkeletonEnv();'));
  });
});

// ---------------------------------------------------------------------------
// deployK3s refuses an incomplete restore point before anything runs
// ---------------------------------------------------------------------------

describe('assertDeployRestorePoint', () => {
  it('accepts no restore and a complete one', () => {
    expect(() => assertDeployRestorePoint({ restore: null })).not.toThrow();
    expect(() => assertDeployRestorePoint({ restore: RESTORE })).not.toThrow();
  });

  it.each([
    ['a raw flag string', 'latest'],
    ['no backup', { ...RESTORE, backup: '' }],
    ['no recovery config', { ...RESTORE, recoveryConf: '' }],
    ['no target', { ...RESTORE, target: '' }],
    ['no size', { ...RESTORE, sizeBytes: undefined }],
    ['no attempt', { ...RESTORE, attempt: '' }],
    ['no lineage', { ...RESTORE, lineage: '' }],
  ])('refuses %s', (_label, restore) => {
    expect(() => assertDeployRestorePoint({ restore })).toThrow(/restore point/);
  });

  it('deployK3s refuses it before any command runs', async () => {
    vi.mocked(spawn).mockReset();
    await expect(
      deployK3s({
        restore: { backup: BACKUP },
        state: {},
        projectName: 'proj',
        environment: 'prod',
      }),
    ).rejects.toThrow(/restore point/);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// applyK3sManifests: marker before the db, proof before the clear
// ---------------------------------------------------------------------------

let calls: string[][] = [];
let stdin: { seq: number; data: string }[] = [];
let dbRolloutExit = 0;
let fence = 'off';
// A db StatefulSet already in the cluster, the restore marker its infra
// Secret carries (plain; the mock answers base64 as kubectl does), and what
// the db pod's PGDATA shows (null: the pod cannot be exec'd).
let liveDbSts = false;
/** The backup files inside the rendered dir `kubectl apply -k` was handed. */
let appliedBackup: { cronjob: string; configmap: string } | null = null;
let marker: Record<string, string> = {};
let pgdataState: string | null = '';
let markerClearExit = 0;

function child(exitCode: number, stdout = '') {
  const c: Record<string, unknown> = {
    stdout: {
      on(ev: string, cb: (b: Buffer) => void) {
        if (ev === 'data' && stdout) Promise.resolve().then(() => cb(Buffer.from(stdout)));
      },
    },
    stderr: { on() {} },
    stdin: {
      write(d: unknown) {
        stdin.push({ seq: calls.length - 1, data: String(d) });
      },
      end() {},
    },
    kill() {},
    unref() {},
    on(ev: string, cb: (code: number) => void) {
      if (ev === 'exit' || ev === 'close') Promise.resolve().then(() => cb(exitCode));
      return c;
    },
  };
  return c as unknown as ReturnType<typeof spawn>;
}

const APP_RS = JSON.stringify({
  items: [
    {
      metadata: {
        annotations: { 'deployment.kubernetes.io/revision': '1' },
        labels: { 'pod-template-hash': 'abc' },
      },
    },
  ],
});
const APP_PODS = JSON.stringify({
  items: [{ metadata: { name: 'app-abc-1', creationTimestamp: '2026-10-20T00:00:00Z' } }],
});

function installSpawn() {
  vi.mocked(spawn).mockImplementation(((cmd: string, args: string[] = []) => {
    calls.push([cmd, ...args]);
    const has = (s: string) => args.includes(s);
    if (cmd === 'kubectl' && has('apply') && has('-k') && args.some((a) => /k8s-base/.test(a))) {
      const dir = args[args.indexOf('-k') + 1];
      appliedBackup = {
        cronjob: readFileSync(join(dir, 'backup/cronjob.yaml'), 'utf-8'),
        configmap: readFileSync(join(dir, 'config/configmap.yaml'), 'utf-8'),
      };
    }
    const sql = args.find((a) => /SELECT|ANALYZE/i.test(a)) ?? '';
    if (cmd === 'kubectl' && has('rollout') && has('status') && has('statefulset/db')) {
      return child(dbRolloutExit);
    }
    if (cmd === 'kubectl' && has('get') && has('statefulset') && has('db')) {
      return child(0, liveDbSts ? 'statefulset.apps/db\n' : '');
    }
    if (cmd === 'kubectl' && has('jsonpath={.data}')) {
      const data = Object.fromEntries(
        Object.entries(marker).map(([k, v]) => [k, Buffer.from(v).toString('base64')]),
      );
      return child(0, JSON.stringify(data));
    }
    if (
      cmd === 'kubectl' &&
      has('patch') &&
      has('vibecarbon-infra-secrets') &&
      args.some((x) => x.includes('"RESTORE_BACKUP":""'))
    ) {
      return child(markerClearExit);
    }
    if (cmd === 'kubectl' && has('exec') && args.some((a) => a.includes('.vc-restored-from'))) {
      return pgdataState === null ? child(1) : child(0, pgdataState);
    }
    if (cmd === 'kubectl' && has('exec') && /pg_is_in_recovery/.test(sql)) return child(0, 'f\n');
    if (cmd === 'kubectl' && has('exec') && /default_transaction_read_only/.test(sql)) {
      return child(fence === 'unreadable' ? 1 : 0, `${fence}\n`);
    }
    if (cmd === 'kubectl' && has('get') && has('replicasets')) return child(0, APP_RS);
    if (cmd === 'kubectl' && has('get') && has('pods')) return child(0, APP_PODS);
    if (
      cmd === 'kubectl' &&
      has('get') &&
      has('secret') &&
      has('jsonpath={.metadata.resourceVersion}')
    ) {
      return child(0, '1');
    }
    if (cmd === 'kubectl' && has('exec') && has('-tAc')) return child(0, '');
    return child(0, cmd === 'kubectl' && has('exec') ? '1\n' : '');
  }) as unknown as typeof spawn);
}

function projectDir() {
  const dir = mkdtempSync(join(tmpdir(), 'vc-deploy-restore-'));
  mkdirSync(join(dir, 'k8s', 'base', 'db'), { recursive: true });
  writeFileSync(join(dir, 'k8s', 'base', 'kustomization.yaml'), 'resources:\n  - db/\n');
  writeFileSync(
    join(dir, 'k8s', 'base', 'db', 'statefulset.yaml'),
    readFileSync(join(__dirname, '../../../carbon/k8s/base/db/statefulset.yaml'), 'utf-8'),
  );
  mkdirSync(join(dir, 'k8s', 'base', 'backup'), { recursive: true });
  mkdirSync(join(dir, 'k8s', 'base', 'config'), { recursive: true });
  for (const f of ['backup/cronjob.yaml', 'config/configmap.yaml']) {
    writeFileSync(
      join(dir, 'k8s', 'base', f),
      readFileSync(join(__dirname, '../../../carbon/k8s/base', f), 'utf-8'),
    );
  }
  return dir;
}

function args(restore: typeof RESTORE | null) {
  const dir = projectDir();
  return {
    kubeconfig: join(dir, 'kubeconfig'),
    projectDir: dir,
    projectName: 'proj',
    imageTag: '10.0.1.1:5000/proj:abc-20260101000000',
    dbImageTag: 'ghcr.io/org/postgres:17-walg',
    envLocal: {
      ADMIN_EMAIL: 'a@example.test',
      ADMIN_PASSWORD: 'pw',
      BETTER_AUTH_SECRET: 'x'.repeat(40),
    },
    domain: 'app.example.test',
    restore,
    apiToken: 'token',
    providerId: 'hetzner',
    ProviderClass: {
      PROVIDER_ID_PREFIX: 'hcloud://',
      K8S_IMAGE: 'ubuntu-24.04',
      K8S_STORAGE_CLASS: 'hcloud-volumes',
      async getK8sWorkerUserData() {
        return '#cloud-config\n';
      },
    },
    region: 'nbg1',
    environment: 'prod',
    minWorkers: 1,
    maxWorkers: 3,
    workerServerType: 'cx23',
    dbPrivateIp: '10.0.1.2',
    k3sToken: 'k3s-token',
    masterIp: '1.2.3.4',
    sshKeyPath: '/tmp/key',
    khPath: join(dir, 'known_hosts'),
    perfPrefix: 'k3s',
  };
}

const idx = (pred: (a: string[]) => boolean) => calls.findIndex(pred);
const infraSecretApply = () => stdin.find((s) => s.data.includes('name: vibecarbon-infra-secrets'));
const isBaseApply = (a: string[]) =>
  a[0] === 'kubectl' &&
  a.includes('apply') &&
  a.includes('-k') &&
  a.some((x) => /k8s-base/.test(x));
const isDbWait = (a: string[]) =>
  a[0] === 'kubectl' && a.includes('rollout') && a.includes('statefulset/db');
const isPromotedCheck = (a: string[]) =>
  a.includes('exec') && a.some((x) => /pg_is_in_recovery/.test(x));
const isFenceCheck = (a: string[]) =>
  a.includes('exec') && a.some((x) => /default_transaction_read_only/.test(x));
const isMarkerClear = (a: string[]) =>
  a[0] === 'kubectl' &&
  a.includes('patch') &&
  a.includes('vibecarbon-infra-secrets') &&
  a.some((x) => x.includes('"RESTORE_BACKUP":""'));
const isRetire = (a: string[]) => a.includes('exec') && a.some((x) => x.includes('.vc-prev'));
const isRemoveDiscard = (a: string[]) =>
  a.includes('exec') &&
  a.some((x) => /^rm -f .*\.vc-restored-from && rm -rf .*\.vc-discard$/.test(x));
const isAppPatch = (a: string[]) =>
  a[0] === 'kubectl' && a.includes('patch') && a.includes('deployment/app');

describe('applyK3sManifests with a restore point', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    calls = [];
    stdin = [];
    dbRolloutExit = 0;
    fence = 'off';
    liveDbSts = false;
    marker = {};
    pgdataState = 'VC_OK\n';
    markerClearExit = 0;
    installSpawn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: { method?: string }) => {
        const method = init?.method ?? 'GET';
        const headers = {
          get: (h: string) =>
            method === 'POST' && h.toLowerCase() === 'location' ? `${String(url)}u1` : null,
        };
        return { status: method === 'PUT' ? 201 : method === 'HEAD' ? 200 : 202, headers };
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks the restore before the db applies, proves it, then clears it and rolls the app', async () => {
    await applyK3sManifests(args(RESTORE));

    const secret = infraSecretApply();
    expect(secret?.data).toContain(`RESTORE_BACKUP: "${BACKUP}"`);
    expect(secret?.data).toContain('RESTORE_TARGET: "latest"');
    expect(secret?.data).toContain('RESTORE_RECOVERY_CONF:');

    const order = [
      secret?.seq ?? -1,
      idx(isBaseApply),
      idx(isDbWait),
      idx(isPromotedCheck),
      idx(isFenceCheck),
      idx(isRetire),
      idx(isMarkerClear),
      idx(isRemoveDiscard),
      idx(isAppPatch),
    ];
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('waits for the db with the size-scaled restore budget (C13)', async () => {
    await applyK3sManifests(args(RESTORE));
    const wait = calls.find(isDbWait) as string[];
    const expected = Math.max(DB_ROLLOUT_TIMEOUT_S, restoreRolloutTimeoutS(RESTORE.sizeBytes));
    expect(expected).toBeGreaterThan(DB_ROLLOUT_TIMEOUT_S);
    expect(wait).toContain(`--timeout=${expected}s`);
  });

  it('a db that does not come back leaves the marker set and rolls nothing', async () => {
    dbRolloutExit = 1;
    await expect(applyK3sManifests(args(RESTORE))).rejects.toThrow(/statefulset\/db/);
    expect(infraSecretApply()?.data).toContain(`RESTORE_BACKUP: "${BACKUP}"`);
    expect(calls.some(isMarkerClear)).toBe(false);
    expect(calls.some(isAppPatch)).toBe(false);
  });

  it('a marker clear that fails after the proof says the copy is proven and names what is left', async () => {
    markerClearExit = 1;
    const err = await applyK3sManifests(args(RESTORE)).catch((e) => e);
    expect(err.message).toMatch(/proven writable/);
    expect(err.message).toMatch(/clearing the restore marker failed/);
    expect(lines(err.message)).toContain(CLEAR);
    expect(calls.some(isRetire)).toBe(true);
    expect(calls.some(isRemoveDiscard)).toBe(false);
    expect(calls.some(isAppPatch)).toBe(false);
  });

  it('an unproven write fence keeps the marker and prints the commands that finish it', async () => {
    fence = 'unreadable';
    const err = await applyK3sManifests(args(RESTORE)).catch((e) => e);
    expect(err.message).toMatch(/could not prove the restored database writable/);
    expect(err.message).toContain('kubectl -n vibecarbon patch secret vibecarbon-infra-secrets');
    expect(err.message).toContain('SHOW default_transaction_read_only');
    expect(calls.some(isMarkerClear)).toBe(false);
    expect(calls.some(isRetire)).toBe(false);
    expect(calls.some(isAppPatch)).toBe(false);
  });

  const markerEnv = { ...process.env, KUBECONFIG: '/tmp/kc' };

  const pending = (over: Record<string, string> = {}) => ({
    RESTORE_BACKUP: BACKUP,
    RESTORE_TARGET: 'latest',
    RESTORE_RECOVERY_CONF: RESTORE.recoveryConf,
    RESTORE_ATTEMPT: RESTORE.attempt,
    RESTORE_ORIGIN: 'deploy',
    RESTORE_LINEAGE: LINEAGE,
    ...over,
  });
  const lines = (msg: string) => msg.split('\n').map((l) => l.trim());
  const plain = () =>
    assertRestoreMarkerState({ env: markerEnv, restore: null, operatorEnv: 'prod' }).catch(
      (e) => e,
    );
  const CLEAR = `kubectl -n vibecarbon patch secret vibecarbon-infra-secrets --type=merge -p '${JSON.stringify({ stringData: restoreMarkerStringData(null) })}'`;

  it('-restore: refuses a cluster that already runs a database, naming the env', async () => {
    liveDbSts = true;
    const err = await assertRestoreMarkerState({
      env: markerEnv,
      restore: RESTORE,
      operatorEnv: 'prod',
    }).catch((e) => e);
    expect(err.message).toMatch(/seeds a new database, and this cluster already runs one/);
    expect(lines(err.message)).toContain(
      `vibecarbon restore prod -source ${BACKUP} -lineage ${LINEAGE}`,
    );
    expect(err.message).not.toContain('<env>');
  });

  it('-restore: a rerun that finishes the same restore (base AND target) goes on', async () => {
    liveDbSts = true;
    marker = pending();
    await expect(
      assertRestoreMarkerState({ env: markerEnv, restore: RESTORE, operatorEnv: 'prod' }),
    ).resolves.toBeUndefined();
  });

  it('-restore: the same base to another target is another restore, refused (N2)', async () => {
    liveDbSts = true;
    marker = pending({ RESTORE_TARGET: '2026-10-19T12:00:00Z' });
    await expect(
      assertRestoreMarkerState({ env: markerEnv, restore: RESTORE, operatorEnv: 'prod' }),
    ).rejects.toThrow(/already runs one/);
  });

  it('plain deploy, a pending deploy -restore: names deploy -restore with its exact point', async () => {
    liveDbSts = true;
    marker = pending();
    const err = await plain();
    expect(err.message).toMatch(new RegExp(`restore of ${BACKUP} \\(target latest\\) is pending`));
    expect(lines(err.message)).toContain(
      `vibecarbon deploy prod -restore ${BACKUP} -lineage ${LINEAGE}`,
    );
    // Read-only: only gets, and the one PGDATA probe.
    expect(calls.every((a) => a.includes('get') || a.includes('exec'))).toBe(true);
    expect(calls.some((a) => a.includes('patch') || a.includes('apply'))).toBe(false);
  });

  it('plain deploy, a pending vibecarbon restore to a point in time: names vibecarbon restore and the target (N2)', async () => {
    liveDbSts = true;
    marker = pending({ RESTORE_ORIGIN: 'restore', RESTORE_TARGET: '2026-10-19T12:00:00Z' });
    const err = await plain();
    expect(lines(err.message)).toContain(
      `vibecarbon restore prod -source 2026-10-19T12:00:00Z -lineage ${LINEAGE}`,
    );
    expect(err.message).not.toContain('deploy prod -restore');
  });

  it('plain deploy, no swap yet: offers the abandon line', async () => {
    liveDbSts = true;
    marker = pending();
    pgdataState = 'VC_OK\n';
    const err = await plain();
    expect(lines(err.message)).toContain(CLEAR);
    expect(err.message).toMatch(/nothing was swapped in yet/);
  });

  // P4: a probe that answered without its read sentinel (cut short) proves
  // nothing; read as "not swapped" it would offer the abandon of a live copy.
  it('plain deploy, a probe cut short (no read sentinel): unknown, never "nothing swapped"', async () => {
    liveDbSts = true;
    marker = pending();
    pgdataState = '';
    const err = await plain();
    expect(err.message).toMatch(/could not read the db pod/i);
    expect(err.message).not.toMatch(/since nothing was swapped in yet/);
  });

  // P5: the proven restore retired .vc-prev into .vc-discard, then the marker
  // clear failed. The copy is proven: neither "unproven" nor "no database".
  it('plain deploy, proven and retired but the marker clear failed: says so, names the two finishing commands', async () => {
    liveDbSts = true;
    marker = pending();
    pgdataState = `discard\nrecord ${BACKUP} ${RESTORE.attempt}\nVC_OK\n`;
    const err = await plain();
    expect(err.message).toMatch(/proven writable/);
    expect(err.message).not.toMatch(/unproven/);
    expect(err.message).not.toMatch(/no database before/);
    expect(lines(err.message)).toContain(CLEAR);
    expect(
      lines(err.message).some((l) => l.includes('rm -rf /var/lib/postgresql/data/.vc-discard')),
    ).toBe(true);
  });

  it('plain deploy, swapped in: no plain abandon, says what clearing would boot (ruling)', async () => {
    liveDbSts = true;
    marker = pending({ RESTORE_ORIGIN: 'restore' });
    pgdataState = `prev\nrecord ${BACKUP} ${RESTORE.attempt}\nVC_OK\n`;
    const err = await plain();
    expect(lines(err.message)).not.toContain(CLEAR);
    expect(err.message).toMatch(/clearing the marker would boot the restored copy/i);
    expect(err.message).toContain('/var/lib/postgresql/data/.vc-prev');
    expect(lines(err.message)).toContain(
      `vibecarbon restore prod -source ${BACKUP} -lineage ${LINEAGE}`,
    );
  });

  it('plain deploy, the pod cannot be read: says both possibilities', async () => {
    liveDbSts = true;
    marker = pending();
    pgdataState = null;
    const err = await plain();
    expect(err.message).toMatch(/could not read the db pod/i);
    expect(err.message).toMatch(/if nothing was swapped in yet/i);
    expect(err.message).toMatch(/if it was/i);
  });

  it('plain deploy: no marker, or a fresh cluster, goes on', async () => {
    await expect(
      assertRestoreMarkerState({ env: markerEnv, restore: null, operatorEnv: 'prod' }),
    ).resolves.toBeUndefined();
    liveDbSts = true;
    await expect(
      assertRestoreMarkerState({ env: markerEnv, restore: null, operatorEnv: 'prod' }),
    ).resolves.toBeUndefined();
  });

  it('deployK3s checks the marker once the cluster answers, before the image build and the k3s-apply gate', () => {
    const src = readFileSync(join(__dirname, '../../../src/lib/deploy/k8s/k3s.js'), 'utf-8');
    const body = src.slice(src.indexOf('export async function deployK3s('));
    const at = (needle: string) => {
      const i = body.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const check = at('await assertRestoreMarkerState({');
    expect(check).toBeGreaterThan(at("state.completeStep('k3s-kubeconfig'"));
    expect(check).toBeLessThan(at('await deliverAppImage({'));
    expect(check).toBeLessThan(at('await shouldSkipK3sApply({'));
    // Outside every step gate: a skipped apply must not skip the check.
    const before = body.slice(at("state.getStepResult('k3s-kubeconfig')"), check);
    expect(before).not.toMatch(/shouldSkip/);
  });

  it('deployK3s pushes the first base on the restored timeline once the app is up, outside the apply gate (H2b)', () => {
    const src = readFileSync(join(__dirname, '../../../src/lib/deploy/k8s/k3s.js'), 'utf-8');
    const body = src.slice(src.indexOf('export async function deployK3s('));
    const at = (needle: string) => {
      const i = body.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const push = at('pushBaseBackupAfterPromote({');
    // After the apply (finishDeployRestore retired .vc-prev; the app rolled)
    // and after the archiving audit, outside the k3s-apply gate.
    expect(push).toBeGreaterThan(at("state.completeStep('k3s-apply')"));
    expect(push).toBeGreaterThan(at('verifyWalgBackups({ kubeconfig })'));
    expect(body.slice(at("state.completeStep('k3s-apply')"), push)).toMatch(
      /if \(options\.restore\) \{/,
    );
    expect(body.slice(push, push + 300)).toMatch(/tier: 'k8s',\s+ip: masterIp,/);
  });

  // Two full applies (about 2s each in this file's mock, up to 5s under a
  // loaded machine): the default 5s budget was too tight for both.
  it('each environment applies its own backup schedule (CronJob) and retention (ConfigMap)', {
    timeout: 20_000,
  }, async () => {
    const settingsMap = () =>
      stdin.filter((s) => s.data.includes('name: vibecarbon-backup-settings')).at(-1)?.data ?? '';
    for (const [cfg, cron, days] of [
      [{ schedule: '0 */6 * * *', retentionDays: 14 }, '0 */6 * * *', '14'],
      [{ schedule: '30 4 * * *', retentionDays: 90 }, '30 4 * * *', '90'],
    ] as const) {
      appliedBackup = null;
      stdin.length = 0;
      await applyK3sManifests({ ...args(null), backupConfig: cfg });
      // The CronJob in the rendered copy kubectl apply -k is handed ...
      expect(appliedBackup?.cronjob).toContain(`schedule: "${cron}"`);
      expect(appliedBackup?.cronjob).not.toContain('{{BACKUP_SCHEDULE}}');
      // ... and the per-cluster settings ConfigMap, applied after it.
      expect(settingsMap()).toContain(`BACKUP_RETENTION_DAYS: "${days}"`);
      // Never patched onto vibecarbon-config, which Flux's base also owns.
      expect(calls.some((c) => c.includes('patch') && c.some((x) => /BACKUP_/.test(x)))).toBe(
        false,
      );
    }
  });

  it('a malformed schedule fails before any kubectl call', async () => {
    calls = [];
    await expect(
      applyK3sManifests({ ...args(null), backupConfig: { schedule: '@daily', retentionDays: 7 } }),
    ).rejects.toThrow(/5-field cron expression/);
    expect(calls).toEqual([]);
  });

  it('without a restore point: no marker keys, no proof, no clear', async () => {
    await applyK3sManifests(args(null));
    const data = infraSecretApply()?.data ?? '';
    for (const k of RESTORE_MARKER_KEYS) expect(data).not.toContain(`${k}:`);
    expect(calls.some(isPromotedCheck)).toBe(false);
    expect(calls.some(isMarkerClear)).toBe(false);
    expect(calls.find(isDbWait)).toContain(`--timeout=${DB_ROLLOUT_TIMEOUT_S}s`);
  });
});
