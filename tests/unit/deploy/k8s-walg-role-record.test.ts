/**
 * A warm deploy does not exec into the db when the role did not change.
 *
 * `kubectl exec` is the one role step that has hung a deploy (30 s, 2 of 11
 * first warm deploys, cause unknown) while the site stayed healthy. So a
 * deploy skips it when vibecarbon-db-role proves the file already reads the
 * role: the intent AND the live record both name it. The intent alone proves
 * nothing, because it is applied before the exec that can fail.
 *
 * The cluster here is fake only at the kubectl seam. The role file is a real
 * directory, the exec runs the real write script, and a restart runs the real
 * db-guard.sh with the env a container gets from the ConfigMap, so what these
 * tests read back is what those scripts actually did.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findCalls } from '../helpers/js-call-scan.js';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: vi.fn() };
});

const { applyVibecarbonSecrets, writeDeployWalgRole } = await import(
  '../../../src/lib/deploy/k8s/k3s.js'
);
const {
  DB_ROLE_CONFIGMAP,
  DB_ROLE_INTENT_KEY,
  DB_ROLE_LIVE_KEY,
  dbRoleConfigMapManifest,
  readDbRoleRecord,
  setK8sWalgRole,
  WALG_ROLE_DIR,
  writeComposeWalgRole,
} = await import('../../../src/lib/deploy/walg-role.js');

const ROOT = join(__dirname, '../../..');
const GUARD = join(ROOT, 'carbon/volumes/db/db-guard.sh');

type Kubectl = (ip: unknown, argv: string[], o?: { input?: string }) => Promise<string>;

let dir: string;
let roleDir: string;
let binDir: string;
let pgdata: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-role-record-'));
  roleDir = join(dir, 'role');
  binDir = join(dir, 'bin');
  pgdata = join(dir, 'data');
  for (const d of [roleDir, binDir, pgdata]) mkdirSync(d);
  const stub = join(binDir, 'db-entrypoint.sh');
  writeFileSync(stub, '#!/bin/sh\nexit 0\n');
  chmodSync(stub, 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fileOf = () => {
  try {
    return readFileSync(join(roleDir, 'walg-role'), 'utf-8').trim();
  } catch {
    return undefined;
  }
};
const setFile = (word: string) => writeFileSync(join(roleDir, 'walg-role'), `${word}\n`);

function pod(roleMount = true) {
  return JSON.stringify({
    spec: {
      containers: [
        {
          name: 'db',
          volumeMounts: roleMount ? [{ name: 'data', mountPath: WALG_ROLE_DIR }] : [],
        },
      ],
    },
  });
}

/** One cluster's role surface: the ConfigMap, the db pod, the file on its volume. */
function cluster(data?: Record<string, string>) {
  const c = {
    data,
    roleMount: true,
    execs: 0,
    applies: 0,
    execError: undefined as Error | undefined,
    readBack: undefined as string | undefined,
    /** Fails the apply whose manifest satisfies this. */
    applyFails: undefined as ((doc: { data: Record<string, string> }) => boolean) | undefined,
    recordRead: undefined as (() => string) | undefined,
    podRead: undefined as (() => string) | undefined,
    kubectl: (async (_ip, argv, o = {}) => {
      if (argv.includes('apply')) {
        const doc = load(String(o.input)) as { data: Record<string, string> };
        if (c.applyFails?.(doc)) throw new Error('the apiserver said no');
        c.applies += 1;
        // Conservative on purpose: a key the manifest leaves out is kept, which
        // is what kubectl apply does for a key it did not set. The clear has to
        // be spelled, never inherited from a three-way merge.
        c.data = { ...c.data, ...doc.data };
        return '';
      }
      if (argv.includes('get') && argv.includes(`configmap/${DB_ROLE_CONFIGMAP}`)) {
        if (c.recordRead) return c.recordRead();
        return c.data ? JSON.stringify({ data: c.data }) : '';
      }
      if (argv.includes('get')) return c.podRead ? c.podRead() : pod(c.roleMount);
      if (argv.includes('exec')) {
        c.execs += 1;
        if (c.execError) throw c.execError;
        if (c.readBack !== undefined) return c.readBack;
        const script = String(argv.at(-1)).replaceAll(WALG_ROLE_DIR, roleDir);
        return execFileSync('sh', ['-c', script], { encoding: 'utf-8' });
      }
      return '';
    }) as Kubectl,
    /**
     * The db container starts again: the kubelet resolves its env from the
     * ConfigMap (only the intent key, statefulset.yaml) and db-guard.sh runs.
     */
    restart() {
      const intent = c.data?.[DB_ROLE_INTENT_KEY];
      const r = spawnSync('sh', [GUARD, 'postgres'], {
        encoding: 'utf-8',
        env: {
          PATH: `${binDir}:${process.env.PATH}`,
          PGDATA: pgdata,
          VC_WALG_ROLE_DIR: roleDir,
          ...(intent !== undefined && { VC_WALG_ROLE_INTENT: intent }),
        },
      });
      expect(r.status).toBe(0);
    },
  };
  return c;
}

