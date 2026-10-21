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
  deployK3s,
  DB_ROLLOUT_TIMEOUT_S,
} = k3s;
const { RESTORE_MARKER_KEYS } = await import('../../../src/lib/walg/restore-layout.js');
const { NoRestorePointError, resolveDeployRestorePoint } = await import(
  '../../../src/lib/walg/restore-base.js'
);
const { buildRecoveryConfig, renderRecoveryConf } = await import(
  '../../../src/lib/walg/recovery-config.js'
);
const { restoreRolloutTimeoutS } = await import('../../../src/lib/deploy/replication.js');

const BACKUP = 'base_000000010000000000000003';
const RESTORE = {
  backup: BACKUP,
  target: 'latest',
  recoveryConf: renderRecoveryConf(buildRecoveryConfig({ target: 'latest' })),
  sizeBytes: 50 * 1024 ** 3,
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

/** A fake S3 that answers sentinel listings, and records every command it saw. */
function fakeS3(names: Array<{ name: string; finish: string; size?: number }>) {
  const seen: string[] = [];
  return {
    seen,
    async send(cmd: { constructor: { name: string }; input: { Key?: string } }) {
      seen.push(cmd.constructor.name);
      if (cmd.constructor.name === 'ListObjectsV2Command') {
        return {
          Contents: names.map((b) => ({
            Key: `backups/proj/prod/walg/basebackups_005/${b.name}_backup_stop_sentinel.json`,
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
    expect(point).toEqual({ ...RESTORE, sizeBytes: 222 });
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
// A db StatefulSet already in the cluster, and the RESTORE_BACKUP its infra
// Secret carries (plain; the mock answers base64 as kubectl does).
let liveDbSts = false;
let markedBackup = '';

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
    const sql = args.find((a) => /SELECT|ANALYZE/i.test(a)) ?? '';
    if (cmd === 'kubectl' && has('rollout') && has('status') && has('statefulset/db')) {
      return child(dbRolloutExit);
    }
    if (cmd === 'kubectl' && has('get') && has('statefulset') && has('db')) {
      return child(0, liveDbSts ? 'statefulset.apps/db\n' : '');
    }
    if (cmd === 'kubectl' && has('jsonpath={.data.RESTORE_BACKUP}')) {
      return child(0, Buffer.from(markedBackup).toString('base64'));
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
    localTunnelPort: 5000,
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
  a.includes('exec') && a.some((x) => /^rm -rf .*\.vc-discard$/.test(x));
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
    markedBackup = '';
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

  it('refuses a cluster that already runs a database, before the marker is written', async () => {
    liveDbSts = true;
    await expect(applyK3sManifests(args(RESTORE))).rejects.toThrow(
      /seeds a new database, and this cluster already runs one/,
    );
    expect(infraSecretApply()).toBeUndefined();
    expect(calls.some(isBaseApply)).toBe(false);
  });

  it('a rerun that finishes the same restore goes on', async () => {
    liveDbSts = true;
    markedBackup = BACKUP;
    await applyK3sManifests(args(RESTORE));
    expect(calls.some(isMarkerClear)).toBe(true);
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
