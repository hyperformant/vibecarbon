/**
 * Moving the wal-g WRITE-GUARD during failover.
 *
 * `WALG_ROLE` is rendered once, at deploy time, from the deploy's notion of
 * which node is which. Failover moves the role WITHOUT redeploying, so before
 * this the promoted node kept the value it was DEPLOYED with — `standby` — and
 * silently stopped taking base backups (both tiers) and archiving WAL (compose,
 * and k8s too once its archive wrapper regained the write-guard).
 *
 * The subtle half is that `WALG_ROLE` is CONTAINER ENVIRONMENT, fixed at
 * container-create time. Writing `.env` or patching a StatefulSet is not the
 * fix on its own; the container has to be recreated. These tests pin the two
 * builders that make that happen, and — the part most likely to rot — pin the
 * compose `-f` reconstruction against the ONE list `composeFileFlags` is built
 * from, so a newly added overlay cannot reach deploy and miss failover.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import { DB_CONTAINER, DB_POD } from '../../../src/lib/deploy/db-workload.js';
import {
  COMPOSE_WALG_ROLE_HOST_DIR,
  composeWalgRoleWriteShell,
  DB_ROLE_CONFIGMAP,
  DB_ROLE_INTENT_KEY,
  dbRoleConfigMapManifest,
  k8sWalgRoleExecArgv,
  k8sWalgRoleIntentApplyArgv,
  parseWalgRoleReadBack,
  podMountsWalgRoleDir,
  setK8sWalgRole,
  WALG_ROLE_DIR,
  walgRoleDegradedMessage,
  walgRoleReadShell,
  walgRoleWriteShell,
  writeComposeWalgRole,
} from '../../../src/lib/deploy/walg-role.js';
import { shEscape } from '../../../src/lib/shell.js';
import { createTempDir } from '../../_shared/temp-dir.js';

describe('walgRoleDegradedMessage', () => {
  const msg = walgRoleDegradedMessage({
    path: 'compose',
    envName: 'prod',
    promotedIp: '2.2.2.2',
    detail: 'the role file reads standby',
  });

  it('states the world first — this is read mid-incident', () => {
    // The first question during a failover is "am I serving?", so answer it
    // before describing the problem.
    expect(msg.indexOf('is serving')).toBeLessThan(msg.indexOf('could not prove'));
    expect(msg).toContain('FAILOVER COMPLETED, BACKUPS DID NOT');
  });

  it('names the consequence and the one-command check', () => {
    expect(msg).toContain('ONLY live copy');
    // The role file on the host, through the bind: no db restart reads it.
    expect(msg).toContain(`cat /opt/<project>/${COMPOSE_WALG_ROLE_HOST_DIR}/walg-role`);
    expect(msg).not.toContain('printenv');
    expect(msg).toContain('vibecarbon deploy prod');
  });

  it('names the base backup the failover could not push on the new timeline (one error, not two)', () => {
    expect(msg).toContain('no base backup on the new timeline');
    expect(msg).toContain('`vibecarbon backup prod`');
  });

  it('names the add-ons the next reconcile holds at zero only when it is given them', () => {
    expect(msg).not.toContain('next reconcile');
    const held = walgRoleDegradedMessage({
      path: 'compose',
      envName: 'prod',
      promotedIp: '2.2.2.2',
      detail: 'x',
      heldAtZero: ['n8n', 'metabase'],
    });
    expect(held).toContain(
      "Until the new primary's wal-g role file reads primary, its next reconcile scales n8n, metabase back to 0",
    );
    expect(held).not.toMatch(/\.env|WALG_ROLE=/);
    expect(held).not.toMatch(/\u2014/);
  });

  it('gives the k8s check on the k8s path', () => {
    const k8s = walgRoleDegradedMessage({
      path: 'k8s',
      envName: 'prod',
      promotedIp: '3.3.3.3',
      detail: 'x',
    });
    expect(k8s).toContain(
      `kubectl -n vibecarbon exec ${DB_POD} -c db -- cat /var/lib/vibecarbon/role/walg-role`,
    );
    expect(k8s).not.toContain('printenv');
  });
});

const podJson = (mounted: boolean) =>
  JSON.stringify({
    metadata: { uid: 'u1' },
    spec: {
      containers: [
        {
          name: 'db',
          volumeMounts: [
            { name: 'data', mountPath: '/var/lib/postgresql/data', subPath: 'postgres-data' },
            ...(mounted
              ? [{ name: 'data', mountPath: WALG_ROLE_DIR, subPath: 'vibecarbon-role' }]
              : []),
          ],
        },
      ],
    },
  });

describe('walg role primitives', () => {
  it('refuses an unknown role', () => {
    expect(() => walgRoleWriteShell(WALG_ROLE_DIR, 'leader' as never)).toThrow(
      /unknown wal-g role/,
    );
    expect(() => dbRoleConfigMapManifest(undefined as never)).toThrow(/unknown wal-g role/);
  });
  it('the write is atomic and reads itself back through the one parser, run for real', () => {
    const dir = createTempDir('vc-role-');
    const r = spawnSync('sh', ['-c', walgRoleWriteShell(dir, 'primary')], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('WALG_ROLE_FILE=primary');
    expect(readFileSync(join(dir, 'walg-role'), 'utf-8')).toBe('primary\n');
    expect(existsSync(join(dir, 'walg-role.tmp'))).toBe(false);
    expect(statSync(join(dir, 'walg-role')).mode & 0o777).toBe(0o644);
    expect(walgRoleWriteShell(dir, 'primary')).toMatch(
      /mv -f [^\n]*walg-role\.tmp [^\n]*walg-role && sync/,
    );
  });
  it('never follows a symlink planted at the tmp name', () => {
    const dir = createTempDir('vc-role-');
    writeFileSync(join(dir, 'victim'), 'x');
    symlinkSync(join(dir, 'victim'), join(dir, 'walg-role.tmp'));
    const r = spawnSync('sh', ['-c', walgRoleWriteShell(dir, 'standby')], { encoding: 'utf-8' });
    expect(readFileSync(join(dir, 'victim'), 'utf-8')).toBe('x');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('WALG_ROLE_FILE=standby');
    expect(readFileSync(join(dir, 'walg-role'), 'utf-8')).toBe('standby\n');
  });
  it('the manifest is the CLI-owned ConfigMap with the intent and an empty live record', () => {
    const doc = load(dbRoleConfigMapManifest('standby')) as {
      kind: string;
      metadata: { name: string; namespace: string };
      data: Record<string, string>;
    };
    expect(doc).toMatchObject({
      kind: 'ConfigMap',
      metadata: { name: DB_ROLE_CONFIGMAP, namespace: 'vibecarbon' },
      data: { [DB_ROLE_INTENT_KEY]: 'standby', VC_WALG_ROLE_LIVE: '' },
    });
  });
  it('setK8sWalgRole: apply (never patch) the intent, then the live write on a mounted pod', async () => {
    const calls: Array<{ argv: string; input?: string }> = [];
    const kubectl = vi.fn(async (_ip: string, argv: string[], o?: { input?: string }) => {
      calls.push({ argv: argv.join(' '), input: o?.input });
      if (argv.includes('get')) return podJson(true);
      if (argv.includes('exec')) return 'WALG_ROLE_FILE=primary';
      return '';
    });
    await expect(setK8sWalgRole({ ip: '1.1.1.1', kubectl, role: 'primary' })).resolves.toEqual({
      intent: true,
      live: true,
    });
    expect(calls[0].argv).toContain('apply -f -');
    expect(calls[0].input).toContain(`${DB_ROLE_INTENT_KEY}: primary`);
    expect(calls.some((c) => c.argv.includes('patch'))).toBe(false);
  });
  it('a pre-release pod without the role mount: intent applied, NO exec, and requireLive throws with the deploy hint (C18)', async () => {
    const kubectl = vi.fn(async (_ip: string, argv: string[]) =>
      argv.includes('get') ? podJson(false) : '',
    );
    await expect(setK8sWalgRole({ ip: '1.1.1.1', kubectl, role: 'standby' })).resolves.toEqual({
      intent: true,
      live: false,
      reason: 'no-role-mount',
    });
    expect(kubectl.mock.calls.some(([, a]) => a.includes('exec'))).toBe(false);
    await expect(
      setK8sWalgRole({ ip: '1.1.1.1', kubectl, role: 'primary', requireLive: true }),
    ).rejects.toThrow(/predates[\s\S]*vibecarbon deploy/);
  });
  it('the requireLive deploy hint names the env when given, and <env> otherwise', async () => {
    const kubectl = vi.fn(async (_ip: string, argv: string[]) =>
      argv.includes('get') ? podJson(false) : '',
    );
    await expect(
      setK8sWalgRole({
        ip: '1.1.1.1',
        kubectl,
        role: 'primary',
        requireLive: true,
        envName: 'prod',
      }),
    ).rejects.toThrow('`vibecarbon deploy prod`');
    await expect(
      setK8sWalgRole({ ip: '1.1.1.1', kubectl, role: 'primary', requireLive: true }),
    ).rejects.toThrow('`vibecarbon deploy <env>`');
  });
  it('a write that runs but exits non-zero is write-failed, not pod-unreachable', async () => {
    // The thrown message carries the whole command (the script, marker text
    // included), so only stderr may decide this.
    const writeErr = Object.assign(
      new Error(`Command failed: ${walgRoleWriteShell(WALG_ROLE_DIR, 'primary')}`),
      {
        stderr: `[walg-role] could not write the wal-g role in ${WALG_ROLE_DIR}\ncommand terminated with exit code 1\n`,
        status: 1,
      },
    );
    const kubectl = vi.fn(async (_ip: string, argv: string[]) => {
      if (argv.includes('get')) return podJson(true);
      if (argv.includes('exec')) throw writeErr;
      return '';
    });
    await expect(setK8sWalgRole({ ip: '1.1.1.1', kubectl, role: 'primary' })).resolves.toEqual({
      intent: true,
      live: false,
      reason: 'write-failed',
      error: writeErr,
    });
    const goneErr = Object.assign(
      new Error(`Command failed: ${walgRoleWriteShell(WALG_ROLE_DIR, 'primary')}`),
      {
        stderr: 'error: unable to upgrade connection: container not found ("db")\n',
        status: 1,
      },
    );
    kubectl.mockImplementation(async (_ip: string, argv: string[]) => {
      if (argv.includes('get')) return podJson(true);
      if (argv.includes('exec')) throw goneErr;
      return '';
    });
    await expect(
      setK8sWalgRole({ ip: '1.1.1.1', kubectl, role: 'primary' }),
    ).resolves.toMatchObject({
      reason: 'pod-unreachable',
    });
  });
  it('the write syncs the tmp file before the rename, and the rename after', () => {
    expect(walgRoleWriteShell(WALG_ROLE_DIR, 'primary')).toMatch(
      /chmod 0644 walg-role\.tmp && sync && mv -f walg-role\.tmp walg-role && sync /,
    );
  });
  it('a dead pod still records the intent (its next start applies it)', async () => {
    const kubectl = vi.fn(async (_ip: string, argv: string[]) => {
      if (argv.includes('get')) throw new Error('pods "db-0" not found');
      return '';
    });
    await expect(
      setK8sWalgRole({ ip: '1.1.1.1', kubectl, role: 'standby' }),
    ).resolves.toMatchObject({
      intent: true,
      live: false,
      reason: 'pod-unreachable',
    });
  });
  it('a read-back that disagrees is not live', async () => {
    const kubectl = vi.fn(async (_ip: string, argv: string[]) =>
      argv.includes('get') ? podJson(true) : argv.includes('exec') ? 'WALG_ROLE_FILE=' : '',
    );
    await expect(
      setK8sWalgRole({ ip: '1.1.1.1', kubectl, role: 'primary' }),
    ).resolves.toMatchObject({
      live: false,
      reason: 'read-back-mismatch',
    });
  });
  it('compose writes on the host, in the project dir', () => {
    expect(composeWalgRoleWriteShell('acme', 'standby')).toMatch(/^cd \/opt\/acme && /);
    expect(composeWalgRoleWriteShell('acme', 'standby')).toContain('.vibecarbon-role');
  });

  // Beyond the brief's cases: the pieces the later tasks lean on.
  it('the intent apply argv is a plain apply from stdin in the vibecarbon namespace', () => {
    expect(k8sWalgRoleIntentApplyArgv()).toEqual(['-n', 'vibecarbon', 'apply', '-f', '-']);
  });
  it('the exec argv survives the ssh argv join and runs the write script unchanged', () => {
    const argv = k8sWalgRoleExecArgv('primary');
    expect(argv.slice(0, 8)).toEqual([
      '-n',
      'vibecarbon',
      'exec',
      DB_POD,
      '-c',
      DB_CONTAINER,
      '--',
      'sh',
    ]);
    // The exact remote string sshKubectl sends (sshArgv's per-token shEscape
    // join), parsed by a real shell: every token comes back intact.
    const remote = ['kubectl', ...argv].map(shEscape).join(' ');
    const r = spawnSync('sh', ['-c', `set -- ${remote}; printf '%s\\0' "$@"`], {
      encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout.split('\0').slice(0, -1)).toEqual(['kubectl', ...argv]);
    expect(argv.at(-1)).toBe(walgRoleWriteShell(WALG_ROLE_DIR, 'primary'));
  });
  it('podMountsWalgRoleDir reads only the db container, and never throws on junk', () => {
    expect(podMountsWalgRoleDir(podJson(true))).toBe(true);
    expect(podMountsWalgRoleDir(podJson(false))).toBe(false);
    expect(podMountsWalgRoleDir('not json')).toBe(false);
    const sidecar = JSON.stringify({
      spec: {
        containers: [
          { name: 'db', volumeMounts: [] },
          { name: 'other', volumeMounts: [{ name: 'data', mountPath: WALG_ROLE_DIR }] },
        ],
      },
    });
    expect(podMountsWalgRoleDir(sidecar)).toBe(false);
  });
  it('the read shell never fails and reports an empty role for a missing file', () => {
    const dir = createTempDir('vc-role-');
    const r = spawnSync('sh', ['-c', walgRoleReadShell(dir)], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('WALG_ROLE_FILE=\n');
  });
  it('the one read-back reads the role line, an empty role, or no answer', () => {
    for (const role of ['primary', 'standby']) {
      const dir = createTempDir('vc-role-');
      writeFileSync(join(dir, 'walg-role'), `${role}\n`);
      const r = spawnSync('sh', ['-c', walgRoleReadShell(dir)], { encoding: 'utf-8' });
      expect(parseWalgRoleReadBack(r.stdout)).toBe(role);
    }
    expect(parseWalgRoleReadBack('noise\nWALG_ROLE_FILE=\n')).toBe('');
    expect(parseWalgRoleReadBack('')).toBeUndefined();
    expect(parseWalgRoleReadBack(false)).toBeUndefined();
    expect(parseWalgRoleReadBack(undefined)).toBeUndefined();
  });
  it('a write into a missing directory fails loudly and prints no role line', () => {
    const dir = join(createTempDir('vc-role-'), 'absent');
    const r = spawnSync('sh', ['-c', walgRoleWriteShell(dir, 'primary')], { encoding: 'utf-8' });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('WALG_ROLE_FILE=');
  });
  it('compose refuses a project name that is not a safe path segment', () => {
    expect(() => composeWalgRoleWriteShell('../etc', 'primary')).toThrow();
    expect(composeWalgRoleWriteShell('acme', 'primary')).toContain(
      `/opt/acme/${COMPOSE_WALG_ROLE_HOST_DIR}`,
    );
  });
});

describe('writeComposeWalgRole: one SSH write, proven by its read-back', () => {
  const args = { ip: '203.0.113.5', sshKeyPath: '/k', projectName: 'acme' };

  it('sends the compose write script as one `sh -c` token, which survives the ssh join', async () => {
    const run = vi.fn(async (_ip: string, _k: string, _argv: string[]) => 'WALG_ROLE_FILE=standby');
    await writeComposeWalgRole({ ...args, role: 'standby', run });
    const argv = run.mock.calls[0][2];
    expect(argv).toEqual(['sh', '-c', composeWalgRoleWriteShell('acme', 'standby')]);
    const remote = argv.map(shEscape).join(' ');
    const r = spawnSync('sh', ['-c', `set -- ${remote}; printf '%s\\0' "$@"`], {
      encoding: 'utf-8',
    });
    expect(r.stdout.split('\0').slice(0, -1)).toEqual(argv);
  });

  it('throws when the role does not read back', async () => {
    const run = vi.fn(async () => 'WALG_ROLE_FILE=');
    await expect(writeComposeWalgRole({ ...args, role: 'primary', run })).rejects.toThrow(
      /read back as "" after writing primary/,
    );
  });

  it('a failed write names the role directory, never the script', async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error(`Command failed: ssh ... ${'x'.repeat(200)}`), {
        stderr: '[walg-role] could not write the wal-g role in /opt/acme/.vibecarbon-role\n',
      });
    });
    const err = await writeComposeWalgRole({ ...args, role: 'primary', run }).catch((e) => e);
    expect(err.message).toBe(
      'could not write the wal-g role primary on 203.0.113.5: the write failed in /opt/acme/.vibecarbon-role',
    );
  });

  it('an unknown role or unsafe project throws before any ssh', async () => {
    const run = vi.fn();
    await expect(
      writeComposeWalgRole({ ...args, role: 'replica' as 'primary', run }),
    ).rejects.toThrow();
    await expect(
      writeComposeWalgRole({ ...args, projectName: '../etc', role: 'primary', run }),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});