const proven = (role: 'primary' | 'standby') => ({
  [DB_ROLE_INTENT_KEY]: role,
  [DB_ROLE_LIVE_KEY]: role,
});

describe('the deploy role step', () => {
  it('an unchanged role with a proven record does not exec, and leaves the ConfigMap alone', async () => {
    const c = cluster(proven('standby'));
    setFile('standby');
    await expect(writeDeployWalgRole({ kubectl: c.kubectl, role: 'standby' })).resolves.toEqual({
      intent: true,
      live: true,
    });
    expect(c.execs).toBe(0);
    expect(c.applies).toBe(0);
    expect(c.data).toEqual(proven('standby'));
  });

  it('the first deploy writes, then records; the next one does not exec', async () => {
    const c = cluster();
    await writeDeployWalgRole({ kubectl: c.kubectl, role: 'primary' });
    expect(c.execs).toBe(1);
    expect(fileOf()).toBe('primary');
    expect(c.data).toEqual(proven('primary'));
    await writeDeployWalgRole({ kubectl: c.kubectl, role: 'primary' });
    expect(c.execs).toBe(1);
  });

  it('a changed role writes, and the record follows it', async () => {
    const c = cluster(proven('primary'));
    setFile('primary');
    await writeDeployWalgRole({ kubectl: c.kubectl, role: 'standby' });
    expect(c.execs).toBe(1);
    expect(fileOf()).toBe('standby');
    expect(c.data).toEqual(proven('standby'));
  });

  it.each([
    ['no record', { [DB_ROLE_INTENT_KEY]: 'primary' }],
    ['an empty record', { [DB_ROLE_INTENT_KEY]: 'primary', [DB_ROLE_LIVE_KEY]: '' }],
    [
      'a record of the other role',
      { [DB_ROLE_INTENT_KEY]: 'primary', [DB_ROLE_LIVE_KEY]: 'standby' },
    ],
    ['a record with no intent', { [DB_ROLE_LIVE_KEY]: 'primary' }],
    ['the other intent', { [DB_ROLE_INTENT_KEY]: 'standby', [DB_ROLE_LIVE_KEY]: 'primary' }],
  ])('%s writes, exactly as before', async (_name, data) => {
    const c = cluster(data);
    await writeDeployWalgRole({ kubectl: c.kubectl, role: 'primary' });
    expect(c.execs).toBe(1);
    expect(fileOf()).toBe('primary');
  });

  it('a record it cannot read writes', async () => {
    const c = cluster(proven('primary'));
    c.recordRead = () => {
      throw new Error('connection refused');
    };
    await writeDeployWalgRole({ kubectl: c.kubectl, role: 'primary' });
    expect(c.execs).toBe(1);
  });

  it('a record that is not JSON writes', async () => {
    const c = cluster(proven('primary'));
    c.recordRead = () => 'not json';
    await writeDeployWalgRole({ kubectl: c.kubectl, role: 'primary' });
    expect(c.execs).toBe(1);
  });

  it('a pod it cannot read does not skip on the record alone', async () => {
    const c = cluster(proven('primary'));
    c.podRead = () => {
      c.podRead = undefined;
      throw new Error('connection refused');
    };
    await writeDeployWalgRole({ kubectl: c.kubectl, role: 'primary' });
    expect(c.execs).toBe(1);
  });

  it('a failed exec fails the deploy and leaves no record, so the next deploy writes', async () => {
    const c = cluster({ [DB_ROLE_INTENT_KEY]: 'primary' });
    c.execError = new Error('exec timed out');
    await expect(writeDeployWalgRole({ kubectl: c.kubectl, role: 'primary' })).rejects.toThrow(
      /pod-unreachable/,
    );
    expect(c.data?.[DB_ROLE_LIVE_KEY]).toBeFalsy();
    c.execError = undefined;
    await writeDeployWalgRole({ kubectl: c.kubectl, role: 'primary' });
    expect(c.execs).toBe(2);
    expect(fileOf()).toBe('primary');
    expect(c.data).toEqual(proven('primary'));
  });

  it('a read-back that disagrees leaves no record', async () => {
    const c = cluster();
    c.readBack = 'WALG_ROLE_FILE=\n';
    await expect(writeDeployWalgRole({ kubectl: c.kubectl, role: 'primary' })).rejects.toThrow(
      /read-back-mismatch/,
    );
    expect(c.data?.[DB_ROLE_LIVE_KEY]).toBeFalsy();
  });

  it('a record that does not land costs one exec next time, never the deploy', async () => {
    const c = cluster();
    c.applyFails = (doc) => Boolean(doc.data[DB_ROLE_LIVE_KEY]);
    await expect(writeDeployWalgRole({ kubectl: c.kubectl, role: 'primary' })).resolves.toEqual({
      intent: true,
      live: true,
    });
    c.applyFails = undefined;
    await writeDeployWalgRole({ kubectl: c.kubectl, role: 'primary' });
    expect(c.execs).toBe(2);
    expect(c.data).toEqual(proven('primary'));
  });

  it('a proven record does not hide a pod without the role mount', async () => {
    const c = cluster(proven('primary'));
    c.roleMount = false;
    await expect(writeDeployWalgRole({ kubectl: c.kubectl, role: 'primary' })).rejects.toThrow(
      /did not give db-0 the wal-g role mount/,
    );
  });
});

