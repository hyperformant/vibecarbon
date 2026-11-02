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
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import { REPL_COMPOSE_FLAGS } from '../../../src/lib/deploy/compose/ha.js';
import { DB_CONTAINER, DB_POD, DB_STATEFULSET } from '../../../src/lib/deploy/db-workload.js';
import {
  COMPOSE_WALG_ROLE_HOST_DIR,
  composeDbRecreateShell,
  composeWalgRoleWriteShell,
  DB_ROLE_CONFIGMAP,
  DB_ROLE_INTENT_KEY,
  dbRoleConfigMapManifest,
  k8sSetWalgRoleArgv,
  k8sWalgRoleExecArgv,
  k8sWalgRoleIntentApplyArgv,
  podMountsWalgRoleDir,
  setK8sWalgRole,
  WALG_ROLE_DIR,
  WALG_ROLE_ENV,
  walgRoleDegradedMessage,
  walgRoleReadShell,
  walgRoleWriteShell,
  writeComposeWalgRole,
} from '../../../src/lib/deploy/walg-role.js';
import { shEscape } from '../../../src/lib/shell.js';

const shell = composeDbRecreateShell('/opt/myapp');

describe('composeDbRecreateShell', () => {
  it('recreates ONLY the db service, in the project directory', () => {
    expect(shell).toContain('cd /opt/myapp');
    expect(shell).toContain('up -d --no-deps db');
    // --no-deps: nothing else on the node is touched. In particular the app
    // tier is not restarted out from under the caller (compose failover
    // restarts it itself, immediately after, so it re-pools against the
    // recreated database).
    expect(shell).not.toContain('--remove-orphans');
  });

  it('never bare-`up`s: prod.yml would be dropped and the db recreated with dev config', () => {
    expect(shell).toContain('FLAGS="-f docker-compose.yml -f docker-compose.prod.yml"');
    expect(shell).toContain('docker compose $FLAGS up -d --no-deps db');
  });

  // GROUND TRUTH over inference: the label is literally the -f set the running
  // container was created with, so it beats reconstructing that set by probing.
  it('prefers the compose config_files label, read BEFORE the recreate overwrites it', () => {
    expect(shell).toContain('com.docker.compose.project.config_files');
    const labelIdx = shell.indexOf('com.docker.compose.project.config_files');
    const upIdx = shell.indexOf('up -d --no-deps db');
    expect(labelIdx).toBeLessThan(upIdx);
  });

  // The failure mode this whole function guards against IS the empty -f set (a
  // bare `up` resolves docker-compose.yml alone). So a missing/garbage label
  // must degrade to the probe reconstruction, never to nothing.
  it('degrades a missing or unusable label to the PROBE set, never to an empty -f set', () => {
    // The label branch only wins when it produced something file-shaped…
    expect(shell).toMatch(/case "\$FLAGS" in\n\s*\*\.yml\*\|\*\.yaml\*\)/);
    // …and the fallback arm always seeds the base pair before probing.
    const caseStart = shell.indexOf('case "$FLAGS" in');
    const fallbackArm = shell.slice(caseStart, shell.indexOf('esac', caseStart));
    expect(fallbackArm).toContain('FLAGS="-f docker-compose.yml -f docker-compose.prod.yml"');
    expect(fallbackArm).toContain('rebuilt the -f set from the replication file set');
    // An all-whitespace / empty label field never contributes a bare `-f`.
    expect(shell).toContain('case "$f" in *[!\\ ]*) FLAGS="$FLAGS -f $f" ;; esac');
  });

  // Measured, not theorised: against a real 3-file project a bare
  // `up -d --no-deps db` reported `Container … Started` and left
  // .NetworkSettings.Ports as {} — the 5433 publish vanished silently.
  it('asserts the published-port set SURVIVES the recreate, and fails loudly if not', () => {
    expect(shell).toContain('PORTS_BEFORE=');
    expect(shell).toContain('PORTS_AFTER=');
    // Captured before, compared after.
    expect(shell.indexOf('PORTS_BEFORE=')).toBeLessThan(shell.indexOf('up -d --no-deps db'));
    expect(shell.indexOf('up -d --no-deps db')).toBeLessThan(shell.indexOf('PORTS_AFTER='));
    expect(shell).toContain('DROPPED published port(s)');
    // Only PUBLISHED ports are compared — exposed-but-unpublished ports have a
    // null mapping, so `range` over them yields nothing and cannot false-fail.
    expect(shell).toContain('{{range $p, $c := .NetworkSettings.Ports}}');
  });

  it('the drop message states the node is recoverable and names the remedy', () => {
    // Read mid-incident: the db IS up (the recreate worked, it just resolved the
    // wrong file set), so say so before saying what is wrong, and give the one
    // command that reconciles it — same remedy as walgRoleDegradedMessage.
    expect(shell).toContain('the database is RUNNING');
    expect(shell).toContain('Nothing is lost');
    expect(shell).toContain('vibecarbon deploy <env>');
  });

  it('refuses to recreate when no db container is running, rather than guessing', () => {
    // Without a running container there is no label and no port baseline, so
    // the assertion below would be vacuous and the -f set unverifiable.
    expect(shell).toContain('refusing to recreate blind');
  });

  it('appends the replication overlay LAST, exactly as reconcile.sh does', () => {
    // Dropping it recreates db without the 5433 publish the repl-gateway socat
    // relay dials — replication transport silently dies.
    expect(shell).toContain('docker-compose.replication.yml');
    const files = [...shell.matchAll(/docker-compose[\w.]*\.yml/g)].map((m) => m[0]);
    expect(files.at(-1)).toBe('docker-compose.replication.yml');
  });

  // DRIFT GUARD — the fallback set must equal the set the DEPLOY itself uses
  // when it recreates db on a compose-ha node (`haWriteReplicationOverlay` →
  // REPL_COMPOSE_FLAGS). Not "every overlay present on the node": n8n and
  // metabase both define a `db:` key, so a generous fallback would merge config
  // the deploy never applied — and the port assertion could not catch it,
  // because it only detects REMOVALS.
  it('falls back to exactly REPL_COMPOSE_FLAGS — never to every overlay present', () => {
    const replFiles = REPL_COMPOSE_FLAGS.split(' ').filter((t) => t !== '-f');
    const caseStart = shell.indexOf('case "$FLAGS" in');
    const fallbackArm = shell.slice(caseStart, shell.indexOf('esac', caseStart));
    const referenced = [...fallbackArm.matchAll(/docker-compose[\w.]*\.yml/g)].map((m) => m[0]);
    expect([...new Set(referenced)]).toEqual(replFiles);
    // And nothing anywhere in the script reaches for an add-on overlay.
    for (const f of ['n8n', 'metabase', 'redis', 'observability', 'dns01']) {
      expect(shell, `fallback must not pull in docker-compose.${f}.yml`).not.toContain(
        `docker-compose.${f}`,
      );
    }
  });

  it('waits for postgres to answer again — `up -d` returns on CREATE, not on ready', () => {
    expect(shell).toContain('pg_isready');
    // Everything downstream (the audit, the app-tier restart) needs a database
    // that answers, so a db that never comes back has to be a hard failure.
    expect(shell.trimEnd().endsWith('exit 1')).toBe(true);
    expect(shell).toContain('set -e');
  });

  it('reports the resulting WALG_ROLE, so the log shows what the container actually got', () => {
    expect(shell).toContain(`printenv ${WALG_ROLE_ENV}`);
  });

  it('never lets a file test short-circuit the recreate under `set -e`', () => {
    // `[ -f x ] && FLAGS=…` evaluates to non-zero when the file is ABSENT —
    // which, as the last statement of the branch under `set -e`, aborts the
    // script before the `up` ever runs. A single-server node legitimately has
    // no replication overlay, so that is the common case, not the rare one.
    expect(shell).toMatch(/if \[ -f docker-compose\.replication\.yml \]; then/);
    expect(shell).not.toMatch(/\[ -f [^\]]+\] &&/);
  });
});