describe('every other role write', () => {
  it('failover writes live and records nothing', async () => {
    const c = cluster(proven('standby'));
    setFile('standby');
    await setK8sWalgRole({ ip: '1.1.1.1', kubectl: c.kubectl, role: 'primary', requireLive: true });
    expect(c.execs).toBe(1);
    expect(fileOf()).toBe('primary');
    expect(c.data?.[DB_ROLE_INTENT_KEY]).toBe('primary');
    expect(c.data?.[DB_ROLE_LIVE_KEY]).toBe('');
  });

  it('failover writes even when the record already proves the role', async () => {
    const c = cluster(proven('primary'));
    setFile('primary');
    await setK8sWalgRole({ ip: '1.1.1.1', kubectl: c.kubectl, role: 'primary', requireLive: true });
    expect(c.execs).toBe(1);
  });

  it('a role moved away and back through failed writes cannot leave an old record true', async () => {
    // The intent returns to the recorded word while the file does not.
    const c = cluster(proven('primary'));
    setFile('primary');
    await setK8sWalgRole({ ip: '1.1.1.1', kubectl: c.kubectl, role: 'standby' });
    expect(fileOf()).toBe('standby');
    c.execError = new Error('exec timed out');
    await setK8sWalgRole({ ip: '1.1.1.1', kubectl: c.kubectl, role: 'primary' });
    expect(fileOf()).toBe('standby');
    expect(c.data?.[DB_ROLE_INTENT_KEY]).toBe('primary');
    c.execError = undefined;
    await writeDeployWalgRole({ kubectl: c.kubectl, role: 'primary' });
    expect(fileOf()).toBe('primary');
  });

  it('the intent manifest spells the record empty, so no write relies on a three-way merge', () => {
    const doc = load(dbRoleConfigMapManifest('standby')) as { data: Record<string, string> };
    expect(doc.data).toEqual({ [DB_ROLE_INTENT_KEY]: 'standby', [DB_ROLE_LIVE_KEY]: '' });
  });
});

describe('a db pod that restarts', () => {
  it('reads the intent whatever the file held, so a record equal to the intent stays true', () => {
    for (const intent of ['primary', 'standby'] as const) {
      for (const before of ['primary', 'standby', 'garbage', undefined]) {
        rmSync(join(roleDir, 'walg-role'), { force: true });
        if (before) setFile(before);
        const c = cluster(proven(intent));
        c.restart();
        expect(fileOf()).toBe(intent);
      }
    }
  });

  it('a restart after a proven write keeps the skip truthful', async () => {
    const c = cluster();
    await writeDeployWalgRole({ kubectl: c.kubectl, role: 'standby' });
    c.restart();
    await writeDeployWalgRole({ kubectl: c.kubectl, role: 'standby' });
    expect(c.execs).toBe(1);
    expect(fileOf()).toBe('standby');
  });

  it('a restart on a new, empty volume keeps it truthful too', async () => {
    const c = cluster();
    await writeDeployWalgRole({ kubectl: c.kubectl, role: 'standby' });
    rmSync(join(roleDir, 'walg-role'));
    c.restart();
    await writeDeployWalgRole({ kubectl: c.kubectl, role: 'standby' });
    expect(c.execs).toBe(1);
    expect(fileOf()).toBe('standby');
  });

  it('a restart after a failed write still leaves the next deploy to write', async () => {
    const c = cluster();
    await writeDeployWalgRole({ kubectl: c.kubectl, role: 'primary' });
    c.execError = new Error('exec timed out');
    await setK8sWalgRole({ ip: '1.1.1.1', kubectl: c.kubectl, role: 'standby' });
    c.restart();
    expect(fileOf()).toBe('standby');
    c.execError = undefined;
    await writeDeployWalgRole({ kubectl: c.kubectl, role: 'standby' });
    expect(c.execs).toBe(3);
  });

  it('the proof rests on the template: db-guard.sh is the command, the intent key is the env', () => {
    const sts = readFileSync(join(ROOT, 'carbon/k8s/base/db/statefulset.yaml'), 'utf-8');
    expect(sts).toContain('command: ["sh", "/usr/local/bin/db-guard.sh"]');
    expect(sts).toMatch(
      new RegExp(
        `name: ${DB_ROLE_INTENT_KEY}\\s+valueFrom:\\s+configMapKeyRef:\\s+name: ${DB_ROLE_CONFIGMAP}\\s+key: ${DB_ROLE_INTENT_KEY}\\b`,
      ),
    );
    // The record is the CLI's alone: nothing in the container reads it.
    for (const f of [sts, readFileSync(GUARD, 'utf-8')]) expect(f).not.toContain(DB_ROLE_LIVE_KEY);
  });
});

describe('readDbRoleRecord', () => {
  it('reads both keys', async () => {
    const c = cluster(proven('primary'));
    await expect(readDbRoleRecord({ ip: 'x', kubectl: c.kubectl })).resolves.toEqual({
      intent: 'primary',
      live: 'primary',
    });
  });
  it('a missing ConfigMap reads as nothing, and never throws', async () => {
    const c = cluster();
    await expect(readDbRoleRecord({ ip: 'x', kubectl: c.kubectl })).resolves.toEqual({});
  });
});

/** The secrets step's kubectl calls: `get` answered from `cm`, stdin kept. */
function secretsKubectl(cm: string) {
  const piped: string[] = [];
  vi.mocked(spawn).mockImplementation(((cmd: string, args: string[]) => {
    const out =
      cmd === 'kubectl' && args.includes(`configmap/${DB_ROLE_CONFIGMAP}`)
        ? cm
        : cmd === 'kubectl' && args.includes('--dry-run=client')
          ? 'kind: Namespace\n'
          : '';
    const child = {
      stdout: {
        on(ev: string, cb: (b: Buffer) => void) {
          if (ev === 'data' && out) Promise.resolve().then(() => cb(Buffer.from(out)));
        },
      },
      stderr: { on() {} },
      stdin: {
        write: (d: unknown) => piped.push(String(d)),
        end() {},
      },
      kill() {},
      unref() {},
      on(ev: string, cb: (code: number) => void) {
        if (ev === 'close' || ev === 'exit') setImmediate(() => cb(0));
        return child;
      },
    };
    return child;
  }) as unknown as typeof spawn);
  return piped;
}

const applySecrets = (walgRole: 'primary' | 'standby') =>
  applyVibecarbonSecrets({
    kubeconfig: join(dir, 'kubeconfig'),
    envLocal: { POSTGRES_PASSWORD: 'x' },
    s3Config: undefined,
    backupTarget: null,
    restore: null,
    walgRole,
  });