describe('k8s write-guard patch', () => {
  it('sets WALG_ROLE on the db StatefulSet', () => {
    expect(k8sSetWalgRoleArgv('primary')).toEqual([
      '-n',
      'vibecarbon',
      'set',
      'env',
      `statefulset/${DB_STATEFULSET}`,
      'WALG_ROLE=primary',
    ]);
    expect(k8sSetWalgRoleArgv('standby').at(-1)).toBe('WALG_ROLE=standby');
  });

  it('targets the StatefulSet, not the pod — a pod patch would be lost on the next roll', () => {
    expect(k8sSetWalgRoleArgv('primary')).not.toContain(DB_POD);
  });
});

describe('walgRoleDegradedMessage', () => {
  const msg = walgRoleDegradedMessage({
    path: 'compose',
    envName: 'prod',
    promotedIp: '2.2.2.2',
    detail: 'the db container still has WALG_ROLE=standby',
  });

  it('states the world first — this is read mid-incident', () => {
    // The first question during a failover is "am I serving?", so answer it
    // before describing the problem.
    expect(msg.indexOf('is serving')).toBeLessThan(msg.indexOf('could not prove'));
    expect(msg).toContain('FAILOVER COMPLETED, BACKUPS DID NOT');
  });

  it('names the consequence and the one-command check', () => {
    expect(msg).toContain('ONLY live copy');
    expect(msg).toContain('printenv WALG_ROLE');
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
      "Until WALG_ROLE=primary is in the new primary's .env, its next reconcile scales n8n, metabase back to 0",
    );
    expect(held).not.toMatch(/\u2014/);
  });

  it('gives the k8s check on the k8s path', () => {
    const k8s = walgRoleDegradedMessage({
      path: 'k8s',
      envName: 'prod',
      promotedIp: '3.3.3.3',
      detail: 'x',
    });
    expect(k8s).toContain(`kubectl -n vibecarbon exec ${DB_POD}`);
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
    const dir = mkdtempSync(join(tmpdir(), 'vc-role-'));
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
    const dir = mkdtempSync(join(tmpdir(), 'vc-role-'));
    writeFileSync(join(dir, 'victim'), 'x');
    symlinkSync(join(dir, 'victim'), join(dir, 'walg-role.tmp'));
    const r = spawnSync('sh', ['-c', walgRoleWriteShell(dir, 'standby')], { encoding: 'utf-8' });
    expect(readFileSync(join(dir, 'victim'), 'utf-8')).toBe('x');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('WALG_ROLE_FILE=standby');
    expect(readFileSync(join(dir, 'walg-role'), 'utf-8')).toBe('standby\n');
  });
  it('the manifest is the CLI-owned ConfigMap with the one key', () => {
    const doc = load(dbRoleConfigMapManifest('standby')) as {
      kind: string;
      metadata: { name: string; namespace: string };
      data: Record<string, string>;
    };
    expect(doc).toMatchObject({
      kind: 'ConfigMap',
      metadata: { name: DB_ROLE_CONFIGMAP, namespace: 'vibecarbon' },
      data: { [DB_ROLE_INTENT_KEY]: 'standby' },
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
    const dir = mkdtempSync(join(tmpdir(), 'vc-role-'));
    const r = spawnSync('sh', ['-c', walgRoleReadShell(dir)], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('WALG_ROLE_FILE=\n');
  });
  it('a write into a missing directory fails loudly and prints no role line', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'vc-role-')), 'absent');
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