describe('the secrets step', () => {
  const intentWrites = (piped: string[]) => piped.filter((p) => p.includes(DB_ROLE_CONFIGMAP));

  it('an unchanged intent is not applied again: that would clear the record and cost the exec', async () => {
    const piped = secretsKubectl(JSON.stringify({ data: proven('standby') }));
    await applySecrets('standby');
    expect(intentWrites(piped)).toEqual([]);
  });

  it('a changed intent is applied, and clears the record with it', async () => {
    const piped = secretsKubectl(JSON.stringify({ data: proven('primary') }));
    await applySecrets('standby');
    expect(intentWrites(piped)).toEqual([dbRoleConfigMapManifest('standby')]);
  });

  it('a new cluster gets the intent before its db pod exists', async () => {
    const piped = secretsKubectl('');
    await applySecrets('primary');
    expect(intentWrites(piped)).toEqual([dbRoleConfigMapManifest('primary')]);
  });
});

describe('compose-ha is unaffected', () => {
  it('every deploy writes the file over ssh: there is no exec to remove and no record to read', async () => {
    const run = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      const role = /printf '%s\\n' (primary|standby) > walg-role\.tmp/.exec(argv[2])?.[1];
      return `WALG_ROLE_FILE=${role}\n`;
    });
    const write = () =>
      writeComposeWalgRole({
        ip: '1.1.1.1',
        sshKeyPath: '/k',
        projectName: 'acme',
        role: 'standby',
        run,
      });
    await write();
    await write();
    expect(run).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(run.mock.calls)).not.toContain('kubectl');
  });
});

/** Every JS source under `rel`, relative to `root`. */
function walk(root: string, rel: string): string[] {
  return readdirSync(join(root, rel)).flatMap((n) => {
    const p = join(rel, n);
    if (statSync(join(root, p)).isDirectory()) return walk(root, p);
    return /\.(m|c)?js$/.test(p) ? [p] : [];
  });
}

const ROLE_MODULE = 'src/lib/deploy/walg-role.js';

/**
 * Who may claim the file is proven. The record is sound only while nothing
 * sets it but a read-back, and every other write clears it, so:
 *
 *   - `recordLive` is passed by the deploy's role step alone;
 *   - `dbRoleConfigMapManifest` takes its record argument in setK8sWalgRole
 *     alone, after the read-back; every other caller writes the clearing form;
 *   - the key is spelled in walg-role.js alone.
 */
function recordClaims(root: string): string[] {
  return walk(root, 'src').flatMap((f) => {
    const text = readFileSync(join(root, f), 'utf-8');
    const claims = [
      ...findCalls(text, ['setK8sWalgRole'])
        .filter((c) => c.args.some((a) => /\brecordLive\b/.test(a)))
        .map((c) => `${f}:${c.fn}`),
      ...findCalls(text, ['dbRoleConfigMapManifest'])
        .filter((c) => c.args.length > 1)
        .map((c) => `${f}:${c.fn}`),
    ];
    if (f !== ROLE_MODULE && text.includes('VC_WALG_ROLE_LIVE')) claims.push(`${f}:key`);
    return claims;
  });
}

describe('census: only a read-back claims the role file is proven', () => {
  it('the one site that records, and the one that asks it to', () => {
    expect(recordClaims(ROOT).sort()).toEqual([
      'src/lib/deploy/k8s/k3s.js:writeDeployWalgRole',
      'src/lib/deploy/walg-role.js:setK8sWalgRole',
    ]);
  });

  it('bites a planted claim', () => {
    const planted = join(dir, 'tree');
    const plant = (rel: string, text: string) => {
      mkdirSync(dirname(join(planted, rel)), { recursive: true });
      writeFileSync(join(planted, rel), text);
    };
    plant('src/a.js', 'function a() { return setK8sWalgRole({ role, recordLive: true }); }\n');
    plant('src/b.js', 'function b() { return dbRoleConfigMapManifest(role, { live: true }); }\n');
    plant('src/c.js', "const K = 'VC_WALG_ROLE_LIVE';\n");
    plant('src/d.js', "function d() { return setK8sWalgRole({ role: 'standby' }); }\n");
    expect(recordClaims(planted).sort()).toEqual(['src/a.js:a', 'src/b.js:b', 'src/c.js:key']);
  });
});
